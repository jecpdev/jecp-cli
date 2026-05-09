import { getClient, getBaseUrl } from '../sdk.js';
import { resolveAuth } from '../config.js';
import { emit, info, success, error, bold, dim } from '../output.js';

export async function statusCmd() {
  const auth = resolveAuth();
  const jecp = getClient();

  const baseUrl = getBaseUrl();
  const healthUrl = `${baseUrl}/health`;
  let healthOk = false;
  let healthLatency = 0;
  try {
    const start = Date.now();
    const res = await fetch(healthUrl);
    healthLatency = Date.now() - start;
    healthOk = res.ok;
  } catch {
    healthOk = false;
  }

  // Catalog as a smoke test (also tells us if our credentials work indirectly)
  let catalogCount: number | undefined;
  try {
    const cat = await jecp.catalog({ pageSize: 1 });
    catalogCount = cat.third_party_count;
  } catch {
    /* ignore */
  }

  const summary = {
    base_url: baseUrl,
    agent_id: auth.agentId,
    health: { ok: healthOk, latency_ms: healthLatency },
    third_party_capabilities: catalogCount,
  };

  emit(summary, () => {
    info(bold('JECP Status'));
    info('─'.repeat(40));
    info(`Hub URL:                ${baseUrl}`);
    info(`Agent ID:               ${auth.agentId ?? dim('(not configured)')}`);
    if (healthOk) {
      success(`Health check: ok (${healthLatency}ms)`);
    } else {
      error(`Health check: FAILED (${healthUrl})`);
    }
    if (catalogCount !== undefined) {
      success(`Catalog: ${catalogCount} third-party capabilities`);
    }
  });
}
