import prompts from 'prompts';
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
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
  /**
   * `true`         — write a tiny YAML stub (for CI / docs).
   * `"hello-world"` — write a runnable Provider starter:
   *   jecp.yaml + handler.mjs + package.json + README.md.
   *   Operator can `npm install && node handler.mjs` and have a live
   *   JECP-spec-compliant endpoint in under a minute, then run
   *   `jecp provider register --wait` to complete onboarding.
   *
   * Commander parses `--example` as `true` and `--example hello-world`
   * as `"hello-world"`, so a single flag covers both modes.
   */
  example?: boolean | string;
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
    if (opts.example === 'hello-world') {
      scaffoldHelloWorld(outPath);
      return;
    }
    if (opts.example === true) {
      // bare `--example` keeps the legacy single-file behavior to avoid
      // surprising existing CI scripts. `--example hello-world` opts
      // into the runnable starter above.
      writeFileSync(outPath, exampleYaml(), 'utf-8');
      success(`Wrote example manifest to ${outPath}`);
      return;
    }
    fail(`unknown --example template: '${opts.example}'. Try '--example' or '--example hello-world'.`);
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
// v0.8.0 — Hello-world starter (runnable Provider in ~60s)
// ──────────────────────────────────────────────────────────────────────

/**
 * Write four files alongside the operator's chosen outPath:
 *   <dir>/jecp.yaml       — minimal manifest declaring one action `echo`
 *   <dir>/handler.mjs     — Node 20+ http.createServer using @jecpdev/sdk's
 *                           JecpProvider.createHandler for HMAC verification
 *   <dir>/package.json    — single dep (@jecpdev/sdk), npm start script
 *   <dir>/README.md       — 5-step quickstart that ends with `jecp provider publish`
 *
 * Design notes:
 *
 * - `handler.mjs` uses the built-in `node:http` rather than Express / Hono so
 *   the starter has exactly one runtime dep — fewer install failures for
 *   evaluators on flaky networks. We adapt Node's IncomingMessage to the
 *   fetch-API `Request` that JecpProvider expects via a small bridge.
 *
 * - The endpoint URL in jecp.yaml is intentionally `https://YOUR_PUBLIC_URL/jecp`
 *   (placeholder) — the operator typically tunnels via ngrok/cloudflared
 *   before running register. We surface this expectation in the README.
 *
 * - We refuse to overwrite existing handler.mjs / package.json / README.md
 *   without --yes. That's the same posture as the jecp.yaml overwrite guard
 *   in the parent flow, but applied per-file because operators may have
 *   already started filling in handler.mjs and we don't want to clobber it.
 */
function scaffoldHelloWorld(yamlPath: string): void {
  const dir = dirname(yamlPath);
  const files = {
    yaml: yamlPath,
    handler: join(dir, 'handler.mjs'),
    pkg: join(dir, 'package.json'),
    readme: join(dir, 'README.md'),
  };

  const conflicts = [
    [files.handler, 'handler.mjs'],
    [files.pkg, 'package.json'],
    [files.readme, 'README.md'],
  ].filter(([p]) => existsSync(p));
  if (conflicts.length > 0) {
    fail(
      `would overwrite ${conflicts.map(([, n]) => n).join(', ')} in ${dir}. ` +
        `Rerun in an empty directory, or move these files first.`,
    );
    return; // defensive — fail() exits, but tests may mock process.exit
  }

  writeFileSync(files.yaml, helloWorldYaml(), 'utf-8');
  writeFileSync(files.handler, helloWorldHandler(), 'utf-8');
  writeFileSync(files.pkg, helloWorldPackageJson(), 'utf-8');
  writeFileSync(files.readme, helloWorldReadme(), 'utf-8');

  emit(
    {
      scaffolded: 'hello-world',
      files: Object.values(files),
      next_steps: [
        'npm install',
        'JECP_HMAC_SECRET=<from-register> node handler.mjs',
        'jecp provider register --endpoint <your-public-url>/jecp --wait',
        'jecp provider publish jecp.yaml',
      ],
    },
    () => {
      success(`Scaffolded hello-world Provider in ${dir}`);
      info('');
      info(bold('Quick start:'));
      info(`  ${dim('$')} cd ${dir}`);
      info(`  ${dim('$')} npm install`);
      info(`  ${dim('$')} JECP_HMAC_SECRET=<from-register> node handler.mjs`);
      info('');
      info(`Then in another terminal:`);
      info(`  ${dim('$')} jecp provider register --endpoint <your-public-url>/jecp --wait`);
      info(`  ${dim('$')} jecp provider publish jecp.yaml`);
      info('');
      info(`See ${join(dir, 'README.md')} for the full walkthrough.`);
    },
  );
}

function helloWorldYaml(): string {
  return `# Hello-world JECP Provider manifest (generated by \`jecp init-provider --example hello-world\`)
# Replace YOUR_PUBLIC_URL with your tunnel (ngrok / cloudflared) or deployed host.

namespace: hello-world
display_name: "Hello World"
website: "https://example.com"
support_email: "ops@example.com"

capability: echo
version: 1.0.0
description: "Echoes back the input text. Smallest valid Provider for JECP onboarding."
tags: ["example", "hello-world"]

endpoint: "https://YOUR_PUBLIC_URL/jecp"
streaming: false

authentication:
  type: api_key
  header_name: x-jecp-signature

actions:
  - id: echo
    name: "Echo"
    description: "Returns the input text unchanged."
    streaming: false
    pricing:
      base: "$0.001"
      currency: USDC
      model: per_call
    trust_tier_required: bronze
    input_schema:
      type: object
      required: ["text"]
      properties:
        text: { type: string, maxLength: 5000 }
    output_schema:
      type: object
      properties:
        text: { type: string }
    examples:
      - input: { text: "Hello" }
        output: { text: "Hello" }
    side_effects:
      external_api_call: false
      stores_data: false
      modifies_state: false
      sends_email: false
    sla:
      latency_p95_ms: 100
      timeout_ms: 5000

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

function helloWorldHandler(): string {
  return `// JECP hello-world Provider — Node 20+ stdlib HTTP server.
// Generated by \`jecp init-provider --example hello-world\`.
//
// JECP_HMAC_SECRET is the base64 secret returned by /v1/providers/register;
// the CLI saved it to ~/.jecp/config.json under \`provider_hmac_secret\`.
// You can also pass it on the command line:
//   JECP_HMAC_SECRET=<secret> node handler.mjs
//
// The endpoint URL configured in jecp.yaml must point at this server.
// Typical local-dev setup:
//   $ node handler.mjs           # listens on 0.0.0.0:3000
//   $ ngrok http 3000            # public HTTPS URL → endpoint: in jecp.yaml

import { createServer } from 'node:http';
import { JecpProvider } from '@jecpdev/sdk';

const HMAC_SECRET = process.env.JECP_HMAC_SECRET;
if (!HMAC_SECRET) {
  console.error('JECP_HMAC_SECRET env var required. Run \`jecp provider register\` first.');
  process.exit(1);
}

const provider = new JecpProvider({ hmacSecret: HMAC_SECRET });

// Your business logic — for hello-world we just echo input.text back.
// Replace this with whatever your capability actually does.
const echoHandler = provider.createHandler(async (req) => {
  if (req.action !== 'echo') {
    throw new Error('unsupported action: ' + req.action);
  }
  const input = req.input;
  if (!input || typeof input.text !== 'string') {
    throw new Error('input.text (string) required');
  }
  return { text: input.text };
});

// Bridge node:http IncomingMessage → fetch-API Request so JecpProvider's
// createHandler can verify the HMAC and parse the JECP envelope.
async function toFetchRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) headers.set(k, v.join(', '));
    else if (v != null) headers.set(k, String(v));
  }
  return new Request(\`http://localhost\${req.url}\`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/jecp') {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const fetchReq = await toFetchRequest(req);
    const fetchRes = await echoHandler(fetchReq);
    res.writeHead(fetchRes.status, Object.fromEntries(fetchRes.headers));
    res.end(await fetchRes.text());
  } catch (e) {
    console.error('handler error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jecp: '1.0', status: 'failed', error: { code: 'INTERNAL', message: String(e) } }));
  }
});

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
server.listen(PORT, () => {
  console.log(\`Hello-world JECP Provider listening on http://localhost:\${PORT}/jecp\`);
  console.log(\`Health check:  http://localhost:\${PORT}/healthz\`);
});
`;
}

function helloWorldPackageJson(): string {
  return `{
  "name": "jecp-hello-world",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node handler.mjs"
  },
  "dependencies": {
    "@jecpdev/sdk": "^0.8.3"
  }
}
`;
}

function helloWorldReadme(): string {
  return `# JECP hello-world Provider

A runnable Provider that echoes input text back. The smallest valid
implementation of the JECP spec — useful for verifying registration,
DNS, Stripe Connect, and manifest publish work end-to-end before
porting your real API.

## Prerequisites

- Node 20+
- A public HTTPS URL (e.g. \`ngrok http 3000\` or a deployed host)
- \`@jecpdev/cli\` installed: \`npm i -g @jecpdev/cli\`

## 5-minute onboarding

\`\`\`bash
# 1. Install dep
npm install

# 2. Get a public HTTPS URL (in another terminal)
ngrok http 3000
# → copy the https://....ngrok.io URL

# 3. Register as a Provider — auto-polls DNS until propagated
jecp provider register \\
  --namespace my-hello-world \\
  --display-name "Hello World" \\
  --email you@example.com \\
  --endpoint https://YOUR_NGROK_URL/jecp \\
  --country JP \\
  --wait

# The CLI prints the DNS TXT record to add. After adding it the
# auto-poll completes (typically 30 s – 2 min). The provider_hmac_secret
# is saved to ~/.jecp/config.json automatically.

# 4. Start the Provider with the HMAC secret from step 3
JECP_HMAC_SECRET="$(jq -r .provider_hmac_secret ~/.jecp/config.json)" node handler.mjs &

# 5. Connect Stripe (opens onboarding URL in your browser)
jecp provider connect-stripe

# 6. Edit jecp.yaml — replace YOUR_PUBLIC_URL with your ngrok host, then:
jecp provider publish jecp.yaml
\`\`\`

Once DNS and Stripe are both verified, the capability auto-promotes to
\`active\` and is discoverable via \`jecp catalog --namespace my-hello-world\`.

## What's in this directory

| File | Role |
|---|---|
| \`jecp.yaml\` | Manifest. Declares one action (\`echo\`) at \`$0.001\`/call. |
| \`handler.mjs\` | HTTP server. Verifies HMAC, parses JECP envelope, returns echo. |
| \`package.json\` | Single dep on \`@jecpdev/sdk\`. \`npm start\` runs the handler. |
| \`README.md\` | This file. |

## Replacing the example with your real capability

1. Edit \`jecp.yaml\`:
   - \`namespace:\`, \`capability:\`, \`description:\`, \`pricing.base:\`
   - \`input_schema\` / \`output_schema\` (JSON Schema 2020-12 subset)
2. Edit \`handler.mjs\`:
   - Replace the body of \`provider.createHandler(async (req) => { ... })\`
     with your business logic. \`req.input\` is the validated payload.
3. Bump \`version:\` in \`jecp.yaml\` and re-run \`jecp provider publish\`.

## Spec links

- Manifest format: https://github.com/jecpdev/jecp-spec/blob/main/spec/04-manifest.md
- HMAC signing: https://github.com/jecpdev/jecp-spec/blob/main/spec/03-auth.md
- Error catalog: https://github.com/jecpdev/jecp-spec/blob/main/spec/05-errors.md
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
