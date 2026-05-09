import prompts from 'prompts';
import { getClient } from '../sdk.js';
import { JecpError } from '@jecpdev/sdk';
import { loadConfig, saveConfig, configFilePath } from '../config.js';
import { emit, success, info, warn, error, bold, dim } from '../output.js';

interface RotateOpts {
  graceSeconds?: string;
  yes?: boolean;
}

export async function rotateKeyCmd(opts: RotateOpts): Promise<void> {
  if (!opts.yes) {
    const ans = await prompts({
      type: 'confirm',
      name: 'go',
      message: 'Rotate this agent\'s API key? The previous key remains valid for 7 days unless overridden.',
      initial: false,
    });
    if (!ans.go) {
      info('Aborted.');
      return;
    }
  }

  const grace = opts.graceSeconds !== undefined ? parseInt(opts.graceSeconds, 10) : undefined;
  if (grace !== undefined && (Number.isNaN(grace) || grace < 60 || grace > 604800)) {
    error('--grace-seconds must be an integer between 60 and 604800 (7 days).');
    process.exit(1);
  }

  const jecp = getClient();
  try {
    const r = await jecp.rotateApiKey(grace !== undefined ? { graceSeconds: grace } : {});

    // Persist the new key in ~/.jecp/config.json so subsequent jecp commands
    // pick it up automatically.
    const cfg = loadConfig();
    if (cfg.agent_id && cfg.agent_id === r.agent_id) {
      cfg.api_key = r.api_key;
      saveConfig(cfg);
    }

    emit(
      {
        agent_id: r.agent_id,
        api_key: r.api_key,
        previous_key_valid_until: r.previous_key_valid_until,
        grace_seconds: r.grace_seconds,
        config_file: configFilePath(),
      },
      () => {
        success('Agent API key rotated.');
        info('');
        info(`${bold('New api_key:')}              ${r.api_key}`);
        info(`${bold('Previous key valid until:')} ${r.previous_key_valid_until}`);
        info(`${bold('Grace seconds:')}            ${r.grace_seconds}`);
        info('');
        if (cfg.agent_id === r.agent_id) {
          info(dim(`Saved to ${configFilePath()} (chmod 600).`));
        } else {
          warn('Local config did not match this agent — new key NOT auto-saved.');
        }
        info('');
        warn('This api_key is shown only once. Persist it now in your secret store.');
      },
    );
  } catch (e) {
    if (e instanceof JecpError) {
      error(`${e.code}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}
