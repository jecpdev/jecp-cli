import { getClient } from '../sdk.js';
import { emit, success, info, bold } from '../output.js';

export async function topupCmd(amount: string, opts: { returnTo?: string }) {
  const n = parseInt(amount, 10);
  if (![5, 20, 100].includes(n)) {
    throw new Error('amount must be one of 5, 20, 100');
  }
  const jecp = getClient();
  const r = await jecp.topup(n as 5 | 20 | 100, { ...(opts.returnTo && { returnTo: opts.returnTo }) });
  emit({ url: r.url, sessionId: r.sessionId }, () => {
    success(`Top-up Stripe Checkout URL ready.`);
    info('');
    info(bold('Open this URL to pay:'));
    info(`  ${r.url}`);
  });
}
