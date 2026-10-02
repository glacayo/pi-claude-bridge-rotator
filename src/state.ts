// Rotator runtime state: cooldowns, invalid profiles, session affinity,
// round-robin cursor, and the identity cache used by status output.
//
// Stored as `claude-bridge-rotator-state.json` next to the config, mode 0600,
// written with a temp file + rename inside the same directory so a crash can
// never leave a half-written file (a corrupt state would otherwise cost every
// account's cooldown knowledge). Paths are injectable for tests.
//
// Load never throws: missing state is a normal first run, and a corrupt or
// unreadable file degrades to a fresh state with a warning.

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { piAgentDir } from "./config.js";
import { USAGE_FAILURE_REASONS, USAGE_WINDOW_NAMES } from "./usage.js";
import type { UsageFailureReason, UsageSnapshot, UsageWindow, UsageWindowName } from "./usage.js";

export const ROTATOR_STATE_FILENAME = "claude-bridge-rotator-state.json";
export const STATE_VERSION = 1;
/** Session affinity is a resume convenience, not an audit log: keep the most
 *  recently touched sessions only, so the file stays bounded. */
export const MAX_SESSION_AFFINITY_ENTRIES = 200;
/** A lock file whose mtime is older than this belonged to a process that died
 *  mid-write and is safe to break. */
export const STATE_LOCK_STALE_MS = 5000;
/** Minimum gap between the state getter's cheap freshness `statSync` checks, so
 *  a hot `acquire` path does not stat the disk on every read. */
export const STATE_STAT_THROTTLE_MS = 250;
/** Lock retry pacing: sleep this long between attempts and give up after the
 *  total timeout has elapsed (then merge without the lock). */
export const STATE_LOCK_RETRY_MS = 10;
export const STATE_LOCK_TIMEOUT_MS = 250;

export interface CooldownRecord {
	/** Epoch ms at which the profile becomes eligible again. */
	untilMs: number;
	/** Rate-limit window label from the bridge payload; "unknown" when absent. */
	rateLimitType: string;
}

/** A value that survives a JSON round trip, used for the opaque usage payload
 *  the bridge reports (its contract types it as `unknown`). */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProfileIdentity {
	email?: string;
	organization?: string;
	organizationId?: string;
	subscriptionType?: string;
	authMethod?: string;
	/** Last raw usage payload seen for the profile (status display only). */
	usage?: JsonValue;
	updatedAtMs?: number;
}

/** Last failure per profile. Diagnostics only: eligibility is decided by the
 *  cooldown and invalid sets, never by this record. */
export interface ProfileFailure {
	kind: string;
	modelId: string;
	atMs: number;
}

/** Last plan-usage failure per profile, for the `usage: unavailable — …` line. */
export interface ProfileUsageError {
	reason: UsageFailureReason;
	atMs: number;
	httpStatus?: number;
}

/** Normalized plan usage for one profile. On a failed refresh the previous
 *  `snapshot` is deliberately kept alongside `lastError` so status can still
 *  show the last known values. */
export interface ProfileUsageRecord {
	snapshot?: UsageSnapshot;
	lastError?: ProfileUsageError;
}

/** Cross-process plan-usage fetch coordination for one profile. `leaseUntilMs`
 *  is a short claim so at most one process fetches at a time; `backoffUntilMs`
 *  is the cooldown after the endpoint answers HTTP 429. Both are epoch ms. */
export interface UsageFetchLease {
	leaseUntilMs?: number;
	backoffUntilMs?: number;
}

export interface RotatorState {
	version: number;
	cooldowns: Record<string, CooldownRecord>;
	/** Profiles needing a manual re-login/reset (auth or billing failures). */
	invalid: string[];
	/** Insertion order is recency: see `touchSessionAffinity`. */
	sessionAffinity: Record<string, string>;
	/** Epoch ms of each bound session's last successful use, keyed by session id.
	 *  Kept in lockstep with `sessionAffinity` (same keys, same cap) so the
	 *  cache-aware move rule can tell whether a 1-hour prompt cache is cold. */
	sessionLastUsedAtMs: Record<string, number>;
	cursor: number;
	identity: Record<string, ProfileIdentity>;
	failures: Record<string, ProfileFailure>;
	/** Normalized plan usage per profile id (see `src/usage.ts`). */
	usage: Record<string, ProfileUsageRecord>;
	/** Shared fetch lease/backoff per profile id, claimed under the state lock so
	 *  every pi process coordinates on a single usage request per window. */
	usageFetch: Record<string, UsageFetchLease>;
}

export interface RotatorStateStoreOptions {
	statePath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	now?: (() => number) | undefined;
	onWarn?: ((message: string) => void) | undefined;
	/** Blocking sleep used between lock retries. Defaults to `Atomics.wait`. */
	sleep?: ((ms: number) => void) | undefined;
	/** Lock file path; defaults to `${statePath}.lock`. */
	lockPath?: string | undefined;
	/** Age (mtime) past which a lock is considered abandoned. */
	lockStaleMs?: number | undefined;
	/** Total time to keep retrying a contended lock before merging unlocked. */
	lockTimeoutMs?: number | undefined;
	/** Delay between lock retries. */
	lockRetryMs?: number | undefined;
}

export function defaultStatePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(piAgentDir(env), ROTATOR_STATE_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Blocking sleep for the synchronous lock retry loop. `Atomics.wait` is the
 *  only portable way to sleep synchronously in Node without a busy spin. */
function defaultSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function positiveOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** JSON-safe copy of an arbitrary payload, or undefined when it cannot be
 *  represented (circular structures, BigInt, bare undefined). Parsing the
 *  stringified form is by construction a JsonValue. */
export function cloneJsonValue(value: unknown): JsonValue | undefined {
	if (value === undefined) return undefined;
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return undefined;
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function emptyRotatorState(): RotatorState {
	return {
		version: STATE_VERSION,
		cooldowns: {},
		invalid: [],
		sessionAffinity: {},
		sessionLastUsedAtMs: {},
		cursor: 0,
		identity: {},
		failures: {},
		usage: {},
		usageFetch: {},
	};
}

/** Keep affinity ordered by recency: delete first so a re-set appends. When a
 *  `lastUsedAtMs` map is given it is written in the same step and pruned with
 *  the same boundary, so the two maps never disagree about which sessions are
 *  bound. `atMs` defaults to `Date.now()` only for callers without an injected
 *  clock; the router always passes its `now`. */
export function touchSessionAffinity(
	affinity: Record<string, string>,
	sessionId: string,
	profileId: string,
	limit: number = MAX_SESSION_AFFINITY_ENTRIES,
	lastUsedAtMs?: Record<string, number> | undefined,
	atMs?: number | undefined,
): void {
	delete affinity[sessionId];
	affinity[sessionId] = profileId;
	if (lastUsedAtMs !== undefined) {
		delete lastUsedAtMs[sessionId];
		lastUsedAtMs[sessionId] = atMs ?? Date.now();
	}
	pruneSessionAffinity(affinity, limit, lastUsedAtMs);
}

/** Drop the oldest affinity entries past `limit`; when a paired `lastUsedAtMs`
 *  map is given, its entries are evicted together and any orphan it still holds
 *  (a timestamp with no affinity) is removed. */
export function pruneSessionAffinity(
	affinity: Record<string, string>,
	limit: number = MAX_SESSION_AFFINITY_ENTRIES,
	lastUsedAtMs?: Record<string, number> | undefined,
): void {
	const keys = Object.keys(affinity);
	for (let index = 0; index < keys.length - limit; index += 1) {
		const key = keys[index];
		if (key === undefined) continue;
		delete affinity[key];
		if (lastUsedAtMs !== undefined) delete lastUsedAtMs[key];
	}
	if (lastUsedAtMs === undefined) return;
	for (const sessionId of Object.keys(lastUsedAtMs)) {
		if (affinity[sessionId] === undefined) delete lastUsedAtMs[sessionId];
	}
}

function sanitizeState(raw: Record<string, unknown>): RotatorState {
	const state = emptyRotatorState();

	if (isRecord(raw.cooldowns)) {
		for (const [profileId, value] of Object.entries(raw.cooldowns)) {
			if (!isRecord(value)) continue;
			const untilMs = value.untilMs;
			if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) continue;
			state.cooldowns[profileId] = {
				untilMs,
				rateLimitType: nonEmptyString(value.rateLimitType) ?? "unknown",
			};
		}
	}

	if (Array.isArray(raw.invalid)) {
		for (const value of raw.invalid) {
			const id = nonEmptyString(value);
			if (id !== undefined && !state.invalid.includes(id)) state.invalid.push(id);
		}
	}

	if (isRecord(raw.sessionAffinity)) {
		for (const [sessionId, profileId] of Object.entries(raw.sessionAffinity)) {
			const bound = nonEmptyString(profileId);
			if (sessionId.length > 0 && bound !== undefined) state.sessionAffinity[sessionId] = bound;
		}
		pruneSessionAffinity(state.sessionAffinity);
	}

	// Last-use timestamps are optional (old files omit them) and valid only for
	// a session that still has affinity: finite, non-negative, no orphans.
	if (isRecord(raw.sessionLastUsedAtMs)) {
		for (const [sessionId, value] of Object.entries(raw.sessionLastUsedAtMs)) {
			if (state.sessionAffinity[sessionId] === undefined) continue;
			if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
			state.sessionLastUsedAtMs[sessionId] = value;
		}
	}

	const cursor = raw.cursor;
	if (typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0) state.cursor = cursor;

	if (isRecord(raw.identity)) {
		for (const [profileId, value] of Object.entries(raw.identity)) {
			if (!isRecord(value)) continue;
			const entry: ProfileIdentity = {};
			for (const field of ["email", "organization", "organizationId", "subscriptionType", "authMethod"] as const) {
				const text = nonEmptyString(value[field]);
				if (text !== undefined) entry[field] = text;
			}
			const usage = cloneJsonValue(value.usage);
			if (usage !== undefined) entry.usage = usage;
			if (typeof value.updatedAtMs === "number" && Number.isFinite(value.updatedAtMs)) entry.updatedAtMs = value.updatedAtMs;
			state.identity[profileId] = entry;
		}
	}

	if (isRecord(raw.failures)) {
		for (const [profileId, value] of Object.entries(raw.failures)) {
			if (!isRecord(value)) continue;
			const atMs = value.atMs;
			if (typeof atMs !== "number" || !Number.isFinite(atMs)) continue;
			state.failures[profileId] = {
				kind: nonEmptyString(value.kind) ?? "unknown",
				modelId: nonEmptyString(value.modelId) ?? "",
				atMs,
			};
		}
	}

	if (isRecord(raw.usage)) {
		for (const [profileId, value] of Object.entries(raw.usage)) {
			const record = sanitizeProfileUsage(value);
			if (record !== undefined) state.usage[profileId] = record;
		}
	}

	if (isRecord(raw.usageFetch)) {
		for (const [profileId, value] of Object.entries(raw.usageFetch)) {
			const entry = sanitizeUsageFetchLease(value);
			if (entry !== undefined) state.usageFetch[profileId] = entry;
		}
	}

	return state;
}

/** Rebuild one persisted `usage` entry from untrusted JSON, dropping anything
 *  malformed. A record with neither a usable snapshot nor a usable error is
 *  dropped entirely, so a stray `{}` never renders an empty usage line. */
function sanitizeProfileUsage(value: unknown): ProfileUsageRecord | undefined {
	if (!isRecord(value)) return undefined;
	const record: ProfileUsageRecord = {};
	const snapshot = sanitizeUsageSnapshot(value.snapshot);
	if (snapshot !== undefined) record.snapshot = snapshot;
	const lastError = sanitizeUsageError(value.lastError);
	if (lastError !== undefined) record.lastError = lastError;
	return record.snapshot === undefined && record.lastError === undefined ? undefined : record;
}

function sanitizeUsageSnapshot(value: unknown): UsageSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	const fetchedAtMs = value.fetchedAtMs;
	if (typeof fetchedAtMs !== "number" || !Number.isFinite(fetchedAtMs)) return undefined;
	if (!isRecord(value.windows)) return undefined;
	const windows: Partial<Record<UsageWindowName, UsageWindow>> = {};
	for (const name of USAGE_WINDOW_NAMES) {
		const window = sanitizeUsageWindow(value.windows[name]);
		if (window !== undefined) windows[name] = window;
	}
	return { fetchedAtMs, windows };
}

function sanitizeUsageWindow(value: unknown): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const utilization = value.utilization;
	const normalizedUtilization = utilization === null
		? null
		: typeof utilization === "number" && Number.isFinite(utilization)
			? Math.min(100, Math.max(0, utilization))
			: undefined;
	if (normalizedUtilization === undefined) return undefined;
	const resetsAtMs = value.resetsAtMs;
	const normalizedResetsAt = resetsAtMs === null
		? null
		: typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs)
			? resetsAtMs
			: undefined;
	if (normalizedResetsAt === undefined) return undefined;
	return { utilization: normalizedUtilization, resetsAtMs: normalizedResetsAt };
}

function sanitizeUsageError(value: unknown): ProfileUsageError | undefined {
	if (!isRecord(value)) return undefined;
	const reason = value.reason;
	if (typeof reason !== "string" || !(USAGE_FAILURE_REASONS as readonly string[]).includes(reason)) return undefined;
	const atMs = value.atMs;
	if (typeof atMs !== "number" || !Number.isFinite(atMs)) return undefined;
	const error: ProfileUsageError = { reason: reason as UsageFailureReason, atMs };
	const httpStatus = value.httpStatus;
	if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) error.httpStatus = httpStatus;
	return error;
}

/** Keep only finite non-negative timestamps; drop an entry that carries neither,
 *  so a stray `{}` never occupies a profile slot. */
function sanitizeUsageFetchLease(value: unknown): UsageFetchLease | undefined {
	if (!isRecord(value)) return undefined;
	const entry: UsageFetchLease = {};
	const leaseUntilMs = value.leaseUntilMs;
	if (typeof leaseUntilMs === "number" && Number.isFinite(leaseUntilMs) && leaseUntilMs >= 0) {
		entry.leaseUntilMs = leaseUntilMs;
	}
	const backoffUntilMs = value.backoffUntilMs;
	if (typeof backoffUntilMs === "number" && Number.isFinite(backoffUntilMs) && backoffUntilMs >= 0) {
		entry.backoffUntilMs = backoffUntilMs;
	}
	return entry.leaseUntilMs === undefined && entry.backoffUntilMs === undefined ? undefined : entry;
}

export class RotatorStateStore {
	readonly path: string;
	readonly lockPath: string;
	private readonly onWarn: (message: string) => void;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => void;
	private readonly lockStaleMs: number;
	private readonly lockTimeoutMs: number;
	private readonly lockRetryMs: number;
	private data: RotatorState;
	/** Freshness snapshot of the file the in-memory state was read from. */
	private lastStatAtMs = 0;
	private lastMtimeMs: number | undefined;
	private lastSize: number | undefined;
	private lastIno: number | undefined;
	private lockWarned = false;

	constructor(options: RotatorStateStoreOptions = {}) {
		const env = options.env ?? process.env;
		this.path = resolve(options.statePath ?? defaultStatePath(env));
		this.lockPath = resolve(options.lockPath ?? `${this.path}.lock`);
		this.onWarn = options.onWarn ?? ((message: string) => console.warn(message));
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? defaultSleep;
		this.lockStaleMs = positiveOr(options.lockStaleMs, STATE_LOCK_STALE_MS);
		this.lockTimeoutMs = positiveOr(options.lockTimeoutMs, STATE_LOCK_TIMEOUT_MS);
		this.lockRetryMs = positiveOr(options.lockRetryMs, STATE_LOCK_RETRY_MS);
		this.data = this.read();
		this.recordStat();
	}

	/** Live state object. Reads cheaply re-check the file so a change written by
	 *  another pi process is picked up within the throttle window. Mutate through
	 *  `update` (or mutate then `save`). */
	get state(): RotatorState {
		this.refreshFromDisk();
		return this.data;
	}

	/** Read-merge-write under a short lock file: re-read the on-disk state, apply
	 *  `mutator` exactly once to that fresh copy, then persist atomically. This
	 *  keeps concurrent processes from clobbering each other's affinity, cooldown,
	 *  or cursor changes. Lock problems never throw and never deadlock: a
	 *  contended lock is retried for a bounded time, a stale one is broken, and
	 *  the final fallback merges without a lock and warns once. */
	update(mutator: (state: RotatorState) => void): void {
		const locked = this.acquireLock();
		try {
			const fresh = this.readForUpdate();
			mutator(fresh);
			this.save(fresh);
			this.data = fresh;
			this.recordStat();
		} finally {
			if (locked) this.releaseLock();
		}
	}

	/** Atomic write: sibling temp file, mode 0600, then rename over the target. */
	save(state: RotatorState = this.data): void {
		const directory = dirname(this.path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const tempPath = join(
			directory,
			`.${ROTATOR_STATE_FILENAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
		);
		const payload = `${JSON.stringify(state, null, "\t")}\n`;
		try {
			// The explicit mode is still subject to umask, so chmod afterwards.
			writeFileSync(tempPath, payload, { encoding: "utf8", mode: 0o600 });
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, this.path);
		} catch (error) {
			try {
				unlinkSync(tempPath);
			} catch {
				// Best effort: the temp file may never have been created.
			}
			throw error;
		}
	}

	/** Reload when the file changed under us, at most once per throttle window. */
	private refreshFromDisk(): void {
		const nowMs = this.now();
		if (nowMs - this.lastStatAtMs < STATE_STAT_THROTTLE_MS) return;
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(this.path);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") {
				this.onWarn(
					`claude-bridge-rotator: state at ${this.path} is unreadable (${describeError(error)}); keeping the in-memory state.`,
				);
			}
			this.lastStatAtMs = nowMs;
			return;
		}
		this.lastStatAtMs = nowMs;
		if (stat.mtimeMs === this.lastMtimeMs && stat.size === this.lastSize && stat.ino === this.lastIno) return;
		const read = this.readFromDisk("keeping the in-memory state");
		const fresh = read === "missing" ? undefined : read;
		if (fresh === undefined) return;
		this.data = fresh;
		this.lastMtimeMs = stat.mtimeMs;
		this.lastSize = stat.size;
		this.lastIno = stat.ino;
	}

	private recordStat(): void {
		try {
			const stat = statSync(this.path);
			this.lastMtimeMs = stat.mtimeMs;
			this.lastSize = stat.size;
			this.lastIno = stat.ino;
		} catch {
			this.lastMtimeMs = undefined;
			this.lastSize = undefined;
			this.lastIno = undefined;
		}
		this.lastStatAtMs = this.now();
	}

	/** Bounded synchronous lock acquisition. Returns true only when this call
	 *  created the lock and therefore owns its removal. */
	private acquireLock(): boolean {
		try {
			mkdirSync(dirname(this.lockPath), { recursive: true, mode: 0o700 });
		} catch (error) {
			this.warnLock(describeError(error));
			return false;
		}
		const attempts = Math.max(1, Math.ceil(this.lockTimeoutMs / this.lockRetryMs));
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (this.tryCreateLock()) return true;
			if (this.lockIsStale()) {
				this.removeLock();
				if (this.tryCreateLock()) return true;
			}
			if (attempt < attempts - 1) this.sleep(this.lockRetryMs);
		}
		this.warnLock("another process is holding it");
		return false;
	}

	private tryCreateLock(): boolean {
		try {
			closeSync(openSync(this.lockPath, "wx"));
			return true;
		} catch {
			return false;
		}
	}

	private lockIsStale(): boolean {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(this.lockPath);
		} catch {
			// Vanished or unreadable: retry the create immediately.
			return true;
		}
		return Date.now() - stat.mtimeMs > this.lockStaleMs;
	}

	private removeLock(): void {
		try {
			unlinkSync(this.lockPath);
		} catch {
			// Already gone (or not removable): nothing to clean up.
		}
	}

	private releaseLock(): void {
		this.removeLock();
	}

	private warnLock(reason: string): void {
		if (this.lockWarned) return;
		this.lockWarned = true;
		this.onWarn(
			`claude-bridge-rotator: could not acquire the state lock at ${this.lockPath} (${reason}); merging without a lock.`,
		);
	}

	private read(): RotatorState {
		const read = this.readFromDisk("starting fresh");
		return read === "missing" || read === undefined ? emptyRotatorState() : read;
	}

	/** Base state for `update`. A missing file starts fresh, but an unreadable or
	 *  corrupt one must not: starting from empty would persist an empty state and
	 *  wipe every affinity, cooldown, and snapshot. Use the in-memory copy then. */
	private readForUpdate(): RotatorState {
		const read = this.readFromDisk("merging into the in-memory state");
		if (read === "missing") return emptyRotatorState();
		if (read !== undefined) return read;
		const copy = cloneJsonValue(this.data);
		return isRecord(copy) ? sanitizeState(copy) : emptyRotatorState();
	}

	/** Parse and sanitize the current file. Returns `"missing"` when there is no
	 *  file, and `undefined` (with a warning) when it is unreadable or corrupt, so
	 *  callers can choose whether to start fresh or keep the in-memory state. */
	private readFromDisk(fallback: string): RotatorState | "missing" | undefined {
		let raw: string;
		try {
			raw = readFileSync(this.path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return "missing";
			this.onWarn(
				`claude-bridge-rotator: state at ${this.path} is unreadable (${describeError(error)}); ${fallback}.`,
			);
			return undefined;
		}

		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed)) throw new Error("state root is not a JSON object");
			return sanitizeState(parsed);
		} catch (error) {
			this.onWarn(
				`claude-bridge-rotator: state at ${this.path} is corrupt (${describeError(error)}); ${fallback}.`,
			);
			return undefined;
		}
	}
}
