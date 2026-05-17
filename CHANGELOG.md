# Changelog

All notable changes to `@jecpdev/cli` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `npm run test:integration` — opt-in suite under `test/integration/`
  that spawns the built `dist/cli.js` against a live JECP Hub (default
  `https://setsuna-jobdonebot.fly.dev`, override via
  `JECP_TEST_BASE_URL`). Covers `--help` surface, `doctor --json`, and
  `catalog --json`. Excluded from `npm test`. Requires `npm run build`
  first. See [`test/integration/README.md`](./test/integration/README.md).

## [0.8.2] - 2026-05-16

### Added

- `jecp provider validate [file]` — client-side manifest validation
  against the canonical schema (`jecp.dev/schemas/v1/manifest.schema.json`,
  shipped in jecp-spec `58f14de`). Catches structural errors before the
  Hub round-trip and surfaces them in the exact same shape as the Hub's
  `INPUT_SCHEMA_VIOLATION` response (`{ instance_path, schema_path, reason }`)
  so the error a developer sees locally matches what the Hub would have
  returned.

  Exit codes: `0` valid, `1` invalid (errors on stderr), `2` read /
  parse failure. `--json` emits a machine-readable result for CI.

  Implementation: hand-rolled JSON Schema 2020-12 validator (160 LOC)
  targeted at the subset our manifest schema actually uses. Avoids
  pulling `ajv` and its ~250 KB bundle cost. Supports `required`,
  `pattern`, `enum`, `type`, `minLength`/`maxLength`,
  `minimum`/`maximum`, `minItems`/`maxItems`, `items`, `properties`,
  `additionalProperties: false`, `$ref` to `#/$defs/*`, and the
  `allOf.not.required` pattern used for the composes/streaming xor.

### Changed

- `yaml` package added as a runtime dep (^2.9.0) — needed for the
  validator to parse YAML manifests. ~50 KB unpacked. Required so
  `validate` accepts both YAML and JSON identically to the Hub
  (the Hub's content-type autodetect parses both).

- `package-lock.json` is now committed. Was gitignored as a legacy
  choice; the new Trusted Publishing workflow uses `npm ci` for
  reproducible installs, which requires the lockfile.

### Tests

59 → 78 (+19 validator tests). Coverage:

- Happy path: minimal valid manifest, manifest with all optional
  fields filled.
- Required fields: missing namespace, empty actions, missing pricing.
- Pattern + enum: uppercase namespace, http endpoint, non-semver
  version, unknown pricing model, unsupported trust_tier.
- Type mismatches: pricing.base as number, tags as string.
- Composes/streaming xor: both set rejected, either alone accepted.
- `additionalProperties: false`: unknown top-level field, unknown
  pricing property — these catch typos at validate time.
- Error shape parity with Hub `INPUT_SCHEMA_VIOLATION` format.

## [0.8.1] - 2026-05-16

QA P0 fixes from the agent-council review of v0.8.0. Both close
real lockout / silent-breakage risks that existed before npm publish.

### Fixed

- **Atomic config writes** — `saveConfig()` now writes to a sibling
  `config.json.tmp.<pid>` file, `fsync`s it, then `rename()`s over
  the real path. POSIX `rename(2)` is atomic, so a crash between the
  write and the durable commit can no longer leave the operator with
  a half-written `~/.jecp/config.json`. The original file content
  survives even if the new write fails for any reason.

- **Anti-lockout fallback on rotate-key** — both `jecp rotate-key`
  (agent) and `jecp provider rotate-key` now wrap `saveConfig()` in
  a try/catch. If the Hub rotation succeeds but the local persist
  fails (disk full, permission change, ENOSPC, etc.), the new
  `api_key` is emitted to stdout with a multi-line URGENT warning
  and a paste-into-config recipe — instead of the prior behavior
  where the operator would be silently locked out (Hub revoked old
  key, local file never got the new one).

- **hello-world scaffold streaming trap** — the generated
  `handler.mjs` and `README.md` now carry prominent warnings that
  this scaffold uses `JecpProvider.createHandler` (non-streaming
  only), and that setting `streaming: true` on a `jecp.yaml` action
  while keeping this handler produces a silently-broken endpoint.
  README explains the SSE wire format expectations and links to the
  streaming guide for Providers that need it.

### Tests

50 → 59 (+9). New coverage:

- `test/config-atomic.test.ts` — 6 tests verifying crash-atomic
  rename, original-file survival on rename failure, no `.tmp.<pid>`
  leaks, mode-0600 final permissions, back-to-back rapid rotations
  without PID collisions, and legacy-file mode normalization.
- `test/provider.test.ts` — 1 new "surfaces the new key on stdout
  if config save fails" test using a real read-only `~/.jecp/`
  filesystem state (not module-level mocking — vitest can't redefine
  `node:fs` exports).
- `test/init-provider-hello-world.test.ts` — 2 new tests asserting
  the streaming-not-supported warnings appear in both `handler.mjs`
  header and the scaffold README.

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
- `jecp provider rotate-key [--grace-seconds <s>] [--revoke-old] [--yes]`
  — rotate the Provider's API key. The HMAC secret is NOT rotated
  (separate lifecycle: HMAC signs inbound Hub forwards, api_key is
  outbound auth for `/v1/providers/*` and `/v1/manifests`). Default
  grace is 7 days; `--revoke-old` forces the old key invalid
  immediately. The Hub's 24h rotation cap surfaces with a recovery
  hint instead of a raw 429.

- `jecp doctor` now reports Provider readiness when Provider creds
  are configured: auth check against `/v1/providers/me`, DNS-verified
  status, Stripe-Connect-verified status, and lifetime call count.
  Skipped silently when no Provider creds — agent-only operators see
  no extra noise.

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
