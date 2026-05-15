/**
 * Unit tests for v0.7.0 x402 helpers.
 *
 * Focus on the address validator — it's the only piece of pure logic.
 * Network-touching code paths (doctor, signer build) require integration
 * fixtures and are deferred to the smoke harness.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidBaseAddress,
  normalizeAddress,
} from '../src/x402/config-ext.js';

describe('isValidBaseAddress', () => {
  it('accepts the 0x + 40 hex form (lowercase)', () => {
    expect(isValidBaseAddress('0xab11cd22ef33aabbccddeeff0011223344556677')).toBe(true);
  });

  it('accepts the 0x + 40 hex form (mixed case / EIP-55 checksum-shaped)', () => {
    expect(isValidBaseAddress('0xAb11Cd22Ef33aaBBCcDDeeFF0011223344556677')).toBe(true);
  });

  it('rejects strings shorter than 42 chars', () => {
    expect(isValidBaseAddress('0xab11')).toBe(false);
  });

  it('rejects strings longer than 42 chars', () => {
    expect(isValidBaseAddress('0xab11cd22ef33aabbccddeeff001122334455667700')).toBe(false);
  });

  it('rejects missing 0x prefix', () => {
    expect(isValidBaseAddress('ab11cd22ef33aabbccddeeff0011223344556677')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidBaseAddress('0xZZZZcd22ef33aabbccddeeff0011223344556677')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidBaseAddress('')).toBe(false);
  });

  it('rejects whitespace-padded valid address (caller must trim)', () => {
    expect(isValidBaseAddress(' 0xab11cd22ef33aabbccddeeff0011223344556677 ')).toBe(false);
  });
});

describe('normalizeAddress', () => {
  it('lowercases a mixed-case valid address', () => {
    const result = normalizeAddress('0xAb11Cd22Ef33aaBBCcDDeeFF0011223344556677');
    expect(result).toBe('0xab11cd22ef33aabbccddeeff0011223344556677');
  });

  it('passes through an already-lowercase address', () => {
    const result = normalizeAddress('0xab11cd22ef33aabbccddeeff0011223344556677');
    expect(result).toBe('0xab11cd22ef33aabbccddeeff0011223344556677');
  });

  it('throws on invalid input', () => {
    expect(() => normalizeAddress('0xZZZ')).toThrow(/Not a valid Ethereum address/);
  });

  it('rejects uppercase 0X prefix (canonical form requires lowercase x)', () => {
    expect(() => normalizeAddress('0XAB11CD22EF33AABBCCDDEEFF0011223344556677')).toThrow(
      /Not a valid Ethereum address/,
    );
  });
});
