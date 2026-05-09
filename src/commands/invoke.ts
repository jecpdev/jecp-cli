import { getClient } from '../sdk.js';
import { JecpError } from '@jecpdev/sdk';
import { emit, info, success, error, warn, fail, bold, dim } from '../output.js';

export async function invokeCmd(
  capability: string,
  action: string,
  opts: { input?: string; budget?: string; timeout?: string; requestId?: string },
) {
  let input: unknown = {};
  if (opts.input) {
    try {
      input = JSON.parse(opts.input);
    } catch (e) {
      fail(`--input must be valid JSON: ${(e as Error).message}`);
    }
  }

  const jecp = getClient();
  const invokeOpts: { mandate?: { budget_usdc: number }; timeoutMs?: number; requestId?: string } = {};
  if (opts.budget !== undefined) {
    const b = parseFloat(opts.budget);
    if (Number.isNaN(b) || b < 0) fail(`--budget must be a positive number, got "${opts.budget}"`);
    invokeOpts.mandate = { budget_usdc: b };
  }
  if (opts.timeout !== undefined) {
    invokeOpts.timeoutMs = parseInt(opts.timeout, 10);
  }
  if (opts.requestId !== undefined) {
    invokeOpts.requestId = opts.requestId;
  }

  try {
    const r = await jecp.invoke(capability, action, input, invokeOpts);
    emit(
      {
        output: r.output,
        billing: r.billing,
        provider: r.provider,
        wallet_balance_after: r.wallet_balance_after,
        attempts: r.attempts,
        request_id: r.request_id,
      },
      () => {
        success('Invocation complete.');
        info('');
        info(`${bold('Output:')}      ${JSON.stringify(r.output)}`);
        info(`${bold('Provider:')}    ${r.provider.namespace}/${r.provider.capability}@${r.provider.version}`);
        info(`${bold('Charged:')}     ${r.billing.charged ? `$${r.billing.amount_usdc} USDC` : 'no'}`);
        if (r.wallet_balance_after !== undefined) {
          info(`${bold('Balance:')}     $${r.wallet_balance_after} USDC`);
        }
        if (r.billing.transaction_id) {
          info(`${dim(`tx: ${r.billing.transaction_id}`)}`);
        }
        if (r.attempts > 0) {
          warn(`Took ${r.attempts + 1} attempts (auto-retried)`);
        }
      },
    );
  } catch (e) {
    if (e instanceof JecpError) {
      error(`${e.code}: ${e.message}`);
      if (e.nextAction) {
        info('');
        info(bold('Next action:'));
        info(`  type: ${e.nextAction.type}`);
        if ('hint' in e.nextAction && e.nextAction.hint) {
          info(`  hint: ${e.nextAction.hint}`);
        }
        if ('api' in e.nextAction && e.nextAction.api) {
          info(`  api:  ${e.nextAction.api}`);
        }
        if ('ui' in e.nextAction && e.nextAction.ui) {
          info(`  ui:   ${e.nextAction.ui}`);
        }
      }
      process.exit(1);
    }
    throw e;
  }
}
