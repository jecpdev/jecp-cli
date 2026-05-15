/**
 * Lazy JecpClient construction — uses resolveAuth() for credentials.
 *
 * v0.7.0 adds `getClientWithPayment()` for the x402 path. The original
 * `getClient()` remains for non-payment commands (catalog, status, etc.).
 */

import { JecpClient } from '@jecpdev/sdk';
import type { PaymentMode, Signer } from '@jecpdev/sdk';
import { resolveAuth, loadConfig } from './config.js';
import { fail, warn } from './output.js';

export function getClient(): JecpClient {
  const { agentId, apiKey, baseUrl } = resolveAuth();
  if (!agentId || !apiKey) {
    fail('Not logged in. Run `jecp login` or `jecp register`.');
  }
  return new JecpClient({
    agentId: agentId!,
    apiKey: apiKey!,
    ...(baseUrl && { baseUrl }),
  });
}

export function getBaseUrl(): string {
  return resolveAuth().baseUrl ?? 'https://jecp.dev';
}

/**
 * v0.7.0 — Build a JecpClient honoring `--pay` flag + persisted x402 config.
 *
 * The CLI does NOT load private keys itself. When mode requires a signer, the
 * CLI builds a thin adapter that delegates to whatever the user configured
 * (env / file / kms). If the signer source is missing, we fall back to
 * wallet mode with a warning rather than crashing — the agent can still
 * top up via Stripe.
 */
export function getClientWithPayment(opts: { pay?: PaymentMode }): JecpClient {
  const auth = resolveAuth();
  if (!auth.agentId || !auth.apiKey) {
    fail('Not logged in. Run `jecp login` or `jecp register`.');
  }

  const cfg = loadConfig();
  const mode: PaymentMode = opts.pay ?? cfg.x402_pay_default ?? 'auto';

  let signer: Signer | undefined;
  if (mode === 'x402' || mode === 'auto') {
    signer = tryBuildSignerFromConfig(cfg);
    if (mode === 'x402' && !signer) {
      fail('--pay x402 requires a linked Base wallet. Run `jecp wallet:link-usdc <address>` first.');
    }
  }

  return new JecpClient({
    agentId: auth.agentId!,
    apiKey: auth.apiKey!,
    ...(auth.baseUrl && { baseUrl: auth.baseUrl }),
    payment: {
      mode,
      ...(signer && { signer }),
    },
  });
}

/**
 * Build a Signer adapter from config. Returns undefined if no key source
 * is configured — caller decides whether that's an error.
 *
 * Implementations are intentionally minimal here; advanced users should
 * inject their own Signer when scripting against `@jecpdev/sdk` directly.
 */
function tryBuildSignerFromConfig(cfg: ReturnType<typeof loadConfig>): Signer | undefined {
  if (!cfg.x402_wallet_address) return undefined;

  switch (cfg.x402_signer_kind ?? 'env') {
    case 'env': {
      const key = process.env.BASE_PRIVATE_KEY;
      if (!key) {
        warn('BASE_PRIVATE_KEY env var not set; x402 signing will fail. ' +
             'Export it before invoking, or use --pay wallet.');
        return undefined;
      }
      return buildEthersSigner(cfg.x402_wallet_address, key);
    }
    case 'file': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readFileSync } = require('fs') as typeof import('fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { homedir } = require('os') as typeof import('os');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { join } = require('path') as typeof import('path');
        const keyPath = join(homedir(), '.jecp', 'base-key.txt');
        const key = readFileSync(keyPath, 'utf-8').trim();
        return buildEthersSigner(cfg.x402_wallet_address, key);
      } catch {
        warn('Could not read ~/.jecp/base-key.txt; x402 signing unavailable.');
        return undefined;
      }
    }
    case 'kms':
      warn('KMS signer kind requires user code — CLI cannot autoload. Use SDK directly.');
      return undefined;
  }
}

/**
 * Build a Signer adapter using ethers if available; otherwise return undefined
 * with a clear hint. ethers is not a hard dep of the CLI (locked design rule:
 * avoid adding npm deps that bloat install).
 */
function buildEthersSigner(_address: `0x${string}`, _privateKey: string): Signer | undefined {
  try {
    // ethers is a runtime-optional dep — type-check tolerantly via any.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const ethers = require('ethers') as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallet = new (ethers as any).Wallet(_privateKey);
    return {
      async getAddress() {
        return (wallet.address ?? wallet.getAddress()) as `0x${string}`;
      },
      async signEIP3009(p) {
        const sig: string = await wallet.signTypedData(
          { name: 'USD Coin', version: '2', chainId: p.chainId, verifyingContract: p.verifyingContract },
          { TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ] },
          { from: p.from, to: p.to, value: p.value, validAfter: p.validAfter, validBefore: p.validBefore, nonce: p.nonce },
        );
        const r = ('0x' + sig.slice(2, 66)) as `0x${string}`;
        const s = ('0x' + sig.slice(66, 130)) as `0x${string}`;
        const v = parseInt(sig.slice(130, 132), 16);
        return { v, r, s };
      },
    };
  } catch {
    warn('ethers not installed. Install with `npm i -g ethers` or use SDK directly with your preferred wallet adapter.');
    return undefined;
  }
}
