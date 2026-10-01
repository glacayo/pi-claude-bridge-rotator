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
- [ ] 4. Extension entry: symbol publish/cleanup + bridge-absent warning
- [ ] 5. Commands `/claude-accounts status|login|reset|probe`
- [ ] 6. README + local `pi install` verification + smoke test
- [ ] 7. User: login both accounts + live rotation verification (user-managed)

## Evidence

| Task | Commit | Checks |
|---|---|---|
| 1 | c009b1e | `npx tsc --noEmit` clean; pi manifest + engines >=22; lock consistent |
| 2 | 6c58b41 | config 16 + state 10 tests pass (26); tsc clean |
| 3 | a77a53c + a0bed41 | 69/69 tests pass, tsc clean; independent verifier Pass (minor cooldown-invariant defect found, fixed in a0bed41, re-verified Pass) |
| 4 | (pending) | vitest pass, manual load check |
| 5 | (pending) | vitest pass, command registration check |
| 6 | (pending) | pi list shows package, symbol resolution smoke |
| 7 | (pending) | user confirms live rotation |

## Resume instructions (for the next Pi session in this repo)

Status at handoff: branch `feat/claude-bridge-rotator`; work-tree clean; HEAD `a0bed41`. Tasks 1–3 COMPLETE and verified: scaffold (`c009b1e`), config+state (`6c58b41`), router core (`a77a53c`) + cooldown-invariant fix (`a0bed41`). 69/69 tests, `npx tsc --noEmit` clean. Two independent verifier runs: Pass (initial minor finding fixed in `a0bed41`, re-verified Pass). Native assess was `unassessable` both times → high path → verifier (both Pass). No git remote; nothing pushed.

1. Read this document fully — it is the authority for design, decisions, and contract facts.
2. Recover context: `mem_context`, then `mem_search "pi-claude-bridge-rotator"`, `mem_get_observation` on the mirror (topic `odd/pi-claude-bridge-rotator/tasks`) and the research memory (topic `claude-account-rotation-strategy`).
3. Rebuild the visible todo list from the Tasks section (tasks 1–3 done; task 4 next).
4. BEFORE delegating tasks 4–5, re-read the bridge extension mechanics: how `@vanillagreen/pi-claude-bridge` discovers the router symbol at runtime, its load/shutdown hooks, `probeProfile` usage, and the Pi extension API for command registration (`ctx.registerCommand` style; check bridge `src/index.ts` and the installed `@earendil-works/pi-coding-agent` extension types). Record exact API facts in this doc before writing the worker prompt.
5. Delegate tasks 4–5 as ONE `gentle-ai-worker` run (Unit 2), foreground `mode: task`, writer model `ollama-cloud/deepseek-v4.1-flash` effort `high`. Allowed edit surfaces: `package.json`, `package-lock.json`, `README.md`, `src/**`, `test/**` (tsconfig/vitest/LICENSE/.gitignore exist; unit 2 needs the `@earendil-works/pi-coding-agent` devDep). Worker does NOT commit.
6. Worker verification: `npx tsc --noEmit`, `npx vitest run` (node_modules already installed).
7. After the writer returns: review evidence, make work-unit commits (conventional messages), then `gentle_review` assess per RDD with writer profile `ollama-cloud/deepseek-v4.1-flash`, effort `high`, baseRef `a0bed41`. If assess is `unassessable` again, run an independent `gentle-ai-verify` (read-only, authorized commands: tsc + vitest + scoped review points) as the high-risk path.
8. Then task 6 (README + `pi install .` verification + smoke); task 7 is the user's live login of both accounts + rotation check.
9. Contract facts for the worker prompt are in Architecture + Learnings above; the bridge authority file is read-only reference, never imported at runtime.

## Learnings so far

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