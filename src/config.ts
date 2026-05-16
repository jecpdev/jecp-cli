/**
 * Persistent CLI config at ~/.jecp/config.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
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

  // ── v0.8.0 — Provider credentials (issued once at register) ──
  // Stored separately from agent creds because the same operator may run
  // both an Agent (consumer) and a Provider (producer) from one machine.
  provider_id?: string;
  provider_namespace?: string;
  /** `jdb_pk_<48 hex>` — Bearer token for /v1/providers/* endpoints. */
  provider_api_key?: string;
  /** Base64 HMAC secret — used by Provider SDK to verify Hub-forwarded calls. */
  provider_hmac_secret?: string;
  /** TXT value to publish at `_jecp.<endpoint host>`. Kept so resume flows work. */
  provider_dns_token?: string;
}

export function loadConfig(): CliConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Atomic config write — temp file + fsync + rename.
 *
 * Why this matters: commands like `jecp provider rotate-key` and
 * `jecp rotate-key` save a freshly-issued api_key here. If the Hub has
 * already revoked the old key but the local write fails halfway
 * (disk full, perm change, partial-write on power-cut), the operator
 * is locked out — neither key works. The rename(2) syscall is atomic
 * on POSIX filesystems, so we write the new content to a sibling tmp
 * file, fsync it to durable storage, then rename over the real path.
 * Either the new content is fully visible or the old content is fully
 * visible — never a half-written hybrid.
 *
 * Throws on any underlying I/O error. Callers that hold a freshly-
 * issued secret MUST handle that throw and surface the secret to
 * stdout so the operator can paste it elsewhere before it's lost.
 */
export function saveConfig(cfg: CliConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${CONFIG_FILE}.tmp.${process.pid}`;
  const json = JSON.stringify(cfg, null, 2);
  let fd: number | undefined;
  try {
    // mode 0600 on creation closes a brief window where the file would
    // otherwise default to 0644 between write and chmod.
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, json);
    // fsync forces the page cache → disk so a crash between rename and
    // physical commit can't surface the rename without the data.
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, CONFIG_FILE);
    // Belt-and-braces: ensure mode is 0600 even if the umask or an
    // existing file overrode the openSync mode.
    chmodSync(CONFIG_FILE, 0o600);
  } catch (e) {
    // Clean up the tmp file before re-throwing so we don't leak
    // partially-written sibling files in ~/.jecp/.
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* swallow */ }
    }
    try { unlinkSync(tmpPath); } catch { /* swallow */ }
    throw e;
  }
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

/**
 * v0.8.0 — Resolve Provider credentials, env-var priority over config file.
 * Agent and Provider keys are independent: an operator may hold both, neither,
 * or one. Commands decide which is required and surface a clear error if
 * missing.
 */
export function resolveProviderAuth(): {
  providerId?: string;
  providerApiKey?: string;
  namespace?: string;
  baseUrl?: string;
} {
  const cfg = loadConfig();
  return {
    providerId: process.env.JECP_PROVIDER_ID ?? cfg.provider_id,
    providerApiKey: process.env.JECP_PROVIDER_KEY ?? cfg.provider_api_key,
    namespace: cfg.provider_namespace,
    baseUrl: process.env.JECP_BASE_URL ?? cfg.base_url ?? 'https://jecp.dev',
  };
}

export function configFilePath(): string {
  return CONFIG_FILE;
}
