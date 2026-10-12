/**
 * The website (`apps/website`, a normal Marmeon app, no static export):
 *
 *   pnpm website:dev    # marmeon dev on http://localhost:3970 (PORT wins); writes apps/website/.env with a fresh APP_KEY first
 *   pnpm website:check  # marmeon build, the production server on a free port, a smoke test, the server stopped — a part of
 *                       # `pnpm run ci` (it needs the packages built: `pnpm build`)
 *
 * The smoke test asks the production build for the landing, the docs' start page, every docs page (200, server-rendered, the static `'self'`
 * policy without a nonce), the search, `/up`, caching headers, no `Set-Cookie` on a public page, a 404 for an unknown page, a
 * package's old page and the old `/search`, and a 10 000-character query (no 500). The docs' image is `scripts/website-image.ts`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import docsConfig from '../apps/website/docs.config.ts';

const app = fileURLToPath(new URL('../apps/website/', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const marmeon = fileURLToPath(new URL('../packages/cli/bin/marmeon.js', import.meta.url));
const mode = process.argv[2];
/** Every page of the docs' sections, in their order — with its file (`docs/<slug>.md` or a policy at the root). */
const pages = docsConfig.sections.flatMap((section) => section.pages.map((entry) => ({ slug: entry.slug, file: entry.file ?? `docs/${entry.slug}.md` })));
/** The docs' policy in production (apps/website SiteServiceProvider, SITE_CSP). */
const DOCS_POLICY = "script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'";

if (mode === 'dev') await dev();
else if (mode === 'check') process.exitCode = await check();
else {
  console.error('Usage: node scripts/website.ts dev | check');
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

  console.log('website:check: marmeon build');
  const build = spawnSync(process.execPath, [marmeon, 'build'], { cwd: app, stdio: 'inherit', env });
  if (build.status !== 0) return fail(`marmeon build exited with ${build.status}`);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  console.log(`website:check: marmeon start on ${base}`);
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
    console.error(`website:check: ${failures.length} problem(s):\n${failures.map((failure) => `  ✗ ${failure}`).join('\n')}`);
    return 1;
  }
  console.log(`website:check: ✓ build, start, smoke test (${checks} checks, ${pages.length + 4} pages) and stop in ${seconds} s`);
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

  // The landing, the docs' start page and the legal pages: all public, cacheable, revalidated with 304.
  for (const [path, heading] of [['/', 'One type, from the database column to the form error.'], ['/docs', '>Marmeon</h1>'], ['/imprint', '>Site Notice</h1>'], ['/privacy', '>Privacy Policy</h1>']] as const) {
    const home = await publicPage(path, heading);
    expect(/^public, max-age=\d+$/.test(home.headers.get('cache-control') ?? ''), `${path}: Cache-Control is "${home.headers.get('cache-control')}"`);
    const vary = (home.headers.get('vary') ?? '').toLowerCase();
    for (const header of ['x-marmeon', 'x-marmeon-partial-data', 'purpose', 'x-marmeon-version']) expect(vary.includes(header), `${path}: Vary lacks ${header} ("${vary}")`);
    const etag = home.headers.get('etag');
    expect(etag !== null, `${path}: no ETag`);
    if (etag) {
      const again = await fetch(base + path, { headers: { 'if-none-match': etag } });
      expect(again.status === 304, `${path} with If-None-Match: status ${again.status}, expected 304`);
    }
  }

  // Each page's heading is its file's first `#` line (React escapes `&` and quotes in it).
  for (const page of pages) {
    const title = /^# (.+)$/m.exec(readFileSync(join(root, page.file), 'utf8'))?.[1] ?? page.slug;
    await publicPage(`/docs/${page.slug}`, `${title.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')}</h1>`);
  }

  const markdown = await get('/docs/routing.md');
  expect(markdown.response.status === 200, `/docs/routing.md: status ${markdown.response.status}, expected 200`);
  expect(markdown.response.headers.get('content-type')?.startsWith('text/markdown') === true, `/docs/routing.md: content type ${markdown.response.headers.get('content-type')}`);
  expect(markdown.body.startsWith('# Routing'), '/docs/routing.md: the body does not start with "# Routing"');
  const negotiated = await get('/docs/routing', { accept: 'text/markdown' });
  expect(negotiated.response.headers.get('content-type')?.startsWith('text/markdown') === true, `/docs/routing with Accept: text/markdown: content type ${negotiated.response.headers.get('content-type')}`);
  expect((negotiated.response.headers.get('vary') ?? '').toLowerCase().includes('accept'), '/docs/routing with Accept: text/markdown: Vary lacks Accept');
  const browser = await get('/docs/routing', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' });
  expect(browser.response.headers.get('content-type')?.startsWith('text/html') === true, `/docs/routing with a browser's Accept: content type ${browser.response.headers.get('content-type')}`);
  expect((browser.response.headers.get('vary') ?? '').toLowerCase().includes('accept'), "/docs/routing with a browser's Accept: Vary lacks Accept");
  const noMarkdown = await get('/docs/search.md');
  expect(noMarkdown.response.status === 404, `/docs/search.md: status ${noMarkdown.response.status}, expected 404`);

  const robots = await get('/robots.txt');
  expect(robots.response.status === 200 && robots.response.headers.get('content-type')?.startsWith('text/plain') === true, `/robots.txt: ${robots.response.status} ${robots.response.headers.get('content-type')}`);
  expect(robots.body.includes(`Sitemap: ${base}/sitemap.xml`), '/robots.txt: no Sitemap line from APP_URL');
  const sitemap = await get('/sitemap.xml');
  expect(sitemap.response.status === 200 && sitemap.response.headers.get('content-type')?.startsWith('application/xml') === true, `/sitemap.xml: ${sitemap.response.status} ${sitemap.response.headers.get('content-type')}`);
  expect(sitemap.body.includes('/docs/routing</loc>'), '/sitemap.xml: no /docs/routing');
  const llms = await get('/llms.txt');
  expect(llms.response.status === 200 && llms.body.includes('/docs/routing.md)'), `/llms.txt: ${llms.response.status}, no link to /docs/routing.md`);
  const llmsFull = await get('/llms-full.txt');
  expect(llmsFull.response.status === 200 && llmsFull.body.includes('# Routing'), `/llms-full.txt: ${llmsFull.response.status}, no "# Routing"`);

  const search = async (q: string, page: string) => {
    const response = await publicPage(`/docs/search?q=${encodeURIComponent(q)}`, `href="${page}`);
    // The same URL as a visit: the page object (JSON), not the document — Vary keeps them apart in a cache.
    const visit = await get(`/docs/search?q=${encodeURIComponent(q)}`, { 'x-marmeon': 'true', accept: 'text/html, application/json' });
    expect(visit.response.headers.get('content-type')?.startsWith('application/json') === true, `/docs/search as a visit: ${visit.response.headers.get('content-type')}`);
    expect(visit.body.includes(`"href":"${page}`), `/docs/search?q=${q} as a visit: no result on ${page}`);
    return response;
  };
  await search('onOneServer', '/docs/scheduling');
  await search('afterRollback', '/docs/transactions');
  await search('SHUTDOWN_DELAY', '/docs/deployment');

  // The favicon is a built asset (Vite rewrites the link), the stylesheet one too: both come from /assets/ (the stylesheet is what `style-src 'self'` allows).
  const landing = await get('/');
  const icon = /<link rel="icon"[^>]*href="([^"]+)"/.exec(landing.body)?.[1];
  expect(icon?.startsWith('/assets/') === true, `/: the favicon link is "${icon}", expected an /assets/ path`);
  if (icon) {
    const favicon = await get(icon);
    expect(favicon.response.status === 200 && favicon.response.headers.get('content-type')?.startsWith('image/svg+xml') === true, `${icon}: ${favicon.response.status} ${favicon.response.headers.get('content-type')}, expected 200 image/svg+xml`);
  }
  expect(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/.test(landing.body), '/: no stylesheet from /assets/');

  const packagePage = await get('/packages/http');
  expect(packagePage.response.status === 404, `/packages/http: status ${packagePage.response.status}, expected 404 (the READMEs are no pages)`);
  const noPage = await get('/docs/no-such-page');
  expect(noPage.response.status === 404, `/docs/no-such-page: status ${noPage.response.status}, expected 404`);
  const oldSearch = await get('/search?q=onOneServer');
  expect(oldSearch.response.status === 404, `/search: status ${oldSearch.response.status}, expected 404 (the search lives at /docs/search)`);
  const long = await get(`/docs/search?q=${'a'.repeat(10_000)}`);
  expect(long.response.status < 500, `/docs/search with 10 000 characters: status ${long.response.status}`);

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
  console.error(`website:check: ✗ ${message}`);
  return 1;
}
