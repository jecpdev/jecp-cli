import { resolveAuth, configFilePath } from '../config.js';
import { existsSync } from 'node:fs';
import { emit, info, success, error, warn, bold, dim } from '../output.js';

interface Check { name: string; ok: boolean; detail?: string; latency_ms?: number }

const VERSION_NPM_BASE = 'https://registry.npmjs.org';

export async function doctorCmd() {
  info(bold('JECP CLI — Diagnostic Report'));
  info('─'.repeat(60));

  const auth = resolveAuth();
  const baseUrl = auth.baseUrl ?? 'https://jecp.dev';
  const cfgPath = configFilePath();
  const checks: Check[] = [];

  // ─── 1. Hub /health (verifies S0 bulkhead alive + DB connected) ─────────
  let hubHealth: any | undefined;
  {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout(`${baseUrl}/health`, 5000);
      const latency = Date.now() - start;
      const body = await res.text();
      try { hubHealth = JSON.parse(body); } catch { hubHealth = undefined; }
      const dbOk = hubHealth?.checks?.database === 'ok';
      const ok = res.ok && dbOk;
      if (ok) {
        success(`Hub reachable: ${baseUrl} (${latency}ms, db ok)`);
      } else {
        error(`Hub degraded: ${baseUrl}/health returned ${res.status} db=${hubHealth?.checks?.database}`);
      }
      checks.push({ name: 'hub_health', ok, detail: `${baseUrl} status=${res.status}`, latency_ms: latency });
    } catch (e) {
      error(`Cannot reach ${baseUrl}: ${(e as Error).message}`);
      checks.push({ name: 'hub_health', ok: false, detail: (e as Error).message });
    }
  }

  // ─── 2. Hub bulkhead pools state (S0) ───────────────────────────────────
  if (hubHealth?.pools) {
    const pools = hubHealth.pools as Record<string, { size: number; idle: number }>;
    const names = Object.keys(pools).sort();
    const summary = names.map((n) => `${n}=${pools[n].size}/${pools[n].idle}`).join(' ');
    success(`Pool partitioning: ${summary}`);
    checks.push({ name: 'hub_pools', ok: names.length >= 4, detail: summary });
  } else if (hubHealth) {
    warn('Hub /health did not surface pools field (S0 bulkhead may be down-rev)');
    checks.push({ name: 'hub_pools', ok: false });
  }

  // ─── 3. Background task supervisor counters (S0) ────────────────────────
  if (hubHealth?.tasks) {
    const tasks = hubHealth.tasks as Record<string, { restart_count: number }>;
    const names = Object.keys(tasks).sort();
    const restartSum = names.reduce((a, n) => a + tasks[n].restart_count, 0);
    if (restartSum === 0) {
      success(`Background tasks healthy: ${names.join(', ')} (0 restarts)`);
    } else {
      warn(`Background tasks: ${restartSum} cumulative restarts (panic-protected, see /health.tasks for breakdown)`);
    }
    checks.push({ name: 'hub_tasks', ok: names.length > 0, detail: `${names.length} tasks, ${restartSum} restarts` });
  }

  // ─── 4. Config file ─────────────────────────────────────────────────────
  if (existsSync(cfgPath)) {
    success(`Config file: ${cfgPath}`);
    checks.push({ name: 'config_file', ok: true, detail: cfgPath });
  } else {
    warn(`Config file not yet created (run \`jecp register\` or \`jecp login\`)`);
    checks.push({ name: 'config_file', ok: false });
  }

  // ─── 5. Credentials present ─────────────────────────────────────────────
  if (auth.agentId && auth.apiKey) {
    success(`Agent credentials: ${auth.agentId}`);
    checks.push({ name: 'credentials', ok: true, detail: auth.agentId });
  } else {
    warn(`No agent credentials. Run \`jecp register\` to obtain one.`);
    checks.push({ name: 'credentials', ok: false });
  }

  // ─── 6. SDK version + npm latest comparison ─────────────────────────────
  let installedSdk: string | undefined;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@jecpdev/sdk/package.json');
    const { readFileSync } = await import('node:fs');
    installedSdk = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
  } catch { /* swallow */ }

  let latestSdk: string | undefined;
  try {
    const r = await fetchWithTimeout(`${VERSION_NPM_BASE}/@jecpdev%2Fsdk/latest`, 5000);
    if (r.ok) {
      const body = await r.json() as { version: string };
      latestSdk = body.version;
    }
  } catch { /* network may be blocked */ }

  if (installedSdk && latestSdk) {
    if (installedSdk === latestSdk) {
      success(`SDK version: ${installedSdk} (up to date)`);
      checks.push({ name: 'sdk_version', ok: true, detail: installedSdk });
    } else {
      warn(`SDK version: ${installedSdk} installed, ${latestSdk} latest on npm`);
      checks.push({ name: 'sdk_version', ok: false, detail: `${installedSdk} → ${latestSdk}` });
    }
  } else if (installedSdk) {
    success(`SDK version: ${installedSdk}`);
    checks.push({ name: 'sdk_version', ok: true, detail: installedSdk });
  } else {
    warn('Could not detect @jecpdev/sdk');
    checks.push({ name: 'sdk_version', ok: false });
  }

  // ─── 7. CLI version vs npm latest ───────────────────────────────────────
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('../package.json');
    const { readFileSync } = await import('node:fs');
    const installed = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
    let latest: string | undefined;
    try {
      const r = await fetchWithTimeout(`${VERSION_NPM_BASE}/@jecpdev%2Fcli/latest`, 5000);
      if (r.ok) latest = ((await r.json()) as { version: string }).version;
    } catch { /* offline */ }
    if (latest && installed !== latest) {
      warn(`CLI version: ${installed} installed, ${latest} latest. Run \`npm i -g @jecpdev/cli@latest\`.`);
      checks.push({ name: 'cli_version', ok: false, detail: `${installed} → ${latest}` });
    } else {
      success(`CLI version: ${installed}${latest ? ' (up to date)' : ''}`);
      checks.push({ name: 'cli_version', ok: true, detail: installed });
    }
  } catch { /* swallow */ }

  // ─── 8. Wallet balance + free calls (only if logged in) ─────────────────
  if (auth.agentId && auth.apiKey) {
    try {
      const r = await fetchWithTimeout(`${baseUrl}/v1/refunds`, 5000, {
        headers: { 'x-agent-id': auth.agentId, 'x-api-key': auth.apiKey },
      });
      if (r.status === 401) {
        error(`Stored credentials rejected (401 INVALID_AGENT). Re-run \`jecp register\` or restore from your password manager.`);
        checks.push({ name: 'auth_check', ok: false, detail: 'INVALID_AGENT' });
      } else {
        success(`Authentication accepted (auth path verified)`);
        checks.push({ name: 'auth_check', ok: true });
      }
    } catch (e) {
      warn(`Could not verify auth: ${(e as Error).message}`);
      checks.push({ name: 'auth_check', ok: false, detail: (e as Error).message });
    }
  }

  // ─── 9. Node version ────────────────────────────────────────────────────
  const nodeVersion = process.versions.node;
  const nodeMajor = parseInt(nodeVersion.split('.')[0], 10);
  if (nodeMajor >= 20) {
    success(`Node.js: ${nodeVersion}`);
    checks.push({ name: 'node_version', ok: true, detail: nodeVersion });
  } else {
    warn(`Node.js: ${nodeVersion} — minimum is 20.0.0`);
    checks.push({ name: 'node_version', ok: false, detail: nodeVersion });
  }

  // ─── Summary ────────────────────────────────────────────────────────────
  info('');
  info('─'.repeat(60));
  const ok = checks.filter((c) => c.ok).length;
  const failed = checks.length - ok;
  if (failed === 0) {
    success(`All ${checks.length} checks passed.`);
  } else {
    warn(`${ok}/${checks.length} checks passed. See ${dim('above')} for details.`);
  }

  emit({ checks, all_ok: failed === 0 });
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}
