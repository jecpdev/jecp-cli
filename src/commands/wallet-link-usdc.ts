/**
 * `jecp wallet:link-usdc <address> [--signer <kind>] [--default <mode>]`
 *
 * Stores the agent's Base wallet address in ~/.jecp/config.json so subsequent
 * `jecp invoke --pay x402` calls know where the SDK should source the signer.
 *
 * The CLI does NOT hold private keys. The `--signer` flag is a hint stored
 * in config (`env` / `file` / `kms`) so downstream scripts can resolve the
 * key consistently. The default is `env` (expects `BASE_PRIVATE_KEY` env var
 * to be set when the SDK runs).
 *
 * Locked design §6.3 + Panel 4 §B.2.
 */

import { info, success, fail, emit, bold, dim } from '../output.js';
import { loadConfig, saveConfig } from '../config.js';
import { normalizeAddress } from '../x402/config-ext.js';

export interface WalletLinkUsdcOpts {
  /** How the SDK should source the private key. Default `env`. */
  signer?: 'env' | 'file' | 'kms';
  /** Optional default --pay mode to set in config simultaneously. */
  default?: 'wallet' | 'x402' | 'auto';
}

export async function walletLinkUsdcCmd(address: string, opts: WalletLinkUsdcOpts): Promise<void> {
  let normalized: `0x${string}`;
  try {
    normalized = normalizeAddress(address);
  } catch (e) {
    fail((e as Error).message);
  }

  const signerKind = opts.signer ?? 'env';
  if (!['env', 'file', 'kms'].includes(signerKind)) {
    fail(`--signer must be one of: env, file, kms (got "${signerKind}")`);
  }

  const cfg = loadConfig();
  cfg.x402_wallet_address = normalized!;
  cfg.x402_signer_kind = signerKind;
  if (opts.default) {
    if (!['wallet', 'x402', 'auto'].includes(opts.default)) {
      fail(`--default must be one of: wallet, x402, auto (got "${opts.default}")`);
    }
    cfg.x402_pay_default = opts.default;
  }
  saveConfig(cfg);

  success(`Linked Base wallet address: ${normalized!}`);
  info(`${dim('signer kind:')}    ${signerKind}`);
  if (opts.default) {
    info(`${dim('default pay mode:')} ${opts.default}`);
  }
  info('');
  info(bold('Next steps:'));
  switch (signerKind) {
    case 'env':
      info(`  export BASE_PRIVATE_KEY=0x...   ${dim('# the private key for ' + normalized!)}`);
      break;
    case 'file':
      info(`  Save private key to ${dim('~/.jecp/base-key.txt')} with chmod 600`);
      break;
    case 'kms':
      info(`  Configure AWS KMS credentials; SDK will use ${dim('@jecpdev/sdk/signers/kms')}`);
      break;
  }
  info(`  Verify: ${dim('$')} jecp doctor`);
  info(`  Invoke: ${dim('$')} jecp invoke --pay x402 namespace/capability action --input '{}'`);

  emit({
    wallet_address: normalized!,
    signer_kind: signerKind,
    default_pay_mode: opts.default ?? null,
  });
}
