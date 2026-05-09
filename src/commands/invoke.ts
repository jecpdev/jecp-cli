import { getClient } from '../sdk.js';
import { JecpError } from '@jecpdev/sdk';
import { emit, info, success, error, warn, fail, bold, dim } from '../output.js';

interface InvokeOpts {
  input?: string;
  budget?: string;
  timeout?: string;
  requestId?: string;
  stream?: boolean;
}

export async function invokeCmd(
  capability: string,
  action: string,
  opts: InvokeOpts,
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

  if (opts.stream) {
    await runStream(jecp, capability, action, input, invokeOpts);
    return;
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

async function runStream(
  jecp: ReturnType<typeof getClient>,
  capability: string,
  action: string,
  input: unknown,
  invokeOpts: { mandate?: { budget_usdc: number }; timeoutMs?: number; requestId?: string },
): Promise<void> {
  const stream = jecp.invokeStream(capability, action, input, invokeOpts);
  let exitCode = 0;
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'chunk':
          process.stdout.write(event.delta);
          break;
        case 'meter':
          // surface meter events via stderr so JSON output stays clean if consumer pipes stdout
          if (event.tokens !== undefined) {
            process.stderr.write(dim(`\n[meter] tokens=${event.tokens}\n`));
          }
          break;
        case 'completed':
          process.stdout.write('\n');
          success('Stream completed.');
          info(`${bold('Billing:')}     ${
            event.billing && event.billing.charged
              ? `$${event.billing.amount_usdc} USDC (tx ${event.billing.transaction_id ?? '—'})`
              : 'not charged'
          }`);
          break;
        case 'error': {
          process.stdout.write('\n');
          error(`${event.error.code}: ${event.error.message}`);
          exitCode = 1;
          break;
        }
        case 'cancelled':
          process.stdout.write('\n');
          warn(`Cancelled${event.reason ? `: ${event.reason}` : ''}`);
          if (event.billing && event.billing.charged) {
            info(`Partial bill: $${event.billing.amount_usdc} USDC`);
          }
          exitCode = 1;
          break;
      }
    }
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
      }
      process.exit(1);
    }
    throw e;
  }
  if (exitCode !== 0) process.exit(exitCode);
}
