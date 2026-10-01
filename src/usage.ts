// Plan-usage source for the rotator.
//
// The rotator reads each account's real subscription usage itself, because the
// bridge cannot: `@vanillagreen/pi-claude-bridge` sets
// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, so the Claude Code usage payload
// it sees always carries `rate_limits: null` (see the feature document under
// `odd/`). Instead this module reads the access token straight from the
// profile's `.credentials.json` and calls the OAuth usage endpoint.
//
// Two hard rules:
//   1. The access token is read-only and NEVER leaves this process: it is not
//      returned, logged, thrown, or persisted. Only the access token and its
//      expiry are read; refresh-token fields are never touched.
//   2. Nothing here throws. Every failure degrades to a typed `UsageFetchResult`
//      so the caller can render a reason instead of crashing a rendered turn.
//
// No pi and no bridge imports (type-only or otherwise): global `fetch`,
// `AbortController`, and `node:fs` only.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The OAuth usage endpoint the official Claude Code CLI uses. Verified live
 *  (2026-10-01) to accept a plain bearer token with no extra headers. */
export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";

/** Per-request timeout. A slow usage endpoint must never stall `status`. */
export const DEFAULT_USAGE_TIMEOUT_MS = 5000;

/** Credentials file name inside a profile's `configDir` (`CLAUDE_CONFIG_DIR`). */
export const CREDENTIALS_FILENAME = ".credentials.json";

/** The only plan windows the rotator understands; everything else in the
 *  response body is ignored. */
export const USAGE_WINDOW_NAMES = [
	"five_hour",
	"seven_day",
	"seven_day_opus",
	"seven_day_sonnet",
] as const;
export type UsageWindowName = (typeof USAGE_WINDOW_NAMES)[number];

/** Every failure reason the usage path can report. Kept as a runtime list so
 *  state sanitization can validate persisted records against it. */
export const USAGE_FAILURE_REASONS = [
	"no-credentials",
	"token-expired",
	"unauthorized",
	"http-error",
	"network",
	"timeout",
	"malformed",
] as const;
export type UsageFailureReason = (typeof USAGE_FAILURE_REASONS)[number];

export interface UsageWindow {
	/** Percent used in this window, clamped to 0-100, or `null` when the
	 *  endpoint reports no number. */
	utilization: number | null;
	/** Epoch ms of the window reset, or `null` when absent/unparseable/not
	 *  started (`five_hour.resets_at` is `null` before the window opens). */
	resetsAtMs: number | null;
}

export interface UsageSnapshot {
	/** Epoch ms the endpoint was polled (also the timeout clock). */
	fetchedAtMs: number;
	windows: Partial<Record<UsageWindowName, UsageWindow>>;
}

export type UsageFetchResult =
	| { ok: true; snapshot: UsageSnapshot }
	| { ok: false; reason: UsageFailureReason; httpStatus?: number };

/** Minimal read seam; defaults to `readFileSync(path, "utf8")`. */
export type ReadFile = (path: string) => string;

/** Minimal fetch seam. Deliberately narrower than the DOM `fetch` so tests can
 *  inject a plain object; the real global `fetch` satisfies it structurally. */
export type FetchUsageResponse = {
	status: number;
	json(): Promise<unknown>;
};
export type FetchUsageImpl = (
	url: string,
	init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchUsageResponse>;

export type ReadOAuthAccessTokenResult =
	| { ok: true; accessToken: string; expiresAtMs?: number }
	| { ok: false; reason: "no-credentials" };

export interface ReadOAuthAccessTokenOptions {
	readFile?: ReadFile | undefined;
}

export interface FetchPlanUsageOptions {
	/** The profile's `CLAUDE_CONFIG_DIR`. */
	configDir: string;
	fetchImpl?: FetchUsageImpl | undefined;
	readFile?: ReadFile | undefined;
	now?: (() => number) | undefined;
	timeoutMs?: number | undefined;
	/** Optional external abort; aborting it fails the fetch (reported as
	 *  `timeout`, since the rotator has no distinct "cancelled" reason). */
	signal?: AbortSignal | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultReadFile(path: string): string {
	return readFileSync(path, "utf8");
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read ONLY `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` from the
 * profile's `.credentials.json`.
 *
 * Missing file, malformed JSON, a missing `claudeAiOauth`, or an empty token all
 * fold into the single `no-credentials` reason: from the caller's point of view
 * there is nothing usable to authenticate with. Refresh-token fields are never
 * read, so they can never leak into a result.
 */
export function readOAuthAccessToken(
	configDir: string,
	options: ReadOAuthAccessTokenOptions = {},
): ReadOAuthAccessTokenResult {
	const readFile = options.readFile ?? defaultReadFile;
	let raw: string;
	try {
		raw = readFile(join(configDir, CREDENTIALS_FILENAME));
	} catch {
		return { ok: false, reason: "no-credentials" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "no-credentials" };
	}
	if (!isRecord(parsed) || !isRecord(parsed.claudeAiOauth)) return { ok: false, reason: "no-credentials" };
	const oauth = parsed.claudeAiOauth;
	const accessToken = nonEmptyString(oauth.accessToken);
	if (accessToken === undefined) return { ok: false, reason: "no-credentials" };
	if (typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)) {
		return { ok: true, accessToken, expiresAtMs: oauth.expiresAt };
	}
	return { ok: true, accessToken };
}

function normalizeUtilization(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.min(100, Math.max(0, value));
}

function normalizeResetsAt(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalize the endpoint body into the four known windows, dropping everything
 * else. Tolerant by construction: unknown keys are ignored, non-record windows
 * are skipped, a non-finite utilization becomes `null`, and an unparseable
 * reset date becomes `null`.
 *
 * Returns `undefined` only when the body is not a plain object (which the caller
 * reports as `malformed`). An object with no recognizable windows is a valid
 * empty snapshot: the endpoint answered, it just reported nothing we track.
 */
export function normalizeUsageResponse(body: unknown, fetchedAtMs: number): UsageSnapshot | undefined {
	if (!isRecord(body)) return undefined;
	const windows: Partial<Record<UsageWindowName, UsageWindow>> = {};
	for (const name of USAGE_WINDOW_NAMES) {
		const raw = body[name];
		if (!isRecord(raw)) continue;
		windows[name] = {
			utilization: normalizeUtilization(raw.utilization),
			resetsAtMs: normalizeResetsAt(raw.resets_at),
		};
	}
	return { fetchedAtMs, windows };
}

/**
 * Fetch one profile's plan usage. NEVER throws: every failure path returns a
 * typed reason. Order of operations is fixed so an expired token costs no
 * network call:
 *
 *   1. read credentials (no token -> `no-credentials`),
 *   2. if a known expiry is already past -> `token-expired` (no fetch),
 *   3. GET with the bearer header under an `AbortController` timeout,
 *   4. 401/403 -> `unauthorized`, other non-2xx -> `http-error` + status,
 *   5. invalid JSON or a non-object body -> `malformed`.
 */
export async function fetchPlanUsage(options: FetchPlanUsageOptions): Promise<UsageFetchResult> {
	const nowMs = options.now?.() ?? Date.now();
	const timeoutMs = options.timeoutMs ?? DEFAULT_USAGE_TIMEOUT_MS;
	const readFile = options.readFile ?? defaultReadFile;
	const globalFetch = (globalThis as { fetch?: unknown }).fetch;
	const fetchImpl = options.fetchImpl
		?? (typeof globalFetch === "function" ? (globalFetch as FetchUsageImpl) : undefined);

	const credentials = readOAuthAccessToken(options.configDir, { readFile });
	if (!credentials.ok) return { ok: false, reason: "no-credentials" };
	if (credentials.expiresAtMs !== undefined && credentials.expiresAtMs <= nowMs) {
		return { ok: false, reason: "token-expired" };
	}
	if (fetchImpl === undefined) return { ok: false, reason: "network" };

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const external = options.signal;
	const onExternalAbort = (): void => {
		controller.abort();
	};
	if (external !== undefined) {
		if (external.aborted) controller.abort();
		else external.addEventListener("abort", onExternalAbort);
	}

	try {
		const response = await fetchImpl(USAGE_ENDPOINT, {
			method: "GET",
			// The ONLY header: verified sufficient against the live endpoint.
			headers: { Authorization: `Bearer ${credentials.accessToken}` },
			signal: controller.signal,
		});
		if (response.status === 401 || response.status === 403) return { ok: false, reason: "unauthorized" };
		if (response.status < 200 || response.status >= 300) {
			return { ok: false, reason: "http-error", httpStatus: response.status };
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			return { ok: false, reason: "malformed" };
		}
		const snapshot = normalizeUsageResponse(body, nowMs);
		if (snapshot === undefined) return { ok: false, reason: "malformed" };
		return { ok: true, snapshot };
	} catch {
		// Any abort (our timer or the caller's signal) reads as a timeout from
		// the caller's perspective; everything else is a transport failure.
		const aborted = timedOut || controller.signal.aborted;
		return { ok: false, reason: aborted ? "timeout" : "network" };
	} finally {
		clearTimeout(timer);
		external?.removeEventListener("abort", onExternalAbort);
	}
}
