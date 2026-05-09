import { resolveAuth, configFilePath } from '../config.js';
import { existsSync } from 'node:fs';
import { emit, info, success, error, warn, bold } from '../output.js';

export async function doctorCmd() {
  info(bold('JECP CLI — Diagnostic Report'));
  info('─'.repeat(50));

  const auth = resolveAuth();
  const baseUrl = auth.baseUrl ?? 'https://jecp.dev';
  const cfgPath = configFilePath();
  const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];

  // 1. base URL reachable
  const start = Date.now();
  let reachable = false;
  try {
    const res = await fetch(`${baseUrl}/health`);
    const latency = Date.now() - start;
    reachable = res.ok;
    if (reachable) {
      success(`${baseUrl} reachable (${latency}ms)`);
      checks.push({ name: 'reachable', ok: true, detail: `${latency}ms` });
    } else {
      error(`${baseUrl}/health returned ${res.status}`);
      checks.push({ name: 'reachable', ok: false, detail: `${res.status}` });
    }
  } catch (e) {
    error(`Cannot reach ${baseUrl}: ${(e as Error).message}`);
    checks.push({ name: 'reachable', ok: false, detail: (e as Error).message });
  }

  // 2. config file
  if (existsSync(cfgPath)) {
    success(`Config file exists at ${cfgPath}`);
    checks.push({ name: 'config_file', ok: true, detail: cfgPath });
  } else {
    warn(`Config file not yet created (will be on first login/register)`);
    checks.push({ name: 'config_file', ok: false });
  }

  // 3. credentials present
  if (auth.agentId && auth.apiKey) {
    success(`Agent credentials configured (${auth.agentId})`);
    checks.push({ name: 'credentials', ok: true });
  } else {
    warn(`No credentials. Run \`jecp register\` or \`jecp login\`.`);
    checks.push({ name: 'credentials', ok: false });
  }

  // 4. SDK version (read installed dep's package.json — best-effort across runtimes)
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@jecpdev/sdk/package.json');
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
    success(`SDK version: ${pkg.version}`);
    checks.push({ name: 'sdk_version', ok: true, detail: pkg.version });
  } catch {
    warn('Could not detect @jecpdev/sdk version');
    checks.push({ name: 'sdk_version', ok: false });
  }

  info('');
  info('─'.repeat(50));
  const allOk = checks.every((c) => c.ok);
  if (allOk) {
    success('All checks passed.');
  } else {
    warn('Some checks failed. See above.');
  }

  emit({ checks, all_ok: allOk });
}
