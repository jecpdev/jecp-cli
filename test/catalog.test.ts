/**
 * `jecp catalog` tests.
 *
 * The catalog is a public Hub endpoint, so the command must work before
 * `jecp register` / `jecp login`. fetch is stubbed; HOME is redirected by
 * test/setup.ts so no real ~/.jecp/config.json is read.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { catalogCmd } from '../src/commands/catalog.js';
import { setJsonMode } from '../src/output.js';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
if (!tmpHome) throw new Error('test/setup.ts did not run');

const AUTH_ENV = ['JECP_API_KEY', 'JECP_AGENT_KEY', 'JECP_AGENT_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

function catalogResponse(): Response {
  return new Response(
    JSON.stringify({ capabilities: [], third_party_capabilities: [], has_more: false, page_size: 50 }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

beforeEach(() => {
  if (existsSync(join(tmpHome, '.jecp'))) {
    rmSync(join(tmpHome, '.jecp'), { recursive: true, force: true });
  }
  for (const k of AUTH_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.restoreAllMocks();
  setJsonMode(true);
});

afterEach(() => {
  for (const k of AUTH_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setJsonMode(false);
});

describe('catalogCmd', () => {
  it('works without saved credentials and sends no auth headers', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(catalogResponse());
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await catalogCmd({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v1/capabilities');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['X-Agent-ID']).toBeUndefined();
  });

  it('passes --cursor through to the Hub', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(catalogResponse());
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await catalogCmd({ cursor: 'cur_abc', pageSize: '10' });

    const url = String(fetchSpy.mock.calls[0]![0]);
    expect(url).toContain('cursor=cur_abc');
    expect(url).toContain('page_size=10');
  });
});
