# @jecpdev/cli — v0.8.1 Release Notes

**Release date**: 2026-05-16
**npm**: `npm install -g @jecpdev/cli@0.8.1`
**SDK pinned**: `@jecpdev/sdk@^0.8.3`
**Hub**: works against any v1.0+ JECP Hub (default `https://jecp.dev`)

---

## TL;DR

Provider time-to-first-published-capability drops from ~3 days (manual DNS retry loops via raw `curl`) to ~30 minutes (`jecp init-provider --example hello-world` + `jecp provider register --wait`).

Plus two QA P0 fixes that close real lockout / silent-breakage risks introduced in v0.8.0 — these are why v0.8.0 was never on the npm registry; v0.8.1 is the first npm-published v0.8.x.

## Why this exists (v0.8.x line)

Until v0.7.x, becoming a Provider required reading the spec, hand-crafting `jecp.yaml`, running five separate `curl` commands (register → publish DNS TXT → wait for propagation → verify → connect Stripe → publish manifest), and retrying the DNS-verify step every few minutes until the TXT record propagated. Onboarding feedback from early Providers consistently put TTV at multiple days, with the manual retry loop as the dominant friction.

v0.8.x makes Provider lifecycle a first-class CLI concept. Every step that was raw `curl` is now an idempotent CLI command with a clear error model, retry-safe state on `~/.jecp/config.json`, and progress feedback for the long-running DNS-propagation step.

## What's new since v0.7.0

### Provider lifecycle commands

| Command | What it does |
|---|---|
| `jecp provider register --wait` | POST `/v1/providers/register`, saves `provider_api_key` + `hmac_secret` + `dns_token` to config (mode 0600), prints the TXT record to publish, then auto-polls `verify-dns` until DNS propagates. 10s interval, 10min default deadline. |
| `jecp provider verify-dns` | Standalone poll for the DNS step. `--once` makes a single attempt and exits 2 if not verified (CI signal). `--timeout 5m`/`1h`/`300` overrides the deadline. |
| `jecp provider publish [file]` | Posts a manifest YAML to `/v1/manifests` (default `jecp.yaml`). Status auto-promotes to `active` once both DNS and Stripe are verified — until then capabilities stay at `submitted` and don't appear in the public catalog. |
| `jecp provider me` | DNS / Stripe / endpoint / lifetime-calls status from `/v1/providers/me`. |
| `jecp provider rotate-key` | Atomic key rotation with optional `--revoke-old` (skip grace) or `--grace-seconds`. The Hub's 24h rotation cap surfaces with a recovery hint instead of a raw 429. |
| `jecp provider connect-stripe` | Prints the Stripe Connect Express onboarding URL. |

### Hello-world Provider scaffold

```bash
jecp init-provider --example hello-world
```

Writes four files: `jecp.yaml`, `handler.mjs`, `package.json`, `README.md`. The handler uses Node 20+ stdlib `http.createServer` + `JecpProvider.createHandler` from the SDK — zero non-SDK dependencies, fewer install failures on flaky networks. An operator can `npm install && node handler.mjs` and have a spec-compliant endpoint live in under a minute.

### `jecp doctor` Provider readiness section

When Provider creds are configured, doctor now reports auth check against `/v1/providers/me`, DNS-verified status, Stripe-Connect-verified status, and lifetime call count. Skipped silently when no Provider creds — agent-only operators see no extra noise.

### QA P0 fixes (v0.8.0 → v0.8.1)

These two fixes are why v0.8.0 was never published to npm.

**Atomic config writes.** `saveConfig()` now writes to `config.json.tmp.<pid>`, `fsync`s, then `rename()`s over the real path. POSIX `rename(2)` is atomic; a crash between write and durable commit can no longer leave a half-written `~/.jecp/config.json`.

**Anti-lockout fallback on rotate-key.** If the Hub rotation succeeds but the local save fails (disk full, permission change, ENOSPC), both `jecp rotate-key` and `jecp provider rotate-key` now emit the new `api_key` to stdout with an URGENT warning + paste-into-config recipe — instead of crashing silently and locking the operator out.

**Hello-world scaffold streaming-trap docs.** Generated `handler.mjs` + `README.md` now warn prominently that the scaffold uses non-streaming `JecpProvider.createHandler`; flipping `streaming: true` in `jecp.yaml` requires replacing the handler with an SSE-aware one (link to `jecp.dev/guides/streaming`).

## Numbers

| Metric | v0.7.0 | v0.8.1 |
|---|---|---|
| Provider commands | 0 (raw `curl`) | 6 first-class |
| Provider TTV (manual DNS wait) | ~3 days | ~30 minutes |
| Hello-world starter | 1 file (YAML only) | 4 files (runnable) |
| Tests | 15 | 59 |

Numbers are measured against the reference Hub at `https://jecp.dev`. TTV is wall-clock from `init-provider` start to first `publish` returning `status: active` (assumes DNS provider propagates within 30s — Cloudflare typical; slower providers extend proportionally).

## Migration

If you were already running v0.7.x:

```bash
npm install -g @jecpdev/cli@latest
```

All existing commands keep their semantics. The new Provider commands are additive. If you previously stored Provider creds in environment variables (`JECP_PROVIDER_KEY` etc.), they still work — env-var resolution takes priority over config-file resolution.

If you were using the published `v0.8.0` — that version exists in the GitHub release history but was never on npm. v0.8.1 is the first v0.8.x install you should pull.

## Spec compatibility

v0.8.1 is compatible with any JECP Hub at spec v1.0+ that exposes the Provider lifecycle endpoints (`/v1/providers/{register, me, verify-dns, me/rotate-key, connect-stripe}` + `/v1/manifests`). The reference Hub at `https://jecp.dev` is the canonical target.

## What's next

v0.9.0 is in design. Tentative scope: `JecpProviderClient` in the SDK so TypeScript apps can run the same lifecycle without shelling out to the CLI, and `jecp provider validate` client-side validation against `jecp-spec/schemas/v1/manifest.schema.json` (shipped 2026-05-16).

## Acknowledgments

The session that produced v0.8.1 was directed by an internal 4-agent council (PM / Architect / QA / Brand). The QA agent flagged both P0s in v0.8.0 before publish. The conformance YAMLs for `/v1/providers/*` covering the new surface live at `jecp-spec/conformance/v1.0/JECP-PROVIDER-*.yaml`.

Spec: `github.com/jecpdev/jecp-spec`
CLI source: `github.com/jecpdev/jecp-cli`
SDK: `github.com/jecpdev/jecp-sdk-typescript`
Issues: `github.com/jecpdev/jecp-cli/issues`
