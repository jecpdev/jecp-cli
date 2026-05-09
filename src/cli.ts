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
  .version('0.1.0')
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
  .action(async (capability, action, opts) => {
    const { invokeCmd } = await import('./commands/invoke.js');
    await invokeCmd(capability, action, opts);
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

program.parseAsync(process.argv).catch((e: Error) => {
  fail(e.message);
});
