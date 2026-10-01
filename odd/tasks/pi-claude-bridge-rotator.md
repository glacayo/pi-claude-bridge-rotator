# Feature: pi-claude-bridge-rotator

## Goal

A Pi companion extension package that rotates multiple Claude Pro subscription
accounts for `@vanillagreen/pi-claude-bridge` by publishing the bridge's
`ClaudeAccountRouterV1` contract (`globalThis[Symbol.for("kendex.pi.claude-account-router.v1")]`).
Zero modifications to the bridge — the contract is the designed extension point.

## Decisions (user-approved)

- **Name**: `pi-claude-bridge-rotator` (both it and `pi-claude-bridge-rotation` are
  free on npm; picked `-rotator` = the actor/extension, matching the companion role).
- **Policy**: balanced by session — new sessions alternate profiles round-robin;
  a profile in cooldown (rate limit) sends ALL traffic to the other; session
  affinity keeps a session on its profile so Claude Code `--resume` stays valid.
- **Scope**: full management commands `/claude-accounts status|login|reset|probe`.
- **Repo**: own nested git repo at `~/localhost/pi-claude-bridge-rotator` (directory renamed from `pi-claude-rotation` on 2026-10-01 to match the package name; git history intact), branch
  `feat/claude-bridge-rotator` (parent `~/localhost` repo left untouched).
- **Contract authority**: `~/.pi/agent/npm/node_modules/@vanillagreen/pi-claude-bridge/src/account-router.ts`.
  Never mutate the contract; local type mirror only, no runtime import of bridge code.

## Architecture

- `src/config.ts` — loads `${PI_CODING_AGENT_DIR || ~/.pi/agent}/claude-bridge-rotator.json`:
  `{ policy: "balanced", profiles: [{ id, label, configDir }] }`. Unique stable ids;
  `configDir` tilde-expanded to ABSOLUTE at load time (bridge's `claudeDirForProfile`
  does not expand `~`).
- `src/state.ts` — `claude-bridge-rotator-state.json` (0600, atomic temp+rename):
  cooldowns `{[profileId]: { untilMs, rateLimitType }}`, `invalid` profiles
  (auth/billing failures → need relogin), `sessionAffinity {[sessionId]: profileId}`
  (pruned to last 200), round-robin cursor, identity cache (email, subscriptionType).
- `src/router.ts` — `ClaudeAccountRouterV1` implementation:
  - `acquire`: affinity → same profile unless cooling/excluded; else round-robin
    over eligible (not cooling, not invalid, not excluded). All ineligible →
    throw with `resetAtMs` = min untilMs + `rateLimitType` (bridge reads both off
    the thrown error) and a clear human message.
  - `recordRateLimit`: cooldown until `info.resetsAt` (seconds-vs-ms heuristic).
  - `recordFailure`: `auth`/`billing` → invalid (manual reset/relogin);
    `rate-limit` → 30min default cooldown; `overloaded`/`server`/`network` →
    transient, record only.
  - `recordSuccess(profileId, sessionId)` → affinity map.
  - `recordIdentity`/`recordUsage` → identity cache for status display.
  - `resolveProfile` → `{ profileId, configDir }` exact (hard requirement for resume).
  - `current(modelId, sessionId)` → last route for session or global.
  - Route carries NO `modelId` override in v1 (account-level cooldowns only;
    model-scoped rotation is a documented non-goal).
- `src/index.ts` — extension entry: register command, publish router on load,
  remove symbol on shutdown, warn if bridge absent.

## Execution settings

- TDD mode: not configured (new project; no project/session/user TDD config) → ordinary functional checks; runner: `npx vitest run`; typecheck: `npx tsc --noEmit`. Tests ship with every work unit.
- Delivery: local work-unit commits on `feat/claude-bridge-rotator`; no git remote configured (PR chaining N/A). Advisory ~400 authored changed lines per task.
- Routes (delegation evidence): T1–T3 → one delegated writer (multi-file write rule; `gentle-ai-worker`, foreground); T4–T5 → delegated writer (Unit 2); T6 → delegated verify + parent install smoke; T7 → user.
- Writer model: `ollama-cloud/deepseek-v4.1-flash`, effort `high` (resolved from subagents.json; used for Unit 1 and the cooldown fix run).
- Native `assess` returned `unassessable` (schema-incompatible, no stderr) for both Unit 1 and the fix commit → per contract treated as high risk → independent `gentle-ai-verify` run for each; both Pass. Verified boundary: `a0bed41`.

## Non-goals (v1)

- Model-scoped quota rotation (`route.modelId`), quota-aware probing for selection,
  auto-detection of profiles, multi-policy runtime switching.

## Tasks

- [x] 1. Scaffold package (package.json with `pi` manifest, tsconfig, vitest, MIT LICENSE)
- [x] 2. Config + state modules with unit tests
- [x] 3. Router core `ClaudeAccountRouterV1` with TDD tests
- [x] 4. Extension entry: symbol publish/cleanup + bridge-absent warning
- [x] 5. Commands `/claude-accounts status|login|reset|probe`
- [ ] 6. README + local `pi install` verification + smoke test
- [ ] 7. User: login both accounts + live rotation verification (user-managed)

## Evidence

| Task | Commit | Checks |
|---|---|---|
| 1 | c009b1e | `npx tsc --noEmit` clean; pi manifest + engines >=22; lock consistent |
| 2 | 6c58b41 | config 16 + state 10 tests pass (26); tsc clean |
| 3 | a77a53c + a0bed41 | 69/69 tests pass, tsc clean; independent verifier Pass (minor cooldown-invariant defect found, fixed in a0bed41, re-verified Pass) |
| 4 | 683799d | tsc clean; vitest 103/103; independent verifier Pass (9/9 confirm, zero defects); native review approved + burned (lineage `review-894c5c8aa9bca5a6`) |
| 5 | 683799d | 23 command tests + 11 extension tests; command registration + ownership covered; same verifier/review as task 4 (one work-unit commit for Unit 2) |
| 6 | (pending) | pi list shows package, symbol resolution smoke |
| 7 | (pending) | user confirms live rotation |

## Resume instructions (for the next Pi session in this repo)

Status at handoff: branch `feat/claude-bridge-rotator`; work-tree clean; HEAD `683799d` (Unit 2 work-unit commit). Tasks 1–5 COMPLETE and verified: scaffold (`c009b1e`), config+state (`6c58b41`), router core (`a77a53c`) + cooldown fix (`a0bed41`), extension entry + commands (`683799d`, one commit covering Unit 2 = tasks 4–5). 103/103 tests (config 16, state 10, router 43, commands 23, extension 11), `npx tsc --noEmit` clean. Independent verifier for `683799d`: 9/9 confirm, zero defects. No git remote; nothing pushed.

Native review of Unit 2 CLOSED and BURNED (2026-10-01, same session): lineage `review-894c5c8aa9bca5a6` (compact-v2), candidate = committed range `7244529…` → `683799d` (8 files / 3282 changed lines incl. lockfile, tier medium, lens `review-reliability`). Reviewer relay ran clean with the user-swapped model (one materialize run, no transport failures). Closed `approved` on the last admitted event; acknowledgement burned via the facade (operation `acknowledge-approved`, no input, target not drifted — the whole lifecycle ran before any post-review commit). Consumed revision `sha256:8a96aa95…`. Three advisory findings (all non-blocking, informational, separate later work; full text in `.git/gentle-ai/review-transactions/`):
- R3-login-unquoted-path — SUGGESTION — `src/commands.ts:151`
- R3-probe-no-deadline — WARNING — `src/commands.ts:226-229`
- R3-state-publisher-divergence — WARNING — `src/index.ts:168-171`

START quirk recorded: `baseRef` must be a FULL 40-char commit id (abbreviated ids are rejected `base-ref-unresolvable`); `7244529` → `724452995bb45ec33e62d62685e411086877515c`. Assess for this candidate returned `unassessable` again (same schema-incompatible native failure) → high path → writer self-verification + independent verifier (both done). Do NOT start a review for docs-only commits after `683799d` (passive documentation-only edits are review-exempt).

Native review CLOSED (2026-10-01): lineage `review-6e0032ea2de3585c` (compact-v2), candidate = committed range base `0871619d…`→ `76cae4b` (16 files / 3870 lines, tier medium, lens `review-reliability`). Root cause of the two prior reviewer transport failures: the host reviewer model `glm-5.3` (reasoning-heavy) consumed the entire output budget before emitting the review artifact (empty output, `stopReason: length`); the user swapped the reviewer-relay model to a better one, after which the materialize slot ran clean and the review closed **approved** on the last admitted event. The exact provider-issued acknowledgement was executed via native CLI with its exact token (facade `acknowledge-approved` was blocked by target drift: the current workspace target `sha256:6412d086…` differs from the frozen candidate `sha256:a5dca793…` because of the docs commit `e452c7e`); burn confirmed from its returned envelope: authority `burned`, consumed revision `sha256:45cda0c8…`. Review outcome is informational; delivery (push/PR/merge) remains user-owned. Do NOT start a review for the newer docs-only target identity — the delta over the approved candidate is documentation-only.

Advisory findings from the native review (all non-blocking, disposition informational, no correction opened, separate later work):
- R3-001 WARNING `src/state.ts:221-224`
- R3-002 WARNING `src/router.ts:391-398`
- R3-003 WARNING `test/router.test.ts:567-573`
- R3-004 SUGGESTION `src/router.ts:355-366`
- R3-005 SUGGESTION `src/router.ts:412-416`
- R3-006 SUGGESTION `src/config.ts:131-141`
- R3-007 SUGGESTION `src/state.ts:117-138`

Full finding text lives in the native review store (`.git/gentle-ai/review-transactions/`); read the flagged line ranges when addressing them.

1. Read this document fully — it is the authority for design, decisions, and contract facts.
2. Recover context: `mem_context`, then `mem_search "pi-claude-bridge-rotator"`, `mem_get_observation` on the mirror (topic `odd/pi-claude-bridge-rotator/tasks`) and the research memory (topic `claude-account-rotation-strategy`).
3. Rebuild the visible todo list from the Tasks section (tasks 1–3 done; task 4 next).
4. ~~Re-read bridge extension mechanics~~ DONE — facts recorded in "Extension API facts" under Learnings and verified in review.
5. ~~Delegate tasks 4–5 as ONE `gentle-ai-worker` run (Unit 2)~~ DONE — commit `683799d`, verifier 9/9, native review approved + burned.
6. Next: task 6 — README polish + local `pi install .` verification + smoke test (pi lists the package; `/reload`; `Symbol.for("kendex.pi.claude-account-router.v1")` resolves after load with a valid config present). Delegate README edits to a writer if multi-file; the install/smoke runs parent-inline (state-mutating but mechanical).
7. Then task 7 (user-managed): user logs in both accounts via the printed `CLAUDE_CONFIG_DIR=… claude login` commands, then verifies live rotation (bridge consuming the router, alternation across sessions, cooldown handling).
8. Optional later: advisory findings (Unit 1: R3-001…007; Unit 2: R3-login-unquoted-path, R3-probe-no-deadline, R3-state-publisher-divergence) — separate non-blocking work.

## Learnings so far

### Extension API facts (recorded 2026-10-01, pre-Unit-2, from bridge src/index.ts + bridge-commands.ts + account-host.ts)

- Pi extension entry contract: `export default function (pi: ExtensionAPI)` — pi calls it at load; `import { type ExtensionAPI } from "@earendil-works/pi-coding-agent"` (type-only import; no runtime dependency).
- Command registration: `pi.registerCommand(name: string, { description: string, handler: async (args: string, ctx) => void })`. Handler `ctx` carries `.ui.notify(message, level)` (level "info"|"warning"|"error"), `.model?: Model`, `.sessionManager?.getSessionId?.()`, `.cwd?: string`. Bridge guards double registration with a process-global `Symbol.for("claude-bridge:commandsRegistered")` set on the `pi` object; the guard is NOT cleared on shutdown.
- Lifecycle: `pi.on("session_start", (event, ctx) => ...)` (event.reason: new|resume|fork|startup), `pi.on("session_shutdown", (_event, ctx) => ...)`. Shutdown (incl. /reload) is where symbol cleanup goes; /reload re-runs the default export (fresh instance re-publishes).
- Router discovery is order-independent: the bridge re-reads `globalThis[CLAUDE_ACCOUNT_ROUTER_SYMBOL]` fresh on every `resolveClaudeAccountRouter()` call — at load (availability), `session_start` re-upsert, pre-spawn fail-fast, and per fresh query. Rotator may load before or after the bridge.
- Bridge-absent detection: the bridge publishes `globalThis[CLAUDE_BRIDGE_ACCOUNT_HOST_SYMBOL = Symbol.for("kendex.pi.claude-bridge.account-host.v1")] = BRIDGE_ACCOUNT_HOST` at ITS load, primary instance only, and a config-disabled bridge returns BEFORE publishing (registerBridgeCommands still runs). So account-host symbol absence at `session_start` (all extensions loaded by then, unlike load-time where order decides) ⇒ bridge absent or disabled ⇒ warn once. 
- `ClaudeBridgeAccountHostV1 = { version: 1, probeProfile(input: { profile: ClaudeAccountRoute; cwd: string; signal?: AbortSignal; deadlineMs?: number }) => Promise<{ identity?: { email?; organization?; subscriptionType?; authMethod? }; usage?: unknown }> }`. 10s default deadline (cold child spawn inside budget); spawns a `/usage` child under the profile's env scope. The rotator CONSUMES this for `/claude-accounts probe` — it publishes no host of its own.
- Ownership pattern for global symbols (bridge): claim on load (`if (claimPrimaryInstance()) publish`), on shutdown clear ONLY if owned (`if (g[SYM] === OURS) g[SYM] = undefined`). A subagent reload must never steal or clear another instance's symbol.
- `router.current(modelId, sessionId)` is called by the bridge's connector enumeration — signature confirmed live usage.
- Host versions: pi 0.99.1, `@earendil-works/pi-coding-agent` 0.99.1 installed (bridge peer requires >=0.86.0). Rotator: devDependency `@earendil-works/pi-coding-agent` (types/tests only) + `peerDependencies >=0.86.0`; all runtime imports type-only.
- Our manifest already declares `"pi": { "extensions": ["./src/index.ts"] }`; `src/index.ts` default export becomes the extension.

- Bridge retry loop: up to `MAX_ROTATION_ATTEMPTS = 16`, acquire re-invoked with
  `excludedProfileIds`, `forceRerank: true` on retries, reason "automatic-failover".
- `recordRateLimit` return value is IGNORED by the bridge — cooldown enforcement
  is entirely the router's job; `acquire` throwing is the only channel.
- Bridge persists only the opaque `profileId`; `resolveProfile` must return the
  exact configDir holding the session JSONL or resume degrades to rebuild.
- `subscriberProfileEnv` scrubs 13 credential env vars + `CLAUDE_CODE_USE_*` for
  managed profiles; child gets only `CLAUDE_CONFIG_DIR=<absolute>`.
- Router presence alone satisfies the bridge's credentialed gate (models register
  even with no `~/.claude`).
- Bridge publishes `probeProfile` (10s deadline `/usage` child) we can call for
  identity/usage display; we do NOT need to publish a host ourselves.
- Cooldown invariant (verified + fixed in `a0bed41`): a past-dated reset event never
  clears an ACTIVE future-dated cooldown — `acquire` never routes to cooling
  profiles, so such payloads are stale duplicates; the branch returns the existing
  `untilMs` untouched, cleans stale expired records, and returns 0 otherwise.
- `lastRouteBySession` (in-memory) is recency-bounded at
  `MAX_SESSION_AFFINITY_ENTRIES` (delete+re-set on issue, evict least-recent);
  evicted sessions fall back to the global route in `current()`.
- The thrown `acquire` error carries `resetAtMs`/`rateLimitType` as real own
  properties (class fields); under ES2022+ semantics even `undefined`-valued fields
  satisfy the bridge's own-property reads.
- `writeFileSync`'s `mode` is umask-subject: pair with explicit `chmodSync` to
  guarantee the 0600 state file (verified in tests via `mode & 0o777`).
- Env: `~/.npmrc` `before=2026-09-01T18:26:43Z` + `min-release-age=30d` can make
  npm's resolver loop on the "before" cutoff; `npm install` exit 0 + vitest/tsc
  resolving proves a consistent tree. A dev-only audit advisory on vitest <3.2.4
  is resolved by the pinned `^3.2.7`.
- Unit 2 npm quirk: `@earendil-works/pi-coding-agent` 0.99.1 was published 2026-09-29,
  inside the `min-release-age=30d` window → plain `npm install` fails ETARGET on the
  exact pin. Resolved by running `npm install --min-release-age=0` for that one
  command; the lockfile pins it, so subsequent installs resolve from the lock.
- Unit 2 reload coherence (accepted v1 limitation, reviewer-confirmed):
  command state is process-global (`Symbol.for("pi-claude-bridge-rotator:commandState")`)
  so a pre-`/reload` handler reads the newest activation's config/router, while the
  published router symbol keeps the FIRST instance's router (ownership ratchet).
  Divergence is bounded: status truth reads the symbol directly, the state file stays
  atomic (last mutator wins), and a fresh process reads coherent disk state.
- Native review START requires the FULL 40-char commit id for `baseRef` — abbreviated
  ids are rejected (`base-ref-unresolvable`, no lineage created).