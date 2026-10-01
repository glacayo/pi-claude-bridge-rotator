// Extension entry point — PLACEHOLDER for Unit 1.
//
// Unit 2 owns real registration: publish the router on `globalThis` under
// `CLAUDE_ACCOUNT_ROUTER_SYMBOL`, register the `/claude-accounts
// status|login|reset|probe` commands, remove the symbol on shutdown, and warn
// when `@vanillagreen/pi-claude-bridge` is absent. Unit 1 ships the config,
// state, and router modules plus the factory below and MUST NOT publish
// anything or register any command yet.

export {
	DEFAULT_POLICY,
	expandHomePath,
	loadConfig,
	piAgentDir,
	RotatorConfigError,
	ROTATOR_CONFIG_FILENAME,
	SUPPORTED_POLICIES,
} from "./config.js";
export type { ConfigLoadOptions, RotatorConfig, RotatorPolicy, RotatorProfileConfig } from "./config.js";

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

import { loadConfig } from "./config.js";
import { ClaudeAccountRouter, createRouter } from "./router.js";

/** Build a router from the real on-disk config. Unit 2 calls this while
 *  registering the extension; nothing is registered or published in Unit 1. */
export function createRotatorFromDisk(): ClaudeAccountRouter {
	return createRouter(loadConfig());
}
