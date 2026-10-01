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

> **Work in progress.** This package is under active development: the router
> core and its configuration/state modules are implemented, while extension
> registration, management commands, and the full documentation are still
> pending. Do not install it for production use yet.
