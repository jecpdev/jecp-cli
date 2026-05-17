# CLI integration tests

These tests **spawn the built `dist/cli.js`** as a child process and run
real commands against a live JECP Hub.

## Run

```bash
# Always build first — integration tests run the compiled artifact.
npm run build

# Against the default staging Hub (https://setsuna-jobdonebot.fly.dev)
npm run test:integration

# Against a local Hub
JECP_TEST_BASE_URL=http://localhost:8080 npm run test:integration

# Against jecp.dev (production)
JECP_TEST_BASE_URL=https://jecp.dev npm run test:integration
```

## What they check

- `cli-help.test.ts` — `jecp --help` lists the expected top-level commands.
  Pure local check, no network.
- `cli-doctor.test.ts` — `jecp doctor --json --base-url=...` returns the
  documented `{ checks: [...], all_ok: bool }` shape and the `hub_health`
  check is `ok`. Does **not** assert `all_ok===true` because doctor also
  inspects local creds + x402 signer that won't be present in CI.
- `cli-catalog.test.ts` — `jecp catalog --json --base-url=...` returns a
  catalog with at least one capability.

## HOME sandboxing

The unit test `test/setup.ts` mocks `node:os` `homedir()` inside the test
process — that doesn't reach child processes. Each integration test
spawns the CLI with a temp `HOME` env var (created via `mkdtempSync`) so
the real `~/.jecp/config.json` is never touched.
