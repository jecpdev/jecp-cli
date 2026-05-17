import { resolveAuth, resolveProviderAuth, configFilePath, loadConfig } from '../config.js';
import { existsSync } from 'node:fs';
import { emit, info, success, error, warn, bold, dim } from '../output.js';

interface Check { name: string; ok: boolean; detail?: string; latency_ms?: number }

const VERSION_NPM_BASE = 'https://registry.npmjs.org';
const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';
const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';

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
  //
  // Resolution order (degrades gracefully — never throws to the user):
  //   1. require.resolve('@jecpdev/sdk/package.json')
  //      → works when the CLI is installed globally / from npm; node_modules
  //        is sitting next to dist/.
  //   2. Read this CLI's own package.json `dependencies['@jecpdev/sdk']`.
  //      → works in a dev workspace where the SDK hasn't been npm-installed
  //        next to dist/ (e.g. linked from a sibling repo); we surface the
  //        declared version so `doctor` doesn't lie about not finding it.
  //   3. ok: false with detail "SDK not found in tree" (no throw).
  let installedSdk: string | undefined;
  let sdkSource: 'node_modules' | 'declared' | undefined;
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@jecpdev/sdk/package.json');
    const { readFileSync } = await import('node:fs');
    installedSdk = (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
    sdkSource = 'node_modules';
  } catch {
    // Fallback: parse this CLI's own package.json dependencies block. Strip
    // a leading ^/~/>= so we surface a real semver string.
    try {
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const ownPkgPath = req.resolve('../package.json');
      const { readFileSync } = await import('node:fs');
      const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      const declared = ownPkg.dependencies?.['@jecpdev/sdk'];
      if (declared) {
        installedSdk = declared.replace(/^[\^~>=<\s]+/, '');
        sdkSource = 'declared';
      }
    } catch { /* swallow — final state handled below */ }
  }

  let latestSdk: string | undefined;
  try {
    const r = await fetchWithTimeout(`${VERSION_NPM_BASE}/@jecpdev%2Fsdk/latest`, 5000);
    if (r.ok) {
      const body = await r.json() as { version: string };
      latestSdk = body.version;
    }
  } catch { /* network may be blocked */ }

  // When the SDK version came from package.json `dependencies`, annotate so
  // operators understand `doctor` couldn't physically resolve the package
  // (e.g. dev workspace without `npm install`).
  const sdkSuffix = sdkSource === 'declared' ? ' (declared in package.json)' : '';
  if (installedSdk && latestSdk) {
    if (installedSdk === latestSdk) {
      success(`SDK version: ${installedSdk} (up to date)${sdkSuffix}`);
      checks.push({ name: 'sdk_version', ok: true, detail: installedSdk });
    } else {
      warn(`SDK version: ${installedSdk} installed, ${latestSdk} latest on npm${sdkSuffix}`);
      checks.push({ name: 'sdk_version', ok: false, detail: `${installedSdk} → ${latestSdk}` });
    }
  } else if (installedSdk) {
    success(`SDK version: ${installedSdk}${sdkSuffix}`);
    checks.push({ name: 'sdk_version', ok: true, detail: installedSdk });
  } else {
    warn('Could not detect @jecpdev/sdk');
    checks.push({ name: 'sdk_version', ok: false, detail: 'SDK not found in tree' });
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

  // ─── Provider readiness (v0.8.0) — skipped silently if not configured ──
  await runProviderChecks(checks, baseUrl);

  // ─── x402 readiness (v0.7.0) ────────────────────────────────────────────
  info('');
  info(bold('── x402 ──'));
  await runX402Checks(checks, baseUrl);

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

// ──────────────────────────────────────────────────────────────────────
// v0.7.0 — x402 readiness checks (Locked design §6.3 Panel 4 §C)
// ──────────────────────────────────────────────────────────────────────

export async function runX402Checks(checks: Check[], baseUrl: string): Promise<void> {
  await checkSignerPresent(checks);
  await checkFacilitatorReachable(checks);
  await checkBaseRpcReachable(checks);
  await checkSplitterAddressCorrect(checks, baseUrl);
}

async function checkSignerPresent(checks: Check[]): Promise<void> {
  const cfg = loadConfig();
  if (cfg.x402_wallet_address) {
    success(`x402 signer configured: ${cfg.x402_wallet_address} (${cfg.x402_signer_kind ?? 'env'})`);
    checks.push({
      name: 'x402.signer_present',
      ok: true,
      detail: `${cfg.x402_wallet_address} via ${cfg.x402_signer_kind ?? 'env'}`,
    });
    if ((cfg.x402_signer_kind ?? 'env') === 'env' && !process.env.BASE_PRIVATE_KEY) {
      warn('  BASE_PRIVATE_KEY env var is NOT set — x402 signing will fail at runtime.');
    }
  } else {
    warn(`x402 signer NOT configured (run \`jecp wallet:link-usdc 0x...\` to enable x402 mode)`);
    checks.push({ name: 'x402.signer_present', ok: false });
  }
}

async function checkFacilitatorReachable(checks: Check[]): Promise<void> {
  const url = process.env.X402_FACILITATOR_URL ?? DEFAULT_FACILITATOR_URL;
  const start = Date.now();
  try {
    const r = await fetchWithTimeout(url, 2_000);
    const latency = Date.now() - start;
    // 200/404/405 are all "reachable" — only 5xx counts as degraded.
    const ok = r.status < 500;
    if (ok) {
      success(`x402 facilitator reachable: ${url} (${latency}ms)`);
      checks.push({ name: 'x402.facilitator_reachable', ok: true, detail: url, latency_ms: latency });
    } else {
      error(`x402 facilitator degraded: ${url} returned ${r.status}`);
      checks.push({ name: 'x402.facilitator_reachable', ok: false, detail: `${url} status=${r.status}`, latency_ms: latency });
    }
  } catch (e) {
    error(`x402 facilitator unreachable: ${(e as Error).message}`);
    checks.push({ name: 'x402.facilitator_reachable', ok: false, detail: (e as Error).message });
  }
}

async function checkBaseRpcReachable(checks: Check[]): Promise<void> {
  const url = process.env.BASE_RPC_URL ?? DEFAULT_BASE_RPC_URL;
  const start = Date.now();
  try {
    const r = await fetchWithTimeout(url, 2_000, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    });
    const latency = Date.now() - start;
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as { result?: string };
      const chainHex = body.result;
      const expectedHex = '0x2105'; // 8453 = Base mainnet
      const expectedHexSep = '0x14a34'; // 84532 = Base Sepolia
      if (chainHex === expectedHex) {
        success(`Base RPC reachable: ${url} chain=base (${latency}ms)`);
        checks.push({ name: 'x402.base_rpc_reachable', ok: true, detail: 'chain=base mainnet', latency_ms: latency });
      } else if (chainHex === expectedHexSep) {
        success(`Base RPC reachable: ${url} chain=base-sepolia (${latency}ms)`);
        checks.push({ name: 'x402.base_rpc_reachable', ok: true, detail: 'chain=base-sepolia', latency_ms: latency });
      } else {
        warn(`Base RPC returned unexpected chainId ${chainHex} — expected 0x2105 (Base mainnet)`);
        checks.push({ name: 'x402.base_rpc_reachable', ok: false, detail: `wrong chain: ${chainHex}` });
      }
    } else {
      error(`Base RPC degraded: ${url} returned ${r.status}`);
      checks.push({ name: 'x402.base_rpc_reachable', ok: false, detail: `status=${r.status}` });
    }
  } catch (e) {
    error(`Base RPC unreachable: ${(e as Error).message}`);
    checks.push({ name: 'x402.base_rpc_reachable', ok: false, detail: (e as Error).message });
  }
}

async function checkSplitterAddressCorrect(checks: Check[], baseUrl: string): Promise<void> {
  // Pull /v1/capabilities and confirm AT LEAST ONE x402-accepting capability
  // is visible. Full splitter-address cross-check arrives once the Hub
  // publishes the address in the catalog response (TODO post-Hub-v1.1.0).
  try {
    const r = await fetchWithTimeout(`${baseUrl}/v1/capabilities?page_size=200`, 5_000);
    if (!r.ok) {
      warn(`Could not load /v1/capabilities (status ${r.status}); splitter check skipped`);
      checks.push({ name: 'x402.splitter_address_correct', ok: false, detail: `catalog status=${r.status}` });
      return;
    }
    const body = (await r.json()) as {
      third_party_capabilities?: Array<{
        id?: string;
        manifest?: {
          actions?: Array<{ pricing?: { payment_methods?: string[] } }>;
        };
      }>;
    };
    const items = body.third_party_capabilities ?? [];
    const hasX402 = items.some((c) =>
      c.manifest?.actions?.some((a) => a.pricing?.payment_methods?.includes('x402'))
    );
    if (hasX402) {
      success(`Splitter check: catalog advertises ${dim('payment_methods: [..., x402]')} capabilities`);
      checks.push({ name: 'x402.splitter_address_correct', ok: true, detail: 'x402 in catalog' });
    } else {
      warn(`No x402-accepting capabilities visible in catalog yet (Hub may not have GA'd v1.1.0)`);
      checks.push({ name: 'x402.splitter_address_correct', ok: false, detail: 'no x402 capabilities' });
    }
  } catch (e) {
    warn(`Splitter check failed: ${(e as Error).message}`);
    checks.push({ name: 'x402.splitter_address_correct', ok: false, detail: (e as Error).message });
  }
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

// ──────────────────────────────────────────────────────────────────────
// v0.8.0 — Provider readiness checks
//
// Skipped silently when no Provider creds are configured — most operators
// are agent-only and the empty case shouldn't generate noise. When creds
// are present, fetch /v1/providers/me and surface DNS + Stripe + endpoint
// state with one actionable line per failing condition.
// ──────────────────────────────────────────────────────────────────────

interface ProviderMe {
  provider_id: string;
  namespace: string;
  display_name: string;
  status: string;
  dns_verified: boolean;
  stripe_verified: boolean;
  endpoint_url?: string;
  total_calls: number;
}

export async function runProviderChecks(checks: Check[], baseUrl: string): Promise<void> {
  const { providerApiKey } = resolveProviderAuth();
  if (!providerApiKey) {
    // No creds — skip silently. Adding a warn() here would noise up the
    // diagnostic for the typical agent-only operator.
    return;
  }

  info('');
  info(bold('── Provider ──'));

  let me: ProviderMe | undefined;
  try {
    const r = await fetchWithTimeout(`${baseUrl}/v1/providers/me`, 5_000, {
      headers: { Authorization: `Bearer ${providerApiKey}` },
    });
    if (r.status === 401) {
      error(`Provider api_key rejected (401). Re-run \`jecp provider register\` or \`jecp provider rotate-key\`.`);
      checks.push({ name: 'provider.auth', ok: false, detail: '401 INVALID_PROVIDER_KEY' });
      return;
    }
    if (!r.ok) {
      error(`Provider /me returned ${r.status}.`);
      checks.push({ name: 'provider.auth', ok: false, detail: `status=${r.status}` });
      return;
    }
    me = (await r.json()) as ProviderMe;
  } catch (e) {
    error(`Provider /me unreachable: ${(e as Error).message}`);
    checks.push({ name: 'provider.auth', ok: false, detail: (e as Error).message });
    return;
  }

  success(`Provider authenticated: ${me.namespace} ${dim('(' + me.display_name + ')')}`);
  checks.push({ name: 'provider.auth', ok: true, detail: me.namespace });

  if (me.dns_verified) {
    success(`DNS verified: ${me.endpoint_url ?? '(endpoint unset)'}`);
    checks.push({ name: 'provider.dns_verified', ok: true });
  } else {
    warn(`DNS NOT verified — add the TXT record and run \`jecp provider verify-dns\`.`);
    checks.push({ name: 'provider.dns_verified', ok: false });
  }

  if (me.stripe_verified) {
    success('Stripe Connect verified');
    checks.push({ name: 'provider.stripe_verified', ok: true });
  } else {
    warn('Stripe NOT connected — run `jecp provider connect-stripe` and complete onboarding.');
    checks.push({ name: 'provider.stripe_verified', ok: false });
  }

  if (me.status === 'active' && me.total_calls > 0) {
    success(`Lifetime calls: ${me.total_calls}`);
  } else if (me.status !== 'active') {
    warn(`Provider status: ${me.status} (capabilities won't appear in catalog until 'active').`);
  }
  checks.push({ name: 'provider.status', ok: me.status === 'active', detail: me.status });
}
