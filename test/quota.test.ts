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

test("the line fills the width and shows used percent, resets and the countdown", () => {
	const [line, divider] = renderQuota({ usage, resets: 2, deadline: NOW + 5 * 3_600_000 }, 120, plain, NOW);
	assert.match(line, /^Codex │ 5h 2h30m ━+ 12% │ Week 3d4h ━+ 59% │ 2 resets │ spend by 5h$/);
	assert.ok([...line].length <= 120 && [...line].length >= 110);
	assert.equal(divider, "─".repeat(120));
});

test("low remaining turns warning then error; bars shrink to a minimum before they are dropped", () => {
	assert.equal(remainingColor(80), "muted");
	assert.equal(remainingColor(40), "warning");
	assert.equal(remainingColor(10), "error");
	const [narrow] = renderQuota({ usage }, 46, tagged, NOW);
	assert.match(narrow, /<warning>━━<dim>━━/);  // 59% used of a 4-wide bar, amber with 41% left
	assert.match(narrow, /<muted><dim>━━━━ <muted>12%/);  // 12% used of a 4-wide bar rounds to empty
	assert.doesNotMatch(renderQuota({ usage }, 45, tagged, NOW)[0], /━/);
});

test("errors are shown instead of windows, and nothing extra appears without resets or deadline", () => {
	assert.equal(renderQuota({ error: "login expired — /login" }, 80, plain, NOW)[0], "Codex │ login expired — /login");
	assert.doesNotMatch(renderQuota({ usage }, 80, plain, NOW)[0], /reset|spend/);
});

test("narrower terminals compact first, then drop from the end, keeping Week over 5h and the title last", () => {
	const view = { usage, resets: 2, deadline: NOW + 5 * 3_600_000 };
	for (let width = 1; width <= 140; width++) {
		for (const line of renderQuota(view, width, plain, NOW)) assert.ok([...line].length <= width, `width ${width}: ${line}`);
	}
	const at = (width: number) => renderQuota(view, width, plain, NOW)[0];
	assert.match(at(72), /^Codex │ 5h 2h30m ━{4} 12% │ Week 3d4h ━{4} 59% │ 2 resets │ spend by 5h$/);
	assert.equal(at(70), "Codex │ 5h 2h30m 12% │ Week 3d4h 59% │ 2 resets │ spend by 5h");
	assert.equal(at(60), "Codex │ 5h 12% │ Week 59% │ 2 resets │ spend by 5h");
	assert.equal(at(45), "Codex │ 5h 12% │ Week 59% │ 2 resets");
	assert.equal(at(30), "Codex │ 5h 12% │ Week 59%");
	assert.equal(at(20), "Codex │ Week 59%");
	assert.equal(at(10), "Codex");
	assert.equal(at(4), "");
	assert.equal(renderQuota({ error: "login expired — /login" }, 12, plain, NOW)[0], "Codex │ log…");
});
