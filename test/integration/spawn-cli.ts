/**
 * Helper for spawning the built `dist/cli.js` inside integration tests.
 *
 * - Resolves the CLI entry from the repo root, regardless of test cwd.
 * - Sandboxes HOME to a per-process temp dir so a real user's
 *   `~/.jecp/config.json` is never touched.
 * - Captures stdout + stderr separately. The CLI emits human text on
 *   stdout in non-JSON mode and on stdout (JSON) in `--json` mode; we
 *   capture both streams unconditionally.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// test/integration/spawn-cli.ts  → ../../  is the repo root
const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_PATH = resolve(REPO_ROOT, 'dist', 'cli.js');

export interface RunCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  /** Additional env vars to merge over the parent env. */
  env?: Record<string, string>;
  /** Override the spawn working directory. Defaults to a temp dir. */
  cwd?: string;
  /** Stdin to feed. Defaults to no stdin. */
  stdin?: string;
  /** Per-invocation timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/**
 * Spawn `node dist/cli.js <args>` with a sandboxed HOME and return the
 * captured streams. Throws if the timeout elapses.
 */
export function runCli(args: string[], opts: RunCliOptions = {}): Promise<RunCliResult> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `CLI artifact not found at ${CLI_PATH}. Run \`npm run build\` first.`,
    );
  }

  const sandboxHome = mkdtempSync(`${tmpdir()}/jecp-cli-itest-`);
  const cwd = opts.cwd ?? sandboxHome;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: sandboxHome,
    // Strip credentials env vars so doctor / status don't accidentally
    // pick up the developer's keys. CLI accepts both JECP_API_KEY (preferred)
    // and JECP_AGENT_KEY (legacy, deprecated) — strip BOTH so the legacy
    // path never silently leaks through.
    JECP_AGENT_ID: undefined as unknown as string,
    JECP_API_KEY: undefined as unknown as string,
    JECP_AGENT_KEY: undefined as unknown as string,
    JECP_PROVIDER_API_KEY: undefined as unknown as string,
    JECP_BASE_URL: undefined as unknown as string,
    ...(opts.env ?? {}),
  };
  // Clean undefined keys so spawn() doesn't get tripped up.
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }

  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });

  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<RunCliResult>((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectP(new Error(
        `CLI invocation timed out after ${timeoutMs}ms.\n` +
        `args: ${JSON.stringify(args)}\n` +
        `stdout so far: ${stdout.slice(-500)}\n` +
        `stderr so far: ${stderr.slice(-500)}`,
      ));
    }, timeoutMs);

    if (opts.stdin) child.stdin.write(opts.stdin);
    child.stdin.end();

    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

export const HUB_BASE_URL = process.env.JECP_TEST_BASE_URL ?? 'https://setsuna-jobdonebot.fly.dev';
