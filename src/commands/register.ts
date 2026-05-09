import { JecpClient } from '@jecpdev/sdk';
import prompts from 'prompts';
import { saveConfig, loadConfig } from '../config.js';
import { emit, info, success, warn, bold, fail } from '../output.js';

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

  success(`Agent registered.`);
  info('');
  info(bold('Save these credentials — the api_key is shown only once:'));
  info('');
  info(`  AGENT_ID:   ${reg.agent_id}`);
  info(`  API_KEY:    ${reg.api_key}`);
  info(`  Free calls: ${reg.free_calls_remaining}`);
  info('');

  // Save to config
  const cfg = loadConfig();
  cfg.agent_id = reg.agent_id;
  cfg.api_key = reg.api_key;
  if (baseUrl !== 'https://jecp.dev') cfg.base_url = baseUrl;
  saveConfig(cfg);
  success(`Credentials saved to ~/.jecp/config.json (mode 0600)`);

  emit({
    agent_id: reg.agent_id,
    api_key: reg.api_key,
    name: reg.name,
    free_calls_remaining: reg.free_calls_remaining,
  });
}
