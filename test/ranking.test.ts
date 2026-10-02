// Pure ranking tests. No filesystem, clock, or network: `rankProfiles` takes
// `nowMs` and a lookup function, so every case is deterministic.

import { describe, expect, it } from "vitest";
import {
	FIVE_HOUR_BONUS_WINDOW_MS,
	FIVE_HOUR_HARD_CAP,
	SNAPSHOT_MAX_AGE_MS,
	WEEK_MS,
	WEEKLY_HARD_CAP,
	rankProfiles,
} from "../src/ranking.js";
import type { ProfileUsageRecord } from "../src/state.js";
import type { UsageSnapshot } from "../src/usage.js";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HOUR_MS = 60 * MINUTE;
const DAY_MS = 24 * HOUR_MS;
const WEEK = WEEK_MS;

interface WindowInput {
	utilization?: number | null;
	resetsInMs?: number | null;
}

function snapshot(
	fetchedAtMs: number,
	windows: { fiveHour?: WindowInput; weekly?: WindowInput } = {},
): UsageSnapshot {
	const built: UsageSnapshot["windows"] = {};
	if (windows.fiveHour !== undefined) {
		built.five_hour = {
			utilization: windows.fiveHour.utilization ?? null,
			resetsAtMs: windows.fiveHour.resetsInMs === undefined || windows.fiveHour.resetsInMs === null
				? null
				: NOW + windows.fiveHour.resetsInMs,
		};
	}
	if (windows.weekly !== undefined) {
		built.seven_day = {
			utilization: windows.weekly.utilization ?? null,
			resetsAtMs: windows.weekly.resetsInMs === undefined || windows.weekly.resetsInMs === null
				? null
				: NOW + windows.weekly.resetsInMs,
		};
	}
	return { fetchedAtMs, windows: built };
}

function record(snap: UsageSnapshot): ProfileUsageRecord {
	return { snapshot: snap };
}

/** A fresh, mid-week baseline: 4 days into a 7-day window (expected ≈ 57.1). */
function midWeek(fiveHourUtil: number | null = 0, weeklyUtil: number | null = 0): UsageSnapshot {
	return snapshot(NOW, {
		fiveHour: { utilization: fiveHourUtil, resetsInMs: null },
		weekly: { utilization: weeklyUtil, resetsInMs: 3 * DAY_MS },
	});
}

function rank(
	candidates: string[],
	records: Record<string, ProfileUsageRecord | undefined>,
	nowMs = NOW,
): { order: string[]; mode: string } {
	return rankProfiles({ candidates, usage: (id) => records[id], nowMs });
}

describe("rankProfiles fallback", () => {
	it("round-robins when no candidate has a snapshot", () => {
		expect(rank(["a", "b", "c"], {})).toEqual({ order: ["a", "b", "c"], mode: "round-robin" });
	});

	it("round-robins when every snapshot is stale", () => {
		const records = {
			a: record(snapshot(NOW - SNAPSHOT_MAX_AGE_MS - 1, { fiveHour: { utilization: 0 } })),
			b: record(snapshot(NOW - SNAPSHOT_MAX_AGE_MS - 1, { fiveHour: { utilization: 90 } })),
		};
		expect(rank(["a", "b"], records)).toEqual({ order: ["a", "b"], mode: "round-robin" });
	});

	it("treats a snapshot exactly at the freshness boundary as known", () => {
		const records = { a: record(snapshot(NOW - SNAPSHOT_MAX_AGE_MS, { fiveHour: { utilization: 1 } })) };
		expect(rank(["a"], records)).toEqual({ order: ["a"], mode: "usage" });
	});

	it("uses a fresh snapshot and ranks when at least one candidate is known", () => {
		const records = { a: record(midWeek(0, 90)), b: record(midWeek(0, 5)) };
		expect(rank(["a", "b"], records)).toEqual({ order: ["b", "a"], mode: "usage" });
	});
});

describe("hard caps", () => {
	it("treats 5-hour utilization at the cap as capped", () => {
		const records = { a: record(midWeek(FIVE_HOUR_HARD_CAP, 0)), b: record(midWeek(0, 0)) };
		expect(rank(["a", "b"], records).order).toEqual(["b", "a"]);
	});

	it("keeps a profile just below the 5-hour cap uncapped", () => {
		// An unknown profile sorts after every known-uncapped one but before any
		// capped one, so its position proves which partition the profile is in.
		const records = { a: record(midWeek(FIVE_HOUR_HARD_CAP - 0.1, 0)) };
		expect(rank(["a", "unknown"], records).order).toEqual(["a", "unknown"]);
	});

	it("treats weekly utilization at the cap as capped", () => {
		const records = { a: record(midWeek(0, WEEKLY_HARD_CAP)), b: record(midWeek(0, 0)) };
		expect(rank(["a", "b"], records).order).toEqual(["b", "a"]);
	});

	it("keeps a profile just below the weekly cap uncapped", () => {
		const records = { a: record(midWeek(0, WEEKLY_HARD_CAP - 0.1)) };
		expect(rank(["a", "unknown"], records).order).toEqual(["a", "unknown"]);
	});

	it("orders capped profiles by the lowest max(5h, weekly) utilization", () => {
		const records = {
			a: record(midWeek(99, 0)),
			b: record(midWeek(0, 99)),
			c: record(midWeek(96, 0)),
		};
		// c (96) < a (99) < b (99), ties broken by candidate order.
		expect(rank(["a", "b", "c"], records).order).toEqual(["c", "a", "b"]);
	});
});

describe("weekly pace", () => {
	it("prefers the account behind its expected weekly pace", () => {
		const records = { behind: record(midWeek(0, 10)), ahead: record(midWeek(0, 50)) };
		expect(rank(["ahead", "behind"], records).order).toEqual(["behind", "ahead"]);
	});

	it("uses no expected pace when the weekly reset is unknown", () => {
		const records = {
			a: record(snapshot(NOW, { weekly: { utilization: 10, resetsInMs: null } })),
			b: record(snapshot(NOW, { weekly: { utilization: 10, resetsInMs: null } })),
		};
		// Equal scores -> candidate order.
		expect(rank(["a", "b"], records).order).toEqual(["a", "b"]);
	});

	it("clamps the expected pace across a full window", () => {
		// Weekly reset just over a week away: elapsed fraction clamps to 0.
		const start = snapshot(NOW, { weekly: { utilization: 0, resetsInMs: WEEK + 2 * DAY_MS } });
		// Weekly reset now: elapsed fraction clamps to 1 -> expected 100.
		const end = snapshot(NOW, { weekly: { utilization: 0, resetsInMs: 0 } });
		const records = { start: record(start), end: record(end) };
		expect(rank(["start", "end"], records).order).toEqual(["end", "start"]);
	});
});

describe("five-hour reset bonus", () => {
	it("awards the bonus for a reset inside the window and prefers it", () => {
		const records = {
			soon: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: 10 * MINUTE },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
			none: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: null },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
		};
		expect(rank(["none", "soon"], records).order).toEqual(["soon", "none"]);
	});

	it("gives no bonus when the reset is outside the window", () => {
		const records = {
			soon: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: 10 * MINUTE },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
			far: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: FIVE_HOUR_BONUS_WINDOW_MS + MINUTE },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
		};
		expect(rank(["soon", "far"], records).order).toEqual(["soon", "far"]);
	});

	it("gives no bonus when the 5-hour reset is null", () => {
		const records = {
			nullReset: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: null },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
			inWindow: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: 30 * MINUTE },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
		};
		expect(rank(["nullReset", "inWindow"], records).order).toEqual(["inWindow", "nullReset"]);
	});

	it("does not award a bonus for an already-past reset", () => {
		const records = {
			// Same weekly pace and 5h utilization: only the bonus could differ.
			past: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: -MINUTE },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
			nullReset: record(snapshot(NOW, {
				fiveHour: { utilization: 0, resetsInMs: null },
				weekly: { utilization: 10, resetsInMs: 3 * DAY_MS },
			})),
		};
		// Both end up with identical scores -> candidate order.
		expect(rank(["past", "nullReset"], records).order).toEqual(["past", "nullReset"]);
	});
});

describe("null utilization and unknown profiles", () => {
	it("counts a null utilization as 0", () => {
		const records = {
			nulls: record(snapshot(NOW, {
				fiveHour: { utilization: null, resetsInMs: null },
				weekly: { utilization: null, resetsInMs: 3 * DAY_MS },
			})),
		};
		// Known, uncapped, non-negative score -> usage mode with the id present.
		const result = rank(["nulls"], records);
		expect(result.mode).toBe("usage");
		expect(result.order).toEqual(["nulls"]);
	});

	it("places unknown profiles after known-uncapped ones", () => {
		const records = { known: record(midWeek(0, 10)) };
		expect(rank(["unknown", "known"], records).order).toEqual(["known", "unknown"]);
	});

	it("places unknown profiles before capped ones", () => {
		const records = { capped: record(midWeek(99, 0)) };
		expect(rank(["capped", "unknown"], records).order).toEqual(["unknown", "capped"]);
	});
});

describe("determinism and ties", () => {
	it("breaks score ties by candidate order", () => {
		const records = { a: record(midWeek(10, 20)), b: record(midWeek(10, 20)) };
		expect(rank(["b", "a"], records).order).toEqual(["b", "a"]);
	});

	it("returns the same order for the same inputs twice", () => {
		const records = {
			a: record(midWeek(12, 30)),
			b: record(midWeek(4, 10)),
			c: record(midWeek(99, 0)),
		};
		const first = rankProfiles({ candidates: ["a", "b", "c"], usage: (id) => records[id as keyof typeof records], nowMs: NOW });
		const second = rankProfiles({ candidates: ["a", "b", "c"], usage: (id) => records[id as keyof typeof records], nowMs: NOW });
		expect(second).toEqual(first);
	});
});
