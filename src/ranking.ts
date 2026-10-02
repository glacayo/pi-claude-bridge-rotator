// Deterministic usage-aware profile ranking.
//
// Pure and I/O-free on purpose: `acquire()` is synchronous in the bridge
// contract, so routing can only read an already-cached snapshot. Same inputs
// always produce the same order: there is no randomness and no clock read; the
// caller passes `nowMs`.
//
// Score for known, uncapped profiles (higher is better):
//
//   weeklyHeadroom + fiveHourBonus - 0.5 * fiveHourUtil
//
//   weeklyHeadroom = expectedWeekly - weeklyUtil
//   expectedWeekly = 100 * clamp((nowMs - (weeklyResetsAtMs - WEEK_MS)) / WEEK_MS, 0, 1)
//                    when seven_day.resetsAtMs is known, else 0
//   fiveHourBonus  = 0.5 * (100 - fiveHourUtil) * (1 - msToReset / FIVE_HOUR_BONUS_WINDOW_MS)
//                    only when the 5-hour reset is known and inside the bonus window,
//                    else 0
//
// A null utilization counts as 0. A snapshot older than `SNAPSHOT_MAX_AGE_MS`
// is treated as unknown. When no candidate is known, ranking degrades to
// `round-robin` and the caller keeps its cursor behavior.

import type { ProfileUsageRecord } from "./state.js";
import type { UsageSnapshot, UsageWindowName } from "./usage.js";

/** Rolling 5-hour utilization at or above this is a hard cap. */
export const FIVE_HOUR_HARD_CAP = 95;
/** Weekly (`seven_day`) utilization at or above this is a hard cap. */
export const WEEKLY_HARD_CAP = 98;
/** Snapshots older than this are considered unknown. */
export const SNAPSHOT_MAX_AGE_MS = 15 * 60_000;
/** Seven-day window length, used to derive the expected weekly pace. */
export const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Look-ahead window for the "use it or lose it" 5-hour bonus. */
export const FIVE_HOUR_BONUS_WINDOW_MS = 60 * 60_000;

export type RankingMode = "usage" | "round-robin";

export interface RankProfilesInput {
	/** Eligible profile ids in profile (candidate) order. */
	candidates: string[];
	/** Cached usage record lookup; the ranking never fetches. */
	usage: (profileId: string) => ProfileUsageRecord | undefined;
	nowMs: number;
}

export interface RankedProfiles {
	/** Best-first ids. In `round-robin` mode this is `candidates` unchanged. */
	order: string[];
	mode: RankingMode;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function windowUtilization(snapshot: UsageSnapshot, name: UsageWindowName): number {
	const value = snapshot.windows[name]?.utilization;
	// A missing or explicitly null number counts as 0.
	return value === null || value === undefined ? 0 : value;
}

function windowResetsAtMs(snapshot: UsageSnapshot, name: UsageWindowName): number | undefined {
	const value = snapshot.windows[name]?.resetsAtMs;
	return value === null || value === undefined ? undefined : value;
}

interface AnalyzedCandidate {
	id: string;
	index: number;
	known: boolean;
	capped: boolean;
	score: number;
	/** max(5h, weekly) utilization, used to order capped last-resort picks. */
	maxUtilization: number;
}

function analyzeCandidate(
	id: string,
	index: number,
	record: ProfileUsageRecord | undefined,
	nowMs: number,
): AnalyzedCandidate {
	const snapshot = record?.snapshot;
	const known = snapshot !== undefined && nowMs - snapshot.fetchedAtMs <= SNAPSHOT_MAX_AGE_MS;
	if (!known || snapshot === undefined) {
		// Unknown profiles sort after every known-uncapped profile, in candidate
		// order; their score/max fields are never read.
		return { id, index, known: false, capped: false, score: 0, maxUtilization: 0 };
	}

	const fiveHourUtil = windowUtilization(snapshot, "five_hour");
	const weeklyUtil = windowUtilization(snapshot, "seven_day");
	const capped = fiveHourUtil >= FIVE_HOUR_HARD_CAP || weeklyUtil >= WEEKLY_HARD_CAP;

	const weeklyResetsAtMs = windowResetsAtMs(snapshot, "seven_day");
	const expectedWeekly = weeklyResetsAtMs === undefined
		? 0
		: 100 * clamp((nowMs - (weeklyResetsAtMs - WEEK_MS)) / WEEK_MS, 0, 1);
	const weeklyHeadroom = expectedWeekly - weeklyUtil;

	const fiveHourResetsAtMs = windowResetsAtMs(snapshot, "five_hour");
	const msToReset = fiveHourResetsAtMs === undefined ? undefined : fiveHourResetsAtMs - nowMs;
	const fiveHourBonusValid = msToReset !== undefined
		&& msToReset >= 0
		&& msToReset <= FIVE_HOUR_BONUS_WINDOW_MS;
	const fiveHourBonus = fiveHourBonusValid
		? 0.5 * (100 - fiveHourUtil) * (1 - msToReset / FIVE_HOUR_BONUS_WINDOW_MS)
		: 0;

	const score = weeklyHeadroom + fiveHourBonus - 0.5 * fiveHourUtil;
	return { id, index, known: true, capped, score, maxUtilization: Math.max(fiveHourUtil, weeklyUtil) };
}

/**
 * Rank eligible candidates for a new-session route.
 *
 * `order` is: known-uncapped by score desc (tie -> candidate order), then
 * unknown profiles in candidate order, then capped profiles by lowest
 * max(5h, weekly) utilization (tie -> candidate order) as the last resort.
 * When nothing is known, `mode` is `round-robin` and `order` equals
 * `candidates` unchanged.
 */
export function rankProfiles(input: RankProfilesInput): RankedProfiles {
	const analyzed = input.candidates.map((id, index) =>
		analyzeCandidate(id, index, input.usage(id), input.nowMs));

	if (!analyzed.some((candidate) => candidate.known)) {
		return { order: [...input.candidates], mode: "round-robin" };
	}

	const uncapped = analyzed
		.filter((candidate) => candidate.known && !candidate.capped)
		.sort((a, b) => b.score - a.score || a.index - b.index);
	const unknown = analyzed.filter((candidate) => !candidate.known);
	const capped = analyzed
		.filter((candidate) => candidate.known && candidate.capped)
		.sort((a, b) => a.maxUtilization - b.maxUtilization || a.index - b.index);

	return {
		order: [...uncapped, ...unknown, ...capped].map((candidate) => candidate.id),
		mode: "usage",
	};
}
