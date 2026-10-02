// Background plan-usage poller.
//
// Lifecycle contract: never start timers at import/factory time. The extension
// creates and starts exactly one poller from `pi.on("session_start")` and stops
// it from the idempotent `session_shutdown` handler. `/reload` fires
// `session_shutdown` and re-runs the entry, so the poller handle lives in the
// shared process-global command state (`src/index.ts`).
//
// The poller reads the CURRENT router through `getTargets` on every run instead
// of holding a router reference, because `state.refresh` and a reload replace
// the router. It never probes the bridge host and never reads credentials: the
// injected `fetchUsage` owns the token handling (an expired token is just a
// `token-expired` result). It never throws; warnings are deduplicated per
// distinct failure kind.

import type { FetchUsage } from "./commands.js";
import type { RotatorProfileConfig } from "./config.js";
import { fetchPlanUsage } from "./usage.js";
import type { UsageFetchResult } from "./usage.js";

/** Background refresh cadence for every configured profile. */
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000;
/** Per-profile floor between after-request refreshes. */
export const USAGE_REFRESH_THROTTLE_MS = 60_000;

export type SetIntervalFn = (handler: () => void, timeoutMs: number) => unknown;
export type ClearIntervalFn = (handle: unknown) => void;
export type SetTimeoutFn = (handler: () => void, timeoutMs: number) => unknown;

/** Minimal router surface the poller records into (structural, type-only). */
export interface UsagePollerRouter {
	recordPlanUsage(profileId: string, result: UsageFetchResult): void;
}

export interface UsagePollerTarget {
	router: UsagePollerRouter;
	profiles: readonly RotatorProfileConfig[];
}

export interface UsagePollerOptions {
	/** Injected fetch seam; defaults to the real `fetchPlanUsage` under `now`. */
	fetchUsage?: FetchUsage | undefined;
	/** Read the current router/profiles on every run. `undefined` means routing
	 *  is not configured and the run is a no-op. */
	getTargets: () => UsagePollerTarget | undefined;
	now?: (() => number) | undefined;
	onWarn?: ((message: string) => void) | undefined;
	setIntervalFn?: SetIntervalFn | undefined;
	clearIntervalFn?: ClearIntervalFn | undefined;
	setTimeoutFn?: SetTimeoutFn | undefined;
}

/** Node's `setInterval`/`setTimeout` handles expose `unref`; browsers do not. */
function unrefTimer(handle: unknown): void {
	const candidate = handle as { unref?: () => void } | null | undefined;
	if (candidate !== null && candidate !== undefined && typeof candidate.unref === "function") {
		try {
			candidate.unref();
		} catch {
			// Best effort: an exotic timer handle must not break the poller.
		}
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export class UsagePoller {
	private readonly fetchUsage: FetchUsage;
	private readonly getTargets: () => UsagePollerTarget | undefined;
	private readonly now: () => number;
	private readonly onWarn: (message: string) => void;
	private readonly setIntervalFn: SetIntervalFn;
	private readonly clearIntervalFn: ClearIntervalFn;
	private readonly setTimeoutFn: SetTimeoutFn;

	private running = false;
	/** Bumped on every `stop()` so an in-flight result started before it is
	 *  discarded instead of recorded. */
	private generation = 0;
	private timerHandles: unknown[] = [];
	private readonly inFlight = new Set<string>();
	private readonly lastRefreshAtMs = new Map<string, number>();
	private readonly warnedKinds = new Set<string>();

	constructor(options: UsagePollerOptions) {
		this.now = options.now ?? (() => Date.now());
		this.fetchUsage = options.fetchUsage ?? ((usageOptions) => fetchPlanUsage({
			configDir: usageOptions.configDir,
			signal: usageOptions.signal,
			now: this.now,
		}));
		this.getTargets = options.getTargets;
		this.onWarn = options.onWarn ?? ((message: string) => console.warn(message));
		this.setIntervalFn = options.setIntervalFn ?? ((handler, timeoutMs) => setInterval(handler, timeoutMs));
		this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
		this.setTimeoutFn = options.setTimeoutFn ?? ((handler, timeoutMs) => setTimeout(handler, timeoutMs));
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Start one immediate refresh (next tick, so `session_start` never performs
	 *  network I/O synchronously) plus a periodic refresh. Idempotent. */
	start(): void {
		if (this.running) return;
		this.running = true;
		const generation = this.generation;
		const immediate = this.setTimeoutFn(() => {
			void this.runAll(generation);
		}, 0);
		unrefTimer(immediate);
		const interval = this.setIntervalFn(() => {
			void this.runAll(generation);
		}, USAGE_POLL_INTERVAL_MS);
		unrefTimer(interval);
		this.timerHandles = [immediate, interval];
	}

	/** Idempotent: clears every timer and discards in-flight results. */
	stop(): void {
		this.running = false;
		this.generation += 1;
		for (const handle of this.timerHandles) this.clearIntervalFn(handle);
		this.timerHandles = [];
	}

	/** Refresh one profile off the normal cadence. Throttled per profile and
	 *  deduplicated while a refresh for it is in flight. Never throws. */
	requestRefresh(profileId: string): void {
		try {
			if (!this.running) return;
			const targets = this.safeGetTargets();
			if (targets === undefined) return;
			const profile = targets.profiles.find((entry) => entry.id === profileId);
			if (profile === undefined) return;
			if (this.inFlight.has(profileId)) return;
			const nowMs = this.now();
			const lastRefreshMs = this.lastRefreshAtMs.get(profileId);
			if (lastRefreshMs !== undefined && nowMs - lastRefreshMs < USAGE_REFRESH_THROTTLE_MS) return;
			this.lastRefreshAtMs.set(profileId, nowMs);
			void this.refreshProfile(targets.router, profile, this.generation);
		} catch (error) {
			this.warnOnce("request-refresh", `could not schedule a usage refresh: ${describeError(error)}`);
		}
	}

	private async runAll(generation: number): Promise<void> {
		if (!this.running || generation !== this.generation) return;
		const targets = this.safeGetTargets();
		if (targets === undefined) return;
		for (const profile of targets.profiles) {
			if (!this.running || generation !== this.generation) return;
			await this.refreshProfile(targets.router, profile, generation);
		}
	}

	private safeGetTargets(): UsagePollerTarget | undefined {
		try {
			return this.getTargets();
		} catch (error) {
			this.warnOnce("get-targets", `could not read routing targets: ${describeError(error)}`);
			return undefined;
		}
	}

	private async refreshProfile(
		router: UsagePollerRouter,
		profile: RotatorProfileConfig,
		generation: number,
	): Promise<void> {
		if (this.inFlight.has(profile.id)) return;
		this.inFlight.add(profile.id);
		let result: UsageFetchResult;
		try {
			result = await this.fetchUsage({ configDir: profile.configDir });
		} catch (error) {
			this.inFlight.delete(profile.id);
			this.warnOnce("fetch-error", `usage refresh failed: ${describeError(error)}`);
			return;
		}
		this.inFlight.delete(profile.id);
		if (!this.running || generation !== this.generation) return;
		if (!result.ok) this.warnOnce(result.reason, `usage refresh failed (${result.reason}).`);
		try {
			router.recordPlanUsage(profile.id, result);
		} catch (error) {
			this.warnOnce("record-error", `could not record usage: ${describeError(error)}`);
		}
	}

	private warnOnce(kind: string, message: string): void {
		if (this.warnedKinds.has(kind)) return;
		this.warnedKinds.add(kind);
		try {
			this.onWarn(`claude-bridge-rotator: ${message}`);
		} catch {
			// A throwing warning sink must never break the poller.
		}
	}
}
