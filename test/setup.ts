/**
 * Vitest setupFile — redirect HOME to a tmp dir so tests that touch
 * `~/.jecp/config.json` don't pollute the real user config.
 *
 * `os.homedir()` on macOS resolves via the underlying uid lookup and ignores
 * `process.env.HOME`. So we use vitest's module mocker to intercept
 * `node:os` `homedir` exports, which runs BEFORE any test file imports
 * `src/config.ts` (which captures `homedir()` at module-init time).
 */

import { vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as realOs from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(realOs.tmpdir(), 'jecp-cli-vitest-'));
process.env.HOME = tmpHome;
process.env.JECP_TEST_TMP_HOME = tmpHome;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});
