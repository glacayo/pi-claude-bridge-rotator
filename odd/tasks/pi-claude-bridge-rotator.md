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
- **Repo**: own nested git repo at `~/localhost/pi-claude-rotation`, branch
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
- Writer model: resolved by pi-subagents from config (see subagents.json).

## Non-goals (v1)

- Model-scoped quota rotation (`route.modelId`), quota-aware probing for selection,
  auto-detection of profiles, multi-policy runtime switching.

## Tasks

- [ ] 1. Scaffold package (package.json with `pi` manifest, tsconfig, vitest, MIT LICENSE)
- [ ] 2. Config + state modules with unit tests
- [ ] 3. Router core `ClaudeAccountRouterV1` with TDD tests
- [ ] 4. Extension entry: symbol publish/cleanup + bridge-absent warning
- [ ] 5. Commands `/claude-accounts status|login|reset|probe`
- [ ] 6. README + local `pi install` verification + smoke test
- [ ] 7. User: login both accounts + live rotation verification (user-managed)

## Evidence

| Task | Commit | Checks |
|---|---|---|
| 1 | (pending) | tsc --noEmit + vitest pass |
| 2 | (pending) | config/state unit tests pass |
| 3 | (pending) | router TDD tests pass, contract shape test |
| 4 | (pending) | vitest pass, manual load check |
| 5 | (pending) | vitest pass, command registration check |
| 6 | (pending) | pi list shows package, symbol resolution smoke |
| 7 | (pending) | user confirms live rotation |

## Resume instructions (for the next Pi session in this repo)

Status at handoff: branch `feat/claude-bridge-rotator`; `main` holds only the `.gitignore` init commit (71b51ee). No source code written yet. Tasks 1–3 writer delegation was fully prepared but NOT launched — the previous session was bound to the parent `~/localhost` clone (started before this repo had its own `.git`), and session worktree tooling rejected this independent repo. A fresh session started in this repo binds correctly and needs no `repository_root` consent.

1. Read this document fully — it is the authority for design, decisions, and contract facts.
2. Recover context: `mem_context`, then `mem_search "pi-claude-bridge-rotator"`, `mem_get_observation` on the mirror (topic `odd/pi-claude-bridge-rotator/tasks`) and the research memory (topic `claude-account-rotation-strategy`).
3. Rebuild the visible todo list from the Tasks section (tasks 1–7; task 1 in_progress).
4. Delegate tasks 1–3 as ONE `gentle-ai-worker` run (multi-file write rule), foreground `mode: task`. Allowed edit surfaces (exact block, prose goes OUTSIDE the section): `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `README.md`, `.gitignore`, `src/**`, `test/**`.
5. Worker verification: `npm install`, `npx tsc --noEmit`, `npx vitest run` (TDD off → tests ship with the unit).
6. After the writer returns: review evidence, make work-unit commits (conventional messages), then `gentle_review` assess per RDD with writer profile `ollama-cloud/deepseek-v4.1-flash`, effort `high`.
7. Then tasks 4–5 (entry + commands) as a second writer unit; task 6 (README + `pi install .` verification + smoke); task 7 is the user's live login of both accounts + rotation check.
8. Contract facts for the worker prompt are in Architecture + Learnings above; the bridge authority file is read-only reference, never imported at runtime.

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