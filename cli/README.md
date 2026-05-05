# Switchboard CLI

Status: active CLI reference
Last reviewed: 2026-04-30

Developer-facing command wrapper for Switchboard.

Run from the repo root:

```text
pnpm switchboard -- help
pnpm switchboard -- init --project hello-api --endpoint hello.ingress.works --context mainnet
pnpm switchboard -- context add mainnet
pnpm switchboard -- context dns set cloudflare --token-env CLOUDFLARE_API_TOKEN
pnpm switchboard -- preflight --quote
pnpm switchboard -- deploy --yes --dry-run --json
pnpm switchboard -- status
pnpm switchboard -- logs
pnpm switchboard -- claimable --recipient 0x...
pnpm switchboard -- claim --recipient 0x...
pnpm switchboard -- refundable --session-id <bytes32>
pnpm switchboard -- refund --session-id <bytes32>
pnpm switchboard -- hostname add app.example.com
pnpm switchboard -- hostname add app.example.com --byo-tls
```

`context add` is interactive: it prompts for the operator ID, Acurast/Polkadot
env vars, derives ss58 addresses from configured seeds, and runs soft balance
checks against the signed manifest for ACU (Acurast), the Hub native token, and
the default Hub asset (USDC). It refuses to overwrite an existing context — use
`context set` for non-interactive updates. Pass `--no-balance-check` to skip
network calls. DNS provider credentials are a separate step
(`context dns set cloudflare --token-env <NAME>`); skip it entirely if you plan
to `--byo-tls` every hostname.

The public-beta deployer/operator surface is `init`, `context add`,
`context dns`, `context list/current/use/set`, `project`, `preflight`,
`deploy`, `status`, `logs`, `claimable`, `claim`, `refundable`, `refund`,
`hostname`, and `operator`.
`switchboard.json` is
directory-local project config, `.switchboard/` is directory-local deployment
state, and `~/.switchboard/contexts.json` stores named identity/access
contexts using env var names for secrets.

Local config ownership is split by intent:

- Builder/developer contexts live in `~/.switchboard/contexts.json`.
- Optional builder context secrets live in
  `~/.switchboard/secrets/<context>.env` and are loaded when that context is
  selected.
- Switchboard/PROOF ops config lives in
  `~/.switchboard/ops/<profile>/config.json`.
- Switchboard/PROOF ops secrets live in
  `~/.switchboard/ops/<profile>/secrets.env`.

Use `pnpm switchboard -- ops init mainnet` to create the mainnet ops profile,
`pnpm switchboard -- ops show mainnet` to inspect current non-secret config,
and `pnpm switchboard -- ops paths mainnet` to see the concrete files.
Low-level Hub session recovery tools are still available under the `session`
namespace for development and recovery:

```text
pnpm switchboard -- session register --local-relay --yes --json
pnpm switchboard -- session status --json --session-id <bytes32>
pnpm switchboard -- session refund --session-id <bytes32> --yes
```

For Ledger-backed PROOF payment/funding, configure the context with the
Ledger-derived Polkadot address:

```text
pnpm switchboard -- context set ledger --use --polkadot-signer ledger --polkadot-address <ledger-polkadot-address> --ledger-account 0 --ledger-address-index 0 --ledger-metadata-chain-id <zondax-chain-id>
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
either `RELAY_URL` or an in-process relay with `--local-relay`, and verifies
the registered session on the contract.

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

Customer hostname TLS defaults to PROOF-managed ACME with `_acme-challenge`
CNAME delegation. Use `--manual-dns01` to manage the transient ACME TXT record
yourself, or `--byo-tls` / `--tls-mode byo-certificate` when your Acurast job
will serve its own certificate and private key.

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
