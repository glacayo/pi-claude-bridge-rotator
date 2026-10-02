import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "./helpers.js";
import {
	MAX_SESSION_AFFINITY_ENTRIES,
	pruneSessionAffinity,
	RotatorStateStore,
	ROTATOR_STATE_FILENAME,
	STATE_VERSION,
	touchSessionAffinity,
} from "../src/state.js";

afterEach(cleanupTempDirs);

function statePathFor(dir: string): string {
	return join(dir, "rotator-state.json");
}

describe("RotatorStateStore loading", () => {
	it("starts fresh without creating a file when none exists", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);

		const store = new RotatorStateStore({ statePath });

		expect(store.path).toBe(statePath);
		expect(store.state.version).toBe(STATE_VERSION);
		expect(store.state.cooldowns).toEqual({});
		expect(store.state.invalid).toEqual([]);
		expect(store.state.sessionAffinity).toEqual({});
		expect(store.state.cursor).toBe(0);
		expect(store.state.identity).toEqual({});
		expect(readdirSync(dir)).toEqual([]);
	});

	it("resolves the default path from PI_CODING_AGENT_DIR", () => {
		const dir = makeTempDir();

		const store = new RotatorStateStore({ env: { PI_CODING_AGENT_DIR: dir } });

		expect(store.path).toBe(join(dir, ROTATOR_STATE_FILENAME));
	});

	it("starts fresh and warns on a corrupt state file", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, "{ this is not json");
		const warnings: string[] = [];

		const store = new RotatorStateStore({ statePath, onWarn: (message) => warnings.push(message) });

		expect(store.state.cooldowns).toEqual({});
		expect(store.state.cursor).toBe(0);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("corrupt");
		expect(warnings[0]).toContain(statePath);
	});

	it("starts fresh and warns when the state path is unreadable", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		mkdirSync(statePath);
		const warnings: string[] = [];

		const store = new RotatorStateStore({ statePath, onWarn: (message) => warnings.push(message) });

		expect(store.state.invalid).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("unreadable");
	});

	it("sanitizes malformed persisted values instead of trusting them", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({
			version: 99,
			cooldowns: { bad: { untilMs: "soon", rateLimitType: 5 }, good: { untilMs: 42 } },
			invalid: ["x", 7, ""],
			sessionAffinity: { s1: 5, s2: "p" },
			cursor: -3,
			identity: { p: "not-an-object" },
			failures: { p: { kind: "auth" } },
		}));

		const store = new RotatorStateStore({ statePath });

		expect(store.state.cooldowns.bad).toBeUndefined();
		expect(store.state.cooldowns.good).toEqual({ untilMs: 42, rateLimitType: "unknown" });
		expect(store.state.invalid).toEqual(["x"]);
		expect(store.state.sessionAffinity).toEqual({ s2: "p" });
		expect(store.state.cursor).toBe(0);
		expect(store.state.identity).toEqual({});
		expect(store.state.failures.p).toBeUndefined();
	});
});

describe("usage state sanitization", () => {
	it("defaults usage to an empty map when the field is missing", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({ version: 1, cursor: 0 }));

		const store = new RotatorStateStore({ statePath });

		expect(store.state.usage).toEqual({});
	});

	it("keeps valid usage records and drops malformed entries", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({
			version: 1,
			usage: {
				a: {
					snapshot: {
						fetchedAtMs: 1000,
						windows: {
							five_hour: { utilization: 12.5, resetsAtMs: 2000 },
							seven_day: { utilization: null, resetsAtMs: null },
						},
					},
				},
				b: { lastError: { reason: "network", atMs: 3000 } },
				c: { snapshot: { fetchedAtMs: "soon", windows: {} } },
				d: {
					snapshot: {
						fetchedAtMs: 4000,
						windows: { five_hour: { utilization: "x", resetsAtMs: 1 }, seven_day: { utilization: 2, resetsAtMs: 3 } },
					},
				},
				e: "not-an-object",
				f: {},
				g: { lastError: { reason: "not-a-reason", atMs: 1 } },
			},
		}));

		const store = new RotatorStateStore({ statePath });

		expect(Object.keys(store.state.usage).sort()).toEqual(["a", "b", "d"]);
		expect(store.state.usage.a?.snapshot).toEqual({
			fetchedAtMs: 1000,
			windows: {
				five_hour: { utilization: 12.5, resetsAtMs: 2000 },
				seven_day: { utilization: null, resetsAtMs: null },
			},
		});
		expect(store.state.usage.b?.lastError).toEqual({ reason: "network", atMs: 3000 });
		expect(store.state.usage.d?.snapshot?.windows).toEqual({
			seven_day: { utilization: 2, resetsAtMs: 3 },
		});
	});

	it("clamps persisted utilization into 0-100 and keeps an http status", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({
			version: 1,
			usage: {
				a: {
					snapshot: {
						fetchedAtMs: 1000,
						windows: {
							five_hour: { utilization: 150, resetsAtMs: 2000 },
							seven_day: { utilization: -5, resetsAtMs: 2000 },
						},
					},
				},
				b: { lastError: { reason: "http-error", atMs: 3000, httpStatus: 503 } },
			},
		}));

		const store = new RotatorStateStore({ statePath });

		expect(store.state.usage.a?.snapshot?.windows.five_hour?.utilization).toBe(100);
		expect(store.state.usage.a?.snapshot?.windows.seven_day?.utilization).toBe(0);
		expect(store.state.usage.b?.lastError).toEqual({ reason: "http-error", atMs: 3000, httpStatus: 503 });
	});

	it("round-trips a usage record through a reload", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		const store = new RotatorStateStore({ statePath });

		store.update((state) => {
			state.usage.a = {
				snapshot: { fetchedAtMs: 1000, windows: { five_hour: { utilization: 12, resetsAtMs: 2000 } } },
			};
		});

		const reloaded = new RotatorStateStore({ statePath });

		expect(reloaded.state.usage.a?.snapshot?.windows.five_hour).toEqual({ utilization: 12, resetsAtMs: 2000 });
	});
});

describe("session last-use state", () => {
	it("defaults the paired last-use map to empty on a fresh state", () => {
		const dir = makeTempDir();
		const store = new RotatorStateStore({ statePath: statePathFor(dir) });

		expect(store.state.sessionLastUsedAtMs).toEqual({});
	});

	it("loads an old file that has affinity but no last-use map", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({ version: 1, sessionAffinity: { s1: "a" } }));

		const store = new RotatorStateStore({ statePath });

		expect(store.state.sessionAffinity).toEqual({ s1: "a" });
		expect(store.state.sessionLastUsedAtMs).toEqual({});
	});

	it("keeps finite non-negative timestamps and drops orphans or malformed values", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		writeFileSync(statePath, JSON.stringify({
			version: 1,
			sessionAffinity: { s1: "a", s2: "b" },
			sessionLastUsedAtMs: {
				s1: 123,
				s2: -1,
				orphan: 5,
				missingAffinity: 7,
				notANumber: "x",
				nullValue: null,
			},
		}));

		const store = new RotatorStateStore({ statePath });

		expect(store.state.sessionLastUsedAtMs).toEqual({ s1: 123 });
	});

	it("round-trips paired affinity and last-use through a reload", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		const store = new RotatorStateStore({ statePath });

		store.update((state) => {
			touchSessionAffinity(
				state.sessionAffinity,
				"s1",
				"a",
				MAX_SESSION_AFFINITY_ENTRIES,
				state.sessionLastUsedAtMs,
				555,
			);
		});

		const reloaded = new RotatorStateStore({ statePath });

		expect(reloaded.state.sessionAffinity.s1).toBe("a");
		expect(reloaded.state.sessionLastUsedAtMs.s1).toBe(555);
	});

	it("prunes affinity and last-use together with the same cap and no orphans", () => {
		const dir = makeTempDir();
		const store = new RotatorStateStore({ statePath: statePathFor(dir) });

		store.update((state) => {
			for (let index = 0; index < 205; index += 1) {
				touchSessionAffinity(
					state.sessionAffinity,
					`s${index}`,
					"a",
					MAX_SESSION_AFFINITY_ENTRIES,
					state.sessionLastUsedAtMs,
					1_000 + index,
				);
			}
		});

		const affinityKeys = Object.keys(store.state.sessionAffinity);
		const lastUsedKeys = Object.keys(store.state.sessionLastUsedAtMs);
		expect(affinityKeys).toHaveLength(MAX_SESSION_AFFINITY_ENTRIES);
		expect(lastUsedKeys).toEqual(affinityKeys);
		expect(lastUsedKeys).not.toContain("s0");
		expect(store.state.sessionLastUsedAtMs.s204).toBe(1_204);
	});

	it("drops a last-use entry with no affinity when pruning", () => {
		const dir = makeTempDir();
		const store = new RotatorStateStore({ statePath: statePathFor(dir) });

		store.update((state) => {
			state.sessionAffinity.s1 = "a";
			state.sessionLastUsedAtMs.s1 = 10;
			state.sessionLastUsedAtMs.orphan = 20;
			pruneSessionAffinity(state.sessionAffinity, MAX_SESSION_AFFINITY_ENTRIES, state.sessionLastUsedAtMs);
		});

		expect(store.state.sessionLastUsedAtMs).toEqual({ s1: 10 });
	});
});

describe("RotatorStateStore persistence", () => {
	it("round-trips state through a reload", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		const store = new RotatorStateStore({ statePath });

		store.update((state) => {
			state.cooldowns.a = { untilMs: 1_800_000_600_000, rateLimitType: "weekly" };
			state.invalid = ["b"];
			state.cursor = 3;
			state.failures.a = { kind: "auth", modelId: "claude-sonnet-4-6", atMs: 1_800_000_000_000 };
			touchSessionAffinity(state.sessionAffinity, "s1", "a");
			state.identity.a = { email: "a@example.com", subscriptionType: "pro" };
		});

		const reloaded = new RotatorStateStore({ statePath });

		expect(reloaded.state.cooldowns.a).toEqual({ untilMs: 1_800_000_600_000, rateLimitType: "weekly" });
		expect(reloaded.state.invalid).toEqual(["b"]);
		expect(reloaded.state.cursor).toBe(3);
		expect(reloaded.state.failures.a).toEqual({ kind: "auth", modelId: "claude-sonnet-4-6", atMs: 1_800_000_000_000 });
		expect(reloaded.state.sessionAffinity.s1).toBe("a");
		expect(reloaded.state.identity.a?.email).toBe("a@example.com");
		expect(reloaded.state.identity.a?.subscriptionType).toBe("pro");
	});

	it("writes the state file with mode 0600", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		const store = new RotatorStateStore({ statePath });

		store.update((state) => {
			state.cursor = 1;
		});

		expect(statSync(statePath).mode & 0o777).toBe(0o600);
	});

	it("writes atomically via a sibling temp file plus rename", () => {
		const dir = makeTempDir();
		const statePath = statePathFor(dir);
		const store = new RotatorStateStore({ statePath });
		store.update((state) => {
			state.cursor = 1;
		});
		const firstInode = statSync(statePath).ino;

		store.update((state) => {
			state.cursor = 2;
		});

		// A rename swaps the directory entry to a different inode; an in-place
		// rewrite would keep the previous one.
		expect(statSync(statePath).ino).not.toBe(firstInode);
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(dir)).toEqual([basename(statePath)]);
	});

	it("prunes session affinity to the 200 most recent entries", () => {
		const dir = makeTempDir();
		const store = new RotatorStateStore({ statePath: statePathFor(dir) });

		store.update((state) => {
			for (let index = 0; index < 205; index += 1) {
				touchSessionAffinity(state.sessionAffinity, `s${index}`, "a");
			}
		});

		const keys = Object.keys(store.state.sessionAffinity);
		expect(keys).toHaveLength(MAX_SESSION_AFFINITY_ENTRIES);
		expect(keys).not.toContain("s0");
		expect(keys).not.toContain("s4");
		expect(keys[0]).toBe("s5");
		expect(keys.at(-1)).toBe("s204");
	});

	it("moves a re-touched session to the most recent position", () => {
		const dir = makeTempDir();
		const store = new RotatorStateStore({ statePath: statePathFor(dir) });

		store.update((state) => {
			touchSessionAffinity(state.sessionAffinity, "s1", "a");
			touchSessionAffinity(state.sessionAffinity, "s2", "b");
			touchSessionAffinity(state.sessionAffinity, "s1", "b");
		});

		expect(Object.keys(store.state.sessionAffinity)).toEqual(["s2", "s1"]);
		expect(store.state.sessionAffinity.s1).toBe("b");
	});
});
