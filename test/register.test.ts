/**
 * `jecp register` tests — free-call display.
 *
 * The Hub no longer grants free calls. When the registration response
 * carries no free-call count, the CLI must report 0 (not a hardcoded 100)
 * and must not print a "Free calls" line.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerCmd } from '../src/commands/register.js';
import { setJsonMode } from '../src/output.js';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
if (!tmpHome) throw new Error('test/setup.ts did not run');

function registerResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  if (existsSync(join(tmpHome, '.jecp'))) {
    rmSync(join(tmpHome, '.jecp'), { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  setJsonMode(false);
});

describe('registerCmd', () => {
  it('reports 0 free calls when the Hub response has no free-call count', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      registerResponse({ agent_id: 'jdb_ag_test', api_key: 'jdb_ak_test' }),
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    setJsonMode(true);

    await registerCmd({ name: 'TestBot', type: 'demo' });

    const payload = JSON.parse(out.join(''));
    expect(payload.agent_id).toBe('jdb_ag_test');
    expect(payload.free_calls_remaining).toBe(0);
  });

  it('does not print a "Free calls" line when there are none', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      registerResponse({ agent_id: 'jdb_ag_test', api_key: 'jdb_ak_test', benefits: { free_api_calls: 0 } }),
    );
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await registerCmd({ name: 'TestBot', type: 'demo' });

    expect(lines.some((l) => l.includes('AGENT_ID'))).toBe(true);
    expect(lines.some((l) => l.includes('Free calls'))).toBe(false);
  });
});
