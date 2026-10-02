// Usage poller tests. Every timer, clock, and fetch is injected: no real timer,
// no network, and no filesystem. The fake timer seam captures the scheduled
// callbacks so the tests fire them by hand.

import { describe, expect, it } from "vitest";
import { profile } from "./helpers.js";
import { UsagePoller, USAGE_POLL_INTERVAL_MS, USAGE_REFRESH_THROTTLE_MS } from "../src/poller.js";
import type {
	UsagePollerOptions,
	UsagePollerRouter,
	UsagePollerTarget,
} from "../src/poller.js";
import type { FetchUsage } from "../src/commands.js";
import type { RotatorProfileConfig } from "../src/config.js";
import type { UsageFetchResult, UsageSnapshot } from "../src/usage.js";

const NOW = 1_800_000_000_000;

function okSnapshot(fetchedAtMs = NOW): UsageSnapshot {
	return {
		fetchedAtMs,
		windows: { five_hour: { utilization: 5, resetsAtMs: null } },
	};
}

interface FakeTimer {
	fn: () => void;
	ms: number;
	unrefCalls: number;
	unref: () => void;
}

interface TimerSeam {
	intervals: FakeTimer[];
	timeouts: FakeTimer[];
	cleared: unknown[];
	setIntervalFn: UsagePollerOptions["setIntervalFn"];
	clearIntervalFn: UsagePollerOptions["clearIntervalFn"];
	setTimeoutFn: UsagePollerOptions["setTimeoutFn"];
}

function makeTimer(fn: () => void, ms: number): FakeTimer {
	const timer: FakeTimer = {
		fn,
		ms,
		unrefCalls: 0,
		unref(): void {
			timer.unrefCalls += 1;
		},
	};
	return timer;
}

function timerSeam(): TimerSeam {
	const intervals: FakeTimer[] = [];
	const timeouts: FakeTimer[] = [];
	const cleared: unknown[] = [];
	return {
		intervals,
		timeouts,
		cleared,
		setIntervalFn: (fn, ms) => {
			const timer = makeTimer(fn, ms);
			intervals.push(timer);
			return timer;
		},
		clearIntervalFn: (handle) => {
			cleared.push(handle);
		},
		setTimeoutFn: (fn, ms) => {
			const timer = makeTimer(fn, ms);
			timeouts.push(timer);
			return timer;
		},
	};
}

interface FetchScript {
	fetchUsage: FetchUsage;
	configDirs: string[];
	calls: () => number;
}

function scriptedFetch(result: UsageFetchResult | (() => Promise<UsageFetchResult>)): FetchScript {
	const configDirs: string[] = [];
	let calls = 0;
	const fetchUsage: FetchUsage = async ({ configDir }) => {
		configDirs.push(configDir);
		calls += 1;
		return typeof result === "function" ? result() : result;
	};
	return { fetchUsage, configDirs, calls: () => calls };
}

interface RouterStub extends UsagePollerRouter {
	records: Array<{ profileId: string; result: UsageFetchResult }>;
}

function routerStub(): RouterStub {
	const records: Array<{ profileId: string; result: UsageFetchResult }> = [];
	return {
		records,
		recordPlanUsage: (profileId, result) => {
			records.push({ profileId, result });
		},
	};
}

function target(router: UsagePollerRouter, profiles: readonly RotatorProfileConfig[]): UsagePollerTarget {
	return { router, profiles };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

interface BuildOptions {
	fetchUsage: FetchUsage;
	getTargets: UsagePollerOptions["getTargets"];
	seam: TimerSeam;
	now?: (() => number) | undefined;
	onWarn?: ((message: string) => void) | undefined;
}

function build(options: BuildOptions): UsagePoller {
	return new UsagePoller({
		fetchUsage: options.fetchUsage,
		getTargets: options.getTargets,
		now: options.now ?? (() => NOW),
		onWarn: options.onWarn ?? (() => {}),
		setIntervalFn: options.seam.setIntervalFn,
		clearIntervalFn: options.seam.clearIntervalFn,
		setTimeoutFn: options.seam.setTimeoutFn,
	});
}

describe("start", () => {
	it("schedules an immediate deferred refresh and the interval", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: true, snapshot: okSnapshot() });
		const router = routerStub();
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(router, [profile("a")]), seam });

		poller.start();

		expect(poller.isRunning()).toBe(true);
		expect(fetch.calls()).toBe(0);
		expect(seam.timeouts).toHaveLength(1);
		expect(seam.intervals).toHaveLength(1);
		expect(seam.intervals[0]?.ms).toBe(USAGE_POLL_INTERVAL_MS);

		seam.timeouts[0]?.fn();
		await flush();

		expect(fetch.calls()).toBe(1);
		expect(router.records).toHaveLength(1);
	});

	it("is idempotent", () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });

		poller.start();
		poller.start();

		expect(seam.timeouts).toHaveLength(1);
		expect(seam.intervals).toHaveLength(1);
	});

	it("unrefs both timers when the handles support it", () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });

		poller.start();

		expect(seam.timeouts[0]?.unrefCalls).toBe(1);
		expect(seam.intervals[0]?.unrefCalls).toBe(1);
	});

	it("refreshes every profile in the target", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: true, snapshot: okSnapshot() });
		const router = routerStub();
		const poller = build({
			fetchUsage: fetch.fetchUsage,
			getTargets: () => target(router, [profile("a"), profile("b")]),
			seam,
		});

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();

		expect(fetch.configDirs).toEqual(["/tmp/rotator-accounts/a", "/tmp/rotator-accounts/b"]);
		expect(router.records.map((entry) => entry.profileId)).toEqual(["a", "b"]);
	});

	it("fires the interval callback through the same path", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: true, snapshot: okSnapshot() });
		const router = routerStub();
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(router, [profile("a")]), seam });

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		seam.intervals[0]?.fn();
		await flush();

		expect(fetch.calls()).toBe(2);
	});
});

describe("stop", () => {
	it("is idempotent and clears every scheduled timer", () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });

		poller.start();
		poller.stop();
		poller.stop();

		expect(poller.isRunning()).toBe(false);
		expect(seam.cleared).toHaveLength(2);
	});

	it("discards an in-flight refresh started before stop", async () => {
		const seam = timerSeam();
		const resolvers: Array<(result: UsageFetchResult) => void> = [];
		const fetchUsage: FetchUsage = () => new Promise((resolve) => {
			resolvers.push(resolve);
		});
		const router = routerStub();
		const poller = build({ fetchUsage, getTargets: () => target(router, [profile("a")]), seam });

		poller.start();
		seam.timeouts[0]?.fn();
		expect(resolvers).toHaveLength(1);
		poller.stop();

		resolvers[0]?.({ ok: true, snapshot: okSnapshot() });
		await flush();

		expect(router.records).toHaveLength(0);
	});

	it("no-ops requestRefresh after stop", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });
		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		poller.stop();

		poller.requestRefresh("a");
		await flush();

		expect(fetch.calls()).toBe(1);
	});
});

describe("requestRefresh", () => {
	it("refreshes a single profile and throttles repeat calls", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: true, snapshot: okSnapshot() });
		const router = routerStub();
		let current = NOW;
		const poller = build({
			fetchUsage: fetch.fetchUsage,
			getTargets: () => target(router, [profile("a"), profile("b")]),
			seam,
			now: () => current,
		});
		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		expect(fetch.calls()).toBe(2);

		poller.requestRefresh("a");
		await flush();
		expect(fetch.calls()).toBe(3);
		expect(fetch.configDirs.at(-1)).toBe("/tmp/rotator-accounts/a");

		poller.requestRefresh("a");
		await flush();
		expect(fetch.calls()).toBe(3);

		current += USAGE_REFRESH_THROTTLE_MS;
		poller.requestRefresh("a");
		await flush();
		expect(fetch.calls()).toBe(4);
	});

	it("dedupes a request while a refresh for that profile is in flight", async () => {
		const seam = timerSeam();
		const resolvers: Array<(result: UsageFetchResult) => void> = [];
		const fetchUsage: FetchUsage = () => new Promise((resolve) => {
			resolvers.push(resolve);
		});
		const router = routerStub();
		const poller = build({ fetchUsage, getTargets: () => target(router, [profile("a")]), seam });

		poller.start();
		seam.timeouts[0]?.fn();
		poller.requestRefresh("a");
		poller.requestRefresh("a");
		expect(resolvers).toHaveLength(1);

		resolvers[0]?.({ ok: true, snapshot: okSnapshot() });
		await flush();
		expect(router.records).toHaveLength(1);
	});

	it("ignores an unknown profile id", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });
		poller.start();
		seam.timeouts[0]?.fn();
		await flush();

		poller.requestRefresh("missing");
		await flush();

		expect(fetch.calls()).toBe(1);
	});
});

describe("fault isolation", () => {
	it("reads the current targets on every run", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: true, snapshot: okSnapshot() });
		const first = routerStub();
		const second = routerStub();
		let runs = 0;
		const poller = build({
			fetchUsage: fetch.fetchUsage,
			getTargets: () => {
				runs += 1;
				return runs === 1 ? target(first, [profile("a")]) : target(second, [profile("b")]);
			},
			seam,
		});

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		seam.intervals[0]?.fn();
		await flush();

		expect(first.records.map((entry) => entry.profileId)).toEqual(["a"]);
		expect(second.records.map((entry) => entry.profileId)).toEqual(["b"]);
	});

	it("does nothing when getTargets returns undefined", async () => {
		const seam = timerSeam();
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({ fetchUsage: fetch.fetchUsage, getTargets: () => undefined, seam });

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		poller.requestRefresh("a");
		await flush();

		expect(fetch.calls()).toBe(0);
	});

	it("never throws when the fetch rejects and warns once per kind", async () => {
		const seam = timerSeam();
		const warnings: string[] = [];
		const fetchUsage: FetchUsage = async () => {
			throw new Error("boom");
		};
		const poller = build({
			fetchUsage,
			getTargets: () => target(routerStub(), [profile("a")]),
			seam,
			onWarn: (message) => warnings.push(message),
		});

		expect(() => poller.start()).not.toThrow();
		seam.timeouts[0]?.fn();
		await flush();
		seam.intervals[0]?.fn();
		await flush();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("boom");
	});

	it("warns once per distinct failure reason", async () => {
		const seam = timerSeam();
		const warnings: string[] = [];
		const fetch = scriptedFetch({ ok: false, reason: "network" });
		const poller = build({
			fetchUsage: fetch.fetchUsage,
			getTargets: () => target(routerStub(), [profile("a")]),
			seam,
			onWarn: (message) => warnings.push(message),
		});

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();
		seam.intervals[0]?.fn();
		await flush();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("network");
	});

	it("never touches credentials itself: the fetch seam only sees the config dir", async () => {
		const seam = timerSeam();
		const calls: Array<{ configDir: string; signal?: AbortSignal | undefined }> = [];
		const fetchUsage: FetchUsage = async (usageOptions) => {
			calls.push({ configDir: usageOptions.configDir, signal: usageOptions.signal });
			return { ok: false, reason: "token-expired" };
		};
		const poller = build({ fetchUsage, getTargets: () => target(routerStub(), [profile("a")]), seam });

		poller.start();
		seam.timeouts[0]?.fn();
		await flush();

		expect(calls).toEqual([{ configDir: "/tmp/rotator-accounts/a", signal: undefined }]);
	});
});
