/**
 * Quota line: the ChatGPT/Codex rate-limit windows in the style of pi-sub-bar, plus banked resets and the
 * post-redeem countdown. Pure rendering, so it can be tested without pi.
 */

export interface RateLimitWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface UsageResponse {
	plan_type?: string;
	rate_limit?: {
		primary_window?: RateLimitWindow | null;
		secondary_window?: RateLimitWindow | null;
	} | null;
}

export interface QuotaView {
	usage?: UsageResponse;
	/** Banked resets still available. */
	resets?: number;
	/** Epoch ms the post-redeem countdown ends, if one is running. */
	deadline?: number;
	error?: string;
}

/** Theme colors this line uses; matches pi's theme.fg names. */
export type Color = "text" | "muted" | "dim" | "warning" | "error" | "accent";
export interface Paint {
	fg(color: Color, text: string): string;
	bold(text: string): string;
}

export const WARNING_AT_MS = 24 * 3600 * 1000;
export const URGENT_AT_MS = 2 * 3600 * 1000;
const MIN_BAR = 4;
const MAX_BAR = 30;

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
	if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	return `${minutes}m`;
}

/** pi-sub-bar's Codex labels: 5h, Day, Week. */
export function windowLabel(seconds?: number): string {
	const hours = Math.round((seconds ?? 0) / 3600);
	if (hours >= 144) return "Week";
	if (hours >= 24) return "Day";
	return `${hours}h`;
}

/** Shortest window first, as in pi-sub-bar: 5h, then Week. */
export function windows(usage?: UsageResponse): RateLimitWindow[] {
	return [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]
		.filter((window): window is RateLimitWindow => Boolean(window) && typeof window?.used_percent === "number")
		.sort((a, b) => (a.limit_window_seconds ?? 0) - (b.limit_window_seconds ?? 0));
}

/** Remaining-percent color, pi-sub-bar's base-warning-error scheme. */
export function remainingColor(remaining: number): Color {
	return remaining < 25 ? "error" : remaining < 50 ? "warning" : "muted";
}

/** Plain-text segments (no color codes), so widths can be measured before painting. */
interface Segment {
	plain: string;
	paint: (paint: Paint, barWidth: number) => string;
	bar?: number;
}

/** How much of the line to show; renderQuota tries these from fullest to tightest. */
interface Detail {
	title: boolean;
	bar: boolean;
	resetTime: boolean;
	deadline: boolean;
	resets: boolean;
	/** Windows shown, longest last: 2 is 5h and Week, 1 is Week alone. */
	windows: number;
}

/** Drop the title first, then compact, then drop from the end of the line, except that Week outlasts 5h. */
const DETAILS: Detail[] = [
	{ title: true, bar: true, resetTime: true, deadline: true, resets: true, windows: 2 },
	{ title: false, bar: true, resetTime: true, deadline: true, resets: true, windows: 2 },
	{ title: false, bar: false, resetTime: true, deadline: true, resets: true, windows: 2 },
	{ title: false, bar: false, resetTime: false, deadline: true, resets: true, windows: 2 },
	{ title: false, bar: false, resetTime: false, deadline: false, resets: true, windows: 2 },
	{ title: false, bar: false, resetTime: false, deadline: false, resets: false, windows: 2 },
	{ title: false, bar: false, resetTime: false, deadline: false, resets: false, windows: 1 },
];

/** pi-sub-bar's default window: bold title, plain reset time, a heavy bar, the used percent. */
function windowSegment(window: RateLimitWindow, now: number, detail: Detail): Segment {
	const used = Math.max(0, Math.min(100, Math.round(window.used_percent ?? 0)));
	const color = remainingColor(100 - used);
	const label = windowLabel(window.limit_window_seconds);
	const reset = detail.resetTime && typeof window.reset_at === "number" ? formatDuration(window.reset_at * 1000 - now) : "";
	const pct = `${used}%`;
	return {
		plain: `${label}${reset ? ` ${reset}` : ""}${detail.bar ? " " : ""} ${pct}`, // the bar sits before the percent
		bar: detail.bar ? used : undefined,
		paint: (paint, barWidth) => {
			const filled = Math.round((used / 100) * barWidth);
			const bar = detail.bar ? `${paint.fg(color, "━".repeat(filled))}${paint.fg("dim", "━".repeat(barWidth - filled))} ` : "";
			const head = paint.bold(paint.fg(color, label)) + (reset ? ` ${paint.fg(color, reset)}` : "");
			return `${head} ${bar}${paint.fg(color, pct)}`;
		},
	};
}

function textSegment(text: string, color: Color): Segment {
	return { plain: text, paint: (paint) => paint.fg(color, text) };
}

function segmentsFor(view: QuotaView, detail: Detail, now: number): Segment[] {
	const segments: Segment[] = [];
	if (detail.title) segments.push({ plain: "Codex", paint: (paint) => paint.bold(paint.fg("text", "Codex")) });
	if (view.error) segments.push(textSegment(view.error, "dim"));
	for (const window of windows(view.usage).slice(-detail.windows)) segments.push(windowSegment(window, now, detail));
	if (detail.resets && view.resets) segments.push(textSegment(`${view.resets} reset${view.resets === 1 ? "" : "s"}`, "muted"));
	if (detail.deadline && view.deadline && view.deadline > now) {
		const left = view.deadline - now;
		const color: Color = left <= URGENT_AT_MS ? "error" : left <= WARNING_AT_MS ? "warning" : "muted";
		segments.push(textSegment(`spend by ${formatDuration(left)}`, color));
	}
	return segments;
}

const DIVIDER = " │ ";
const textWidth = (segments: Segment[]) =>
	segments.reduce((sum, segment) => sum + [...segment.plain].length, 0) + DIVIDER.length * Math.max(0, segments.length - 1);
const barCount = (segments: Segment[]) => segments.filter((segment) => segment.bar !== undefined).length;
const minWidth = (segments: Segment[]) => textWidth(segments) + barCount(segments) * MIN_BAR;

/**
 * One line fitting `width` (pi refuses wider lines): the fullest detail that fits, with bars sharing
 * whatever width the text leaves. When nothing fits, an error is cut short, otherwise the line is empty.
 */
export function renderQuota(view: QuotaView, width: number, paint: Paint, now = Date.now()): string[] {
	const error = view.error && [...view.error];
	const segments = DETAILS.map((detail) => segmentsFor(view, detail, now)).find((candidate) => minWidth(candidate) <= width)
		?? (error && width > 1 ? [textSegment(`${error.slice(0, width - 1).join("")}…`, "dim")] : []);
	const bars = barCount(segments);
	const barWidth = bars ? Math.max(MIN_BAR, Math.min(MAX_BAR, Math.floor((width - textWidth(segments)) / bars))) : 0;
	const line = segments.map((segment) => segment.paint(paint, barWidth)).join(paint.fg("dim", DIVIDER));
	return [line, paint.fg("dim", "─".repeat(Math.max(1, width)))]; // pi-sub-bar's bottom divider
}
