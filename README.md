# pi-claude-bridge-rotator

> **This package works only with
> [`@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge).**
> It is a companion extension for that bridge, not a standalone tool. It
> implements the bridge's account-router contract, and the bridge is the only
> consumer of the routes it hands out. Without the bridge installed, the rotator
> loads and reports status, but no request ever routes through it. It does not
> work with any other Claude or pi provider. Developed and verified against
> bridge `4.0.6`.

A Pi companion extension for `@vanillagreen/pi-claude-bridge` that rotates
multiple Claude subscription accounts (Pro, Max, or Team). It publishes the bridge's
`ClaudeAccountRouterV1` contract on `globalThis` under
`Symbol.for("kendex.pi.claude-account-router.v1")`, so the bridge can hand each
fresh Claude request to an eligible subscription profile: session affinity keeps
Claude Code `--resume` sessions on their account, a rate-limited account
cools down while traffic moves to another, and accounts that need a re-login are
taken out of rotation until an operator resets them. The bridge itself is never
modified.

## Requirements

- [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) with
  extension support (peer `>=0.86.0`; developed and verified against `0.99.1`).
- [`@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/kendex/tree/main/pi-extensions/pi-claude-bridge)
  (**required**; verified against `4.0.6`) — the only consumer of the router.
  Install and configure the bridge first. Without it the rotator loads and
  reports status, but nothing routes through it.

## Install

```sh
pi install git:github.com/glacayo/pi-claude-bridge-rotator   # from GitHub
pi install pi-claude-bridge-rotator   # once published to npm
pi install /path/to/pi-claude-bridge-rotator   # local checkout
```

Then `/reload` (or start a new pi session). The extension publishes its router
at load when a valid configuration exists; with no configuration it stays
dormant and `/claude-accounts status` explains what is missing.

## Set up accounts

Run `/claude-accounts login` inside pi. The wizard does the whole setup: it
asks for an account label, creates `~/.claude-rotator/<id>` as that account's
Claude config dir, opens your browser to the Claude sign-in page, and gives you
a pi dialog to paste the code back into. The command writes the configuration
file itself, so nothing is hand-edited and no second terminal is needed.

```text
/claude-accounts login
  Account label: Personal
  → Opening browser to sign in…  https://claude.ai/oauth/authorize?…
  Paste the login code:  <code shown in the browser>
  Add another account?  Yes
  ...
```

Repeat for each subscription. Config mutations republish the router
immediately, so a freshly added account is live without `/reload`.

In non-interactive modes (JSON/print) pi exposes no dialogs; the command then
prints the exact per-profile command to run yourself:

```sh
CLAUDE_CONFIG_DIR=/home/you/.claude-rotator/personal claude auth login --claudeai
```

### Advanced: hand-edited config

The rotator reads `${PI_CODING_AGENT_DIR:-~/.pi/agent}/claude-bridge-rotator.json`:

```json
{
	"policy": "balanced",
	"profiles": [
		{ "id": "primary", "label": "Primary", "configDir": "~/.claude-primary" },
		{ "id": "secondary", "label": "Secondary", "configDir": "~/.claude-secondary" }
	]
}
```

- `id` — stable unique identifier (persisted by the bridge across sessions;
  keep it stable or affinity is lost).
- `label` — display name.
- `configDir` — the Claude config dir (`CLAUDE_CONFIG_DIR`) for that account,
  tilde-expanded to an absolute path at load time.

`/claude-accounts login` writes this file for you; hand-editing remains
supported for advanced setups but is never required.

## Commands

All management goes through a single `/claude-accounts` command:

| Command | Effect |
| --- | --- |
| `/claude-accounts` | Same as `status`; shows policy, published state, and per-profile cooldown, plan usage, invalid flag, and cached identity. |
| `/claude-accounts status` | Status report; polls each account's plan usage and also explains a broken config. |
| `/claude-accounts login [profile]` | Interactive wizard: pick or add an account, sign in via the browser, paste the code into a pi dialog, and the command writes the config. `[profile]` logs in that profile; an argument that matches nothing offers to create it. Falls back to printing `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai` when pi has no dialogs. |
| `/claude-accounts reset [profile]` | Clears cooldowns and invalid flags for the target profile(s); affinity and identity are kept. |
| `/claude-accounts probe [profile]` | Reads account identity from the bridge's account host and polls plan usage. |

`[profile]` accepts a profile id or label; omitting it targets every profile.

### Plan usage in `status`

`status` polls each account's real subscription usage and prints a `usage:` line
right below its cooldown:

```text
• Personal (personal)
  configDir: /home/you/.claude-rotator/personal
  cooldown: ok
  usage: 5h 12% (resets in 2h10m) · weekly 34% (resets in 3d4h)
```

- `5h` is the rolling 5-hour window, `weekly` the 7-day window. `opus` and
  `sonnet` are appended only when the account reports those model-scoped
  windows. A value the endpoint does not report renders as `n/a`; a 5-hour
  window that has not opened yet renders as `5h 0% (window not started)`.
- Every profile is polled in parallel with a 5-second timeout, so `status`
  stays a single round trip even with several accounts.
- Usage is fetched at most about once per account every 4 minutes across all pi
  processes: a successful poll is reused by every process for that window, and
  only one process may fetch a given account at a time. If the usage endpoint
  answers HTTP 429, fetching pauses for that account (honoring `Retry-After`, at
  least 5 minutes) while the last known snapshot keeps being used.
- When a poll fails, the line reads `usage: unavailable — <reason>` and, if a
  previous snapshot exists, a second `last known <age> ago: …` line shows how
  fresh that data is.

All requests are read-only and go straight from the rotator to
`https://api.anthropic.com/api/oauth/usage`. The rotator reads only
`claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt` out of the profile's
`.credentials.json`; the token is never logged, persisted, or included in an
error. **The rotator never refreshes, writes, or rotates tokens** — refresh
tokens rotate, and racing the official CLI could invalidate a login. An expired
access token is refreshed by the Claude CLI the next time that account is used;
if `status` finds an expired or unauthorized token it gives the CLI one bounded
probe (15 s) to refresh, then polls once more.

## How rotation works

- **Usage-aware ranking for new sessions**: the router ranks the eligible
  profiles from their cached plan-usage snapshot and sends a new session to the
  best one. The score rewards *weekly headroom* (the expected use for how far
  the 7-day window has elapsed, minus actual use) plus a small "use it or lose
  it" bonus for 5-hour headroom that resets within the hour, and subtracts a
  penalty for current 5-hour use. Hard caps — 5-hour utilization ≥ 95 % or
  weekly utilization ≥ 98 % — move an account to the back of the order as a
  last resort. Accounts with no snapshot, or one older than 15 minutes, are
  treated as unknown and placed between the healthy and the capped ones. Ties
  keep the configured profile order, so the choice is fully deterministic:
  the same inputs always produce the same route.
- **Per-session spread between refreshes**: ranking alone would send every new
  session to the same best account until the next snapshot. Each new
  (non-affinity) session routed to a profile adds a small in-memory score
  penalty to that profile, so new sessions spread across the healthy accounts.
  The count resets as soon as a newer snapshot arrives, never applies in
  round-robin mode, and never overrides the hard caps.
- **Round-robin fallback**: until the first snapshot arrives (or when every
  snapshot is stale), ranking degrades to the cursor round-robin over the
  eligible profiles, so rotation is never worse than it was before.
- **Background refresh**: one poller per process refreshes every account's usage
  every 5 minutes, plus once more after a successful request (at most once per
  account per minute). Routing itself reads only the cached snapshot: `acquire`
  is synchronous and never fetches, so a slow endpoint can never stall a turn.
  Processes coordinate through the shared state file, so the poller and `status`
  together issue at most about one usage request per account every 4 minutes
  across every open pi window, and a 429 pauses that account for at least 5
  minutes.
- **Cache-aware session affinity**: a session normally stays on its account so
  Claude Code `--resume` keeps working (the bridge needs the exact `configDir`).
  Because prompt caches are isolated per organization and Claude Code uses a
  1-hour cache TTL, moving a session always costs one cold cache rebuild, so the
  router moves it only when the move is worth that cost: when the bound account
  is ineligible (cooling down, invalid, or excluded); when it is at a hard cap
  (5-hour ≥ 95 % or weekly ≥ 98 %) and another eligible account is not; or when
  it is over a soft threshold (5-hour ≥ 85 % or weekly ≥ 90 %) **and** the
  session has been idle for at least 1 hour, so its cache is already cold. An
  unknown last-use time counts as still warm, so the session stays. A move
  behaves like a normal ranked pick and rebinds the session; staying does not
  disturb the round-robin cursor.
- **Cooldowns**: a rate-limited account stops receiving traffic until the
  upstream reset time (or a 30-minute default when the payload carries no
  reset); all traffic goes to the remaining account(s). The bridge's retry loop
  re-asks the router on failures, so cooldowns apply immediately.
- **Invalid accounts**: an auth or billing failure marks the profile invalid —
  it leaves rotation until you re-login and run `/claude-accounts reset`.
- When every account is cooling or invalid, the router throws with the earliest
  reset time, which the bridge surfaces as a clear error.

State lives in `~/.pi/agent/claude-bridge-rotator-state.json` (0600, atomic
writes): cooldowns, invalid set, session affinity and its paired last-use
timestamps (pruned together to the last 200 sessions), a cached identity per
profile, and a normalized plan-usage snapshot (plus the last failure reason)
per profile.

## Troubleshooting

- **"no @vanillagreen/pi-claude-bridge account host found"** — the bridge is
  not installed or disabled; the rotator's router is published but nothing
  consumes it.
- **`status` shows a config error** — fix the JSON; the next `/reload`
  republishes. `/claude-accounts login` can also recreate the file.
- **`probe` reports no identity** — the account is not logged in, or the
  bridge's probe deadline hit an empty response; run
  `/claude-accounts login` first.
- **`usage: unavailable — no credentials — run /claude-accounts login <id>`** —
  there is no readable `.credentials.json` under that profile's config dir.
  Log that account in.
- **`usage: unavailable — access token expired …`** — the access token's
  recorded expiry has passed. Use the account once from Claude Code (or run
  `/claude-accounts probe <id>`) so the official CLI refreshes it, then run
  `status` again. The rotator deliberately never refreshes it itself.
- **`usage: unavailable — unauthorized …`** — the endpoint rejected the token
  (HTTP 401/403). If it persists after the account is used again, run
  `/claude-accounts login <id>`.
- **`usage: unavailable — usage endpoint returned HTTP <n>`** — the usage
  endpoint answered with an unexpected status; retry, and check Anthropic
  status if it keeps failing.
- **`usage: unavailable — usage endpoint rate limited, retrying in <duration>`**
  — the usage endpoint answered HTTP 429 for that account, so fetching is paused
  for the shown time (at least 5 minutes, following `Retry-After`) and the last
  known snapshot keeps being shown. No action is needed; it resumes on its own.
- **`usage: unavailable — network error`** — the request could not reach the
  endpoint. Check connectivity.
- **`usage: unavailable — timed out after 5s`** — the endpoint did not answer
  within the 5-second budget. Retry.
- **`usage: unavailable — unexpected usage response`** — the response was not
  JSON or had an unexpected shape. Usually transient.
- **The browser does not open** — copy the URL from the notification into your
  browser, then paste the code into the pi dialog as usual.
- **`claude CLI not found on PATH`** — install Claude Code so the `claude`
  binary is on your `PATH`, then rerun `/claude-accounts login`.
- **Every account unavailable** — wait for the reset time in the error, or
  `reset` after a re-login.
- **Disable routing without uninstalling** — remove or rename the
  configuration file and `/reload`.

## Non-goals (v1)

Model-scoped quota rotation (`route.modelId`), auto-detection of profiles, and
multi-policy runtime switching.

## License

[MIT](LICENSE)