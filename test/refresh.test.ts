import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import extension from "../src/index.ts";

async function setup(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "codex-plan-test-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	await writeFile(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { access: "test-token", accountId: "acct" } }));
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(dir, { recursive: true, force: true });
	});
	let now = Date.parse("2026-11-10T00:00:00Z");
	let used = 38;
	let poll: () => void;
	t.mock.method(Date, "now", () => now);
	const fetchMock = t.mock.method(globalThis, "fetch", async (url: string) => new Response(JSON.stringify(
		url.endsWith("/wham/usage")
			? { plan_type: "pro", rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 18_000, reset_after_seconds: 3600 } } }
			: { credits: [] },
	)));
	t.mock.method(globalThis, "setInterval", (callback: () => void) => {
		poll = callback;
		return { unref() {} };
	});
	t.mock.method(globalThis, "clearInterval", () => {});
	const settle = () => new Promise(resolve => setTimeout(resolve, 30));
	// Each call is one pi session; all of them share the agent directory, the clock and the backend.
	const session = () => {
		const handlers = new Map();
		const commands = new Map();
		extension({
			on: (name, handler) => handlers.set(name, handler),
			registerCommand: (name, command) => commands.set(name, command),
		} as any);
		let widget: string[] | undefined;
		let tick: () => void;
		const notifications: string[] = [];
		const ctx = { hasUI: true, ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWidget: (_key: string, factory: any) => { widget = factory?.().render(160); },
			notify: (message: string) => notifications.push(message),
		} };
		return {
			widget: () => widget,
			request: (provider: string, api: string) => handlers.get("before_provider_request")({ payload: { stream: true } }, { model: { provider, api } }),
			notifications,
			start: async () => { handlers.get("session_start")({}, ctx); tick = poll; await settle(); },
			turn: async () => { handlers.get("agent_end")({}, ctx); await settle(); },
			tick: async () => { tick(); await settle(); },
			command: (args = "") => commands.get("codex").handler(args, ctx),
		};
	};
	return {
		session,
		dir,
		advance: (ms: number) => { now += ms; },
		now: () => now,
		use: (percent: number) => { used = percent; },
		// One refresh is two requests: usage and reset credits.
		refreshes: () => fetchMock.mock.callCount() / 2,
	};
}

test("fast toggles the animated title and priority tier without fetching quota", async (t) => {
	const app = await setup(t);
	const s = app.session();
	await s.start();
	const standard = s.widget()![0];
	await s.command("fast");
	const animated = s.widget()![0];
	assert.match(animated, /\x1b\[38;2;/);
	assert.equal(animated.replace(/\x1b\[[0-9;]+m/g, ""), standard);
	assert.deepEqual(s.request("openai-codex", "openai-codex-responses"), { stream: true, service_tier: "priority" });
	assert.equal(s.request("other", "openai-responses"), undefined);
	await s.command("fast");
	assert.equal(s.request("openai", "openai-responses"), undefined);
	assert.equal(s.widget()![0], standard);
	assert.equal(app.refreshes(), 1);
});

test("sessions share one snapshot instead of each querying the backend", async (t) => {
	const app = await setup(t);
	const [first, second] = [app.session(), app.session()];
	await Promise.all([first.start(), second.start()]);
	// The second session finds the lock held and polls for the first one's snapshot.
	await new Promise(resolve => setTimeout(resolve, 400));
	assert.equal(app.refreshes(), 1);
	assert.match(first.widget()![0], /38%/);
	assert.match(second.widget()![0], /38%/);
	assert.deepEqual((await readdir(app.dir)).sort(), ["auth.json", "codex-plan-usage.json"]);
	assert.doesNotMatch(await readFile(join(app.dir, "codex-plan-usage.json"), "utf8"), /test-token|acct/);

	// Turns are throttled across sessions, not per session.
	app.use(40);
	app.advance(59_999);
	await second.turn();
	assert.equal(app.refreshes(), 1);
	app.advance(1);
	await second.turn();
	await first.turn();
	assert.equal(app.refreshes(), 2);
	assert.match(first.widget()![0], /40%/);

	// A poll reuses a snapshot that is less than a full period old.
	app.use(42);
	app.advance(240_000);
	await first.tick();
	assert.equal(app.refreshes(), 2);
	app.advance(60_000);
	await first.tick();
	assert.equal(app.refreshes(), 3);
	assert.match(first.widget()![0], /42%/);
});

test("/codex always queries the backend, and a crashed session's lock is taken over", async (t) => {
	const app = await setup(t);
	await writeFile(join(app.dir, "codex-plan-usage.lock"), String(app.now() - 30_000));
	const first = app.session();
	await first.start();
	assert.equal(app.refreshes(), 1);
	app.use(50);
	await first.command();
	assert.equal(app.refreshes(), 2);
	assert.match(first.widget()![0], /50%/);
	assert.match(first.notifications.at(-1)!, /limits refreshed/);
	const second = app.session();
	await second.start();
	assert.equal(app.refreshes(), 2);
	assert.match(second.widget()![0], /50%/);
});

test("logging out hides the line and reports it", async (t) => {
	const app = await setup(t);
	const first = app.session();
	await first.start();
	await writeFile(join(app.dir, "auth.json"), "{}");
	await first.command();
	assert.equal(first.widget(), undefined);
	assert.match(first.notifications.at(-1)!, /not logged in/);
	assert.equal(app.refreshes(), 1);
});
