/**
 * Node loader hook for app code: `node --import @marmeon/core/register app.ts`.
 *
 * Reads constructor parameter types *before* Node strips them and inserts the
 * generated `static inject` list, so classes get constructor injection without
 * decorators or hand-written lists. Files in node_modules are left alone — packages
 * carry their lists from `marmeon package:build` or get them from `marmeon discover`.
 *
 * In a protected environment (production, staging, no `NODE_ENV` — E139) the lists come from `marmeon build`
 * (`.marmeon/injections.json`, E138): a module whose source is the one the build saw gets its precomputed insertions, and
 * oxc-parser is never loaded; any other module of the app is analysed as in development and counted for the one
 * "build artifacts are stale" warning. In development and tests every module is analysed (the file may be old there).
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
    if (isBrowserSource(file)) return result; // never built by the container (E76)

    if (precomputed) {
      const raw = result.source instanceof ArrayBuffer ? new Uint8Array(result.source) : (result.source as string | Uint8Array);
      return { ...result, source: precomputed.transform(file, raw, decode) };
    }
    const source = typeof result.source === 'string' ? result.source : decoder.decode(result.source);
    return { ...result, source: injectConstructorDependencies(source, file) };
  },
});
