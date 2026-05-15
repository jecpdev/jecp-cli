/**
 * Persistent CLI config at ~/.jecp/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG_DIR = join(homedir(), '.jecp');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export interface CliConfig {
  agent_id?: string;
  api_key?: string;
  base_url?: string;
  default_namespace?: string;
  /** v0.7.0 — Base wallet address (Checksum or lowercase 0x40 hex). */
  x402_wallet_address?: `0x${string}`;
  /**
   * v0.7.0 — How the SDK should access the private key when it builds a
   * Signer. The CLI itself does NOT hold private keys; this is a hint for
   * downstream scripts.
   */
  x402_signer_kind?: 'env' | 'file' | 'kms';
  /** v0.7.0 — Default `--pay` mode if the flag is omitted. */
  x402_pay_default?: 'wallet' | 'x402' | 'auto';
}

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as CliConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  chmodSync(CONFIG_FILE, 0o600);
}

/** Resolve credentials with env-var priority over config file. */
export function resolveAuth(): { agentId?: string; apiKey?: string; baseUrl?: string } {
  const cfg = loadConfig();
  return {
    agentId: process.env.JECP_AGENT_ID ?? cfg.agent_id,
    apiKey: process.env.JECP_AGENT_KEY ?? cfg.api_key,
    baseUrl: process.env.JECP_BASE_URL ?? cfg.base_url ?? 'https://jecp.dev',
  };
}

export function configFilePath(): string {
  return CONFIG_FILE;
}
