import { getClient } from '../sdk.js';
import { emit, info, success, error, bold, dim, fail } from '../output.js';

export async function refundRequestCmd(transactionId: string, opts: { reason: string; evidenceUrl?: string }) {
  if (!opts.reason) fail('--reason required');
  const jecp = getClient();
  const r = await jecp.requestRefund({
    transaction_id: transactionId,
    reason: opts.reason,
    ...(opts.evidenceUrl && { evidence_url: opts.evidenceUrl }),
  });
  emit(r, () => {
    success('Refund requested.');
    info('');
    info(`${bold('Refund ID:')}     ${r.refund_id}`);
    info(`${bold('Status:')}        ${r.status}`);
    info(`${bold('Amount:')}        $${r.amount_usdc} USDC`);
    if (r.estimated_resolution) {
      info(`${dim(`Auto-resolves: ${r.estimated_resolution}`)}`);
    }
  });
}

export async function refundGetCmd(refundId: string) {
  const jecp = getClient();
  const r = await jecp.getRefund(refundId);
  emit(r);
}

export async function refundListCmd(opts: { limit?: string }) {
  const jecp = getClient();
  const limit = opts.limit ? parseInt(opts.limit, 10) : 50;
  const r = await jecp.listRefunds({ limit });
  emit(r, () => {
    info(bold(`Refunds (${r.count}):`));
    info('');
    for (const item of r.refunds as Array<{
      refund_id: string; status: string; amount_usdc: number; reason: string; requested_at: string;
    }>) {
      const s = item.status === 'requested' ? '⋯' : item.status === 'denied' ? '✗' : '✓';
      info(`  ${s} ${bold(item.refund_id)}  $${item.amount_usdc}  [${item.status}]`);
      info(`    ${dim(item.reason)}`);
      info(`    ${dim('requested ' + item.requested_at)}`);
      info('');
    }
  });
}
