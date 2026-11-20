// Match the moving logo-color bands of the Radius entry in pi's /login selector.
const colors = [[77, 154, 191], [131, 204, 210], [241, 190, 87], [240, 144, 130]];

export function codexShimmer(elapsedMs: number): string {
	return Array.from("Codex", (char, i) => {
		const phase = (((i - elapsedMs / 100) % 16 + 16) % 16) / 4;
		const band = Math.floor(phase);
		const t = phase - band;
		const blend = t * t * (3 - 2 * t);
		const rgb = colors[band].map((v, c) => Math.round(v + (colors[(band + 1) % 4][c] - v) * blend));
		return `\x1b[38;2;${rgb.join(";")}m${char}`;
	}).join("") + "\x1b[39m";
}
