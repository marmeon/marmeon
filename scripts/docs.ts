/**
 * The docs app (`apps/docs`, a normal Marmeon app, no static export):
 *
 *   pnpm docs:dev       # marmeon dev on http://localhost:3970 (PORT wins); writes apps/docs/.env with a fresh APP_KEY first
 *   pnpm docs:check     # marmeon build, the production server on a free port, a smoke test, the server stopped — a part of
 *                       # `pnpm run ci` (it needs the packages built: `pnpm build`)
 *
 * The smoke test asks the running production build for the start page, every page of the docs'
 * sections (`/docs/<slug>`: `docs/*.md`, `UPGRADING.md`, …) (200, server-rendered, the static `'self'`
 * Content-Security-Policy without a nonce), the search (`onOneServer` → the scheduling page, `afterRollback` → transactions,
 * `SHUTDOWN_DELAY` → the deployment page), `/up`, no `Set-Cookie` on any public page, caching headers (`public`, `ETag`,
 * `Vary`, `304`), an unknown page and a package's old page (404 — the READMEs are cards for npm) and a 10 000-character query
 * (no 500). The image of the docs is built and run by the `image` part (scripts/docs-image.ts).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import docsConfig from '../apps/docs/docs.config.ts';

const app = fileURLToPath(new URL('../apps/docs/', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const marmeon = fileURLToPath(new URL('../packages/cli/bin/marmeon.js', import.meta.url));
const mode = process.argv[2];
/** Every page of the docs' sections, in their order — with its file (`docs/<slug>.md` or a policy at the root). */
const pages = docsConfig.sections.flatMap((section) => section.pages.map((entry) => ({ slug: entry.slug, file: entry.file ?? `docs/${entry.slug}.md` })));
/** The docs' policy in production (apps/docs DocsServiceProvider, DOCS_CSP). */
const DOCS_POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

if (mode === 'dev') await dev();
else if (mode === 'check') process.exitCode = await check();
else {
  console.error('Usage: node scripts/docs.ts dev | check');
  process.exitCode = 2;
}

async function dev(): Promise<void> {
  if (!existsSync(`${app}.env`)) spawnSync(process.execPath, [marmeon, 'key:generate'], { cwd: app, stdio: 'inherit' });
  const child = spawn(process.execPath, [marmeon, 'dev'], { cwd: app, stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT ?? '3970' } });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  await new Promise<void>((resolve) => child.on('exit', (code) => resolve(void (process.exitCode = code ?? 1))));
}

async function check(): Promise<number> {
  const started = performance.now();
  // Everything the app needs comes with the command: CI has no .env (a key of its own for this run only).
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
    CACHE_DRIVER: 'memory',
    LOG_LEVEL: 'warn',
  };
  delete env.NODE_ENV; // `marmeon build` builds for production without one (a development NODE_ENV of .env is set aside), `marmeon start` sets production

  console.log('docs:check: marmeon build');
  const build = spawnSync(process.execPath, [marmeon, 'build'], { cwd: app, stdio: 'inherit', env });
  if (build.status !== 0) return fail(`marmeon build exited with ${build.status}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`docs:check: marmeon start on ${base}`);
  const server = spawn(process.execPath, [marmeon, 'start'], { cwd: app, stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, HOST: '127.0.0.1', PORT: String(port), APP_URL: base } });
  const failures: string[] = [];
  let checks = 0;
  try {
    await waitForUp(base, server);
    checks = await smoke(base, failures);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    await stop(server);
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  if (failures.length > 0) {
    console.error(`docs:check: ${failures.length} problem(s):\n${failures.map((failure) => `  ✗ ${failure}`).join('\n')}`);
    return 1;
  }
  console.log(`docs:check: ✓ build, start, smoke test (${checks} checks, ${pages.length + 1} pages) and stop in ${seconds} s`);
  return 0;
}

/** Asks the running server; returns how many checks it made. */
async function smoke(base: string, failures: string[]): Promise<number> {
  let checks = 0;
  const expect = (ok: boolean, message: string) => {
    checks++;
    if (!ok) failures.push(message);
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(base + path, { headers, redirect: 'manual' });
    return { response, body: await response.text() };
  };
  const publicPage = async (path: string, contains: string) => {
    const { response, body } = await get(path);
    expect(response.status === 200, `${path}: status ${response.status}, expected 200`);
    expect(body.includes(contains), `${path}: the server-rendered page lacks "${contains}"`);
    expect(!response.headers.has('set-cookie'), `${path}: sets a cookie (${response.headers.get('set-cookie')})`);
    // Cached publicly, so no nonce: scripts from this origin only — and the document carries no nonce attribute.
    const policy = response.headers.get('content-security-policy');
    expect(policy === DOCS_POLICY, `${path}: Content-Security-Policy is "${policy}", expected "${DOCS_POLICY}"`);
    expect(!/<[a-z]+ [^>]*\bnonce=/.test(body), `${path}: a tag carries a nonce attribute`);
    expect(response.headers.get('x-content-type-options') === 'nosniff', `${path}: no X-Content-Type-Options: nosniff`);
    return response;
  };

  const home = await publicPage('/', '<h1>Marmeon</h1>');
  expect(/^public, max-age=\d+$/.test(home.headers.get('cache-control') ?? ''), `/: Cache-Control is "${home.headers.get('cache-control')}"`);
  const vary = (home.headers.get('vary') ?? '').toLowerCase();
  for (const header of ['x-marmeon', 'x-marmeon-partial-data', 'purpose', 'x-marmeon-version']) expect(vary.includes(header), `/: Vary lacks ${header} ("${vary}")`);
  const etag = home.headers.get('etag');
  expect(etag !== null, '/: no ETag');
  if (etag) {
    const again = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });
    expect(again.status === 304, `/ with If-None-Match: status ${again.status}, expected 304`);
  }

  // Each page's heading is its file's first `#` line (React escapes `&` and quotes in it).
  for (const page of pages) {
    const title = /^# (.+)$/m.exec(readFileSync(join(root, page.file), 'utf8'))?.[1] ?? page.slug;
    await publicPage(`/docs/${page.slug}`, `${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')}</h1>`);
  }

  const search = async (q: string, page: string) => {
    const response = await publicPage(`/search?q=${encodeURIComponent(q)}`, `href="${page}`);
    // The same URL as a visit: the page object (JSON), not the document — Vary keeps them apart in a cache.
    const visit = await get(`/search?q=${encodeURIComponent(q)}`, { 'x-marmeon': 'true', accept: 'text/html, application/json' });
    expect(visit.response.headers.get('content-type')?.startsWith('application/json') === true, `/search as a visit: ${visit.response.headers.get('content-type')}`);
    expect(visit.body.includes(`"href":"${page}`), `/search?q=${q} as a visit: no result on ${page}`);
    return response;
  };
  await search('onOneServer', '/docs/scheduling');
  await search('afterRollback', '/docs/transactions');
  await search('SHUTDOWN_DELAY', '/docs/deployment');

  const packagePage = await get('/packages/http');
  expect(packagePage.response.status === 404, `/packages/http: status ${packagePage.response.status}, expected 404 (the READMEs are no pages)`);
  const noPage = await get('/docs/no-such-page');
  expect(noPage.response.status === 404, `/docs/no-such-page: status ${noPage.response.status}, expected 404`);
  const long = await get(`/search?q=${'a'.repeat(10_000)}`);
  expect(long.response.status < 500, `/search with 10 000 characters: status ${long.response.status}`);

  const up = await get('/up');
  expect(up.response.status === 200, `/up: status ${up.response.status}`);
  return checks;
}

async function waitForUp(base: string, server: ChildProcess): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`the server exited with ${server.exitCode} before it answered /up`);
    try {
      if ((await fetch(`${base}/up`)).status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the server did not answer /up within 60 s');
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
  server.kill('SIGTERM');
  const killed = setTimeout(() => server.kill('SIGKILL'), 15_000);
  await exited;
  clearTimeout(killed);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no free port'))));
    });
  });
}

function fail(message: string): number {
  console.error(`docs:check: ✗ ${message}`);
  return 1;
}
