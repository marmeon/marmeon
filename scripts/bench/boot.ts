/**
 * `pnpm bench boot` — how long `marmeon start` takes until `GET /up` answers 200 (E161: measured and documented, no gate).
 *
 *   pnpm bench boot --app apps/web-app                       # median of 7 starts + a breakdown from one profiled start
 *   pnpm bench boot --app <dir A> --app <dir B> [--runs 9]   # A/B: the apps start alternately (fair under changing load)
 *   pnpm bench boot --app apps/web-app --no-profile
 *
 * Each app needs a build (`marmeon build`): the starts run what production runs — `node_modules/marmeon/bin/marmeon.js
 * start` in the app, without `NODE_ENV` (so: production), without this process's `NODE_OPTIONS`, a fresh process each time.
 * One unmeasured start per app comes first (it warms the disk cache and Node's compile cache).
 *
 * The breakdown is the CPU profile of one more start (`--cpu-prof`, ended at the first request by `loads.ts`), each sample
 * attributed to: module loading (read, compile, the loader), type stripping, the injection lists (hash check or analysis),
 * discovery, the app's boot (`createApplication`), the server (renderer, listener), module evaluation and the rest. The
 * profiler slows the start: the shares count, the absolute numbers are only roughly those of an unprofiled start.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

interface Options {
  apps: string[];
  runs: number;
  profile: boolean;
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { app: { type: 'string', multiple: true }, runs: { type: 'string', default: '7' }, 'no-profile': { type: 'boolean' } },
  });
  const options: Options = { apps: (values.app ?? ['apps/web-app']).map((app) => resolve(app)), runs: Number(values.runs), profile: values['no-profile'] !== true };
  for (const app of options.apps) {
    const missing = ['node_modules/marmeon/bin/marmeon.js', 'dist/server/ssr.js'].filter((path) => !existsSync(join(app, path)));
    if (missing.length > 0) {
      process.stderr.write(`${app}: ${missing.join(', ')} missing — install and build it first (pnpm build && cd <app> && marmeon build).\n`);
      return 1;
    }
  }

  const port = await freePort();
  const times = new Map(options.apps.map((app) => [app, [] as number[]]));
  for (const app of options.apps) await start(app, port); // warm-up
  for (let run = 0; run < options.runs; run++) {
    for (const app of run % 2 === 0 ? options.apps : options.apps.toReversed()) times.get(app)!.push(await start(app, port));
  }

  for (const app of options.apps) {
    const measured = times.get(app)!;
    process.stdout.write(`\n${app}\n  marmeon start → /up 200: median ${Math.round(median(measured))} ms (${measured.map(Math.round).join(' · ')}, n = ${measured.length})\n`);
    if (options.profile) printBreakdown(await profile(app, port));
  }
  return 0;
}

/** The environment of a start: this shell's, without what would change it (pnpm's variables, NODE_OPTIONS, NODE_ENV). */
function environment(port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^(npm_|PNPM_|MARMEON_|VITEST|NODE_OPTIONS$|NODE_ENV$|INIT_CWD$)/.test(key)) env[key] = value;
  }
  // On the address /up is asked at (W9.2): on every interface the server could start beside a program holding the port on 127.0.0.1.
  return { ...env, HOST: '127.0.0.1', PORT: String(port), ...extra };
}

/** One `marmeon start` until `/up` answers 200, in milliseconds; then SIGTERM and wait for the exit. */
async function start(app: string, port: number): Promise<number> {
  const started = performance.now();
  const child = spawn(process.execPath, [join(app, 'node_modules/marmeon/bin/marmeon.js'), 'start'], { cwd: app, env: environment(port), stdio: 'ignore' });
  try {
    while (!(await up(port))) {
      if (child.exitCode !== null) throw new Error(`${app}: marmeon start exited with ${child.exitCode} before /up answered`);
      if (performance.now() - started > 30_000) throw new Error(`${app}: no /up 200 within 30 s`);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    return performance.now() - started;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  }
}

async function up(port: number): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/up`, { signal: AbortSignal.timeout(500) })).status === 200;
  } catch {
    return false;
  }
}

interface Profile {
  readonly loads: { total: number; typescript: number; packages: Record<string, number> };
  readonly categories: Map<string, number>;
  readonly total: number;
}

/** One start with `--cpu-prof`, ended by `loads.ts` at its first request. */
async function profile(app: string, port: number): Promise<Profile> {
  const dir = mkdtempSync(join(tmpdir(), 'marmeon-bench-boot-'));
  try {
    const loadsOut = join(dir, 'loads.json');
    const preload = new URL('./loads.ts', import.meta.url).href;
    const child = spawn(process.execPath, [join(app, 'node_modules/marmeon/bin/marmeon.js'), 'start'], {
      cwd: app,
      env: environment(port, { NODE_OPTIONS: `--cpu-prof --cpu-prof-interval=100 --cpu-prof-dir=${dir} --import=${preload}`, BENCH_LOADS_OUT: loadsOut }),
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    while (child.exitCode === null) {
      await up(port); // the first request ends the process
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    await exited;
    const file = readdirSync(dir).find((name) => name.endsWith('.cpuprofile'));
    if (!file) throw new Error(`${app}: the profiled start wrote no CPU profile`);
    return { loads: JSON.parse(readFileSync(loadsOut, 'utf8')), ...categorize(JSON.parse(readFileSync(join(dir, file), 'utf8'))) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}

const COMPILE = /^(compileSourceTextModule|wrapSafe|compileFunctionForCJSLoader|compileFunction)$/;
const READ = /^(readFileSync|readFileUtf8|getSource|getSourceSync|defaultLoad|defaultLoadSync)$/;

/** Sums the samples per category (see the file's comment). Idle time is left out. */
export function categorize(profile: CpuProfile): { categories: Map<string, number>; total: number } {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const categories = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const chain: CpuProfile['nodes'] = [];
    for (let id: number | undefined = profile.samples[i]; id !== undefined; id = parent.get(id)) chain.push(byId.get(id)!);
    const category = categoryOf(chain);
    if (category === undefined) continue;
    const ms = profile.timeDeltas[i]! / 1000;
    total += ms;
    categories.set(category, (categories.get(category) ?? 0) + ms);
  }
  return { categories, total };
}

/**
 * `chain`: the sampled frame first, then its callers. The first frame that says what the work is decides: builtins (`node:fs`,
 * `node:crypto` …) and native frames are skipped up to whoever called them; Node's module loader is read, compile, type
 * stripping or the rest of the loader; the framework's injection and discovery code are their own categories; any other code
 * of a file is module evaluation — or boot/server when `createApplication`/`startServer` is further up.
 */
function categoryOf(chain: CpuProfile['nodes']): string | undefined {
  const leaf = chain[0]!.callFrame.functionName;
  if (leaf === '(idle)') return undefined;
  if (leaf === '(garbage collector)') return 'garbage collection';
  if (leaf === '(program)') return 'native (program)';
  for (const [index, { callFrame }] of chain.entries()) {
    const { functionName, url } = callFrame;
    if (/stripTypeScript|processTypeScriptCode/.test(functionName) || url === 'node:internal/modules/typescript') return 'type stripping';
    if (url.startsWith('node:internal/modules/')) {
      if (COMPILE.test(functionName)) return 'modules: compile';
      if (READ.test(functionName)) return 'modules: read';
      return 'modules: loader';
    }
    if (!url.startsWith('file:')) continue;
    if (/\/core\/(dist|src)\/(injection\/|oxc\.|register\.)|oxc-parser/.test(url)) return 'injection lists';
    if (/\/core\/(dist|src)\/discovery\//.test(url)) return 'discovery';
    const callers = chain.slice(index).map((node) => node.callFrame.functionName);
    if (callers.includes('createApplication')) return 'boot (createApplication)';
    if (callers.includes('startServer')) return 'server (renderer, listener)';
    return 'module evaluation, other';
  }
  return 'module evaluation, other';
}

function printBreakdown({ loads, categories, total }: Profile): void {
  const top = Object.entries(loads.packages).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} ${count}`);
  const oxc = Object.keys(loads.packages).some((name) => name.includes('oxc-parser'));
  process.stdout.write(`  modules: ${loads.total} (TypeScript ${loads.typescript}; ${top.join(', ')}); oxc-parser ${oxc ? 'LOADED' : 'not loaded'}\n`);
  process.stdout.write(`  breakdown (CPU samples of one profiled start, ${Math.round(total)} ms):\n`);
  for (const [category, ms] of [...categories].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`    ${category.padEnd(30)} ${ms.toFixed(1).padStart(7)} ms  ${((100 * ms) / total).toFixed(1).padStart(5)} %\n`);
  }
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
