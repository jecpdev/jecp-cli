/**
 * Output helpers — pretty by default, --json for machine-readable.
 */

import kleur from 'kleur';

let jsonMode = false;

export function setJsonMode(on: boolean): void {
  jsonMode = on;
}

export function info(msg: string): void {
  if (!jsonMode) console.log(msg);
}

export function success(msg: string): void {
  if (!jsonMode) console.log(kleur.green('✓'), msg);
}

export function warn(msg: string): void {
  if (!jsonMode) console.warn(kleur.yellow('⚠'), msg);
}

export function error(msg: string): void {
  if (!jsonMode) console.error(kleur.red('✗'), msg);
}

export function dim(msg: string): string {
  return jsonMode ? msg : kleur.dim(msg);
}

export function bold(msg: string): string {
  return jsonMode ? msg : kleur.bold(msg);
}

export function emit<T>(payload: T, prettyFn?: (p: T) => void): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    if (prettyFn) prettyFn(payload);
    else console.log(payload);
  }
}

export function fail(msg: string, code = 1): never {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  } else {
    error(msg);
  }
  process.exit(code);
}
