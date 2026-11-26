/**
 * pi-codex-plan
 *
 * Shows the ChatGPT/Codex quota of the account pi is logged into below the editor
 * (whatever model is selected), lists the banked rate-limit resets, lets you
 * redeem one, and then counts down until the weekly window would have reset on
 * its own.
 *
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatDuration, type Paint, type QuotaView, renderQuota, type UsageResponse } from "./quota.ts";
import { codexShimmer } from "./shimmer.ts";
import { accountKey, agentDir, sharedRefresh } from "./shared.ts";

const BACKEND = "https://chatgpt.com/backend-api";
const WIDGET_KEY = "codex-plan";
const REFRESH_MS = 5 * 60_000;
const AFTER_TURN_MIN_MS = 60_000;
// The periodic poll only fetches when no session has refreshed within (almost) a full period.
const TIMER_MIN_AGE_MS = REFRESH_MS - 5_000;
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

function authPath(): string {
	return join(agentDir(), "auth.json");
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

function formatLocal(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Soonest expiry first. The backend already returns them that way, so only sort when it does not. */
function soonestFirst(credits: ResetCredit[]): ResetCredit[] {
	const alreadySorted = credits.every((credit, i) => i === 0 || expiryMs(credits[i - 1]) <= expiryMs(credit));
	return alreadySorted ? credits : [...credits].sort((a, b) => expiryMs(a) - expiryMs(b));
}

export default function (pi: ExtensionAPI) {
	let fast = false;
	pi.on("before_provider_request", ({ payload }, { model }) => {
		if (!fast || !model || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
		if ((model.provider === "openai" && model.api === "openai-responses") ||
			(model.provider === "openai-codex" && model.api === "openai-codex-responses")) {
			return { ...payload, service_tier: "priority" };
		}
	});

	let view: QuotaView = {};
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let hasLogin = false;
	let refreshing: Promise<void> | undefined;
	// Shared by every pi session, so many open sessions cost no more requests than one.
	const shared = sharedRefresh<QuotaView>("codex-plan-usage");

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
		ctx.ui.setWidget(WIDGET_KEY, (tui) => {
			const style = paint(ctx);
			const start = Date.now();
			if (fast) style.codexTitle = () => codexShimmer(Date.now() - start);
			const timer = fast ? setInterval(() => tui.requestRender(), 50) : undefined;
			timer?.unref?.();
			return {
				render: (width: number) => renderQuota(view, width, style),
				invalidate: () => {},
				dispose: () => clearInterval(timer),
			};
		}, { placement: "belowEditor" });
	};

	const fetchView = async (auth: CodexAuth, previous: QuotaView = {}): Promise<{ view: QuotaView }> => {
		const [usage, credits] = await Promise.allSettled([
			api<UsageResponse>(auth, "/wham/usage"),
			api<ResetCreditsResponse>(auth, "/wham/rate-limit-reset-credits"),
		]);
		const available = credits.status === "fulfilled"
			? (credits.value.credits ?? []).filter((credit) => credit.status === "available")
			: undefined;
		return { view: {
			...previous,
			usage: usage.status === "fulfilled" ? usage.value : previous.usage,
			resets: available ? available.length : previous.resets,
			resetExpiresAt: available ? Math.min(...available.map(expiryMs)) : previous.resetExpiresAt,
			error: usage.status === "rejected" ? shortError(usage.reason) : undefined,
		} };
	};

	/**
	 * Show usage and banked resets; follows the login, never the selected model. Only queries the
	 * backend if no pi session has done so within `minAge`; otherwise the shared snapshot is shown.
	 */
	const refresh = (ctx: ExtensionContext, minAge = AFTER_TURN_MIN_MS) => {
		refreshing ??= (async () => {
			try {
				hasLogin = await loggedIn();
				if (!hasLogin) {
					view = {};
					shared.forget();
					render(ctx, false);
					return;
				}
				const auth = await readAuth();
				const result = await shared.refresh(accountKey(auth.accountId ?? auth.access), minAge,
					previous => fetchView(auth, previous));
				view = result.view ?? {};
				render(ctx, true);
			} finally {
				refreshing = undefined;
			}
		})();
		return refreshing;
	};

	/** For explicit requests and after redeeming: always query the backend. */
	const refreshNow = async (ctx: ExtensionContext) => {
		await refreshing?.catch(() => {});
		await refresh(ctx, 0);
	};

	const stopTimers = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			fast = JSON.parse(await readFile(join(agentDir(), "codex-plan-settings.json"), "utf8"))?.fast === true;
		} catch {
			fast = false;
		}
		if (!ctx.hasUI) return;
		void refresh(ctx);
		stopTimers();
		refreshTimer = setInterval(() => void refresh(ctx, TIMER_MIN_AGE_MS), REFRESH_MS);
		refreshTimer.unref?.();
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) void refresh(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopTimers();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});

	pi.registerCommand("codex", {
		description: "Codex plan: refresh limits, redeem a reset, or toggle fast mode",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "fast", label: "fast", description: "Toggle priority processing (may cost more)" },
				{ value: "reset", label: "reset", description: "List banked resets and redeem one" },
			].filter((item) => item.value.startsWith(prefix));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "fast") {
				const next = !fast;
				const path = join(agentDir(), "codex-plan-settings.json");
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					await mkdir(agentDir(), { recursive: true });
					await writeFile(temporary, JSON.stringify({ fast: next }) + "\n", { mode: 0o600 });
					await rename(temporary, path);
				} catch (error) {
					await unlink(temporary).catch(() => {});
					ctx.ui.notify(`Could not save Codex fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
					return;
				}
				fast = next;
				if (ctx.hasUI) render(ctx, hasLogin);
				ctx.ui.notify(fast ? "Codex fast mode on (priority processing may cost more)." : "Codex fast mode off.", "info");
				return;
			}

				if (command !== "reset") {
				await refreshNow(ctx);
				if (!hasLogin) {
					ctx.ui.notify("pi is not logged in to a ChatGPT (Codex) account. Run /login and pick ChatGPT.", "error");
					return;
				}
				ctx.ui.notify(`Codex ${view.usage?.plan_type ?? ""} limits refreshed; ${view.resets ?? 0} banked reset(s).`, "info");
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

			await refreshNow(ctx);
			ctx.ui.notify("Reset applied.", "info");
		},
	});
}

function shortError(reason: unknown): string {
	const message = reason instanceof Error ? reason.message : String(reason);
	return /401|403|rejected/.test(message) ? "login expired — /login" : "unavailable";
}
