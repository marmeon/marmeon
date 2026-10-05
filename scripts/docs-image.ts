/**
 * `pnpm docs:image` — the docs as the image they are deployed with (E142, E160; part of the `image` part of `pnpm run ci`, after the
 * starter kit's image): `apps/docs/Dockerfile` built from this checkout, then
 *
 *   the image: runs as a user other than root · no .env*, no test, no other app's code, no config of the build (vite, vitest,
 *   tsconfig) · no dev dependency · the framework's manifests as published · every README and guide in /app/content
 *   the container (read-only root file system, the storage volume — as deploy/docs/compose.yaml runs it): /up 200 · the start page,
 *   every guide and every package 200 without Set-Cookie, with the static 'self' policy · the health check turns healthy · no
 *   warning in the log · SIGTERM → exit 0
 *   behind Caddy (deploy/docs/compose.yaml itself, Caddy's port moved to a free one on 127.0.0.1, DOCS_DOMAIN=localhost — Caddy's
 *   own CA): HTTP/2 · no Set-Cookie · Strict-Transport-Security · X-Forwarded-Proto/-Host trusted (an old client's 409 names
 *   https://localhost:<port>) · documents compressed, and a revalidation with the compressed ETag answers 304
 *
 * The image is tagged `bespokecore-docs:smoke-…`, the Compose project `bespokecore-docs-smoke-…`; both, the containers and the
 * volumes are removed afterwards (the build cache stays). Without Docker, or when the build cannot reach the registry, it ends
 * with exit 75 — skipped, never green.
 *
 *   pnpm docs:image           # build, check, remove
 *   pnpm docs:image --keep    # leaves the image (printed)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import docsConfig, { PACKAGES } from '../apps/docs/docs.config.ts';
import { cleanEnvironment, freePort, Offline, OFFLINE, SKIPPED, SmokeError } from './pack-smoke.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const DOCKER_OFFLINE = /failed to resolve source metadata|failed to do request|dial tcp|i\/o timeout|TLS handshake timeout|no such host|ERR_PNPM_META_FETCH_FAIL|EAI_AGAIN|ENOTFOUND/;
/** The docs' policy in production (apps/docs DocsServiceProvider, DOCS_CSP). */
const POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
/** Never in the image: what only builds or tests the docs. */
const DEV_PACKAGES = /^(vite|vitest|typescript|@vitejs\+|oxlint|@oxlint\+|@bespokecore\+(devtools|testing|vite))(@|$)/;

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

/** Every page of the docs: the start page, the guides, the packages. */
export function docsPages(): string[] {
  return ['/', ...(docsConfig.guides ?? []).map((guide) => `/guides/${guide.slug}`), ...PACKAGES.map((name) => `/packages/${name}`)];
}

/** Lists, inside the image, what must not be there (printed as JSON by Node — the image has no find). */
const INSPECT = `
const fs = require('fs'), path = require('path');
const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (p !== 'node_modules') walk(p, out); } else out.push(p); } return out; };
const app = walk('.');
const store = fs.readdirSync('node_modules/.pnpm');
const framework = store.filter((e) => e.startsWith('@bespokecore+')).flatMap((e) => { const dir = path.join('node_modules/.pnpm', e, 'node_modules/@bespokecore'); return fs.readdirSync(dir).map((n) => path.join(dir, n)); });
const frameworkFiles = framework.flatMap((dir) => walk(dir));
console.log(JSON.stringify({
  top: fs.readdirSync('.').sort(),
  env: [...app, ...frameworkFiles].filter((f) => /(^|\\/)\\.env/.test(f)),
  tests: [...app, ...frameworkFiles].filter((f) => /\\.(test|type-test)\\.tsx?$|__fixtures__/.test(f)),
  store,
  sourceCondition: framework.filter((dir) => fs.readFileSync(path.join(dir, 'package.json'), 'utf8').includes('@bespokecore/source')),
  content: app.filter((f) => f.startsWith('content/')).sort(),
}));
`;

interface Inspection {
  top: string[];
  env: string[];
  tests: string[];
  store: string[];
  sourceCondition: string[];
  content: string[];
}

/** The files the image must not have and the ones it must — `problems` empty when all is well. */
export function inspectionProblems(found: Inspection, repository = root): string[] {
  const problems: string[] = [];
  const expected = ['.bespoke', 'README.md', 'bootstrap', 'config', 'content', 'dist', 'docs.config.ts', 'index.html', 'layouts', 'modules', 'node_modules', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'storage', 'styles'];
  const extra = found.top.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !found.top.includes(name));
  if (extra.length > 0) problems.push(`/app has what the docs do not run on: ${extra.join(', ')} (apps/docs "files", the Dockerfile's copies)`);
  if (missing.length > 0) problems.push(`/app lacks ${missing.join(', ')}`);
  if (found.env.length > 0) problems.push(`.env files in the image: ${found.env.join(', ')} (Dockerfile.dockerignore, apps/docs "files")`);
  if (found.tests.length > 0) problems.push(`tests in the image: ${found.tests.slice(0, 8).join(', ')}${found.tests.length > 8 ? ` … (${found.tests.length})` : ''}`);
  const dev = found.store.filter((entry) => DEV_PACKAGES.test(entry));
  if (dev.length > 0) problems.push(`dev dependencies in the image: ${dev.join(', ')} (pnpm deploy --prod)`);
  if (found.sourceCondition.length > 0) problems.push(`framework manifests with the @bespokecore/source condition: ${found.sourceCondition.join(', ')} (scripts/published-manifests.ts)`);
  const pages = [
    'content/README.md',
    ...(docsConfig.guides ?? []).map((guide) => `content/${guide.file}`),
    ...PACKAGES.flatMap((name) => [`content/packages/${name}/README.md`, `content/packages/${name}/package.json`]),
  ];
  const absent = pages.filter((file) => !found.content.includes(file));
  if (absent.length > 0) problems.push(`/app/content lacks ${absent.slice(0, 8).join(', ')}`);
  const guides = readdirSync(join(repository, 'docs')).filter((name) => name.endsWith('.md')).map((name) => `content/docs/${name}`);
  const unshipped = guides.filter((file) => !found.content.includes(file));
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

export async function docsImage({ keep = false }: { keep?: boolean } = {}): Promise<number> {
  const started = performance.now();
  const probe = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { env, encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(`docs image: SKIPPED — Docker is not available here (docker info: ${(probe.stderr || probe.error?.message || '').trim().split('\n')[0]}).`);
    return SKIPPED;
  }
  const id = `${process.pid}-${Date.now().toString(36)}`;
  const tag = `smoke-${id}`;
  const image = `bespokecore-docs:${tag}`;
  const volume = `bespokecore-docs-smoke-${id}`;
  const project = `bespokecore-docs-smoke-${id}`;
  const work = mkdtempSync(join(tmpdir(), 'bespoke-docs-image-'));
  const containers = new Set<string>();
  const key = `base64:${crypto.getRandomValues(new Uint8Array(32)).toBase64()}`;
  let built = false;
  let composed = false;
  // DOCS_DOMAIN=localhost: Caddy signs with its own CA; the port Caddy listens on is moved to a free one (compose.smoke.yaml).
  const composeEnv: Record<string, string> = { APP_KEY: key, DOCS_DOMAIN: 'localhost', DOCS_TAG: tag, SMOKE_PORT: String(await freePort()) };
  const compose = (args: string[], expect: number | 'any' = 0) =>
    docker(['compose', '-p', project, '-f', 'compose.yaml', '-f', join(work, 'compose.smoke.yaml'), ...args], { cwd: join(root, 'deploy/docs'), extraEnv: composeEnv, expect });
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
    await step('deploy/docs/compose.yaml valid', () => {
      writeFileSync(join(work, 'compose.smoke.yaml'), "services:\n  caddy:\n    ports: !override\n      - '127.0.0.1:${SMOKE_PORT}:443'\n");
      compose(['config', '-q']);
    });
    const buildSeconds = await step(`docker build -f apps/docs/Dockerfile -t ${image} .`, () => {
      const begin = performance.now();
      docker(['build', '--progress=plain', '-f', 'apps/docs/Dockerfile', '-t', image, '.'], { extraEnv: { DOCKER_BUILDKIT: '1' } });
      built = true;
      return (performance.now() - begin) / 1000;
    });
    await step('non-root; no .env, no test, no other app, no dev dependency; the manifests as published; every page in content/', () => {
      const uid = docker(['run', '--rm', '--entrypoint', 'id', image, '-u']).output.trim();
      if (uid === '0' || !/^\d+$/.test(uid)) throw new SmokeError(`the container runs as uid ${uid} — the Dockerfile must switch to USER node.`);
      const found = JSON.parse(docker(['run', '--rm', '--entrypoint', 'node', image, '-e', INSPECT]).output.trim().split('\n').at(-1)!) as Inspection;
      const problems = inspectionProblems(found);
      if (problems.length > 0) throw new SmokeError(`the image:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    });
    await step('read-only root, the storage volume → /up, every page 200 without Set-Cookie, the static policy, healthy, a quiet log; SIGTERM → exit 0', async () => {
      const port = await freePort();
      const name = `bespokecore-docs-smoke-${id}-docs`;
      containers.add(name);
      docker(['run', '-d', '--name', name, '--init', '--read-only', '--tmpfs', '/tmp', '-p', `127.0.0.1:${port}:3000`, '-e', `APP_KEY=${key}`, '-e', `APP_URL=http://127.0.0.1:${port}`, '-v', `${volume}:/app/storage`, '--health-interval=1s', '--health-start-period=1s', image]);
      const base = `http://127.0.0.1:${port}`;
      await until('GET /up 200', async () => ((await fetch(`${base}/up`, { signal: AbortSignal.timeout(2_000) })).status === 200 ? true : undefined), 60_000, logs(name));
      const problems: string[] = [];
      for (const path of docsPages()) {
        const response = await fetch(base + path, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(10_000) });
        const body = await response.text();
        if (response.status !== 200) problems.push(`${path}: ${response.status}`);
        if (response.headers.has('set-cookie')) problems.push(`${path}: Set-Cookie ${response.headers.get('set-cookie')}`);
        if (response.headers.get('content-security-policy') !== POLICY) problems.push(`${path}: Content-Security-Policy "${response.headers.get('content-security-policy')}"`);
        if (!body.includes('</h1>')) problems.push(`${path}: not rendered on the server`);
      }
      if (problems.length > 0) throw new SmokeError(`the docs in the container:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
      await until('the health check turning healthy', () => (docker(['inspect', '-f', '{{.State.Health.Status}}', name]).output.trim() === 'healthy' ? true : undefined), 30_000, logs(name));
      docker(['kill', '--signal', 'SIGTERM', name]);
      const code = docker(['wait', name]).output.trim();
      const output = logs(name)();
      if (code !== '0') throw new SmokeError(`the docs container ended with ${code} after SIGTERM:\n${output}`);
      // pino levels: 40 warn, 50 error — a read-only start that wanted to write (a stale manifest, E160) warns.
      const loud = output.split('\n').filter((line) => /"level":(4|5|6)0/.test(line) || /EROFS|EACCES/.test(line));
      if (loud.length > 0) throw new SmokeError(`the docs container warned:\n${loud.join('\n')}`);
      docker(['rm', '-f', '-v', name]);
      containers.delete(name);
    });
    await step('behind Caddy (deploy/docs/compose.yaml): HTTP/2, no Set-Cookie, HSTS, X-Forwarded-* trusted, compressed documents with 304', async () => {
      const port = Number(composeEnv.SMOKE_PORT);
      composed = true;
      compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90']);
      const base = `https://localhost:${port}`;
      await until('Caddy answering over HTTPS', () => (curl(`${base}/up`).status === 200 ? true : undefined), 60_000, () => compose(['logs'], 'any').output);
      const problems: string[] = [];
      for (const path of ['/', '/guides/getting-started', '/packages/session']) {
        const page = curl(base + path, { accept: 'text/html' });
        if (page.version !== 'HTTP/2' || page.status !== 200) problems.push(`${path}: ${page.version} ${page.status}, expected HTTP/2 200`);
        if (page.headers.has('set-cookie')) problems.push(`${path}: Set-Cookie behind Caddy: ${page.headers.get('set-cookie')}`);
        if (!page.headers.get('strict-transport-security')?.startsWith('max-age=')) problems.push(`${path}: no Strict-Transport-Security`);
        if (page.headers.get('content-security-policy') !== POLICY) problems.push(`${path}: Content-Security-Policy "${page.headers.get('content-security-policy')}"`);
      }
      // An old client's visit: the docs build the reload URL from what Caddy forwarded — trusted, it is Caddy's https address.
      const stale = curl(`${base}/guides/deployment`, { 'x-bespoke': 'true', 'x-bespoke-version': 'stale', accept: 'text/html, application/json' });
      if (stale.status !== 409 || stale.headers.get('x-bespoke-location') !== `${base}/guides/deployment`) {
        problems.push(`an old client's visit: ${stale.status}, x-bespoke-location "${stale.headers.get('x-bespoke-location')}" — expected 409 and ${base}/guides/deployment (TRUSTED_PROXIES)`);
      }
      const compressed = curl(`${base}/guides/upgrading`, { accept: 'text/html', 'accept-encoding': 'zstd, gzip' });
      const plain = curl(`${base}/guides/upgrading`, { accept: 'text/html' });
      if (!/zstd|gzip/.test(compressed.headers.get('content-encoding') ?? '') || compressed.length >= plain.length / 2) {
        problems.push(`/guides/upgrading: Content-Encoding "${compressed.headers.get('content-encoding')}", ${compressed.length} of ${plain.length} bytes`);
      }
      const etag = compressed.headers.get('etag');
      const again = etag ? curl(`${base}/guides/upgrading`, { accept: 'text/html', 'accept-encoding': 'zstd, gzip', 'if-none-match': etag }) : undefined;
      if (again?.status !== 304) problems.push(`/guides/upgrading revalidated with ${etag}: ${again?.status}, expected 304`);
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
  process.exitCode = await docsImage({ keep: values.keep === true });
}
