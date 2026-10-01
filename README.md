# pi-claude-bridge-rotator

A Pi companion extension for `@vanillagreen/pi-claude-bridge` that rotates
multiple Claude Pro subscription accounts. It publishes the bridge's
`ClaudeAccountRouterV1` contract on `globalThis` under
`Symbol.for("kendex.pi.claude-account-router.v1")`, so the bridge can hand each
fresh Claude request to an eligible subscription profile: session affinity keeps
Claude Code `--resume` sessions on their account, a rate-limited account
cools down while traffic moves to another, and accounts that need a re-login are
taken out of rotation until an operator resets them. The bridge itself is never
modified.

## Configuration

The rotator reads `${PI_CODING_AGENT_DIR:-~/.pi/agent}/claude-bridge-rotator.json`:

```json
{
  "policy": "balanced",
  "profiles": [{ "id": "primary", "label": "Primary", "configDir": "~/.claude-primary" }]
}
```

`configDir` is the Claude config dir (`CLAUDE_CONFIG_DIR`) for that account and
is tilde-expanded to an absolute path.

## Commands

All management goes through a single `/claude-accounts` command:

| Command | Effect |
| --- | --- |
| `/claude-accounts` | Same as `status`; shows policy, published state, and per-profile cooldown, invalid flag, and cached identity. |
| `/claude-accounts status` | Status report; also explains a broken config. |
| `/claude-accounts login [profile]` | Prints the `CLAUDE_CONFIG_DIR=<dir> claude login` command(s) to authenticate accounts. |
| `/claude-accounts reset [profile]` | Clears cooldowns and invalid flags for the target profile(s); affinity and identity are kept. |
| `/claude-accounts probe [profile]` | Reads account identity from the bridge's account host and refreshes the identity cache. |

`[profile]` accepts a profile id or label; omitting it targets every profile.

> **Work in progress.** This package is under active development: the router
> core, extension registration, and management commands are implemented, while
> the full documentation is still pending. Do not install it for production use
> yet.
