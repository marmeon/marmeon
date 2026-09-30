/**
 * Node loader hook for app code: `node --import @bespokecore/core/register app.ts`.
 *
 * Reads constructor parameter types *before* Node strips them and inserts the
 * generated `static inject` list, so classes get constructor injection without
 * decorators or hand-written lists. Files in node_modules are left alone — packages
 * carry their lists from `bespoke package:build` or get them from `bespoke discover`.
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { injectConstructorDependencies } from './injection/analyze.ts';

const decoder = new TextDecoder();

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const typescript = result.format === 'module-typescript' || result.format === 'commonjs-typescript';
    if (!typescript || url.includes('/node_modules/') || result.source == null) return result;

    const source = typeof result.source === 'string' ? result.source : decoder.decode(result.source);
    return { ...result, source: injectConstructorDependencies(source, fileURLToPath(url)) };
  },
});
