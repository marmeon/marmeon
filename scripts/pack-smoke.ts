/**
 * `pnpm pack:smoke` — the framework as a stranger gets it (E158): the tarballs of every package, installed into a copy of
 * the blank app OUTSIDE the monorepo, without its node_modules, and the app's life from there. A part of `pnpm run ci`.
 *
 *   install → key:generate → build → start → GET /up 200 → make:auth → migrate → vitest run → build → start → GET /login 200
 *   (its CSP nonce on header and entry script, the entry as precompressed .br, immutable)
 *   → pnpm install --prod → node_modules/.bin/bespoke → start → GET /login 200
 *
 * Every `bespoke start` must be exactly one Node process (E159: no launcher in front of the server — signals, exit codes and
 * `NODE_OPTIONS` reach the server itself), checked with `ps` over its process group — and must load neither oxc-parser (the
 * injection lists come from `bespoke build`, E138) nor pino-pretty (JSON logs), with no "build artifacts" warning: a preloaded
 * hook records every module the start loads.
 *
 *   pnpm pack:smoke              # packs the current dist/ (pnpm build first; pnpm run ci does)
 *   pnpm pack:smoke --keep       # leaves the app in $TMPDIR (the path is printed); a red run always keeps it
 *   pnpm pack:smoke --offline [--store-dir <dir>]   # never the network: only what pnpm's store (or that one) has
 *
 * The app lives in a fresh directory under $TMPDIR: no parent directory may hold node_modules/@bespokecore or a
 * pnpm-workspace.yaml (checked by path — nothing of the repository can leak in). Every `@bespokecore/*` dependency points to
 * its tarball (`file:`), and `overrides` do the same for the packages' own dependencies on each other: their exact
 * `0.0.0` versions exist on no registry. Hoisting is off, so a package that imports what it does not declare (a
 * devDependency, say) fails here as it would for a user. The tsconfig is standalone and `@types/node` comes from the app
 * itself (until `create-bespoke-app` writes both, W8 step 10).
 *
 * Third-party packages come from pnpm's store or the registry. When neither is reachable the run ends with exit 75 and
 * "skipped" — `pnpm run ci` reports that as skipped, never as green.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { packAll, type PackedPackage } from './packages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const blankApp = join(root, 'apps/blank-app');
/** `pnpm run ci` shows a part that exits with this as skipped (EX_TEMPFAIL): no store, no network. */
export const SKIPPED = 75;
const OFFLINE = /ERR_PNPM_(NO_OFFLINE_TARBALL|NO_OFFLINE_META|META_FETCH_FAIL|TARBALL_FETCH)|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|in offline mode/;

class SmokeError extends Error {}
class Offline extends Error {}

/** The environment of every command: nothing of this repository's run (source condition, test databases, pnpm's script variables). */
function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|PNPM_|BESPOKE_|DB_|REDIS_|S3_|VITEST|INIT_CWD$|NODE_OPTIONS$|NODE_ENV$|NODE_PATH$)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
}

/** Parses JSON with comments and trailing commas (tsconfig files). */
export function parseJsonc(text: string): any {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const string = end.exec(text)![0];
      out += string;
      i += string.length - 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** A standalone tsconfig for the copy: the repository's shared settings without the source condition, then the app's own. */
function standaloneTsconfig(): object {
  const base = parseJsonc(readFileSync(join(root, 'tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
  const app = parseJsonc(readFileSync(join(blankApp, 'tsconfig.json'), 'utf8')) as { compilerOptions?: Record<string, unknown>; include?: string[] };
  const { customConditions: _conditions, declaration: _d, declarationMap: _dm, sourceMap: _sm, ...shared } = base.compilerOptions;
  return { compilerOptions: { ...shared, ...app.compilerOptions }, include: app.include };
}

/** The blank app's files as a fresh checkout has them (tracked and new, never ignored ones like .env or node_modules). */
function copyBlankApp(target: string): void {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps/blank-app'], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new SmokeError(`git ls-files failed: ${listed.stderr}`);
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const source = join(root, file);
    if (!existsSync(source)) continue; // deleted in the working tree
    const destination = join(target, relative(blankApp, source));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

/** Throws when anything above `dir` could hand the app the repository's packages or make it part of a workspace. */
function assertIsolated(dir: string): void {
  if (!relative(root, dir).startsWith('..')) throw new SmokeError(`${dir} is inside the repository.`);
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    for (const leak of ['node_modules/@bespokecore', 'pnpm-workspace.yaml']) {
      if (existsSync(join(parent, leak))) throw new SmokeError(`${join(parent, leak)} exists above the smoke app — it would not be isolated.`);
    }
    if (dirname(parent) === parent) break;
  }
}

function writeManifest(app: string, tarballs: Map<string, PackedPackage>): void {
  const file = join(app, 'package.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  manifest.name = 'bespoke-pack-smoke';
  delete manifest.description;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (!name.startsWith('@bespokecore/')) continue;
      const tarball = tarballs.get(name);
      if (!tarball) throw new SmokeError(`the blank app depends on ${name}, which pnpm pack did not produce.`);
      manifest[field][name] = `file:${tarball.tarball}`;
    }
  }
  if (!manifest.devDependencies?.['@types/node']) {
    throw new SmokeError('the blank app has no @types/node devDependency — outside the monorepo nothing else brings it.');
  }
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  const overrides = [...tarballs.values()].map((tarball) => `  ${JSON.stringify(tarball.name)}: ${JSON.stringify(`file:${tarball.tarball}`)}`);
  writeFileSync(
    join(app, 'pnpm-workspace.yaml'),
    [
      '# Written by scripts/pack-smoke.ts: the framework from its tarballs.',
      'overrides:',
      ...overrides,
      '# Nothing hoisted: a package can only import what it declares.',
      'hoistPattern: []',
      '',
    ].join('\n'),
  );
  writeFileSync(join(app, 'tsconfig.json'), `${JSON.stringify(standaloneTsconfig(), null, 2)}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface Step {
  readonly name: string;
  readonly ms: number;
}

class Smoke {
  readonly steps: Step[] = [];
  readonly env = cleanEnvironment();
  readonly #children = new Set<ChildProcess>();
  readonly app: string;

  constructor(app: string) {
    this.app = app;
  }

  async step<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const begin = performance.now();
    process.stdout.write(`pack:smoke: ${name} … `);
    try {
      const result = await work();
      const ms = performance.now() - begin;
      this.steps.push({ name, ms });
      console.log(`${(ms / 1000).toFixed(1)}s`);
      return result;
    } catch (error) {
      console.log('✗');
      throw error;
    }
  }

  /** Runs a command in the app; its output is shown only when it fails. */
  run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
    const result = spawnSync(command, args, { cwd: this.app, env: { ...this.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) throw new SmokeError(`${[command, ...args].join(' ')} failed (exit ${result.status ?? result.signal}):\n${output}`);
    return output;
  }

  bespoke(...args: string[]): string {
    return this.run(join(this.app, 'node_modules/.bin/bespoke'), args);
  }

  /**
   * `bespoke start` on a free port until `path` answers 200 — then SIGTERM to its process group (ours, nobody else's). While it
   * answers, its process group must be exactly one process, and that one Node (E159).
   */
  async serve(path: string, check?: (base: string) => Promise<void>): Promise<void> {
    const port = await freePort();
    const loads = join(dirname(this.app), 'loads.mjs');
    const loaded = join(dirname(this.app), 'loaded.json');
    writeFileSync(
      loads,
      "import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst urls = [];\n" +
        'registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });\n' +
        `process.on('exit', () => writeFileSync(${JSON.stringify(loaded)}, JSON.stringify(urls)));\n`,
    );
    rmSync(loaded, { force: true });
    const child = spawn(join(this.app, 'node_modules/.bin/bespoke'), ['start'], {
      cwd: this.app,
      // As a server runs it: NODE_ENV in the real environment — it wins over the development .env from .env.example (E170).
      env: { ...this.env, NODE_ENV: 'production', PORT: String(port), NODE_OPTIONS: `--import=${pathToFileURL(loads).href}` },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#children.add(child);
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const deadline = Date.now() + 30_000;
      let last = '';
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new SmokeError(`bespoke start exited with ${child.exitCode}:\n${output}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
          await response.body?.cancel();
          if (response.status === 200) {
            const group = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,comm='], { encoding: 'utf8' })
              .stdout.split('\n')
              .map((line) => line.trim().split(/\s+/))
              .filter(([, pgid]) => pgid === String(child.pid));
            if (group.length !== 1 || group[0]![0] !== String(child.pid) || !/(^|\/)node$/.test(group[0]![2] ?? '')) {
              throw new SmokeError(`bespoke start should be one Node process, its process group has: ${group.map((entry) => entry.join(' ')).join('; ') || 'none'}`);
            }
            await check?.(`http://127.0.0.1:${port}`);
            await this.#checkLoads(child, exited, loaded, () => output);
            return;
          }
          last = `${response.status}`;
        } catch (error) {
          if (error instanceof SmokeError) throw error; // a failed check, not a server that is not up yet
          last = (error as Error).message;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      throw new SmokeError(`GET ${path} did not answer 200 within 30 s (last: ${last}):\n${output}`);
    } finally {
      this.#stop(child);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      if (child.exitCode === null && child.signalCode === null) this.#stop(child, 'SIGKILL');
      this.#children.delete(child);
    }
  }

  /** After SIGTERM: what the start loaded (E138) — no oxc-parser, no pino-pretty — and no "build artifacts" warning. */
  async #checkLoads(child: ChildProcess, exited: Promise<void>, loaded: string, output: () => string): Promise<void> {
    this.#stop(child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (!existsSync(loaded)) throw new SmokeError(`bespoke start wrote no module list (did it exit cleanly?):\n${output()}`);
    const urls = JSON.parse(readFileSync(loaded, 'utf8')) as string[];
    const unwanted = ['oxc-parser', 'pino-pretty'].filter((name) => urls.some((url) => url.includes(`/node_modules/${name}/`)));
    if (unwanted.length > 0) throw new SmokeError(`bespoke start loaded ${unwanted.join(' and ')} (${urls.length} modules) — the injection lists of bespoke build and JSON logs should keep them out.`);
    if (output().includes('Build artifacts are')) throw new SmokeError(`bespoke start found the build artifacts stale or missing:\n${output()}`);
  }

  #stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    try {
      process.kill(-child.pid!, signal);
    } catch {
      // already gone
    }
  }

  stopAll(): void {
    for (const child of this.#children) this.#stop(child, 'SIGKILL');
  }
}

/**
 * The production HTTP defaults of the starter's shell (E147, E162): `/login` under its CSP — one nonce in the header and on the
 * entry script — and never compressed; the entry script as the `.br` `bespoke build` wrote, kept a year (`immutable`).
 */
async function checkProductionHttp(base: string): Promise<void> {
  const page = await fetch(`${base}/login`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br' }, signal: AbortSignal.timeout(5_000) });
  const html = await page.text();
  const policy = page.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  if (!nonce || !policy.includes("'strict-dynamic'")) throw new SmokeError(`GET /login has no strict CSP with a nonce: ${policy || '(no header)'}`);
  if (page.headers.get('content-encoding')) throw new SmokeError(`GET /login was compressed (${page.headers.get('content-encoding')}) — documents never are (BREACH).`);
  const entry = /<script type="module"[^>]*\ssrc="(\/assets\/[^"]+\.js)"[^>]*>/.exec(html);
  if (!entry || !entry[0].includes(`nonce="${nonce}"`)) throw new SmokeError(`The entry script of /login does not carry the response's nonce: ${entry?.[0] ?? '(no entry script)'}`);
  const asset = await fetch(`${base}${entry[1]}`, { headers: { 'accept-encoding': 'br' }, signal: AbortSignal.timeout(5_000) });
  await asset.arrayBuffer();
  if (asset.headers.get('content-encoding') !== 'br') throw new SmokeError(`${entry[1]} came without Brotli (${asset.headers.get('content-encoding') ?? 'identity'}) — bespoke build writes the .br.`);
  if (!asset.headers.get('cache-control')?.includes('immutable')) throw new SmokeError(`${entry[1]} is not cached as immutable: ${asset.headers.get('cache-control')}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { keep: { type: 'boolean' }, offline: { type: 'boolean' }, 'store-dir': { type: 'string' } } });
  const started = performance.now();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'bespoke-pack-smoke-')));
  const app = join(work, 'app');
  const smoke = new Smoke(app);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      smoke.stopAll();
      process.exit(130);
    });
  }
  let keep = values.keep === true;
  try {
    assertIsolated(app);
    const tarballs = await smoke.step('pnpm pack (all packages)', () => new Map(packAll(root, join(work, 'tarballs')).map((tarball) => [tarball.name, tarball])));
    await smoke.step('copy the blank app', () => {
      copyBlankApp(app);
      writeManifest(app, tarballs);
    });
    await smoke.step('pnpm install', () => {
      const flags = [values.offline ? '--offline' : '--prefer-offline', ...(values['store-dir'] ? ['--store-dir', values['store-dir']] : [])];
      const result = spawnSync('pnpm', ['install', ...flags, '--reporter', 'append-only'], { cwd: app, env: smoke.env, encoding: 'utf8' });
      const output = `${result.stdout}${result.stderr}`;
      if (result.status !== 0) throw OFFLINE.test(output) ? new Offline(output) : new SmokeError(`pnpm install failed (exit ${result.status}):\n${output}`);
      // The framework came from the tarballs: installed inside the smoke app, its manifest without the source condition.
      const core = realpathSync(join(app, 'node_modules/@bespokecore/core'));
      if (!core.startsWith(work + sep)) throw new SmokeError(`@bespokecore/core resolves to ${core}, not into the smoke app.`);
      if (readFileSync(join(core, 'package.json'), 'utf8').includes('@bespokecore/source')) throw new SmokeError('the installed @bespokecore/core still has the source condition.');
    });
    await smoke.step('bespoke key:generate', () => smoke.bespoke('key:generate'));
    await smoke.step('bespoke build', () => smoke.bespoke('build'));
    await smoke.step('bespoke start → GET /up 200', () => smoke.serve('/up'));
    await smoke.step('bespoke make:auth', () => {
      const output = smoke.bespoke('make:auth');
      const asks = /^(Install what the module uses|And what its tests use): (.*)$/m.exec(output);
      if (asks) throw new SmokeError(`make:auth asks for packages the blank app should have: ${asks[2]}`);
    });
    // As a developer migrates: NODE_ENV=development from the .env that key:generate copied (E170) — no --force there, and it
    // writes bootstrap/database.d.ts (E164).
    await smoke.step('bespoke migrate (development from .env)', () => {
      const output = smoke.bespoke('migrate');
      if (!output.includes('Environment: development (from .env)')) throw new SmokeError(`bespoke migrate did not take NODE_ENV=development from .env:\n${output}`);
      if (!existsSync(join(app, 'bootstrap/database.d.ts'))) throw new SmokeError(`bespoke migrate in development wrote no bootstrap/database.d.ts:\n${output}`);
    });
    const tests = await smoke.step('vitest run', () => {
      const output = smoke.run(join(app, 'node_modules/.bin/vitest'), ['run']);
      return /Tests\s+(\d+ passed[^\n]*)/.exec(output)?.[1] ?? '?';
    });
    await smoke.step('bespoke build (with the auth module)', () => {
      smoke.bespoke('build');
      // The injection lists of the app (E138): the auth module's controllers take their services through the constructor.
      const injections = JSON.parse(readFileSync(join(app, '.bespoke/injections.json'), 'utf8')) as { files: Record<string, { insert: unknown[] }> };
      const listed = Object.entries(injections.files).filter(([name, entry]) => name.startsWith('modules/auth/') && entry.insert.length > 0);
      if (listed.length < 5) throw new SmokeError(`bespoke build precomputed the injection lists of ${listed.length} auth modules — expected the controllers.`);
    });
    await smoke.step('bespoke start → GET /login 200 (CSP nonce, precompressed assets)', () => smoke.serve('/login', checkProductionHttp));
    // Production installs without the dev dependencies (E159): `bespoke` is a dependency, and the app starts without the rest.
    await smoke.step('pnpm install --prod → node_modules/.bin/bespoke', () => {
      const flags = [values.offline ? '--offline' : '--prefer-offline', ...(values['store-dir'] ? ['--store-dir', values['store-dir']] : [])];
      smoke.run('pnpm', ['install', '--prod', ...flags, '--reporter', 'append-only']);
      if (existsSync(join(app, 'node_modules/vitest'))) throw new SmokeError('pnpm install --prod left the dev dependency vitest in node_modules.');
      if (!existsSync(join(app, 'node_modules/.bin/bespoke'))) throw new SmokeError('pnpm install --prod has no node_modules/.bin/bespoke — @bespokecore/cli must be a dependency of the app.');
    });
    await smoke.step('bespoke start (production install) → GET /login 200', () => smoke.serve('/login'));
    const total = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`pack:smoke: ${tarballs.size} tarballs outside the monorepo — install, build, start, make:auth, migrate, ${tests} tests, start, production install, start: green (${total}s).`);
    return 0;
  } catch (error) {
    if (error instanceof Offline) {
      console.error(`pack:smoke: SKIPPED — pnpm could not fetch the third-party packages (no store, no network):\n${error.message.trim().split('\n').slice(-5).join('\n')}`);
      return SKIPPED;
    }
    keep = true;
    console.error(`pack:smoke: ${error instanceof SmokeError ? error.message : (error as Error).stack}`);
    return 1;
  } finally {
    smoke.stopAll();
    if (keep) console.log(`pack:smoke: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main();
