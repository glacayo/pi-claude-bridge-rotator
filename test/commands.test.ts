// `/claude-accounts` command tests. Everything is driven through the real
// handler with injected state, clock, host, and filesystem seam; temp dirs keep
// the real agent directory untouched.

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir, profile } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import type { RotatorConfig } from "../src/config.js";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL, ClaudeAccountRouter } from "../src/router.js";
import { RotatorStateStore } from "../src/state.js";
import type { ClaudeBridgeAccountHostV1, GlobalTarget } from "../src/host.js";
import { createRotatorCommandHandler, STATUS_PROBE_BACKOFF_MS } from "../src/commands.js";
import type {
	FetchUsage,
	NotifyLevel,
	RotatorCommandContext,
	RotatorCommandState,
	RotatorUIContext,
	StartLogin,
} from "../src/commands.js";
import type { UsageFetchResult, UsageSnapshot } from "../src/usage.js";

afterEach(cleanupTempDirs);

const START_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;

interface CapturedNotify {
	message: string;
	level: NotifyLevel | undefined;
}

interface Harness {
	state: RotatorCommandState;
	globalTarget: GlobalTarget;
	store: RotatorStateStore;
	router: ClaudeAccountRouter;
	mkdirCalls: string[];
	notifies: CapturedNotify[];
	run: (args: string, ctx?: Omit<Partial<RotatorCommandContext>, "ui">) => Promise<void>;
	lastMessage: () => string;
	lastLevel: () => NotifyLevel | undefined;
}

interface HarnessOptions {
	now?: (() => number) | undefined;
	host?: ClaudeBridgeAccountHostV1 | undefined;
	ui?: Partial<RotatorUIContext> | undefined;
	startLogin?: StartLogin | undefined;
	backupConfigFile?: ((path: string) => void) | undefined;
	configPath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	onRefresh?: (() => void) | undefined;
	fetchUsage?: FetchUsage | undefined;
}

function harness(config: RotatorConfig, options: HarnessOptions = {}): Harness {
	const dir = makeTempDir();
	const now = options.now ?? (() => START_MS);
	const store = new RotatorStateStore({ statePath: join(dir, "state.json"), now });
	const router = new ClaudeAccountRouter({ profiles: config.profiles, state: store, now });
	const state: RotatorCommandState = { config, router };
	if (options.onRefresh !== undefined) state.refresh = options.onRefresh;
	const globalTarget: GlobalTarget = {};
	const mkdirCalls: string[] = [];
	const notifies: CapturedNotify[] = [];
	const handler = createRotatorCommandHandler({
		state,
		globalTarget,
		now,
		mkdirRecursive: (path) => {
			mkdirCalls.push(path);
		},
		resolveHost: () => options.host,
		startLogin: options.startLogin,
		backupConfigFile: options.backupConfigFile,
		configPath: options.configPath,
		env: options.env,
		// Hermetic default: no filesystem read and no network unless a test opts in.
		fetchUsage: options.fetchUsage ?? (async () => ({ ok: false, reason: "no-credentials" })),
	});
	const run = async (args: string, ctx: Omit<Partial<RotatorCommandContext>, "ui"> = {}): Promise<void> => {
		await handler(args, {
			ui: { notify: (message, level) => notifies.push({ message, level }), ...(options.ui ?? {}) },
			...ctx,
		});
	};
	return {
		state,
		globalTarget,
		store,
		router,
		mkdirCalls,
		notifies,
		run,
		lastMessage: () => notifies.at(-1)?.message ?? "",
		lastLevel: () => notifies.at(-1)?.level,
	};
}

function twoProfileConfig(): RotatorConfig {
	return {
		policy: "balanced",
		path: "/tmp/rotator-config.json",
		profiles: [profile("a"), profile("b")],
	};
}

interface ScriptedDialogs {
	selectResponses?: (string | undefined)[];
	confirmResponses?: boolean[];
	inputResponses?: (string | undefined)[];
}

interface Dialogs {
	ui: Pick<RotatorUIContext, "select" | "confirm" | "input">;
	selects: Array<{ title: string; options: string[] }>;
	confirms: Array<{ title: string; message: string }>;
	inputs: Array<{ title: string; placeholder: string | undefined }>;
}

/** Fake dialog queue: each call shifts the next scripted response. */
function scriptedDialogs(script: ScriptedDialogs): Dialogs {
	const selects: Array<{ title: string; options: string[] }> = [];
	const confirms: Array<{ title: string; message: string }> = [];
	const inputs: Array<{ title: string; placeholder: string | undefined }> = [];
	const selectQueue = [...(script.selectResponses ?? [])];
	const confirmQueue = [...(script.confirmResponses ?? [])];
	const inputQueue = [...(script.inputResponses ?? [])];
	const ui: Pick<RotatorUIContext, "select" | "confirm" | "input"> = {
		select: async (title, options) => {
			selects.push({ title, options });
			return selectQueue.shift();
		},
		confirm: async (title, message) => {
			confirms.push({ title, message });
			return confirmQueue.shift() ?? false;
		},
		input: async (title, placeholder) => {
			inputs.push({ title, placeholder });
			return inputQueue.shift();
		},
	};
	return { ui, selects, confirms, inputs };
}

interface FakeLogin {
	startLogin: StartLogin;
	calls: string[];
	submitted: string[];
	wasCancelled: () => boolean;
}

function fakeLogin(options: { ok?: boolean; output?: string } = {}): FakeLogin {
	const calls: string[] = [];
	const submitted: string[] = [];
	let cancelled = false;
	const startLogin: StartLogin = async ({ configDir }) => {
		calls.push(configDir);
		return {
			url: "https://claude.ai/oauth/authorize?test=1",
			submitCode: async (code) => {
				submitted.push(code);
				return { ok: options.ok ?? true, output: options.output ?? "ok" };
			},
			cancel: () => {
				cancelled = true;
			},
		};
	};
	return { startLogin, calls, submitted, wasCancelled: () => cancelled };
}

describe("status", () => {
	it("renders the default status with policy, symbol presence, and each profile", async () => {
		const h = harness(twoProfileConfig());
		await h.run("");
		expect(h.notifies).toHaveLength(1);
		expect(h.lastLevel()).toBe("info");
		expect(h.lastMessage()).toContain("policy: balanced");
		expect(h.lastMessage()).toContain("router published: no");
		expect(h.lastMessage()).toContain("bridge account host: no");
		expect(h.lastMessage()).toContain("A (a)");
		expect(h.lastMessage()).toContain("B (b)");
		expect(h.lastMessage()).toContain("cooldown: ok");
	});

	it("reports a published router and bridge host", async () => {
		const host: ClaudeBridgeAccountHostV1 = { version: 1, probeProfile: async () => ({}) };
		const h = harness(twoProfileConfig(), { host });
		h.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = h.router;
		await h.run("status");
		expect(h.lastMessage()).toContain("router published: yes");
		expect(h.lastMessage()).toContain("bridge account host: yes");
	});

	it("shows a cooldown with remaining time", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordRateLimit("a", { resetsAt: (START_MS + 5 * MINUTE_MS) / 1000 }, "m");
		await h.run("status");
		expect(h.lastMessage()).toContain("cooldown: remaining 5m (unknown)");
	});

	it("shows invalid profiles with the relogin hint", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordFailure("b", "auth", "m");
		await h.run("status");
		expect(h.lastMessage()).toContain("invalid: needs relogin — run /claude-accounts login b");
	});

	it("shows cached identity", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordIdentity("a", { email: "a@example.com", subscriptionType: "max" });
		await h.run("status");
		expect(h.lastMessage()).toContain("identity: a@example.com · max");
	});

	it("marks the profile the router would currently pick", async () => {
		const h = harness(twoProfileConfig());
		h.router.acquire({ modelId: "m", sessionId: "s1" });
		await h.run("status", { model: { id: "m" }, sessionManager: { getSessionId: () => "s1" } });
		expect(h.lastMessage()).toContain("← current route");
	});

	it("renders a broken-config status as an error notification", async () => {
		const h = harness(twoProfileConfig());
		h.state.config = undefined;
		h.state.router = undefined;
		h.state.configError = `Cannot read rotator config at /tmp/missing.json (ENOENT).`;
		await h.run("status");
		expect(h.lastLevel()).toBe("error");
		expect(h.lastMessage()).toContain("config error:");
		expect(h.lastMessage()).toContain("/tmp/missing.json");
	});
});

describe("status usage", () => {
	const NOW = START_MS;
	const DAY_MS = 24 * 60 * MINUTE_MS;

	function successSnapshot(overrides: Partial<UsageSnapshot["windows"]> = {}): UsageSnapshot {
		return {
			fetchedAtMs: NOW,
			windows: {
				five_hour: { utilization: 12, resetsAtMs: NOW + 130 * MINUTE_MS },
				seven_day: { utilization: 34, resetsAtMs: NOW + (3 * 24 * 60 + 4 * 60) * MINUTE_MS },
				...overrides,
			},
		};
	}

	function snapshotFetch(snapshot: UsageSnapshot): FetchUsage {
		return async () => ({ ok: true, snapshot });
	}

	it("renders the plan usage line right after cooldown", async () => {
		const h = harness(twoProfileConfig(), { now: () => NOW, fetchUsage: snapshotFetch(successSnapshot()) });
		await h.run("status");
		expect(h.lastMessage()).toContain("  cooldown: ok\n  usage: 5h 12% (resets in 2h10m) · weekly 34% (resets in 3d4h)");
	});

	it("appends opus only when present and non-null, and labels an unstarted 5h window", async () => {
		const snapshot: UsageSnapshot = {
			fetchedAtMs: NOW,
			windows: {
				five_hour: { utilization: 0, resetsAtMs: null },
				seven_day: { utilization: null, resetsAtMs: null },
				seven_day_opus: { utilization: 7, resetsAtMs: null },
				seven_day_sonnet: { utilization: null, resetsAtMs: null },
			},
		};
		const h = harness(twoProfileConfig(), { now: () => NOW, fetchUsage: snapshotFetch(snapshot) });
		await h.run("status");
		expect(h.lastMessage()).toContain("usage: 5h 0% (window not started) · weekly n/a · opus 7%");
		expect(h.lastMessage()).not.toContain("sonnet");
	});

	it("renders the failure reason and the last known values", async () => {
		const h = harness(twoProfileConfig(), {
			now: () => NOW,
			fetchUsage: async () => ({ ok: false, reason: "network" }),
		});
		h.router.recordPlanUsage("a", { ok: true, snapshot: successSnapshot() });
		await h.run("status");
		expect(h.lastMessage()).toContain("usage: unavailable — network error");
		expect(h.lastMessage()).toContain("last known 1m ago: 5h 12% · weekly 34%");
	});

	it.each([
		[{ ok: false, reason: "no-credentials" } as UsageFetchResult, "no credentials — run /claude-accounts login a"],
		[
			{ ok: false, reason: "token-expired" } as UsageFetchResult,
			"access token expired — use this account once, or run /claude-accounts probe a",
		],
		[
			{ ok: false, reason: "unauthorized" } as UsageFetchResult,
			"unauthorized — run /claude-accounts login a if this persists",
		],
		[{ ok: false, reason: "timeout" } as UsageFetchResult, "timed out after 5s"],
		[{ ok: false, reason: "malformed" } as UsageFetchResult, "unexpected usage response"],
	])("renders the reason text for %o", async (result, text) => {
		const h = harness(twoProfileConfig(), { now: () => NOW, fetchUsage: async () => result });
		await h.run("status");
		expect(h.lastMessage()).toContain(`usage: unavailable — ${text}`);
	});

	it("renders the http-error reason with the status code", async () => {
		const h = harness(twoProfileConfig(), {
			now: () => NOW,
			fetchUsage: async () => ({ ok: false, reason: "http-error", httpStatus: 503 }),
		});
		await h.run("status");
		expect(h.lastMessage()).toContain("usage: unavailable — usage endpoint returned HTTP 503");
	});

	it("fetches every profile in parallel", async () => {
		let active = 0;
		let maxActive = 0;
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 0));
			active -= 1;
			return { ok: false, reason: "network" };
		};
		const h = harness(twoProfileConfig(), { now: () => NOW, fetchUsage });
		await h.run("status");
		expect(calls).toBe(2);
		expect(maxActive).toBe(2);
	});

	it("probes once with a 15s deadline and refetches when the token expired", async () => {
		const probes: Array<{ profileId: string; deadlineMs: number | undefined }> = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ profile: route, deadlineMs }) => {
				probes.push({ profileId: route.profileId, deadlineMs });
				return {};
			},
		};
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			return calls === 1 ? { ok: false, reason: "token-expired" } : { ok: true, snapshot: successSnapshot() };
		};
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => NOW, host, fetchUsage });
		await h.run("status");
		expect(probes).toEqual([{ profileId: "a", deadlineMs: 15000 }]);
		expect(calls).toBe(2);
		expect(h.lastMessage()).toContain("usage: 5h 12%");
	});

	it("does not probe without a host and keeps the expired reason", async () => {
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			return { ok: false, reason: "token-expired" };
		};
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => NOW, fetchUsage });
		await h.run("status");
		expect(calls).toBe(1);
		expect(h.lastMessage()).toContain("usage: unavailable — access token expired");
	});

	it("degrades when the refresh probe fails", async () => {
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async () => {
				throw new Error("probe down");
			},
		};
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			return { ok: false, reason: "token-expired" };
		};
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => NOW, host, fetchUsage });
		await h.run("status");
		expect(calls).toBe(2);
		expect(h.lastMessage()).toContain("usage: unavailable — access token expired");
	});

	it("renders multi-day durations", async () => {
		const snapshot: UsageSnapshot = {
			fetchedAtMs: NOW,
			windows: { five_hour: { utilization: 12, resetsAtMs: NOW + 2 * DAY_MS } },
		};
		const h = harness(twoProfileConfig(), { now: () => NOW, fetchUsage: snapshotFetch(snapshot) });
		// A cooldown is capped at 24h, so this exercises the `d` branch; the usage
		// reset below exercises the `2d` branch with no cap in the way.
		h.router.recordRateLimit("a", { resetsAt: (NOW + DAY_MS) / 1000 }, "m");
		await h.run("status");
		expect(h.lastMessage()).toContain("cooldown: remaining 1d (unknown)");
		expect(h.lastMessage()).toContain("usage: 5h 12% (resets in 2d)");
	});

	it("probes and refetches when the token is unauthorized", async () => {
		const probes: string[] = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ profile: route }) => {
				probes.push(route.profileId);
				return {};
			},
		};
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			return calls === 1 ? { ok: false, reason: "unauthorized" } : { ok: true, snapshot: successSnapshot() };
		};
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => NOW, host, fetchUsage });

		await h.run("status");

		expect(probes).toEqual(["a"]);
		expect(calls).toBe(2);
		expect(h.lastMessage()).toContain("usage: 5h 12%");
	});

	it("backs off a persistently ineffective probe and retries after the window", async () => {
		const probes: string[] = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ profile: route }) => {
				probes.push(route.profileId);
				return {};
			},
		};
		let calls = 0;
		const fetchUsage: FetchUsage = async () => {
			calls += 1;
			return { ok: false, reason: "token-expired" };
		};
		let current = NOW;
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => current, host, fetchUsage });

		await h.run("status");
		expect(probes).toEqual(["a"]);
		expect(calls).toBe(2);

		// Within the backoff the plain fetch still runs, but no probe (and no refetch).
		await h.run("status");
		expect(probes).toEqual(["a"]);
		expect(calls).toBe(3);

		current += STATUS_PROBE_BACKOFF_MS;
		await h.run("status");
		expect(probes).toEqual(["a", "a"]);
		expect(calls).toBe(5);
	});

	it("does not back off when the probe fixes the token", async () => {
		const probes: string[] = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ profile: route }) => {
				probes.push(route.profileId);
				return {};
			},
		};
		const scripted: UsageFetchResult[] = [
			{ ok: false, reason: "token-expired" },
			{ ok: true, snapshot: successSnapshot() },
			{ ok: false, reason: "token-expired" },
			{ ok: true, snapshot: successSnapshot() },
		];
		let index = 0;
		const fetchUsage: FetchUsage = async () => {
			const result = scripted[Math.min(index, scripted.length - 1)];
			index += 1;
			return result ?? { ok: false, reason: "network" };
		};
		const config: RotatorConfig = { policy: "balanced", path: "/tmp/rotator-config.json", profiles: [profile("a")] };
		const h = harness(config, { now: () => NOW, host, fetchUsage });

		await h.run("status");
		await h.run("status");

		// A successful refetch is not a backoff: the next failure probes again.
		expect(probes).toEqual(["a", "a"]);
	});
});

describe("login", () => {
	it("prepares a CLAUDE_CONFIG_DIR login command for every profile", async () => {
		const h = harness(twoProfileConfig());
		await h.run("login");
		expect(h.lastLevel()).toBe("info");
		expect(h.mkdirCalls).toEqual(["/tmp/rotator-accounts/a", "/tmp/rotator-accounts/b"]);
		expect(h.lastMessage()).toContain("CLAUDE_CONFIG_DIR=/tmp/rotator-accounts/a claude auth login");
		expect(h.lastMessage()).toContain("CLAUDE_CONFIG_DIR=/tmp/rotator-accounts/b claude auth login");
	});

	it("targets a single profile by id", async () => {
		const h = harness(twoProfileConfig());
		await h.run("login a");
		expect(h.mkdirCalls).toEqual(["/tmp/rotator-accounts/a"]);
		expect(h.lastMessage()).not.toContain("rotator-accounts/b");
	});

	it("targets a single profile by label", async () => {
		const h = harness(twoProfileConfig());
		await h.run("login B");
		expect(h.mkdirCalls).toEqual(["/tmp/rotator-accounts/b"]);
	});

	it("warns and creates nothing for an unknown profile", async () => {
		const h = harness(twoProfileConfig());
		await h.run("login nope");
		expect(h.lastLevel()).toBe("warning");
		expect(h.lastMessage()).toContain('unknown profile "nope"');
		expect(h.mkdirCalls).toEqual([]);
	});

	it("reports a config error instead of running", async () => {
		const h = harness(twoProfileConfig());
		h.state.config = undefined;
		h.state.router = undefined;
		h.state.configError = "config is broken";
		await h.run("login");
		expect(h.lastLevel()).toBe("error");
		expect(h.lastMessage()).toContain("config is broken");
		expect(h.mkdirCalls).toEqual([]);
	});
});

describe("login wizard", () => {
	interface WizardContext {
		configPath: string;
		env: NodeJS.ProcessEnv;
	}

	function wizardContext(): WizardContext {
		const dir = makeTempDir();
		return { configPath: join(dir, "claude-bridge-rotator.json"), env: { PI_CODING_AGENT_DIR: dir } };
	}

	it("logs in a selected existing profile through the dialogs", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ selectResponses: ["A"], inputResponses: ["123456"] });
		const login = fakeLogin();
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async () => ({ identity: { email: "a@example.com", subscriptionType: "max" } }),
		};
		const h = harness(twoProfileConfig(), { ui: dialogs.ui, startLogin: login.startLogin, configPath, env, host });

		await h.run("login");

		expect(dialogs.selects[0]?.title).toBe("Log in to which account?");
		expect(dialogs.selects[0]?.options).toEqual(["A", "B", "Add a new account…"]);
		expect(login.calls).toEqual(["/tmp/rotator-accounts/a"]);
		expect(login.submitted).toEqual(["123456"]);
		expect(h.mkdirCalls).toEqual(["/tmp/rotator-accounts/a"]);
		expect(h.lastLevel()).toBe("info");
		expect(h.lastMessage()).toContain("a@example.com");
		expect(h.store.state.identity.a?.email).toBe("a@example.com");
		// Existing profiles are never rewritten.
		expect(existsSync(configPath)).toBe(false);
	});

	it("passes a 15s deadline to the post-login identity probe", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ selectResponses: ["A"], inputResponses: ["123456"] });
		const deadlines: Array<number | undefined> = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ deadlineMs }) => {
				deadlines.push(deadlineMs);
				return { identity: { email: "a@example.com" } };
			},
		};
		const h = harness(twoProfileConfig(), {
			ui: dialogs.ui,
			startLogin: fakeLogin().startLogin,
			configPath,
			env,
			host,
		});

		await h.run("login");

		expect(deadlines).toEqual([15000]);
	});

	it("creates a new profile, writes the config, refreshes, and logs in", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ inputResponses: ["Personal", "111111"], confirmResponses: [false] });
		const login = fakeLogin();
		let refreshes = 0;
		const config: RotatorConfig = { policy: "balanced", path: configPath, profiles: [] };
		const h = harness(config, {
			ui: dialogs.ui,
			startLogin: login.startLogin,
			configPath,
			env,
			onRefresh: () => {
				refreshes += 1;
			},
		});

		await h.run("login");

		const expectedDir = join(homedir(), ".claude-rotator", "personal");
		expect(dialogs.inputs[0]?.title).toBe("Account label");
		expect(dialogs.inputs[1]?.title).toBe("Paste the login code");
		expect(login.calls).toEqual([expectedDir]);
		expect(h.mkdirCalls).toEqual([expectedDir]);
		expect(refreshes).toBe(1);
		expect(dialogs.confirms.some((entry) => entry.title === "Add another account?")).toBe(true);
		const saved = loadConfig({ configPath });
		expect(saved.profiles).toEqual([{ id: "personal", label: "Personal", configDir: expectedDir }]);
		expect(h.lastMessage()).toContain("logged in Personal");
	});

	it("offers to create an unknown argument and logs it in", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ confirmResponses: [true], inputResponses: ["999999"] });
		const login = fakeLogin();
		let refreshes = 0;
		const h = harness(twoProfileConfig(), {
			ui: dialogs.ui,
			startLogin: login.startLogin,
			configPath,
			env,
			onRefresh: () => {
				refreshes += 1;
			},
		});

		await h.run("login Work");

		expect(dialogs.confirms[0]?.title).toBe("Create new account?");
		expect(login.calls).toEqual([join(homedir(), ".claude-rotator", "work")]);
		expect(refreshes).toBe(1);
		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["a", "b", "work"]);
	});

	it("declines to create an unknown argument", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ confirmResponses: [false] });
		const login = fakeLogin();
		const h = harness(twoProfileConfig(), { ui: dialogs.ui, startLogin: login.startLogin, configPath, env });

		await h.run("login nope");

		expect(login.calls).toEqual([]);
		expect(h.lastMessage()).toContain("no account added");
		expect(existsSync(configPath)).toBe(false);
	});

	it("cancels cleanly when the code dialog is dismissed", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ selectResponses: ["A"], inputResponses: [undefined] });
		const login = fakeLogin();
		const h = harness(twoProfileConfig(), { ui: dialogs.ui, startLogin: login.startLogin, configPath, env });

		await h.run("login");

		expect(login.wasCancelled()).toBe(true);
		expect(login.submitted).toEqual([]);
		expect(h.lastMessage()).toContain("login cancelled");
	});

	it("reports a submit failure with the child output tail", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ selectResponses: ["A"], inputResponses: ["bad"] });
		const login = fakeLogin({ ok: false, output: "invalid code, try again" });
		const h = harness(twoProfileConfig(), { ui: dialogs.ui, startLogin: login.startLogin, configPath, env });

		await h.run("login");

		expect(h.lastLevel()).toBe("error");
		expect(h.lastMessage()).toContain("failed");
		expect(h.lastMessage()).toContain("invalid code, try again");
	});

	it("keeps a successful login successful when the identity probe fails", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ selectResponses: ["A"], inputResponses: ["123456"] });
		const login = fakeLogin();
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async () => {
				throw new Error("probe down");
			},
		};
		const h = harness(twoProfileConfig(), { ui: dialogs.ui, startLogin: login.startLogin, configPath, env, host });

		await h.run("login");

		expect(h.lastLevel()).toBe("info");
		expect(h.lastMessage()).toContain("logged in A");
	});

	it("adds multiple accounts in one session", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({
			inputResponses: ["Personal", "111111", "Work", "222222"],
			confirmResponses: [true, false],
		});
		const login = fakeLogin();
		let refreshes = 0;
		const config: RotatorConfig = { policy: "balanced", path: configPath, profiles: [] };
		const h = harness(config, {
			ui: dialogs.ui,
			startLogin: login.startLogin,
			configPath,
			env,
			onRefresh: () => {
				refreshes += 1;
			},
		});

		await h.run("login");

		expect(login.calls).toEqual([
			join(homedir(), ".claude-rotator", "personal"),
			join(homedir(), ".claude-rotator", "work"),
		]);
		expect(refreshes).toBe(2);
		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["personal", "work"]);
	});

	it("enters the add flow when the add option is selected", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({
			selectResponses: ["Add a new account…"],
			inputResponses: ["Side", "333333"],
			confirmResponses: [false],
		});
		const login = fakeLogin();
		const h = harness(twoProfileConfig(), {
			ui: dialogs.ui,
			startLogin: login.startLogin,
			configPath,
			env,
			onRefresh: () => {},
		});

		await h.run("login");

		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["a", "b", "side"]);
	});

	it("backs up a broken existing config before overwriting it", async () => {
		const { configPath, env } = wizardContext();
		const broken = "{ not valid json ";
		writeFileSync(configPath, broken, "utf8");
		const dialogs = scriptedDialogs({ inputResponses: ["Recovered", "111111"], confirmResponses: [false] });
		const login = fakeLogin();
		const h = harness(
			{ policy: "balanced", path: configPath, profiles: [] },
			{ ui: dialogs.ui, startLogin: login.startLogin, configPath, env },
		);
		// Simulate the broken-config state the extension records on a failed load.
		h.state.config = undefined;
		h.state.configError = "broken";

		await h.run("login");

		expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(broken);
		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["recovered"]);
		expect(login.calls).toEqual([join(homedir(), ".claude-rotator", "recovered")]);
		expect(h.lastMessage()).toContain("logged in Recovered");
	});

	it("continues the login when the config backup fails", async () => {
		const { configPath, env } = wizardContext();
		writeFileSync(configPath, "{ broken", "utf8");
		const dialogs = scriptedDialogs({ inputResponses: ["Recovered", "111111"], confirmResponses: [false] });
		const login = fakeLogin();
		const h = harness(
			{ policy: "balanced", path: configPath, profiles: [] },
			{
				ui: dialogs.ui,
				startLogin: login.startLogin,
				configPath,
				env,
				backupConfigFile: () => {
					throw new Error("disk full");
				},
			},
		);
		h.state.config = undefined;
		h.state.configError = "broken";

		await h.run("login");

		const warning = h.notifies.find((entry) => entry.level === "warning");
		expect(warning?.message).toContain("could not back up");
		expect(existsSync(`${configPath}.bak`)).toBe(false);
		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["recovered"]);
		expect(login.calls).toHaveLength(1);
	});

	it("does not create a backup for a fresh setup", async () => {
		const { configPath, env } = wizardContext();
		const dialogs = scriptedDialogs({ inputResponses: ["Personal", "111111"], confirmResponses: [false] });
		const login = fakeLogin();
		const h = harness(
			{ policy: "balanced", path: configPath, profiles: [] },
			{ ui: dialogs.ui, startLogin: login.startLogin, configPath, env },
		);

		await h.run("login");

		expect(existsSync(configPath)).toBe(true);
		expect(existsSync(`${configPath}.bak`)).toBe(false);
	});

	it("does not back up a loadable existing config when appending", async () => {
		const { configPath, env } = wizardContext();
		writeFileSync(
			configPath,
			JSON.stringify({ policy: "balanced", profiles: [profile("a"), profile("b")] }),
			"utf8",
		);
		const dialogs = scriptedDialogs({
			selectResponses: ["Add a new account…"],
			inputResponses: ["Side", "333333"],
			confirmResponses: [false],
		});
		const login = fakeLogin();
		const h = harness(twoProfileConfig(), {
			ui: dialogs.ui,
			startLogin: login.startLogin,
			configPath,
			env,
			onRefresh: () => {},
		});

		await h.run("login");

		expect(existsSync(`${configPath}.bak`)).toBe(false);
		expect(loadConfig({ configPath }).profiles.map((entry) => entry.id)).toEqual(["a", "b", "side"]);
	});
});

describe("reset", () => {
	it("clears cooldowns and invalid flags while preserving affinity and identity", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordIdentity("a", { email: "a@example.com" });
		h.router.recordSuccess("a", "s1");
		h.router.recordRateLimit("a", { resetsAt: (START_MS + 10 * MINUTE_MS) / 1000 }, "m");
		h.router.recordFailure("b", "billing", "m");

		await h.run("reset");

		expect(h.lastLevel()).toBe("info");
		expect(h.lastMessage()).toContain("Cleared cooldowns: a");
		expect(h.lastMessage()).toContain("Cleared invalid flags: b");
		expect(h.store.state.cooldowns).toEqual({});
		expect(h.store.state.invalid).toEqual([]);
		expect(h.store.state.sessionAffinity.s1).toBe("a");
		expect(h.store.state.identity.a?.email).toBe("a@example.com");
	});

	it("clears only the targeted profile", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordRateLimit("a", { resetsAt: (START_MS + 10 * MINUTE_MS) / 1000 }, "m");
		h.router.recordFailure("b", "auth", "m");

		await h.run("reset a");

		expect(h.store.state.cooldowns.a).toBeUndefined();
		expect(h.store.state.invalid).toContain("b");
	});

	it("reports when there is nothing to clear", async () => {
		const h = harness(twoProfileConfig());
		await h.run("reset");
		expect(h.lastMessage()).toContain("No active cooldowns to clear.");
		expect(h.lastMessage()).toContain("No invalid profiles to clear.");
	});

	it("warns and changes nothing for an unknown profile", async () => {
		const h = harness(twoProfileConfig());
		h.router.recordFailure("a", "auth", "m");
		await h.run("reset nope");
		expect(h.lastLevel()).toBe("warning");
		expect(h.store.state.invalid).toContain("a");
	});
});

describe("probe", () => {
	function hostProbe(
		results: Partial<Record<string, unknown>>,
		throwing: readonly string[] = [],
	): { host: ClaudeBridgeAccountHostV1; calls: string[] } {
		const calls: string[] = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ profile: route }) => {
				calls.push(route.profileId);
				if (throwing.includes(route.profileId)) throw new Error(`boom ${route.profileId}`);
				const result = results[route.profileId];
				return (result ?? {}) as Awaited<ReturnType<ClaudeBridgeAccountHostV1["probeProfile"]>>;
			},
		};
		return { host, calls };
	}

	it("records and displays identity from the host", async () => {
		const { host } = hostProbe({
			a: { identity: { email: "a@example.com", subscriptionType: "pro" }, usage: { five_hour: 42 } },
			b: { identity: { email: "b@example.com" } },
		});
		const h = harness(twoProfileConfig(), { host });
		await h.run("probe");
		expect(h.lastMessage()).toContain("a@example.com");
		expect(h.lastMessage()).toContain("usage:");
		expect(h.store.state.identity.a?.email).toBe("a@example.com");
		expect(h.store.state.identity.b?.email).toBe("b@example.com");
	});

	it("warns when the bridge host is absent", async () => {
		const h = harness(twoProfileConfig());
		await h.run("probe");
		expect(h.lastLevel()).toBe("warning");
		expect(h.lastMessage()).toContain("no account host");
		expect(h.lastMessage()).toContain("@vanillagreen/pi-claude-bridge");
	});

	it("treats an empty probe result as no identity, not an error", async () => {
		const { host } = hostProbe({ a: {}, b: {} });
		const h = harness(twoProfileConfig(), { host });
		await h.run("probe");
		expect(h.lastLevel()).toBe("info");
		expect(h.lastMessage()).toContain("no identity reported");
		expect(h.store.state.identity.a).toBeUndefined();
	});

	it("isolates a per-profile probe failure", async () => {
		const { host } = hostProbe({ b: { identity: { email: "b@example.com" } } }, ["a"]);
		const h = harness(twoProfileConfig(), { host });
		await h.run("probe");
		expect(h.lastMessage()).toContain("probe failed — boom a");
		expect(h.lastMessage()).toContain("b@example.com");
		expect(h.store.state.identity.b?.email).toBe("b@example.com");
	});

	it("probes a single targeted profile", async () => {
		const { host, calls } = hostProbe({ b: { identity: { email: "b@example.com" } } });
		const h = harness(twoProfileConfig(), { host });
		await h.run("probe b");
		expect(calls).toEqual(["b"]);
	});

	it("shows the plan usage line after probing", async () => {
		const { host } = hostProbe({ a: { identity: { email: "a@example.com" } } });
		const snapshot: UsageSnapshot = {
			fetchedAtMs: START_MS,
			windows: { five_hour: { utilization: 12, resetsAtMs: null } },
		};
		const h = harness(twoProfileConfig(), { host, fetchUsage: async () => ({ ok: true, snapshot }) });
		await h.run("probe a");
		expect(h.lastMessage()).toContain("a@example.com · usage: 5h 12% (window not started)");
	});

	it("passes a 15s deadline to probeProfile", async () => {
		const deadlines: Array<number | undefined> = [];
		const host: ClaudeBridgeAccountHostV1 = {
			version: 1,
			probeProfile: async ({ deadlineMs }) => {
				deadlines.push(deadlineMs);
				return { identity: { email: "a@example.com" } };
			},
		};
		const h = harness(twoProfileConfig(), { host });
		await h.run("probe a");
		expect(deadlines).toEqual([15000]);
	});
});

describe("arg parsing and dispatch", () => {
	it("warns on an unknown subcommand listing the valid ones", async () => {
		const h = harness(twoProfileConfig());
		await h.run("frobnicate");
		expect(h.lastLevel()).toBe("warning");
		expect(h.lastMessage()).toContain('unknown subcommand "frobnicate"');
		expect(h.lastMessage()).toContain("status, login, reset, probe");
	});

	it("tolerates surrounding whitespace and defaults to status", async () => {
		const h = harness(twoProfileConfig());
		await h.run("   ");
		expect(h.lastMessage()).toContain("policy: balanced");
	});
});
