/**
 * Integration test — `jecp catalog --json --base-url=$JECP_TEST_BASE_URL`.
 *
 * Hits the live Hub catalog endpoint via the SDK, through the CLI, and
 * asserts the result decodes + contains at least one capability.
 *
 * The CLI's catalog command needs `agentId+apiKey` resolved to build a
 * `JecpClient`. The catalog endpoint itself is unauthenticated, so we
 * pass dummy credentials via env vars (the CLI's sdk.js will pack them
 * into the client; the Hub will ignore them on a GET to /v1/capabilities).
 *
 * If the CLI tightens auth resolution and refuses dummy creds, this test
 * is the canary — and we'll need a `--no-auth` flag on the catalog
 * command to keep it usable for unauthenticated catalog browsing.
 */

import { describe, it, expect } from 'vitest';
import { runCli, HUB_BASE_URL } from './spawn-cli.js';

interface CatalogPayload {
  capabilities?: unknown[];
  third_party_capabilities?: unknown[];
  page_size?: number;
  has_more?: boolean;
  paginated?: boolean;
}

describe(`integration: cli catalog --json against ${HUB_BASE_URL}`, () => {
  it('exits 0 and emits a catalog with at least 1 capability', async () => {
    const r = await runCli(
      [
        '--json',
        `--base-url=${HUB_BASE_URL}`,
        'catalog',
        '--page-size',
        '5',
      ],
      {
        // CLI's auth resolver expects either env vars or ~/.jecp/config.json.
        // /v1/capabilities is public, so dummy creds are fine — the Hub
        // never validates them on a GET.
        env: {
          // Use JECP_API_KEY (preferred name as of v0.8.3). Dummy creds
          // are fine here because /v1/capabilities is unauthenticated —
          // the Hub never validates them on a GET to this endpoint.
          JECP_AGENT_ID: 'jdb_ag_dummy_for_integration_test',
          JECP_API_KEY: 'jdb_ak_dummy_for_integration_test',
        },
      },
    );

    expect(r.exitCode, `catalog exited non-zero.\nstdout:\n${r.stdout.slice(0, 1000)}\nstderr:\n${r.stderr.slice(0, 1000)}`).toBe(0);

    let parsed: CatalogPayload;
    try {
      parsed = JSON.parse(r.stdout) as CatalogPayload;
    } catch (e) {
      throw new Error(
        `catalog --json did not emit valid JSON.\nstdout:\n${r.stdout.slice(0, 2000)}\nstderr:\n${r.stderr.slice(0, 1000)}`,
      );
    }

    const builtin = parsed.capabilities ?? [];
    const tp = parsed.third_party_capabilities ?? [];
    const total = builtin.length + tp.length;
    expect(total, 'expected at least one capability in catalog').toBeGreaterThan(0);
  });
});
