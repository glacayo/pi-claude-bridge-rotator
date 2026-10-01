// `/claude-accounts` command tests. Everything is driven through the real
// handler with injected state, clock, host, and filesystem seam; temp dirs keep
// the real agent directory untouched.

import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir, profile } from "./helpers.js";
import type { RotatorConfig } from "../src/config.js";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL, ClaudeAccountRouter } from "../src/router.js";
import { RotatorStateStore } from "../src/state.js";
import type { ClaudeBridgeAccountHostV1, GlobalTarget } from "../src/host.js";
import { createRotatorCommandHandler } from "../src/commands.js";
import type { NotifyLevel, RotatorCommandContext, RotatorCommandState } from "../src/commands.js";

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

function harness(
	config: RotatorConfig,
	options: { now?: (() => number) | undefined; host?: ClaudeBridgeAccountHostV1 | undefined } = {},
): Harness {
	const dir = makeTempDir();
	const now = options.now ?? (() => START_MS);
	const store = new RotatorStateStore({ statePath: join(dir, "state.json"), now });
	const router = new ClaudeAccountRouter({ profiles: config.profiles, state: store, now });
	const state: RotatorCommandState = { config, router };
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
	});
	const run = async (args: string, ctx: Omit<Partial<RotatorCommandContext>, "ui"> = {}): Promise<void> => {
		await handler(args, {
			ui: { notify: (message, level) => notifies.push({ message, level }) },
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

describe("login", () => {
	it("prepares a CLAUDE_CONFIG_DIR login command for every profile", async () => {
		const h = harness(twoProfileConfig());
		await h.run("login");
		expect(h.lastLevel()).toBe("info");
		expect(h.mkdirCalls).toEqual(["/tmp/rotator-accounts/a", "/tmp/rotator-accounts/b"]);
		expect(h.lastMessage()).toContain("CLAUDE_CONFIG_DIR=/tmp/rotator-accounts/a claude login");
		expect(h.lastMessage()).toContain("CLAUDE_CONFIG_DIR=/tmp/rotator-accounts/b claude login");
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
