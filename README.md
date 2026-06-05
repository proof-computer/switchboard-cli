# Switchboard CLI Shared Runners

Legacy command-specific shared runners for the native
`proof switchboard ...` CLI.

The standalone `switchboard` command router has been retired. The packaged
`switchboard` bin now prints a migration handoff and no longer dispatches
migrated commands. Use the PROOF umbrella CLI for user-facing Switchboard
commands. New CLI work belongs in `@proof-computer/proof-cli-switchboard`, not
in this legacy non-oclif package.

## Quickstart

```bash
npm install -g @proof-computer/proof-cli
proof plugins install @proof-computer/proof-cli-switchboard
proof switchboard --help
```

```bash
export ACURAST_MAINNET_SEED='<funded acurast mnemonic>'
export ACURAST_MAINNET_ADDRESS='<acurast ss58 address>'
export POLKADOT_SEED='<funded polkadot mnemonic or seed uri>'
export POLKADOT_ADDRESS='<polkadot ss58 address>'
```

```bash
proof switchboard context add mainnet
proof switchboard preflight
```

```bash
mkdir -p switchboard-demo
cd switchboard-demo
proof switchboard init --project switchboard-demo --context mainnet
proof switchboard launch-demo --dry-run
proof switchboard launch-demo --yes-spend
proof switchboard status
```

You need ACU on Acurast mainnet for the demo job, Hub USDC for the Switchboard
quote, and a small Hub native balance for the payment transactions.

Switchboard selects live capacity, creates a temporary project that depends on
`@proofcomputer/switchboard-express-demo`, funds the Hub quote, handles
DNS/TLS/routing, and prints the URL. Demo page/template development lives in
the `switchboard-express-demo` repository; the CLI does not carry a copied
demo renderer.

## Install Details

This legacy installer path is retained only for already-published standalone
release assets and migration diagnostics. New installs should use
`@proof-computer/proof-cli` plus `@proof-computer/proof-cli-switchboard`.

The installer downloads the `switchboard-cli.tgz` package from GitHub Releases,
installs it into `~/.local/share/switchboard`, and writes a `switchboard`
launcher into `~/.local/bin`. If the host does not already have Node 22 or
newer, it installs a private Node runtime under
`~/.local/share/switchboard/node` rather than changing system packages.

Rerun the same command to upgrade an existing install. Each run downloads a
fresh release package, replaces the installed `switchboard-cli` package under
the install home, and rewrites the launcher.

Pin a release with `SWITCHBOARD_CLI_VERSION=v0.1.7`, or override the package
URL directly with `SWITCHBOARD_CLI_PACKAGE_URL`. The control-plane installer
mirror at `https://control.switchboard.proof.computer/install.sh` serves the
same installer after rollout.

The core CLI install does not install native Ledger HID packages. Polkadot
Ledger signing lives under `src/ledger/` and is intended to move to a separate
Ledger extension package/repo. Until then, install its peer dependencies only
on a developer/payment machine that needs Ledger signing.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the standalone migration handoff from source:

```bash
pnpm switchboard --help
```

The PROOF umbrella CLI plugin temporarily calls command-specific shared runners
from this package. It does not fall back to the packaged `switchboard` binary.
Deploy,
launch-demo, validator launch, relay DNS
apply/remove, relay spec backfill, bootstrap, ops, and the read-only/local
diagnostic surfaces are exported as Switchboard runners for native
`proof switchboard ...` oclif commands. Acurast remains an implementation
detail of those Switchboard runners rather than a separate public PROOF command
namespace.

Relay inventory sync is exposed as
`runSwitchboardRelaySync(argv)` and preserves the existing local
`switchboard relay sync` behavior: read signed discovery, write
`relays/catalog.json`, create missing local stub specs, and preserve existing
relay spec files without publishing catalogs, deploying jobs, changing DNS,
submitting transactions, or changing local project/context state. Relay key
generation is exposed as
`runSwitchboardRelayKeygen(argv)` and preserves the existing local
`switchboard relay keygen <relay-id>` behavior, including default private-key
stderr handling and explicit `--unsafe-stdout`. Local relay spec generation is
exposed as `runSwitchboardRelayScaffold(argv)` and preserves the existing
`switchboard relay scaffold <relay-id>` behavior: local `relays/<id>.json`
writes, optional key generation with stderr secret handling, overwrite
refusal without `--force`, Acurast/Compose defaults, and no live publish, DNS,
deploy, chain, relay-state, or context mutation. Relay health transition
watching is exposed as `runSwitchboardRelayWatch(argv)` and preserves the
existing read-only `switchboard relay watch [relay-id]` behavior, including
local relay catalog lookup, endpoint probes, `--interval-ms`, and
`--max-runs`. Local relay catalog artifact builds are exposed as
`runSwitchboardRelayCatalogBuild(argv)` and preserve the existing
`switchboard relay catalog build` behavior: local relay spec discovery,
local catalog-state overlay, signing-key fallback, and output/stdout handling.
Local relay catalog state mutation is exposed as
`runSwitchboardRelayCatalogSetState(argv)` and preserves the existing
`switchboard relay catalog set-state <relay-id> <state>` behavior: local
relay catalog file updates, optional rebuild/signing, and no live relay
publish, DNS, deploy, chain, or context mutation.

Acurast deploy helper paths use `@acurast/sdk` for fee estimates, IPFS upload,
and job environment updates. The CLI no longer shells out to `@acurast/cli`;
third-party update banners or other child-process output should not leak into
Switchboard command output.

Build output is generated into `dist/`, with packaged validator job bundles
under `assets/jobs/`. These generated files are ignored by Git; local installs,
`prepare`, and package dry-runs build them from source. Local Acurast staging
directories such as `dist/acurast/` are ignored and must not be packaged.

## Package Shape

The package includes the compiled CLI, internal runner bundles, generated
validator job bundles, and gateway setup assets used by
`switchboard gateway setup`. GitHub Release installs consume the generated
package tarball. The package `prepare` script builds and verifies the
generated artifacts, and
`npm pack --dry-run --json` is the release-surface check.

## Trust Model

By default the CLI discovers the network through
`https://control.switchboard.proof.computer/v1/network-manifest` and verifies
that manifest against the pinned `PROOF_NETWORK_MANIFEST_SIGNER`. The signed
manifest is the root for the Hub chain ID, active registry address, RPC URLs,
accepted assets, and signed service-catalog references. Expired manifests are
rejected unless `--allow-expired-manifest` is used for diagnostics.

Service catalogs are fetched only through references in the signed manifest.
Each catalog is verified under the `switchboard.service-catalog.v1` signature
domain. Catalog references must name a trusted signer or pin the exact catalog
response body with a `0x`-prefixed SHA-256 `digest`; when both are present,
both are enforced. Catalog freshness limits are enforced before control-plane
URLs or relay endpoints are selected. Bootstrap-host env generation defaults
role catalog `maxStaleSeconds` to 24 hours and accepts
`PROOF_SERVICE_CATALOG_MAX_STALE_SECONDS`,
`PROOF_CONTROL_API_SERVICE_CATALOG_MAX_STALE_SECONDS`, and
`PROOF_RELAY_SERVICE_CATALOG_MAX_STALE_SECONDS` overrides for operator-managed
mainnet hosts.

Funding uses the registry address and chain ID from the verified manifest.
Registry-bound signatures use the deployed `ProofIngress` EIP-712 domain,
chain ID, and registry address; the Hub registry verifies the quote signer
on-chain. The CLI also checks that a quote matches the developer and asset
before spending.

## Fulfillment Cadence

Validators may report route-open evidence every 5 minutes. Hub fulfillment is
not written every 5 minutes; relays roll evidence up into batched settlement
windows. Production scheduler config defaults to a 4-hour minimum window, and
shorter scheduler periods require
`PROOF_FULFILLMENT_SCHEDULER_ALLOW_SHORT_PERIODS=true` for local or staging
tests. Direct fulfillment recording is an operator/admin recovery path, not a
public deploy flag, because it spends relay Hub DOT and requires relay-side
opt-in.

Relay requests use separate trust checks by action: job registration and
certificate requests are signed by the expected job signer, customer-hostname
changes are signed by the session developer, and operator/admin routes require
bearer tokens from local env or ops profile secrets. Override flags such as
`--manifest-url`, `--manifest-signer`, `--registry`, `--relay-url`, and RPC URL
flags change the trust root for that command.

## Secret Handling

This repository should not contain live credentials. Context files store env
var names for secrets, not secret values, and local secrets live outside the
repo under `~/.switchboard/`. Generated package artifacts are limited to the
public CLI bundles and public job bundles. Local Acurast stage output, `.env`
files, `.acurast/` directories, deploy receipts, and runtime keys must stay out
of Git and out of npm package contents.

## Export Note

This repository was extracted from the Switchboard integration monorepo. During
the transition, keep changes here focused on CLI source, CLI support modules,
packaging, and tests.
