/**
 * pi-codex-plan
 *
 * Shows the ChatGPT/Codex quota of the account pi is logged into below the editor
 * (whatever model is selected), lists the banked rate-limit resets, lets you
 * redeem one, and then counts down until the weekly window would have reset on
 * its own.
 *
 * Why the countdown: redeeming a credit restores your quota now, but it does not
 * move the original weekly reset. Whatever you do not spend before that moment is
 * lost when the window rolls over anyway.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatDuration, type Paint, type QuotaView, renderQuota, type UsageResponse } from "./quota.ts";

const BACKEND = "https://chatgpt.com/backend-api";
const WIDGET_KEY = "codex-plan";
const REFRESH_MS = 5 * 60_000;
const AFTER_TURN_MIN_MS = 60_000;
const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "pi-codex-plan";

interface CodexAuth {
	access: string;
	accountId?: string;
	expires?: number;
}

interface ResetCredit {
	id: string;
	reset_type: string;
	status: string;
	granted_at: string;
	expires_at?: string | null;
	title?: string | null;
	description?: string | null;
}

interface ResetCreditsResponse {
	credits: ResetCredit[];
	available_count?: number;
}

type ConsumeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

interface ConsumeResponse {
	code: ConsumeCode;
	windows_reset?: number;
}

interface ReminderState {
	/** Epoch ms of the weekly reset that was already scheduled before redeeming. */
	deadline: number;
	/** Epoch ms the credit was redeemed. */
	redeemedAt: number;
	creditId?: string;
}

function configDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function authPath(): string {
	return join(configDir(), "auth.json");
}

function statePath(): string {
	return join(configDir(), "codex-plan.json");
}

async function loggedIn(): Promise<boolean> {
	try {
		return Boolean(JSON.parse(await readFile(authPath(), "utf8"))?.["openai-codex"]?.access);
	} catch {
		return false;
	}
}

async function readAuth(): Promise<CodexAuth> {
	let raw: string;
	try {
		raw = await readFile(authPath(), "utf8");
	} catch {
		throw new Error("No pi credentials found. Log in to ChatGPT in pi first (/login).");
	}
	const auth = JSON.parse(raw)?.["openai-codex"] as CodexAuth | undefined;
	if (!auth?.access) {
		throw new Error("pi is not logged in to a ChatGPT (Codex) account. Run /login and pick ChatGPT.");
	}
	return auth;
}

async function api<T>(auth: CodexAuth, path: string, init?: RequestInit): Promise<T> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.access}`,
		"User-Agent": USER_AGENT,
		...((init?.headers as Record<string, string> | undefined) ?? {}),
	};
	if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;

	const response = await fetch(`${BACKEND}${path}`, {
		...init,
		headers,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error("ChatGPT session rejected (HTTP " + response.status + "). Re-login in pi with /login.");
		}
		const body = (await response.text().catch(() => "")).slice(0, 200);
		throw new Error(`GET ${path} failed: HTTP ${response.status}${body ? ` — ${body}` : ""}`);
	}
	return (await response.json()) as T;
}

function expiryMs(credit: ResetCredit): number {
	const parsed = credit.expires_at ? Date.parse(credit.expires_at) : Number.NaN;
	// Credits without a usable expiry sort last; they are never the urgent one.
	return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

/** Soonest expiry first. The backend already returns them that way, so only sort when it does not. */
function soonestFirst(credits: ResetCredit[]): ResetCredit[] {
	const alreadySorted = credits.every((credit, i) => i === 0 || expiryMs(credits[i - 1]) <= expiryMs(credit));
	return alreadySorted ? credits : [...credits].sort((a, b) => expiryMs(a) - expiryMs(b));
}

/**
 * The reset that matters for the reminder is the longest window (the weekly one);
 * the 5-hour window rolls over on its own long before the credit is worth tracking.
 */
function weeklyResetAt(usage: UsageResponse): number | undefined {
	const windows = [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window].filter(
		(window) => Boolean(window) && typeof window?.reset_at === "number",
	);
	let longest: (typeof windows)[number] | undefined;
	for (const window of windows) {
		if (!longest || (window.limit_window_seconds ?? 0) > (longest.limit_window_seconds ?? 0)) longest = window;
	}
	return longest?.reset_at;
}

function formatLocal(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function readState(): Promise<ReminderState | undefined> {
	try {
		// One-time move from the pi-reset-chatgpt state file.
		await rename(join(configDir(), "reset-chatgpt.json"), statePath()).catch(() => {});
		const state = JSON.parse(await readFile(statePath(), "utf8")) as ReminderState;
		return typeof state?.deadline === "number" ? state : undefined;
	} catch {
		return undefined;
	}
}

async function writeState(state: ReminderState): Promise<void> {
	await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export default function (pi: ExtensionAPI) {
	let view: QuotaView = {};
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let lastRefresh = 0;
	let refreshing: Promise<void> | undefined;

	const paint = (ctx: ExtensionContext): Paint => ({
		fg: (color, text) => ctx.ui.theme.fg(color, text),
		bold: (text) => ctx.ui.theme.bold(text),
	});

	/** The plan line below the editor; hidden while pi is not logged in to ChatGPT. */
	const render = (ctx: ExtensionContext, show: boolean) => {
		if (!show) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, () => ({
			render: (width: number) => renderQuota(view, width, paint(ctx)),
			invalidate: () => {},
		}), { placement: "belowEditor" });
	};

	/** Fetch usage and banked resets; follows the login, never the selected model. */
	const refresh = (ctx: ExtensionContext) => {
		refreshing ??= (async () => {
			try {
				if (!(await loggedIn())) {
					lastRefresh = 0;
					render(ctx, false);
					return;
				}
				const auth = await readAuth();
				const [usage, credits] = await Promise.allSettled([
					api<UsageResponse>(auth, "/wham/usage"),
					api<ResetCreditsResponse>(auth, "/wham/rate-limit-reset-credits"),
				]);
				view = {
					...view,
					usage: usage.status === "fulfilled" ? usage.value : view.usage,
					resets: credits.status === "fulfilled"
						? (credits.value.credits ?? []).filter((credit) => credit.status === "available").length
						: view.resets,
					error: usage.status === "rejected" ? shortError(usage.reason) : undefined,
				};
				lastRefresh = Date.now();
				render(ctx, true);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	};

	const stopTimers = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (tickTimer) clearInterval(tickTimer);
		refreshTimer = tickTimer = undefined;
	};

	const setDeadline = async (state: ReminderState | undefined) => {
		view = { ...view, deadline: state?.deadline };
		if (!state) await rm(statePath(), { force: true }).catch(() => {});
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const saved = await readState();
		await setDeadline(saved && saved.deadline > Date.now() ? saved : undefined);
		void refresh(ctx);
		stopTimers();
		refreshTimer = setInterval(() => void refresh(ctx), REFRESH_MS);
		// Countdowns move between refreshes; re-render, and drop the deadline once it passes.
		tickTimer = setInterval(() => {
			if (view.deadline && view.deadline <= Date.now()) void setDeadline(undefined);
			if (lastRefresh) render(ctx, true);
		}, TICK_MS);
		refreshTimer.unref?.();
		tickTimer.unref?.();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI && Date.now() - lastRefresh >= AFTER_TURN_MIN_MS) void refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimers();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("codex", {
		description: "Codex plan: refresh the limits, or redeem a banked rate-limit reset",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "reset", label: "reset", description: "List banked resets and redeem one" },
				{ value: "clear", label: "clear", description: "Dismiss the post-reset countdown" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "clear") {
				await setDeadline(undefined);
				render(ctx, Boolean(lastRefresh));
				ctx.ui.notify("Countdown dismissed.", "info");
				return;
			}

			if (command !== "reset") {
				await refresh(ctx);
				if (!lastRefresh) {
					ctx.ui.notify("pi is not logged in to a ChatGPT (Codex) account. Run /login and pick ChatGPT.", "error");
					return;
				}
				const deadline = view.deadline && view.deadline > Date.now()
					? ` Weekly window rolls over at ${formatLocal(view.deadline)} (${formatDuration(view.deadline - Date.now())} left).`
					: "";
				ctx.ui.notify(`Codex ${view.usage?.plan_type ?? ""} limits refreshed; ${view.resets ?? 0} banked reset(s).${deadline}`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/codex reset needs an interactive session.", "error");
				return;
			}

			let auth: CodexAuth;
			let credits: ResetCreditsResponse;
			try {
				auth = await readAuth();
				credits = await api<ResetCreditsResponse>(auth, "/wham/rate-limit-reset-credits");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const available = soonestFirst((credits.credits ?? []).filter((credit) => credit.status === "available"));
			if (available.length === 0) {
				ctx.ui.notify("No reset credits available on this ChatGPT account.", "info");
				return;
			}

			const now = Date.now();
			const options = available.map((credit, index) => {
				const title = credit.title?.trim() || "Rate limit reset";
				const expires = expiryMs(credit);
				const when = Number.isFinite(expires)
					? `expires ${formatLocal(expires)} (in ${formatDuration(expires - now)})`
					: "no expiry";
				return `${index + 1}. ${title} — ${when}`;
			});

			const picked = await ctx.ui.select(
				`${available.length} reset${available.length === 1 ? "" : "s"} available — soonest to expire first`,
				options,
			);
			if (!picked) return;

			const chosen = available[options.indexOf(picked)];
			if (!chosen) return;

			// Cancel is listed first so it is the highlighted default.
			const answer = await ctx.ui.select(`Redeem "${chosen.title?.trim() || "this reset"}"? This uses it up.`, [
				"Cancel",
				"Confirm",
			]);
			if (answer !== "Confirm") {
				ctx.ui.notify("Cancelled. No reset was used.", "info");
				return;
			}

			// Read the pre-existing weekly reset first: once the credit is consumed the
			// backend reports the new window and the original deadline is unrecoverable.
			let originalWeeklyReset: number | undefined;
			try {
				originalWeeklyReset = weeklyResetAt(await api<UsageResponse>(auth, "/wham/usage"));
			} catch {
				originalWeeklyReset = undefined;
			}

			let result: ConsumeResponse;
			try {
				result = await api<ConsumeResponse>(auth, "/wham/rate-limit-reset-credits/consume", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ redeem_request_id: randomUUID(), credit_id: chosen.id }),
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (result.code !== "reset") {
				const reasons: Record<ConsumeCode, string> = {
					reset: "Reset applied.",
					nothing_to_reset: "Nothing to reset — your quota is not limited right now.",
					no_credit: "That reset is no longer available.",
					already_redeemed: "That reset was already used.",
				};
				ctx.ui.notify(reasons[result.code] ?? `Unexpected response: ${result.code}`, "warning");
				return;
			}

			if (originalWeeklyReset === undefined) {
				ctx.ui.notify("Reset applied. (Could not read the original weekly reset time, so no countdown.)", "info");
				return;
			}

			const next: ReminderState = {
				deadline: originalWeeklyReset * 1000,
				redeemedAt: Date.now(),
				creditId: chosen.id,
			};
			await writeState(next).catch(() => {});
			await setDeadline(next);
			await refresh(ctx);
			ctx.ui.notify(
				`Reset applied. Your weekly window still rolls over at ${formatLocal(next.deadline)} — spend the quota before then.`,
				"info",
			);
		},
	});
}

function shortError(reason: unknown): string {
	const message = reason instanceof Error ? reason.message : String(reason);
	return /401|403|rejected/.test(message) ? "login expired — /login" : "unavailable";
}
