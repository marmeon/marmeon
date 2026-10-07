/**
 * `pnpm image:smoke` — the app as an image (E158, E140, E141, E163): `create-marmeon app --docker` from the tarballs (as in
 * `pack:smoke`: outside the monorepo, the framework from its tarballs inside the app's `vendor/` — the build context) — the
 * starter kit with the files of `marmeon make:docker` — is built with Docker; then the container's life:
 *
 *   compose.production.yaml valid · docker build → runs as a user other than root · no .env* in the image (.env and
 *   .env.production are in the context) · migrate --force · start → GET /up 200, /login 200
 *   (sessions written to the storage volume) · the image's health check turns healthy · SIGTERM with SHUTDOWN_DELAY=1 →
 *   /up/ready 503 at once, exit 0 after the delay — all without `docker run --init`: tini is the image's PID 1 (E187) · tini reaps
 *   an orphaned process (no zombie) · a read-only root file system starts (E160) · start --workers=2 → SIGTERM → exit 0 · a worker
 *   with a stuck job ends the container with 70 · the image's size
 *
 * Then the docs' image (`scripts/docs-image.ts`, `pnpm docs:image` alone): `apps/docs/Dockerfile` built from this checkout, its
 * contents, the container read-only, and `deploy/docs/compose.yaml` behind Caddy over HTTP/2 (E142).
 *
 * Containers, the volume and the image are named `marmeon-image-smoke-…` and removed afterwards (Docker's build cache
 * stays — the next build reuses the dependency layers). Without Docker, or when the build cannot reach the registry, the run
 * ends with exit 75 — `pnpm run ci` shows it as skipped, never as green.
 *
 *   pnpm image:smoke          # packs the current dist/ (pnpm build first; pnpm run ci does)
 *   pnpm image:smoke --keep   # leaves the app, the image and the volume (printed) — a red run keeps its app only with --keep
 *   pnpm image:smoke --npm    # create-marmeon --npm (package-lock.json) — make:docker writes the npm variant (without the docs)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertReapsOrphans, docsImage } from './docs-image.ts';
import { packAll } from './packages.ts';
import { assertIsolated, cleanEnvironment, freePort, Offline, OFFLINE, scaffold, SKIPPED, SmokeError, unpackScaffolder } from './pack-smoke.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Docker's own words for a registry it cannot reach (the build pulls node:26-slim and the app's dependencies). */
const DOCKER_OFFLINE = /failed to resolve source metadata|failed to do request|dial tcp|i\/o timeout|TLS handshake timeout|no such host|ERR_PNPM_META_FETCH_FAIL|EAI_AGAIN|ENOTFOUND/;

class Docker {
  readonly env = cleanEnvironment();
  readonly containers = new Set<string>();

  /** Runs `docker …`; its output on failure only — unless `expect` names another exit code. */
  run(args: string[], { expect = 0, input }: { expect?: number | 'any'; input?: string } = {}): { code: number; output: string } {
    const result = spawnSync('docker', args, { env: this.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, timeout: 15 * 60_000 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const code = result.status ?? 1;
    if (expect !== 'any' && code !== expect) throw new SmokeError(`docker ${args.join(' ')} exited with ${code} (expected ${expect}):\n${output}`);
    return { code, output };
  }

  /** `docker run -d …` — remembered, so it is removed at the end. */
  detached(name: string, args: string[]): string {
    this.containers.add(name);
    this.run(['run', '-d', '--name', name, ...args]);
    return name;
  }

  remove(name: string): void {
    spawnSync('docker', ['rm', '-f', '-v', name], { env: this.env, stdio: 'ignore' });
    this.containers.delete(name);
  }
}

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms = 30_000, logs?: () => string): Promise<T> {
  const deadline = Date.now() + ms;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      if (error instanceof SmokeError) throw error;
      last = (error as Error).message;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new SmokeError(`${what} did not happen within ${ms / 1000} s${last ? ` (last: ${last})` : ''}${logs ? `:\n${logs()}` : ''}`);
}

async function status(url: string): Promise<number | undefined> {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
  await response.body?.cancel();
  return response.status;
}

/** A job that never ends (timeout 1 s): the worker gives up on it after --stop-timeout and exits with 70 (E83). */
function addStuckJob(app: string): void {
  mkdirSync(join(app, 'modules/smoke/jobs'), { recursive: true });
  writeFileSync(
    join(app, 'modules/smoke/jobs/StuckJob.ts'),
    [
      "import { rules as r } from '@marmeon/validation';",
      '',
      '/** Written by scripts/image-smoke.ts: a job that never ends — its worker must exit with 70 after the timeout. */',
      'export class StuckJob {',
      "  static readonly job = 'smoke.stuck';",
      '  static readonly schema = r.object({});',
      '  static readonly timeout = 1;',
      '  static readonly tries = 1;',
      '',
      '  handle(): Promise<void> {',
      '    return new Promise(() => {});',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(app, 'modules/smoke/index.ts'),
    "import { defineModule } from '@marmeon/core';\nimport { StuckJob } from './jobs/StuckJob.ts';\n\nexport default defineModule({ name: 'smoke', jobs: [StuckJob] });\n",
  );
  const file = join(app, 'bootstrap/app.ts');
  const source = readFileSync(file, 'utf8');
  const modules = /modules: \[([^\]]*)\]/.exec(source);
  if (!modules || !source.includes("import system from '#modules/system';")) throw new SmokeError('bootstrap/app.ts of the new app has no `modules: [...]` and system import to add the smoke module to.');
  writeFileSync(file, source.replace("import system from '#modules/system';", "import system from '#modules/system';\nimport smoke from '#modules/smoke';").replace(modules[0], `modules: [${modules[1]}, smoke]`));
}

/** Inserts the stuck job into the queue's table — with Node's own SQLite, inside the image (no tool on the host needed). */
const INSERT_STUCK_JOB = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('storage/database.sqlite');
const now = Date.now();
const payload = JSON.stringify({ uuid: crypto.randomUUID(), job: 'smoke.stuck', data: {}, tries: 1, backoff: [], dispatchedAt: now });
db.prepare('insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at) values (?, ?, 0, null, ?, ?)').run('default', payload, now, now);
`;

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { keep: { type: 'boolean' }, npm: { type: 'boolean' } } });
  const npm = values.npm === true;
  const started = performance.now();
  const docker = new Docker();
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env: docker.env, encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(`image: SKIPPED — Docker is not available here (docker info: ${(probe.stderr || probe.error?.message || '').trim().split('\n')[0]}).`);
    return SKIPPED;
  }
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const image = `marmeon-image-smoke:${id}`;
  const volume = `marmeon-image-smoke-${id}`;
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'marmeon-image-smoke-')));
  const app = join(work, 'app');
  const key = `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`;
  // The app with its node_modules is kept only when asked — a red run says how to keep it (E187: red runs piled up in $TMPDIR).
  const keep = values.keep === true;
  let built = false;
  const step = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
    const begin = performance.now();
    process.stdout.write(`image: ${name} … `);
    try {
      const result = await work();
      console.log(`${((performance.now() - begin) / 1000).toFixed(1)}s`);
      return result;
    } catch (error) {
      console.log('✗');
      throw error;
    }
  };
  const logs = (name: string) => () => docker.run(['logs', name], { expect: 'any' }).output;
  const common = ['-e', `APP_KEY=${key}`, '-e', 'APP_NAME=Smoke', '-e', 'APP_URL=http://localhost', '-e', 'MAIL_MAILER=array', '-v', `${volume}:/app/storage`];

  try {
    assertIsolated(app);
    await step(`create-marmeon app --docker${npm ? ' --npm' : ''} --no-git (the starter kit: install, make:auth, migrate, make:docker) + a stuck job`, () => {
      const tarballs = join(work, 'tarballs');
      const bin = unpackScaffolder(new Map(packAll(root, tarballs).map((tarball) => [tarball.name, tarball])), join(work, 'create-marmeon'));
      // The tarballs end up inside the app (vendor/marmeon/): the Docker build sees only its context, and the Dockerfile copies them first.
      const output = scaffold(bin, work, ['app', '--yes', '--docker', '--no-git', ...(npm ? ['--npm'] : [])], {
        tarballs,
        env: npm ? { npm_config_prefer_offline: 'true' } : { pnpm_config_prefer_offline: 'true' },
      });
      if (!output.includes('marmeon make:docker')) throw new SmokeError(`create-marmeon wrote no Docker files:\n${output}`);
      // A .env in the context (the scaffolder wrote it) — the image must not get it; the server's configuration next to the compose
      // file — in the build context too, so the image must keep it out as well.
      writeFileSync(join(app, '.env.production'), `APP_KEY=${key}\nAPP_NAME=Smoke\nAPP_URL=https://smoke.example\n`);
      const config = spawnSync('docker', ['compose', '-f', 'compose.production.yaml', 'config', '-q'], { cwd: app, env: docker.env, encoding: 'utf8' });
      if (config.status !== 0) throw new SmokeError(`docker compose config rejects compose.production.yaml:\n${config.stderr}`);
      const written = readFileSync(join(app, 'Dockerfile'), 'utf8');
      if (written.includes('npm ci') !== npm) throw new SmokeError(`make:docker did not write the ${npm ? 'npm' : 'pnpm'} variant:\n${written}`);
      if (!/^COPY vendor\S* \.\/vendor/m.test(written)) throw new SmokeError(`the Dockerfile does not copy the vendored tarballs before the install:\n${written}`);
      addStuckJob(app);
    });
    const buildSeconds = await step(`docker build -t ${image}`, () => {
      const begin = performance.now();
      const result = spawnSync('docker', ['build', '--progress=plain', '-t', image, '.'], { cwd: app, env: { ...docker.env, DOCKER_BUILDKIT: '1' }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (result.status !== 0) throw DOCKER_OFFLINE.test(output) || OFFLINE.test(output) ? new Offline(output) : new SmokeError(`docker build failed (exit ${result.status}):\n${output.split('\n').slice(-80).join('\n')}`);
      built = true;
      return (performance.now() - begin) / 1000;
    });
    await step('runs as a user other than root, no .env* and no dev dependency in the image', () => {
      const uid = docker.run(['run', '--rm', '--entrypoint', 'id', image, '-u']).output.trim();
      if (uid === '0' || !/^\d+$/.test(uid)) throw new SmokeError(`the container runs as uid ${uid} — the Dockerfile must switch to USER node.`);
      const listed = docker.run(['run', '--rm', '--entrypoint', 'node', image, '-e', "console.log(require('fs').readdirSync('.').join('\\n'))"]).output.split('\n');
      const leaked = listed.filter((file) => file.startsWith('.env'));
      if (leaked.length > 0) throw new SmokeError(`the image contains ${leaked.join(', ')} — .dockerignore must keep every .env* out.`);
      if (!listed.includes('dist') || !listed.includes('.marmeon')) throw new SmokeError(`the image has no build (dist/, .marmeon/): ${listed.join(' ')}`);
      // Production dependencies only (E159): the dev dependencies of the build stage are not in the image, not even unlinked.
      const store = docker.run(['run', '--rm', '--entrypoint', 'node', image, '-e', "const fs = require('fs'); console.log([...(fs.existsSync('node_modules/.pnpm') ? fs.readdirSync('node_modules/.pnpm') : []), ...fs.readdirSync('node_modules')].join('\\n'))"]).output.split('\n');
      // npm keeps the optional peers of production packages that a dev dependency brought (vite, typescript, @vitejs) — only what
      // nothing in production names may be missing there; pnpm leaves out all of them.
      const dev = store.filter((entry) => (npm ? /^(vitest|oxlint)(@|$|\+)/ : /^(vitest|vite|typescript|@vitejs|oxlint)(@|$|\+)/).test(entry));
      if (dev.length > 0) throw new SmokeError(`the image carries dev dependencies: ${dev.join(', ')}`);
    });
    await step('marmeon migrate --force (into the storage volume)', () => docker.run(['run', '--rm', ...common, image, 'migrate', '--force']));
    await step('start → /up 200, /login 200, healthy; SIGTERM (SHUTDOWN_DELAY=1) → /up/ready 503, exit 0', async () => {
      const port = await freePort();
      const name = docker.detached(`marmeon-image-smoke-${id}-web`, ['-p', `127.0.0.1:${port}:3000`, '-e', 'SHUTDOWN_DELAY=1', '--health-interval=1s', '--health-start-period=1s', ...common, image]);
      const base = `http://127.0.0.1:${port}`;
      await until('GET /up 200', async () => ((await status(`${base}/up`)) === 200 ? true : undefined), 30_000, logs(name));
      if ((await status(`${base}/login`)) !== 200) throw new SmokeError(`GET /login did not answer 200:\n${logs(name)()}`);
      const uid = docker.run(['exec', name, 'id', '-u']).output.trim();
      if (uid === '0') throw new SmokeError('the server runs as root.');
      await until('the health check turning healthy', () => (docker.run(['inspect', '-f', '{{.State.Health.Status}}', name]).output.trim() === 'healthy' ? true : undefined), 30_000, logs(name));
      const signalled = performance.now();
      docker.run(['kill', '--signal', 'SIGTERM', name]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const ready = await status(`${base}/up/ready`);
      if (ready !== 503) throw new SmokeError(`GET /up/ready answered ${ready} right after SIGTERM — SHUTDOWN_DELAY should take it out of readiness at once.`);
      if ((await status(`${base}/login`)) !== 200) throw new SmokeError('GET /login was not answered during SHUTDOWN_DELAY.');
      const code = docker.run(['wait', name]).output.trim();
      const seconds = (performance.now() - signalled) / 1000;
      if (code !== '0') throw new SmokeError(`the web container ended with ${code} after SIGTERM:\n${logs(name)()}`);
      if (seconds < 1) throw new SmokeError(`the web container ended ${seconds.toFixed(2)} s after SIGTERM — before SHUTDOWN_DELAY=1.`);
      if (!logs(name)().includes('SIGTERM received, shutting down')) throw new SmokeError(`no drain in the log:\n${logs(name)()}`);
      docker.remove(name);
    });
    await step('tini is PID 1 and reaps an orphaned process (no <defunct>)', async () => {
      const port = await freePort();
      const name = docker.detached(`marmeon-image-smoke-${id}-orphans`, ['-p', `127.0.0.1:${port}:3000`, ...common, image]);
      await until('GET /up 200', async () => ((await status(`http://127.0.0.1:${port}/up`)) === 200 ? true : undefined), 30_000, logs(name));
      await assertReapsOrphans((args) => docker.run(args), name);
      docker.remove(name);
    });
    await step('read-only root file system → /up 200, exit 0', async () => {
      const port = await freePort();
      const name = docker.detached(`marmeon-image-smoke-${id}-readonly`, ['--read-only', '--tmpfs', '/tmp', '-p', `127.0.0.1:${port}:3000`, ...common, image]);
      await until('GET /up 200 (read-only)', async () => ((await status(`http://127.0.0.1:${port}/login`)) === 200 ? true : undefined), 30_000, logs(name));
      docker.run(['kill', '--signal', 'SIGTERM', name]);
      const code = docker.run(['wait', name]).output.trim();
      const output = logs(name)();
      if (code !== '0') throw new SmokeError(`the read-only container ended with ${code}:\n${output}`);
      if (/EROFS|EACCES|read-only|stale|missing/i.test(output)) throw new SmokeError(`the read-only start complained:\n${output}`);
      docker.remove(name);
    });
    await step('start --workers=2 → /up 200; SIGTERM → both drain, exit 0', async () => {
      const port = await freePort();
      const name = docker.detached(`marmeon-image-smoke-${id}-cluster`, ['-p', `127.0.0.1:${port}:3000`, ...common, image, 'start', '--workers=2']);
      await until('two workers listening', () => (logs(name)().split('Marmeon in production').length - 1 >= 2 ? true : undefined), 30_000, logs(name));
      if ((await status(`http://127.0.0.1:${port}/up`)) !== 200) throw new SmokeError(`GET /up did not answer 200:\n${logs(name)()}`);
      docker.run(['kill', '--signal', 'SIGTERM', name]);
      const code = docker.run(['wait', name]).output.trim();
      const output = logs(name)();
      if (code !== '0') throw new SmokeError(`the cluster ended with ${code}:\n${output}`);
      if (output.split('SIGTERM received, shutting down').length - 1 !== 2) throw new SmokeError(`not both workers drained:\n${output}`);
      docker.remove(name);
    });
    await step('a worker with a stuck job → container exit 70', () => {
      docker.run(['run', '--rm', ...common, '--entrypoint', 'node', image, '-e', INSERT_STUCK_JOB]);
      const name = `marmeon-image-smoke-${id}-worker`;
      docker.containers.add(name);
      const { code, output } = docker.run(['run', '--name', name, ...common, image, 'queue:work', '--stop-timeout=1'], { expect: 'any' });
      if (code !== 70) throw new SmokeError(`the worker container ended with ${code}, expected 70 (a stuck job):\n${output}`);
      docker.remove(name);
    });
    const size = Number(docker.run(['image', 'inspect', '-f', '{{.Size}}', image]).output.trim());
    const modules = docker.run(['run', '--rm', '--entrypoint', 'du', image, '-sm', 'node_modules']).output.trim().split(/\s+/)[0];
    const total = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `image: ${image} — ${(size / 1024 / 1024).toFixed(0)} MB (node_modules ${modules} MB), built in ${buildSeconds.toFixed(1)}s; non-root, no .env, /up, /login, healthy, SHUTDOWN_DELAY, tini reaps, read-only, --workers=2, exit 70: green (${total}s).`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Offline) {
      console.error(`image: SKIPPED — the build could not reach the registry:\n${error.message.trim().split('\n').slice(-5).join('\n')}`);
      return SKIPPED;
    }
    console.error(`image: ${error instanceof SmokeError ? error.message : (error as Error).stack}`);
    if (!keep) console.error(`image: removing ${work} — run pnpm image:smoke --keep to keep the app of a red run`);
    return 1;
  } finally {
    for (const name of [...docker.containers]) docker.remove(name);
    if (values.keep !== true) {
      spawnSync('docker', ['volume', 'rm', '-f', volume], { env: docker.env, stdio: 'ignore' });
      if (built) spawnSync('docker', ['image', 'rm', '-f', image], { env: docker.env, stdio: 'ignore' });
    } else console.log(`image: kept ${image} and the volume ${volume}`);
    if (keep) console.log(`image: kept ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const app = await main();
  // Then the docs' image (E142, scripts/docs-image.ts — alone: pnpm docs:image); not with --npm, the manual variant of the app.
  const docs = process.argv.includes('--npm') ? 0 : await docsImage({ keep: process.argv.includes('--keep') });
  process.exitCode = app !== 0 && app !== SKIPPED ? app : docs !== 0 && docs !== SKIPPED ? docs : app === SKIPPED || docs === SKIPPED ? SKIPPED : 0;
}

