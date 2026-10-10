/**
 * Node loader hook for app code (`node --import @marmeon/core/register app.ts`): reads constructor parameter types before
 * Node strips them and inserts the `static inject` list; node_modules is left alone. Where the app is protected, the
 * precomputed lists of `marmeon build` are used for every unchanged module (oxc-parser is never loaded); a changed one is
 * analysed and counted for the "stale" warning. See docs/container.md#where-the-lists-come-from.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { environment } from './environment.ts';
import { injectConstructorDependencies } from './injection/analyze.ts';
import { PrecomputedInjections, usePrecomputedInjections } from './injection/artifacts.ts';
import { isBrowserSource } from './injection/browser.ts';

const decoder = new TextDecoder();
const decode = (source: Uint8Array) => decoder.decode(source);

const precomputed = environment.isProtected() ? PrecomputedInjections.load(process.cwd()) : undefined;
if (precomputed) usePrecomputedInjections(precomputed);

registerHooks({
  load(url, context, nextLoad) {
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
