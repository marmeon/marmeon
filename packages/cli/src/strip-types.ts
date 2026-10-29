import { stripTypeScriptTypes } from 'node:module';

/**
 * `stripTypeScriptTypes` is still experimental in Node 26 (stable: type stripping of files) and says so with a warning on
 * first use — in the middle of tinker's prompt, or in the message of an app that fails to load. That one warning is left out; every other warning goes through.
 */
export function strip(code: string): string {
  const emit = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
    const type = typeof warning === 'string' ? (typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type) : warning.name;
    if (type === 'ExperimentalWarning') return;
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    return stripTypeScriptTypes(code);
  } finally {
    process.emitWarning = emit;
  }
}
