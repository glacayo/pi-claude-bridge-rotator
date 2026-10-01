// Extension wiring tests: command registration, router publishing/ownership,
// and session lifecycle. The real default export is exercised against a fake
// `pi` object with a temp agent dir, so nothing touches the real environment.

import { afterEach, describe, expect, it } from "vitest";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cleanupTempDirs, makeTempDir, profile } from "./helpers.js";
import type { RotatorConfig } from "../src/config.js";
import { createRouter, CLAUDE_ACCOUNT_ROUTER_SYMBOL } from "../src/router.js";
import { CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL, resolveBridgeAccountHost } from "../src/host.js";
import type { GlobalTarget } from "../src/host.js";
import type { RotatorCommandState } from "../src/commands.js";
import { activateExtension, RouterPublisher } from "../src/index.js";
import activate, { createRotatorCommandHandler } from "../src/index.js";

const COMMAND_STATE_SYMBOL = Symbol.for("pi-claude-bridge-rotator:commandState");

function commandState(target: GlobalTarget): RotatorCommandState {
	return target[COMMAND_STATE_SYMBOL] as RotatorCommandState;
}

afterEach(() => {
	cleanupTempDirs();
	// Defensive: no test writes these tokens to the real global (each test uses
	// a fresh `pi` object and `globalTarget`), but clear them so a future
	// default-target call can never leak registration/state across tests.
	// SAFETY: `globalThis` is a plain object at runtime; symbol-keyed deletes are
	// valid even though its TypeScript type has no symbol index signature.
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	for (const key of [
		Symbol.for("pi-claude-bridge-rotator:commandsRegistered"),
		Symbol.for("pi-claude-bridge-rotator:commandState"),
		Symbol.for("pi-claude-bridge-rotator:bridgeAbsentWarned"),
		CLAUDE_ACCOUNT_ROUTER_SYMBOL,
		CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL,
	]) {
		delete globals[key];
	}
});

interface FakePi {
	pi: ExtensionAPI;
	registered: string[];
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
}

function makeFakePi(): FakePi {
	const registered: string[] = [];
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const fake = {
		registerCommand: (name: string): void => {
			registered.push(name);
		},
		on: (event: string, handler: (...args: unknown[]) => unknown): void => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	};
	// SAFETY: the extension only calls `registerCommand` and `on`, and this fake
	// implements both with the same runtime shape the real `pi` object has.
	return { pi: fake as unknown as ExtensionAPI, registered, handlers };
}

interface AgentDir {
	dir: string;
	env: NodeJS.ProcessEnv;
	config: RotatorConfig;
}

function makeAgentDir(withConfig: boolean): AgentDir {
	const dir = makeTempDir("rotator-agent-");
	const config: RotatorConfig = {
		policy: "balanced",
		path: join(dir, "claude-bridge-rotator.json"),
		profiles: [
			profile("a", { configDir: join(dir, "acc-a") }),
			profile("b", { configDir: join(dir, "acc-b") }),
		],
	};
	if (withConfig) {
		writeFileSync(
			config.path,
			JSON.stringify({ policy: "balanced", profiles: config.profiles }),
			"utf8",
		);
	}
	return { dir, env: { PI_CODING_AGENT_DIR: dir }, config };
}

describe("RouterPublisher ownership", () => {
	function routerFor(id: string): ReturnType<typeof createRouter> {
		const config: RotatorConfig = { policy: "balanced", path: `/tmp/${id}.json`, profiles: [profile(id)] };
		return createRouter(config, { statePath: join(makeTempDir(), "state.json") });
	}

	it("claims an empty slot and refuses a foreign value", () => {
		const target: GlobalTarget = {};
		const first = new RouterPublisher(target);
		const second = new RouterPublisher(target);
		const routerA = routerFor("a");
		const routerB = routerFor("b");

		expect(first.publish(routerA)).toBe(true);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(routerA);
		expect(first.owned).toBe(true);

		expect(second.publish(routerB)).toBe(false);
		expect(second.owned).toBe(false);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(routerA);
	});

	it("re-publishes its own value but never a foreign one", () => {
		const target: GlobalTarget = {};
		const publisher = new RouterPublisher(target);
		const routerA = routerFor("a");
		const routerB = routerFor("b");
		expect(publisher.publish(routerA)).toBe(true);
		expect(publisher.publish(routerB)).toBe(true);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(routerB);
	});

	it("unpublishes only what it owns and is idempotent", () => {
		const target: GlobalTarget = {};
		const publisher = new RouterPublisher(target);
		const routerA = routerFor("a");
		publisher.publish(routerA);

		expect(publisher.unpublish()).toBe(true);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeUndefined();
		expect(publisher.unpublish()).toBe(false);
	});

	it("leaves a foreign replacement untouched on shutdown", () => {
		const target: GlobalTarget = {};
		const publisher = new RouterPublisher(target);
		const routerA = routerFor("a");
		const routerB = routerFor("b");
		publisher.publish(routerA);
		target[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = routerB;

		expect(publisher.unpublish()).toBe(false);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(routerB);
	});
});

describe("activateExtension wiring", () => {
	it("registers /claude-accounts and publishes the router on a valid config", () => {
		const { pi, registered } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });

		expect(registered).toEqual(["claude-accounts"]);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeDefined();
		expect(resolveBridgeAccountHost(target)).toBeUndefined();
	});

	it("still registers the command on a broken config but publishes nothing", () => {
		const { pi, registered, handlers } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(false);

		expect(() => activateExtension(pi, { globalTarget: target, env: agent.env })).not.toThrow();
		expect(registered).toEqual(["claude-accounts"]);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeUndefined();

		const notifies: string[] = [];
		for (const handler of handlers.get("session_start") ?? []) {
			handler({}, { ui: { notify: (message: string) => notifies.push(message) } });
		}
		expect(notifies).toEqual([]);
	});

	it("does not re-register the command on a reload and keeps the first router", () => {
		const { pi, registered, handlers } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });
		const firstRouter = target[CLAUDE_ACCOUNT_ROUTER_SYMBOL];

		activateExtension(pi, { globalTarget: target, env: agent.env });

		expect(registered).toEqual(["claude-accounts"]);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(firstRouter);
		expect(handlers.get("session_shutdown")?.length).toBe(2);
	});

	it("clears an owned symbol on session_shutdown", () => {
		const { pi, handlers } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeDefined();

		for (const handler of handlers.get("session_shutdown") ?? []) handler();
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeUndefined();
	});

	it("warns once per process when the bridge is absent", () => {
		const { pi, handlers } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });
		const startHandlers = handlers.get("session_start") ?? [];
		const notifies: string[] = [];
		const ctx = { ui: { notify: (message: string) => notifies.push(message) } };

		for (const handler of startHandlers) handler({}, ctx);
		for (const handler of startHandlers) handler({}, ctx);

		expect(notifies).toHaveLength(1);
		expect(notifies[0]).toContain("no @vanillagreen/pi-claude-bridge account host");
	});

	it("does not warn when the bridge account host is present", () => {
		const { pi, handlers } = makeFakePi();
		const target: GlobalTarget = {};
		target[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL] = { version: 1, probeProfile: async () => ({}) };
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });
		const notifies: string[] = [];
		for (const handler of handlers.get("session_start") ?? []) {
			handler({}, { ui: { notify: (message: string) => notifies.push(message) } });
		}
		expect(notifies).toEqual([]);
	});

	it("exposes a working default export", () => {
		const { pi, registered } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activate(pi, { globalTarget: target, env: agent.env });

		expect(registered).toEqual(["claude-accounts"]);
		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBeDefined();
		expect(typeof createRotatorCommandHandler).toBe("function");
	});
});

describe("refresh hook", () => {
	it("rebuilds and republishes the router with the new config", () => {
		const { pi } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);
		activateExtension(pi, { globalTarget: target, env: agent.env });
		const first = target[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
		const state = commandState(target);

		writeFileSync(
			agent.config.path,
			JSON.stringify({
				policy: "balanced",
				profiles: [
					profile("a", { configDir: join(agent.dir, "acc-a") }),
					profile("b", { configDir: join(agent.dir, "acc-b") }),
					profile("c", { configDir: join(agent.dir, "acc-c") }),
				],
			}),
			"utf8",
		);

		state.refresh?.();

		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).not.toBe(first);
		expect(state.config?.profiles.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
		expect(state.configError).toBeUndefined();
	});

	it("stores the first activation's publisher once", () => {
		const { pi } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);

		activateExtension(pi, { globalTarget: target, env: agent.env });
		const state = commandState(target);
		const firstPublisher = state.publisher;
		expect(firstPublisher).toBeDefined();

		activateExtension(pi, { globalTarget: target, env: agent.env });

		expect(commandState(target).publisher).toBe(firstPublisher);
	});

	it("keeps the previous router published when the refresh fails", () => {
		const { pi } = makeFakePi();
		const target: GlobalTarget = {};
		const agent = makeAgentDir(true);
		activateExtension(pi, { globalTarget: target, env: agent.env });
		const first = target[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
		const state = commandState(target);

		unlinkSync(agent.config.path);
		state.refresh?.();

		expect(target[CLAUDE_ACCOUNT_ROUTER_SYMBOL]).toBe(first);
		expect(state.configError).toBeDefined();
		expect(state.config).toBeUndefined();
	});
});
