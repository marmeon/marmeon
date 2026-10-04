/**
 * Preloaded into the profiled start of `pnpm bench boot` (`NODE_OPTIONS=--import …/loads.ts`): counts every module the
 * process loads (per package) and ends the process at its first HTTP request — the CPU profile then covers the start up to
 * `/up` and nothing after it. Writes `BENCH_LOADS_OUT` (JSON) on exit.
 */
import { subscribe } from 'node:diagnostics_channel';
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const loads = { total: 0, typescript: 0, packages: {} as Record<string, number> };

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    loads.total++;
    if (result.format === 'module-typescript' || result.format === 'commonjs-typescript') loads.typescript++;
    const name = packageOf(url);
    loads.packages[name] = (loads.packages[name] ?? 0) + 1;
    return result;
  },
});

/** `kysely`, `@bespokecore/http` (also a workspace package of the monorepo), `node:` for builtins, `app` for the rest. */
function packageOf(url: string): string {
  if (url.startsWith('node:')) return 'node:';
  const installed = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(url);
  if (installed) return installed[1]!;
  const workspace = /\/packages\/([^/]+)\/(?:dist|src)\//.exec(url);
  return workspace ? `@bespokecore/${workspace[1]}` : 'app';
}

process.on('exit', () => {
  if (process.env.BENCH_LOADS_OUT) writeFileSync(process.env.BENCH_LOADS_OUT, JSON.stringify(loads));
});

subscribe('http.server.request.start', () => {
  process.exit(0);
});
