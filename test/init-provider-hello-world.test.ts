/**
 * Hello-world scaffold tests.
 *
 * The interactive prompts in `initProviderCmd` are skipped via --example,
 * so we don't need to stub `prompts` here. Each test scaffolds into a
 * fresh subdirectory under the tmp HOME redirect from test/setup.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProviderCmd } from '../src/commands/init-provider.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'jecp-hello-'));
}

describe('initProviderCmd --example hello-world', () => {
  it('writes jecp.yaml, handler.mjs, package.json, README.md', async () => {
    const dir = freshDir();
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'hello-world', yes: true });

    expect(existsSync(join(dir, 'jecp.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'handler.mjs'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
  });

  it('handler.mjs imports JecpProvider and reads JECP_HMAC_SECRET', async () => {
    const dir = freshDir();
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'hello-world', yes: true });
    const handler = readFileSync(join(dir, 'handler.mjs'), 'utf-8');
    expect(handler).toMatch(/import \{ JecpProvider \} from ['"]@jecpdev\/sdk['"]/);
    expect(handler).toMatch(/JECP_HMAC_SECRET/);
    expect(handler).toMatch(/createServer/);
  });

  it('package.json is valid JSON declaring @jecpdev/sdk', async () => {
    const dir = freshDir();
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'hello-world', yes: true });
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'));
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies['@jecpdev/sdk']).toBeTruthy();
    expect(pkg.scripts.start).toBe('node handler.mjs');
  });

  it('jecp.yaml declares the echo action with correct shape', async () => {
    const dir = freshDir();
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'hello-world', yes: true });
    const yaml = readFileSync(join(dir, 'jecp.yaml'), 'utf-8');
    expect(yaml).toMatch(/namespace: hello-world/);
    expect(yaml).toMatch(/capability: echo/);
    expect(yaml).toMatch(/version: 1\.0\.0/);
    expect(yaml).toMatch(/- id: echo/);
    expect(yaml).toMatch(/endpoint: "https:\/\/YOUR_PUBLIC_URL\/jecp"/);
  });

  it('refuses to overwrite an existing handler.mjs without renaming', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'handler.mjs'), '// preexisting', 'utf-8');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'hello-world', yes: true }).catch(
      () => undefined,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(readFileSync(join(dir, 'handler.mjs'), 'utf-8')).toBe('// preexisting');
    exitSpy.mockRestore();
  });

  it('bare --example still produces a single-file YAML stub (legacy path)', async () => {
    const dir = freshDir();
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: true, yes: true });
    expect(existsSync(join(dir, 'jecp.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'handler.mjs'))).toBe(false);
    expect(existsSync(join(dir, 'package.json'))).toBe(false);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });

  it('rejects an unknown --example template with a clear error', async () => {
    const dir = freshDir();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await initProviderCmd({ output: join(dir, 'jecp.yaml'), example: 'banana', yes: true }).catch(
      () => undefined,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
