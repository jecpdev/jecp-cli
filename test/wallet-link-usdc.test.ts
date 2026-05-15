/**
 * Smoke test for `jecp wallet:link-usdc` — exercises the command end-to-end
 * against a temporary HOME directory so the real ~/.jecp is untouched.
 *
 * HOME is redirected by `test/setup.ts` (configured in vitest.config.ts
 * `setupFiles`) BEFORE any module loads, so `src/config.ts` captures the
 * tmp HOME at its top-level `homedir()` call.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { walletLinkUsdcCmd } from '../src/commands/wallet-link-usdc.js';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
if (!tmpHome) throw new Error('test/setup.ts did not run');

describe('walletLinkUsdcCmd', () => {
  it('persists a valid address + signer kind to ~/.jecp/config.json', async () => {
    await walletLinkUsdcCmd('0xAb11Cd22Ef33aaBBCcDDeeFF0011223344556677', {
      signer: 'env',
    });

    const cfgPath = join(tmpHome, '.jecp', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.x402_wallet_address).toBe('0xab11cd22ef33aabbccddeeff0011223344556677');
    expect(cfg.x402_signer_kind).toBe('env');
  });

  it('also persists default pay mode when --default is passed', async () => {
    await walletLinkUsdcCmd('0xab11cd22ef33aabbccddeeff0011223344556677', {
      signer: 'file',
      default: 'x402',
    });

    const cfg = JSON.parse(readFileSync(join(tmpHome, '.jecp', 'config.json'), 'utf-8'));
    expect(cfg.x402_signer_kind).toBe('file');
    expect(cfg.x402_pay_default).toBe('x402');

    // Reset for next test.
    rmSync(join(tmpHome, '.jecp'), { recursive: true, force: true });
  });

  it('exits the process on invalid address (process.exit(1))', async () => {
    // Spy `exit` so the test runner doesn't actually die. The downstream
    // command continues past `fail()` with `undefined` state (cosmetic
    // noise in stdout) — we only assert exit-called-with-1.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await walletLinkUsdcCmd('not-an-address', { signer: 'env' }).catch(() => undefined);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
