import { stripTypeScriptTypes } from 'node:module';

/** What the REPL evaluates for one input: JavaScript, an incomplete input (wait for more lines), or a TypeScript error. */
export type Input = { readonly code: string } | { readonly incomplete: Error } | { readonly error: SyntaxError };

/**
 * REPL input as JavaScript: the types stripped by Node's own TypeScript support (`module.stripTypeScriptTypes`, the same
 * erasable-syntax rule as every file of the app — no enums, no parameter properties). Stripping replaces types with
 * spaces, so the rest of the line is what the developer typed, and Node's evaluator keeps everything it does — top-level
 * `await`, the result of the last expression.
 *
 * - Input that ends too early (`function f(x: number) {`) is **incomplete**: the REPL waits for the next line.
 * - TypeScript that only a transform could run (`enum`) is an error that says so.
 * - An object literal (`{ a: 1, b: 2 }`), a block to the TypeScript parser, is stripped in parentheses — as the REPL
 *   reads it. Anything else the parser rejects goes through as it is: the REPL's own error is the one to show.
 */
export function toJavaScript(code: string): Input {
  try {
    return { code: strip(code) };
  } catch (error) {
    const { code: reason, message } = error as { code?: string; message: string };
    if (reason === 'ERR_INVALID_TYPESCRIPT_SYNTAX' && message.includes("got '<eof>'")) return { incomplete: error as Error };
    if (reason === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') return { error: new SyntaxError(message.split('\n')[0]) };
    // `{ a: 1 as const }` is an object literal to the REPL, a block to the parser.
    if (/^\s*\{/.test(code)) {
      try {
        return { code: strip(`(${code.trim()})`) };
      } catch {
        // Not an object literal either.
      }
    }
    return { code };
  }
}

/**
 * `stripTypeScriptTypes` is still experimental in Node 26 (stable: type stripping of files) and says so with a warning on
 * first use — in the middle of a prompt. That one warning is left out; every other warning goes through.
 */
function strip(code: string): string {
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
