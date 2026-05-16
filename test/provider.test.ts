/**
 * Provider lifecycle command tests.
 *
 * Strategy: stub `globalThis.fetch` per-test so we never hit the network,
 * exercise the auto-poll loop with synthetic responses, and assert that
 * credentials land in ~/.jecp/config.json (mode 0600). HOME is redirected
 * by test/setup.ts before any module import.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { saveConfig } from '../src/config.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import {
  providerRegisterCmd,
  providerVerifyDnsCmd,
  providerMeCmd,
  providerPublishCmd,
  providerRotateKeyCmd,
  parseTimeoutMs,
} from '../src/commands/provider.js';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
if (!tmpHome) throw new Error('test/setup.ts did not run');

const CONFIG_PATH = join(tmpHome, '.jecp', 'config.json');

function readCfg(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {};
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function resetCfg(): void {
  if (existsSync(join(tmpHome, '.jecp'))) {
    rmSync(join(tmpHome, '.jecp'), { recursive: true, force: true });
  }
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

describe('parseTimeoutMs', () => {
  it('defaults to 10 minutes', () => {
    expect(parseTimeoutMs(undefined)).toBe(10 * 60 * 1000);
  });
  it('parses bare seconds', () => {
    expect(parseTimeoutMs('300')).toBe(300_000);
  });
  it('parses suffixed durations', () => {
    expect(parseTimeoutMs('5m')).toBe(5 * 60_000);
    expect(parseTimeoutMs('1h')).toBe(60 * 60_000);
    expect(parseTimeoutMs('45s')).toBe(45_000);
  });
  it('caps at 1 hour', () => {
    expect(parseTimeoutMs('10h')).toBe(60 * 60_000);
  });
});

describe('providerRegisterCmd', () => {
  it('persists provider creds to config.json with mode 0600', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        provider_id: 'prov_abc123',
        namespace: 'tester',
        provider_api_key: 'jdb_pk_deadbeef'.padEnd(56, '0'),
        hmac_secret: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==',
        dns_verification_token: 'tok_xyz',
        next_steps: {},
      }, 201),
    );

    await providerRegisterCmd({
      namespace: 'tester',
      displayName: 'Tester Co',
      email: 'ops@tester.example',
      endpoint: 'https://tester.example/jecp',
      country: 'JP',
      yes: true,
    });

    const cfg = readCfg();
    expect(cfg.provider_id).toBe('prov_abc123');
    expect(cfg.provider_namespace).toBe('tester');
    expect(cfg.provider_api_key).toMatch(/^jdb_pk_/);
    expect(cfg.provider_hmac_secret).toBeTruthy();
    expect(cfg.provider_dns_token).toBe('tok_xyz');

    // Body sanity — country uppercased, namespace lowercased
    const callArgs = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((callArgs[1] as RequestInit).body as string);
    expect(body.country).toBe('JP');
    expect(body.namespace).toBe('tester');
    expect(body.endpoint_url).toBe('https://tester.example/jecp');
  });

  it('surfaces NAMESPACE_TAKEN with a recovery hint instead of dumping HTTP 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(
        { error: { code: 'NAMESPACE_TAKEN', message: "namespace 'tester' is already registered" } },
        409,
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await providerRegisterCmd({
      namespace: 'tester',
      displayName: 'Tester Co',
      email: 'ops@tester.example',
      endpoint: 'https://tester.example/jecp',
      country: 'JP',
      yes: true,
    }).catch(() => undefined);

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(readCfg()).toEqual({});
    exitSpy.mockRestore();
  });

  it('forwards optional usdc_payout_address lowercased', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        provider_id: 'p1',
        namespace: 't',
        provider_api_key: 'k',
        hmac_secret: 'YWFh',
        dns_verification_token: 'd',
        next_steps: {},
      }, 201),
    );
    await providerRegisterCmd({
      namespace: 'tester2',
      displayName: 'T',
      email: 'o@t.example',
      endpoint: 'https://t.example/j',
      country: 'us',
      usdcAddress: '0xABBA' + 'C'.repeat(36),
      yes: true,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.usdc_payout_address).toBe('0xabba' + 'c'.repeat(36));
    expect(body.country).toBe('US');
  });
});

describe('providerVerifyDnsCmd --once', () => {
  beforeEach(() => {
    saveConfig({
      provider_id: 'prov_abc',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_test',
    });
  });

  it('reports success when Hub returns verified=true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ verified: true, status: 'verified', message: 'ok' }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerVerifyDnsCmd({ once: true });
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('exits 2 when not yet verified (CI signal)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({ verified: false, status: 'pending', message: 'TXT not found' }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerVerifyDnsCmd({ once: true });
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it('aborts (exit 1) when no provider creds are saved', async () => {
    resetCfg();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerVerifyDnsCmd({ once: true }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('providerVerifyDnsCmd polling loop', () => {
  beforeEach(() => {
    saveConfig({
      provider_id: 'prov_abc',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_test',
    });
  });

  it('keeps polling on 404 / pending then succeeds — fake timers drive 10s ticks', async () => {
    // Sequence: attempt 1 → pending, attempt 2 → verified.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        mockJsonResponse(
          { error: { code: 'DNS_NOT_VERIFIED', message: 'TXT not found at _jecp.tester.example' } },
          404,
        ),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({ verified: true, status: 'verified', message: 'ok' }),
      );

    vi.useFakeTimers();
    const cmdPromise = providerVerifyDnsCmd({ timeout: '60s' });

    // First fetch fires immediately; advance past the 10s interval so the
    // poll loop hits attempt #2.
    await vi.advanceTimersByTimeAsync(10_000);
    await cmdPromise;
    vi.useRealTimers();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('treats 5xx as fatal — operators should see Hub errors, not silent retries', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(
        { error: { code: 'DB_ERROR', message: 'lookup failed' } },
        500,
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerVerifyDnsCmd({ once: true, timeout: '30s' }).catch(() => undefined);
    // singleVerifyAttempt fails fatally on 5xx via fail()
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('providerPublishCmd', () => {
  const yamlPath = join(tmpHome, 'jecp-publish-test.yaml');

  beforeEach(() => {
    saveConfig({
      provider_id: 'p1',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_test',
    });
    mkdirSync(tmpHome, { recursive: true });
    writeFileSync(yamlPath, 'namespace: tester\ncapability: hello\nversion: 1.0.0\n', 'utf-8');
  });

  it('POSTs YAML body with Content-Type: application/x-yaml', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(
        {
          capability_id: 'cap_abc',
          full_id: 'tester/hello',
          version: '1.0.0',
          status: 'active',
          action_count: 1,
          validation_warnings: [],
        },
        201,
      ),
    );

    await providerPublishCmd({ file: yamlPath });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/manifests$/);
    expect((init as RequestInit).method).toBe('POST');
    expect(((init as RequestInit).headers as Record<string, string>)['Content-Type']).toBe('application/x-yaml');
    expect((init as RequestInit).body).toContain('capability: hello');
  });

  it('maps VERSION_EXISTS to a bump-the-version hint', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(
        { error: { code: 'VERSION_EXISTS', message: "capability 'tester/hello' version '1.0.0' is already published" } },
        409,
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerPublishCmd({ file: yamlPath }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('aborts with a clear error when the manifest file is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerPublishCmd({ file: join(tmpHome, 'does-not-exist.yaml') }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('refuses to publish without provider creds', async () => {
    resetCfg();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerPublishCmd({ file: yamlPath }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('providerRotateKeyCmd', () => {
  beforeEach(() => {
    saveConfig({
      provider_id: 'prov_abc',
      provider_namespace: 'tester',
      provider_api_key: 'jdb_pk_old_key_value',
      provider_hmac_secret: 'YmFzZTY0X2htYWNfc2VjcmV0',
    });
  });

  it('persists the new api_key to config and leaves hmac_secret untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        jecp: '1.0',
        provider_id: 'prov_abc',
        namespace: 'tester',
        api_key: 'jdb_pk_new_key_value',
        api_key_prefix: 'jdb_pk_new_',
        previous_key_valid_until: '2026-05-23T05:00:00Z',
        grace_seconds: 604800,
        revoke_old: false,
        rotations_in_last_24h: 1,
        warning: 'This api_key is shown only once.',
      }),
    );

    await providerRotateKeyCmd({ yes: true });

    const cfg = readCfg();
    expect(cfg.provider_api_key).toBe('jdb_pk_new_key_value');
    // HMAC secret is on a separate lifecycle — never touched by rotate-key
    expect(cfg.provider_hmac_secret).toBe('YmFzZTY0X2htYWNfc2VjcmV0');
  });

  it('forwards --revoke-old + --grace-seconds in the request body', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        jecp: '1.0',
        provider_id: 'prov_abc',
        namespace: 'tester',
        api_key: 'jdb_pk_new',
        api_key_prefix: 'jdb_pk_new_',
        previous_key_valid_until: null,
        grace_seconds: 0,
        revoke_old: true,
        rotations_in_last_24h: 2,
        warning: 'previous key revoked',
      }),
    );

    await providerRotateKeyCmd({ yes: true, revokeOld: true, graceSeconds: '300' });

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.revoke_old).toBe(true);
    expect(body.grace_seconds).toBe(300);
  });

  it('surfaces ROTATION_24H_CAP with a recovery hint instead of a raw 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse(
        {
          error: {
            code: 'ROTATION_24H_CAP',
            message: 'Rotation limit exceeded (5 rotations in the last 24 h).',
          },
        },
        429,
      ),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerRotateKeyCmd({ yes: true }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // old key MUST stay in config when rotation is rejected
    expect(readCfg().provider_api_key).toBe('jdb_pk_old_key_value');
    exitSpy.mockRestore();
  });

  it('rejects --grace-seconds outside [60, 604800]', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerRotateKeyCmd({ yes: true, graceSeconds: '30' }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('aborts when no provider creds are saved', async () => {
    resetCfg();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerRotateKeyCmd({ yes: true }).catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('surfaces the new key on stdout if config save fails (anti-lockout)', async () => {
    // Force a real saveConfig failure by making CONFIG_DIR read-only.
    // The Hub has already revoked the old key, so swallowing the error
    // would lock the operator out. The fix: emit the new key to stdout
    // with a "PASTE NOW" warning instead of crashing silently.
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        jecp: '1.0',
        provider_id: 'prov_abc',
        namespace: 'tester',
        api_key: 'jdb_pk_brand_new_key',
        api_key_prefix: 'jdb_pk_bran',
        previous_key_valid_until: null,
        grace_seconds: 0,
        revoke_old: true,
        rotations_in_last_24h: 1,
        warning: 'previous key revoked',
      }),
    );

    // Make ~/.jecp/ readonly so the temp-file + rename inside saveConfig fails.
    const { chmodSync } = await import('node:fs');
    const cfgDir = join(tmpHome, '.jecp');
    chmodSync(cfgDir, 0o500);

    // Capture warnings — the new key + failure detail must surface there.
    // output.ts calls console.warn('⚠', msg) so we join all args.
    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    // The new key is also routed through info() (the success header block);
    // capture stdout too so we don't miss it in the search below.
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      await providerRotateKeyCmd({ yes: true, revokeOld: true });
    } finally {
      chmodSync(cfgDir, 0o700);
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }

    // The Hub-issued key MUST be in the operator-visible output. Without
    // this we'd be a lock-the-operator-out failure.
    const allOutput = [...logs, ...warnings].join('\n');
    expect(allOutput).toContain('jdb_pk_brand_new_key');
    const warnCombined = warnings.join('\n');
    expect(warnCombined.toUpperCase()).toContain('URGENT');
    expect(warnCombined.toLowerCase()).toMatch(/save fail|paste/);
  });
});

describe('providerMeCmd', () => {
  it('refuses to run without provider creds', async () => {
    resetCfg();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerMeCmd().catch(() => undefined);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('emits the parsed provider status', async () => {
    saveConfig({
      provider_id: 'p',
      provider_namespace: 'ns',
      provider_api_key: 'jdb_pk_x',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJsonResponse({
        provider_id: 'p',
        namespace: 'ns',
        display_name: 'NS Co',
        status: 'active',
        dns_verified: true,
        stripe_verified: false,
        endpoint_url: 'https://ns.example/jecp',
        total_calls: 42,
      }),
    );
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await providerMeCmd();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
