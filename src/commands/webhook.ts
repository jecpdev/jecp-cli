import { getClient } from '../sdk.js';
import { emit, info, success, bold, dim } from '../output.js';

export async function webhookSubscribeCmd(opts: { url: string; events?: string }) {
  const jecp = getClient();
  const events = opts.events ? opts.events.split(',').map(e => e.trim()).filter(Boolean) : undefined;
  const sub = await jecp.subscribe({
    endpoint_url: opts.url,
    ...(events && { events }),
  });
  emit(sub, () => {
    success('Subscription created.');
    info('');
    info(`${bold('Subscription ID:')}  ${sub.subscription_id}`);
    info(`${bold('Endpoint:')}         ${sub.endpoint_url}`);
    info(`${bold('Events:')}           ${sub.events.length === 0 ? 'all' : sub.events.join(', ')}`);
    info('');
    info(bold('HMAC SECRET (shown once — save it now):'));
    info(`  ${sub.hmac_secret}`);
    info('');
    info(dim('Use this secret with @jecpdev/sdk verifyWebhook() to validate inbound events.'));
  });
}

export async function webhookListCmd() {
  const jecp = getClient();
  const r = await jecp.listSubscriptions();
  emit(r, () => {
    info(bold(`Webhook subscriptions (${r.count}):`));
    info('');
    for (const s of r.subscriptions as Array<{
      subscription_id: string; endpoint_url: string; events: string[]; status: string;
      failures_consecutive: number; last_success_at?: string;
    }>) {
      const mark = s.status === 'active' ? '●' : '○';
      info(`  ${mark} ${bold(s.subscription_id)}  [${s.status}]`);
      info(`    ${s.endpoint_url}`);
      info(`    ${dim('events: ' + (s.events.length === 0 ? 'all' : s.events.join(', ')))}`);
      if (s.failures_consecutive > 0) {
        info(`    ${dim('⚠ ' + s.failures_consecutive + ' consecutive failures')}`);
      }
      info('');
    }
  });
}

export async function webhookTestCmd(subscriptionId: string) {
  const jecp = getClient();
  const r = await jecp.testSubscription(subscriptionId);
  emit(r, () => {
    success('Test event enqueued.');
    info(`${bold('Event ID:')}  ${r.event_id}`);
    info(dim('Check your endpoint logs — delivery within ~2-5 seconds.'));
  });
}
