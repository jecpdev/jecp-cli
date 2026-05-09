import type { CatalogResponse } from '@jecpdev/sdk';
import { getClient } from '../sdk.js';
import { emit, info, bold, dim } from '../output.js';

export async function catalogCmd(opts: {
  pageSize?: string;
  namespace?: string;
  tags?: string;
  all?: boolean;
}) {
  const jecp = getClient();

  if (opts.all) {
    const result = await jecp.catalogAll();
    emit(result, () => printCatalog(result));
    return;
  }

  const pageSize = opts.pageSize ? parseInt(opts.pageSize, 10) : 50;
  const result = await jecp.catalog({
    pageSize,
    ...(opts.namespace && { namespace: opts.namespace }),
    ...(opts.tags && { tags: opts.tags.split(',') }),
  });

  emit(result, () => printCatalog(result));
}

interface ActionInfo {
  id: string;
  name?: string;
  description?: string;
  price_usdc?: number;
  pricing?: { base?: string };
  input_schema?: { required?: string[] };
}

interface CapInfo {
  id: string;
  name?: string;
  description?: string;
  total_calls?: number;
  tags?: string[];
  actions?: ActionInfo[];
  manifest?: { actions?: ActionInfo[] };
}

function printCatalog(c: CatalogResponse): void {
  // Built-in capabilities (free calls via /v1/jecp legacy endpoint).
  // The CLI's `jecp invoke` only hits /v1/invoke (Provider routing) —
  // built-ins are still listed for reference but require their
  // Provider-routed twin (e.g. jobdonebot/<id>) to be invokable here.
  const builtin = (c.capabilities ?? []) as unknown as CapInfo[];
  const tp = (c.third_party_capabilities ?? []) as unknown as CapInfo[];

  if (builtin.length === 0 && tp.length === 0) {
    info(dim('(no capabilities yet)'));
    return;
  }

  if (tp.length > 0) {
    info(bold(`Third-party capabilities (${tp.length}${c.has_more ? '+' : ''}) — invokable via wallet:`));
    info('');
    for (const cap of tp) {
      printOneCapability(cap, true);
    }
  }

  if (builtin.length > 0) {
    info(bold(`Built-in capabilities (${builtin.length}) — JobDoneBot reference:`));
    info(dim('  These have wallet-billed twins under namespace jobdonebot/'));
    info('');
    for (const cap of builtin) {
      printOneCapability(cap, false);
    }
  }

  info(dim(`Page size: ${c.page_size ?? '?'}, has_more: ${c.has_more ?? false}`));
  if (c.has_more && c.next_cursor) {
    info(dim(`Next page: jecp catalog --cursor ${c.next_cursor}`));
  }
}

function printOneCapability(cap: CapInfo, invokable: boolean): void {
  info(`  ${bold(cap.id)}    ${dim(`${cap.total_calls ?? 0} calls`)}`);
  if (cap.description) info(`    ${cap.description}`);
  if (cap.tags && cap.tags.length > 0) info(`    ${dim('tags: ' + cap.tags.join(', '))}`);

  // Actions live at .actions for built-ins, .manifest.actions for third-party.
  const actions = cap.actions ?? cap.manifest?.actions ?? [];
  if (actions.length > 0) {
    const shown = actions.slice(0, 5);
    info(`    ${dim('Actions:')}`);
    for (const a of shown) {
      const price = formatPrice(a);
      const desc = a.description ? `  ${a.description.slice(0, 60)}` : '';
      info(`      ${dim('•')} ${a.id}  ${dim(price)}${desc}`);
    }
    if (actions.length > shown.length) {
      info(`      ${dim(`... +${actions.length - shown.length} more`)}`);
    }
    if (invokable && shown.length > 0) {
      const a0 = shown[0];
      const requiredFields = a0.input_schema?.required ?? [];
      const exampleInput = requiredFields.length > 0
        ? `{${requiredFields.map(f => `"${f}":"..."`).join(',')}}`
        : '{}';
      info(`    ${dim(`Try: jecp invoke ${cap.id} ${a0.id} --input '${exampleInput}'`)}`);
    }
  }
  info('');
}

function formatPrice(a: ActionInfo): string {
  if (a.price_usdc !== undefined) return `$${a.price_usdc.toFixed(4)}`;
  if (a.pricing?.base) return a.pricing.base; // already includes $
  return '$?';
}
