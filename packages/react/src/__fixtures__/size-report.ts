/**
 * `pnpm size` — what the client core, the React adapter and the apps cost a browser: a Markdown table of every scenario of
 * `bundle-size.test.ts` and the real apps' client builds, in KB gzip of the initial download. It reports and never judges: it
 * fails when a build or a measurement breaks, not because of a size. In CI (`GITHUB_STEP_SUMMARY`) it also writes the table into
 * the job summary.
 *
 * With a base — `--base <ref>` or `MARMEON_SIZE_BASE` (CI sets it to a pull request's base commit) — the table has the base's size
 * beside it and the delta: the base is checked out into a temporary worktree, installed from the lockfile, built, and measured
 * with this script. A base that cannot be built is reported, and the table shows the sizes alone.
 * Measures `dist/` — run `pnpm build` first.
 *
 *   pnpm size                  # the table, sizes alone
 *   pnpm size --base main      # against a commit (builds it: an install and a build)
 *   pnpm size web-app          # one app (or scenario), every byte attributed to its module by source map, with the
 *                              # marginal cost of core + adapter (gzip with and without their bytes)
 *   pnpm size --json           # the sizes as JSON, nothing else (how the base is measured)
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBundle, appClientBuild, bundleDirectory, kb, PACKAGES, SCENARIOS, type AppBundle, type ModuleShare, type Scenario } from './bundle.ts';
import { renderSizeTable, type Sizes } from './size-table.ts';

const APPS = ['blank-app', 'web-app', 'website'];
const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const json = args.includes('--json');
const baseRef = flag('--base') || process.env.MARMEON_SIZE_BASE || undefined;
const fromCi = !flag('--base');
const only = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--base');
const wanted = (name: string) => only.includes(name);

/** What a module belongs to, for the detail view. */
function groupOf(module: string): string {
  if (/^http\/(dist|src)\/(client\/|page\.|page-support\.|protocol\.)/.test(module) || /^router\/(dist|src)\/url\./.test(module)) return 'client core';
  if (module.startsWith('react/')) return 'React adapter';
  // The table's browser half: framework code an app has with `useTable`.
  if (/^table\/(dist|src)\/client\//.test(module)) return 'table (client)';
  if (module.startsWith('i18n/')) return 'i18n';
  if (/^node_modules\/(react-dom|scheduler)\//.test(module)) return 'react-dom';
  if (module.startsWith('node_modules/react/')) return 'react';
  if (module.startsWith('node_modules/')) return 'other packages';
  if (module.startsWith('(')) return module;
  return 'app';
}

const FRAMEWORK = new Set(['client core', 'React adapter', 'table (client)']);
const format = (share: ModuleShare) => `${(share.min / 1024).toFixed(1).padStart(6)} min ${(share.gzip / 1024).toFixed(2).padStart(6)} gzip`;

function groups(attribution: ReadonlyMap<string, ModuleShare>): Map<string, ModuleShare> {
  const total = new Map<string, ModuleShare>();
  for (const [module, share] of attribution) {
    const group = groupOf(module);
    const sum = total.get(group) ?? { min: 0, gzip: 0 };
    total.set(group, { min: sum.min + share.min, gzip: sum.gzip + share.gzip });
  }
  return total;
}

/** One bundle's modules by group. The marginal cost is what the download loses without core + adapter; unlike their scaled shares, it does not grow with the number of modules. */
function print(title: string, bundle: AppBundle): void {
  const { initial, lazy } = bundle.attribution!;
  console.log(`\n${title} — initial ${(bundle.min / 1024).toFixed(1)} KB min / ${(bundle.gzip / 1024).toFixed(2)} KB gzip in ${bundle.initial.length} chunk(s)` +
    (bundle.lazy.length ? `, ${bundle.lazy.length} lazy chunk(s) ${(bundle.lazy.reduce((sum, chunk) => sum + chunk.gzip, 0) / 1024).toFixed(2)} KB gzip` : ''));
  const initialGroups = groups(initial);
  const lazyGroups = groups(lazy);
  for (const [group, share] of [...initialGroups].sort((a, b) => b[1].gzip - a[1].gzip)) {
    const later = lazyGroups.get(group);
    console.log(`  ${group.padEnd(16)} ${format(share)}${later ? `   (+ lazy ${format(later)})` : ''}`);
  }
  const framework = [...initial].filter(([module]) => FRAMEWORK.has(groupOf(module))).sort((a, b) => b[1].gzip - a[1].gzip);
  const sum = framework.reduce((total, [, share]) => ({ min: total.min + share.min, gzip: total.gzip + share.gzip }), { min: 0, gzip: 0 });
  console.log(`  ${'core + adapter'.padEnd(16)} ${format(sum)}`);
  const marginal = bundle.attribution!.marginalGzip((module) => FRAMEWORK.has(groupOf(module)));
  console.log(`  ${'  marginal'.padEnd(16)} ${(marginal / 1024).toFixed(2).padStart(17)} gzip  (what the download loses without core + adapter)`);
  for (const [module, share] of framework) console.log(`    ${module.padEnd(44)} ${format(share)}`);
}

/** What an app's download loses without the client core and the React adapter, in bytes: React and the app's own code do not move it. */
const marginalBundle = (bundle: AppBundle): number => bundle.attribution!.marginalGzip((module) => FRAMEWORK.has(groupOf(module)));

type Job = [name: string, bytes: () => Promise<number>];

/** The initial download of every scenario and the marginal cost of core + adapter in every app, in KB gzip. `tolerant` skips what does not build (a base that lacks it). */
async function measureAll(tolerant: boolean): Promise<Sizes> {
  const jobs: Job[] = [
    ...(Object.keys(SCENARIOS) as Scenario[]).map((name): Job => [name, async () => (await appBundle(SCENARIOS[name])).gzip]),
    ...APPS.map((app): Job => [app, async () => marginalBundle(await appClientBuild(join(PACKAGES, '../apps', app), { sourcemap: true }))]),
  ];
  const sizes: Record<string, number> = {};
  for (const [name, bytes] of jobs) {
    try {
      sizes[name] = kb(await bytes());
    } catch (error) {
      if (!tolerant) throw new Error(`Measuring "${name}" failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return sizes;
}

/** Runs a command quietly; when it fails, the end of its output goes to stderr. */
function run(command: string, commandArgs: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): { ok: boolean; stdout: string } {
  const result = spawnSync(command, commandArgs, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const ok = result.status === 0;
  if (!ok) console.error(`$ ${command} ${commandArgs.join(' ')}\n${`${result.stdout}${result.stderr}`.trim().split('\n').slice(-20).join('\n')}`);
  return { ok, stdout: result.stdout };
}

/**
 * The commit to compare with: in CI the merge commit's first parent (the base as merged; `HEAD^1` is in the depth-2 clone), else
 * the ref given — `--base <ref>` or the pull request's base sha.
 */
function baseOf(ref: string): string {
  const repository = join(PACKAGES, '..');
  if (fromCi && run('git', ['rev-parse', '--verify', '--quiet', 'HEAD^2'], repository).ok) {
    const parent = run('git', ['rev-parse', '--verify', 'HEAD^1'], repository);
    if (parent.ok) return parent.stdout.trim();
  }
  return ref;
}

/**
 * The base's sizes: the commit checked out into a temporary worktree (the ref is an argument, never part of a script), installed
 * from its lockfile and built, then measured by a child of this script that reads the base's `packages/`.
 */
function measureBase(given: string): Sizes | undefined {
  const ref = baseOf(given);
  if (ref.startsWith('-')) return undefined;
  const repository = join(PACKAGES, '..');
  const scratch = mkdtempSync(join(tmpdir(), 'marmeon-size-base-'));
  const worktree = join(scratch, 'base');
  let added = false;
  let bundleDir: string | undefined;
  try {
    // A shallow checkout of a pull request's merge commit has its parents; any other commit is fetched.
    let commit = run('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repository);
    if (!commit.ok && run('git', ['fetch', '--depth=1', 'origin', '--end-of-options', ref], repository).ok) {
      commit = run('git', ['rev-parse', '--verify', '--end-of-options', 'FETCH_HEAD^{commit}'], repository);
    }
    if (!commit.ok) return undefined;
    added = run('git', ['worktree', 'add', '--detach', worktree, commit.stdout.trim()], repository).ok;
    if (!added) return undefined;
    if (!run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], worktree).ok) return undefined;
    if (!run('pnpm', ['run', 'build'], worktree).ok) return undefined;
    // The measurement's app directory (`appDirectory` of bundle.ts), named by the base's `packages/`.
    const packages = realpathSync(join(worktree, 'packages'));
    bundleDir = bundleDirectory(packages);
    const measured = run(process.execPath, [fileURLToPath(import.meta.url), '--json'], repository, {
      ...process.env,
      MARMEON_SIZE_BASE: '',
      MARMEON_MEASURE_PACKAGES: packages,
    });
    if (!measured.ok) return undefined;
    try {
      return JSON.parse(measured.stdout) as Sizes;
    } catch {
      console.error(`The base's measurement is not JSON: ${measured.stdout.slice(0, 200)}`);
      return undefined;
    }
  } finally {
    if (added) run('git', ['worktree', 'remove', '--force', worktree], repository);
    else run('git', ['worktree', 'prune'], repository);
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (json) {
  console.log(JSON.stringify(await measureAll(true)));
} else if (only.length > 0) {
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    if (wanted(scenario)) print(`scenario ${scenario}`, await appBundle(SCENARIOS[scenario], { sourcemap: true }));
  }
  for (const app of APPS) {
    if (wanted(app)) print(app, await appClientBuild(join(PACKAGES, '../apps', app), { sourcemap: true }));
  }
} else {
  const sizes = await measureAll(false);
  const base = baseRef ? measureBase(baseRef) : undefined;
  const lines = ['### Bundle size', '', 'KB gzip, minified (`pnpm size`). Scenarios: the initial download, without React and i18n. Apps: what their initial load loses without the client core and the React adapter.', ''];
  if (baseRef && !base) lines.push(`The base (${baseRef}) could not be built or measured, so the sizes stand alone.`, '');
  lines.push(renderSizeTable(sizes, base));
  const report = lines.join('\n');
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
}
