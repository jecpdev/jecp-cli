import prompts from 'prompts';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { emit, info, success, warn, bold, dim, fail } from '../output.js';

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
  const yaml = renderYaml(provider, capability, actions);
  writeFileSync(outPath, yaml, 'utf-8');

  success(`Wrote ${outPath}`);
  info('');
  info(bold('Next steps:'));
  info(`  1. Edit ${outPath} and fill in input_schema / output_schema for each action.`);
  info(`     ${dim('See spec/04-manifest.md §5 for the JSON Schema 2020-12 subset.')}`);
  info('');
  info(`  2. Register your Provider (one-time, gets api_key + HMAC secret + DNS token):`);
  info(`     ${dim('$')} curl -X POST https://jecp.dev/v1/providers/register \\`);
  info(`         -H "Content-Type: application/json" \\`);
  info(`         -d '{"namespace":"${provider.namespace}","display_name":"${provider.display_name}","endpoint_url":"${provider.endpoint}","support_email":"${provider.support_email ?? ''}","website":"${provider.website ?? ''}"}'`);
  info('');
  info(`  3. Add the DNS TXT record returned by register:`);
  info(`     ${dim(`_jecp.<your-domain>  TXT  "<dns_verification_token>"`)}`);
  info('');
  info(`  4. Verify and connect Stripe:`);
  info(`     ${dim('$')} curl -X POST https://jecp.dev/v1/providers/verify-dns -H "Authorization: Bearer <provider_api_key>"`);
  info(`     ${dim('$')} curl -X POST https://jecp.dev/v1/providers/connect-stripe -H "Authorization: Bearer <provider_api_key>" -d '{"country":"JP"}'`);
  info('');
  info(`  5. Publish the manifest (raw YAML body, not multipart):`);
  info(`     ${dim('$')} curl -X POST https://jecp.dev/v1/manifests \\`);
  info(`         -H "Authorization: Bearer <provider_api_key>" \\`);
  info(`         -H "Content-Type: application/x-yaml" \\`);
  info(`         --data-binary @${outPath}`);
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

function renderYaml(p: Record<string, string>, c: Record<string, string>, actions: ActionDraft[]): string {
  const tags = (c.tags ?? '')
    .split(',')
    .map((t: string) => t.trim())
    .filter(Boolean);
  const tagsLine = tags.length > 0 ? `tags: [${tags.map((t) => `"${t}"`).join(', ')}]` : '# tags: []';

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

  return `# Generated by \`jecp init-provider\` (CLI v0.5.2+)
# JECP Provider manifest — see https://github.com/jecpdev/jecp-spec/blob/main/spec/04-manifest.md

namespace: ${p.namespace}
display_name: "${p.display_name}"
website: "${p.website ?? ''}"
support_email: "${p.support_email ?? ''}"

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
