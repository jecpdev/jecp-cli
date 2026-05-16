/**
 * Doctor provider-readiness section tests.
 *
 * Hits runProviderChecks directly (not doctorCmd) so we don't have to mock
 * every other check the full diagnostic runs (Hub /health, npm registry,
 * Base RPC, etc.). The function takes a `checks` array by reference and
 * mutates it — same shape as runX402Checks.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { saveConfig } from '../src/config.js';
import { runProviderChecks } from '../src/commands/doctor.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;

function resetCfg(): void {
  const dir = join(tmpHome, '.jecp');
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  resetCfg();
  vi.restoreAllMocks();
});

describe('runProviderChecks', () => {
  it('skips silently when no provider creds are configured', async () => {
    const checks: { name: string; ok: boolean }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await runProviderChecks(checks, 'https://jecp.dev');
    expect(checks).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports auth + dns + stripe + status when fully verified', async () => {
    saveConfig({
      provider_id: 'p1',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_x',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        provider_id: 'p1',
        namespace: 'tester',
        display_name: 'Tester Co',
        status: 'active',
        dns_verified: true,
        stripe_verified: true,
        endpoint_url: 'https://tester.example/jecp',
        total_calls: 100,
      }),
    );
    const checks: { name: string; ok: boolean }[] = [];
    await runProviderChecks(checks, 'https://jecp.dev');

    const names = checks.map((c) => c.name);
    expect(names).toContain('provider.auth');
    expect(names).toContain('provider.dns_verified');
    expect(names).toContain('provider.stripe_verified');
    expect(names).toContain('provider.status');
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('flags dns_verified=false and stripe_verified=false as failing checks', async () => {
    saveConfig({
      provider_id: 'p1',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_x',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        provider_id: 'p1',
        namespace: 'tester',
        display_name: 'Tester Co',
        status: 'submitted',
        dns_verified: false,
        stripe_verified: false,
        endpoint_url: 'https://tester.example/jecp',
        total_calls: 0,
      }),
    );
    const checks: { name: string; ok: boolean }[] = [];
    await runProviderChecks(checks, 'https://jecp.dev');

    const byName = Object.fromEntries(checks.map((c) => [c.name, c.ok]));
    expect(byName['provider.auth']).toBe(true);
    expect(byName['provider.dns_verified']).toBe(false);
    expect(byName['provider.stripe_verified']).toBe(false);
    expect(byName['provider.status']).toBe(false);
  });

  it('treats 401 as a recoverable auth failure with actionable hint', async () => {
    saveConfig({
      provider_id: 'p1',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_stale',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ error: 'INVALID_PROVIDER_KEY' }, 401),
    );
    const checks: { name: string; ok: boolean; detail?: string }[] = [];
    await runProviderChecks(checks, 'https://jecp.dev');

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe('provider.auth');
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toMatch(/401/);
  });

  it('reports network failure without throwing', async () => {
    saveConfig({
      provider_id: 'p1',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_x',
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const checks: { name: string; ok: boolean; detail?: string }[] = [];
    await runProviderChecks(checks, 'https://jecp.dev');

    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(false);
    expect(checks[0]?.detail).toMatch(/ECONNREFUSED/);
  });
});
