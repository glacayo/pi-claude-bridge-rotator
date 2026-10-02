// Cross-process plan-usage fetch coordination.
//
// Every pi process runs its own `UsagePoller` and its own `status` command, so
// without coordination the usage endpoint receives one request per process per
// window. This module funnels all of them through the shared state file: the
// poller and the status command both call `claimUsageFetch` before a fetch and
// `completeUsageFetch` after it.
//
// `claimUsageFetch` runs inside ONE `RotatorStateStore.update()` call, which
// re-reads the file under the cross-process lock (see `src/state.ts`), so two
// processes can never both claim the same profile at the same time. If the
// store cannot take the lock it merges without one; the worst case is then one
// extra fetch, which is exactly the pre-lease behavior.
//
// No pi and no bridge imports, no network, no credentials.

import type { RotatorStateStore } from "./state.js";
import type { UsageFetchResult } from "./usage.js";

/** A successful snapshot younger than this is reused instead of refetched. The
 *  poller runs every 5 minutes, so this makes the effective cadence about once
 *  per account per 4 minutes across all processes. */
export const USAGE_SHARED_FRESH_MS = 4 * 60_000;
/** How long a process may hold the fetch claim for one profile. Longer than the
 *  5 s fetch timeout and the status probe sequence, so a slow fetch cannot be
 *  double-claimed. */
export const USAGE_FETCH_LEASE_MS = 30_000;
/** Minimum cooldown after HTTP 429, even without a usable `Retry-After`. */
export const USAGE_429_MIN_BACKOFF_MS = 5 * 60_000;
/** Hard ceiling on a 429 cooldown so a wild `Retry-After` cannot sideline an
 *  account for hours. */
export const USAGE_429_MAX_BACKOFF_MS = 60 * 60_000;

export type UsageFetchSkipReason = "backoff" | "fresh" | "lease";

/** Outcome of a `claimUsageFetch` call: either this process may fetch now, or a
 *  skip with the reason the caller can render. */
export type UsageFetchClaim =
	| { fetch: true }
	| { fetch: false; reason: UsageFetchSkipReason; retryAtMs?: number };

/**
 * Try to claim the shared fetch slot for one profile.
 *
 * Inside a single locked `update()` -- in this order: skip if the profile is in
 * a 429 backoff; skip if the shared snapshot is younger than
 * `USAGE_SHARED_FRESH_MS`; skip if another process holds a live lease;
 * otherwise write a fresh lease and return `{ fetch: true }`.
 *
 * Never throws: a state-write failure degrades to fetching, so a broken state
 * file can never stall usage reporting.
 */
export function claimUsageFetch(
	store: RotatorStateStore,
	profileId: string,
	nowMs: number,
): UsageFetchClaim {
	let claim: UsageFetchClaim | undefined;
	try {
		store.update((state) => {
			const entry = state.usageFetch[profileId];
			const backoffUntilMs = entry?.backoffUntilMs;
			if (backoffUntilMs !== undefined && backoffUntilMs > nowMs) {
				claim = { fetch: false, reason: "backoff", retryAtMs: backoffUntilMs };
				return;
			}
			const fetchedAtMs = state.usage[profileId]?.snapshot?.fetchedAtMs;
			if (fetchedAtMs !== undefined && nowMs - fetchedAtMs < USAGE_SHARED_FRESH_MS) {
				claim = { fetch: false, reason: "fresh" };
				return;
			}
			const leaseUntilMs = entry?.leaseUntilMs;
			if (leaseUntilMs !== undefined && leaseUntilMs > nowMs) {
				claim = { fetch: false, reason: "lease", retryAtMs: leaseUntilMs };
				return;
			}
			state.usageFetch[profileId] = { ...(entry ?? {}), leaseUntilMs: nowMs + USAGE_FETCH_LEASE_MS };
			claim = { fetch: true };
		});
	} catch {
		return { fetch: true };
	}
	return claim ?? { fetch: true };
}

/**
 * Release the lease for one profile and fold the fetch result into the shared
 * coordination state: a success clears any backoff, an HTTP 429 sets the backoff
 * (`max(retryAfterMs, 5 min)`, capped at 60 min), and every other outcome
 * (including a non-429 failure) clears the lease without setting a backoff.
 *
 * Never throws: cleanup failing must not break the caller.
 */
export function completeUsageFetch(
	store: RotatorStateStore,
	profileId: string,
	result: UsageFetchResult,
	nowMs: number,
): void {
	try {
		store.update((state) => {
			const entry = { ...(state.usageFetch[profileId] ?? {}) };
			delete entry.leaseUntilMs;
			if (result.ok) {
				delete entry.backoffUntilMs;
			} else if (result.reason === "http-error" && result.httpStatus === 429) {
				const backoffMs = Math.min(
					Math.max(result.retryAfterMs ?? 0, USAGE_429_MIN_BACKOFF_MS),
					USAGE_429_MAX_BACKOFF_MS,
				);
				entry.backoffUntilMs = nowMs + backoffMs;
			}
			if (entry.backoffUntilMs === undefined) delete state.usageFetch[profileId];
			else state.usageFetch[profileId] = entry;
		});
	} catch {
		// Best effort: a failed cleanup must not break the caller.
	}
}
