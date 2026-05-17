/**
 * Integration test — `jecp --help` lists the documented top-level commands.
 *
 * Pure-local check (no network). Catches the regression where a refactor
 * of `src/cli.ts` accidentally drops a top-level command from the
 * commander tree (which would silently break the user-facing UX).
 */

import { describe, it, expect } from 'vitest';
import { runCli } from './spawn-cli.js';

describe('integration: cli --help', () => {
  it('exits 0 and lists the documented top-level commands', async () => {
    const r = await runCli(['--help']);

    expect(r.exitCode).toBe(0);

    // The full surface area we want to keep visible. If commander silently
    // drops one of these, the user-facing UX regresses and we won't notice
    // without an integration check.
    const required = [
      'register',
      'login',
      'logout',
      'invoke',
      'wallet:link-usdc',
      'catalog',
      'topup',
      'status',
      'doctor',
      'rotate-key',
      'init-provider',
      'refund',
      'provider',
      'webhook',
    ];

    for (const cmd of required) {
      expect(r.stdout, `missing command: ${cmd}`).toContain(cmd);
    }
  });

  it('exits 0 and lists provider subcommands under `jecp provider --help`', async () => {
    const r = await runCli(['provider', '--help']);

    expect(r.exitCode).toBe(0);

    // Subcommands documented in the README + CHANGELOG. `validate` was the
    // 0.8.2 addition — surface this so any refactor that drops it fails.
    const requiredSub = [
      'register',
      'verify-dns',
      'me',
      'rotate-key',
      'validate',
      'publish',
      'connect-stripe',
    ];

    for (const sub of requiredSub) {
      expect(r.stdout, `missing provider subcommand: ${sub}`).toContain(sub);
    }
  });

  it('exits 0 and reports a semver version on --version', async () => {
    const r = await runCli(['--version']);
    expect(r.exitCode).toBe(0);
    // commander prints just the version on stdout
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
