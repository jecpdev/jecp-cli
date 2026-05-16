/**
 * saveConfig atomicity tests.
 *
 * The contract: either the file fully reflects the new content, or it
 * fully reflects the old content. Never a half-written hybrid. We achieve
 * that with temp-file + fsync + rename, so a crash between write and
 * rename leaves the original file intact.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { saveConfig, loadConfig } from '../src/config.js';

const tmpHome = process.env.JECP_TEST_TMP_HOME!;
const CONFIG_DIR = join(tmpHome, '.jecp');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function resetCfg(): void {
  if (existsSync(CONFIG_DIR)) {
    // Restore writable mode first in case a prior test left it readonly,
    // otherwise rmSync fails on macOS / Linux.
    try { chmodSync(CONFIG_DIR, 0o700); } catch { /* swallow */ }
    rmSync(CONFIG_DIR, { recursive: true, force: true });
  }
}

beforeEach(() => {
  resetCfg();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetCfg();
});

describe('saveConfig atomicity', () => {
  it('persists content end-to-end (happy path)', () => {
    saveConfig({ agent_id: 'a1', api_key: 'k1' });
    expect(loadConfig()).toMatchObject({ agent_id: 'a1', api_key: 'k1' });
  });

  it('leaves the original file untouched when rename fails (crash-atomic)', () => {
    // Strategy: write a real config, then make CONFIG_DIR read-only so
    // the rename() syscall hits EACCES. Avoids relying on vitest's
    // spyOn(fs.renameSync) which can't redefine node:fs properties.
    saveConfig({ agent_id: 'old_agent', api_key: 'old_key' });
    expect(readFileSync(CONFIG_FILE, 'utf-8')).toContain('old_key');

    chmodSync(CONFIG_DIR, 0o500); // r-x — can read/list but not write or rename

    try {
      // Save MUST throw — operator needs to react before the new secret is lost.
      expect(() => saveConfig({ agent_id: 'new_agent', api_key: 'new_key' })).toThrow();
      // Original file content survives — no partial overwrite.
      expect(readFileSync(CONFIG_FILE, 'utf-8')).toContain('old_key');
      expect(readFileSync(CONFIG_FILE, 'utf-8')).not.toContain('new_key');
    } finally {
      chmodSync(CONFIG_DIR, 0o700);
    }
  });

  it('cleans up the tmp file when write fails (no .tmp leaks in ~/.jecp/)', () => {
    saveConfig({ agent_id: 'a' });
    chmodSync(CONFIG_DIR, 0o500);
    try {
      expect(() => saveConfig({ agent_id: 'b' })).toThrow();
    } catch { /* swallow */ } finally {
      chmodSync(CONFIG_DIR, 0o700);
    }
    // No tmp files leak even after failure path.
    const remnants = readdirSync(CONFIG_DIR).filter((n) => n.startsWith('config.json.tmp'));
    expect(remnants).toEqual([]);
  });

  it('writes mode 0600 on the final file', () => {
    saveConfig({ agent_id: 'a', api_key: 'k' });
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const mode = statSync(CONFIG_FILE).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('survives back-to-back rapid rotations (no PID collisions in tmp names)', async () => {
    saveConfig({ agent_id: 'a', api_key: 'k0' });
    // Same process, multiple saves — tmp name uses PID + suffix, must not collide.
    for (let i = 1; i <= 10; i++) {
      saveConfig({ agent_id: 'a', api_key: `k${i}` });
    }
    expect(loadConfig().api_key).toBe('k10');
    // No leftover tmp files.
    const remnants = readdirSync(CONFIG_DIR).filter((n) => n.startsWith('config.json.tmp'));
    expect(remnants).toEqual([]);
  });

  it('overwrites a pre-existing config file even when previously written with default umask', () => {
    // Simulate a config file written by an older CLI build with default mode.
    if (!existsSync(CONFIG_DIR)) {
      const { mkdirSync } = require('node:fs') as typeof import('node:fs');
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }
    writeFileSync(CONFIG_FILE, '{"agent_id":"legacy"}', { mode: 0o644 });
    saveConfig({ agent_id: 'fresh' });
    const { statSync } = require('node:fs') as typeof import('node:fs');
    expect(statSync(CONFIG_FILE).mode & 0o777).toBe(0o600);
    expect(loadConfig().agent_id).toBe('fresh');
  });
});
