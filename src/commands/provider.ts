/**
 * v0.8.0 — Provider lifecycle commands.
 *
 * The Provider onboarding flow used to be raw curl: 5 commands typed by hand,
 * a DNS propagation wait of unknown duration, and a manual verify retry loop.
 * `jecp init-provider` (v0.7.0) scaffolded the manifest YAML but still left
 * the curl steps. This module closes the loop:
 *
 *   jecp init-provider           # generate jecp.yaml (already shipped in v0.7.0)
 *   jecp provider register …     # POST /v1/providers/register, save creds
 *   jecp provider verify-dns     # auto-polls until TXT propagates
 *   jecp provider connect-stripe # print onboarding URL
 *   jecp provider me             # status check
 *
 * Target: 30 min Provider TTV (from ~3 days of waiting + retrying).
 *
 * Provider creds (provider_api_key + hmac_secret) are stored in
 * ~/.jecp/config.json (mode 0600). API key is shown once at register time;
 * the CLI prints it AND saves it. Subsequent commands authenticate
 * automatically from the saved key.
 */

import prompts from 'prompts';
import { getBaseUrl } from '../sdk.js';
import { loadConfig, saveConfig, resolveProviderAuth, configFilePath } from '../config.js';
import { emit, info, success, warn, bold, dim, fail } from '../output.js';

// ── shared helpers ──────────────────────────────────────────────────────

interface JecpHttpError {
  status: number;
  code: string;
  message: string;
}

/**
 * Thin wrapper around fetch that:
 * - injects Authorization: Bearer <provider_api_key> when authed=true
 * - parses both legacy `{error: "..."}` and JECP `{error: {code, message}}`
 * - throws JecpHttpError so callers can branch on `.code`
 */
async function fetchJson<T>(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  authed?: boolean;
  baseUrl?: string;
  providerApiKey?: string;
}): Promise<T> {
  const baseUrl = (opts.baseUrl ?? getBaseUrl()).replace(/\/+$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.authed) {
    if (!opts.providerApiKey) {
      throw {
        status: 0,
        code: 'NO_PROVIDER_KEY',
        message: 'Not registered as a Provider. Run `jecp provider register` first.',
      } satisfies JecpHttpError;
    }
    headers['Authorization'] = `Bearer ${opts.providerApiKey}`;
  }
  const res = await fetch(`${baseUrl}${opts.path}`, {
    method: opts.method,
    headers,
    ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
  });
  if (!res.ok) {
    const raw = (await res.json().catch(() => ({}))) as
      | { error?: string | { code?: string; message?: string } }
      | undefined;
    const err = raw?.error;
    const code = typeof err === 'object' && err?.code ? err.code : `HTTP_${res.status}`;
    const message =
      typeof err === 'string'
        ? err
        : typeof err === 'object' && err?.message
          ? err.message
          : `request failed: ${res.status}`;
    throw { status: res.status, code, message } satisfies JecpHttpError;
  }
  return (await res.json()) as T;
}

function isHttpError(e: unknown): e is JecpHttpError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

// ── jecp provider register ──────────────────────────────────────────────

interface RegisterOpts {
  namespace?: string;
  displayName?: string;
  email?: string;
  endpoint?: string;
  country?: string;
  website?: string;
  usdcAddress?: string;
  yes?: boolean;
  wait?: boolean;
  /** Override default 10-minute DNS polling deadline. */
  timeout?: string;
}

interface RegisterResponse {
  provider_id: string;
  namespace: string;
  provider_api_key: string;
  hmac_secret: string;
  dns_verification_token: string;
  next_steps: Record<string, unknown>;
}

export async function providerRegisterCmd(opts: RegisterOpts): Promise<void> {
  // Refuse to silently overwrite an existing Provider credential.
  const existing = loadConfig();
  if (existing.provider_api_key && !opts.yes) {
    const ans = await prompts({
      type: 'confirm',
      name: 'replace',
      message: `Provider creds already saved for namespace '${existing.provider_namespace ?? '?'}'. Overwrite?`,
      initial: false,
    });
    if (!ans.replace) {
      info('Aborted. Existing credentials preserved.');
      return;
    }
  }

  const fields = await collectRegisterFields(opts);

  info(`Registering Provider ${bold(fields.namespace)}…`);
  let reg: RegisterResponse;
  try {
    reg = await fetchJson<RegisterResponse>({
      method: 'POST',
      path: '/v1/providers/register',
      body: {
        namespace: fields.namespace,
        display_name: fields.display_name,
        owner_email: fields.owner_email,
        endpoint_url: fields.endpoint_url,
        country: fields.country,
        ...(fields.website && { website: fields.website }),
        ...(fields.usdc_payout_address && { usdc_payout_address: fields.usdc_payout_address }),
      },
    });
  } catch (e) {
    if (isHttpError(e)) {
      // Tell the operator how to recover from common cases instead of dumping
      // a status code. Recovery hints are intentionally short — the full
      // spec link in init-provider's footer carries the long explanation.
      if (e.code === 'NAMESPACE_TAKEN') {
        fail(`namespace '${fields.namespace}' is already registered. Pick a different one and re-run.`);
      }
      if (e.code === 'UNSUPPORTED_COUNTRY') {
        fail(`country '${fields.country}' is not supported by Stripe Connect. See https://stripe.com/global`);
      }
      fail(`${e.code}: ${e.message}`);
    }
    throw e;
  }

  // Save immediately. The api_key is shown once by the Hub; losing it means
  // re-register from scratch.
  const cfg = loadConfig();
  cfg.provider_id = reg.provider_id;
  cfg.provider_namespace = reg.namespace;
  cfg.provider_api_key = reg.provider_api_key;
  cfg.provider_hmac_secret = reg.hmac_secret;
  cfg.provider_dns_token = reg.dns_verification_token;
  saveConfig(cfg);

  success(`Provider registered. Credentials saved to ${bold(configFilePath())} (mode 0600).`);
  info('');
  info(bold('Credentials (shown once — already saved to config):'));
  info(`  Provider ID:   ${reg.provider_id}`);
  info(`  Namespace:     ${reg.namespace}`);
  info(`  API key:       ${reg.provider_api_key}`);
  info(`  HMAC secret:   ${reg.hmac_secret}`);
  info('');

  const txtName = `_jecp.${hostFromUrl(fields.endpoint_url) ?? 'your-domain.com'}`;
  const txtValue = `jecp-verify=${reg.dns_verification_token}`;
  info(bold('Step 1 — Publish this DNS TXT record:'));
  info(`  ${dim('Name: ')}${bold(txtName)}`);
  info(`  ${dim('Type: ')}TXT`);
  info(`  ${dim('Value:')}${bold(' ')}${txtValue}`);
  info('');

  emit({
    provider_id: reg.provider_id,
    namespace: reg.namespace,
    provider_api_key: reg.provider_api_key,
    hmac_secret: reg.hmac_secret,
    dns_txt: { name: txtName, value: txtValue },
    next_step: opts.wait
      ? 'auto-polling /v1/providers/verify-dns'
      : 'run `jecp provider verify-dns` after adding the TXT record',
  });

  if (!opts.wait) {
    info(bold('Step 2 — When the TXT record is live, verify:'));
    info(`  ${dim('$')} jecp provider verify-dns`);
    info('');
    info(`${dim('Most DNS providers propagate in 30 s – 5 min. Cloudflare is usually < 30 s.')}`);
    return;
  }

  info(bold('Auto-polling DNS propagation… (Ctrl-C to stop and resume later with `jecp provider verify-dns`)'));
  const deadlineMs = Date.now() + parseTimeoutMs(opts.timeout);
  await pollVerifyDns(reg.provider_api_key, deadlineMs);
}

async function collectRegisterFields(opts: RegisterOpts): Promise<{
  namespace: string;
  display_name: string;
  owner_email: string;
  endpoint_url: string;
  country: string;
  website?: string;
  usdc_payout_address?: string;
}> {
  // If all required flags are supplied non-interactively, skip the wizard.
  const allSupplied =
    opts.namespace && opts.displayName && opts.email && opts.endpoint && opts.country;
  if (allSupplied) {
    return {
      namespace: opts.namespace!.toLowerCase(),
      display_name: opts.displayName!,
      owner_email: opts.email!,
      endpoint_url: opts.endpoint!,
      country: opts.country!.toUpperCase(),
      ...(opts.website && { website: opts.website }),
      ...(opts.usdcAddress && { usdc_payout_address: opts.usdcAddress.toLowerCase() }),
    };
  }

  const a = await prompts([
    {
      type: 'text',
      name: 'namespace',
      message: 'Namespace (3-32 chars, [a-z0-9-])',
      initial: opts.namespace,
      validate: (v: string) => /^[a-z][a-z0-9-]{2,31}$/.test(v) || 'must match ^[a-z][a-z0-9-]{2,31}$',
    },
    {
      type: 'text',
      name: 'displayName',
      message: 'Display name',
      initial: opts.displayName,
      validate: (v: string) => (v.length > 0 && v.length <= 120) || '1-120 chars required',
    },
    {
      type: 'text',
      name: 'email',
      message: 'Owner email',
      initial: opts.email,
      validate: (v: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) || 'not a valid email',
    },
    {
      type: 'text',
      name: 'endpoint',
      message: 'HTTPS endpoint (Hub forwards calls here)',
      initial: opts.endpoint,
      validate: (v: string) => v.startsWith('https://') || 'must start with https://',
    },
    {
      type: 'text',
      name: 'country',
      message: 'ISO country (e.g. JP, US, DE)',
      initial: opts.country,
      validate: (v: string) => /^[a-zA-Z]{2}$/.test(v) || 'two-letter code required',
    },
    {
      type: 'text',
      name: 'website',
      message: 'Website (optional, press enter to skip)',
      initial: opts.website ?? '',
    },
    {
      type: 'text',
      name: 'usdcAddress',
      message: 'Base USDC payout address (optional, 0x… 40 hex)',
      initial: opts.usdcAddress ?? '',
      validate: (v: string) => v === '' || /^0x[a-fA-F0-9]{40}$/.test(v) || 'invalid address',
    },
  ]);

  if (!a.namespace) fail('aborted');

  return {
    namespace: a.namespace.toLowerCase(),
    display_name: a.displayName,
    owner_email: a.email,
    endpoint_url: a.endpoint,
    country: a.country.toUpperCase(),
    ...(a.website && { website: a.website }),
    ...(a.usdcAddress && { usdc_payout_address: a.usdcAddress.toLowerCase() }),
  };
}

// ── jecp provider verify-dns ────────────────────────────────────────────

interface VerifyDnsOpts {
  timeout?: string;
  once?: boolean;
}

interface VerifyDnsResponse {
  verified: boolean;
  status: string;
  message: string;
}

export async function providerVerifyDnsCmd(opts: VerifyDnsOpts): Promise<void> {
  const { providerApiKey, namespace } = resolveProviderAuth();
  if (!providerApiKey) {
    fail('No Provider credentials in config. Run `jecp provider register` first, or export JECP_PROVIDER_KEY.');
  }

  if (opts.once) {
    const r = await singleVerifyAttempt(providerApiKey!);
    emit(r, () => {
      if (r.verified) success(`DNS verified for namespace '${namespace ?? '?'}'.`);
      else warn(`Not yet verified: ${r.message}`);
    });
    if (!r.verified) process.exit(2);
    return;
  }

  const deadlineMs = Date.now() + parseTimeoutMs(opts.timeout);
  info(`Polling /v1/providers/verify-dns until ${dim(new Date(deadlineMs).toISOString())} (${formatTimeout(opts.timeout)})…`);
  await pollVerifyDns(providerApiKey!, deadlineMs);
}

/**
 * Poll verify-dns every 10s until verified or deadline. Prints a progress
 * line per attempt. On success, suggests the next command. On timeout,
 * exits with code 2 so CI scripts can react.
 *
 * Why 10s: most DNS providers propagate within 30s-2min. A shorter interval
 * burns RPS quota at the Hub for no operator benefit; a longer one feels
 * sluggish on Cloudflare (typically < 30s).
 */
async function pollVerifyDns(providerApiKey: string, deadlineMs: number): Promise<void> {
  const intervalMs = 10_000;
  let attempt = 0;
  while (Date.now() < deadlineMs) {
    attempt++;
    const r = await singleVerifyAttempt(providerApiKey);
    if (r.verified) {
      info('');
      success(`DNS verified after ${attempt} ${attempt === 1 ? 'attempt' : 'attempts'}.`);
      info('');
      info(bold('Next steps:'));
      info(`  ${dim('$')} jecp provider connect-stripe   ${dim('# enable USD payouts')}`);
      info(`  ${dim('$')} jecp provider me               ${dim('# verify state')}`);
      info('');
      emit({ verified: true, attempts: attempt, namespace: loadConfig().provider_namespace });
      return;
    }
    process.stdout.write(`  ${dim(`attempt ${attempt}: ${r.status} — ${r.message}`)}\n`);
    if (Date.now() + intervalMs >= deadlineMs) break;
    await sleep(intervalMs);
  }
  fail(
    `DNS not verified within deadline. The TXT record may still be propagating. ` +
      `Re-run \`jecp provider verify-dns\` later, or check your DNS provider's status.`,
    2,
  );
}

async function singleVerifyAttempt(providerApiKey: string): Promise<VerifyDnsResponse> {
  try {
    return await fetchJson<VerifyDnsResponse>({
      method: 'POST',
      path: '/v1/providers/verify-dns',
      body: {},
      authed: true,
      providerApiKey,
    });
  } catch (e) {
    if (isHttpError(e)) {
      // The Hub returns 4xx with a structured body when the TXT is missing
      // or wrong — surface it as a non-fatal "not yet" rather than crashing
      // the poll loop. 5xx still propagates as a fatal error.
      if (e.status >= 400 && e.status < 500) {
        return { verified: false, status: e.code, message: e.message };
      }
      fail(`${e.code}: ${e.message}`);
    }
    throw e;
  }
}

// ── jecp provider me ────────────────────────────────────────────────────

interface ProviderMeResponse {
  provider_id: string;
  namespace: string;
  display_name: string;
  status: string;
  dns_verified: boolean;
  stripe_verified: boolean;
  endpoint_url?: string;
  total_calls: number;
}

export async function providerMeCmd(): Promise<void> {
  const { providerApiKey } = resolveProviderAuth();
  if (!providerApiKey) {
    fail('No Provider credentials. Run `jecp provider register` first.');
  }

  const me = await fetchJson<ProviderMeResponse>({
    method: 'GET',
    path: '/v1/providers/me',
    authed: true,
    providerApiKey,
  });

  emit(me, () => {
    info(bold(`${me.display_name} ${dim('(' + me.namespace + ')')}`));
    info(`  Status:       ${me.status}`);
    info(`  DNS:          ${me.dns_verified ? '✓ verified' : '✗ not verified'}`);
    info(`  Stripe:       ${me.stripe_verified ? '✓ verified' : '✗ not connected'}`);
    info(`  Endpoint:     ${me.endpoint_url ?? dim('(unset)')}`);
    info(`  Total calls:  ${me.total_calls}`);
  });
}

// ── jecp provider publish ───────────────────────────────────────────────

interface PublishOpts {
  /** Path to the YAML manifest (default: ./jecp.yaml). */
  file?: string;
}

interface PublishResponse {
  capability_id: string;
  full_id: string;
  version: string;
  /** "submitted" when DNS+Stripe not yet verified; "active" when fully verified. */
  status: string;
  action_count: number;
  validation_warnings: string[];
}

export async function providerPublishCmd(opts: PublishOpts): Promise<void> {
  const { providerApiKey, baseUrl } = resolveProviderAuth();
  if (!providerApiKey) {
    fail('No Provider credentials. Run `jecp provider register` first.');
  }

  const path = opts.file ?? 'jecp.yaml';
  // Lazy node:fs import so the CLI bundle stays tree-shakable for browsers
  // that might pull from index.ts (not used in production but keeps the
  // build consistent with other commands).
  const { readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(path)) {
    fail(`Manifest file not found: ${path}. Run \`jecp init-provider\` to scaffold one.`);
  }
  const yamlText = readFileSync(path, 'utf-8');
  if (yamlText.trim().length === 0) fail(`Manifest file is empty: ${path}`);
  if (yamlText.length > 256 * 1024) fail(`Manifest exceeds 256 KiB Hub limit: ${path}`);

  const base = (baseUrl ?? 'https://jecp.dev').replace(/\/+$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/v1/manifests`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-yaml',
        Authorization: `Bearer ${providerApiKey}`,
      },
      body: yamlText,
    });
  } catch (e) {
    fail(`network error: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res!.ok) {
    const raw = (await res!.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string } | string;
    };
    const err = raw.error;
    const code = typeof err === 'object' && err?.code ? err.code : `HTTP_${res!.status}`;
    const message =
      typeof err === 'string' ? err : typeof err === 'object' ? (err?.message ?? '') : '';

    // Map a couple of common cases to actionable hints. Everything else
    // surfaces the raw code+message so operators can grep the spec.
    if (code === 'PARSE_ERROR') {
      fail(`YAML parse failed: ${message}. Check indentation / unquoted strings.`);
    }
    if (code === 'VERSION_EXISTS') {
      fail(`${message}. Bump the manifest's \`version:\` field and re-publish.`);
    }
    if (code === 'NAMESPACE_MISMATCH') {
      fail(`${message}. The manifest's \`namespace:\` must match your registered namespace.`);
    }
    fail(`${code}: ${message || 'publish failed'}`);
  }

  const body = (await res!.json()) as PublishResponse;

  emit(body, () => {
    success(`Published ${bold(body.full_id)}@${body.version}`);
    info(`  Capability ID: ${body.capability_id}`);
    info(`  Actions:       ${body.action_count}`);
    info(`  Status:        ${body.status === 'active' ? '✓ ' + body.status : '⋯ ' + body.status}`);
    if (body.validation_warnings.length > 0) {
      info('');
      warn(`Validation warnings (non-fatal):`);
      for (const w of body.validation_warnings) info(`  - ${dim(w)}`);
    }
    info('');
    if (body.status !== 'active') {
      info(bold('Capability is submitted but not yet discoverable in /v1/capabilities.'));
      info(`To go live, complete:`);
      info(`  ${dim('$')} jecp provider verify-dns      ${dim('# if not yet done')}`);
      info(`  ${dim('$')} jecp provider connect-stripe  ${dim('# if not yet done')}`);
      info(`Once both are verified, the capability auto-promotes to 'active'.`);
    } else {
      info(`Discover at: ${dim(base + '/v1/capabilities?namespace=' + body.full_id.split('/')[0])}`);
    }
  });
}

// ── jecp provider rotate-key ────────────────────────────────────────────

interface RotateKeyOpts {
  graceSeconds?: string;
  revokeOld?: boolean;
  yes?: boolean;
}

interface RotateKeyResponse {
  jecp: '1.0';
  provider_id: string;
  namespace: string;
  api_key: string;
  api_key_prefix: string;
  previous_key_valid_until: string | null;
  grace_seconds: number;
  revoke_old: boolean;
  rotations_in_last_24h: number;
  warning: string;
}

/**
 * Rotate this Provider's API key. The HMAC secret is NOT rotated — it lives
 * on a separate lifecycle (HMAC is the Provider-side signing secret for
 * inbound Hub forwards; the api_key is the Provider's outbound auth for
 * /v1/providers/* and /v1/manifests). To rotate HMAC you'd re-register.
 *
 * Hub-side guarantees (see /v1/providers/me/rotate-key handler):
 *
 * - Atomic SQL TX: count-of-recent-rotations + UPDATE + audit row land in
 *   one transaction. Either everything commits or nothing does.
 * - 24h rotation cap. Hub returns 429 ROTATION_24H_CAP when the Provider
 *   has rotated too many times in the last day — defends against an
 *   attacker who phished one key and tries to "permanently rotate it out
 *   of reach" by spamming new rotations.
 * - Grace period default is 7 days (604800 s). --revoke-old forces 0 s.
 */
export async function providerRotateKeyCmd(opts: RotateKeyOpts): Promise<void> {
  const { providerApiKey, namespace } = resolveProviderAuth();
  if (!providerApiKey) {
    fail('No Provider credentials. Run `jecp provider register` first.');
    return;
  }

  if (!opts.yes) {
    const ans = await prompts({
      type: 'confirm',
      name: 'go',
      message: opts.revokeOld
        ? "Rotate this Provider's API key AND revoke the old one immediately? Existing invocations using the old key will fail."
        : "Rotate this Provider's API key? The previous key remains valid for 7 days unless overridden.",
      initial: false,
    });
    if (!ans.go) {
      info('Aborted.');
      return;
    }
  }

  const grace =
    opts.graceSeconds !== undefined ? parseInt(opts.graceSeconds, 10) : undefined;
  if (grace !== undefined && (Number.isNaN(grace) || grace < 60 || grace > 604800)) {
    fail('--grace-seconds must be an integer between 60 and 604800 (7 days).');
    return;
  }

  const body: Record<string, unknown> = {};
  if (grace !== undefined) body.grace_seconds = grace;
  if (opts.revokeOld) body.revoke_old = true;

  let r: RotateKeyResponse;
  try {
    r = await fetchJson<RotateKeyResponse>({
      method: 'POST',
      path: '/v1/providers/me/rotate-key',
      body,
      authed: true,
      providerApiKey,
    });
  } catch (e) {
    if (isHttpError(e)) {
      if (e.code === 'ROTATION_24H_CAP') {
        fail(
          `${e.message} If this is unexpected, audit recent activity in the Hub's provider_audit_log.`,
        );
        return;
      }
      fail(`${e.code}: ${e.message}`);
      return;
    }
    throw e;
  }

  // Persist the new key. HMAC secret is untouched — leave it as-is in config.
  const cfg = loadConfig();
  if (cfg.provider_id && cfg.provider_id === r.provider_id) {
    cfg.provider_api_key = r.api_key;
    saveConfig(cfg);
  }

  emit(r, () => {
    success(`Provider API key rotated for namespace '${r.namespace}'.`);
    info('');
    info(`${bold('New api_key:')}              ${r.api_key}`);
    info(`${bold('Previous valid until:')}     ${r.previous_key_valid_until ?? '(revoked)'}`);
    info(`${bold('Grace seconds:')}            ${r.grace_seconds}`);
    info(`${bold('Rotations last 24h:')}       ${r.rotations_in_last_24h}`);
    info('');
    if (cfg.provider_id === r.provider_id) {
      info(`${dim(`Saved to ${configFilePath()} (mode 0600).`)}`);
    } else {
      warn('Local config did not match this Provider — new key NOT auto-saved.');
    }
    info('');
    warn(r.warning);
  });
}

// ── jecp provider connect-stripe ────────────────────────────────────────

interface ConnectStripeResponse {
  onboarding_url: string;
  expires_at: number;
}

export async function providerConnectStripeCmd(): Promise<void> {
  const { providerApiKey, namespace } = resolveProviderAuth();
  if (!providerApiKey) {
    fail('No Provider credentials. Run `jecp provider register` first.');
  }

  const r = await fetchJson<ConnectStripeResponse>({
    method: 'POST',
    path: '/v1/providers/connect-stripe',
    body: {},
    authed: true,
    providerApiKey,
  });

  emit(r, () => {
    success(`Stripe Connect onboarding URL ready for namespace '${namespace ?? '?'}':`);
    info('');
    info(`  ${bold(r.onboarding_url)}`);
    info('');
    info(`${dim(`URL expires ${new Date(r.expires_at * 1000).toISOString()}.`)}`);
    info(`${dim('Open in browser, complete Stripe onboarding, then run `jecp provider me` to confirm.')}`);
  });
}

// ── shared utils ────────────────────────────────────────────────────────

function hostFromUrl(u: string): string | undefined {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse `--timeout` as either a number-of-seconds or a suffixed duration
 * like `5m` / `30s` / `1h`. Default 10 min. Caps at 1 h to keep CI scripts
 * sane — operators with longer waits should re-run the verify command.
 */
export function parseTimeoutMs(input: string | undefined): number {
  const DEFAULT_MS = 10 * 60 * 1000;
  const MAX_MS = 60 * 60 * 1000;
  if (!input) return DEFAULT_MS;
  const m = /^(\d+)(s|m|h)?$/.exec(input.trim());
  if (!m) fail(`invalid --timeout: '${input}' (use e.g. 300, 5m, 1h)`);
  const n = parseInt(m![1], 10);
  const unit = m![2] ?? 's';
  const ms = unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : n * 1000;
  return Math.min(ms, MAX_MS);
}

function formatTimeout(input: string | undefined): string {
  return input ?? '10m';
}
