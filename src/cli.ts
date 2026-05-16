#!/usr/bin/env node
/**
 * JECP CLI — entry point
 */

import { Command } from 'commander';
import { setJsonMode, fail } from './output.js';

const program = new Command();

program
  .name('jecp')
  .description('Command-line interface for JECP — Joint Execution & Commerce Protocol')
  .version('0.8.0')
  .option('--json', 'Machine-readable JSON output')
  .option('--base-url <url>', 'Override Hub URL (default https://jecp.dev)')
  .hook('preAction', (cmd) => {
    if (cmd.opts().json) setJsonMode(true);
    if (cmd.opts().baseUrl) process.env.JECP_BASE_URL = cmd.opts().baseUrl;
  });

program
  .command('register')
  .description('Register a new agent (interactive or with flags)')
  .option('-n, --name <name>', 'Agent name (display label)')
  .option('-t, --type <type>', 'Agent type (research, coder, demo, etc.)')
  .option('-d, --description <description>', 'Optional description')
  .action(async (opts) => {
    const { registerCmd } = await import('./commands/register.js');
    await registerCmd(opts);
  });

program
  .command('login')
  .description('Save existing agent credentials to ~/.jecp/config.json')
  .option('--agent-id <id>', 'Agent ID')
  .option('--api-key <key>', 'API key')
  .option('--base-url <url>', 'Override Hub URL')
  .action(async (opts) => {
    const { loginCmd } = await import('./commands/login.js');
    await loginCmd(opts);
  });

program
  .command('logout')
  .description('Clear stored credentials')
  .action(async () => {
    const { logoutCmd } = await import('./commands/login.js');
    await logoutCmd();
  });

program
  .command('invoke <capability> <action>')
  .description('Invoke a capability action (capability format: namespace/capability)')
  .option('-i, --input <json>', 'Input as JSON string', '{}')
  .option('-b, --budget <usdc>', 'Mandate budget cap in USDC (e.g. 1.00)')
  .option('-t, --timeout <ms>', 'Request timeout in milliseconds')
  .option('--request-id <id>', 'Override idempotency key (default: auto UUID)')
  .option('--stream', 'Stream the response as Server-Sent Events. Capability action must declare streaming: true.')
  .option('--pay <mode>', 'v0.7.0 — Payment rail: wallet|x402|auto (default: from config or "auto")')
  .action(async (capability, action, opts) => {
    const { invokeCmd } = await import('./commands/invoke.js');
    await invokeCmd(capability, action, opts);
  });

// v0.7.0 — x402 wallet linking (Locked design §6.3 + Panel 4 §B.2)
program
  .command('wallet:link-usdc <address>')
  .description('Store your Base USDC wallet address for x402 payments (v0.7.0)')
  .option('--signer <kind>', 'How the SDK accesses the private key: env|file|kms', 'env')
  .option('--default <mode>', 'Default --pay mode if flag omitted: wallet|x402|auto')
  .action(async (address, opts) => {
    const { walletLinkUsdcCmd } = await import('./commands/wallet-link-usdc.js');
    await walletLinkUsdcCmd(address, opts);
  });

program
  .command('catalog')
  .description('List capabilities (paginated by default)')
  .option('--page-size <n>', 'Items per page (1-200)', '50')
  .option('--namespace <ns>', 'Filter by Provider namespace')
  .option('--tags <csv>', 'Comma-separated tag filter')
  .option('--all', 'Fetch all in legacy mode (?paginated=false)')
  .action(async (opts) => {
    const { catalogCmd } = await import('./commands/catalog.js');
    await catalogCmd(opts);
  });

program
  .command('topup <amount>')
  .description('Top up wallet via Stripe Checkout (amount: 5, 20, or 100)')
  .option('--return-to <url>', 'Redirect URL after payment')
  .action(async (amount, opts) => {
    const { topupCmd } = await import('./commands/topup.js');
    await topupCmd(amount, opts);
  });

program
  .command('status')
  .description('Show health, balance, agent info')
  .action(async () => {
    const { statusCmd } = await import('./commands/status.js');
    await statusCmd();
  });

program
  .command('doctor')
  .description('Diagnose connectivity, config, and SDK version')
  .action(async () => {
    const { doctorCmd } = await import('./commands/doctor.js');
    await doctorCmd();
  });

// M2 — API key rotation (Phase B)
program
  .command('rotate-key')
  .description('Rotate this agent\'s API key. Previous key remains valid for 7 days.')
  .option('--grace-seconds <int>', 'Override grace window in seconds (60..604800)')
  .option('--yes', 'Skip the interactive confirmation')
  .action(async (opts) => {
    const { rotateKeyCmd } = await import('./commands/rotate-key.js');
    await rotateKeyCmd(opts);
  });

// S3-1 — Provider scaffolding (interactive jecp.yaml generator)
program
  .command('init-provider')
  .description('Interactive scaffold of a JECP Provider manifest (jecp.yaml).')
  .option('-o, --output <path>', 'Output file path (default jecp.yaml)')
  .option('--yes', 'Skip overwrite confirmation')
  .option(
    '--example [template]',
    'Non-interactive scaffold. Bare flag writes a YAML stub; "hello-world" writes a runnable Provider (jecp.yaml + handler.mjs + package.json + README.md).',
  )
  .action(async (opts) => {
    const { initProviderCmd } = await import('./commands/init-provider.js');
    await initProviderCmd(opts);
  });

// W2 — Refund commands
const refund = program.command('refund').description('Refund management (W2)');

refund
  .command('request <transaction_id>')
  .description('Request a refund within 30 days of the original charge')
  .requiredOption('--reason <text>', 'Reason (max 500 chars)')
  .option('--evidence-url <url>', 'Optional URL to evidence (screenshot, log)')
  .action(async (txId, opts) => {
    const { refundRequestCmd } = await import('./commands/refund.js');
    await refundRequestCmd(txId, opts);
  });

refund
  .command('get <refund_id>')
  .description('Read a refund by id')
  .action(async (refundId) => {
    const { refundGetCmd } = await import('./commands/refund.js');
    await refundGetCmd(refundId);
  });

refund
  .command('list')
  .description('List your refunds')
  .option('--limit <n>', 'Max items (1-200)', '50')
  .action(async (opts) => {
    const { refundListCmd } = await import('./commands/refund.js');
    await refundListCmd(opts);
  });

// v0.8.0 — Provider lifecycle (S3 UX P0: register + auto-poll verify-dns)
const provider = program.command('provider').description('Provider lifecycle commands (v0.8.0)');

provider
  .command('register')
  .description('Register as a Provider; saves api_key + hmac_secret + dns_token to config')
  .option('-n, --namespace <ns>', 'Namespace (3-32 chars, [a-z0-9-])')
  .option('--display-name <name>', 'Display name (1-120 chars)')
  .option('-e, --email <email>', 'Owner email')
  .option('--endpoint <url>', 'HTTPS endpoint that receives Hub-forwarded calls')
  .option('-c, --country <iso>', 'ISO 3166-1 alpha-2 country code (e.g. JP)')
  .option('--website <url>', 'Optional website URL')
  .option('--usdc-address <0x...>', 'Optional Base USDC payout address (x402)')
  .option('-w, --wait', 'After register, auto-poll verify-dns until propagated')
  .option('-t, --timeout <duration>', 'Polling deadline when --wait (e.g. 5m, 1h; default 10m)')
  .option('--yes', 'Skip overwrite confirmation if creds already saved')
  .action(async (opts) => {
    const { providerRegisterCmd } = await import('./commands/provider.js');
    await providerRegisterCmd(opts);
  });

provider
  .command('verify-dns')
  .description('Poll /v1/providers/verify-dns until DNS TXT propagates (default 10m deadline)')
  .option('-t, --timeout <duration>', 'Polling deadline (e.g. 5m, 1h; default 10m)')
  .option('--once', 'Make one attempt and exit 2 if not yet verified (for CI)')
  .action(async (opts) => {
    const { providerVerifyDnsCmd } = await import('./commands/provider.js');
    await providerVerifyDnsCmd(opts);
  });

provider
  .command('me')
  .description('Show Provider status (DNS, Stripe, total calls)')
  .action(async () => {
    const { providerMeCmd } = await import('./commands/provider.js');
    await providerMeCmd();
  });

provider
  .command('rotate-key')
  .description("Rotate this Provider's API key. Previous key remains valid for 7 days unless --revoke-old.")
  .option('--grace-seconds <int>', 'Override grace window in seconds (60..604800)')
  .option('--revoke-old', 'Revoke the old key immediately instead of using a grace period')
  .option('--yes', 'Skip the interactive confirmation')
  .action(async (opts) => {
    const { providerRotateKeyCmd } = await import('./commands/provider.js');
    await providerRotateKeyCmd(opts);
  });

provider
  .command('publish [file]')
  .description('Publish a manifest YAML to /v1/manifests (default file: jecp.yaml)')
  .action(async (file: string | undefined) => {
    const { providerPublishCmd } = await import('./commands/provider.js');
    await providerPublishCmd({ file });
  });

provider
  .command('connect-stripe')
  .description('Get Stripe Connect Express onboarding URL for USD payouts')
  .action(async () => {
    const { providerConnectStripeCmd } = await import('./commands/provider.js');
    await providerConnectStripeCmd();
  });

// W4 — Webhook subscription commands
const webhook = program.command('webhook').description('Webhook subscription management (W4)');

webhook
  .command('subscribe')
  .description('Subscribe to webhook events. Returns hmac_secret (one-time)')
  .requiredOption('--url <url>', 'Endpoint URL (must be https://)')
  .option('--events <csv>', 'Comma-separated event types (omit for all)')
  .action(async (opts) => {
    const { webhookSubscribeCmd } = await import('./commands/webhook.js');
    await webhookSubscribeCmd(opts);
  });

webhook
  .command('list')
  .description('List your webhook subscriptions')
  .action(async () => {
    const { webhookListCmd } = await import('./commands/webhook.js');
    await webhookListCmd();
  });

webhook
  .command('test <subscription_id>')
  .description('Send a synthetic test event to your endpoint')
  .action(async (subId) => {
    const { webhookTestCmd } = await import('./commands/webhook.js');
    await webhookTestCmd(subId);
  });

program.parseAsync(process.argv).catch((e: Error) => {
  fail(e.message);
});
