// `ClaudeAccountRouterV1` implementation.
//
// Contract authority (read-only, never imported at runtime):
//   @vanillagreen/pi-claude-bridge/src/account-router.ts
// The bridge looks the router up on
// `globalThis[Symbol.for("kendex.pi.claude-account-router.v1")]`; this module
// owns the local type mirror and the rotation policy, and Unit 2 owns the
// actual publish. The bridge wraps its `record*` calls in `safeRouterCall`, but
// this implementation stays non-throwing on its own.
//
// Policy (v1, "balanced"): session affinity first, then round-robin over every
// eligible profile. A rate-limited profile cools down, an auth/billing failure
// takes a profile out until an operator resets it, and rotation never shortens
// a cooldown.

import type { RotatorConfig, RotatorProfileConfig } from "./config.js";
import { rankProfiles } from "./ranking.js";
import { cloneJsonValue, MAX_SESSION_AFFINITY_ENTRIES, RotatorStateStore, touchSessionAffinity } from "./state.js";
import type { JsonValue, ProfileUsageError, ProfileUsageRecord } from "./state.js";
import type { UsageFetchResult } from "./usage.js";

/** The bridge's published contract symbol (see contract authority above). */
export const CLAUDE_ACCOUNT_ROUTER_SYMBOL = Symbol.for("kendex.pi.claude-account-router.v1");

// --- Contract type mirror (must stay shape-compatible with the bridge) ---

export interface ClaudeAccountRoute {
	profileId: string;
	label: string;
	configDir?: string;
	/** Reserved for model-scoped rotation, a v1 non-goal: never set here. */
	modelId?: string;
	fallbackReason?: "fable-quota";
}

export type ClaudeAccountFailureKind = "auth" | "billing" | "rate-limit" | "overloaded" | "server" | "network";

export interface ClaudeAccountAcquireInput {
	modelId: string;
	sessionId?: string;
	excludedProfileIds?: string[];
	forceRerank?: boolean;
	reason?: string;
}

export interface ClaudeAccountIdentity {
	email?: string;
	organization?: string;
	organizationId?: string;
	subscriptionType?: string;
	authMethod?: string;
}

export interface ClaudeAccountRouterV1 {
	version: 1;
	acquire(input: ClaudeAccountAcquireInput): ClaudeAccountRoute;
	recordIdentity(profileId: string, identity: ClaudeAccountIdentity): void;
	recordUsage(profileId: string, usage: unknown): void;
	recordRateLimit(profileId: string, info: Record<string, unknown> | undefined, modelId: string): number;
	recordFailure(profileId: string, kind: ClaudeAccountFailureKind, modelId: string): void;
	recordSuccess(profileId: string, sessionId?: string): void;
	current(modelId: string, sessionId?: string): ClaudeAccountRoute | undefined;
	resolveProfile?(profileId: string): Pick<ClaudeAccountRoute, "profileId" | "configDir"> | undefined;
}

// --- Cooldown timing ---

/** Used when a rate limit arrives with no usable reset time, and for a
 *  `rate-limit` failure classification (the bridge ignores our return value,
 *  so the cooldown is the only channel we have). */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
/** A reset further out than this is almost certainly a misparse (or a weekly
 *  window we cannot serve); cap it rather than sideline the account for days. */
export const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Mirrored from the bridge's `rate-limit.ts` heuristic (no runtime import):
 *  epoch seconds stay below 1e12 until the year 33658 while epoch ms passed
 *  1e12 in 2001, so magnitude decides the unit. Numeric strings get the same
 *  treatment, and anything else falls back to `Date.parse` for ISO strings. */
export function resetTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.abs(value) < 1e12 ? value * 1000 : value;
	}
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const numeric = Number(value);
	if (Number.isFinite(numeric)) return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** First usable reset field, in the bridge's own precedence order
 *  (`resetsAt ?? resets_at ?? resetAt ?? reset_at`). Only a number (epoch) or a
 *  string (numeric or ISO) can yield a reset time; anything else is skipped. */
export function rateLimitResetFromInfo(info: Record<string, unknown> | undefined): number | string | undefined {
	for (const value of [info?.resetsAt, info?.resets_at, info?.resetAt, info?.reset_at]) {
		if (typeof value === "number" || typeof value === "string") return value;
	}
	return undefined;
}

export function rateLimitTypeFromInfo(info: Record<string, unknown> | undefined): string {
	const value = info?.rateLimitType ?? info?.rate_limit_type ?? info?.type;
	const text = typeof value === "string" ? value.trim() : "";
	return text.length > 0 ? text : "unknown";
}

/** Thrown by `acquire` when no profile can serve the request. The bridge reads
 *  `resetAtMs` and `rateLimitType` straight off the thrown error to decide when
 *  it may retry, so they are real own properties, not just message text. */
export class AllProfilesUnavailableError extends Error {
	readonly resetAtMs: number | undefined;
	readonly rateLimitType: string | undefined;

	constructor(message: string, options: { resetAtMs?: number | undefined; rateLimitType?: string | undefined } = {}) {
		super(message);
		this.name = "AllProfilesUnavailableError";
		this.resetAtMs = options.resetAtMs;
		this.rateLimitType = options.rateLimitType;
	}
}

export interface ClaudeAccountRouterOptions {
	profiles: readonly RotatorProfileConfig[];
	state: RotatorStateStore;
	now?: (() => number) | undefined;
	onWarn?: ((message: string) => void) | undefined;
	/** Recency bound for the in-memory per-session route cache. Defaults to
	 *  `MAX_SESSION_AFFINITY_ENTRIES`; injectable so tests can use a tiny bound. */
	maxSessionRouteEntries?: number | undefined;
	/** Fire-and-forget hook invoked after a recorded success (used by the
	 *  poller for an after-request usage refresh). Guarded: a throwing callback
	 *  never breaks the success write or routing itself. */
	onRequestSucceeded?: ((profileId: string) => void) | undefined;
}

export class ClaudeAccountRouter implements ClaudeAccountRouterV1 {
	readonly version: 1 = 1;

	private readonly profileList: readonly RotatorProfileConfig[];
	private readonly profiles: Map<string, RotatorProfileConfig>;
	private readonly state: RotatorStateStore;
	private readonly now: () => number;
	private readonly onWarn: (message: string) => void;
	private readonly onRequestSucceeded: ((profileId: string) => void) | undefined;
	private readonly lastRouteBySession = new Map<string, ClaudeAccountRoute>();
	private readonly maxSessionRouteEntries: number;
	private lastGlobalRoute: ClaudeAccountRoute | undefined;
	private warnedOnce = false;

	constructor(options: ClaudeAccountRouterOptions) {
		this.profileList = [...options.profiles];
		this.profiles = new Map(this.profileList.map((profile) => [profile.id, profile]));
		this.state = options.state;
		this.now = options.now ?? (() => Date.now());
		this.onWarn = options.onWarn ?? ((message: string) => console.warn(message));
		this.onRequestSucceeded = options.onRequestSucceeded;
		const limit = options.maxSessionRouteEntries;
		this.maxSessionRouteEntries = typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0
			? limit
			: MAX_SESSION_AFFINITY_ENTRIES;
	}

	acquire(input: ClaudeAccountAcquireInput): ClaudeAccountRoute {
		const nowMs = this.now();
		const excluded = new Set((input.excludedProfileIds ?? []).filter((id) => typeof id === "string"));
		const sessionId = nonEmptyString(input.sessionId);

		// Affinity first: a bound session keeps its account so Claude Code
		// `--resume` keeps finding the JSONL it wrote under that config dir.
		if (sessionId !== undefined) {
			const bound = this.state.state.sessionAffinity[sessionId];
			if (bound !== undefined && this.isEligible(bound, excluded, nowMs)) return this.issue(bound, sessionId);
		}

		// Collect eligible candidates in profile order, then rank them. Ranking is
		// deterministic and reads only the cached snapshot (`acquire` never
		// fetches). With no fresh snapshot at all it degrades to today's cursor
		// round-robin.
		const candidates: string[] = [];
		for (const profile of this.profileList) {
			if (this.isEligible(profile.id, excluded, nowMs)) candidates.push(profile.id);
		}
		const ranked = rankProfiles({ candidates, usage: (id) => this.planUsage(id), nowMs });

		if (ranked.mode === "usage") {
			// Usage mode always yields a non-empty order when at least one profile
			// is eligible. Advance the cursor past the pick so a later fallback to
			// round-robin stays fair.
			const picked = ranked.order[0];
			if (picked !== undefined) {
				const index = this.profileList.findIndex((profile) => profile.id === picked);
				this.advanceCursor(index + 1);
				return this.issue(picked, sessionId);
			}
		} else {
			// Today's cursor loop, unchanged: the bridge's own failover retry passes
			// `forceRerank` plus the failed ids as `excludedProfileIds`; honoring the
			// exclusions while the cursor advances naturally lands elsewhere, so no
			// separate rerank machinery is needed.
			const start = this.cursor();
			for (let offset = 0; offset < this.profileList.length; offset += 1) {
				const index = (start + offset) % this.profileList.length;
				const candidate = this.profileList[index];
				if (candidate === undefined) continue;
				if (!this.isEligible(candidate.id, excluded, nowMs)) continue;
				this.advanceCursor(index + 1);
				return this.issue(candidate.id, sessionId);
			}
		}

		throw this.unavailableError(input, nowMs);
	}

	recordRateLimit(profileId: string, info: Record<string, unknown> | undefined, _modelId: string): number {
		return this.guard("recordRateLimit", 0, () => {
			if (!this.profiles.has(profileId)) return 0;
			const nowMs = this.now();
			const parsed = resetTimestampMs(rateLimitResetFromInfo(info));
			const rateLimitType = rateLimitTypeFromInfo(info);

			if (parsed === undefined) {
				const untilMs = nowMs + DEFAULT_COOLDOWN_MS;
				this.setCooldown(profileId, untilMs, rateLimitType);
				return untilMs;
			}
			// A reset time already in the past is skipped: it must never shorten
			// an active cooldown. `acquire` never routes to a cooling profile, so
			// such a payload can only be a stale duplicate from a concurrent
			// in-flight request; the service still enforces the limit, and the
			// next genuine 429 re-records the cooldown anyway.
			if (parsed <= nowMs) {
				const existing = this.state.state.cooldowns[profileId];
				if (existing !== undefined && existing.untilMs > nowMs) return existing.untilMs;
				if (existing !== undefined) this.clearCooldown(profileId);
				return 0;
			}
			const untilMs = Math.min(parsed, nowMs + MAX_COOLDOWN_MS);
			this.setCooldown(profileId, untilMs, rateLimitType);
			return untilMs;
		});
	}

	recordFailure(profileId: string, kind: ClaudeAccountFailureKind, modelId: string): void {
		this.guard("recordFailure", undefined, () => {
			if (!this.profiles.has(profileId)) return;
			const atMs = this.now();
			this.state.update((state) => {
				state.failures[profileId] = { kind, modelId, atMs };
				if (kind === "auth" || kind === "billing") {
					// Needs a human: relogin or a billing fix cannot be waited out.
					if (!state.invalid.includes(profileId)) state.invalid.push(profileId);
					delete state.cooldowns[profileId];
					return;
				}
				if (kind === "rate-limit") {
					const existing = state.cooldowns[profileId];
					state.cooldowns[profileId] = {
						untilMs: Math.max(existing?.untilMs ?? 0, atMs + DEFAULT_COOLDOWN_MS),
						rateLimitType: existing?.rateLimitType ?? "unknown",
					};
				}
				// overloaded | server | network: transient upstream conditions,
				// diagnostics only. Another account may still succeed, so
				// eligibility is deliberately unchanged.
			});
		});
	}

	recordSuccess(profileId: string, sessionId?: string): void {
		this.guard("recordSuccess", undefined, () => {
			if (!this.profiles.has(profileId)) return;
			// Best-effort usage refresh trigger, independent of the session write
			// below: it fires even when the bridge reports no session id.
			this.invokeRequestSucceeded(profileId);
			const sid = nonEmptyString(sessionId);
			if (sid === undefined) return;
			this.state.update((state) => {
				touchSessionAffinity(state.sessionAffinity, sid, profileId);
			});
		});
	}

	recordIdentity(profileId: string, identity: ClaudeAccountIdentity): void {
		this.guard("recordIdentity", undefined, () => {
			if (!this.profiles.has(profileId) || typeof identity !== "object" || identity === null) return;
			const entry: Record<string, string> = {};
			for (const field of ["email", "organization", "organizationId", "subscriptionType", "authMethod"] as const) {
				const text = nonEmptyString(identity[field]);
				if (text !== undefined) entry[field] = text;
			}
			if (Object.keys(entry).length === 0) return;
			this.state.update((state) => {
				state.identity[profileId] = { ...state.identity[profileId], ...entry, updatedAtMs: this.now() };
			});
		});
	}

	recordUsage(profileId: string, usage: unknown): void {
		this.guard("recordUsage", undefined, () => {
			if (!this.profiles.has(profileId)) return;
			const cloned: JsonValue | undefined = cloneJsonValue(usage);
			if (cloned === undefined) return;
			this.state.update((state) => {
				state.identity[profileId] = { ...state.identity[profileId], usage: cloned, updatedAtMs: this.now() };
			});
		});
	}

	/** Store the outcome of one plan-usage poll.
	 *
	 *  Not part of the bridge contract: usage-aware routing (a later stage) reads
	 *  it through `planUsage`. On success the snapshot replaces the previous one
	 *  and the error is cleared; on failure the previous snapshot is kept and the
	 *  typed reason is recorded, so status can still show last known values.
	 *  Guarded like the other telemetry methods and a no-op for unknown ids. */
	recordPlanUsage(profileId: string, result: UsageFetchResult): void {
		this.guard("recordPlanUsage", undefined, () => {
			if (!this.profiles.has(profileId)) return;
			const atMs = this.now();
			this.state.update((state) => {
				const previous = state.usage[profileId]?.snapshot;
				if (result.ok) {
					state.usage[profileId] = { snapshot: result.snapshot };
					return;
				}
				const lastError: ProfileUsageError = { reason: result.reason, atMs };
				if (result.httpStatus !== undefined) lastError.httpStatus = result.httpStatus;
				const record: ProfileUsageRecord = { lastError };
				if (previous !== undefined) record.snapshot = previous;
				state.usage[profileId] = record;
			});
		});
	}

	/** Read the stored plan-usage record for a profile (never throws). */
	planUsage(profileId: string): ProfileUsageRecord | undefined {
		return this.guard("planUsage", undefined, () => this.state.state.usage[profileId]);
	}

	current(_modelId: string, sessionId?: string): ClaudeAccountRoute | undefined {
		return this.guard("current", undefined, () => {
			const sid = nonEmptyString(sessionId);
			if (sid !== undefined) {
				const route = this.lastRouteBySession.get(sid);
				if (route !== undefined) return route;
			}
			return this.lastGlobalRoute;
		});
	}

	resolveProfile(profileId: string): Pick<ClaudeAccountRoute, "profileId" | "configDir"> | undefined {
		return this.guard("resolveProfile", undefined, () => {
			const profile = this.profiles.get(profileId);
			// The EXACT config dir: the bridge rebuilds `CLAUDE_CONFIG_DIR` from
			// this when restoring a session, and a different dir loses the JSONL.
			return profile === undefined ? undefined : { profileId: profile.id, configDir: profile.configDir };
		});
	}

	/** Injectable intro-spection for Unit 2's status command. */
	get profilesConfig(): readonly RotatorProfileConfig[] {
		return this.profileList;
	}

	get stateStore(): RotatorStateStore {
		return this.state;
	}

	private issue(profileId: string, sessionId: string | undefined): ClaudeAccountRoute {
		const profile = this.profiles.get(profileId);
		if (profile === undefined) throw new AllProfilesUnavailableError(`Unknown Claude profile id "${profileId}".`);
		const route: ClaudeAccountRoute = { profileId, label: profile.label, configDir: profile.configDir };
		this.lastGlobalRoute = route;
		if (sessionId !== undefined) this.rememberRoute(sessionId, route);
		return route;
	}

	/** Recency order mirrors the persisted session affinity: delete before
	 *  re-set so a re-used session appends, then evict the oldest overflow. */
	private rememberRoute(sessionId: string, route: ClaudeAccountRoute): void {
		this.lastRouteBySession.delete(sessionId);
		this.lastRouteBySession.set(sessionId, route);
		while (this.lastRouteBySession.size > this.maxSessionRouteEntries) {
			const oldest = this.lastRouteBySession.keys().next().value;
			if (oldest === undefined) return;
			this.lastRouteBySession.delete(oldest);
		}
	}

	private isEligible(profileId: string, excluded: ReadonlySet<string>, nowMs: number): boolean {
		if (excluded.has(profileId)) return false;
		if (!this.profiles.has(profileId)) return false;
		if (this.state.state.invalid.includes(profileId)) return false;
		const cooldown = this.state.state.cooldowns[profileId];
		return cooldown === undefined || cooldown.untilMs <= nowMs;
	}

	private cursor(): number {
		const length = this.profileList.length;
		if (length === 0) return 0;
		const stored = this.state.state.cursor;
		return Number.isSafeInteger(stored) && stored >= 0 ? stored % length : 0;
	}

	private advanceCursor(value: number): void {
		const length = this.profileList.length;
		const next = length === 0 ? 0 : value % length;
		try {
			this.state.update((state) => {
				state.cursor = next;
			});
		} catch (error) {
			// The cursor is a rotation nicety; failing to persist it must not
			// fail an acquire. The in-memory value already advanced above.
			this.warn(`could not persist rotator state: ${describeError(error)}`);
		}
	}

	private setCooldown(profileId: string, untilMs: number, rateLimitType: string): void {
		this.state.update((state) => {
			const existing = state.cooldowns[profileId];
			state.cooldowns[profileId] = {
				// Never shorten an active cooldown: the bridge can report the
				// same limit from several paths, and a stale payload must not
				// hand the account back early.
				untilMs: Math.max(existing?.untilMs ?? 0, untilMs),
				rateLimitType,
			};
		});
	}

	private clearCooldown(profileId: string): void {
		this.state.update((state) => {
			delete state.cooldowns[profileId];
		});
	}

	private unavailableError(input: ClaudeAccountAcquireInput, nowMs: number): AllProfilesUnavailableError {
		let soonest: { profileId: string; untilMs: number; rateLimitType: string } | undefined;
		for (const [profileId, cooldown] of Object.entries(this.state.state.cooldowns)) {
			if (!this.profiles.has(profileId) || cooldown.untilMs <= nowMs) continue;
			if (soonest === undefined || cooldown.untilMs < soonest.untilMs) {
				soonest = { profileId, untilMs: cooldown.untilMs, rateLimitType: cooldown.rateLimitType || "unknown" };
			}
		}
		if (soonest !== undefined) {
			return new AllProfilesUnavailableError(
				`All Claude subscription profiles are cooling down for model "${input.modelId}"; `
					+ `the soonest reset is ${new Date(soonest.untilMs).toISOString()} `
					+ `(${soonest.rateLimitType} limit on profile "${soonest.profileId}").`,
				{ resetAtMs: soonest.untilMs, rateLimitType: soonest.rateLimitType },
			);
		}

		const invalid = this.state.state.invalid.filter((id) => this.profiles.has(id));
		return new AllProfilesUnavailableError(
			"No Claude subscription profile is eligible"
				+ `${invalid.length > 0 ? `; these need a manual re-login/reset: ${invalid.join(", ")}` : ""}. `
				+ "Refresh the Claude login for the affected accounts and clear them with the "
				+ "`/claude-accounts reset` command, then retry.",
			{},
		);
	}

	private invokeRequestSucceeded(profileId: string): void {
		const callback = this.onRequestSucceeded;
		if (callback === undefined) return;
		try {
			callback(profileId);
		} catch (error) {
			// A refresh trigger is best-effort: it must never break a recorded
			// success or the session-affinity write that follows it.
			this.warn(`onRequestSucceeded failed: ${describeError(error)}`);
		}
	}

	private guard<T>(label: string, fallback: T, body: () => T): T {
		try {
			return body();
		} catch (error) {
			// The router is third-party code reached from delivery paths: a
			// throwing telemetry callback must never error a rendered turn.
			this.warn(`${label} failed: ${describeError(error)}`);
			return fallback;
		}
	}

	private warn(message: string): void {
		if (this.warnedOnce) return;
		this.warnedOnce = true;
		this.onWarn(`claude-bridge-rotator: ${message}`);
	}
}

export interface CreateRouterOptions {
	state?: RotatorStateStore | undefined;
	statePath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	now?: (() => number) | undefined;
	onWarn?: ((message: string) => void) | undefined;
	onRequestSucceeded?: ((profileId: string) => void) | undefined;
}

/** Build a router for a loaded config. Unit 2 calls this during extension
 *  registration; tests build the store directly to inject temp paths. */
export function createRouter(config: RotatorConfig, options: CreateRouterOptions = {}): ClaudeAccountRouter {
	const state = options.state ?? new RotatorStateStore({
		statePath: options.statePath,
		env: options.env,
		now: options.now,
		onWarn: options.onWarn,
	});
	return new ClaudeAccountRouter({
		profiles: config.profiles,
		state,
		now: options.now,
		onWarn: options.onWarn,
		onRequestSucceeded: options.onRequestSucceeded,
	});
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
