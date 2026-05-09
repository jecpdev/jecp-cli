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

function printCatalog(c: CatalogResponse): void {
  const tp = (c.third_party_capabilities ?? []) as Array<{ id: string; description?: string; total_calls?: number; tags?: string[] }>;
  if (tp.length === 0) {
    info(dim('(no third-party capabilities yet)'));
  } else {
    info(bold(`Third-party capabilities (${tp.length}${c.has_more ? '+' : ''}):`));
    info('');
    for (const cap of tp) {
      info(`  ${bold(cap.id)}    ${dim(`${cap.total_calls ?? 0} calls`)}`);
      if (cap.description) info(`    ${cap.description}`);
      if (cap.tags && cap.tags.length > 0) info(`    ${dim('tags: ' + cap.tags.join(', '))}`);
      info('');
    }
  }
  info(dim(`Page size: ${c.page_size ?? '?'}, has_more: ${c.has_more ?? false}`));
  if (c.has_more && c.next_cursor) {
    info(dim(`Next page: jecp catalog --cursor ${c.next_cursor}`));
  }
}
