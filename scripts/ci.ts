/**
 * `pnpm run ci` — every check of the repository, one part after the other, each with its exit code and duration; exit 1 when one
 * is red. `run` is needed: `pnpm ci` is pnpm's own clean install (it deletes every `node_modules`, and checks nothing).
 *
 *   pnpm run ci                          # everything
 *   pnpm run ci --only test,size         # some parts (in the order below); --skip a,b likewise
 *   pnpm run ci --bail | --no-compose | --list   # stop at the first red · the databases already run · the parts
 *   pnpm run ci --only test --shard 2/3  # a third of the test files (Vitest's --shard) — how ci.yml spreads a suite over runners
 *
 * The suites that need a database start only this repository's `compose.yaml` containers (`marmeon-*`, `docker compose up -d
 * --wait`), never another project's, and the Postgres and Redis suites run one after the other: they share their databases.
 * A new check is one more entry in `parts`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/** A container of `compose.yaml` a part needs. */
type Service = 'pgsql' | 'redis' | 's3';

interface Part {
  readonly name: string;
  readonly command: readonly string[];
  readonly services?: readonly Service[];
  /** A Vitest run that `--shard i/n` may split: the files of one shard are about a n-th of the suite. */
  readonly shardable?: true;
  /** Parts this one builds on: when one of them ran in this run and was red, this one is skipped. */
  readonly after?: readonly string[];
}

const pnpm = (script: string) => ['pnpm', 'run', script] as const;

export const parts: readonly Part[] = [
  { name: 'build', command: pnpm('build') },
  { name: 'typecheck', command: pnpm('typecheck'), after: ['build'] },
  // oxlint over the repository; the apps' own .oxlintrc.json (marmeon make:lint-config) for their files.
  { name: 'lint', command: pnpm('lint') },
  // Rules over the repository's own files (scripts/check-source.ts).
  { name: 'check:source', command: pnpm('check:source') },
  // The bundle-size test measures the packages' dist/ — after the build.
  { name: 'test', command: pnpm('test'), shardable: true, after: ['build'] },
  { name: 'test:pgsql', command: pnpm('test:pgsql'), shardable: true, services: ['pgsql'], after: ['build'] },
  { name: 'test:redis', command: pnpm('test:redis'), shardable: true, services: ['redis'], after: ['build'] },
  { name: 'test:s3', command: pnpm('test:s3'), shardable: true, services: ['s3'], after: ['build'] },
  { name: 'size', command: pnpm('size'), after: ['build'] },
  { name: 'types:check', command: pnpm('types:check') },
  // The website: its production build, started on a free port and asked by a smoke test (scripts/website.ts).
  { name: 'website:check', command: pnpm('website:check'), after: ['build'] },
  // The tarballs: a clean build, pnpm pack of every package, the content rules, publint and attw.
  { name: 'pack:check', command: pnpm('pack:check') },
  // create-marmeon from the tarballs, outside the monorepo: the starter kit with pnpm and a blank app with npm — install, tests,
  // lint, build, start; the kit's Redis drivers talk to marmeon-redis. Without a store/cache and the registry it is skipped
  // (exit 75) — reported as such, never as green.
  { name: 'pack:smoke', command: pnpm('pack:smoke'), services: ['redis'], after: ['build', 'pack:check'] },
  // create-marmeon --docker as an image (marmeon make:docker): non-root, no .env, /up, health check, SHUTDOWN_DELAY, read-only root,
  // --workers, a worker's exit 70, the image's size; then the docs' image (apps/website/Dockerfile) — its contents, read-only, behind
  // Caddy over HTTP/2 (deploy/website). Without Docker (or the registry) it is skipped (exit 75), never green.
  { name: 'image', command: pnpm('image:smoke'), after: ['build', 'pack:check'] },
  // The release rules: one version and the changelogs that go with it,
  // release.yml (staged publishing with OIDC), npm-trust.sh, UPGRADING.md (its entries from the first release on), LICENSE and policies.
  { name: 'check-release', command: pnpm('check-release') },
];

/** `i/n` of `--shard`: both whole numbers from 1, `i` not above `n`; undefined for anything else. */
export function parseShard(value: string): string | undefined {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  return match && Number(match[1]) <= Number(match[2]) ? value : undefined;
}

/** What runs a part: its command, with Vitest's `--shard=i/n` behind it for a shardable part (`pnpm run` passes it on). */
export function commandFor(part: Part, shard?: string): readonly string[] {
  return shard !== undefined && part.shardable ? [...part.command, `--shard=${shard}`] : part.command;
}

/** The exit code of a part that could not run here (no network, no store): skipped, not green (`scripts/pack-smoke.ts`). */
const SKIPPED_EXIT = 75;

type Status = 'passed' | 'failed' | 'skipped';
interface Result {
  readonly part: Part;
  readonly status: Status;
  readonly ms: number;
  readonly note?: string;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const github = process.env.GITHUB_ACTIONS === 'true';
let current: ChildProcess | undefined;


function run(command: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    const [file, ...args] = command as [string, ...string[]];
    const child = spawn(file, args, { cwd: root, stdio: 'inherit' });
    current = child;
    child.on('error', (error) => {
      console.error(`ci: ${file} could not start: ${error.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      current = undefined;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

const started = new Set<Service>();

/** Starts (or finds healthy) the containers a part needs — `compose.yaml`'s own, nothing else. */
async function ensureServices(services: readonly Service[], compose: boolean): Promise<string | undefined> {
  const missing = services.filter((service) => !started.has(service));
  if (!compose || missing.length === 0) return undefined;
  const code = await run(['docker', 'compose', 'up', '-d', '--wait', ...missing]);
  if (code !== 0) return `docker compose up -d --wait ${missing.join(' ')} failed (exit ${code})`;
  for (const service of missing) started.add(service);
  return undefined;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function select(only: string | undefined, skip: string | undefined): Part[] | string {
  const names = (list: string | undefined) => (list ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const known = new Set(parts.map((part) => part.name));
  const unknown = [...names(only), ...names(skip)].filter((name) => !known.has(name));
  if (unknown.length > 0) return `Unknown part${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Known: ${[...known].join(', ')}.`;
  const wanted = only === undefined ? known : new Set(names(only));
  const skipped = new Set(names(skip));
  return parts.filter((part) => wanted.has(part.name) && !skipped.has(part.name));
}

async function main(): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        only: { type: 'string' },
        skip: { type: 'string' },
        bail: { type: 'boolean', default: false },
        'no-compose': { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        shard: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`ci: ${(error as Error).message}`);
    return 2;
  }
  if (values.help || values.list) {
    if (values.help) console.log('Usage: pnpm run ci [--only a,b] [--skip a,b] [--bail] [--no-compose] [--list] [--shard i/n]\n');
    for (const part of parts) console.log(`  ${part.name.padEnd(17)} ${part.command.join(' ')}${part.services ? `  (needs ${part.services.join(', ')})` : ''}${part.shardable ? '  (--shard)' : ''}`);
    return 0;
  }
  const selected = select(values.only, values.skip);
  if (typeof selected === 'string') {
    console.error(`ci: ${selected}`);
    return 2;
  }
  if (selected.length === 0) {
    console.error('ci: nothing selected.');
    return 2;
  }
  if (values.shard !== undefined) {
    if (parseShard(values.shard) === undefined) {
      console.error(`ci: --shard ${values.shard} — expected i/n with 1 ≤ i ≤ n, e.g. 2/3.`);
      return 2;
    }
    if (!selected.some((part) => part.shardable)) {
      console.error(`ci: --shard splits a test run, and none is selected (${parts.filter((part) => part.shardable).map((part) => part.name).join(', ')}).`);
      return 2;
    }
  }
  const compose = !values['no-compose'];

  const results: Result[] = [];
  const red = new Set<string>();
  for (const part of selected) {
    const blocker = part.after?.find((name) => red.has(name));
    if (blocker || (values.bail && red.size > 0)) {
      results.push({ part, status: 'skipped', ms: 0, note: blocker ? `${blocker} is red` : '--bail' });
      red.add(part.name);
      continue;
    }
    const command = commandFor(part, values.shard);
    console.log(github ? `::group::ci: ${part.name}` : `\n▶ ci: ${part.name} — ${command.join(' ')}`);
    const begin = performance.now();
    const problem = await ensureServices(part.services ?? [], compose);
    const code = problem ? 1 : await run(command);
    const ms = performance.now() - begin;
    if (github) console.log('::endgroup::');
    if (problem) console.error(`ci: ${problem}`);
    const status: Status = code === 0 ? 'passed' : !problem && code === SKIPPED_EXIT ? 'skipped' : 'failed';
    if (status !== 'passed') red.add(part.name);
    const note = problem ?? (status === 'skipped' ? 'could not run here (no network, store or Docker)' : code === 0 ? undefined : `exit ${code}`);
    results.push({ part, status, ms, note });
    console.log(`${{ passed: '✓', failed: '✗', skipped: '–' }[status]} ci: ${part.name} ${seconds(ms)}${note ? ` (${note})` : ''}`);
    if (github && status === 'failed') console.log(`::error title=ci: ${part.name}::${command.join(' ')} — ${problem ?? `exit ${code}`}`);
  }

  const total = results.reduce((sum, result) => sum + result.ms, 0);
  const mark = { passed: '✓', failed: '✗', skipped: '–' } as const;
  console.log('\nci summary');
  for (const result of results) {
    console.log(`  ${mark[result.status]} ${result.part.name.padEnd(17)} ${result.status.padEnd(8)} ${seconds(result.ms).padStart(7)}${result.note ? `  ${result.note}` : ''}`);
  }
  const failed = results.filter((result) => result.status !== 'passed');
  console.log(`  ${failed.length === 0 ? 'all green' : `${failed.length} of ${results.length} not green`} in ${seconds(total)}`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      current?.kill(signal);
      process.exit(130);
    });
  }
  process.exitCode = await main();
}
