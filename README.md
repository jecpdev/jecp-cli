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

## Commands

| Command | Description |
|---------|-------------|
| `jecp register` | Register a new agent (interactive or via flags) |
| `jecp login` | Save existing agent credentials |
| `jecp logout` | Clear stored credentials |
| `jecp invoke <cap> <action>` | Invoke a capability action |
| `jecp catalog` | List capabilities (paginated) |
| `jecp topup <amount>` | Top up wallet (5/20/100 USDC) |
| `jecp status` | Show health, balance, agent info |
| `jecp doctor` | Diagnose connectivity, config, SDK version |

Run `jecp <command> --help` for full options.

## Global flags

- `--json` — machine-readable JSON output (for CI/scripting)
- `--base-url <url>` — override Hub URL (default `https://jecp.dev`)

## Auth precedence

1. `JECP_AGENT_ID` + `JECP_AGENT_KEY` env vars (CI mode)
2. `~/.jecp/config.json` (saved by `register` or `login`)

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
JECP_AGENT_ID=jdb_ag_... JECP_AGENT_KEY=jdb_ak_... \
  jecp invoke a/b c --json | jq '.output'
```

## License

Apache 2.0 — Tufe Company Inc.
