/**
 * x402 config helpers (CLI v0.7.0).
 *
 * The persisted shape lives in `../config.ts` (CliConfig). This file owns
 * the address validators + a re-exported `JecpCliConfig` alias so x402
 * commands import a single, semantically-named type.
 *
 * Locked design §6.3 — Developer UX.
 */

import type { CliConfig } from '../config.js';

/** Alias for the persisted config when read from x402-aware code paths. */
export type JecpCliConfig = CliConfig;

/**
 * Strict address validator — 0x + 40 hex chars. Per locked design §3.3
 * the Hub will reject malformed addresses with X402_PAYMENT_INVALID, so
 * we catch them at config time for a better error message.
 */
export function isValidBaseAddress(addr: string): addr is `0x${string}` {
  return /^0x[a-fA-F0-9]{40}$/.test(addr);
}

/**
 * Normalize a user-supplied address to checksum-able lowercase form.
 * (Full EIP-55 checksum verification would require keccak256; we accept
 * any well-formed hex and let the chain reject if wrong.)
 */
export function normalizeAddress(addr: string): `0x${string}` {
  if (!isValidBaseAddress(addr)) {
    throw new Error(`Not a valid Ethereum address (must be 0x + 40 hex chars): ${addr}`);
  }
  return ('0x' + addr.slice(2).toLowerCase()) as `0x${string}`;
}
