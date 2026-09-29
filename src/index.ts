/**
 * pi-reset-chatgpt
 *
 * Lists the banked Codex rate-limit resets on the ChatGPT account pi is logged
 * into, lets you redeem one, and then keeps a countdown in the status bar until
 * the weekly window would have reset on its own.
 *
 * Why the countdown: redeeming a credit restores your quota now, but it does not
 * move the original weekly reset. Whatever you do not spend before that moment is
 * lost when the window rolls over anyway.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BACKEND = "https://chatgpt.com/backend-api";
const STATUS_KEY = "reset-chatgpt";
/** Spelled out rather than shown as a glyph: no terminal font carries the OpenAI mark. */
const STATUS_LABEL = "⏳ ChatGPT:";
const WARNING_AT_MS = 24 * 3600 * 1000;
const URGENT_AT_MS = 2 * 3600 * 1000;
const TICK_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT = "pi-reset-chatgpt";

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

interface RateLimitWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface UsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: RateLimitWindow | null;
		secondary_window?: RateLimitWindow | null;
	} | null;
}

type ConsumeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

interface ConsumeResponse {
	code: ConsumeCode;
	windows_reset?: number;
}

interface ReminderState {
	/** Epoch ms of the weekly reset that was already scheduled before redeeming. */
	deadline: number;
	/** Epoch ms the credit was redeemed, for `/reset-chatgpt status`. */
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
	return join(configDir(), "reset-chatgpt.json");
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
		(window): window is RateLimitWindow => Boolean(window) && typeof window?.reset_at === "number",
	);
	let longest: RateLimitWindow | undefined;
	for (const window of windows) {
		if (!longest || (window.limit_window_seconds ?? 0) > (longest.limit_window_seconds ?? 0)) longest = window;
	}
	return longest?.reset_at;
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatLocal(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function readState(): Promise<ReminderState | undefined> {
	try {
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
	let timer: ReturnType<typeof setInterval> | undefined;
	let state: ReminderState | undefined;

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	/** Drop the reminder entirely: past the deadline there is nothing left to hurry for. */
	const clearReminder = async (ctx: ExtensionContext) => {
		stopTimer();
		state = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		await rm(statePath(), { force: true }).catch(() => {});
	};

	const renderStatus = (ctx: ExtensionContext) => {
		if (!state) return;
		const remaining = state.deadline - Date.now();
		if (remaining <= 0) {
			void clearReminder(ctx);
			return;
		}
		// The whole reminder is one token in a crowded footer, so urgency is carried
		// by color rather than by extra words.
		const color = remaining <= URGENT_AT_MS ? "error" : remaining <= WARNING_AT_MS ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, `${STATUS_LABEL} ${formatDuration(remaining)}`));
	};

	const startReminder = (ctx: ExtensionContext, next: ReminderState) => {
		stopTimer();
		state = next;
		renderStatus(ctx);
		if (!state) return; // already past the deadline
		timer = setInterval(() => renderStatus(ctx), TICK_MS);
		timer.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const saved = await readState();
		if (!saved) return;
		if (saved.deadline <= Date.now()) {
			await clearReminder(ctx);
			return;
		}
		startReminder(ctx, saved);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("reset-chatgpt", {
		description: "List and redeem banked ChatGPT/Codex rate-limit resets",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show the current quota countdown" },
				{ value: "clear", label: "clear", description: "Dismiss the quota countdown" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "clear") {
				await clearReminder(ctx);
				ctx.ui.notify("Quota countdown dismissed.", "info");
				return;
			}

			if (command === "status") {
				if (!state || state.deadline <= Date.now()) {
					ctx.ui.notify("No active quota countdown.", "info");
					return;
				}
				ctx.ui.notify(
					`Quota resets on its own at ${formatLocal(state.deadline)} (${formatDuration(state.deadline - Date.now())} left). Anything unused by then is gone.`,
					"info",
				);
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify("/reset-chatgpt needs an interactive session.", "error");
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
			startReminder(ctx, next);
			ctx.ui.notify(
				`Reset applied. Your weekly window still rolls over at ${formatLocal(next.deadline)} — spend the quota before then.`,
				"info",
			);
		},
	});
}
