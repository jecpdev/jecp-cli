/**
 * Integration test — `jecp doctor --json --base-url=$JECP_TEST_BASE_URL`.
 *
 * Runs the diagnostic against a live Hub and asserts the result envelope.
 *
 * NOTE on `all_ok`: doctor combines Hub-health checks with local checks
 * (config file presence, x402 signer, etc.) that won't be configured in
 * a CI sandbox. We therefore do NOT assert `all_ok === true`. Instead we:
 *
 *   - assert the documented shape `{ checks: [...], all_ok: bool }`
 *   - assert `hub_health` is present and ok (the live Hub probe is the
 *     point of this test)
 *   - record which checks failed for visibility in the test log
 */

import { describe, it, expect } from 'vitest';
import { runCli, HUB_BASE_URL } from './spawn-cli.js';

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
  latency_ms?: number;
}

interface DoctorOutput {
  checks: Check[];
  all_ok: boolean;
}

describe(`integration: cli doctor --json against ${HUB_BASE_URL}`, () => {
  it('exits 0 with the documented JSON envelope and a healthy Hub probe', async () => {
    const r = await runCli([
      '--json',
      `--base-url=${HUB_BASE_URL}`,
      'doctor',
    ]);

    // Doctor never exits non-zero just because some local checks fail; it
    // emits the per-check rollup and exits 0. (If this regresses to
    // `process.exit(1)` on local failures, the test will catch it.)
    expect(r.exitCode).toBe(0);

    // stdout MUST be valid JSON with the documented shape.
    let parsed: DoctorOutput;
    try {
      parsed = JSON.parse(r.stdout) as DoctorOutput;
    } catch (e) {
      throw new Error(
        `doctor --json did not emit valid JSON.\nstdout:\n${r.stdout.slice(0, 2000)}\nstderr:\n${r.stderr.slice(0, 1000)}`,
      );
    }

    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(typeof parsed.all_ok).toBe('boolean');
    expect(parsed.checks.length).toBeGreaterThan(0);

    // Each check item has the documented schema.
    for (const c of parsed.checks) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.ok).toBe('boolean');
      if (c.detail !== undefined) expect(typeof c.detail).toBe('string');
      if (c.latency_ms !== undefined) expect(typeof c.latency_ms).toBe('number');
    }

    // Hub-health is the check this integration test specifically wants
    // to enforce. If hub_health is failing, the Hub is dead or unreachable
    // from CI — that's a real signal worth blocking on.
    const hubHealth = parsed.checks.find((c) => c.name === 'hub_health');
    expect(hubHealth, `doctor did not emit hub_health check; got ${parsed.checks.map((c) => c.name).join(',')}`).toBeDefined();
    expect(hubHealth!.ok, `hub_health failed: ${hubHealth!.detail ?? '(no detail)'}`).toBe(true);

    // The pool partitioning check should also pass against a fresh Hub
    // (S0 bulkhead is GA). If it ever flips to false we want to know.
    const pools = parsed.checks.find((c) => c.name === 'hub_pools');
    if (pools) {
      expect(pools.ok, `hub_pools failed: ${pools.detail ?? '(no detail)'}`).toBe(true);
    }

    // Soft visibility: print local-check failures so test runs surface them
    // without failing the suite (these aren't part of the live-Hub contract).
    const failed = parsed.checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    if (failed.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[integration] local checks reported failure (expected in CI): ${failed.join(', ')}`);
    }
  });
});
