# @jecpdev/cli

> Command-line interface for **JECP — Joint Execution & Commerce Protocol**.
> Register agents, invoke capabilities, manage Providers from your terminal.

[![npm](https://img.shields.io/npm/v/@jecpdev/cli.svg)](https://npmjs.com/package/@jecpdev/cli)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

```bash
npm install -g @jecpdev/cli
# or one-shot
npx @jecpdev/cli --help
```

## Quickstart — agent in 30 seconds

```bash
$ jecp register --name MyBot --type demo
✓ Agent registered.

  AGENT_ID:   jdb_ag_a1b2c3...
  API_KEY:    jdb_ak_xxxxxxxxxxxx
  Free calls: 100

✓ Credentials saved to ~/.jecp/config.json (mode 0600)

$ jecp invoke jobdonebot/content-factory translate \
    --input '{"text":"Hello","target_lang":"JA"}'
✓ Invocation complete.

  Output:      {"translated":"こんにちは"}
  Provider:    jobdonebot/content-factory@1.0.0
  Charged:     $0.005 USDC
  Balance:     $0.995 USDC
```

## Quickstart — Provider in 30 minutes (v0.8.1+)

```bash
$ jecp init-provider --example hello-world      # scaffold runnable starter
✓ Scaffolded hello-world Provider in .
  → jecp.yaml, handler.mjs, package.json, README.md

$ npm install
$ jecp provider register \
    --namespace myco --display-name "MyCo" \
    --email ops@myco.example --endpoint https://myco.example/jecp \
    --country JP --wait                         # auto-polls DNS until verified
✓ Provider registered. Credentials saved to ~/.jecp/config.json
  → Add this DNS TXT record:
    _jecp.myco.example  TXT  "jecp-verify=tok_xyz"
  Polling /v1/providers/verify-dns until propagation…
✓ DNS verified after 3 attempts.

$ JECP_HMAC_SECRET=$(jq -r .provider_hmac_secret ~/.jecp/config.json) \
    node handler.mjs &                          # local Provider running
$ jecp provider connect-stripe                  # open the URL in browser
$ jecp provider publish jecp.yaml               # active once DNS+Stripe verified
✓ Published myco/echo@1.0.0
```

For a fully interactive scaffold (without the hello-world starter),
omit `--example`. The bare YAML stub is available with `--example`.

## Commands

| Command | Description |
|---------|-------------|
| `jecp register` | Register a new agent (interactive or via flags) |
| `jecp login` | Save existing agent credentials |
| `jecp logout` | Clear stored credentials |
| `jecp invoke <cap> <action>` | Invoke a capability action (`--pay wallet\|x402\|auto`) |
| `jecp catalog` | List capabilities (paginated) |
| `jecp topup <amount>` | Top up wallet (5/20/100 USDC) |
| `jecp status` | Show health, balance, agent info |
| `jecp doctor` | Diagnose connectivity, config, SDK version, x402 readiness |
| `jecp wallet:link-usdc <addr>` | **v0.7.0** — Link Base USDC wallet for x402 payments |
| `jecp init-provider` | Interactive jecp.yaml scaffold (now with x402 prompts) |
| `jecp provider register` | **v0.8.0** — Register as Provider; saves creds, prints DNS TXT |
| `jecp provider verify-dns` | **v0.8.0** — Auto-poll until DNS TXT propagates (`--once` for CI) |
| `jecp provider validate [file]` | **v0.8.2** — Validate jecp.yaml locally against the manifest schema (exits 1 on invalid) |
| `jecp provider publish [file]` | **v0.8.0** — Publish jecp.yaml to `/v1/manifests` |
| `jecp provider me` | **v0.8.0** — Show Provider DNS/Stripe/endpoint status |
| `jecp provider rotate-key` | **v0.8.0** — Rotate Provider api_key (7-day grace) |
| `jecp provider connect-stripe` | **v0.8.0** — Get Stripe Connect onboarding URL |
| `jecp rotate-key` | Rotate this agent's API key (7-day grace) |
| `jecp refund …` / `webhook …` | Refund + webhook subscription management |

Run `jecp <command> --help` for full options.

## Global flags

- `--json` — machine-readable JSON output (for CI/scripting)
- `--base-url <url>` — override Hub URL (default `https://jecp.dev`)

## Auth precedence

1. `JECP_AGENT_ID` + `JECP_API_KEY` env vars (CI mode)
2. `~/.jecp/config.json` (saved by `register` or `login`)

### Environment variables

| Variable | Status | Notes |
|----------|--------|-------|
| `JECP_AGENT_ID` | active | Agent ID (e.g. `jdb_ag_…`). |
| `JECP_API_KEY` | active | Preferred name for the agent's API key. Matches the Hub's `X-API-Key` header convention. |
| `JECP_AGENT_KEY` | **deprecated** | Legacy alias for `JECP_API_KEY`. Still honored, but emits a deprecation warning on stderr and will be **removed in v0.10**. |
| `JECP_BASE_URL` | active | Override Hub URL (default `https://jecp.dev`). |
| `JECP_PROVIDER_ID` / `JECP_PROVIDER_KEY` | active | Provider credentials, independent of agent credentials. |

If both `JECP_API_KEY` and `JECP_AGENT_KEY` are set, `JECP_API_KEY` wins and
no deprecation warning is emitted.

## Config file

Stored at `~/.jecp/config.json` with mode `0600`. Contains `agent_id`, `api_key`, `base_url`. Treat like a Stripe secret key.

## Examples

### Invoke with budget cap

```bash
jecp invoke deepl/translate translate \
  --input '{"text":"Hello","target_lang":"JA"}' \
  --budget 1.00 \
  --timeout 60000
```

### Discover capabilities

```bash
jecp catalog --page-size 100 --namespace jobdonebot
```

### CI integration

```bash
JECP_AGENT_ID=jdb_ag_... JECP_API_KEY=jdb_ak_... \
  jecp invoke a/b c --json | jq '.output'
```

> `JECP_AGENT_KEY` is the legacy name and still works for one more
> release; switch to `JECP_API_KEY` to avoid the deprecation warning.
> The variable will be removed in v0.10.

## x402 quickstart (v0.7.0)

JECP supports **x402 (USDC on Base)** as a parallel payment rail alongside the
default Stripe-funded wallet. Per-call settlement, lower fees, no balance
required.

### 1. Link your Base wallet address

```bash
jecp wallet:link-usdc 0xAb11Cd22Ef33aaBBCcDDeeFF0011223344556677
# → stored in ~/.jecp/config.json (CLI never holds the private key)
```

The CLI accepts three signer kinds via `--signer`:

- `env` (default) — SDK reads `BASE_PRIVATE_KEY` from env at invoke time
- `file` — SDK reads `~/.jecp/base-key.txt` (chmod 600)
- `kms` — bring your own KMS adapter via SDK directly

### 2. Verify readiness

```bash
jecp doctor
# … existing 9 checks …
# ── x402 ──
# ✓ x402 signer configured: 0xAb11... (env)
# ✓ x402 facilitator reachable: https://x402.org/facilitator (122ms)
# ✓ Base RPC reachable: https://mainnet.base.org chain=base (88ms)
# ✓ Splitter check: catalog advertises payment_methods: [..., x402]
```

### 3. Invoke with x402

```bash
export BASE_PRIVATE_KEY=0x...
jecp invoke jobdonebot/bg-remover-pro remove \
  --pay x402 \
  --input '{"image_url":"https://example.com/photo.jpg"}'

# … receipt block printed:
# Payment receipt (x402):
#   method:     x402
#   txHash:     0xdead…
#   network:    base
#   amount:     $0.005 (5000 USDC micros)
#   Basescan:   https://basescan.org/tx/0xdead…
```

`--pay auto` (default) tries x402 when both the agent and capability
support it, and falls back to wallet otherwise. `--pay wallet` forces the
classic balance-funded path.

### 4. Provider opt-in (when scaffolding)

`jecp init-provider` now asks "Accept x402 (USDC on Base) payments? (Y/n)"
and emits `payment_methods: ["stripe", "x402"]` in the manifest by default.
Locked design §6.2 — hybrid mode is the recommended default.

> **Note**: `ethers` is an optional peer dep. Install it (`npm i -g ethers`)
> if you use `--pay x402`; otherwise the CLI falls back to wallet mode with a
> clear hint.

## Integration tests

Default `npm test` runs hermetic unit tests only. An opt-in suite under
`test/integration/` spawns the **built** `dist/cli.js` against a live
JECP Hub to catch CLI/Hub contract drift:

```bash
# Always build first — integration tests run the compiled artifact.
npm run build

# Against the default staging Hub (https://setsuna-jobdonebot.fly.dev)
npm run test:integration

# Against a local Hub
JECP_TEST_BASE_URL=http://localhost:8080 npm run test:integration

# Against jecp.dev (production — coordinate first)
JECP_TEST_BASE_URL=https://jecp.dev npm run test:integration
```

See [`test/integration/README.md`](./test/integration/README.md) for what
each test asserts and how HOME is sandboxed in spawned children.

## License

Apache 2.0 — Tufe Company Inc.
