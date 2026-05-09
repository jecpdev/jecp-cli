import { JecpClient } from '@jecpdev/sdk';
import prompts from 'prompts';
import { saveConfig, loadConfig, configFilePath } from '../config.js';
import { emit, info, success, bold, fail, dim } from '../output.js';

export async function registerCmd(opts: { name?: string; type?: string; description?: string }) {
  let { name, type, description } = opts;

  if (!name) {
    const ans = await prompts([
      { type: 'text',  name: 'name',        message: 'Agent name (display label)', validate: (v) => v.length > 0 },
      { type: 'text',  name: 'type',        message: 'Agent type (e.g. research, coder, demo)', initial: 'demo' },
      { type: 'text',  name: 'description', message: 'Short description (optional)' },
    ]);
    if (!ans.name) fail('aborted');
    name = ans.name;
    type = ans.type;
    description = ans.description;
  }

  info(`Registering agent ${bold(name!)}...`);

  const baseUrl = process.env.JECP_BASE_URL ?? 'https://jecp.dev';
  const reg = await JecpClient.register(
    {
      name: name!,
      ...(type && { agent_type: type }),
      ...(description && { description }),
    },
    baseUrl,
  );

  // Save credentials FIRST so the success message about auto-save can lead.
  const cfg = loadConfig();
  cfg.agent_id = reg.agent_id;
  cfg.api_key = reg.api_key;
  if (baseUrl !== 'https://jecp.dev') cfg.base_url = baseUrl;
  saveConfig(cfg);

  // Lead message: subsequent jecp commands work automatically.
  success(`Agent registered. Credentials auto-saved to ${bold(configFilePath())} (mode 0600)`);
  info(dim(`  → All subsequent jecp commands authenticate automatically. No env-var setup needed.`));
  info('');

  // Compact credentials block for users who want to copy elsewhere.
  const freeCalls =
    (reg as { free_calls_remaining?: number }).free_calls_remaining
    ?? (reg as { benefits?: { free_api_calls?: number } }).benefits?.free_api_calls
    ?? 100;
  info(bold('Credentials (api_key shown ONLY ONCE — store externally if you need it elsewhere):'));
  info(`  AGENT_ID:   ${reg.agent_id}`);
  info(`  API_KEY:    ${reg.api_key}`);
  info(`  Free calls: ${freeCalls}`);
  info('');

  // First-success suggestion — PM-identified friction: "capability_id を覚えていない"
  info(bold('Try your first invocation now (uses 1 of your 100 free calls):'));
  info(`  ${dim('$')} jecp invoke jobdonebot/content-factory translate \\`);
  info(`        --input '{"text":"Hello","target_lang":"JA"}'`);
  info('');
  info(`  Then explore the catalog:`);
  info(`  ${dim('$')} jecp catalog`);
  info('');

  emit({
    agent_id: reg.agent_id,
    api_key: reg.api_key,
    name: name,
    free_calls_remaining: freeCalls,
    config_file: configFilePath(),
    next_step: {
      command: 'jecp invoke jobdonebot/content-factory translate --input \'{"text":"Hello","target_lang":"JA"}\'',
      description: `Try your first invocation (uses 1 of ${freeCalls} free calls)`,
    },
  });
}
