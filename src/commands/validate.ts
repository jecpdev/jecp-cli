/**
 * v0.8.2 — Client-side manifest validation.
 *
 * Reads a YAML (or JSON) manifest file, validates against the canonical
 * schema bundled with the CLI (mirror of
 * https://jecp.dev/schemas/v1/manifest.schema.json), and prints the same
 * shape as the Hub's INPUT_SCHEMA_VIOLATION response so operators see
 * consistent error messages whether they run validate locally or POST
 * the manifest to /v1/manifests.
 *
 * Exit codes:
 *   0  manifest valid
 *   1  manifest invalid (errors listed on stderr)
 *   2  file not found / read failed / not valid YAML
 *
 * --json emits { valid: bool, errors: [...] } for CI integration.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateManifest } from '../lib/manifest-validate.js';
import { emit, info, success, error, warn, bold, dim, fail } from '../output.js';

interface ValidateOpts {
  /** Path to manifest YAML / JSON (default: ./jecp.yaml). */
  file?: string;
}

export async function providerValidateCmd(file: string | undefined, opts: ValidateOpts): Promise<void> {
  void opts;
  const path = resolve(file ?? 'jecp.yaml');

  if (!existsSync(path)) {
    fail(`Manifest file not found: ${path}. Run \`jecp init-provider\` to scaffold one.`, 2);
    return;
  }

  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    fail(`Cannot read ${path}: ${(e as Error).message}`, 2);
    return;
  }

  if (text.trim().length === 0) {
    fail(`Manifest file is empty: ${path}`, 2);
    return;
  }
  if (text.length > 256 * 1024) {
    fail(`Manifest exceeds 256 KiB Hub limit: ${path}`, 2);
    return;
  }

  // Both YAML and JSON parse via the yaml package (a JSON file is a valid
  // YAML document). This matches the Hub's autodetect — fewer surprises
  // when a Provider authored manifest validates locally then publishes.
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    fail(`YAML parse failed: ${(e as Error).message}`, 2);
    return;
  }

  const result = validateManifest(parsed);

  emit(
    {
      valid: result.valid,
      file: path,
      errors: result.errors,
    },
    () => {
      if (result.valid) {
        success(`Manifest valid: ${path}`);
        info('');
        info(`${dim('Schema:')} https://jecp.dev/schemas/v1/manifest.schema.json`);
        info(`${dim('Ready to publish:')} jecp provider publish ${file ?? 'jecp.yaml'}`);
        return;
      }
      error(`Manifest INVALID (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}): ${path}`);
      info('');
      for (const e of result.errors) {
        // Match the Hub's INPUT_SCHEMA_VIOLATION shape: instance_path is what
        // operators actually need to fix; schema_path is for our reference.
        info(`  ${bold(e.instance_path || '(root)')}`);
        info(`    ${e.reason}`);
        info(`    ${dim('schema: ' + e.schema_path)}`);
      }
      info('');
      warn(
        `Fix the errors above and re-validate. The Hub would have rejected this manifest with the same shape (INPUT_SCHEMA_VIOLATION).`,
      );
    },
  );

  if (!result.valid) process.exit(1);
}
