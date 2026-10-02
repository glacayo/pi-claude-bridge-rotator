// Plan-usage unit tests. Every credential read, clock, and fetch is injected and
// temp dirs stand in for a profile config dir, so no test touches the real
// `~/.claude-rotator`, reads a real token, or reaches the network.

import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, makeTempDir } from "./helpers.js";
import {
	CREDENTIALS_FILENAME,
	DEFAULT_USAGE_TIMEOUT_MS,
	USAGE_ENDPOINT,
	fetchPlanUsage,
	normalizeUsageResponse,
	parseRetryAfterMs,
	readOAuthAccessToken,
} from "../src/usage.js";
import type { FetchUsageImpl, FetchUsageResponse } from "../src/usage.js";

afterEach(cleanupTempDirs);

const NOW_MS = 1_800_000_000_000;
const FUTURE_MS = NOW_MS + 8 * 60 * 60 * 1000;
const PAST_MS = NOW_MS - 1000;
const TOKEN = "super-secret-access-token";

/** Write `{ claudeAiOauth: oauth }` into a fresh temp config dir. */
function credsDir(oauth: unknown): string {
	const dir = makeTempDir();
	writeFileSync(
		join(dir, CREDENTIALS_FILENAME),
		JSON.stringify({ claudeAiOauth: oauth }),
		"utf8",
	);
	return dir;
}

function okResponse(body: unknown): FetchUsageResponse {
	return { status: 200, json: async () => body };
}

/** A response carrying response headers, for the `Retry-After` tests. */
function headerResponse(
	status: number,
	headers: Record<string, string>,
	body: unknown = {},
): FetchUsageResponse {
	const lowered = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	return {
		status,
		json: async () => body,
		headers: { get: (name) => lowered.get(name.toLowerCase()) ?? null },
	};
}

interface RecordedFetch {
	impl: FetchUsageImpl;
	urls: string[];
	headers: Record<string, string>[];
	calls: number;
}

function recordingFetch(
	response: FetchUsageResponse | (() => Promise<FetchUsageResponse>),
): RecordedFetch {
	const recorded: RecordedFetch = { impl: async () => okResponse({}), urls: [], headers: [], calls: 0 };
	recorded.impl = async (url, init) => {
		recorded.calls += 1;
		recorded.urls.push(url);
		recorded.headers.push(init.headers);
		return typeof response === "function" ? response() : response;
	};
	return recorded;
}

function neverResolvingFetch(): FetchUsageImpl {
	return (_url, init) =>
		new Promise<FetchUsageResponse>((_resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				const error = new Error("aborted");
				error.name = "AbortError";
				reject(error);
			});
		});
}

describe("readOAuthAccessToken", () => {
	it("reads only the access token and its expiry", () => {
		const dir = credsDir({
			accessToken: TOKEN,
			expiresAt: FUTURE_MS,
			refreshToken: "refresh-secret",
			refreshTokenExpiresAt: NOW_MS + 1000,
			subscriptionType: "max",
		});

		const result = readOAuthAccessToken(dir);

		expect(result).toEqual({ ok: true, accessToken: TOKEN, expiresAtMs: FUTURE_MS });
		// The refresh-token material must never appear anywhere in the result.
		expect(JSON.stringify(result)).not.toContain("refresh-secret");
		expect(JSON.stringify(result)).not.toContain("subscriptionType");
	});

	it("omits expiresAtMs when the expiry is missing or not a finite number", () => {
		expect(readOAuthAccessToken(credsDir({ accessToken: TOKEN }))).toEqual({ ok: true, accessToken: TOKEN });
		expect(readOAuthAccessToken(credsDir({ accessToken: TOKEN, expiresAt: "later" })))
			.toEqual({ ok: true, accessToken: TOKEN });
		expect(readOAuthAccessToken(credsDir({ accessToken: TOKEN, expiresAt: Number.NaN })))
			.toEqual({ ok: true, accessToken: TOKEN });
	});

	it("trims surrounding whitespace from the token", () => {
		expect(readOAuthAccessToken(credsDir({ accessToken: `  ${TOKEN}  ` })))
			.toEqual({ ok: true, accessToken: TOKEN });
	});

	it("reports no-credentials for a missing file", () => {
		expect(readOAuthAccessToken(makeTempDir())).toEqual({ ok: false, reason: "no-credentials" });
	});

	it("reports no-credentials for malformed JSON", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, CREDENTIALS_FILENAME), "{ not json", "utf8");
		expect(readOAuthAccessToken(dir)).toEqual({ ok: false, reason: "no-credentials" });
	});

	it.each([
		["a non-object root", []],
		["a missing claudeAiOauth", {}],
		["a non-object claudeAiOauth", { claudeAiOauth: "nope" }],
		["a missing token", { claudeAiOauth: {} }],
		["an empty token", { claudeAiOauth: { accessToken: "   " } }],
		["a non-string token", { claudeAiOauth: { accessToken: 42 } }],
	] as const)("reports no-credentials for %s", (_label, oauth) => {
		expect(readOAuthAccessToken(credsDir(oauth))).toEqual({ ok: false, reason: "no-credentials" });
	});
});

describe("normalizeUsageResponse", () => {
	it("keeps the four known windows and ignores every unknown key", () => {
		const snapshot = normalizeUsageResponse(
			{
				five_hour: { utilization: 12, resets_at: new Date(NOW_MS + 1000).toISOString() },
				seven_day: { utilization: 34, resets_at: new Date(NOW_MS + 2000).toISOString() },
				seven_day_opus: { utilization: 7, resets_at: null },
				seven_day_sonnet: { utilization: 5, resets_at: new Date(NOW_MS + 3000).toISOString() },
				extra_usage: { anything: true },
				limits: [{ window: "five_hour" }],
			},
			NOW_MS,
		);

		expect(snapshot).toEqual({
			fetchedAtMs: NOW_MS,
			windows: {
				five_hour: { utilization: 12, resetsAtMs: NOW_MS + 1000 },
				seven_day: { utilization: 34, resetsAtMs: NOW_MS + 2000 },
				seven_day_opus: { utilization: 7, resetsAtMs: null },
				seven_day_sonnet: { utilization: 5, resetsAtMs: NOW_MS + 3000 },
			},
		});
	});

	it("clamps utilization into 0-100 and nulls non-finite values", () => {
		const snapshot = normalizeUsageResponse(
			{
				five_hour: { utilization: 150 },
				seven_day: { utilization: -5 },
				seven_day_opus: { utilization: "12" },
				seven_day_sonnet: { utilization: Number.POSITIVE_INFINITY },
			},
			NOW_MS,
		);

		expect(snapshot?.windows.five_hour?.utilization).toBe(100);
		expect(snapshot?.windows.seven_day?.utilization).toBe(0);
		expect(snapshot?.windows.seven_day_opus?.utilization).toBeNull();
		expect(snapshot?.windows.seven_day_sonnet?.utilization).toBeNull();
	});

	it("keeps a null utilization as null and an invalid reset date as null", () => {
		const snapshot = normalizeUsageResponse(
			{ five_hour: { utilization: null, resets_at: "not a date" } },
			NOW_MS,
		);

		expect(snapshot?.windows.five_hour).toEqual({ utilization: null, resetsAtMs: null });
	});

	it("keeps a five-hour window whose resets_at is null (window not started)", () => {
		const snapshot = normalizeUsageResponse({ five_hour: { utilization: 0, resets_at: null } }, NOW_MS);
		expect(snapshot?.windows.five_hour).toEqual({ utilization: 0, resetsAtMs: null });
	});

	it("skips null, non-object, and array window values", () => {
		const snapshot = normalizeUsageResponse(
			{ five_hour: null, seven_day: 5, seven_day_opus: [], seven_day_sonnet: { utilization: 1 } },
			NOW_MS,
		);

		expect(snapshot?.windows).toEqual({ seven_day_sonnet: { utilization: 1, resetsAtMs: null } });
	});

	it("treats an object with no recognizable windows as a valid empty snapshot", () => {
		expect(normalizeUsageResponse({}, NOW_MS)).toEqual({ fetchedAtMs: NOW_MS, windows: {} });
		expect(normalizeUsageResponse({ extra_usage: 1 }, NOW_MS)).toEqual({ fetchedAtMs: NOW_MS, windows: {} });
	});

	it.each([null, undefined, "body", 5, true, []])("returns undefined for a non-object body: %p", (body) => {
		expect(normalizeUsageResponse(body, NOW_MS)).toBeUndefined();
	});
});

describe("parseRetryAfterMs", () => {
	it("parses delta-seconds", () => {
		expect(parseRetryAfterMs("120", NOW_MS)).toBe(120_000);
		expect(parseRetryAfterMs("0", NOW_MS)).toBe(0);
		expect(parseRetryAfterMs("  45  ", NOW_MS)).toBe(45_000);
	});

	it("parses an HTTP-date relative to now and clamps the past to zero", () => {
		expect(parseRetryAfterMs(new Date(NOW_MS + 30_000).toUTCString(), NOW_MS)).toBe(30_000);
		expect(parseRetryAfterMs(new Date(NOW_MS - 30_000).toUTCString(), NOW_MS)).toBe(0);
	});

	it.each([undefined, null, "", "  ", "not-a-date", "-5", "1.5"]) (
		"returns undefined for %p",
		(value) => {
			expect(parseRetryAfterMs(value, NOW_MS)).toBeUndefined();
		},
	);
});

describe("fetchPlanUsage", () => {
	it("GETs the usage endpoint with only the bearer header and returns a snapshot", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(okResponse({ five_hour: { utilization: 12, resets_at: null } }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({
			ok: true,
			snapshot: { fetchedAtMs: NOW_MS, windows: { five_hour: { utilization: 12, resetsAtMs: null } } },
		});
		expect(fetch.urls).toEqual([USAGE_ENDPOINT]);
		expect(fetch.headers).toEqual([{ Authorization: `Bearer ${TOKEN}` }]);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("returns token-expired without any network call when the token is already past", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: PAST_MS });
		const fetch = recordingFetch(okResponse({}));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "token-expired" });
		expect(fetch.calls).toBe(0);
	});

	it("returns no-credentials without any network call when the file is missing", async () => {
		const fetch = recordingFetch(okResponse({}));

		const result = await fetchPlanUsage({ configDir: makeTempDir(), fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "no-credentials" });
		expect(fetch.calls).toBe(0);
	});

	it.each([401, 403])("reports HTTP %i as unauthorized", async (status) => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch({ status, json: async () => ({}) });

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "unauthorized" });
	});

	it("reports another non-2xx status as http-error with the status attached", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch({ status: 503, json: async () => ({}) });

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 503 });
	});

	it("captures Retry-After delta-seconds on an HTTP 429", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(headerResponse(429, { "Retry-After": "120" }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 429, retryAfterMs: 120_000 });
	});

	it("captures an HTTP-date Retry-After as a delay from now", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(headerResponse(429, { "Retry-After": new Date(NOW_MS + 30_000).toUTCString() }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 429, retryAfterMs: 30_000 });
	});

	it("clamps an HTTP-date Retry-After in the past to zero", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(headerResponse(429, { "Retry-After": new Date(NOW_MS - 30_000).toUTCString() }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 429, retryAfterMs: 0 });
	});

	it.each([
		["absent", undefined],
		["empty", ""],
		["non-numeric", "not-a-date"],
		["negative", "-5"],
	] as const)("omits retryAfterMs for a %s Retry-After", async (_label, header) => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(headerResponse(429, header === undefined ? {} : { "Retry-After": header }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 429 });
	});

	it("ignores Retry-After on a non-429 status", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(headerResponse(503, { "Retry-After": "120" }));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "http-error", httpStatus: 503 });
	});

	it("reports invalid JSON as malformed", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch({
			status: 200,
			json: async () => {
				throw new SyntaxError("bad json");
			},
		});

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "malformed" });
	});

	it("reports a non-object body as malformed", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(okResponse([1, 2, 3]));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "malformed" });
	});

	it("reports a rejection as a network error", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const fetch = recordingFetch(() => Promise.reject(new Error("connection reset")));

		const result = await fetchPlanUsage({ configDir: dir, fetchImpl: fetch.impl, now: () => NOW_MS });

		expect(result).toEqual({ ok: false, reason: "network" });
	});

	it("aborts a hung request at the timeout and reports timeout", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });

		const result = await fetchPlanUsage({
			configDir: dir,
			fetchImpl: neverResolvingFetch(),
			now: () => NOW_MS,
			timeoutMs: 5,
		});

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	it("honors an external abort signal", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const controller = new AbortController();

		const pending = fetchPlanUsage({
			configDir: dir,
			fetchImpl: neverResolvingFetch(),
			now: () => NOW_MS,
			timeoutMs: 10_000,
			signal: controller.signal,
		});
		controller.abort();

		expect(await pending).toEqual({ ok: false, reason: "timeout" });
	});

	it("never leaks the access token into any failure result", async () => {
		const dir = credsDir({ accessToken: TOKEN, expiresAt: FUTURE_MS });
		const failures = await Promise.all([
			fetchPlanUsage({ configDir: dir, fetchImpl: recordingFetch({ status: 401, json: async () => ({}) }).impl, now: () => NOW_MS }),
			fetchPlanUsage({ configDir: dir, fetchImpl: recordingFetch({ status: 500, json: async () => ({}) }).impl, now: () => NOW_MS }),
			fetchPlanUsage({ configDir: dir, fetchImpl: recordingFetch(() => Promise.reject(new Error(TOKEN))).impl, now: () => NOW_MS }),
		]);
		for (const result of failures) {
			expect(JSON.stringify(result)).not.toContain(TOKEN);
		}
	});

	it("uses a 5 second default timeout", () => {
		expect(DEFAULT_USAGE_TIMEOUT_MS).toBe(5000);
	});
});
