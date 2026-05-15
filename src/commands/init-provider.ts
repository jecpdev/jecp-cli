import prompts from 'prompts';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, info, success, warn, bold, dim, fail } from '../output.js';
import { isValidBaseAddress } from '../x402/config-ext.js';

/** v0.7.0 — x402 opt-in answers from the wizard (Locked design §6.2 default-on). */
interface X402ProviderConfig {
  acceptX402: boolean;
  usdcPayoutAddress?: `0x${string}`;
}

interface InitOpts {
  output?: string;
  yes?: boolean;
  /** When true, write a tiny example without prompting (for CI / docs). */
  example?: boolean;
}

interface ActionDraft {
  id: string;
  name: string;
  description: string;
  base_price_usdc: number;
  streaming: boolean;
}

/**
 * Interactive scaffolding for a Provider's `jecp.yaml` manifest.
 *
 * PM-identified friction (S3-1): "yaml 書き始めるのに 60 min 〜 3 days、
 * 自社 API を capability にマッピングする発想転換が最大の壁". A 5-question
 * wizard cuts that to ~5 minutes.
 *
 * Output format conforms to spec 04-manifest.md §5. The generated YAML is
 * intentionally minimal — devs add input/output JSON Schemas afterward.
 */
export async function initProviderCmd(opts: InitOpts): Promise<void> {
  const outPath = resolve(opts.output ?? 'jecp.yaml');
  if (existsSync(outPath) && !opts.yes) {
    const ans = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `${outPath} already exists. Overwrite?`,
      initial: false,
    });
    if (!ans.overwrite) {
      info('Aborted.');
      return;
    }
  }

  if (opts.example) {
    writeFileSync(outPath, exampleYaml(), 'utf-8');
    success(`Wrote example manifest to ${outPath}`);
    return;
  }

  // Provider-level questions
  const provider = await prompts([
    {
      type: 'text',
      name: 'namespace',
      message: 'Namespace (lowercase, 3-32 chars, [a-z0-9-])',
      validate: (v) => /^[a-z][a-z0-9-]{2,31}$/.test(v) || 'must match ^[a-z][a-z0-9-]{2,31}$',
    },
    { type: 'text', name: 'display_name', message: 'Display name (human label)', validate: (v) => v.length > 0 },
    { type: 'text', name: 'website', message: 'Website URL', initial: 'https://' },
    { type: 'text', name: 'support_email', message: 'Support email' },
    {
      type: 'text',
      name: 'endpoint',
      message: 'HTTPS endpoint that receives Hub-forwarded calls',
      validate: (v) => v.startsWith('https://') || 'must start with https://',
    },
  ]);

  if (!provider.namespace) fail('aborted');

  // v0.7.0 — x402 opt-in (Locked design §6.2 — hybrid mode is the recommended default)
  const x402cfg = await promptX402Config();

  // Capability-level questions
  const capability = await prompts([
    {
      type: 'text',
      name: 'capability',
      message: 'Capability id (lowercase, 3-64 chars, [a-z0-9-])',
      validate: (v) => /^[a-z][a-z0-9-]{2,63}$/.test(v) || 'must match ^[a-z][a-z0-9-]{2,63}$',
    },
    { type: 'text', name: 'version', message: 'Version (semver)', initial: '1.0.0' },
    {
      type: 'text',
      name: 'description',
      message: 'One-line description (≤500 chars)',
      validate: (v) => v.length > 0 && v.length <= 500,
    },
    { type: 'text', name: 'tags', message: 'Tags (comma-separated, optional)', initial: '' },
  ]);

  if (!capability.capability) fail('aborted');

  // Action prompts (loop until "no more")
  const actions: ActionDraft[] = [];
  for (;;) {
    const action = await prompts([
      {
        type: 'text',
        name: 'id',
        message: actions.length === 0 ? 'First action id' : `Next action id (or empty to finish — already added ${actions.length})`,
        validate: (v) => v === '' || /^[a-z][a-z0-9-]{2,63}$/.test(v) || 'must match ^[a-z][a-z0-9-]{2,63}$',
      },
    ]);
    if (!action.id) break;

    const detail = await prompts([
      { type: 'text',   name: 'name',        message: 'Action name (human label)' },
      { type: 'text',   name: 'description', message: 'Description (≤300 chars)', validate: (v) => v.length > 0 && v.length <= 300 },
      { type: 'number', name: 'base_price_usdc', message: 'Base price in USDC (e.g. 0.005)', initial: 0.005, float: true, min: 0 },
      { type: 'confirm', name: 'streaming', message: 'Streaming response (Server-Sent Events)?', initial: false },
    ]);

    actions.push({
      id: action.id,
      name: detail.name ?? action.id,
      description: detail.description,
      base_price_usdc: detail.base_price_usdc ?? 0.005,
      streaming: detail.streaming ?? false,
    });
  }

  if (actions.length === 0) fail('at least one action required');

  // Render
  const yaml = renderYaml(provider, capability, actions, x402cfg);
  writeFileSync(outPath, yaml, 'utf-8');

  success(`Wrote ${outPath}`);
  info('');
  info(bold('Next steps:'));
  info(`  1. Edit ${outPath} and fill in input_schema / output_schema for each action.`);
  info(`     ${dim('See spec/04-manifest.md §5 for the JSON Schema 2020-12 subset.')}`);
  info('');
  info(`  2. Register your Provider (auto-polls DNS until propagated):`);
  info(`     ${dim('$')} jecp provider register \\`);
  info(`           --namespace ${provider.namespace} \\`);
  info(`           --display-name "${provider.display_name}" \\`);
  info(`           --email ${provider.support_email ?? '<owner@example.com>'} \\`);
  info(`           --endpoint ${provider.endpoint} \\`);
  info(`           --country <ISO>  ${dim('# e.g. JP, US, DE')} \\`);
  info(`           --wait           ${dim('# auto-poll verify-dns after register')}`);
  info('');
  info(`  3. Connect Stripe for USD payouts:`);
  info(`     ${dim('$')} jecp provider connect-stripe`);
  info('');
  info(`  4. Publish the manifest:`);
  info(`     ${dim('$')} jecp provider publish ${outPath}`);
  info(`     ${dim('Auto-detects creds from config. Status auto-promotes to')}`);
  info(`     ${dim('"active" once both DNS and Stripe are verified.')}`);
  info('');

  if (actions.some((a) => a.streaming)) {
    warn('At least one action is streaming. See https://jecp.dev/guides/streaming for Provider-side SSE response format.');
  }

  emit({
    output_path: outPath,
    namespace: provider.namespace,
    capability: capability.capability,
    actions: actions.map((a) => a.id),
  });
}

function renderYaml(
  p: Record<string, string>,
  c: Record<string, string>,
  actions: ActionDraft[],
  x402cfg: X402ProviderConfig,
): string {
  const tags = (c.tags ?? '')
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean);
  const tagsLine = tags.length > 0 ? `tags: [${tags.map((t) => `"${t}"`).join(', ')}]` : '# tags: []';

  const paymentMethodsLine = paymentMethodsYamlLine(x402cfg);
  const usdcPayoutLine = usdcPayoutAddressYamlLine(x402cfg);

  const actionsYaml = actions
    .map(
      (a) => `  - id: ${a.id}
    name: "${a.name}"
    description: "${a.description.replace(/"/g, '\\"')}"
    streaming: ${a.streaming}
    pricing:
      base: "$${a.base_price_usdc}"
      currency: USDC
      model: ${a.streaming ? 'flat' : 'per_call'}
${paymentMethodsLine}
    trust_tier_required: bronze
    input_schema:
      type: object
      required: []
      properties: {}
    output_schema:
      type: object
      properties: {}
    examples:
      - input: {}
        output: {}
    side_effects:
      external_api_call: false
      stores_data: false
      modifies_state: false
      sends_email: false
    sla:
      latency_p95_ms: 2000
      timeout_ms: 30000`,
    )
    .join('\n');

  return `# Generated by \`jecp init-provider\` (CLI v0.7.0+)
# JECP Provider manifest — see https://github.com/jecpdev/jecp-spec/blob/main/spec/04-manifest.md

namespace: ${p.namespace}
display_name: "${p.display_name}"
website: "${p.website ?? ''}"
support_email: "${p.support_email ?? ''}"
${usdcPayoutLine ? usdcPayoutLine + '\n' : ''}
capability: ${c.capability}
version: ${c.version}
description: "${c.description.replace(/"/g, '\\"')}"
${tagsLine}

endpoint: "${p.endpoint}"
streaming: ${actions.some((a) => a.streaming)}

authentication:
  type: api_key
  header_name: x-jecp-signature

actions:
${actionsYaml}

compliance:
  pii_handling: process_only_no_store
  gdpr_compliant: true
  data_residency: ["JP", "US"]

billing:
  payout_currency: USD
  stripe_connect_required: true

deprecation:
  status: active
`;
}

function exampleYaml(): string {
  return `# Example JECP Provider manifest
# Generated by \`jecp init-provider --example\`

namespace: example
display_name: "Example Translator"
website: "https://example.com"
support_email: "ops@example.com"

capability: translate
version: 1.0.0
description: "Translate text between 10 supported languages."
tags: ["translation", "language", "ai"]

endpoint: "https://example.com/jecp"
streaming: false

authentication:
  type: api_key
  header_name: x-jecp-signature

actions:
  - id: translate
    name: "Translate text"
    description: "Translate input text to the target language."
    streaming: false
    pricing:
      base: "$0.005"
      currency: USDC
      model: per_call
    trust_tier_required: bronze
    input_schema:
      type: object
      required: ["text", "target_lang"]
      properties:
        text: { type: string, maxLength: 5000 }
        target_lang: { type: string, pattern: "^[a-z]{2}$" }
    output_schema:
      type: object
      properties:
        translation: { type: string }
        detected_lang: { type: string }
    examples:
      - input: { text: "Hello", target_lang: "ja" }
        output: { translation: "こんにちは", detected_lang: "en" }
    side_effects:
      external_api_call: false
      stores_data: false
      modifies_state: false
      sends_email: false
    sla:
      latency_p95_ms: 1500
      timeout_ms: 30000

compliance:
  pii_handling: process_only_no_store
  gdpr_compliant: true
  data_residency: ["US"]

billing:
  payout_currency: USD
  stripe_connect_required: true

deprecation:
  status: active
`;
}

// ──────────────────────────────────────────────────────────────────────
// v0.7.0 — x402 prompts + YAML helpers (Locked design §6.2 / Panel 4 §C)
// ──────────────────────────────────────────────────────────────────────

/**
 * Prompt the operator for x402 opt-in. Default Y per locked design §6.2
 * (hybrid mode is the recommended default for new Providers).
 *
 * The optional 1-wei USDC test transfer (Panel 4 §C.4 item 8) is documented
 * as a runtime step rather than executed by the wizard — running on-chain
 * transactions from a scaffold tool is an unexpected side effect.
 */
async function promptX402Config(): Promise<X402ProviderConfig> {
  const optIn = await prompts({
    type: 'confirm',
    name: 'accept',
    message: 'Accept x402 (USDC on Base) payments? Recommended — higher Provider net margin (locked design §6.2).',
    initial: true,
  });
  if (!optIn.accept) {
    info(`  ${dim('Skipping x402 setup. You can opt in later by editing the manifest.')}`);
    return { acceptX402: false };
  }

  const addr = await prompts({
    type: 'text',
    name: 'address',
    message: 'USDC payout address (Base mainnet, 0x + 40 hex chars):',
    validate: (v: string) => isValidBaseAddress(v) || 'Must match ^0x[a-fA-F0-9]{40}$',
  });
  if (!addr.address) {
    info(`  ${dim('No address provided; falling back to Stripe-only.')}`);
    return { acceptX402: false };
  }

  info('');
  info(`  ${dim('Address recorded. Before going live, send a 1-wei USDC transfer to')}`);
  info(`  ${dim('the JECP Splitter test contract to verify ownership:')}`);
  info(`  ${dim('  $ cast send <USDC_BASE> "transfer(address,uint256)" <SPLITTER> 1 --rpc-url $BASE_RPC_URL')}`);
  info('');

  return {
    acceptX402: true,
    usdcPayoutAddress: addr.address.toLowerCase() as `0x${string}`,
  };
}

/**
 * `payment_methods` YAML line for each action's pricing block.
 * Hybrid (`["stripe", "x402"]`) by default; Stripe-only when operator opts out.
 */
function paymentMethodsYamlLine(cfg: X402ProviderConfig): string {
  if (cfg.acceptX402) {
    return `      payment_methods: ["stripe", "x402"]`;
  }
  return `      payment_methods: ["stripe"]`;
}

/**
 * Top-level Provider field — `usdc_payout_address: "0x..."` when x402 is
 * accepted; empty string (omitted) otherwise.
 */
function usdcPayoutAddressYamlLine(cfg: X402ProviderConfig): string {
  if (cfg.acceptX402 && cfg.usdcPayoutAddress) {
    return `usdc_payout_address: "${cfg.usdcPayoutAddress}"`;
  }
  return ``;
}
