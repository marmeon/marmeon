/**
 * `pnpm website:image` — the docs as the image they are deployed with (the `image` part of `pnpm run ci`, after the starter kit's
 * image): `apps/website/Dockerfile` built from this checkout, then checked as an image (non-root, no `.env*`, tests or dev
 * dependencies, tini is PID 1), as a container (read-only root, `/up` 200, every page 200 without Set-Cookie, healthy, SIGTERM →
 * exit 0) and behind Caddy (`deploy/website/compose.yaml`: HTTP/2, HSTS, forwarded headers trusted, 304 on a revalidation).
 *
 * Image `marmeon-website:smoke-…`, Compose project `marmeon-website-smoke-…`: both and the volumes are removed afterwards. Without
 * Docker, or when the build cannot reach the registry: exit 75 — skipped, never green.
 *
 *   pnpm website:image           # build, check, remove
 *   pnpm website:image --keep    # leaves the image (printed)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import docsConfig from '../apps/website/docs.config.ts';
import { cleanEnvironment, freePort, Offline, OFFLINE, SKIPPED, SmokeError } from './pack-smoke.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const DOCKER_OFFLINE = /failed to resolve source metadata|failed to do request|dial tcp|i\/o timeout|TLS handshake timeout|no such host|ERR_PNPM_META_FETCH_FAIL|EAI_AGAIN|ENOTFOUND/;
/** The docs' policy in production (apps/website SiteServiceProvider, SITE_CSP). */
const POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'";
/** Never in the image: what only builds or tests the docs. */
const DEV_PACKAGES = /^(vite|vitest|typescript|@vitejs\+|oxlint|@oxlint\+|@marmeon\+(devtools|testing|vite))(@|$)/;

const env = cleanEnvironment();

function docker(args: string[], { expect = 0, cwd = root, extraEnv = {} }: { expect?: number | 'any'; cwd?: string; extraEnv?: NodeJS.ProcessEnv } = {}): { code: number; output: string } {
  const result = spawnSync('docker', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60_000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const code = result.status ?? 1;
  if (expect !== 'any' && code !== expect) {
    if (DOCKER_OFFLINE.test(output) || OFFLINE.test(output)) throw new Offline(output);
    throw new SmokeError(`docker ${args.join(' ')} exited with ${code} (expected ${expect}):\n${output.split('\n').slice(-60).join('\n')}`);
  }
  return { code, output };
}

async function until<T>(what: string, check: () => Promise<T | undefined> | T | undefined, ms: number, logs?: () => string): Promise<T> {
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new SmokeError(`${what} did not happen within ${ms / 1000} s${last ? ` (last: ${last})` : ''}${logs ? `:\n${logs()}` : ''}`);
}

/** The docs' pages in the order of their sections. */
const entries = () => docsConfig.sections.flatMap((section) => section.pages);

/** Every page of the website: the landing, the docs' start page and the sections' pages. */
export function docsPages(): string[] {
  return ['/', '/docs', ...entries().map((entry) => `/docs/${entry.slug}`)];
}

/** Lists, inside the image, what must not be there (printed as JSON by Node — the image has no find). */
const INSPECT = `
const fs = require('fs'), path = require('path');
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (p !== 'node_modules') walk(p, out); } else out.push(p); } return out; };
const app = walk('.');
const store = fs.readdirSync('node_modules/.pnpm');
const framework = store.filter((e) => e.startsWith('@marmeon+')).flatMap((e) => { const dir = path.join('node_modules/.pnpm', e, 'node_modules/@marmeon'); return fs.readdirSync(dir).map((n) => path.join(dir, n)); });
const frameworkFiles = framework.flatMap((dir) => walk(dir));
console.log(JSON.stringify({
  top: fs.readdirSync('.').sort(),
  env: [...app, ...frameworkFiles].filter((f) => /(^|\\/)\\.env/.test(f)),
  tests: [...app, ...frameworkFiles].filter((f) => /\\.(test|type-test)\\.tsx?$|__fixtures__/.test(f)),
  store,
  content: app.filter((f) => f.startsWith('content/')).sort(),
}));
`;

interface Inspection {
  top: string[];
  env: string[];
  tests: string[];
  store: string[];
  content: string[];
}

/** Lists the zombies of a container from inside it (state `Z` in /proc/<pid>/stat) — the image has no `ps`. */
const ZOMBIES = `const fs = require('fs'); const found = [];
for (const pid of fs.readdirSync('/proc')) {
  if (!/^\\d+$/.test(pid)) continue;
  try { const stat = /^\\d+ \\((.*)\\) (\\S)/.exec(fs.readFileSync('/proc/' + pid + '/stat', 'utf8')); if (stat && stat[2] === 'Z') found.push(pid + ' ' + stat[1]); } catch {}
}
console.log(JSON.stringify(found));`;

/**
 * tini is PID 1 and reaps an orphan: a process whose parent ended is handed to PID 1 — `sh -c 'sleep … &'` through
 * `docker exec` leaves one. Node as PID 1 never waits for it: it stays a zombie (`<defunct>`) until the container ends.
 */
export async function assertReapsOrphans(run: (args: string[]) => { output: string }, container: string): Promise<void> {
  const init = run(['exec', container, 'cat', '/proc/1/comm']).output.trim();
  run(['exec', container, 'sh', '-c', 'sleep 0.2 >/dev/null 2>&1 & exit 0']);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const zombies = JSON.parse(run(['exec', container, 'node', '-e', ZOMBIES]).output.trim().split('\n').at(-1)!) as string[];
  if (zombies.length > 0) throw new SmokeError(`an orphaned process stayed a zombie (<defunct>: ${zombies.join(', ')}) — PID 1 is "${init}", which reaps none; the image must run marmeon under tini.`);
  if (init !== 'tini') throw new SmokeError(`PID 1 of the container is "${init}", not tini.`);
}

/** The files the image must not have and the ones it must — `problems` empty when all is well. */
export function inspectionProblems(found: Inspection, repository = root): string[] {
  const problems: string[] = [];
  const expected = ['.marmeon', 'README.md', 'bootstrap', 'config', 'content', 'dist', 'docs.config.ts', 'index.html', 'layouts', 'modules', 'node_modules', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'storage', 'styles'];
  const extra = found.top.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !found.top.includes(name));
  if (extra.length > 0) problems.push(`/app has what the docs do not run on: ${extra.join(', ')} (apps/website "files", the Dockerfile's copies)`);
  if (missing.length > 0) problems.push(`/app lacks ${missing.join(', ')}`);
  if (found.env.length > 0) problems.push(`.env files in the image: ${found.env.join(', ')} (Dockerfile.dockerignore, apps/website "files")`);
  if (found.tests.length > 0) problems.push(`tests in the image: ${found.tests.slice(0, 8).join(', ')}${found.tests.length > 8 ? ` … (${found.tests.length})` : ''}`);
  const dev = found.store.filter((entry) => DEV_PACKAGES.test(entry));
  if (dev.length > 0) problems.push(`dev dependencies in the image: ${dev.join(', ')} (pnpm deploy --prod)`);
  const pages = entries().map((entry) => `content/${entry.file ?? `docs/${entry.slug}.md`}`);
  const absent = pages.filter((file) => !found.content.includes(file));
  if (absent.length > 0) problems.push(`/app/content lacks ${absent.slice(0, 8).join(', ')}`);
  // Only the pages: docs/*.md and the policies at the root — no package's README or manifest (they are no pages).
  const others = found.content.filter((file) => !pages.includes(file) && !/^content\/docs\/[^/]+\.md$/.test(file));
  if (others.length > 0) problems.push(`/app/content has what is no page: ${others.slice(0, 8).join(', ')}${others.length > 8 ? ` … (${others.length})` : ''}`);
  const docs = readdirSync(join(repository, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `content/docs/${name}`);
  const unshipped = docs.filter((file) => !found.content.includes(file));
  if (unshipped.length > 0) problems.push(`/app/content lacks ${unshipped.join(', ')}`);
  return problems;
}

/** `curl` against Caddy (HTTP/2 needs it — Node's fetch speaks HTTP/1.1): status line, headers and the body's length. */
function curl(url: string, headers: Record<string, string> = {}): { version: string; status: number; headers: Map<string, string>; length: number } {
  const args = ['-sk', '--http2', '-D', '-', '-o', '/dev/null', '-w', '%{size_download}', ...Object.entries(headers).flatMap(([name, value]) => ['-H', `${name}: ${value}`]), url];
  const result = spawnSync('curl', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`curl ${url} exited with ${result.status}: ${result.stderr}`);
  const text = result.stdout;
  const blocks = text.split(/\r?\n\r?\n/);
  const head = blocks[0]!.split(/\r?\n/);
  const [version = '', status = '0'] = head[0]!.split(' ');
  const map = new Map<string, string>();
  for (const line of head.slice(1)) {
    const at = line.indexOf(':');
    if (at > 0) {
      const name = line.slice(0, at).toLowerCase();
      map.set(name, map.has(name) ? `${map.get(name)}, ${line.slice(at + 1).trim()}` : line.slice(at + 1).trim());
    }
  }
  return { version, status: Number(status), headers: map, length: Number(blocks.at(-1)) };
}

export async function websiteImage({ keep = false }: { keep?: boolean } = {}): Promise<number> {
  const started = performance.now();
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env, encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(`docs image: SKIPPED — Docker is not available here (docker info: ${(probe.stderr || probe.error?.message || '').trim().split('\n')[0]}).`);
    return SKIPPED;
  }
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const tag = `smoke-${id}`;
  const image = `marmeon-website:${tag}`;
  const volume = `marmeon-website-smoke-${id}`;
  const project = `marmeon-website-smoke-${id}`;
  const work = mkdtempSync(join(tmpdir(), 'marmeon-website-image-'));
  const containers = new Set<string>();
  const key = `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`;
  let built = false;
  let composed = false;
  // WEBSITE_DOMAIN=localhost: Caddy signs with its own CA; the port Caddy listens on is moved to a free one (compose.smoke.yaml).
  const composeEnv: Record<string, string> = { APP_KEY: key, WEBSITE_DOMAIN: 'localhost', WEBSITE_TAG: tag, SMOKE_PORT: String(await freePort()) };
  const compose = (args: string[], expect: number | 'any' = 0) =>
    docker(['compose', '-p', project, '-f', 'compose.yaml', '-f', join(work, 'compose.smoke.yaml'), ...args], { cwd: join(root, 'deploy/website'), extraEnv: composeEnv, expect });
  const step = async <T>(name: string, run: () => Promise<T> | T): Promise<T> => {
    const begin = performance.now();
    process.stdout.write(`docs image: ${name} … `);
    try {
      const result = await run();
      console.log(`${((performance.now() - begin) / 1000).toFixed(1)}s`);
      return result;
    } catch (error) {
      console.log('✗');
      throw error;
    }
  };
  const logs = (name: string) => () => docker(['logs', name], { expect: 'any' }).output;

  try {
    await step('deploy/website/compose.yaml valid', () => {
      writeFileSync(join(work, 'compose.smoke.yaml'), "services:\n  caddy:\n    ports: !override\n      - '127.0.0.1:${SMOKE_PORT}:443'\n");
      compose(['config', '-q']);
    });
    const buildSeconds = await step(`docker build -f apps/website/Dockerfile -t ${image} .`, () => {
      const begin = performance.now();
      docker(['build', '--progress=plain', '-f', 'apps/website/Dockerfile', '-t', image, '.'], { extraEnv: { DOCKER_BUILDKIT: '1' } });
      built = true;
      return (performance.now() - begin) / 1000;
    });
    await step('non-root; no .env, no test, no other app, no dev dependency; every page in content/; route:types --check without a key (dist/)', () => {
      const uid = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']).output.trim();
      if (uid === '0' || !/^\d+$/.test(uid)) throw new SmokeError(`the container runs as uid ${uid} — the Dockerfile must switch to USER node.`);
      const found = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', image, '-e', INSPECT]).output.trim().split('\n').at(-1)!) as Inspection;
      const problems = inspectionProblems(found);
      if (problems.length > 0) throw new SmokeError(`the image:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      // A command besides start in the pnpm deploy copy: the framework's manifests keep the workspace's source condition —
      // marmeon must not take the copy for the monorepo, or Node refuses the TypeScript under node_modules. No APP_KEY given:
      // route:types registers the app without booting it (the build phase).
      const types = docker(['run', '--rm', '-e', 'NODE_ENV=production', image, 'route:types', '--check'], { expect: 'any' });
      if (types.code !== 0) throw new SmokeError(`marmeon route:types --check in the image ended with ${types.code}:\n${types.output}`);
    });
    await step('read-only root, the storage volume → /up, every page 200 without Set-Cookie, the static policy, healthy, a quiet log; SIGTERM → exit 0', async () => {
      const port = await freePort();
      const name = `marmeon-website-smoke-${id}-docs`;
      containers.add(name);
      docker(['run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '-p', `127.0.0.1:${port}:3000`, '-e', `APP_KEY=${key}`, '-e', `APP_URL=http://127.0.0.1:${port}`, '-v', `${volume}:/app/storage`, '--health-interval=1s', '--health-start-period=1s', image]);
      const base = `http://127.0.0.1:${port}`;
      await until('GET /up 200', async () => ((await fetch(`${base}/up`, { signal: AbortSignal.timeout(2_000) })).status === 200 ? true : undefined), 60_000, logs(name));
      const problems: string[] = [];
      for (const path of docsPages()) {
        const response = await fetch(base + path, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        if (response.status !== 200) problems.push(`${path}: ${response.status}`);
        if (response.headers.has('set-cookie')) problems.push(`${path}: Set-Cookie ${response.headers.get('set-cookie')}`);
        if (response.headers.get('content-security-policy') !== POLICY) problems.push(`${path}: Content-Security-Policy "${response.headers.get('content-security-policy')}"`);
        if (response.headers.get('x-content-type-options') !== 'nosniff') problems.push(`${path}: no X-Content-Type-Options: nosniff`);
        if (!body.includes('</h1>')) problems.push(`${path}: not rendered on the server`);
      }
      if (problems.length > 0) throw new SmokeError(`the docs in the container:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      await until('the health check turning healthy', () => (docker(['inspect', '-f', '{{.State.Health.Status}}', name]).output.trim() === 'healthy' ? true : undefined), 30_000, logs(name));
      await assertReapsOrphans(docker, name);
      docker(['kill', '--signal', 'SIGTERM', name]);
      const code = docker(['wait', name]).output.trim();
      const output = logs(name)();
      if (code !== '0') throw new SmokeError(`the docs container ended with ${code} after SIGTERM:\n${output}`);
      // pino levels: 40 warn, 50 error — a read-only start that wanted to write (a stale manifest) warns.
      const loud = output.split('\n').filter((line) => /"level":(4|5|6)0/.test(line) || /EROFS|EACCES/.test(line));
      if (loud.length > 0) throw new SmokeError(`the docs container warned:\n${loud.join('\n')}`);
      docker(['rm', '-f', '-v', name]);
      containers.delete(name);
    });
    await step('behind Caddy (deploy/website/compose.yaml): HTTP/2, no Set-Cookie, HSTS, X-Forwarded-* trusted, compressed documents with 304', async () => {
      const port = Number(composeEnv.SMOKE_PORT);
      composed = true;
      compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90']);
      const base = `https://localhost:${port}`;
      await until('Caddy answering over HTTPS', () => (curl(`${base}/up`).status === 200 ? true : undefined), 60_000, () => compose(['logs'], 'any').output);
      const problems: string[] = [];
      for (const path of ['/', '/docs', '/docs/installation', '/docs/session']) {
        const page = curl(base + path, { accept: 'text/html' });
        if (page.version !== 'HTTP/2' || page.status !== 200) problems.push(`${path}: ${page.version} ${page.status}, expected HTTP/2 200`);
        if (page.headers.has('set-cookie')) problems.push(`${path}: Set-Cookie behind Caddy: ${page.headers.get('set-cookie')}`);
        if (!page.headers.get('strict-transport-security')?.startsWith('max-age=')) problems.push(`${path}: no Strict-Transport-Security`);
        if (page.headers.get('content-security-policy') !== POLICY) problems.push(`${path}: Content-Security-Policy "${page.headers.get('content-security-policy')}"`);
      }
      // An old client's visit: the docs build the reload URL from what Caddy forwarded — trusted, it is Caddy's https address.
      const stale = curl(`${base}/docs/deployment`, { 'x-marmeon': 'true', 'x-marmeon-version': 'stale', accept: 'text/html, application/json' });
      if (stale.status !== 409 || stale.headers.get('x-marmeon-location') !== `${base}/docs/deployment`) {
        problems.push(`an old client's visit: ${stale.status}, x-marmeon-location "${stale.headers.get('x-marmeon-location')}" — expected 409 and ${base}/docs/deployment (TRUSTED_PROXIES)`);
      }
      const compressed = curl(`${base}/docs/validation`, { accept: 'text/html', 'accept-encoding': 'zstd, gzip' });
      const plain = curl(`${base}/docs/validation`, { accept: 'text/html' });
      if (!/zstd|gzip/.test(compressed.headers.get('content-encoding') ?? '') || compressed.length >= plain.length / 2) {
        problems.push(`/docs/validation: Content-Encoding "${compressed.headers.get('content-encoding')}", ${compressed.length} of ${plain.length} bytes`);
      }
      const etag = compressed.headers.get('etag');
      const again = etag ? curl(`${base}/docs/validation`, { accept: 'text/html', 'accept-encoding': 'zstd, gzip', 'if-none-match': etag }) : undefined;
      if (again?.status !== 304) problems.push(`/docs/validation revalidated with ${etag}: ${again?.status}, expected 304`);
      if (problems.length > 0) throw new SmokeError(`behind Caddy:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n${compose(['logs', '--tail', '40'], 'any').output}`);
    });
    const size = Number(docker(['image', 'inspect', '-f', '{{.Size}}', image]).output.trim());
    const modules = docker(['run', '--rm', '--entrypoint', 'du', image, '-sm', 'node_modules']).output.trim().split(/\s+/)[0];
    console.log(
      `docs image: ${image} — ${(size / 1024 / 1024).toFixed(0)} MB (node_modules ${modules} MB), built in ${buildSeconds.toFixed(1)}s; ${docsPages().length} pages, read-only, behind Caddy over HTTP/2: green (${((performance.now() - started) / 1000).toFixed(1)}s).`,
    );
    return 0;
  } catch (error) {
    if (error instanceof Offline) {
      console.error(`docs image: SKIPPED — the build could not reach the registry:\n${error.message.trim().split('\n').slice(-5).join('\n')}`);
      return SKIPPED;
    }
    console.error(`docs image: ${error instanceof SmokeError ? error.message : (error as Error).stack}`);
    return 1;
  } finally {
    if (composed) compose(['down', '-v', '--remove-orphans'], 'any');
    for (const name of containers) docker(['rm', '-f', '-v', name], { expect: 'any' });
    docker(['volume', 'rm', '-f', volume], { expect: 'any' });
    if (built && !keep) docker(['image', 'rm', '-f', image], { expect: 'any' });
    else if (built) console.log(`docs image: kept ${image}`);
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { keep: { type: 'boolean' } } });
  process.exitCode = await websiteImage({ keep: values.keep === true });
}
