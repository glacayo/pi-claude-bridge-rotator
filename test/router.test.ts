import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cleanupTempDirs, makeTempDir, profile } from "./helpers.js";
import type { RotatorConfig, RotatorProfileConfig } from "../src/config.js";
import { RotatorStateStore } from "../src/state.js";
import {
	AllProfilesUnavailableError,
	CLAUDE_ACCOUNT_ROUTER_SYMBOL,
	ClaudeAccountRouter,
	createRouter,
	DEFAULT_COOLDOWN_MS,
	MAX_COOLDOWN_MS,
	rateLimitResetFromInfo,
	rateLimitTypeFromInfo,
	resetTimestampMs,
} from "../src/router.js";
import type { ClaudeAccountAcquireInput, ClaudeAccountFailureKind, ClaudeAccountRouterV1 } from "../src/router.js";

afterEach(cleanupTempDirs);

const START_MS = 1_800_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

interface Harness {
	router: ClaudeAccountRouterV1 & ClaudeAccountRouter;
	store: RotatorStateStore;
	storePath: string;
	now: () => number;
	advance: (ms: number) => void;
	warnings: string[];
}

function harness(profiles: RotatorProfileConfig[], startMs = START_MS): Harness {
	const dir = makeTempDir();
	const storePath = join(dir, "state.json");
	let currentMs = startMs;
	const warnings: string[] = [];
	const now = (): number => currentMs;
	const store = new RotatorStateStore({ statePath: storePath, now, onWarn: (message) => warnings.push(message) });
	const router = new ClaudeAccountRouter({
		profiles,
		state: store,
		now,
		onWarn: (message) => warnings.push(message),
	});
	return {
		router,
		store,
		storePath,
		now,
		advance: (ms: number) => {
			currentMs += ms;
		},
		warnings,
	};
}

function captureThrow(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("contract shape", () => {
	it("exposes the published v1 router shape", () => {
		const { router } = harness([profile("a"), profile("b")]);

		expect(router.version).toBe(1);
		expect(CLAUDE_ACCOUNT_ROUTER_SYMBOL).toBe(Symbol.for("kendex.pi.claude-account-router.v1"));
		const methods: readonly (keyof ClaudeAccountRouterV1)[] = [
			"acquire",
			"recordIdentity",
			"recordUsage",
			"recordRateLimit",
			"recordFailure",
			"recordSuccess",
			"current",
			"resolveProfile",
		];
		for (const method of methods) {
			expect(typeof router[method]).toBe("function");
		}
	});

	it("issues a route with the exact absolute config dir and no v1 model override", () => {
		const { router } = harness([profile("a", { configDir: "/tmp/accounts/a" })]);

		const route = router.acquire({ modelId: "claude-sonnet-4-6" });

		expect(route).toEqual({ profileId: "a", label: "A", configDir: "/tmp/accounts/a" });
		expect(isAbsolute(route.configDir ?? "")).toBe(true);
		expect(route.modelId).toBeUndefined();
		expect(route.fallbackReason).toBeUndefined();
	});
});

describe("rotation and affinity", () => {
	it("alternates profiles round-robin for new sessions", () => {
		const { router } = harness([profile("a"), profile("b")]);

		const ids = ["s1", "s2", "s3", "s4"].map(
			(sessionId) => router.acquire({ modelId: "m", sessionId }).profileId,
		);

		expect(ids).toEqual(["a", "b", "a", "b"]);
	});

	it("keeps a bound session on its profile and does not advance the cursor", () => {
		const { router } = harness([profile("a"), profile("b"), profile("c")]);

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
		router.recordSuccess("a", "s1");
		expect(router.acquire({ modelId: "m", sessionId: "s2" }).profileId).toBe("b");
		expect(router.acquire({ modelId: "m", sessionId: "s3" }).profileId).toBe("c");
		expect(router.acquire({ modelId: "m", sessionId: "s4" }).profileId).toBe("a");
		// The cursor now points at "b", so only affinity can explain "a" here.
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
		// An affinity hit must leave the cursor where it was: the next fresh
		// session continues the round-robin with "b".
		expect(router.acquire({ modelId: "m", sessionId: "s5" }).profileId).toBe("b");
	});

	it("bypasses affinity when the bound profile is cooling", () => {
		const { router, now } = harness([profile("a"), profile("b")]);
		router.recordSuccess("a", "s1");
		router.recordRateLimit("a", { resetsAt: (now() + HOUR_MS) / 1000 }, "m");

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
	});

	it("bypasses affinity when the bound profile needs a re-login", () => {
		const { router } = harness([profile("a"), profile("b")]);
		router.recordSuccess("a", "s1");
		router.recordFailure("a", "auth", "m");

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
	});

	it("bypasses affinity when the bound profile is excluded", () => {
		const { router } = harness([profile("a"), profile("b")]);
		router.recordSuccess("a", "s1");

		const route = router.acquire({ modelId: "m", sessionId: "s1", excludedProfileIds: ["a"] });

		expect(route.profileId).toBe("b");
	});

	it("returns to the bound profile once its cooldown expires", () => {
		const { router, now, advance } = harness([profile("a"), profile("b")]);
		router.recordSuccess("a", "s1");
		router.recordRateLimit("a", { resetsAt: (now() + 5 * MINUTE_MS) / 1000 }, "m");
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");

		advance(5 * MINUTE_MS + 1);

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
	});

	it("ignores affinity that points at a profile the config no longer holds", () => {
		const dir = makeTempDir();
		const statePath = join(dir, "state.json");
		writeFileSync(statePath, JSON.stringify({ version: 1, sessionAffinity: { s1: "removed" } }));
		const store = new RotatorStateStore({ statePath });
		const router = new ClaudeAccountRouter({ profiles: [profile("a")], state: store });

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
		expect(router.resolveProfile("removed")).toBeUndefined();
	});
});

describe("cooldowns", () => {
	it("skips a cooling profile and sends traffic to the other one", () => {
		const { router, now } = harness([profile("a"), profile("b")]);
		router.recordRateLimit("a", { resetsAt: (now() + 10 * MINUTE_MS) / 1000 }, "m");

		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
		expect(router.acquire({ modelId: "m", sessionId: "s2" }).profileId).toBe("b");
	});

	it("throws the soonest reset and its limit type when every profile is cooling", () => {
		const { router, now } = harness([profile("a"), profile("b")]);
		router.recordRateLimit("a", { resetsAt: (now() + 10 * MINUTE_MS) / 1000, rateLimitType: "five_hour" }, "m");
		const soonestMs = now() + 5 * MINUTE_MS;
		router.recordRateLimit("b", { resetsAt: soonestMs, rateLimitType: "weekly" }, "m");

		const thrown = captureThrow(() => router.acquire({ modelId: "m", sessionId: "s3" }));

		expect(thrown).toBeInstanceOf(AllProfilesUnavailableError);
		const error = thrown as AllProfilesUnavailableError;
		expect(error.resetAtMs).toBe(soonestMs);
		expect(error.rateLimitType).toBe("weekly");
		expect(error.message).toContain("cooling");
		expect(error.message).toContain(new Date(soonestMs).toISOString());
		expect(error.message.length).toBeGreaterThan(20);
	});

	it("never shortens an active cooldown when a shorter reset arrives later", () => {
		const { router, now, store } = harness([profile("a")]);
		router.recordRateLimit("a", { resetsAt: (now() + 10 * MINUTE_MS) / 1000, rateLimitType: "five_hour" }, "m");

		router.recordRateLimit("a", { resetsAt: (now() + MINUTE_MS) / 1000, rateLimitType: "five_hour" }, "m");

		expect(store.state.cooldowns.a?.untilMs).toBe(now() + 10 * MINUTE_MS);
	});
});

describe("recordFailure kinds", () => {
	it("marks an auth failure invalid and keeps it out of rotation", () => {
		const { router, store, advance } = harness([profile("a"), profile("b")]);

		router.recordFailure("a", "auth", "m");

		expect(store.state.invalid).toContain("a");
		expect(store.state.failures.a?.kind).toBe("auth");
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
		// Not time-based: still invalid a day later, unlike a cooldown.
		advance(24 * HOUR_MS);
		expect(router.acquire({ modelId: "m", sessionId: "s2" }).profileId).toBe("b");
	});

	it("marks a billing failure invalid", () => {
		const { router, store } = harness([profile("a"), profile("b")]);

		router.recordFailure("a", "billing", "m");

		expect(store.state.invalid).toContain("a");
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
	});

	it("applies a 30 minute cooldown for a rate-limit failure", () => {
		const { router, now, advance, store } = harness([profile("a"), profile("b")]);

		router.recordFailure("a", "rate-limit", "m");

		expect(store.state.cooldowns.a?.untilMs).toBe(now() + DEFAULT_COOLDOWN_MS);
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
		advance(DEFAULT_COOLDOWN_MS + 1);
		expect(router.acquire({ modelId: "m", sessionId: "s2", excludedProfileIds: ["b"] }).profileId).toBe("a");
	});

	it.each(["overloaded", "server", "network"] as const)("treats a %s failure as transient", (kind) => {
		const { router, store } = harness([profile("a"), profile("b")]);

		router.recordFailure("a", kind, "m");

		expect(store.state.invalid).not.toContain("a");
		expect(store.state.cooldowns.a).toBeUndefined();
		expect(store.state.failures.a?.kind).toBe(kind);
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
	});

	it("throws a manual-reset message when every profile needs a re-login", () => {
		const { router } = harness([profile("a"), profile("b")]);
		router.recordFailure("a", "auth", "m");
		router.recordFailure("b", "billing", "m");

		const thrown = captureThrow(() => router.acquire({ modelId: "m", sessionId: "s1" }));

		expect(thrown).toBeInstanceOf(AllProfilesUnavailableError);
		const error = thrown as AllProfilesUnavailableError;
		expect(error.resetAtMs).toBeUndefined();
		expect(error.rateLimitType).toBeUndefined();
		expect(error.message).toContain("/claude-accounts reset");
		expect(error.message).toContain("a, b");
	});
});

describe("excludedProfileIds", () => {
	it("never returns an excluded profile and exhausts within the bridge retry budget", () => {
		const { router } = harness([profile("a"), profile("b")]);
		const excluded = new Set<string>();
		let attempts = 0;
		let unavailable: AllProfilesUnavailableError | undefined;

		// Mirrors the bridge's failover loop: MAX_ROTATION_ATTEMPTS = 16
		// acquires, each excluding the profiles that already failed.
		while (attempts < 16) {
			const input: ClaudeAccountAcquireInput = {
				modelId: "m",
				sessionId: "s1",
				excludedProfileIds: [...excluded],
			};
			if (attempts > 0) {
				input.forceRerank = true;
				input.reason = "automatic-failover";
			}
			try {
				const route = router.acquire(input);
				expect(excluded.has(route.profileId)).toBe(false);
				excluded.add(route.profileId);
			} catch (error) {
				expect(error).toBeInstanceOf(AllProfilesUnavailableError);
				unavailable = error as AllProfilesUnavailableError;
				break;
			}
			attempts += 1;
		}

		expect(attempts).toBe(2);
		expect([...excluded]).toEqual(["a", "b"]);
		expect(unavailable).toBeInstanceOf(AllProfilesUnavailableError);
	});

	it("honors exclusions on both sides", () => {
		const { router } = harness([profile("a"), profile("b")]);

		expect(router.acquire({ modelId: "m", sessionId: "s1", excludedProfileIds: ["a"] }).profileId).toBe("b");
		expect(router.acquire({ modelId: "m", sessionId: "s1", excludedProfileIds: ["b"] }).profileId).toBe("a");
		const thrown = captureThrow(() => router.acquire({ modelId: "m", sessionId: "s1", excludedProfileIds: ["a", "b"] }));
		expect(thrown).toBeInstanceOf(AllProfilesUnavailableError);
	});
});

describe("recordRateLimit reset parsing", () => {
	it("treats a small number as epoch seconds", () => {
		const { router, now } = harness([profile("a")]);

		const untilMs = router.recordRateLimit("a", { resetsAt: (now() + 10 * MINUTE_MS) / 1000 }, "m");

		expect(untilMs).toBe(now() + 10 * MINUTE_MS);
	});

	it("treats a large number as epoch milliseconds", () => {
		const { router, now } = harness([profile("a")]);

		const untilMs = router.recordRateLimit("a", { resetsAt: now() + 10 * MINUTE_MS }, "m");

		expect(untilMs).toBe(now() + 10 * MINUTE_MS);
	});

	it("applies the same magnitude rule to numeric strings", () => {
		const { router, now } = harness([profile("a")]);
		const { router: second, now: secondNow } = harness([profile("a")]);

		expect(router.recordRateLimit("a", { resetsAt: String((now() + 10 * MINUTE_MS) / 1000) }, "m"))
			.toBe(now() + 10 * MINUTE_MS);
		expect(second.recordRateLimit("a", { resetsAt: String(secondNow() + 10 * MINUTE_MS) }, "m"))
			.toBe(secondNow() + 10 * MINUTE_MS);
	});

	it("parses ISO strings", () => {
		const { router, now } = harness([profile("a")]);
		const iso = new Date(now() + 10 * MINUTE_MS).toISOString();

		expect(router.recordRateLimit("a", { resetsAt: iso }, "m")).toBe(now() + 10 * MINUTE_MS);
	});

	it("caps a far-future reset at 24 hours", () => {
		const { router, now } = harness([profile("a")]);

		const untilMs = router.recordRateLimit("a", { resetsAt: now() + 5 * 24 * HOUR_MS }, "m");

		expect(untilMs).toBe(now() + MAX_COOLDOWN_MS);
	});

	it("sets no cooldown for a reset time already in the past", () => {
		const { router, now } = harness([profile("a")]);

		const untilMs = router.recordRateLimit("a", { resetsAt: (now() - 10 * MINUTE_MS) / 1000 }, "m");

		expect(untilMs).toBe(0);
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
	});

	it("clears an existing cooldown when the reset time is already in the past", () => {
		const { router, now, store } = harness([profile("a")]);
		router.recordRateLimit("a", { resetsAt: (now() + 10 * MINUTE_MS) / 1000 }, "m");

		router.recordRateLimit("a", { resetsAt: (now() - 10 * MINUTE_MS) / 1000 }, "m");

		expect(store.state.cooldowns.a).toBeUndefined();
	});

	it("falls back to 30 minutes when the reset time is missing or unparseable", () => {
		const { router, now, store } = harness([profile("a")]);

		expect(router.recordRateLimit("a", undefined, "m")).toBe(now() + DEFAULT_COOLDOWN_MS);
		expect(store.state.cooldowns.a?.untilMs).toBe(now() + DEFAULT_COOLDOWN_MS);
		expect(router.recordRateLimit("a", {}, "m")).toBe(now() + DEFAULT_COOLDOWN_MS);
		expect(router.recordRateLimit("a", { resetsAt: "whenever" }, "m")).toBe(now() + DEFAULT_COOLDOWN_MS);
		expect(router.recordRateLimit("a", { resetsAt: { nested: true } }, "m")).toBe(now() + DEFAULT_COOLDOWN_MS);
	});

	it("reads the reset field in the bridge's precedence order", () => {
		expect(rateLimitResetFromInfo({ resets_at: 111, resetAt: 222 })).toBe(111);
		expect(rateLimitResetFromInfo({ resetAt: 222, reset_at: 333 })).toBe(222);
		expect(rateLimitResetFromInfo({ reset_at: 333 })).toBe(333);
		expect(rateLimitResetFromInfo({ resetsAt: null, resets_at: 111 })).toBe(111);
		expect(rateLimitResetFromInfo(undefined)).toBeUndefined();

		const { router, now } = harness([profile("a")]);
		expect(router.recordRateLimit("a", { reset_at: (now() + 10 * MINUTE_MS) / 1000 }, "m")).toBe(now() + 10 * MINUTE_MS);
	});

	it("stores the rate limit type from the bridge field aliases", () => {
		const { router, store } = harness([profile("a")]);
		router.recordRateLimit("a", { resetsAt: 4_000_000_000, rateLimitType: "five_hour" }, "m");
		expect(store.state.cooldowns.a?.rateLimitType).toBe("five_hour");

		router.recordRateLimit("a", { resetsAt: 4_000_000_000, rate_limit_type: "seven_day" }, "m");
		expect(store.state.cooldowns.a?.rateLimitType).toBe("seven_day");

		router.recordRateLimit("a", { resetsAt: 4_000_000_000, type: "weekly" }, "m");
		expect(store.state.cooldowns.a?.rateLimitType).toBe("weekly");

		expect(rateLimitTypeFromInfo(undefined)).toBe("unknown");
		expect(rateLimitTypeFromInfo({ type: "   " })).toBe("unknown");
		expect(rateLimitTypeFromInfo({ type: 5 })).toBe("unknown");
	});
});

describe("resetTimestampMs", () => {
	it("renders the documented magnitude heuristic", () => {
		expect(resetTimestampMs(1_800_000_000)).toBe(1_800_000_000_000);
		expect(resetTimestampMs(1_800_000_000_000)).toBe(1_800_000_000_000);
		expect(resetTimestampMs("1800000000")).toBe(1_800_000_000_000);
		expect(resetTimestampMs("1800000000000")).toBe(1_800_000_000_000);
		expect(resetTimestampMs("2027-01-15T00:00:00.000Z")).toBe(Date.parse("2027-01-15T00:00:00.000Z"));
		expect(resetTimestampMs("not a date")).toBeUndefined();
		expect(resetTimestampMs("")).toBeUndefined();
		expect(resetTimestampMs(undefined)).toBeUndefined();
		expect(resetTimestampMs(Number.NaN)).toBeUndefined();
	});
});

describe("session reporting and profile resolution", () => {
	it("binds affinity on recordSuccess and reads it back from the store", () => {
		const { router, store } = harness([profile("a"), profile("b")]);

		router.recordSuccess("b", "s1");

		expect(store.state.sessionAffinity.s1).toBe("b");
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("b");
	});

	it("ignores recordSuccess without a session id", () => {
		const { router, store } = harness([profile("a")]);

		router.recordSuccess("a");

		expect(store.state.sessionAffinity).toEqual({});
	});

	it("reports the session route, then the global route, else undefined", () => {
		const { router } = harness([profile("a"), profile("b")]);
		expect(router.current("m", "s1")).toBeUndefined();

		const first = router.acquire({ modelId: "m", sessionId: "s1" });
		const second = router.acquire({ modelId: "m", sessionId: "s2" });

		expect(router.current("m", "s1")).toEqual(first);
		expect(router.current("m", "s2")).toEqual(second);
		expect(router.current("m")).toEqual(second);
		expect(router.current("m", "unknown-session")).toEqual(second);
	});

	it("resolves the exact config dir and reports unknown ids as undefined", () => {
		const { router } = harness([profile("a", { configDir: "/tmp/exact/accounts/a" })]);

		expect(router.resolveProfile("a")).toEqual({ profileId: "a", configDir: "/tmp/exact/accounts/a" });
		expect(router.resolveProfile("missing")).toBeUndefined();
	});

	it("caches identity and usage for status display", () => {
		const { router, store } = harness([profile("a")]);

		router.recordIdentity("a", { email: "  a@example.com  ", subscriptionType: "pro", organization: "" });
		router.recordUsage("a", { five_hour: { utilization: 12 } });

		expect(store.state.identity.a?.email).toBe("a@example.com");
		expect(store.state.identity.a?.subscriptionType).toBe("pro");
		expect(store.state.identity.a?.organization).toBeUndefined();
		expect(store.state.identity.a?.usage).toEqual({ five_hour: { utilization: 12 } });
		expect(store.state.identity.a?.updatedAtMs).toBeGreaterThan(0);
	});

	it("persists cooldowns, invalid sets, and identity to disk", () => {
		const { router, now, store } = harness([profile("a")]);

		router.recordRateLimit("a", { resetsAt: (now() + MINUTE_MS) / 1000, rateLimitType: "five_hour" }, "m");
		router.recordIdentity("a", { email: "a@example.com" });

		const persisted = JSON.parse(readFileSync(store.path, "utf8")) as {
			cooldowns: Record<string, { untilMs: number; rateLimitType: string }>;
			identity: Record<string, { email?: string }>;
		};
		expect(persisted.cooldowns.a).toEqual({ untilMs: now() + MINUTE_MS, rateLimitType: "five_hour" });
		expect(persisted.identity.a?.email).toBe("a@example.com");
	});
});

describe("fault isolation", () => {
	it("never throws from record*, current, or resolveProfile on bad input", () => {
		const { router, store } = harness([profile("a")]);
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		expect(() => router.recordIdentity("missing", { email: "x@y.z" })).not.toThrow();
		expect(() => router.recordUsage("missing", { any: "thing" })).not.toThrow();
		expect(() => router.recordUsage("a", circular)).not.toThrow();
		expect(() => router.recordUsage("a", undefined)).not.toThrow();
		expect(() => router.recordRateLimit("missing", undefined, "m")).not.toThrow();
		expect(() => router.recordRateLimit("a", circular, "m")).not.toThrow();
		expect(() => router.recordFailure("missing", "auth", "m")).not.toThrow();
		expect(() => router.recordFailure("a", "bogus" as ClaudeAccountFailureKind, "m")).not.toThrow();
		expect(() => router.recordSuccess("missing", "s1")).not.toThrow();
		expect(router.resolveProfile("missing")).toBeUndefined();
		expect(router.current("m", "missing")).toBeUndefined();

		expect(store.state.invalid).toEqual([]);
		expect(store.state.sessionAffinity).toEqual({});
		expect(store.state.identity.a).toBeUndefined();
	});

	it("keeps round-robin cursor changes out of acquire failures", () => {
		const { router } = harness([profile("a"), profile("b")]);

		router.acquire({ modelId: "m", sessionId: "s1" });

		expect(() => router.acquire({ modelId: "m", sessionId: "s2" })).not.toThrow();
	});
});

describe("createRouter factory", () => {
	it("builds a router from a loaded config and injected state path", () => {
		const dir = makeTempDir();
		const config: RotatorConfig = {
			policy: "balanced",
			path: join(dir, "claude-bridge-rotator.json"),
			profiles: [profile("a"), profile("b")],
		};

		const router = createRouter(config, { statePath: join(dir, "state.json") });

		expect(router.version).toBe(1);
		expect(router.acquire({ modelId: "m", sessionId: "s1" }).profileId).toBe("a");
		expect(router.acquire({ modelId: "m", sessionId: "s2" }).profileId).toBe("b");
	});
});
