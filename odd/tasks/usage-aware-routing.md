# Feature: usage-aware routing

Feature document and design authority for the three-stage follow-up to
`odd/tasks/pi-claude-bridge-rotator.md`. Engram mirror: topic
`odd/usage-aware-routing/tasks` (project `pi-claude-bridge-rotator`).

## Objective

Make the rotator aware of each account's real plan usage: show it in
`/claude-accounts status`, route new sessions with a deterministic usage-aware
balancer, and move sessions between accounts only at moments that minimize
prompt-cache loss.

## Problem and why

- `/claude-accounts status` only shows a cooldown after an account has already
  been rejected. The user cannot see how close each account is to its 5-hour or
  weekly limit.
- Routing is blind round-robin plus affinity. One account can run out on its
  weekly window while the other sits mostly idle, and a session is only moved
  after Claude rejects a request, sometimes mid-response.
- Moving a session to another account always costs a cold prompt-cache rebuild
  on the first turn, because caches are isolated per organization. The router
  should pay that cost rarely and, where possible, only when the cache has
  already expired.

## Verified facts (2026-10-01)

- The bridge sets `process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"`
  at load (`@vanillagreen/pi-claude-bridge` `src/index.ts:1612`). With it,
  Claude Code's `usage_EXPERIMENTAL_…()` returns `rate_limits: null` for every
  account, so the bridge's `recordUsage` never carries plan utilization. This
  source is unusable without modifying the bridge (out of scope).
- `GET https://api.anthropic.com/api/oauth/usage` with only
  `Authorization: Bearer <claudeAiOauth.accessToken>` from
  `<configDir>/.credentials.json` returns `200` in about 0.5 s (verified on
  `claude-1`, with user authorization). No `anthropic-beta` header is needed.
  The body includes `five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet` as `{ utilization: 0-100 | null, resets_at: ISO | null }`,
  plus `extra_usage` and a `limits[]` array. `five_hour.resets_at` is `null`
  while that window has not started.
- Credentials: access token lasts about 8 h; refresh token about 30 days
  (`refreshTokenExpiresAt`). The Claude CLI refreshes the access token when it
  runs under that `CLAUDE_CONFIG_DIR`. The rotator must NEVER refresh or write
  tokens itself: refresh tokens rotate, and racing the CLI could invalidate the
  login.
- Prompt caching (platform.claude.com docs): "Caches are isolated between
  organizations. Different organizations never share caches." Claude Code uses
  the 1-hour TTL (observed `ephemeral_1h_input_tokens` in bridge sessions).
- `acquire()` is synchronous in the bridge contract: routing must read a cached
  usage snapshot; it can never fetch.
- Pi lifecycle: start long-lived resources from `session_start`, release them in
  an idempotent `session_shutdown`; never start timers in the factory. `/reload`
  fires `session_shutdown` (`reason: "reload"`) and re-runs the entry.
- Codebase map (explorer, 2026-10-01): `RotatorState` is whitelist-sanitized
  (unknown fields dropped; new fields need type + `emptyRotatorState` +
  `sanitizeState`). `sessionAffinity` stores no timestamps. The router has no
  policy abstraction (`createRouter` drops `config.policy`). There is no timer,
  `fetch`, or credential read anywhere in `src/` today. Plug-in seams:
  `acquire` affinity block → round-robin loop, `isEligible` hard gate, `issue`
  single route emitter; command side effects are injected (`StartLogin`
  pattern).

## Design decisions

- **Usage source:** the rotator calls `/api/oauth/usage` itself, reading only
  `claudeAiOauth.accessToken` and `expiresAt`. The token is never logged,
  persisted, or included in errors. Each fetch has its own timeout (5 s) and
  abort; failures degrade to a typed reason, never an exception.
- **Expired token:** do not refresh. Ask the bridge account host for one probe
  of that profile with a deadline. The probe runs the official CLI under the
  profile's dir, which is expected to refresh the token as a side effect. Then
  retry the fetch once. Otherwise report `token expired — use this account once`.
  The refresh-by-probe assumption is UNVERIFIED and is checked in task 4.
- **Snapshot:** a normalized, sanitized `usage` section in the state file per
  profile (`windows` + `fetchedAtMs` + last error reason), separate from the
  opaque bridge `identity.usage` blob.
- **Policy:** keep the single `balanced` policy and make it usage-aware when a
  fresh snapshot exists, falling back to today's round-robin when the snapshot
  is missing or stale. No config edit is needed and behavior is never worse than
  today. Thresholds are code constants in v1.
- **Deterministic ranking (new sessions):** hard gate = existing eligibility plus
  a usage cap (5-hour ≥ 95 % or weekly ≥ 98 %). Score from weekly pace headroom
  (expected weekly use for the elapsed window fraction minus actual) plus a
  "use it or lose it" bonus for 5-hour headroom that resets soon. Tie-break by
  profile order. Same inputs always produce the same choice.
- **Cache-aware moves (existing sessions):** affinity stays the default. A bound
  session moves only when (a) its account is ineligible (today's rule), (b) its
  account crosses the hard usage cap (better than a mid-response rejection), or
  (c) it crosses a soft threshold AND the session has been idle ≥ 60 min, so its
  1-hour cache is already cold and the move is free.
- **Background refresh:** one poller per process (handle kept in the shared
  `Symbol.for` command state), started on `session_start`, stopped on
  `session_shutdown`, `unref()`ed, interval 5 min, plus a throttled refresh
  after successful requests (at most once per profile per 60 s). Persistence is
  throttled to avoid write amplification.

## Scope and constraints

- Zero bridge modifications; zero runtime imports of the bridge or pi
  (type-only); no new runtime dependencies (global `fetch`, Node ≥ 22).
- Tests never touch the real `~/.pi/agent`, `~/.claude-rotator`, or the network;
  every fetch, clock, timer, and credential read is injected.
- README must keep the prominent "works only with
  `@vanillagreen/pi-claude-bridge`" notice, and the non-goals section must be
  amended for stages 2–3.
- `odd/**` is never edited by workers.

## Checks

- TDD mode: not configured (inherited from the parent feature; no
  project/session/user TDD config) → ordinary functional checks.
  Runner: `npx vitest run`; typecheck: `npx tsc --noEmit`; CI: GitHub Actions
  (Node 22 and 24).
- RDD: on. After each work-unit commit, run assess against the last reviewed
  boundary and follow its result.

## Delivery

- Forecast: about 1350 authored changed lines (T0 ~20, T1 ~450, T2 ~550,
  T3 ~350). This exceeds the ~400-line budget, so the delivery strategy is
  `ask-on-risk`; the chain strategy is asked once before the first commit.
- Chain strategy: `feature-branch-chain` (user decision, 2026-10-01).
  Integration branch `feat/usage-aware-routing`; each stage gets its own
  branch and PR into it, and one final PR merges the integration branch into
  `main`.
- Slices: PR-A = tasks 0 + docs on the integration branch base (pushed
  directly), PR-1 = task 1 (`feat/usage-status`), PR-2 = task 2
  (`feat/usage-balancer`), PR-3 = task 3 (`feat/usage-cache-switch`), final
  PR = integration → `main`.

## Tasks

- [x] 0. CI hardening: pin `actions/checkout` and `actions/setup-node` to commit
  SHAs and set `persist-credentials: false` (zizmor `unpinned-uses`,
  `artipacked`). Route: inline (one mechanical file).
- [x] 1. Usage in status: new `src/usage.ts` (credential read + fetch + typed
  result + normalizer), `usage` state section, async `status` that fetches all
  profiles in parallel and renders `usage: 5h N% (resets …) · weekly N%
  (resets …)` or the failure reason with last-known age, expired-token probe
  fallback, README. Route: delegated writer (multi-file).
- [x] 2. Usage-aware balancer: reload-safe background poller + post-request
  throttled refresh, router ranking over the snapshot with hard usage cap,
  round-robin fallback, config→router plumbing, README rotation section.
  Route: delegated writer (multi-file).
- [x] 3. Cache-aware switching: per-session last-use timestamps paired with
  affinity pruning, affinity-branch move rules (a/b/c above), README.
  Route: delegated writer (multi-file).
- [ ] 4. Live verification (user + parent): status shows real usage for both
  accounts; new sessions follow the ranking; after an access token expires,
  confirm whether the probe fallback refreshes it.
  Partial (2026-10-02, live): status shows real usage for both accounts (user
  confirmed); two fresh sessions both routed to `claude-1` (5h 18% / weekly 2%
  vs `claude-2` 5h 42% / weekly 25%), proven by new Claude Code JSONL files
  under `~/.claude-rotator/claude-1/projects/`. Token refresh-by-probe still
  pending (claude-1 access token expires 06:16 UTC). The test exposed the
  bug fixed by task 5. After task 5 + `/reload`, a new session's affinity
  (`claude-1`) and its last-use time persisted alongside this session's entry
  (`claude-2`), with no leftover lock file (2026-10-02 02:30 UTC). Remaining:
  token refresh-by-probe, to be checked after the final PR.
- [x] 5. Fix cross-process state clobbering (found in task 4): with several pi
  processes open, each `RotatorStateStore` keeps an in-memory copy and
  rewrites the whole file, so the last writer erases other processes'
  session affinity (both test sessions lost their binding). Fix in
  `src/state.ts`: every `update()` re-reads the file under a short lock file
  and applies the mutator to the fresh disk state; the `state` getter reloads
  when the file changed on disk. Route: delegated writer (multi-file with
  tests). Branch `fix/state-cross-process-writes` → integration branch.
- [x] 6. Bound usage-endpoint traffic across processes (found live after the
  merge to `main`): with 4 pi processes, both accounts got HTTP 429 from
  `/api/oauth/usage` in the same second, because every process runs its own
  poller plus after-request refreshes. Fix: a shared fetch lease in the state
  file (claimed under the existing lock) so at most one process fetches a
  profile per freshness window (~4 min), skip a fetch when the shared
  snapshot is fresh, and a per-profile backoff after 429 honoring
  `Retry-After` (minimum 5 min), also respected by manual `status`. Goal:
  about 1 request per account per window regardless of the number of
  sessions. Route: delegated writer. Branch `fix/usage-fetch-lease` from
  `main` (the integration branch is merged).

## Evidence

| Task | Commit | Checks |
|---|---|---|
| 0 | c1e6654 (+ docs f7e12b2, 182f054; chore 0853144) | SHAs resolved from `git ls-remote` (`v4` = `v4.4.0` for both); zizmor delta clean; tsc clean; vitest 134/134; assess `high` (`shell_source` in `ci.yml`) → independent verifier PASS 6/6; native review folded into the task 1 review (base `217d59d`, so these bytes are reviewed with it); CI run proven on the first stage PR |
| 1 | 59932aa | tsc clean; vitest 197/197 (usage 36, router 49, commands 53, state 14, config 22, login 9, extension 14); live `fetchPlanUsage` against both real accounts OK, no token in output (claude-1 5h 0% / weekly 0%; claude-2 5h 57% / weekly 19%); independent verifier PASS 10/10; native review approved + burned (lineage `review-8c8d05f9622e0472`, range `217d59d..59932aa` incl. task 0, tier high, 4 lenses; readability needed one reoffered retry after a reviewer tool-call transport failure). Advisory: R2-last-known-indent, R2-probe-deadline-name, R3-001, R4-probe-sequential-latency, R4-status-probe-latency (status can take up to ~20 s when a token is expired and the probe runs) |
| 2 | b24d465 | tsc clean; vitest 250/250 (ranking 21, poller 16, router 58, extension 18, commands 56, usage 36, config 22, state 14, login 9); assess `unassessable` (schema-incompatible, treated as high) → independent verifier PASS 9/9 (no blocker/major); native review approved + burned (lineage `review-7c514e8566496832`, range `f498ff3..b24d465`, tier medium, lens `review-reliability`). Includes the fixes for task 1 advisories R4-status-persistent-401-probe (10-min probe backoff) and R3-unauthorized-probe-untested. Advisory: R3-poller-restart-untested, R3-usage-ranking-herd (new sessions all go to the single best account until the next refresh; addressed in task 3). Known benign gap: if the first account is configured mid-session, the poller starts at the next `session_start` (round-robin until then; status still records snapshots) |
| 3 | d80a874 | tsc clean; vitest 284/284 (ranking 38, router 67, state 20, poller 17, extension 19, commands 56, usage 36, config 22, login 9); independent verifier PASS 9/9 (no defects; the hard-cap move to an UNKNOWN alternative was judged an accepted design risk: staying guarantees a rejection, failover still recovers); native review approved + burned (lineage `review-35a54a64ffb5b036`, range `ad430c5..d80a874`, tier medium, lens `review-reliability`; a first START hit an expired consent binding and was simply re-run). Includes the herd fix (R3-usage-ranking-herd: 5-point penalty per new session since the snapshot) and the missing tests R3-poller-restart-untested and R3-request-refresh-wiring-untested (the poller now clears `inFlight` on stop). Advisory: R3-001 `src/router.ts:174` |
| 4 | (pending) | partial live evidence recorded under task 4 |
| 6 | ba4880b | tsc clean; vitest 332/332 (usage 53, state 31, poller 19, usage-lease 13, commands 60, router 68, ranking 38, config 22, login 9, extension 19); real 8-process simultaneous claim on one profile: 1 CLAIMED, 7 skip:lease, no leftover lock; native review approved + burned (lineage `review-070596cf0e9b5bf4`, range `85a9053..ba4880b`, tier medium, lens `review-reliability`). Two pre-existing status tests were updated because status now reuses a fresh shared snapshot instead of always fetching. Advisory: R3-future-snapshot-blocks-fetch `src/usage-lease.ts:62`, R3-poller-lease-release-untested `src/poller.ts:208` |
| 5 | a564782 + a0665cc | tsc clean; vitest 293/293; real 4-process × 40 concurrent writes: old code kept 107/160 affinities, fixed code 160/160, no leftover lock; native review approved + burned for both commits (`review-257872a53cdff9c0` range `80dd4f0..a564782`; `review-7a6372308a19c5b6` range `a564782..a0665cc`, no findings). The second commit fixes the first review's WARNING R3-update-wipes-memory-on-read-failure (a corrupt file made `update` persist an empty state); its regression test fails on `a564782` and passes after. Remaining advisories: R3-stale-lock-break-race, R3-corrupt-file-warn-repeats, R3-legacy-save-still-clobbers, R3-lock-stale-clock-mismatch. Route: delegated writer for a564782, parent inline for a0665cc (one small, understood change). A full-range START from `main` hits `lens_context_budget_exceeded`; every slice is covered by its own approved review instead |

## Progress and next step

- 2026-10-01: branch `feat/usage-aware-routing` created from `main` at
  `217d59d` (PR #1 merged). Exploration done, design recorded.
- Chain strategy chosen (`feature-branch-chain`); task 0 done.
- Review boundary: last reviewed = `59932aa` (tasks 0 + 1 reviewed together).
  Actual task 1 size was ~1350 changed lines incl. tests and docs (forecast
  ~450): the full test list and README were required, nothing was dropped.
- PR #2 (`feat/usage-status`) merged into the integration branch by the parent
  with user authorization (`f498ff3`). The docs-only delta `217d59d..d587e39`
  was also reviewed at the user's request: lineage `review-467ebf8f29503306`,
  approved + burned; advisories R2-001..003, R3-unauthorized-probe-untested,
  R4-probe-sequential-latency, R4-status-persistent-401-probe.
- PR #3 (`feat/usage-balancer`) merged into the integration branch by the
  parent with user authorization (`ad430c5`). The full range
  `217d59d..39c3d7b` was also reviewed at the user's request: lineage
  `review-11c4b10fd7c75f5e`, tier high, 4 lenses, approved + burned (the
  readability lens again needed one reoffered retry after a reviewer tool-call
  transport failure). Advisories: R2-duplicated-default-fetch,
  R2-last-known-indent, R2-ranking-magic-weights, R2-timeout-literal,
  R3-poller-restart-untested and R3-request-refresh-wiring-untested (both fixed
  in task 3), R4-warn-once-never-resets.
- Review boundary: last reviewed = `d80a874`.
- Next: PR-3 `feat/usage-cache-switch` → `feat/usage-aware-routing`; then
  task 4 live verification (user); then the final integration PR to `main`.
