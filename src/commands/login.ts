import prompts from 'prompts';
import { saveConfig, loadConfig, configFilePath } from '../config.js';
import { info, success, fail } from '../output.js';

export async function loginCmd(opts: { agentId?: string; apiKey?: string; baseUrl?: string }) {
  let { agentId, apiKey, baseUrl } = opts;
  if (!agentId || !apiKey) {
    const ans = await prompts([
      { type: 'text', name: 'agentId', message: 'Agent ID (jdb_ag_*)', initial: agentId },
      { type: 'password', name: 'apiKey', message: 'API key (jdb_ak_*)', initial: apiKey },
    ]);
    agentId = ans.agentId;
    apiKey = ans.apiKey;
    if (!agentId || !apiKey) fail('aborted');
  }
  const cfg = loadConfig();
  cfg.agent_id = agentId;
  cfg.api_key = apiKey;
  if (baseUrl) cfg.base_url = baseUrl;
  saveConfig(cfg);
  success(`Saved to ${configFilePath()} (mode 0600)`);
}

export async function logoutCmd() {
  saveConfig({});
  success(`Cleared credentials at ${configFilePath()}`);
}
