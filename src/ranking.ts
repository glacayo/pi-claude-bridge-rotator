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
/** Soft 5-hour threshold: past it a bound session may move once its cache is
 *  cold, to get ahead of the hard cap before a mid-response rejection. */
export const FIVE_HOUR_SOFT_CAP = 85;
/** Soft weekly threshold, paired with `FIVE_HOUR_SOFT_CAP`. */
export const WEEKLY_SOFT_CAP = 90;
/** A session idle at least this long has outlived Claude Code's 1-hour prompt
 *  cache TTL, so moving it to another account costs no cache rebuild. */
export const CACHE_COLD_IDLE_MS = 60 * 60_000;
/** Score points subtracted per new session already routed to a profile since
 *  its current snapshot, so new sessions spread instead of herding. */
export const NEW_SESSION_PENALTY = 5;
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
	/** Optional load penalty in score points, subtracted from a known profile's
	 *  score. It never changes the cap partition and is ignored in round-robin
	 *  mode, so omitting it reproduces the previous ordering exactly. */
	penalty?: ((profileId: string) => number) | undefined;
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
	penalty: ((profileId: string) => number) | undefined,
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

	const rawPenalty = penalty?.(id);
	const appliedPenalty = rawPenalty !== undefined && Number.isFinite(rawPenalty) ? rawPenalty : 0;
	const score = weeklyHeadroom + fiveHourBonus - 0.5 * fiveHourUtil - appliedPenalty;
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
		analyzeCandidate(id, index, input.usage(id), input.nowMs, input.penalty));

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

// --- Cache-aware affinity decisions ---

function freshSnapshot(record: ProfileUsageRecord | undefined, nowMs: number): UsageSnapshot | undefined {
	const snapshot = record?.snapshot;
	if (snapshot === undefined) return undefined;
	return nowMs - snapshot.fetchedAtMs <= SNAPSHOT_MAX_AGE_MS ? snapshot : undefined;
}

function snapshotIsHardCapped(snapshot: UsageSnapshot | undefined): boolean {
	if (snapshot === undefined) return false;
	return windowUtilization(snapshot, "five_hour") >= FIVE_HOUR_HARD_CAP
		|| windowUtilization(snapshot, "seven_day") >= WEEKLY_HARD_CAP;
}

function snapshotIsUnderSoftCaps(snapshot: UsageSnapshot | undefined): boolean {
	if (snapshot === undefined) return false;
	return windowUtilization(snapshot, "five_hour") < FIVE_HOUR_SOFT_CAP
		&& windowUtilization(snapshot, "seven_day") < WEEKLY_SOFT_CAP;
}

function isCacheCold(lastUsedAtMs: number | undefined, nowMs: number): boolean {
	// An unknown last use counts as NOT idle: the cache might still be warm.
	return lastUsedAtMs !== undefined && nowMs - lastUsedAtMs >= CACHE_COLD_IDLE_MS;
}

export interface DecideAffinityInput {
	/** The session's currently bound profile (already known eligible). */
	bound: string;
	/** Eligible candidate ids in profile order; includes `bound`. */
	candidates: string[];
	usage: (profileId: string) => ProfileUsageRecord | undefined;
	nowMs: number;
	/** Epoch ms of the session's last successful use, or undefined if unknown. */
	lastUsedAtMs?: number | undefined;
}

export interface AffinityDecision {
	/** Profile to route this request to. */
	profileId: string;
	/** True when this is a move away from `bound`; false keeps the binding. */
	moved: boolean;
}

/**
 * Decide whether a bound session keeps its account or moves.
 *
 * The default is always to keep `bound` (prompt caches are isolated per
 * organization, so a move forces one cold rebuild). It moves only when:
 *  - `bound` has a fresh snapshot and is at the HARD cap while another
 *    eligible profile is not: leaving early beats a mid-response rejection; or
 *  - `bound` has a fresh snapshot and is over a SOFT threshold, the session has
 *    been idle at least `CACHE_COLD_IDLE_MS`, and the top-ranked eligible
 *    profile is a different one that is itself under both soft thresholds.
 *
 * Pure and deterministic: no randomness, no clock read, same inputs -> same
 * decision. The caller checks eligibility before calling.
 */
export function decideAffinity(input: DecideAffinityInput): AffinityDecision {
	const keep: AffinityDecision = { profileId: input.bound, moved: false };
	const ranked = rankProfiles({ candidates: input.candidates, usage: input.usage, nowMs: input.nowMs });
	// No fresh data at all (round-robin) means nothing to move toward.
	if (ranked.mode !== "usage") return keep;
	const best = ranked.order[0];
	if (best === undefined) return keep;

	const boundSnapshot = freshSnapshot(input.usage(input.bound), input.nowMs);
	if (boundSnapshot === undefined) return keep;

	const hardCapped = snapshotIsHardCapped(boundSnapshot);
	if (hardCapped) {
		if (best === input.bound) return keep;
		// `best` is the first non-capped-ranked candidate unless everyone is
		// capped; an unknown profile also counts as not hard-capped.
		if (snapshotIsHardCapped(freshSnapshot(input.usage(best), input.nowMs))) return keep;
		return { profileId: best, moved: true };
	}

	const overSoft = windowUtilization(boundSnapshot, "five_hour") >= FIVE_HOUR_SOFT_CAP
		|| windowUtilization(boundSnapshot, "seven_day") >= WEEKLY_SOFT_CAP;
	if (!overSoft) return keep;
	if (!isCacheCold(input.lastUsedAtMs, input.nowMs)) return keep;
	if (best === input.bound) return keep;
	const bestSnapshot = freshSnapshot(input.usage(best), input.nowMs);
	if (!snapshotIsUnderSoftCaps(bestSnapshot)) return keep;
	return { profileId: best, moved: true };
}
