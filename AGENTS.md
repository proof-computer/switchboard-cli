# Agent Instructions

This repository owns the standalone public Switchboard CLI, exported as the
`switchboard` binary. Keep changes focused on CLI source, CLI support modules,
packaging, and tests.

## CLI Development Guidance

Before adding or reshaping command behavior, review Liran Tal's Node.js CLI
Apps Best Practices and the agent-oriented skill:

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

For package-surface changes, run the narrowest relevant checks, usually:

```fish
pnpm typecheck
pnpm test
pnpm build
npm pack --dry-run --json
```
