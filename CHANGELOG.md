# Changelog

All notable changes to `@jecpdev/cli` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.8.0] - 2026-05-16

Closes the Provider onboarding loop end-to-end in the CLI. Before this
release `jecp init-provider` scaffolded a `jecp.yaml`, but the remaining
five steps (register → DNS publish → verify → Stripe Connect → publish
manifest) were raw `curl` invocations with a manual retry wait for DNS
propagation. v0.8.0 ships first-class commands and an auto-poll loop.

Target metric: Provider TTV from ~3 days (manual DNS retry) to ~30 min.

### Added

- `jecp provider register` — interactive (or flag-driven) Provider
  registration. POSTs `/v1/providers/register`, saves `provider_api_key`
  + `hmac_secret` + `dns_token` to `~/.jecp/config.json` (mode 0600),
  prints the DNS TXT record name + value. `--wait` chains into the
  verify-dns poll loop so a single command completes the register + DNS
  wait.
- `jecp provider verify-dns` — polls `/v1/providers/verify-dns` every
  10 s until the TXT propagates. Default 10-minute deadline,
  `--timeout 5m`/`1h`/`300` (seconds) overrides. `--once` makes a single
  attempt and exits 2 if not yet verified (CI signal).
- `jecp provider me` — pretty-prints DNS / Stripe / endpoint / call
  count from `/v1/providers/me`.
- `jecp provider publish [file]` — POSTs YAML to `/v1/manifests`
  (default file `jecp.yaml`), prints `capability_id` + status, surfaces
  the auto-promote rule ("submitted until DNS+Stripe both verified").
- `jecp provider connect-stripe` — gets the Stripe Connect Express
  onboarding URL and prints it for manual browser opening (URL has a
  short TTL so chained automation is intentionally avoided).

- `jecp init-provider --example hello-world` — runnable Provider
  starter (jecp.yaml + handler.mjs + package.json + README.md). The
  handler uses Node 20+ stdlib `http.createServer` (zero non-SDK deps)
  and integrates `JecpProvider.createHandler` for HMAC verification.
  An operator can `npm install && node handler.mjs` and have a live,
  spec-compliant endpoint in under a minute. Bare `--example` keeps
  the legacy single-file YAML stub behavior.

### Changed

- `jecp init-provider`'s "Next steps" footer now references the new
  commands instead of `curl`, cutting onboarding doc surface area
  roughly in half.

### Config surface (additive)

`~/.jecp/config.json` gains five Provider fields, all optional:

```jsonc
{
  "provider_id":          "prov_…",
  "provider_namespace":   "yourns",
  "provider_api_key":     "jdb_pk_…",  // shown once, persisted automatically
  "provider_hmac_secret": "base64…",
  "provider_dns_token":   "…"          // kept so resume flows work
}
```

Env-var override for scripted use:
- `JECP_PROVIDER_ID`
- `JECP_PROVIDER_KEY`

Agent creds (`agent_id` / `api_key`) and Provider creds are independent
— one operator may hold both, neither, or one. Each command surfaces
a clear "run register first" hint if its required creds are missing.

### Internal

- `resolveProviderAuth()` parallel to `resolveAuth()`; same env-over-file
  precedence pattern.
- `parseTimeoutMs()` helper accepts bare seconds or `s/m/h` suffix,
  capped at 1 h to keep CI loops sane.
- Provider commands call `/v1/providers/*` and `/v1/manifests` via
  direct `fetch` rather than the SDK — the JecpClient surface is
  Agent-side only, and pulling Provider lifecycle into the SDK is
  scope for a future release.

## [0.7.0] - 2026-05-15

Aligns with `@jecpdev/sdk` v0.8.2 and `jecp-spec` v1.1.0 (x402 integration).
Backward-compatible — `--pay` defaults to `auto`, which behaves identically
to pre-0.7 for capabilities that don't accept x402.

Cites the **x402 Integration Locked Design v1.1.1**
(`docs/jecp/x402-integration-locked-design.md`) §6.3 (Developer UX) and
Panel 4 §B.2 / §C (CLI surface).

### Added

#### New command

- `jecp wallet:link-usdc <address> [--signer env|file|kms] [--default wallet|x402|auto]`
  Stores the agent's Base wallet address + signer kind in `~/.jecp/config.json`.
  Validates `0x` + 40 hex chars at the CLI layer for fast feedback. Does NOT
  read or store the private key (the CLI never holds keys).

#### New flag

- `jecp invoke --pay <wallet|x402|auto>` — override the payment rail for a
  single invoke. Default reads from `x402_pay_default` in config, falling
  back to `'auto'`. When `--pay x402` and no wallet linked, fails fast with
  a clear "run wallet:link-usdc first" message.

#### Doctor expansion (4 new checks)

`jecp doctor` now runs:

- `x402.signer_present` — config has wallet:link-usdc done; also warns if
  `BASE_PRIVATE_KEY` env var is missing when `signer_kind=env`
- `x402.facilitator_reachable` — GET `$X402_FACILITATOR_URL` (default
  `https://x402.org/facilitator`), <2s timeout
- `x402.base_rpc_reachable` — JSON-RPC `eth_chainId` against
  `$BASE_RPC_URL` (default `https://mainnet.base.org`); verifies chain
  is `0x2105` (mainnet) or `0x14a34` (Sepolia)
- `x402.splitter_address_correct` — pulls `/v1/capabilities` and confirms
  at least one capability advertises `payment_methods: [..., x402]` (full
  splitter-address cross-check lives in the SDK once the Hub publishes
  the address in the catalog response — TODO post-Hub-v1.1.0)

#### init-provider extensions

`jecp init-provider` wizard now asks:

- "Accept x402 (USDC on Base) payments? (Y/n)" — default Y per locked
  design §6.2 (hybrid mode is the recommended default)
- "USDC payout address (Base mainnet):" — validated against the
  `0x` + 40 hex regex

Generated manifest emits `payment_methods: ["stripe", "x402"]` by default
(or `["stripe"]` if operator opts out). New top-level `usdc_payout_address`
field is emitted in the Provider block when x402 is accepted.

The optional 1-wei USDC test transfer (Panel 4 §C.4 item 8) is documented
as a runtime step rather than executed by the wizard — running on-chain
transactions from a scaffold tool is an unexpected side effect.

#### CLI version

- `--version` now reports `0.7.0`.
- Peer/dep range bumped: `@jecpdev/sdk` `^0.5.0` → `^0.8.2`.

### Behavior

- Agents already running v0.6.x see zero change unless they pass `--pay`
  or run `wallet:link-usdc`. Default `--pay` mode is read from config
  (falls back to `auto`).
- `--pay x402` without a linked wallet fails fast at the CLI; SDK is never
  called with an unfulfillable contract.
- After successful x402 invocation, the CLI prints a "Payment receipt
  (x402)" block with `txHash`, `network`, `amount`, and a Basescan link.

### Internal

- The CLI does NOT add `ethers` or `viem` as a hard dependency. The
  `--pay x402` path uses `require('ethers')` inside the signer builder
  with a graceful fallback message — operators who want x402 install
  `ethers` (or use the SDK directly with their preferred adapter).
- Config file `~/.jecp/config.json` schema extended with optional
  `x402_wallet_address`, `x402_signer_kind`, `x402_pay_default` fields.
  Old configs continue to load without migration.
