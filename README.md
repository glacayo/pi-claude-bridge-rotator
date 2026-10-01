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
| `/claude-accounts` | Same as `status`; shows policy, published state, and per-profile cooldown, invalid flag, and cached identity. |
| `/claude-accounts status` | Status report; also explains a broken config. |
| `/claude-accounts login [profile]` | Interactive wizard: pick or add an account, sign in via the browser, paste the code into a pi dialog, and the command writes the config. `[profile]` logs in that profile; an argument that matches nothing offers to create it. Falls back to printing `CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai` when pi has no dialogs. |
| `/claude-accounts reset [profile]` | Clears cooldowns and invalid flags for the target profile(s); affinity and identity are kept. |
| `/claude-accounts probe [profile]` | Reads account identity from the bridge's account host and refreshes the identity cache. |

`[profile]` accepts a profile id or label; omitting it targets every profile.

## How rotation works

- **Balanced by session**: every new session is routed round-robin over the
  eligible profiles; within a session, requests stick to its profile so Claude
  Code `--resume` keeps working (the bridge needs the exact `configDir`).
- **Cooldowns**: a rate-limited account stops receiving traffic until the
  upstream reset time (or a 30-minute default when the payload carries no
  reset); all traffic goes to the remaining account(s). The bridge's retry loop
  re-asks the router on failures, so cooldowns apply immediately.
- **Invalid accounts**: an auth or billing failure marks the profile invalid —
  it leaves rotation until you re-login and run `/claude-accounts reset`.
- When every account is cooling or invalid, the router throws with the earliest
  reset time, which the bridge surfaces as a clear error.

State lives in `~/.pi/agent/claude-bridge-rotator-state.json` (0600, atomic
writes): cooldowns, invalid set, session affinity (pruned to the last 200
sessions), and a cached identity per profile for display.

## Troubleshooting

- **"no @vanillagreen/pi-claude-bridge account host found"** — the bridge is
  not installed or disabled; the rotator's router is published but nothing
  consumes it.
- **`status` shows a config error** — fix the JSON; the next `/reload`
  republishes. `/claude-accounts login` can also recreate the file.
- **`probe` reports no identity** — the account is not logged in, or the
  bridge's 10s probe deadline hit an empty response; run
  `/claude-accounts login` first.
- **The browser does not open** — copy the URL from the notification into your
  browser, then paste the code into the pi dialog as usual.
- **`claude CLI not found on PATH`** — install Claude Code so the `claude`
  binary is on your `PATH`, then rerun `/claude-accounts login`.
- **Every account unavailable** — wait for the reset time in the error, or
  `reset` after a re-login.
- **Disable routing without uninstalling** — remove or rename the
  configuration file and `/reload`.

## Non-goals (v1)

Model-scoped quota rotation (`route.modelId`), quota-aware probing for
selection, auto-detection of profiles, and multi-policy runtime switching.

## License

[MIT](LICENSE)