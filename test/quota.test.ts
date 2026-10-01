import assert from "node:assert/strict";
import { test } from "node:test";
import { renderQuota, windows, windowLabel, remainingColor, formatDuration, type Paint } from "../src/quota.ts";

const plain: Paint = { fg: (_color, text) => text, bold: (text) => text };
const tagged: Paint = { fg: (color, text) => `<${color}>${text}`, bold: (text) => `*${text}*` };
const NOW = Date.UTC(2026, 9, 1, 12, 0);
const usage = { rate_limit: {
	primary_window: { used_percent: 59, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 3 * 86_400 + 4 * 3600 },
	secondary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 2 * 3600 + 30 * 60 },
} };

test("windows are shown shortest first with sub-bar labels", () => {
	assert.deepEqual(windows(usage).map((w) => windowLabel(w.limit_window_seconds)), ["5h", "Week"]);
	assert.equal(windowLabel(86_400), "Day");
	assert.equal(formatDuration(3 * 86_400_000 + 4 * 3_600_000), "3d4h");
});

test("the line fills the width and shows remaining percent, resets and the countdown", () => {
	const [line, divider] = renderQuota({ usage, resets: 2, deadline: NOW + 5 * 3_600_000 }, 120, plain, NOW);
	assert.match(line, /^Codex │ 5h 2h30m ━+ 88% │ Week 3d4h ━+ 41% │ 2 resets │ spend by 5h$/);
	assert.ok([...line].length <= 120 && [...line].length >= 110);
	assert.equal(divider, "─".repeat(120));
});

test("low remaining turns warning then error, and a narrow terminal keeps a minimum bar", () => {
	assert.equal(remainingColor(80), "muted");
	assert.equal(remainingColor(40), "warning");
	assert.equal(remainingColor(10), "error");
	const [narrow] = renderQuota({ usage }, 20, tagged, NOW);
	assert.match(narrow, /<warning>━━<dim>━━/);  // 41% of a 4-wide bar
});

test("errors are shown instead of windows, and nothing extra appears without resets or deadline", () => {
	assert.equal(renderQuota({ error: "login expired — /login" }, 80, plain, NOW)[0], "Codex │ login expired — /login");
	assert.doesNotMatch(renderQuota({ usage }, 80, plain, NOW)[0], /reset|spend/);
});
