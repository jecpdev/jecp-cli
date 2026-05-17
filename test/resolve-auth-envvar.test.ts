/**
 * resolveAuth() env-var precedence tests.
 *
 * Contract:
 *   - JECP_API_KEY (new, preferred) wins over JECP_AGENT_KEY (legacy).
 *   - When only JECP_AGENT_KEY is set, the legacy var is honored AND a
 *     deprecation warning is written to stderr exactly once per process.
 *   - When both are set, JECP_API_KEY wins silently (no warning).
 *   - When neither is set, apiKey falls back to the saved config.
 *
 * This test exists because the v0.8 → v1.0 line keeps two env-var names
 * alive. Drift here (e.g. forgetting to honor either, or warning twice)
 * breaks CI scripts in user code, which is exactly the kind of thing
 * integration tests caught last cycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveAuth, saveConfig, __resetDeprecationWarningForTests } from '../src/config.js';
import { existsSync, rmSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
const CONFIG_DIR = join(tmpHome, '.jecp');

function resetCfg(): void {
  if (existsSync(CONFIG_DIR)) {
    try { chmodSync(CONFIG_DIR, 0o700); } catch { /* swallow */ }
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetCfg();
  delete process.env.JECP_API_KEY;
  delete process.env.JECP_AGENT_KEY;
  delete process.env.JECP_AGENT_ID;
  delete process.env.JECP_BASE_URL;
  __resetDeprecationWarningForTests();
});

describe('resolveAuth — env var precedence', () => {
  it('JECP_API_KEY set → picked up, no deprecation warning', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.JECP_API_KEY = 'jdb_ak_new_style';
    const { apiKey } = resolveAuth();
    expect(apiKey).toBe('jdb_ak_new_style');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('JECP_AGENT_KEY only → picked up + stderr deprecation warning', () => {
    const calls: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      calls.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
      return true;
    });
    process.env.JECP_AGENT_KEY = 'jdb_ak_legacy_style';
    const { apiKey } = resolveAuth();
    expect(apiKey).toBe('jdb_ak_legacy_style');
    // Warning fired exactly once on stderr.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('JECP_AGENT_KEY is deprecated');
    expect(calls[0]).toContain('JECP_API_KEY');
    expect(calls[0]).toContain('v0.10');
    spy.mockRestore();
  });

  it('JECP_AGENT_KEY warning fires at most once per process', () => {
    const calls: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      calls.push(typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8'));
      return true;
    });
    process.env.JECP_AGENT_KEY = 'jdb_ak_legacy';
    resolveAuth();
    resolveAuth();
    resolveAuth();
    expect(calls.length).toBe(1);
    spy.mockRestore();
  });

  it('both env vars set → JECP_API_KEY wins, no warning', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.env.JECP_API_KEY = 'jdb_ak_new';
    process.env.JECP_AGENT_KEY = 'jdb_ak_old';
    const { apiKey } = resolveAuth();
    expect(apiKey).toBe('jdb_ak_new');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('neither env var set → falls back to config file', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    saveConfig({ agent_id: 'jdb_ag_from_file', api_key: 'jdb_ak_from_file' });
    const { agentId, apiKey } = resolveAuth();
    expect(agentId).toBe('jdb_ag_from_file');
    expect(apiKey).toBe('jdb_ak_from_file');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('neither env var nor config → apiKey is undefined (existing behavior)', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { apiKey } = resolveAuth();
    expect(apiKey).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
