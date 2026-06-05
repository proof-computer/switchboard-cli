# Switchboard CLI Shared Runner Reference

Status: shared runner reference
Last reviewed: 2026-06-05

Developer-facing Switchboard commands are now native `proof switchboard ...`
entrypoints in `@proof-computer/proof-cli-switchboard`. This package keeps the
temporary command-specific shared runner implementations that those entrypoints
call while code is migrated into oclif plugin/shared-library code.
The standalone `switchboard` command router is retired and prints a migration
handoff only. Do not add new user-facing CLI behavior here.

Run user-facing commands through the PROOF CLI:

```text
proof switchboard --help
proof switchboard init --project hello-api --context mainnet
proof switchboard context add mainnet
proof switchboard preflight --quote
proof switchboard deploy --yes --dry-run --json
proof switchboard status
proof switchboard claimable --recipient 0x...
proof switchboard claim --recipient 0x...
proof switchboard refundable --session-id <bytes32>
proof switchboard refund --session-id <bytes32>
proof switchboard hostname add app.example.com
proof switchboard hostname add app.example.com --byo-tls
proof switchboard validator script --json
proof switchboard relay list --json
proof switchboard relay diff --json
proof switchboard relay sync --dry-run
proof switchboard relay whoami relay-d --json
proof switchboard relay status relay-d --catalog-file relays/catalog.json
proof switchboard relay verify relay-d
proof switchboard relay dns plan relay-d
proof switchboard relay dns verify relay-d
```

`context add` is interactive: it prompts for Acurast/Polkadot env vars,
derives ss58 addresses from configured seeds, and runs soft balance
checks against the signed manifest for ACU (Acurast), the Hub native token, and
the default Hub asset (USDC). It refuses to overwrite an existing context — use
`context set` for non-interactive updates. Pass `--no-balance-check` to skip
network calls.

The public-beta deployer/gateway surface is `init`, `context add`,
`context dns`, `context list/current/use/set`, `project`, `preflight`,
`deploy`, `status`, `logs`, `claimable`, `claim`, `refundable`, `refund`,
`hostname`, `validator script`, `gateway`, read-only
`relay list/diff/whoami/logs/status/verify/watch`, local inventory
`relay sync`, read-only `relay dns plan`/`relay dns verify`, local
`relay budget`, and local spec generation `relay scaffold`.
`switchboard.json` is
directory-local project config, `.switchboard/` is directory-local deployment
state, and `~/.switchboard/contexts.json` stores named identity/access
contexts using env var names for secrets.

`init` and `project init` share the same project scaffold implementation and
are exposed as native PROOF plugin entrypoints through
`runSwitchboardProjectInit`. They initialize only local project files and keep
deploy, signing, catalog, relay, bootstrap, and ops behavior on their existing
commands.

Local config ownership is split by intent:

- Builder/developer contexts live in `~/.switchboard/contexts.json`.
- Optional builder context secrets live in
  `~/.switchboard/secrets/<context>.env` and are loaded when that context is
  selected.
- Switchboard/PROOF ops config lives in
  `~/.switchboard/ops/<profile>/config.json`.
- Switchboard/PROOF ops secrets live in
  `~/.switchboard/ops/<profile>/secrets.env`.

Use `proof switchboard ops init mainnet` to create the mainnet ops profile,
`proof switchboard ops show mainnet` to inspect current non-secret config,
and `proof switchboard ops paths mainnet` to see the concrete files.
Low-level Hub session recovery tools are still available under the `session`
namespace for development and recovery:

```text
proof switchboard session register --relay-url https://control.switchboard.proof.computer --yes --json
proof switchboard session status --json --session-id <bytes32>
proof switchboard session refund --session-id <bytes32> --yes
```

For Ledger-backed PROOF payment/funding, configure the context with the
Ledger-derived Polkadot address:

```text
proof switchboard context set ledger --use --polkadot-signer ledger --polkadot-address <ledger-polkadot-address> --ledger-account 0 --ledger-address-index 0 --ledger-metadata-chain-id <zondax-chain-id>
```

`--ledger-mode generic` uses the Polkadot Generic app. The legacy Statemint app
path is available with `--ledger-mode legacy --ledger-chain statemint`.
Ledger signing is scoped to PROOF Hub funding transactions; Acurast deployment
signing remains outside the Switchboard CLI boundary.

The CLI reads the same environment variables as the Web3 harness:

```text
PROOF_NETWORK_MANIFEST_URL=https://control.switchboard.proof.computer/v1/network-manifest
PROOF_POLKADOT_SIGNER=seed
PROOF_LEDGER_METADATA_CHAIN_ID=
POLKADOT_ADDRESS=
POLKADOT_SEED=
JOB_SIGNER_ADDRESS=
JOB_SIGNER_PRIVATE_KEY=
RELAYER_PRIVATE_KEY=
LEASE_SECONDS=
RELAY_URL=
CHAIN_ID=
CONTRACT_CALL_TIMEOUT_MS=
```

`deploy --quote` requests a signed control-plane quote for the configured
USDC/accepted asset, then funds the session through `approve(...)` and
`fundWithAssetQuote(...)`. `session register` reads a funded session, signs the
canonical registration payload with `JOB_SIGNER_PRIVATE_KEY`, submits it to
`--relay-url` or `RELAY_URL`, and verifies the registered session on the
contract. The public package does not include in-process `--local-relay`
registration mode.

`session status --session-id <bytes32>` reads raw Hub session state without
signing, registering, refunding, claiming, or submitting any transaction.

`validator script` reads the approved validator Script runtime IPFS pin from
the signed network manifest, then falls back to an explicit validator script
manifest supplied by JSON, file, or URL. It does not launch validators, sign,
submit transactions, deploy jobs, mutate relay/catalog state, or change local
project/context state.

`catalog build` builds signed service catalog artifacts locally. `catalog
set-state` updates local catalog build spec service state and optionally
rebuilds the signed bundle; it does not publish to a relay. `catalog inspect`
and `catalog verify` are read-only catalog diagnostics.
`catalog inspect` verifies a signed catalog file or URL and prints signer,
expiry, role, sequence, and members. `catalog verify` loads a signed network
manifest, requires a pinned manifest signer unless `--allow-unpinned-signer`
is explicit, and verifies referenced service catalogs.

`relay catalog build` builds a signed relay catalog bundle from local relay
specs plus the persisted `relays/catalog.json` state overlay. `relay catalog
set-state <relay-id> <state>` updates only the local relay catalog state file
and optionally rebuilds the signed bundle; it does not publish to relays,
change DNS, deploy jobs, submit transactions, or change project/context state.

`relay status [relay-id]` reads a relay catalog file and probes relay
`/health`, `/v1/relay-status`, and `/v1/service-catalogs/relay` endpoints. It
is exposed as a native PROOF plugin entrypoint through
`runSwitchboardRelayStatus(argv)` and performs network reads only; it does not
publish catalogs, deploy jobs, submit transactions, or mutate relay state.
`relay list`/`relay ls` lists local relay inventory by default or reads the
signed live manifest/catalog with `--source live`. It is exposed through
`runSwitchboardRelayList(argv)` and preserves the existing `--json` output.
`relay diff` compares local `relays/catalog.json` with signed live discovery.
It is exposed through `runSwitchboardRelayDiff(argv)` and preserves the
existing `--json` output while remaining read-only.
`relay sync` reads signed live discovery, writes local `relays/catalog.json`,
and creates missing local relay stub specs while preserving existing local
spec files. It is exposed through `runSwitchboardRelaySync(argv)` and
preserves `--dry-run`, signer validation, and the no live publish, DNS,
deploy, chain, or context mutation boundary.
Relay lifecycle-management commands are removed from the public CLI surface.
The retired verbs are `relay deploy`, `relay replace`, `relay rotate-key`,
`relay drain`, `relay promote`, `relay deployments`,
`relay deployment-status`, and `relay inspect`. Current relay lifecycle
operations are handled through Fly.io and ops runbooks; the remaining relay
commands are audited/provisional diagnostics or local inventory tools.
`relay whoami [relay-id]` resolves the Acurast relay seed from env/spec
configuration, derives the Acurast deployer addresses, and compares them with
any configured Acurast address env. It is exposed through
`runSwitchboardRelayWhoami(argv)` and remains local/env/spec read-only.
`relay scaffold <relay-id>` writes a local `relays/<relay-id>.json` spec for
either a bootstrap/Compose relay or an Acurast relay. It is exposed through
`runSwitchboardRelayScaffold(argv)` and preserves optional `--keygen` stderr
secret handling, default hostname/domain resolution, duration parsing,
overwrite refusal without `--force`, and local-only file mutation. It does not
deploy jobs, publish catalogs, mutate DNS, submit transactions, touch live
relay state, or change project/context state.
`relay logs [relay-id]` reads encrypted relay log events from the configured
log sink, using saved `.switchboard/relays/<relay-id>.log-sink.json` state
or the existing read URL/token/key env flow. It is exposed through
`runSwitchboardRelayLogs(argv)` and preserves the existing text/JSON output
while remaining read-only log inspection.
`relay verify <relay-id>` reads the local relay catalog, verifies the relay in
the signed live relay catalog, probes `/health`, `/v1/relay-status`, and
`/v1/service-catalogs/relay`, checks the reported relay id, and checks locally
declared peer reachability. It is exposed through
`runSwitchboardRelayVerify(argv)` and preserves the existing text output and
failed-check nonzero behavior while remaining read-only live verification.
`relay budget <duration>` computes the recommended relay
`maxCostPerExecution` for a duration, optional rate, and optional margin. It is
exposed through `runSwitchboardRelayBudget(argv)` and preserves the existing
text/JSON output plus the explicit `--update <spec>` local Acurast spec update
behavior. It does not probe relays, publish catalogs, deploy jobs, submit
transactions, or mutate live relay state.
`relay pick-processor <relay-id>` reads the local relay spec and Acurast
manager availability, lists schedule-clear processors, and optionally updates
the local spec with `--pin auto` or `--pin <processor>`. It is exposed through
`runSwitchboardRelayPickProcessor(argv)` and preserves text/JSON output,
schedule-conflict refusal unless `--force` is passed, and local-only spec
mutation. It does not publish catalogs, deploy jobs, submit transactions, or
mutate live relay state.
`relay dns plan <relay-id>` and `relay dns verify <relay-id>` read the relay
spec DNS block and public CNAME state. They are exposed through
`runSwitchboardRelayDnsPlan(argv)` and `runSwitchboardRelayDnsVerify(argv)`,
preserve `--spec`/`--spec-file`, `--resolvers`, no-DNS no-op behavior, and
drift failure behavior, and do not require Cloudflare credentials. `relay dns
apply` and `relay dns remove` remain mutating Cloudflare/admin surfaces.
`relay watch [relay-id]` reads the local relay catalog, repeatedly probes
relay `/health`, `/v1/relay-status`, and `/v1/service-catalogs/relay`
endpoints, and prints state transitions. It is exposed through
`runSwitchboardRelayWatch(argv)` and preserves `--interval-ms`, `--max-runs`,
and read-only transition output without mutating files, DNS, catalogs,
deployments, sessions, or chain state.

`claimable` checks released reward balances for operator, validator, and PROOF
recipients. `claim` withdraws those balances from
`claimableBalances(asset, msg.sender)`. Use `--recipient` for a read-only
balance check, an EVM reward key with `--claim-private-key-env`, or native
Polkadot seed/Ledger signing with `--hub-signer polkadot`.

`refundable` checks whether a session has an available developer refund.
`refund` is separate from reward claiming. It inspects the session and calls
the eligible developer refund path, either `refundAfterActivationTimeout` or
`refundUnfulfilled`. It supports direct EVM developer keys and native Polkadot
seed/Ledger signing for mapped contract-layer developer addresses.

`claim`, `refund`, and the advanced alias `session refund` are exposed as
native PROOF plugin entrypoints through `runSwitchboardClaim(argv)` and
`runSwitchboardRefund(argv)`. They preserve the existing dry-run default,
`--yes` submission requirement, signer checks, JSON output, and native
Polkadot/Ledger signing behavior.

Customer hostname TLS defaults to PROOF-managed ACME with `_acme-challenge`
CNAME delegation. Use `--manual-dns01` to manage the transient ACME TXT record
yourself, or `--byo-tls` / `--tls-mode byo-certificate` when your Acurast job
will serve its own certificate and private key.

`hostname add`, `hostname remove`, and `hostname status` are exposed as native
PROOF plugin entrypoints through `runSwitchboardHostnameAdd(argv)`,
`runSwitchboardHostnameRemove(argv)`, and `runSwitchboardHostnameStatus(argv)`.
Add/remove sign relay customer-hostname requests, but they do not deploy,
spend, submit Hub transactions, mutate local context/project files, or update
DNS provider records.

Customer hostname modes:

- Default: `hostname add app.example.com` prints the traffic CNAME and a stable
  `_acme-challenge` CNAME delegation record. PROOF handles the transient ACME
  TXT value after DNS is delegated.
- Manual TXT: `hostname add app.example.com --manual-dns01` keeps PROOF ACME
  issuance, but `hostname status` prints the current `_acme-challenge` TXT
  value for the developer to create.
- BYO TLS: `hostname add app.example.com --byo-tls` only configures routing.
  The Acurast job must serve a valid cert/key for `app.example.com`; PROOF does
  not request or renew certificates for that hostname.

By attaching a hostname, developers must use only domains they control and must
not use Switchboard for illegal content, attacks, abuse, phishing, spam,
malware, or platform evasion.
