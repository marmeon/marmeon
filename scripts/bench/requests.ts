/**
 * `pnpm bench login|people` — the request path, in-process against the web app (E136, E154, E166; no gate, never part of `pnpm run ci`).
 *
 *   pnpm bench login                                   # this checkout: /login with a guest session and without a cookie
 *   pnpm bench login --base f785159 --runs 6           # A/B: alternating, each run a fresh process; median, 95 % CI, Welch test
 *   pnpm bench login --base f785159 --without w8       # adds this checkout with Wave 8's measures off (shims.ts; counted, proven 0)
 *   pnpm bench login --without epoch --without csp     # one variant per --without: the cost of a single measure
 *   pnpm bench people                                  # GET /people signed in
 *   pnpm bench login --profile [--base f785159]        # CPU profile of the measured requests: top lists (self, inclusive) and the diff
 *
 * Every side runs from a `git worktree` under `$TMPDIR/marmeon-bench/` — the base at its commit, this checkout as a snapshot (HEAD
 * plus the working tree's changes and untracked files; `--in-place` measures the checkout itself). Same place, same conditions: the
 * repository's own `apps/web-app/.env` (read under `.env.test`) and its location changed results by several per cent (W8 step 7).
 * Worktrees are kept for the next run (`git worktree remove` cleans up); before a run each one is smoke-tested — it imports what a
 * measured process imports, and a missing module (macOS cleans `$TMPDIR` file by file) removes its `node_modules` and installs
 * again (`integrity.ts`). A run: `--rounds` × `--requests` per scenario after a
 * warm-up of 500; the run's number is the median of its rounds, in µs per request. Noise on a laptop is ±3–5 % between runs —
 * compare sides measured in the same `pnpm bench` call only.
 *
 * Options: `--scenario <name>` (repeatable: login, login-guest, login-document, people), `--encrypt` (`SESSION_ENCRYPT=true`; off
 * by default — E154 is measured without; `--encrypt-too`: every variant twice, plain and encrypted), `--rounds 3`, `--requests 10000`, `--runs 6`, `--checkout <label>=<dir>` (repeatable: a
 * checkout prepared by hand, installed — e.g. this one with a change taken back, to attribute a saving).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ensureImportable, importProblem, type ImportProbe } from './integrity.ts';
import { SCENARIOS, WORKER_MODULES, type ScenarioName } from './request-worker.ts';
import { MEASURES, parseMeasures, type Measure } from './shims.ts';
import { welch } from './stats.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

interface Variant {
  readonly label: string;
  readonly checkout: string;
  readonly without: readonly Measure[];
  readonly base: boolean;
  /** `SESSION_ENCRYPT=true` for this variant (`--encrypt` or its `--encrypt-too` twin). */
  readonly encrypt: boolean;
  /** The variant this one is a change of (`−<measures>`, `+encrypt`): compared with it. */
  readonly of?: Variant;
}

interface RunResult {
  scenarios: Record<string, number[]>;
  requests: number;
  counters?: Record<Measure, number>;
}

const DEFAULT_SCENARIOS: Record<string, ScenarioName[]> = { login: ['login', 'login-guest'], people: ['people'] };

export async function main(name: string, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string', multiple: true },
      checkout: { type: 'string', multiple: true },
      without: { type: 'string', multiple: true },
      scenario: { type: 'string', multiple: true },
      runs: { type: 'string', default: '6' },
      rounds: { type: 'string', default: '3' },
      requests: { type: 'string', default: '10000' },
      encrypt: { type: 'boolean' },
      'encrypt-too': { type: 'boolean' },
      profile: { type: 'boolean' },
      'in-place': { type: 'boolean' },
    },
  });
  const scenarios = (values.scenario ?? DEFAULT_SCENARIOS[name]!) as ScenarioName[];
  for (const scenario of scenarios) if (!(scenario in SCENARIOS)) throw new Error(`Unknown scenario "${scenario}" — one of ${Object.keys(SCENARIOS).join(', ')}.`);

  const encrypt = values.encrypt === true;
  const sides: Variant[] = [{ label: 'this checkout', checkout: values['in-place'] ? root : snapshot(), without: [], base: false, encrypt }];
  for (const given of values.checkout ?? []) {
    // A checkout prepared by hand (installed): `label=dir` — measured like this one, its `--without` variants too.
    const [label, dir] = given.includes('=') ? [given.slice(0, given.indexOf('=')), given.slice(given.indexOf('=') + 1)] : [given, given];
    const checkout = realpathSync(resolve(dir!));
    // Prepared by hand: checked, never repaired — its node_modules are not ours to remove.
    const problem = importProblem(probeOf(checkout));
    if (problem !== undefined) throw new Error(`--checkout ${given}: it cannot import what a measured process imports — install it first:\n${problem}`);
    sides.push({ label: label!, checkout, without: [], base: false, encrypt });
  }
  const variants: Variant[] = [];
  for (const side of sides) {
    variants.push(side);
    for (const set of values.without ?? []) variants.push({ ...side, label: `${side.label} −${set}`, without: parseMeasures([set]), of: side });
  }
  for (const ref of values.base ?? []) variants.push({ label: `base ${ref}`, checkout: baseWorktree(ref), without: [], base: true, encrypt });
  if (values['encrypt-too'] && !encrypt) for (const variant of variants.slice()) variants.push({ ...variant, label: `${variant.label} +encrypt`, encrypt: true, of: variant });

  const env = { BENCH_SCENARIOS: scenarios.join(',') };
  if (variants.some((variant) => variant.without.length > 0)) await check(variants, env);

  if (values.profile) return profile(variants, scenarios, env);

  const runs = Number(values.runs);
  const results = new Map<Variant, Record<string, number[]>>(variants.map((variant) => [variant, {}]));
  log(`${runs} runs × ${variants.length} variants, each ${values.rounds} × ${values.requests} requests per scenario (${scenarios.join(', ')})`);
  for (let run = 0; run < runs; run++) {
    for (const variant of run % 2 === 0 ? variants : variants.toReversed()) {
      const result = await worker(variant, { ...env, BENCH_ROUNDS: values.rounds!, BENCH_REQUESTS: values.requests! });
      const line: string[] = [];
      for (const [scenario, rounds] of Object.entries(result.scenarios)) {
        const value = median(rounds);
        (results.get(variant)![scenario] ??= []).push(value);
        line.push(`${scenario} ${value.toFixed(1)}`);
      }
      log(`  run ${run + 1} ${variant.label}: ${line.join(' · ')} µs`);
    }
  }
  report(variants, results, scenarios);
  return 0;
}

// --- Checkouts ------------------------------------------------------------------------------------------------------------

function git(args: string[], cwd = root): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`);
  return result.stdout;
}

function benchDir(): string {
  const dir = join(tmpdir(), 'marmeon-bench');
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir); // the profiles' file URLs are real paths (macOS: /var → /private/var)
}

function install(checkout: string): void {
  log(`  pnpm install in ${checkout}`);
  const result = spawnSync('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { cwd: checkout, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pnpm install in ${checkout} failed:\n${result.stdout}${result.stderr}`);
}

/** The worktree of `ref` (kept between runs). */
function baseWorktree(ref: string): string {
  const sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const dir = join(benchDir(), `base-${sha.slice(0, 12)}`);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'add', '--detach', dir, sha]);
    install(dir);
  }
  ensureImportable(dir, probeOf(dir), { install, log });
  return dir;
}

/** This checkout as a worktree of its own: HEAD, then the diff of the working tree and the untracked files on top. */
function snapshot(): string {
  const dir = join(benchDir(), `current-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`);
  const head = git(['rev-parse', 'HEAD']).trim();
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'add', '--detach', dir, head]);
  } else {
    git(['checkout', '--detach', '--force', head], dir);
    git(['clean', '-fdq', '-e', 'node_modules'], dir);
  }
  const diff = spawnSync('git', ['diff', 'HEAD', '--binary'], { cwd: root, encoding: 'buffer', maxBuffer: 1 << 28 }).stdout;
  if (diff.length > 0) {
    const apply = spawnSync('git', ['apply', '--whitespace=nowarn'], { cwd: dir, input: diff });
    if (apply.status !== 0) throw new Error(`git apply in ${dir}: ${apply.stderr.toString()}`);
  }
  for (const file of git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  const fingerprint = createHash('sha256').update(readFileSync(join(dir, 'pnpm-lock.yaml'))).digest('hex');
  const marker = join(dir, 'node_modules', '.bench-lock');
  const installed = (checkout: string) => {
    install(checkout);
    writeFileSync(marker, fingerprint);
  };
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== fingerprint) installed(dir);
  // The marker only knows the lockfile: files under node_modules can be gone all the same.
  ensureImportable(dir, probeOf(dir), { install: installed, log });
  return dir;
}

/** The import smoke test of a checkout: what `request-worker.ts` imports first, the way `worker()` starts it. */
function probeOf(checkout: string): ImportProbe {
  return {
    cwd: join(checkout, 'apps/web-app'),
    args: ['--conditions=@marmeon/source', `--import=${pathToFileURL(join(checkout, 'packages/core/src/register.ts')).href}`],
    env: { ...workerEnvironment(), NODE_ENV: 'test' },
    specifiers: WORKER_MODULES.map((path) => pathToFileURL(join(checkout, path)).href),
  };
}

/** The environment of a measured process: none of pnpm's, Vitest's or this process's own variables. */
function workerEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(npm_|PNPM_|MARMEON_|VITEST|NODE_OPTIONS$|NODE_ENV$|INIT_CWD$)/.test(key)) clean[key] = value;
  return clean;
}

// --- Processes ------------------------------------------------------------------------------------------------------------

/** One measured process for `variant`; its last line of output is the result. */
function worker(variant: Variant, env: Record<string, string>, { shims = variant.without.length > 0 } = {}): Promise<RunResult> {
  const clean = workerEnvironment();
  const args = ['--expose-gc', '--conditions=@marmeon/source'];
  if (shims) args.push(`--import=${join(here, 'shims.ts')}`);
  args.push(`--import=${join(variant.checkout, 'packages/core/src/register.ts')}`, join(here, 'request-worker.ts'), variant.checkout);
  const child = spawn(process.execPath, args, {
    cwd: join(variant.checkout, 'apps/web-app'),
    env: {
      ...clean,
      ...env,
      NODE_ENV: 'test',
      BENCH_WORKER: '1',
      BENCH_CHECKOUT: variant.checkout,
      BENCH_WITHOUT: variant.without.join(','),
      BENCH_ENCRYPT: String(variant.encrypt),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on('exit', (code) => {
      const last = stdout.trim().split('\n').at(-1);
      if (code !== 0 || !last?.startsWith('{')) reject(new Error(`${variant.label} (${variant.checkout}) exited with ${code}:\n${stderr.slice(-4000)}`));
      else resolve(JSON.parse(last));
    });
  });
}

/**
 * `--without` must really switch its measures off: one short process per variant with the counting shims and one CSRF-protected
 * POST (BENCH_CHECK) — this checkout as it is runs every measure at least once (else an anchor no longer reaches its code), a variant
 * without a measure runs it never.
 */
async function check(variants: readonly Variant[], env: Record<string, string>): Promise<void> {
    const on = await worker(variants[0]!, { ...env, BENCH_SCENARIOS: 'login', BENCH_ROUNDS: '1', BENCH_REQUESTS: '20', BENCH_CHECK: '1' }, { shims: true });
    const missing = MEASURES.filter((measure) => !(on.counters![measure] > 0));
    if (missing.length > 0) throw new Error(`pnpm bench: ${missing.join(', ')} never ran in this checkout — the shims no longer reach the measure (scripts/bench/shims.ts).`);
    log(`check: this checkout runs every measure (${MEASURES.map((measure) => `${measure} ${on.counters![measure]}`).join(', ')})`);
    for (const variant of variants.filter((variant) => variant.without.length > 0)) {
      const off = await worker(variant, { ...env, BENCH_SCENARIOS: 'login', BENCH_ROUNDS: '1', BENCH_REQUESTS: '20', BENCH_CHECK: '1' });
      const running = variant.without.filter((measure) => off.counters![measure] !== 0);
      if (running.length > 0) throw new Error(`pnpm bench: ${variant.label} still runs ${running.map((measure) => `${measure} (${off.counters![measure]}×)`).join(', ')} — the switch does not take.`);
      log(`check: ${variant.label} runs none of ${variant.without.join(', ')} (${variant.without.map((measure) => `${measure} 0`).join(', ')})`);
    }
}

// --- Report ---------------------------------------------------------------------------------------------------------------

function report(variants: readonly Variant[], results: Map<Variant, Record<string, number[]>>, scenarios: readonly ScenarioName[]): void {
  for (const scenario of scenarios) {
    out(`\n${scenario} — ${SCENARIOS[scenario]} (µs per request; median of the runs, each the median of its rounds)`);
    for (const variant of variants) {
      const values = results.get(variant)![scenario]!;
      out(`  ${variant.label.padEnd(34)} ${median(values).toFixed(1).padStart(7)}   ${values.map((value) => value.toFixed(1)).join(' · ')}`);
    }
    for (const [side, reference] of comparisons(variants)) {
      const a = results.get(side)![scenario]!;
      const b = results.get(reference)![scenario]!;
      const test = welch(a, b);
      const ratios = a.map((value, i) => value / b[i]! - 1);
      out(
        `  ${side.label} vs ${reference.label}: ${pct(median(a) / median(b) - 1)} median, ${pct(test.relative)} mean ` +
          `(95 % CI ${pct(test.ciLow)} … ${pct(test.ciHigh)}, Welch p = ${test.p.toFixed(3)}; runs ${pct(Math.min(...ratios))} … ${pct(Math.max(...ratios))}) ` +
          `= ${signed(median(a) - median(b))} µs`,
      );
    }
  }
}

/** What is compared: each side of this checkout with each base, and each variant of this checkout with the checkout as it is. */
function comparisons(variants: readonly Variant[]): [Variant, Variant][] {
  const pairs: [Variant, Variant][] = [];
  const bases = variants.filter((variant) => variant.base);
  // Each side of this checkout (and its `--without` variants) with each base of the same encryption.
  for (const side of variants.filter((variant) => !variant.base)) {
    for (const base of bases) if (base.encrypt === side.encrypt) pairs.push([side, base]);
  }
  // Each change with what it changes: `−<measures>` with the checkout as it is, `+encrypt` with the plain variant.
  for (const variant of variants) if (variant.of) pairs.push([variant, variant.of]);
  // Prepared checkouts with this one.
  for (const side of variants.filter((variant) => !variant.base && !variant.of && variant !== variants[0])) pairs.push([side, variants[0]!]);
  return pairs;
}

// --- Profile --------------------------------------------------------------------------------------------------------------

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; children?: number[] }[];
  samples: number[];
  timeDeltas: number[];
}

async function profile(variants: readonly Variant[], scenarios: readonly ScenarioName[], env: Record<string, string>): Promise<number> {
  const dir = mkdtempSync(join(benchDir(), 'profile-'));
  const tables = new Map<Variant, Map<string, { self: number; total: number }>>();
  for (const variant of variants) {
    const file = join(dir, `${variant.label.replace(/[^\w.-]+/g, '-')}.cpuprofile`);
    const result = await worker(variant, { ...env, BENCH_SCENARIOS: scenarios.join(','), BENCH_ROUNDS: '1', BENCH_REQUESTS: '20000', BENCH_PROFILE: file });
    const requests = result.requests * scenarios.length;
    const table = aggregate(JSON.parse(readFileSync(file, 'utf8')), variant.checkout, requests);
    tables.set(variant, table);
    const sum = [...table.values()].reduce((total, entry) => total + entry.self, 0);
    out(`\n${variant.label} — ${sum.toFixed(1)} µs of CPU per request (${scenarios.join(', ')}; profile: ${file})`);
    out('  self                                                                              µs/req     %');
    for (const [key, entry] of [...table].sort((x, y) => y[1].self - x[1].self).slice(0, 25)) out(`  ${key.slice(0, 80).padEnd(80)} ${entry.self.toFixed(2).padStart(7)} ${((100 * entry.self) / sum).toFixed(1).padStart(5)}`);
    out('  inclusive');
    for (const [key, entry] of [...table].filter(([key]) => !key.startsWith('(')).sort((x, y) => y[1].total - x[1].total).slice(0, 25)) out(`  ${key.slice(0, 80).padEnd(80)} ${entry.total.toFixed(2).padStart(7)} ${((100 * entry.total) / sum).toFixed(1).padStart(5)}`);
  }
  for (const [side, reference] of comparisons(variants)) {
    const a = tables.get(side)!;
    const b = tables.get(reference)!;
    const keys = new Set([...a.keys(), ...b.keys()]);
    const diff = [...keys].map((key) => ({ key, self: (a.get(key)?.self ?? 0) - (b.get(key)?.self ?? 0), total: (a.get(key)?.total ?? 0) - (b.get(key)?.total ?? 0) }));
    out(`\n${side.label} − ${reference.label} (µs per request; self, then inclusive — functions by name and file, lines ignored)`);
    for (const entry of diff.sort((x, y) => Math.abs(y.self) - Math.abs(x.self)).slice(0, 30)) out(`  ${entry.key.slice(0, 80).padEnd(80)} ${signed(entry.self).padStart(7)} ${signed(entry.total).padStart(8)}`);
  }
  return 0;
}

/** Self and inclusive time per function (`name file`) in µs per request; idle left out. */
function aggregate(profile: CpuProfile, checkout: string, requests: number): Map<string, { self: number; total: number }> {
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const keyOf = new Map(profile.nodes.map((node) => [node.id, functionKey(node.callFrame, checkout)]));
  const table = new Map<string, { self: number; total: number }>();
  const entry = (key: string) => {
    let found = table.get(key);
    if (!found) table.set(key, (found = { self: 0, total: 0 }));
    return found;
  };
  for (let i = 0; i < profile.samples.length; i++) {
    const leaf = profile.samples[i]!;
    const leafKey = keyOf.get(leaf)!;
    if (leafKey === '(idle)' || leafKey === '(root)') continue;
    const us = profile.timeDeltas[i]! / requests;
    entry(leafKey).self += us;
    const seen = new Set<string>();
    for (let id: number | undefined = leaf; id !== undefined; id = parent.get(id)) {
      const key = keyOf.get(id)!;
      if (!seen.has(key)) {
        seen.add(key);
        entry(key).total += us;
      }
    }
  }
  return table;
}

function functionKey({ functionName, url }: { functionName: string; url: string }, checkout: string): string {
  const name = functionName || '(anonymous)';
  if (!url) return name;
  let file = url.startsWith('file://') ? fileURLToPath(url) : url;
  const installed = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(.*)$/.exec(file);
  if (installed) file = installed[1]!;
  else if (file.startsWith(checkout)) file = relative(checkout, file);
  return `${name} ${file}`;
}

// --- Helpers --------------------------------------------------------------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const pct = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(100 * value).toFixed(1)} %`;
const signed = (value: number) => `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
const out = (line: string) => process.stdout.write(`${line}\n`);
const log = (line: string) => process.stderr.write(`${line}\n`);
