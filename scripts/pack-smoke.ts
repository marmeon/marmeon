/**
 * `pnpm pack:smoke` — the framework as a stranger gets it (E158, E150): the tarballs of every package, and a new app made
 * from them OUTSIDE the monorepo by the `create-marmeon` tarball — twice. A part of `pnpm run ci`.
 *
 *   create-marmeon without a directory and without a terminal → exit 2 at once (never a prompt that waits)
 *   create-marmeon app --yes (the starter kit, pnpm, git) → package.json at exact versions, .env with APP_KEY, one clean commit
 *     → migrate (development from .env) → vitest run → lint → build without .env (E187: no key; nothing shaped like an APP_KEY and
 *     not the app's own in dist/ or .marmeon/) → start → GET /login 200
 *     (its CSP nonce on header and entry script, no cookie for a guest, a cross-site post refused, the entry as precompressed
 *     .br, immutable), GET / 200, a sign-up with a known address answered like a new one (private registration, E146) → start
 *     with AUTH_PRIVATE_REGISTRATION=false: the known address is "already registered", and the boot warns (E193) → pnpm install --prod → node_modules/.bin/marmeon → start → GET /login 200
 *     → SMTP from the production install (nodemailer comes with @marmeon/mail, E198) → pnpm add @marmeon/redis @marmeon/storage (their
 *     tarballs, nothing else), build: start with CACHE_DRIVER=redis SESSION_DRIVER=redis on the Redis of compose.yaml (`redis` came with
 *     @marmeon/redis — the app's package.json has none) → an S3 default disk without the AWS SDK: the start fails with the exact command
 *   create-marmeon app-npm --minimal --npm --no-git → build without .env → start → GET /up 200 → vitest run → discovery in npm's flat
 *     node_modules finds every package the pnpm app's does (E151)
 *
 * Every `marmeon start` must be exactly one Node process (E159: no launcher in front of the server — signals, exit codes and
 * `NODE_OPTIONS` reach the server itself), checked with `ps` over its process group — and must load neither oxc-parser (the
 * injection lists come from `marmeon build`, E138) nor pino-pretty (JSON logs), with no "build artifacts" warning: a preloaded
 * hook records every module the start loads.
 *
 *   pnpm pack:smoke              # packs the current dist/ (pnpm build first; pnpm run ci does)
 *   pnpm pack:smoke --keep       # leaves the apps in $TMPDIR (the path is printed); a red run always keeps them
 *   pnpm pack:smoke --offline [--store-dir <dir>]   # never the network: only what pnpm's store (or that one) and npm's cache have
 *
 * The apps live in a fresh directory under $TMPDIR: no parent directory may hold node_modules/@marmeon or a
 * pnpm-workspace.yaml (checked by path — nothing of the repository can leak in). The scaffolder takes the framework from
 * `MARMEON_CREATE_TARBALLS` (its maintainers' switch, packages/create-marmeon/README.md): the tarballs go into the app's
 * `vendor/marmeon/`, every `@marmeon/*` dependency and override points there (the exact versions of this checkout are on no
 * registry), and for pnpm nothing is hoisted — a package that imports what it does not declare (a devDependency, say) fails
 * here as it would for a user.
 *
 * Third-party packages come from pnpm's store, npm's cache or the registry. When none is reachable the run ends with exit 75
 * and "skipped" — `pnpm run ci` reports that as skipped, never as green. The Redis step needs the Redis of compose.yaml
 * (`MARMEON_TEST_REDIS_URL`, default redis://127.0.0.1:56379 — `pnpm run ci` starts it); without it the run is red.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { packAll, type PackedPackage } from './packages.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** `pnpm run ci` shows a part that exits with this as skipped (EX_TEMPFAIL): no store, no network. */
export const SKIPPED = 75;
export const OFFLINE = /ERR_PNPM_(NO_OFFLINE_TARBALL|NO_OFFLINE_META|META_FETCH_FAIL|TARBALL_FETCH)|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|in offline mode|ENOTCACHED/;
/** The Redis of compose.yaml (marmeon-redis) — the driver step of the starter kit talks to it (E198). */
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL ?? 'redis://127.0.0.1:56379';
/** What a missing AWS SDK says (E198: optional peers, the exact command with the tested major). */
const S3_COMMAND = 'pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3';
/** What create-marmeon says without a directory and without a terminal (E167). */
const NO_DIRECTORY = 'create-marmeon needs a directory: create-marmeon <dir> [--yes]';

export class SmokeError extends Error {}
export class Offline extends Error {}

/** The environment of every command: nothing of this repository's run (source condition, test databases, pnpm's script variables). */
export function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|pnpm_|PNPM_|MARMEON_|DB_|REDIS_|S3_|VITEST|GIT_|INIT_CWD$|NODE_OPTIONS$|NODE_ENV$|NODE_PATH$)/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, NO_COLOR: '1', FORCE_COLOR: '0' };
}

/** Throws when anything above `dir` could hand the app the repository's packages or make it part of a workspace. */
export function assertIsolated(dir: string): void {
  if (!relative(root, dir).startsWith('..')) throw new SmokeError(`${dir} is inside the repository.`);
  for (let parent = dirname(dir); ; parent = dirname(parent)) {
    for (const leak of ['node_modules/@marmeon', 'pnpm-workspace.yaml']) {
      if (existsSync(join(parent, leak))) throw new SmokeError(`${join(parent, leak)} exists above the smoke app — it would not be isolated.`);
    }
    if (dirname(parent) === parent) break;
  }
}

/** The packed `create-marmeon`, unpacked into `dir` — it has no dependencies, so its bin runs as it is. Returns the bin. */
export function unpackScaffolder(tarballs: ReadonlyMap<string, PackedPackage>, dir: string): string {
  const scaffolder = tarballs.get('create-marmeon');
  if (!scaffolder) throw new SmokeError('pnpm pack made no create-marmeon tarball.');
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', scaffolder.tarball, '-C', dir], { encoding: 'utf8' });
  if (tar.status !== 0) throw new SmokeError(`could not unpack ${scaffolder.tarball}: ${tar.stderr}`);
  return join(dir, 'package', 'bin', 'create-marmeon.js');
}

/**
 * A git that commits without anyone's signing key or identity — and without the machine's global ignore file, which could hide
 * a `.env` the template's `.gitignore` forgot: for the throwaway repositories of the smoke apps only.
 */
export const THROWAWAY_GIT: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.excludesFile',
  GIT_CONFIG_VALUE_1: '/dev/null',
  GIT_AUTHOR_NAME: 'Smoke',
  GIT_AUTHOR_EMAIL: 'smoke@example.com',
  GIT_COMMITTER_NAME: 'Smoke',
  GIT_COMMITTER_EMAIL: 'smoke@example.com',
};

/**
 * Runs the unpacked create-marmeon in `cwd` without a terminal (stdin closed) — the framework from `tarballs`. Throws
 * `Offline` when the install could not reach the registry, a `SmokeError` with its output on any other failure.
 */
export function scaffold(bin: string, cwd: string, args: string[], { tarballs, env = {} }: { tarballs: string; env?: NodeJS.ProcessEnv }): string {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    env: { ...cleanEnvironment(), MARMEON_CREATE_TARBALLS: tarballs, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) {
    throw OFFLINE.test(output) ? new Offline(output) : new SmokeError(`create-marmeon ${args.join(' ')} failed (exit ${result.status ?? result.signal}):\n${output}`);
  }
  return output;
}

/**
 * The generated package.json: every `@marmeon/*` and the CLI `marmeon` from its vendored tarball — never `workspace:`, never a floating
 * range; `@marmeon/validation` and no `valibot` (E197).
 */
export function checkManifest(app: string, packageManager: 'pnpm' | 'npm'): Record<string, any> {
  const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as Record<string, any>;
  for (const field of ['dependencies', 'devDependencies', 'overrides'] as const) {
    for (const [name, range] of Object.entries((manifest[field] ?? {}) as Record<string, string>)) {
      if (/workspace:|^latest$|^\*$/.test(range)) throw new SmokeError(`package.json ${field}.${name} is "${range}" — a new app pins every package.`);
      if ((name.startsWith('@marmeon/') || name === 'marmeon') && !/^file:(?:\.|\/.+)\/vendor\/marmeon\/marmeon(?:-[\w-]+)?-\d+\.\d+\.\d+[\w.-]*\.tgz$/.test(range)) {
        throw new SmokeError(`package.json ${field}.${name} is "${range}", not its vendored tarball.`);
      }
    }
  }
  // Validation is @marmeon/validation's (E197): Valibot is its engine, never the app's to install.
  const engines = ['dependencies', 'devDependencies'].filter((field) => 'valibot' in ((manifest[field] ?? {}) as Record<string, string>));
  if (engines.length > 0) throw new SmokeError(`package.json ${engines.join(' and ')} list valibot — a new app validates with @marmeon/validation and installs no engine (E197).`);
  if (!manifest.dependencies?.['@marmeon/validation']) throw new SmokeError('package.json has no @marmeon/validation — the rules of config/app.ts come from it.');
  if (packageManager === 'pnpm' && !/^pnpm@12\.\d+\.\d+$/.test(manifest.packageManager ?? '')) throw new SmokeError(`package.json pins no pnpm 12: ${manifest.packageManager}`);
  if (packageManager === 'npm' && (manifest.packageManager || existsSync(join(app, 'pnpm-workspace.yaml')) || existsSync(join(app, 'pnpm-lock.yaml')))) {
    throw new SmokeError('the npm app has pnpm files (packageManager, pnpm-workspace.yaml or pnpm-lock.yaml).');
  }
  const env = readFileSync(join(app, '.env'), 'utf8');
  if (!/^APP_KEY=base64:[A-Za-z0-9+/]{43}=$/m.test(env)) throw new SmokeError('.env has no APP_KEY.');
  if (!/^APP_KEY=$/m.test(readFileSync(join(app, '.env.example'), 'utf8'))) throw new SmokeError('.env.example carries an APP_KEY.');
  // The framework came from the tarballs: installed inside the app, its manifest without the source condition.
  const core = realpathSync(join(app, 'node_modules/@marmeon/core'));
  if (!core.startsWith(app + sep)) throw new SmokeError(`@marmeon/core resolves to ${core}, not into the app.`);
  if (readFileSync(join(core, 'package.json'), 'utf8').includes('@marmeon/source')) throw new SmokeError('the installed @marmeon/core still has the source condition.');
  return manifest;
}

/** An `APP_KEY` as `marmeon key:generate` writes it — the shape a key (a real one or a placeholder) has in any file. */
const KEY_SHAPE = /base64:[A-Za-z0-9+/]{43}=/;

/**
 * Every place in what `marmeon build` wrote (`dist/`, `.marmeon/`) that holds something shaped like an `APP_KEY` or one of
 * `values` — the app's own secrets (E187: the build has none, so none may end up there). Compressed copies are skipped: their
 * originals are read.
 */
export function secretsIn(app: string, values: readonly string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!/\.(br|gz|png|jpe?g|webp|avif|ico|woff2?)$/.test(entry.name)) {
        const text = readFileSync(path, 'utf8');
        const what = [KEY_SHAPE.exec(text)?.[0], ...values.filter((value) => value !== '' && text.includes(value))].filter((hit) => hit !== undefined);
        if (what.length > 0) found.push(`${relative(app, path)} (${[...new Set(what)].map((hit) => `${hit.slice(0, 12)}…`).join(', ')})`);
      }
    }
  };
  for (const dir of ['dist', '.marmeon']) walk(join(app, dir));
  return found;
}

export function freePort(): Promise<number> {
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

/** One command to a Redis (RESP over a socket — no client library in this script): the reply as text, its first line decides. */
export function redisCommand(url: string, args: readonly string[]): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: hostname, port: Number(port || 6379) });
    let reply = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error(`no answer from Redis at ${url}`)));
    socket.on('connect', () => socket.write(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join('')}`));
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      // Enough for the replies used here: a status, an integer, or an array whose last element ends the reply.
      if (/^[+:-][^\r]*\r\n$/.test(reply) || /^\*0\r\n$/.test(reply) || (/^\*\d+\r\n/.test(reply) && reply.split('\r\n').length >= Number(/^\*(\d+)/.exec(reply)![1]) * 2 + 2)) {
        socket.end();
        resolve(reply);
      }
    });
    socket.on('error', (error) => reject(new SmokeError(`Redis at ${url} is not reachable (${error.message}) — docker compose up -d --wait redis (pnpm run ci starts it).`)));
  });
}

/** The keys under `prefix` (a smoke run's own: `KEYS` is fine on a test Redis). */
async function redisKeys(prefix: string): Promise<string[]> {
  const reply = await redisCommand(REDIS_URL, ['KEYS', `${prefix}*`]);
  return reply.split('\r\n').filter((line, index) => index > 0 && line !== '' && !line.startsWith('$'));
}

/**
 * A minimal SMTP server without TLS (as Mailpit is): takes one message and hands back its envelope and data. Closed by `close()`.
 */
function smtpServer(): Promise<{ port: number; received: { envelope: string[]; data: string }; close: () => void }> {
  const received = { envelope: [] as string[], data: '' };
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let inData = false;
    socket.write('220 smoke ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          received.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 queued\r\n');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'MAIL' || command === 'RCPT') received.envelope.push(line.replace(/ SIZE=\d+/, ''));
        if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const close = () => {
        for (const socket of sockets) socket.destroy();
        server.close();
      };
      resolve({ port: (server.address() as { port: number }).port, received, close });
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
  readonly label: string;

  constructor(app: string, label: string) {
    this.app = app;
    this.label = label;
  }

  async step<T>(name: string, work: () => Promise<T> | T): Promise<T> {
    const begin = performance.now();
    process.stdout.write(`pack:smoke [${this.label}]: ${name} … `);
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

  marmeon(...args: string[]): string {
    return this.run(join(this.app, 'node_modules/.bin/marmeon'), args);
  }

  /**
   * `marmeon build` as an image builds it (E187): without the app's `.env` — no key, no name, no database — then what it wrote must
   * hold no secret: neither the app's `APP_KEY` nor anything shaped like one (a placeholder a build phase might have used).
   */
  buildWithoutEnv(): string {
    const env = join(this.app, '.env');
    const aside = join(this.app, '.env.aside-for-the-build');
    renameSync(env, aside);
    let output: string;
    try {
      output = this.marmeon('build');
    } finally {
      renameSync(aside, env);
    }
    const key = /^APP_KEY=(.*)$/m.exec(readFileSync(env, 'utf8'))?.[1] ?? '';
    const leaked = secretsIn(this.app, [key]);
    if (leaked.length > 0) throw new SmokeError(`marmeon build wrote a secret (or a placeholder key) into its output: ${leaked.join('; ')}`);
    return output;
  }

  /**
   * `marmeon start` on a free port until `path` answers 200 — then SIGTERM to its process group (ours, nobody else's). While it
   * answers, its process group must be exactly one process, and that one Node (E159).
   */
  async serve(path: string, check?: (base: string, output: () => string) => Promise<void>, env: NodeJS.ProcessEnv = {}): Promise<void> {
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
    const child = spawn(join(this.app, 'node_modules/.bin/marmeon'), ['start'], {
      cwd: this.app,
      // As a server runs it: NODE_ENV in the real environment — it wins over the development .env from .env.example (E170).
      env: { ...this.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), NODE_OPTIONS: `--import=${pathToFileURL(loads).href}`, ...env },
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
        if (child.exitCode !== null) throw new SmokeError(`marmeon start exited with ${child.exitCode}:\n${output}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
          await response.body?.cancel();
          if (response.status === 200) {
            const group = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,comm='], { encoding: 'utf8' })
              .stdout.split('\n')
              .map((line) => line.trim().split(/\s+/))
              .filter(([, pgid]) => pgid === String(child.pid));
            if (group.length !== 1 || group[0]![0] !== String(child.pid) || !/(^|\/)node$/.test(group[0]![2] ?? '')) {
              throw new SmokeError(`marmeon start should be one Node process, its process group has: ${group.map((entry) => entry.join(' ')).join('; ') || 'none'}`);
            }
            await check?.(`http://127.0.0.1:${port}`, () => output);
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

  /** `marmeon start` that must not come up: its exit code and output (SIGKILL after 30 s — then it did come up). */
  async startFailing(env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
    const child = spawn(join(this.app, 'node_modules/.bin/marmeon'), ['start'], {
      cwd: this.app,
      env: { ...this.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', ...env },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#children.add(child);
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.#stop(child, 'SIGKILL');
        resolve(null);
      }, 30_000);
      child.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    this.#children.delete(child);
    return { code, output };
  }

  /** After SIGTERM: what the start loaded (E138) — no oxc-parser, no pino-pretty — and no "build artifacts" warning. */
  async #checkLoads(child: ChildProcess, exited: Promise<void>, loaded: string, output: () => string): Promise<void> {
    this.#stop(child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (!existsSync(loaded)) throw new SmokeError(`marmeon start wrote no module list (did it exit cleanly?):\n${output()}`);
    const urls = JSON.parse(readFileSync(loaded, 'utf8')) as string[];
    const unwanted = ['oxc-parser', 'pino-pretty'].filter((name) => urls.some((url) => url.includes(`/node_modules/${name}/`)));
    if (unwanted.length > 0) throw new SmokeError(`marmeon start loaded ${unwanted.join(' and ')} (${urls.length} modules) — the injection lists of marmeon build and JSON logs should keep them out.`);
    if (output().includes('Build artifacts are')) throw new SmokeError(`marmeon start found the build artifacts stale or missing:\n${output()}`);
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
 * The production HTTP defaults of the starter kit (E147, E162): `/login` under its CSP — one nonce in the header and on the
 * entry script — and never compressed, for a guest without a cookie (E143), a cross-site post refused; the entry script as the
 * `.br` `marmeon build` wrote, kept a year (`immutable`); the home page.
 */
/**
 * The look comes from stylesheets the built index.html links (E202): `@marmeon/react/styles.css` — resolved from the packed
 * package's `exports` — and, in the kit, the auth module's `auth.css`. No inline style needed under a strict `style-src`.
 */
/** The built browser files that keep a development branch: the client core calls the devtools hook only there. */
function developmentBranchesIn(client: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.js') && readFileSync(path, 'utf8').includes('__MARMEON_DEVTOOLS_HOOK__')) found.push(path.slice(client.length + 1));
    }
  };
  walk(client);
  return found;
}

function checkStyles(app: string, classes: readonly string[]): void {
  const client = join(app, 'dist/client');
  const html = readFileSync(join(client, 'index.html'), 'utf8');
  const linked = [...html.matchAll(/<link rel="stylesheet"[^>]* href="\/([^"]+\.css)"/g)].map((match) => match[1]!);
  const css = linked.map((file) => readFileSync(join(client, file), 'utf8')).join('\n');
  const missing = classes.filter((name) => !css.includes(`.${name}`));
  if (missing.length > 0) throw new SmokeError(`the built index.html links ${linked.join(', ') || 'no stylesheet'} — without ${missing.map((name) => `.${name}`).join(', ')} (E202).`);
}

async function checkProductionHttp(base: string): Promise<void> {
  const home = await fetch(`${base}/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5_000) });
  const homeHtml = await home.text();
  if (home.status !== 200 || !homeHtml.includes('home/Home')) throw new SmokeError(`GET / answered ${home.status} without the home page (modules/home).`);
  const page = await fetch(`${base}/login`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br' }, signal: AbortSignal.timeout(5_000) });
  const html = await page.text();
  const policy = page.headers.get('content-security-policy') ?? '';
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  if (!nonce || !policy.includes("'strict-dynamic'")) throw new SmokeError(`GET /login has no strict CSP with a nonce: ${policy || '(no header)'}`);
  if (page.headers.get('content-encoding')) throw new SmokeError(`GET /login was compressed (${page.headers.get('content-encoding')}) — documents never are (BREACH).`);
  // A guest's page keeps no session (E143): no cookie — and a post from another site is refused before the token is asked for.
  if (page.headers.getSetCookie().length > 0) throw new SmokeError(`GET /login of a guest set cookies (E143: no session for a guest): ${page.headers.getSetCookie().join(' | ')}`);
  const forged = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'cross-site', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40example.com&password=x', signal: AbortSignal.timeout(5_000) });
  await forged.arrayBuffer();
  if (forged.status !== 403) throw new SmokeError(`A cross-site POST /login answered ${forged.status}, expected 403 (E143, Fetch Metadata).`);
  const entry = /<script type="module"[^>]*\ssrc="(\/assets\/[^"]+\.js)"[^>]*>/.exec(html);
  if (!entry || !entry[0].includes(`nonce="${nonce}"`)) throw new SmokeError(`The entry script of /login does not carry the response's nonce: ${entry?.[0] ?? '(no entry script)'}`);
  const asset = await fetch(`${base}${entry[1]}`, { headers: { 'accept-encoding': 'br' }, signal: AbortSignal.timeout(5_000) });
  await asset.arrayBuffer();
  if (asset.headers.get('content-encoding') !== 'br') throw new SmokeError(`${entry[1]} came without Brotli (${asset.headers.get('content-encoding') ?? 'identity'}) — marmeon build writes the .br.`);
  if (!asset.headers.get('cache-control')?.includes('immutable')) throw new SmokeError(`${entry[1]} is not cached as immutable: ${asset.headers.get('cache-control')}`);
}

/**
 * The registration of the starter kit (E146, E193): private by default — a sign-up with an address that has an account is answered
 * like one with a new address (303 to /register/sent); with `AUTH_PRIVATE_REGISTRATION=false` the second sign-up with an address is
 * told "already registered", and the boot of a production server warns once.
 */
function checkRegistration(privately: boolean) {
  return async (base: string, output: () => string): Promise<void> => {
    const email = privately ? 'private@example.com' : 'open@example.com';
    const register = async (cookie?: string) => {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: base, referer: `${base}/register`, 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
        body: new URLSearchParams({ name: 'Katherine Johnson', email, password: 'orbital mechanics', password_confirmation: 'orbital mechanics' }),
        signal: AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer();
      return response;
    };
    const first = await register();
    const second = await register();
    const where = (response: Response) => `${response.status} → ${response.headers.get('location')}`;
    if (privately) {
      for (const response of [first, second]) {
        if (response.status !== 303 || !response.headers.get('location')?.endsWith('/register/sent')) throw new SmokeError(`A sign-up answered ${where(response)}, expected 303 → /register/sent for a new and a known address alike (E146).`);
      }
      if (second.headers.getSetCookie().length > 0) throw new SmokeError('A sign-up with a known address set a cookie — the private registration answers without a session (E146).');
      return;
    }
    if (first.status !== 303 || !first.headers.get('location')?.endsWith('/dashboard')) throw new SmokeError(`With AUTH_PRIVATE_REGISTRATION=false a sign-up answered ${where(first)}, expected 303 → /dashboard (signed in).`);
    if (!second.headers.get('location')?.endsWith('/register')) throw new SmokeError(`With AUTH_PRIVATE_REGISTRATION=false a second sign-up answered ${where(second)}, expected back to /register with an error.`);
    const cookie = second.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ');
    const page = await fetch(`${base}/register`, { headers: { accept: 'text/html', cookie }, signal: AbortSignal.timeout(5_000) });
    if (!(await page.text()).includes('This e-mail address is already registered.')) throw new SmokeError('With AUTH_PRIVATE_REGISTRATION=false the form did not say "already registered" for a known address.');
    if (!output().includes('AUTH_PRIVATE_REGISTRATION=false outside development and tests')) throw new SmokeError(`A production start with AUTH_PRIVATE_REGISTRATION=false did not warn (E193):\n${output()}`);
  };
}

/**
 * The production install sends a mail over SMTP — nodemailer is a dependency of @marmeon/mail (E198), the app never names it. A
 * local server without TLS, so `requireTls: false` (MAIL_REQUIRE_TLS=false, as for Mailpit).
 */
async function checkSmtp(smoke: Smoke): Promise<void> {
  const server = await smtpServer();
  try {
    const script =
      "import { compose, SmtpTransport } from '@marmeon/mail';\n" +
      `const transport = new SmtpTransport({ host: '127.0.0.1', port: ${server.port}, secure: false, requireTls: false });\n` +
      "await transport.send(await compose({ envelope: () => ({ to: 'ada@example.com', subject: 'Smoke' }), content: () => ({ html: '<p>Hello</p>', text: 'Hello' }) }, 'app@example.com'));\n" +
      'await transport.close();\n';
    // Asynchronously: the SMTP server lives in this process (spawnSync would block it).
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: smoke.app, env: smoke.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (chunk) => (output += chunk));
    child.stderr!.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)));
    clearTimeout(timer);
    if (code !== 0) throw new SmokeError(`SMTP from the production install failed (exit ${code ?? 'killed after 30 s'}):\n${output}`);
    if (!server.received.envelope.includes('RCPT TO:<ada@example.com>') || !/^Subject: Smoke$/m.test(server.received.data)) {
      throw new SmokeError(`the SMTP server got no mail: ${JSON.stringify(server.received)}`);
    }
  } finally {
    server.close();
  }
}

/**
 * The Redis drivers of the starter kit: `/up/ready` (the cache takes and frees a key, Redis answers PING), a failed sign-in writes its
 * flash into a Redis session — and the keys are under the run's prefix.
 */
async function checkRedisDrivers(base: string, prefix: string): Promise<void> {
  const ready = await fetch(`${base}/up/ready`, { signal: AbortSignal.timeout(5_000) });
  const readiness = await ready.text();
  if (ready.status !== 200) throw new SmokeError(`GET /up/ready with the Redis drivers answered ${ready.status}: ${readiness}`);
  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, referer: `${base}/login`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'nobody@example.com', password: 'not the password' }),
    signal: AbortSignal.timeout(10_000),
  });
  await login.arrayBuffer();
  if (login.status !== 303 || !login.headers.getSetCookie().some((cookie) => cookie.startsWith('marmeon_session='))) {
    throw new SmokeError(`A failed sign-in answered ${login.status} without a session cookie — expected 303 back to /login with its error in the session.`);
  }
  const keys = await redisKeys(prefix);
  if (!keys.some((key) => key.startsWith(`${prefix}session:`))) throw new SmokeError(`No session in Redis under ${prefix} — the keys: ${keys.join(', ') || 'none'}`);
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { keep: { type: 'boolean' }, offline: { type: 'boolean' }, 'store-dir': { type: 'string' } } });
  const started = performance.now();
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-pack-smoke-')));
  const pnpmApp = new Smoke(join(work, 'app'), 'pnpm');
  const npmApp = new Smoke(join(work, 'app-npm'), 'npm');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      pnpmApp.stopAll();
      npmApp.stopAll();
      process.exit(130);
    });
  }
  // The package managers' own settings through their environment (the scaffolder runs the install): a warm store, or none of the network.
  const offline = values.offline === true;
  const installEnv: NodeJS.ProcessEnv = {
    ...(offline ? { pnpm_config_offline: 'true', npm_config_offline: 'true' } : { pnpm_config_prefer_offline: 'true', npm_config_prefer_offline: 'true' }),
    ...(values['store-dir'] ? { pnpm_config_store_dir: values['store-dir'] } : {}),
  };
  const pnpmFlags = [offline ? '--offline' : '--prefer-offline', ...(values['store-dir'] ? ['--store-dir', values['store-dir']] : [])];
  let keep = values.keep === true;
  try {
    assertIsolated(pnpmApp.app);
    const tarballDir = join(work, 'tarballs');
    const tarballs = await pnpmApp.step('pnpm pack (all packages)', () => new Map(packAll(root, tarballDir).map((tarball) => [tarball.name, tarball])));
    const bin = unpackScaffolder(tarballs, join(work, 'create-marmeon'));

    // Without a directory and without a terminal: exit 2 and the reason — at once, never a prompt that waits for an answer (E167).
    await pnpmApp.step('create-marmeon without a directory, no terminal → exit 2', () => {
      const result = spawnSync(process.execPath, [bin], { cwd: work, env: cleanEnvironment(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000 });
      if (result.error) throw new SmokeError(`create-marmeon without a directory did not end within 15 s (waiting for an answer?): ${result.error.message}`);
      if (result.status !== 2 || !result.stderr.includes(NO_DIRECTORY)) throw new SmokeError(`create-marmeon without a directory ended with ${result.status}, expected 2 and "${NO_DIRECTORY}":\n${result.stdout}${result.stderr}`);
    });

    // ── The starter kit with pnpm (the defaults — its registration private, E146/E193) ──
    const app = pnpmApp.app;
    await pnpmApp.step('create-marmeon app --yes (starter kit, pnpm, install, make:auth, migrate, git)', () => {
      const output = scaffold(bin, work, ['app', '--yes'], { tarballs: tarballDir, env: { ...installEnv, ...THROWAWAY_GIT } });
      if (!output.includes('marmeon make:auth') || !output.includes('git: a repository with the first commit')) throw new SmokeError(`create-marmeon skipped a step:\n${output}`);
      checkManifest(app, 'pnpm');
      for (const file of ['modules/auth/routes.ts', 'modules/auth/controllers/ConfirmEmailChangeController.ts', 'modules/home/routes.ts', 'pnpm-lock.yaml', 'storage/database.sqlite']) {
        if (!existsSync(join(app, file))) throw new SmokeError(`the starter kit has no ${file}.`);
      }
      // One commit, nothing left over — and none of what the app writes or keeps secret in it (.gitignore of the template).
      const git = (...args: string[]) => pnpmApp.run('git', args, THROWAWAY_GIT).trim();
      if (git('rev-list', '--count', 'HEAD') !== '1') throw new SmokeError('the new repository should have exactly one commit.');
      if (git('status', '--porcelain') !== '') throw new SmokeError(`the first commit left files behind:\n${git('status', '--porcelain')}`);
      const tracked = git('ls-files').split('\n');
      const leaked = tracked.filter((file) => /^(\.env$|node_modules\/|dist\/|\.marmeon\/)|\.sqlite$|^storage\/(?!.*\.gitignore$)/.test(file));
      if (leaked.length > 0) throw new SmokeError(`the first commit carries ${leaked.join(', ')}.`);
    });
    // As a developer migrates: NODE_ENV=development from the .env (E170) — no --force there.
    await pnpmApp.step('marmeon migrate (development from .env)', () => {
      const output = pnpmApp.marmeon('migrate');
      if (!output.includes('Environment: development (from .env)')) throw new SmokeError(`marmeon migrate did not take NODE_ENV=development from .env:\n${output}`);
    });
    const tests = await pnpmApp.step('vitest run (auth, home, system)', () => {
      const output = pnpmApp.run(join(app, 'node_modules/.bin/vitest'), ['run', '--reporter=verbose']);
      if (!/modules\/home\/home\.test\.ts/.test(output)) throw new SmokeError(`vitest did not run the home module's tests:\n${output}`);
      if (!/modules\/auth\/email-change\.test\.ts/.test(output)) throw new SmokeError(`vitest did not run the change of address's tests (email-change.test.ts):\n${output}`);
      if (!/AUTH_PRIVATE_REGISTRATION=false/.test(output)) throw new SmokeError(`vitest did not run the tests with AUTH_PRIVATE_REGISTRATION=false (E193):\n${output}`);
      return /Tests\s+(\d+) passed/.exec(output)?.[1] ?? '?';
    });
    await pnpmApp.step('lint (oxlint with the app\'s preset, no warnings)', () => pnpmApp.run('pnpm', ['run', 'lint', '--deny-warnings']));
    await pnpmApp.step('marmeon build without .env (no key, E187) → no secret in dist/ or .marmeon/, the stylesheets linked (E202)', () => {
      pnpmApp.buildWithoutEnv();
      checkStyles(app, ['marmeon-layer', 'marmeon-failure', 'auth-header']);
      // The injection lists of the app (E138): the auth module's controllers take their services through the constructor.
      const injections = JSON.parse(readFileSync(join(app, '.marmeon/injections.json'), 'utf8')) as { files: Record<string, { insert: unknown[] }> };
      const listed = Object.entries(injections.files).filter(([name, entry]) => name.startsWith('modules/auth/') && entry.insert.length > 0);
      if (listed.length < 5) throw new SmokeError(`marmeon build precomputed the injection lists of ${listed.length} auth modules — expected the controllers.`);
    });
    await pnpmApp.step('marmeon start → GET /login 200 (CSP nonce, precompressed assets), GET / 200, private registration', () =>
      pnpmApp.serve('/login', async (base, output) => {
        await checkProductionHttp(base);
        await checkRegistration(true)(base, output);
      }),
    );
    await pnpmApp.step('marmeon start with AUTH_PRIVATE_REGISTRATION=false → "already registered", a boot warning (E193)', () =>
      pnpmApp.serve('/login', checkRegistration(false), { AUTH_PRIVATE_REGISTRATION: 'false' }),
    );
    const discovered = await pnpmApp.step('marmeon discover (pnpm, nothing hoisted)', () => discoveredPackages(pnpmApp.marmeon('discover')));
    // Production installs without the dev dependencies (E159): `marmeon` is a dependency, and the app starts without the rest.
    await pnpmApp.step('pnpm install --prod → node_modules/.bin/marmeon', () => {
      pnpmApp.run('pnpm', ['install', '--prod', ...pnpmFlags, '--reporter', 'append-only']);
      if (existsSync(join(app, 'node_modules/vitest'))) throw new SmokeError('pnpm install --prod left the dev dependency vitest in node_modules.');
      if (!existsSync(join(app, 'node_modules/.bin/marmeon'))) throw new SmokeError('pnpm install --prod has no node_modules/.bin/marmeon — marmeon must be a dependency of the app.');
    });
    await pnpmApp.step('marmeon start (production install) → GET /login 200', () => pnpmApp.serve('/login'));
    // ── The driver rule (E198) as an app meets it ──
    await pnpmApp.step('SMTP from the production install (nodemailer comes with @marmeon/mail, E198)', () => checkSmtp(pnpmApp));
    await pnpmApp.step('pnpm add @marmeon/redis @marmeon/storage (their tarballs — nothing else) → marmeon build', () => {
      const tarball = (name: string) => {
        const packed = tarballs.get(name);
        if (!packed) throw new SmokeError(`pnpm pack made no tarball for ${name}.`);
        return `./vendor/marmeon/${packed.tarball.split(sep).pop()}`;
      };
      pnpmApp.run('pnpm', ['add', tarball('@marmeon/redis'), tarball('@marmeon/storage'), ...pnpmFlags, '--reporter', 'append-only']);
      const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
      const drivers = Object.keys(manifest.dependencies).filter((name) => name === 'redis' || name.startsWith('@aws-sdk/'));
      if (drivers.length > 0) throw new SmokeError(`the kit's package.json lists ${drivers.join(', ')} — the driver step must show what @marmeon/redis brings by itself (E198).`);
      if (!manifest.dependencies['@marmeon/redis'] || !manifest.dependencies['@marmeon/storage']) throw new SmokeError('pnpm add did not add @marmeon/redis and @marmeon/storage.');
      // New packages, new injection lists: built as before a deploy (the start must not parse anything, E138).
      pnpmApp.buildWithoutEnv();
    });
    await pnpmApp.step('marmeon start with CACHE_DRIVER=redis SESSION_DRIVER=redis — redis came with @marmeon/redis (E198)', async () => {
      const prefix = `marmeon-smoke-${process.pid}-${Date.now()}:`;
      try {
        await pnpmApp.serve('/login', (base) => checkRedisDrivers(base, prefix), { CACHE_DRIVER: 'redis', SESSION_DRIVER: 'redis', REDIS_URL, REDIS_PREFIX: prefix });
      } finally {
        await redisCommand(REDIS_URL, ['EVAL', "for _, key in ipairs(redis.call('KEYS', ARGV[1])) do redis.call('DEL', key) end return 0", '0', `${prefix}*`]).catch(() => undefined);
      }
    });
    await pnpmApp.step('an S3 default disk without the AWS SDK → the start fails with the exact command (E198)', async () => {
      const bootstrap = join(app, 'bootstrap/app.ts');
      const original = readFileSync(bootstrap, 'utf8');
      if (!original.includes('config: [AppConfig],')) throw new SmokeError('bootstrap/app.ts of the kit has no "config: [AppConfig]," to add the storage configuration to.');
      writeFileSync(
        join(app, 'config/storage.ts'),
        "import { defineStorage } from '@marmeon/storage';\n\nexport const Storage = defineStorage({\n  default: 'files',\n  disks: { files: { driver: 's3', bucket: 'smoke' }, uploads: { driver: 'local', root: 'storage/app/uploads' } },\n});\n",
      );
      writeFileSync(bootstrap, `import { Storage } from '../config/storage.ts';\n${original.replace('config: [AppConfig],', 'config: [AppConfig, Storage],')}`);
      try {
        const { code, output } = await pnpmApp.startFailing();
        if (code === null) throw new SmokeError(`marmeon start came up with an S3 default disk and no AWS SDK — it should fail at the start:\n${output}`);
        if (code === 0 || !output.includes(S3_COMMAND)) throw new SmokeError(`marmeon start with an S3 default disk and no AWS SDK ended with ${code}, without "${S3_COMMAND}":\n${output}`);
      } finally {
        writeFileSync(bootstrap, original);
        rmSync(join(app, 'config/storage.ts'), { force: true });
      }
    });

    // ── A blank app with npm (E151: npm's flat node_modules) ──
    await npmApp.step('create-marmeon app-npm --minimal --npm --no-git (install, migrate)', () => {
      scaffold(bin, work, ['app-npm', '--minimal', '--npm', '--no-git'], { tarballs: tarballDir, env: installEnv });
      checkManifest(npmApp.app, 'npm');
      if (existsSync(join(npmApp.app, 'modules/auth')) || existsSync(join(npmApp.app, 'modules/home'))) throw new SmokeError('--minimal wrote the starter kit\'s modules.');
      if (!existsSync(join(npmApp.app, 'package-lock.json'))) throw new SmokeError('the npm app has no package-lock.json.');
    });
    await npmApp.step('marmeon build without .env (E187), the framework\'s stylesheet linked (E202)', () => {
      npmApp.buildWithoutEnv();
      checkStyles(npmApp.app, ['marmeon-layer']);
    });
    // The README's way on a developer's machine: `npm run build` next to the .env of .env.example (NODE_ENV=development, E170) —
    // the browser code must still be production's (W10 step 9b): no development branch, no devtools hook.
    await npmApp.step('npm run build with the development .env → a production client (no development branch in dist/client)', () => {
      if (!/^NODE_ENV=development$/m.test(readFileSync(join(npmApp.app, '.env'), 'utf8'))) throw new SmokeError('the app\'s .env has no NODE_ENV=development (from .env.example).');
      const output = npmApp.run('npm', ['run', 'build']);
      const leaked = developmentBranchesIn(join(npmApp.app, 'dist/client'));
      if (leaked.length > 0) throw new SmokeError(`npm run build with the development .env built a development client — ${leaked.join(', ')} carry __MARMEON_DEVTOOLS_HOOK__.`);
      if (!output.includes('marmeon build builds for production')) throw new SmokeError(`npm run build did not say that it builds for production:\n${output}`);
    });
    await npmApp.step('marmeon start → GET /up 200', () => npmApp.serve('/up'));
    const npmTests = await npmApp.step('vitest run', () => /Tests\s+(\d+) passed/.exec(npmApp.run(join(npmApp.app, 'node_modules/.bin/vitest'), ['run']))?.[1] ?? '?');
    // Discovery walks node_modules as Node resolves (E151): in npm's flat layout it finds every package pnpm's finds.
    await npmApp.step('marmeon discover (npm) finds what pnpm\'s finds', () => {
      // The same packages, and in them the same providers and injectable classes (a constructor's types resolve from the package's
      // own dependencies — another place where a lookup could assume pnpm's layout).
      const flat = discoveredPackages(npmApp.marmeon('discover'));
      const missing = discovered.names.filter((name) => !flat.names.includes(name));
      if (missing.length > 0 || flat.names.length !== discovered.names.length || flat.summary !== discovered.summary) {
        throw new SmokeError(
          `discovery in npm's node_modules found ${flat.summary} (${flat.names.join(', ')}), in pnpm's ${discovered.summary} — missing: ${missing.join(', ') || 'none'}`,
        );
      }
    });

    const total = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `pack:smoke: ${tarballs.size} tarballs outside the monorepo — create-marmeon: the starter kit with pnpm (${tests} tests, lint, build, start, production install, the drivers: SMTP, Redis, S3 without its SDK) and a blank app with npm (${npmTests} test, build, start, discovery as with pnpm: ${discovered.summary}): green (${total}s).`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Offline) {
      console.error(`pack:smoke: SKIPPED — the third-party packages could not be fetched (no store or cache, no network):\n${error.message.trim().split('\n').slice(-5).join('\n')}`);
      return SKIPPED;
    }
    keep = true;
    console.error(`pack:smoke: ${error instanceof SmokeError ? error.message : (error as Error).stack}`);
    return 1;
  } finally {
    pnpmApp.stopAll();
    npmApp.stopAll();
    if (keep) console.log(`pack:smoke: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

/** What `marmeon discover` found: the package names (one per line, indented), sorted, and its summary (packages, providers, classes). */
function discoveredPackages(output: string): { names: string[]; summary: string } {
  const names = output
    .split('\n')
    .filter((line) => /^\s+@?[\w./-]+$/.test(line))
    .map((line) => line.trim())
    .sort();
  const summary = /(\d+ packages, \d+ providers, \d+ injectable classes[^→]*)/.exec(output)?.[1]?.trim();
  if (!summary) throw new SmokeError(`marmeon discover printed no summary:\n${output}`);
  return { names, summary };
}

if (import.meta.main) process.exitCode = await main();
