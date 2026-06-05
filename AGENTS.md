# Agent Instructions

This repository is now a legacy/decommissioning Switchboard shared-runner
package. It no longer owns user-facing CLI behavior. All new or changed
Switchboard command behavior for users belongs in the oclif plugin at
`../proof-cli-switchboard` and the root `proof` CLI/plugin ecosystem.

Do not restore or extend the standalone `switchboard` command router. The
packaged `switchboard` bin is a migration handoff only. This package may keep
temporary command-specific runner exports while implementation code is moved
into oclif plugin/shared-library code, but it should shrink over time rather
than gain new command surface.

## CLI Development Guidance

Before changing shared-runner behavior that is still called by
`proof switchboard ...`, review Liran Tal's Node.js CLI Apps Best Practices and
the agent-oriented skill:

- https://github.com/lirantal/nodejs-cli-apps-best-practices
- https://github.com/lirantal/nodejs-cli-apps-best-practices/tree/main/skills/nodejs-cli-best-practices

Apply the checklist where it fits: POSIX flags, zero-config defaults,
configuration precedence, STDIN/STDOUT and `--json` behavior, graceful color
degradation, actionable errors, debug mode, exit codes, `--version`, package
`files`, strict opt-in analytics, and argument-injection safety.

Switchboard-specific trust and packaging rules still take priority: no live
credentials in the repo, no local Acurast staging output in npm packages,
signed manifest/catalog verification stays explicit, and package changes must
be checked against the generated tarball surface.

## Verification

For remaining shared-runner or package-surface changes, run the narrowest
relevant checks, usually:

```fish
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run --json
```

For user-facing command changes, make the change in
`../proof-cli-switchboard` and verify that plugin package instead.
