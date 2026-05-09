/**
 * @jecpdev/cli — Command-line interface for JECP.
 *
 * Public exports for programmatic use (rare — most users invoke via `jecp` binary).
 */

export { loadConfig, saveConfig, resolveAuth, configFilePath } from './config.js';
export type { CliConfig } from './config.js';
