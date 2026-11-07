/**
 * Node loader hook for app code (`node --import @marmeon/core/register app.ts`): reads constructor parameter types before
 * Node strips them and inserts the `static inject` list; node_modules is left alone. Where the app is protected, the
 * precomputed lists of `marmeon build` are used for every unchanged module (oxc-parser is never loaded); a changed one is
 * analysed and counted for the "stale" warning. See docs/container.md#where-the-lists-come-from.
 *
 * The one TSX it loads is a mail view, a `.tsx` below `modules/<module>/mail/`, compiled with the app's JSX setting by `oxc-transform`
 * (an optional peer); any other `.tsx` is refused.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { environment } from './environment.ts';
import { injectConstructorDependencies } from './injection/analyze.ts';
import { PrecomputedInjections, usePrecomputedInjections } from './injection/artifacts.ts';
import { isBrowserSource } from './injection/browser.ts';
import { compileMailView, jsxOptions, mailViewPath, tsxFileOf } from './mail-views.ts';

const decoder = new TextDecoder();
const decode = (source: Uint8Array) => decoder.decode(source);

const precomputed = environment.isProtected() ? PrecomputedInjections.load(process.cwd()) : undefined;
if (precomputed) usePrecomputedInjections(precomputed);

/** A mail view: refused unless it is one, then the injection lists, then the JSX. Before `nextLoad`, which cannot load `.tsx`. */
function loadMailView(file: string) {
  const root = process.cwd();
  const path = mailViewPath(root, file);
  const bytes = readFileSync(path);
  const text = decode(bytes);
  const injected = precomputed ? precomputed.transform(file, bytes, decode) : text.includes('constructor') ? injectConstructorDependencies(text, file) : text;
  return { format: 'module' as const, source: compileMailView(path, injected, jsxOptions(realpathSync.native(root))), shortCircuit: true };
}

registerHooks({
  load(url, context, nextLoad) {
    const view = tsxFileOf(url);
    if (view !== undefined) return loadMailView(view);
    const result = nextLoad(url, context);
    const typescript = result.format === 'module-typescript' || result.format === 'commonjs-typescript';
    if (!typescript || url.includes('/node_modules/') || result.source == null) return result;
    const file = fileURLToPath(url);
    if (isBrowserSource(file)) return result; // never built by the container

    if (precomputed) {
      const raw = result.source instanceof ArrayBuffer ? new Uint8Array(result.source) : (result.source as string | Uint8Array);
      return { ...result, source: precomputed.transform(file, raw, decode) };
    }
    const source = typeof result.source === 'string' ? result.source : decoder.decode(result.source);
    return { ...result, source: injectConstructorDependencies(source, file) };
  },
});
