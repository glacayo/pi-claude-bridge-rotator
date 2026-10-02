// Cross-process usage fetch lease tests. Each store points at a temp state
// file, so nothing touches the real agent directory; two store instances on the
// same path stand in for two pi processes.

import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "./helpers.js";
import { RotatorStateStore } from "../src/state.js";
import {
	claimUsageFetch,
	completeUsageFetch,
	USAGE_429_MAX_BACKOFF_MS,
	USAGE_429_MIN_BACKOFF_MS,
	USAGE_FETCH_LEASE_MS,
	USAGE_SHARED_FRESH_MS,
} from "../src/usage-lease.js";
import type { UsageFetchResult, UsageSnapshot } from "../src/usage.js";

afterEach(cleanupTempDirs);

const NOW = 1_800_000_000_000;

function storePath(dir: string): string {
	return join(dir, "state.json");
}

function freshSnapshot(fetchedAtMs = NOW): UsageSnapshot {
	return { fetchedAtMs, windows: { five_hour: { utilization: 5, resetsAtMs: null } } };
}

function success(fetchedAtMs = NOW): UsageFetchResult {
	return { ok: true, snapshot: freshSnapshot(fetchedAtMs) };
}

describe("claimUsageFetch", () => {
	it("claims the first fetch and blocks a second claim at the same instant", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });

		expect(claimUsageFetch(store, "a", NOW)).toEqual({ fetch: true });
		expect(claimUsageFetch(store, "a", NOW)).toEqual({
			fetch: false,
			reason: "lease",
			retryAtMs: NOW + USAGE_FETCH_LEASE_MS,
		});
	});

	it("reclaims the profile once the lease has expired", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });

		expect(claimUsageFetch(store, "a", NOW)).toEqual({ fetch: true });
		expect(claimUsageFetch(store, "a", NOW + USAGE_FETCH_LEASE_MS + 1)).toEqual({ fetch: true });
	});

	it("skips a profile whose shared snapshot is still fresh", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		store.update((state) => {
			state.usage.a = { snapshot: freshSnapshot(NOW) };
		});

		expect(claimUsageFetch(store, "a", NOW + 1000)).toEqual({ fetch: false, reason: "fresh" });
		expect(claimUsageFetch(store, "a", NOW + USAGE_SHARED_FRESH_MS - 1)).toEqual({ fetch: false, reason: "fresh" });
		expect(claimUsageFetch(store, "a", NOW + USAGE_SHARED_FRESH_MS + 1)).toEqual({ fetch: true });
	});

	it("skips while a 429 backoff is active and reclaims after it expires", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		store.update((state) => {
			state.usageFetch.a = { backoffUntilMs: NOW + USAGE_429_MIN_BACKOFF_MS };
		});

		expect(claimUsageFetch(store, "a", NOW + 1000)).toEqual({
			fetch: false,
			reason: "backoff",
			retryAtMs: NOW + USAGE_429_MIN_BACKOFF_MS,
		});
		expect(claimUsageFetch(store, "a", NOW + USAGE_429_MIN_BACKOFF_MS + 1)).toEqual({ fetch: true });
	});

	it("lets only one of two stores on the same file claim a profile", () => {
		const statePath = storePath(makeTempDir());
		const processA = new RotatorStateStore({ statePath });
		const processB = new RotatorStateStore({ statePath });

		expect(claimUsageFetch(processA, "a", NOW).fetch).toBe(true);
		expect(claimUsageFetch(processB, "a", NOW).fetch).toBe(false);
		// A different profile is independent.
		expect(claimUsageFetch(processB, "b", NOW).fetch).toBe(true);
	});

	it("blocks a claim while another process holds the lease, released after it", () => {
		const statePath = storePath(makeTempDir());
		const processA = new RotatorStateStore({ statePath });
		const processB = new RotatorStateStore({ statePath });

		expect(claimUsageFetch(processA, "a", NOW).fetch).toBe(true);
		completeUsageFetch(processA, "a", success(), NOW);
		expect(claimUsageFetch(processB, "a", NOW + 1000)).toEqual({ fetch: true });
	});
});

describe("completeUsageFetch", () => {
	it("clears the lease on success and removes the empty entry", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		expect(claimUsageFetch(store, "a", NOW).fetch).toBe(true);

		completeUsageFetch(store, "a", success(), NOW);

		expect(store.state.usageFetch.a).toBeUndefined();
	});

	it("clears a previous backoff on success", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		store.update((state) => {
			state.usageFetch.a = { backoffUntilMs: NOW + USAGE_429_MIN_BACKOFF_MS };
		});

		completeUsageFetch(store, "a", success(), NOW);

		expect(store.state.usageFetch.a).toBeUndefined();
	});

	it("sets a 429 backoff from Retry-After", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		expect(claimUsageFetch(store, "a", NOW).fetch).toBe(true);

		completeUsageFetch(store, "a", { ok: false, reason: "http-error", httpStatus: 429, retryAfterMs: 10 * 60_000 }, NOW);

		expect(store.state.usageFetch.a).toEqual({ backoffUntilMs: NOW + 10 * 60_000 });
	});

	it("uses the 5-minute minimum for a 429 without a usable Retry-After", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		expect(claimUsageFetch(store, "a", NOW).fetch).toBe(true);

		completeUsageFetch(store, "a", { ok: false, reason: "http-error", httpStatus: 429 }, NOW);

		expect(store.state.usageFetch.a).toEqual({ backoffUntilMs: NOW + USAGE_429_MIN_BACKOFF_MS });
	});

	it("caps the 429 backoff at 60 minutes", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		expect(claimUsageFetch(store, "a", NOW).fetch).toBe(true);

		completeUsageFetch(store, "a", { ok: false, reason: "http-error", httpStatus: 429, retryAfterMs: 4 * 60 * 60_000 }, NOW);

		expect(store.state.usageFetch.a).toEqual({ backoffUntilMs: NOW + USAGE_429_MAX_BACKOFF_MS });
	});

	it("clears the lease on a non-429 failure without setting a backoff", () => {
		const store = new RotatorStateStore({ statePath: storePath(makeTempDir()) });
		expect(claimUsageFetch(store, "a", NOW).fetch).toBe(true);

		completeUsageFetch(store, "a", { ok: false, reason: "network" }, NOW);

		expect(store.state.usageFetch.a).toBeUndefined();
	});

	it("never throws when the state file cannot be written", () => {
		const dir = makeTempDir();
		// A regular file where the state directory should be: every lock/create
		// and write under it fails, which must degrade to fetching.
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "not a directory", "utf8");
		const store = new RotatorStateStore({ statePath: join(blocker, "state.json"), onWarn: () => {} });

		expect(claimUsageFetch(store, "a", NOW)).toEqual({ fetch: true });
		expect(() => completeUsageFetch(store, "a", success(), NOW)).not.toThrow();
	});
});
