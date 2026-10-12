import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createApplication, CSP_NONCE_PLACEHOLDER, defineModule, Logger, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { cacheControl, contentSecurityPolicy, HttpServiceProvider, PAGE_HEADER, view, type SsrRender } from '@marmeon/http';
import { defineRoutes } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { ASSET_CACHE_CONTROL } from './assets.ts';
import { withNonce } from './html.ts';
import { createHttpKernel, startServer } from './kernel.ts';
import { ServerConfig, ServerServiceProvider } from './provider.ts';
import { forwardedRequest, isProxyEntry, proxyMatcher } from './proxies.ts';
import { assetPreloads } from './preloads.ts';
import { createDocumentRenderer } from './render.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// What a production server does at the HTTP level — the proxies it believes, the assets it sends,
// the nonce every document and its policy share.

const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

describe('TRUSTED_PROXIES', async () => {
  it('knows addresses and ranges — IPv4, IPv6, an IPv4-mapped peer — and refuses anything else at boot', async () => {
    const trusts = proxyMatcher(['10.0.0.0/8', '192.168.1.7', 'fd00::/8', '::1']);
    expect(['10.200.3.4', '::ffff:10.0.0.1', '192.168.1.7', 'fd12::1', '::1'].map(trusts)).toEqual([true, true, true, true, true]);
    expect(['11.0.0.1', '192.168.1.8', 'fe80::1', '::2', 'not an ip'].map(trusts)).toEqual([false, false, false, false, false]);
    expect(proxyMatcher([])('10.0.0.1')).toBe(false);
    expect(proxyMatcher(['*'])('203.0.113.9')).toBe(true);
    expect(['10.0.0.0/33', '10.0.0.1/', 'fd00::/129', 'proxy.internal', '10.0.0.0/8/1'].some(isProxyEntry)).toBe(false);
    await expect(
      createApplication({ root: import.meta.dirname, discover: false, env: { TRUSTED_PROXIES: '10.0.0.0/8, proxy.internal' }, providers: [ServerServiceProvider] }),
    ).rejects.toThrow('server: TRUSTED_PROXIES — Expected addresses or ranges like 10.0.0.0/8, or *: proxy.internal is not one');
  });

  it('rewrites the URL only from a trusted peer: X-Forwarded-Proto and -Host — the nearest proxy\'s value, a valid one', () => {
    const request = (headers: Record<string, string>) => new Request('http://10.0.0.5:3000/users?page=2', { headers });
    const trusts = proxyMatcher(['10.0.0.0/8']);
    const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' };
    expect(forwardedRequest(request(forwarded), '10.0.0.2', trusts).url).toBe('https://example.com/users?page=2');
    // Anybody else: ignored — and the very same request (no copy on the common path).
    const untrusted = request(forwarded);
    expect(forwardedRequest(untrusted, '203.0.113.9', trusts)).toBe(untrusted);
    expect(forwardedRequest(untrusted, undefined, trusts)).toBe(untrusted);
    // A list: the right-most value, which the trusted proxy added — not what the client wrote on the left.
    expect(forwardedRequest(request({ 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'evil.example, example.com' }), '10.0.0.2', trusts).url).toBe(
      'http://example.com/users?page=2',
    );
    // Not a protocol or not a host: ignored.
    expect(forwardedRequest(request({ 'x-forwarded-proto': 'javascript', 'x-forwarded-host': 'a b/c@evil' }), '10.0.0.2', trusts).url).toBe('http://10.0.0.5:3000/users?page=2');
  });

  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), TRUSTED_PROXIES: '10.0.0.0/8' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [
      defineModule({
        name: 'whoami',
        routes: defineRoutes((Route) => Route.get('/whoami', (ctx) => ({ ip: ctx.ip, url: ctx.request.url }))),
        apiRoutes: defineRoutes((Route) => Route.get('/whoami', (ctx) => ({ ip: ctx.ip, url: ctx.request.url }))),
      }),
    ],
  });
  const app = createHttpKernel(application);
  const whoami = async (remote: string, headers: Record<string, string>, path = '/whoami') =>
    (await (await app.request(path, { headers: { accept: 'application/json', ...headers } }, peer(remote))).json()) as { ip: string; url: string };
  const proxied = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.com' };

  it('an untrusted peer: X-Forwarded-* change neither ctx.ip nor the URL', async () => {
    expect(await whoami('203.0.113.9', proxied)).toEqual({ ip: '203.0.113.9', url: 'http://localhost/whoami' });
  });

  it('a trusted peer (in the range): the client\'s address, the protocol and host the client used — in every group', async () => {
    expect(await whoami('10.1.2.3', proxied)).toEqual({ ip: '198.51.100.7', url: 'https://example.com/whoami' });
    expect(await whoami('::ffff:10.1.2.3', proxied, '/api/whoami')).toEqual({ ip: '198.51.100.7', url: 'https://example.com/api/whoami' });
  });

  it("TRUSTED_PROXIES='*' trusts the direct peer only: a client's own X-Forwarded-For through the proxy chooses no address", async () => {
    const behindAny = createHttpKernel(
      await createApplication({
        root: import.meta.dirname,
        discover: false,
        env: { APP_KEY: generateKey(), TRUSTED_PROXIES: '*' },
        providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
        modules: [defineModule({ name: 'whoami', routes: defineRoutes((Route) => Route.get('/whoami', (ctx) => ({ ip: ctx.ip, url: ctx.request.url }))) })],
      }),
    );
    const ask = async (remote: string, headers: Record<string, string>) =>
      (await (await behindAny.request('/whoami', { headers: { accept: 'application/json', ...headers } }, peer(remote))).json()) as { ip: string; url: string };
    // A proxy that appends (nginx's $proxy_add_x_forwarded_for): the client sent "6.6.6.6", the proxy added the address it saw.
    expect(await ask('172.18.0.2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7', 'x-forwarded-proto': 'http, https' })).toEqual({
      ip: '198.51.100.7',
      url: 'https://localhost/whoami',
    });
    // A proxy that replaces the header; and none at all — the peer itself.
    expect((await ask('172.18.0.2', { 'x-forwarded-for': '198.51.100.7' })).ip).toBe('198.51.100.7');
    expect((await ask('172.18.0.2', {})).ip).toBe('172.18.0.2');
  });

  it('the server config: HOST is where it listens (unset: every interface)', async () => {
    expect(application.container.make(ServerConfig).host).toBeUndefined();
    const local = await createApplication({ root: import.meta.dirname, discover: false, env: { APP_KEY: generateKey(), HOST: '127.0.0.1' }, providers: [ServerServiceProvider] });
    expect(local.container.make(ServerConfig).host).toBe('127.0.0.1');
  });
});

describe('the build\'s assets', async () => {
  // Removed with the file (also when a filter skips this suite and its afterAll would not run).
  const clientDir = tempDir('marmeon-assets-');
  mkdirSync(join(clientDir, 'assets'));
  const script = `export const greeting = ${JSON.stringify('hello '.repeat(200))};\n`;
  writeFileSync(join(clientDir, 'assets/index-AbC123.js'), script);
  writeFileSync(join(clientDir, 'assets/index-AbC123.js.br'), brotliCompressSync(script));
  writeFileSync(join(clientDir, 'assets/index-AbC123.js.gz'), gzipSync(script));
  writeFileSync(join(clientDir, 'assets/logo-Zz9.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    modules: [defineModule({ name: 'pages', routes: defineRoutes((Route) => Route.get('/page', () => view('pages/Show', { secret: 'x'.repeat(4000) }))) })],
  });
  const app = createHttpKernel(application, { clientDir });

  it('are kept for a year, immutable — the hash in the name changes with the content', async () => {
    const response = await app.request('/assets/index-AbC123.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(await response.text()).toBe(script);
    expect((await app.request('/assets/logo-Zz9.png')).headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
  });

  it('come as the .br marmeon build wrote (else .gz) when the browser accepts it — with the original Content-Type and Vary', async () => {
    const br = await app.request('/assets/index-AbC123.js', { headers: { 'accept-encoding': 'gzip, deflate, br, zstd' } });
    expect(br.headers.get('content-encoding')).toBe('br');
    expect(br.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(br.headers.get('vary')).toBe('Accept-Encoding');
    expect(br.headers.get('cache-control')).toBe(ASSET_CACHE_CONTROL);
    expect(Number(br.headers.get('content-length'))).toBeLessThan(script.length / 4);
    const gz = await app.request('/assets/index-AbC123.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    // An image is not compressible: never a variant, no Vary.
    const png = await app.request('/assets/logo-Zz9.png', { headers: { 'accept-encoding': 'br' } });
    expect(png.headers.get('content-encoding')).toBeNull();
    expect(png.headers.get('vary')).toBeNull();
  });

  it('never serves the manifest — it names the source path of every page', async () => {
    mkdirSync(join(clientDir, '.vite'));
    writeFileSync(join(clientDir, '.vite/manifest.json'), '{}');
    for (const path of ['/.vite/manifest.json', '/assets/..%2f.vite/manifest.json', '/assets/%2e%2e%2f.vite%2fmanifest.json']) {
      expect((await app.request(path, { headers: { accept: 'application/json' } })).status).toBe(404);
    }
  });

  it('a missing asset is a 404, not cached; a document is never compressed here (BREACH) — whatever the browser accepts', async () => {
    const missing = await app.request('/assets/gone-123.js', { headers: { accept: 'application/json' } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).not.toBe(ASSET_CACHE_CONTROL);
    const page = await app.request('/page', { headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br, zstd' } });
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-encoding')).toBeNull();
    expect((await page.text()).length).toBeGreaterThan(4000);
  });
});

describe('the CSP nonce', async () => {
  const TEMPLATE = `<!doctype html><html><head><meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}"><!--app-head--><script type="module" crossorigin src="/assets/index-AbC123.js" nonce="${CSP_NONCE_PLACEHOLDER}"></script></head><body><div id="app"><!--app-html--></div></body></html>`;
  const rendered: (string | undefined)[] = [];
  const render: SsrRender = async (page, options) => {
    rendered.push(options?.nonce);
    const inline = options?.nonce ? `<script nonce="${options.nonce}">$RC("B:0","S:0")</script>` : '<script>$RC("B:0","S:0")</script>';
    return { html: `<main>${page.component}</main>${inline}`, head: '' };
  };
  const warnings: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), NODE_ENV: 'test' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
    override: (container: Container) => container.instance(Logger, logger),
    middleware: { global: [contentSecurityPolicy({ imgSrc: ["'self'", 'data:'] })] },
    modules: [
      defineModule({
        name: 'pages',
        routes: defineRoutes((Route) => {
          Route.get('/page', () => view('pages/Show', {}));
          Route.get('/data', () => ({ ok: true }));
          Route.get('/own', () => new Response('<p>sandboxed</p>', { headers: { 'content-type': 'text/html', 'content-security-policy': 'sandbox' } }));
          Route.get('/handmade', (ctx) => new Response(`<script nonce="${ctx.nonce()}">ok()</script>`, { headers: { 'content-type': 'text/html' } }));
          Route.middleware(cacheControl('public, max-age=60')).get('/public', () => view('pages/Show', {}));
        }),
      }),
    ],
  });
  const app = createHttpKernel(application, { renderer: createDocumentRenderer({ template: () => TEMPLATE, ssr: () => render }) });
  const nonceOf = (response: Response) => /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy') ?? '')?.[1];

  it('one per response — in the header, on the template\'s tags and React\'s streamed scripts alike; the next response gets another', async () => {
    const first = await app.request('/page', { headers: { accept: 'text/html' } });
    const html = await first.text();
    const nonce = nonceOf(first);
    expect(first.headers.get('content-security-policy')).toBe(`script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'self'; img-src 'self' data:`);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(html).not.toContain(CSP_NONCE_PLACEHOLDER);
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
    expect(html).toContain(`src="/assets/index-AbC123.js" nonce="${nonce}"`);
    expect(html).toContain(`<script nonce="${nonce}">$RC`);
    expect(rendered.at(-1)).toBe(nonce);
    // Every executable script of the document carries it (the page object is data: type="application/json").
    for (const tag of html.match(/<script\b[^>]*>/g)!) if (!tag.includes('application/json')) expect(tag).toContain(`nonce="${nonce}"`);
    const second = await app.request('/page', { headers: { accept: 'text/html' } });
    expect(nonceOf(second)).toBeDefined();
    expect(nonceOf(second)).not.toBe(nonce);
  });

  it('the preloads the server adds carry the response\'s nonce — the very one of the policy', async () => {
    const preloaded = createHttpKernel(application, {
      renderer: createDocumentRenderer({
        template: () => TEMPLATE,
        ssr: () => render,
        preloads: assetPreloads({ 'modules/pages/views/Show.tsx': { file: 'assets/Show-1.js' } }),
      }),
    });
    const response = await preloaded.request('/page', { headers: { accept: 'text/html' } });
    const nonce = nonceOf(response);
    const html = await response.text();
    expect(html).toContain(`<link rel="modulepreload" href="/assets/Show-1.js" crossorigin nonce="${nonce}">`);
    expect(html).not.toContain(CSP_NONCE_PLACEHOLDER);
    const visit = await preloaded.request('/page', { headers: { [PAGE_HEADER]: 'true', accept: 'text/html' } });
    expect(await visit.text()).not.toContain('<link');
  });

  it('a JSON visit or answer neither makes a nonce nor gets the header — nothing in it depends on one', async () => {
    const before = rendered.length;
    const visit = await app.request('/page', { headers: { [PAGE_HEADER]: 'true', accept: 'text/html, application/xhtml+xml' } });
    expect(visit.headers.get('content-type')).toBe('application/json');
    expect(visit.headers.get('content-security-policy')).toBeNull();
    expect(JSON.stringify(await visit.json())).not.toMatch(/nonce/i);
    expect(rendered.length).toBe(before); // never rendered — no document, no nonce
    const data = await app.request('/data', { headers: { accept: 'application/json' } });
    expect(data.headers.get('content-security-policy')).toBeNull();
  });

  it('leaves a response with a policy of its own alone; HTML the app writes itself gets the nonce through ctx.nonce()', async () => {
    expect((await app.request('/own')).headers.get('content-security-policy')).toBe('sandbox');
    const handmade = await app.request('/handmade');
    expect(await handmade.text()).toBe(`<script nonce="${nonceOf(handmade)}">ok()</script>`);
  });

  it('warns once when a page with a nonce is cached publicly — a shared cache would hand the nonce to everybody', async () => {
    await app.request('/public', { headers: { accept: 'text/html' } });
    await app.request('/public', { headers: { accept: 'text/html' } });
    expect(warnings.filter((message) => message.includes('cached publicly'))).toEqual([
      expect.stringContaining("/public is cached publicly (Cache-Control: public, max-age=60) and carries a CSP nonce"),
    ]);
  });

  it('without the policy, documents carry no nonce at all — the placeholder attributes are taken out', async () => {
    const plain = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: { APP_KEY: generateKey(), NODE_ENV: 'test' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      modules: [defineModule({ name: 'pages', routes: defineRoutes((Route) => Route.get('/page', () => view('pages/Show', {}))) })],
    });
    const kernel = createHttpKernel(plain, { renderer: createDocumentRenderer({ template: () => TEMPLATE, ssr: () => render }) });
    const response = await kernel.request('/page', { headers: { accept: 'text/html' } });
    const html = await response.text();
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(html).not.toContain('nonce=');
    expect(html).toContain('<meta property="csp-nonce">');
    expect(rendered.at(-1)).toBeUndefined();
    const bare = createHttpKernel(plain, {
      renderer: createDocumentRenderer({ template: () => TEMPLATE, ssr: () => render, preloads: assetPreloads({ 'modules/pages/views/Show.tsx': { file: 'assets/Show-1.js' } }) }),
    });
    const preloaded = await (await bare.request('/page', { headers: { accept: 'text/html' } })).text();
    expect(preloaded).toContain('<link rel="modulepreload" href="/assets/Show-1.js" crossorigin>');
    expect(preloaded).not.toContain('nonce=');
    expect(withNonce('<p>no placeholder</p>', 'abc')).toBe('<p>no placeholder</p>');
  });
});

describe('startServer and HOST', () => {
  it('listens on HOST only — 127.0.0.1 answers, the start line names it', async () => {
    const root = tempDir('marmeon-host-');
    mkdirSync(join(root, 'dist/client'), { recursive: true });
    mkdirSync(join(root, 'dist/server'), { recursive: true });
    writeFileSync(join(root, 'dist/client/index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
    writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
    const lines: string[] = [];
    const logger: Logger = { debug() {}, info: (message: string) => void lines.push(message), warn() {}, error() {}, child: () => logger };
    const app = await createApplication({
      root,
      discover: false,
      env: { APP_KEY: generateKey(), HOST: '127.0.0.1', NODE_ENV: 'test' },
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider],
      override: (container: Container) => container.instance(Logger, logger),
    });
    const running = await startServer({ app, port: 0, mode: 'production' });
    try {
      const address = running.server.address() as AddressInfo;
      expect(address.address).toBe('127.0.0.1');
      expect((await fetch(`http://127.0.0.1:${address.port}/up`)).status).toBe(200);
      expect(lines.find((line) => line.startsWith('Marmeon in'))).toContain(`on http://127.0.0.1:${address.port}`);
    } finally {
      await running.close();
      await app.shutdown();
    }
  });
});

describe('keep-alive behind a proxy', () => {
  /** The `Keep-Alive` header of an answer — what Node tells the client (the proxy) about idle connections. */
  const keepAliveOf = (port: number) =>
    new Promise<string | undefined>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/up', agent: false, headers: { connection: 'keep-alive' } }, (response) => {
        response.resume();
        resolve(response.headers['keep-alive'] as string | undefined);
      }).once('error', reject);
    });

  it('keeps idle connections 65 s (longer than nginx keeps its own to the app, 60 s) — KEEP_ALIVE_TIMEOUT sets it; headers may take a second more', async () => {
    const root = tempDir('marmeon-keepalive-');
    mkdirSync(join(root, 'dist/client'), { recursive: true });
    mkdirSync(join(root, 'dist/server'), { recursive: true });
    writeFileSync(join(root, 'dist/client/index.html'), '<html><head><!--app-head--></head><body><!--app-html--></body></html>');
    writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "" });');
    for (const [env, seconds] of [[{}, 65], [{ KEEP_ALIVE_TIMEOUT: '620' }, 620]] as const) {
      const app = await createApplication({ root, discover: false, env: { APP_KEY: generateKey(), HOST: '127.0.0.1', NODE_ENV: 'test', LOG_LEVEL: 'silent', ...env }, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider] });
      const running = await startServer({ app, port: 0, mode: 'production' });
      try {
        expect([running.server.keepAliveTimeout, running.server.headersTimeout, running.server.requestTimeout]).toEqual([seconds * 1000, seconds === 65 ? 66_000 : 300_000, 300_000]);
        expect(await keepAliveOf(running.port)).toBe(`timeout=${seconds}`);
      } finally {
        await running.close();
        await app.shutdown();
      }
    }
    await expect(createApplication({ root: import.meta.dirname, discover: false, env: { KEEP_ALIVE_TIMEOUT: '0' }, providers: [ServerServiceProvider] })).rejects.toThrow(
      'server: KEEP_ALIVE_TIMEOUT — Expected at least 1 second',
    );
  });
});
