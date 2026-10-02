// Extension entry point: publish the router on `globalThis` under
// `CLAUDE_ACCOUNT_ROUTER_SYMBOL`, register `/claude-accounts status|login|reset|probe`,
// clear the symbol on shutdown, and warn once when the bridge is absent.
//
// The default export is a thin wiring shell over `activateExtension`; every
// piece of real behavior lives in an injectable helper (`RouterPublisher`,
// `createRotatorCommandHandler`, `resolveBridgeAccountHost`) so unit tests run
// with no pi runtime. The Unit 1 surface (`createRotatorFromDisk` and every
// named re-export) stays intact: it is public API.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export {
	DEFAULT_POLICY,
	expandHomePath,
	loadConfig,
	piAgentDir,
	rotatorProfilesBaseDir,
	RotatorConfigError,
	ROTATOR_CONFIG_FILENAME,
	saveConfig,
	slugifyProfileId,
	SUPPORTED_POLICIES,
	uniqueProfileId,
} from "./config.js";
export type {
	ConfigLoadOptions,
	RotatorConfig,
	RotatorPolicy,
	RotatorProfileConfig,
	SaveConfigInput,
	SaveConfigOptions,
} from "./config.js";

export {
	cloneJsonValue,
	MAX_SESSION_AFFINITY_ENTRIES,
	pruneSessionAffinity,
	RotatorStateStore,
	ROTATOR_STATE_FILENAME,
	STATE_VERSION,
	touchSessionAffinity,
} from "./state.js";
export type {
	CooldownRecord,
	JsonValue,
	ProfileFailure,
	ProfileIdentity,
	ProfileUsageError,
	ProfileUsageRecord,
	RotatorState,
	RotatorStateStoreOptions,
} from "./state.js";

export {
	AllProfilesUnavailableError,
	CLAUDE_ACCOUNT_ROUTER_SYMBOL,
	ClaudeAccountRouter,
	createRouter,
	DEFAULT_COOLDOWN_MS,
	MAX_COOLDOWN_MS,
	rateLimitResetFromInfo,
	rateLimitTypeFromInfo,
	resetTimestampMs,
} from "./router.js";
export type {
	ClaudeAccountAcquireInput,
	ClaudeAccountFailureKind,
	ClaudeAccountIdentity,
	ClaudeAccountRoute,
	ClaudeAccountRouterOptions,
	ClaudeAccountRouterV1,
	CreateRouterOptions,
} from "./router.js";

export {
	CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL,
	DEFAULT_GLOBAL_TARGET,
	resolveBridgeAccountHost,
} from "./host.js";
export type { ClaudeBridgeAccountHostV1, GlobalTarget } from "./host.js";

export { createRotatorCommandHandler, STATUS_PROBE_BACKOFF_MS } from "./commands.js";
export type {
	FetchUsage,
	NotifyLevel,
	RotatorCommandContext,
	RotatorCommandHandler,
	RotatorCommandOptions,
	RotatorCommandState,
	RotatorDialogOptions,
	RotatorUIContext,
	StartLogin,
} from "./commands.js";

export {
	FIVE_HOUR_BONUS_WINDOW_MS,
	FIVE_HOUR_HARD_CAP,
	rankProfiles,
	SNAPSHOT_MAX_AGE_MS,
	WEEK_MS,
	WEEKLY_HARD_CAP,
} from "./ranking.js";
export type { RankedProfiles, RankProfilesInput, RankingMode } from "./ranking.js";

export {
	UsagePoller,
	USAGE_POLL_INTERVAL_MS,
	USAGE_REFRESH_THROTTLE_MS,
} from "./poller.js";
export type {
	ClearIntervalFn,
	SetIntervalFn,
	SetTimeoutFn,
	UsagePollerOptions,
	UsagePollerRouter,
	UsagePollerTarget,
} from "./poller.js";

export {
	CREDENTIALS_FILENAME,
	DEFAULT_USAGE_TIMEOUT_MS,
	fetchPlanUsage,
	normalizeUsageResponse,
	readOAuthAccessToken,
	USAGE_ENDPOINT,
	USAGE_FAILURE_REASONS,
	USAGE_WINDOW_NAMES,
} from "./usage.js";
export type {
	FetchPlanUsageOptions,
	FetchUsageImpl,
	FetchUsageResponse,
	ReadFile,
	ReadOAuthAccessTokenOptions,
	ReadOAuthAccessTokenResult,
	UsageFailureReason,
	UsageFetchResult,
	UsageSnapshot,
	UsageWindow,
	UsageWindowName,
} from "./usage.js";

export { DEFAULT_LOGIN_TIMEOUT_MS, startClaudeLogin } from "./login.js";
export type {
	ClaudeLoginHandle,
	LoginStdin,
	LoginStream,
	SpawnedLoginProcess,
	SpawnImpl,
	SpawnLoginOptions,
	StartClaudeLoginOptions,
} from "./login.js";

import { createRotatorCommandHandler } from "./commands.js";
import type { FetchUsage, RotatorCommandState } from "./commands.js";
import { loadConfig } from "./config.js";
import type { RotatorConfig } from "./config.js";
import { DEFAULT_GLOBAL_TARGET, resolveBridgeAccountHost } from "./host.js";
import type { GlobalTarget } from "./host.js";
import { UsagePoller } from "./poller.js";
import type { ClearIntervalFn, SetIntervalFn, SetTimeoutFn } from "./poller.js";
import { CLAUDE_ACCOUNT_ROUTER_SYMBOL, ClaudeAccountRouter, createRouter } from "./router.js";
import type { ClaudeAccountRouterV1 } from "./router.js";
import { fetchPlanUsage } from "./usage.js";

/** Build a router from the real on-disk config. */
export function createRotatorFromDisk(): ClaudeAccountRouter {
	return createRouter(loadConfig());
}

// --- Process-global registration tokens (Symbol.for, set-once) ---

/** Guards double command registration on the `pi` object. Set once and NOT
 *  cleared on shutdown, mirroring the bridge: `/reload` re-runs the default
 *  export but must not register the command twice. */
const COMMANDS_REGISTERED_KEY = Symbol.for("pi-claude-bridge-rotator:commandsRegistered");
/** Shared command state, so a handler registered before `/reload` still reads
 *  the newest config/router filled in by the reloaded instance. */
const COMMAND_STATE_KEY = Symbol.for("pi-claude-bridge-rotator:commandState");
/** Set once per process after the first bridge-absent warning. */
const BRIDGE_ABSENT_WARNED_KEY = Symbol.for("pi-claude-bridge-rotator:bridgeAbsentWarned");

/** Ownership-guarded publisher for the process-global router symbol.
 *
 *  The `owned` flag is per instance, not per symbol: a subagent reload (a
 *  second live activation before the first shuts down) must never overwrite
 *  or clear an instance it does not own. `publish` only claims an empty slot
 *  or this instance's own previous value; `unpublish` clears only when this
 *  instance's value is still the published one, and is idempotent. */
export class RouterPublisher {
	private readonly globalTarget: GlobalTarget;
	private ownedRouter: ClaudeAccountRouterV1 | undefined;

	constructor(globalTarget: GlobalTarget = DEFAULT_GLOBAL_TARGET) {
		this.globalTarget = globalTarget;
	}

	get owned(): boolean {
		return this.ownedRouter !== undefined;
	}

	publish(router: ClaudeAccountRouterV1): boolean {
		const existing = this.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL];
		if (existing !== undefined && existing !== this.ownedRouter) return false;
		this.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = router;
		this.ownedRouter = router;
		return true;
	}

	unpublish(): boolean {
		const owned = this.ownedRouter;
		if (owned === undefined) return false;
		this.ownedRouter = undefined;
		if (this.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] !== owned) return false;
		this.globalTarget[CLAUDE_ACCOUNT_ROUTER_SYMBOL] = undefined;
		return true;
	}
}

export interface RotatorExtensionDeps {
	globalTarget?: GlobalTarget | undefined;
	/** Explicit config path; tests inject a temp file. Wins over `env`. */
	configPath?: string | undefined;
	env?: NodeJS.ProcessEnv | undefined;
	now?: (() => number) | undefined;
	/** Plan-usage fetch seam for the background poller; tests inject a fake. */
	fetchUsage?: FetchUsage | undefined;
	onWarn?: ((message: string) => void) | undefined;
	/** Timer seams for the poller; tests inject fakes so no real timer runs. */
	setIntervalFn?: SetIntervalFn | undefined;
	clearIntervalFn?: ClearIntervalFn | undefined;
	setTimeoutFn?: SetTimeoutFn | undefined;
}

/** Real extension wiring, separated from the default export so tests can inject
 *  the global target, config path, and clock. Safe to call with a broken
 *  config: it registers the command, skips publishing, and records the error
 *  for `/claude-accounts status` instead of throwing. */
export function activateExtension(pi: ExtensionAPI, deps: RotatorExtensionDeps = {}): void {
	const globalTarget = deps.globalTarget ?? DEFAULT_GLOBAL_TARGET;
	const state = commandStateFor(globalTarget);
	const now = deps.now ?? (() => Date.now());

	registerCommandOnce(pi, globalTarget, state, deps);

	// Publish on load only when the config is valid. A config error is exactly
	// when `/claude-accounts status` has to explain what is wrong, so the
	// command registration above happens regardless.
	const publisher = new RouterPublisher(globalTarget);
	// Store the FIRST activation's publisher once: `/reload` re-runs this entry,
	// and only the original owner may republish the process-global symbol.
	if (state.publisher === undefined) state.publisher = publisher;

	// Every router shares one after-request refresh trigger. It reads the poller
	// off the shared state so a reloaded router still points at the live poller
	// (and is a no-op before `session_start` creates it).
	const onRequestSucceeded = (profileId: string): void => {
		state.poller?.requestRefresh(profileId);
	};

	// Refresh hook shared across activations: reload the config from disk,
	// rebuild the router, and republish through the stored owner. This is what
	// makes a wizard-written profile live without `/reload`.
	state.refresh = () => {
		try {
			const config: RotatorConfig = loadConfig({ configPath: deps.configPath, env: deps.env });
			const router = createRouter(config, { env: deps.env, now: deps.now, onRequestSucceeded });
			state.publisher?.publish(router);
			state.config = config;
			state.router = router;
			state.configError = undefined;
		} catch (error) {
			// A failed reload must not unpublish the previous router: keep the
			// symbol as-is and surface the error through the command state.
			state.config = undefined;
			state.router = undefined;
			state.configError = describeError(error);
		}
	};

	try {
		const config: RotatorConfig = loadConfig({ configPath: deps.configPath, env: deps.env });
		const router = createRouter(config, { env: deps.env, now: deps.now, onRequestSucceeded });
		state.config = config;
		state.router = router;
		state.configError = undefined;
		publisher.publish(router);
	} catch (error) {
		state.config = undefined;
		state.router = undefined;
		state.configError = describeError(error);
	}

	pi.on("session_start", (_event, ctx) => {
		// Start (or reuse) the single process-wide poller only once routing is
		// configured and only from `session_start`: never at module/factory load.
		// Idempotent, so a reload re-running the entry cannot create a second one.
		if (state.router !== undefined && state.config !== undefined) ensurePoller(state, deps, now);

		// Only claim to have published if this instance actually owns the symbol.
		if (!publisher.owned) return;
		if (resolveBridgeAccountHost(globalTarget) !== undefined) return;
		if (globalTarget[BRIDGE_ABSENT_WARNED_KEY] === true) return;
		globalTarget[BRIDGE_ABSENT_WARNED_KEY] = true;
		ctx.ui.notify(
			"pi-claude-bridge-rotator: no @vanillagreen/pi-claude-bridge account host found — "
				+ "the router is published but nothing consumes it. Install/enable the bridge "
				+ "or disable the rotator.",
			"warning",
		);
	});

	pi.on("session_shutdown", () => {
		state.poller?.stop();
		publisher.unpublish();
	});
}

export default function (pi: ExtensionAPI, deps: RotatorExtensionDeps = {}): void {
	activateExtension(pi, deps);
}

function registerCommandOnce(
	pi: ExtensionAPI,
	globalTarget: GlobalTarget,
	state: RotatorCommandState,
	deps: RotatorExtensionDeps,
): void {
	// SAFETY: the guard key is a Symbol.for token set only by this module on the
	// `pi` object; any truthy value there means this process already registered.
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[COMMANDS_REGISTERED_KEY] === true) return;
	guard[COMMANDS_REGISTERED_KEY] = true;
	pi.registerCommand("claude-accounts", {
		description: "Manage Claude subscription accounts (status|login|reset|probe)",
		handler: createRotatorCommandHandler({
			state,
			globalTarget,
			now: deps.now,
			configPath: deps.configPath,
			env: deps.env,
		}),
	});
}

function commandStateFor(globalTarget: GlobalTarget): RotatorCommandState {
	// SAFETY: this Symbol.for slot is written only by this module with a plain
	// RotatorCommandState object, so a defined value here is one.
	const existing = globalTarget[COMMAND_STATE_KEY] as RotatorCommandState | undefined;
	if (existing !== undefined) return existing;
	const created: RotatorCommandState = {};
	globalTarget[COMMAND_STATE_KEY] = created;
	return created;
}

/** Start the single shared poller, or reuse the running one. Called only from
 *  `session_start`. The handle lives in the shared command state, so a `/reload`
 *  that re-runs the entry finds `state.poller` running and never creates a
 *  second one. `getTargets` reads the current router/config on every tick. */
function ensurePoller(
	state: RotatorCommandState,
	deps: RotatorExtensionDeps,
	now: () => number,
): UsagePoller {
	const existing = state.poller;
	if (existing !== undefined && existing.isRunning()) return existing;
	const poller = existing ?? new UsagePoller({
		fetchUsage: deps.fetchUsage ?? ((usageOptions) => fetchPlanUsage({
			configDir: usageOptions.configDir,
			signal: usageOptions.signal,
			now,
		})),
		getTargets: () => {
			const router = state.router;
			const config = state.config;
			if (router === undefined || config === undefined) return undefined;
			return { router, profiles: config.profiles };
		},
		now,
		onWarn: deps.onWarn ?? ((message: string) => console.warn(message)),
		setIntervalFn: deps.setIntervalFn,
		clearIntervalFn: deps.clearIntervalFn,
		setTimeoutFn: deps.setTimeoutFn,
	});
	state.poller = poller;
	poller.start();
	return poller;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
