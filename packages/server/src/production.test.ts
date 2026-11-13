import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageObject } from '@marmeon/http';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProductionRenderer } from './production.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

const root = tempDir('marmeon-prod-');

const manifest = {
  'index.html': { file: 'assets/index-a1.js', isEntry: true },
  'modules/demo/views/Home.tsx': { file: 'assets/Home-b2.js', isDynamicEntry: true, imports: ['index.html'] },
};

function build(asset: string, manifestText: string | null = JSON.stringify(manifest)): void {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
  mkdirSync(join(root, 'dist/client'), { recursive: true });
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  writeFileSync(join(root, 'dist/client/index.html'), `<html><head><script src="/assets/${asset}"></script><!--app-head--></head><body><!--app-html--></body></html>`);
  if (manifestText !== null) {
    mkdirSync(join(root, 'dist/client/.vite'), { recursive: true });
    writeFileSync(join(root, 'dist/client/.vite/manifest.json'), manifestText);
  }
  writeFileSync(join(root, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "<p>hi</p>" });');
}

describe('createProductionRenderer', () => {
  it('asks for a build when there is none', async () => {
    await expect(createProductionRenderer({ root: join(root, 'nothing-built') })).rejects.toThrow(
      'No production build in dist/client — run `marmeon build` first.',
    );
  });

  it('derives the asset version from the build — a new build, a new version', async () => {
    build('index-a1b2.js');
    const first = await createProductionRenderer({ root });
    expect(first.version).toMatch(/^[0-9a-f]{12}$/);
    expect((await createProductionRenderer({ root })).version).toBe(first.version);

    build('index-c3d4.js');
    expect((await createProductionRenderer({ root })).version).not.toBe(first.version);
  });

  const page = { component: 'demo/Home', props: {}, url: '/', version: null } as unknown as PageObject;

  it("preloads the page's chunks in the shell, with the nonce; the entry stays the template's", async () => {
    build('index-a1.js');
    const html = await (await createProductionRenderer({ root })).shell(page, new Request('http://h/'), 'N0NCE');
    expect(html).toContain('<link rel="modulepreload" href="/assets/Home-b2.js" crossorigin nonce="N0NCE">');
    expect(html).not.toContain('href="/assets/index-a1.js"');
    // The outlet's content (the page object) comes after the preloads.
    expect(html.indexOf('modulepreload')).toBeGreaterThan(-1);
    expect(html.indexOf('modulepreload')).toBeLessThan(html.indexOf('id="marmeon-page"'));
  });

  it('starts without a manifest and preloads nothing', async () => {
    build('index-a1.js', null);
    const html = await (await createProductionRenderer({ root })).shell(page, new Request('http://h/'), 'N0NCE');
    expect(html).not.toContain('modulepreload');
  });

  it('refuses to boot with a path base, with a manifest or without', async () => {
    for (const manifestText of [JSON.stringify(manifest), null]) {
      build('index-a1.js', manifestText);
      const index = join(root, 'dist/client/index.html');
      writeFileSync(index, '<html><head><script type="module" src="/static/assets/index-a1.js"></script></head><body></body></html>');
      await expect(createProductionRenderer({ root })).rejects.toThrow("`base` is '/static/'");
    }
  });

  it('refuses to boot with a malformed manifest', async () => {
    build('index-a1.js', '{ "a": { "file": 1 } }');
    await expect(createProductionRenderer({ root })).rejects.toThrow('dist/client/.vite/manifest.json is not a Vite manifest — run `marmeon build` again.');
    build('index-a1.js', 'not json');
    await expect(createProductionRenderer({ root })).rejects.toThrow('is not a Vite manifest');
  });
});

describe('createProductionRenderer — a package entry of its own', () => {
  const base = {
    'index.html': { file: 'assets/index-a1.js', isEntry: true, imports: ['_react'], css: ['assets/index-a1.css'] },
    '../pkg/client.js': { file: 'assets/pkg-status-d4.js', isEntry: true, imports: ['_react', '_status-lib'], css: ['assets/pkg-status-d4.css'] },
    _react: { file: 'assets/react-c3.js' },
    '_status-lib': { file: 'assets/status-lib-e5.js', css: ['assets/status-lib-e5.css'] },
    'modules/demo/views/Home.tsx': { file: 'assets/Home-b2.js', isDynamicEntry: true, imports: ['_react', 'index.html'] },
    'modules/demo/views/Shared.tsx': { file: 'assets/Shared-g7.js', isDynamicEntry: true, imports: ['_react', '_status-lib', 'index.html'] },
    '../pkg/views/Index.js': { file: 'assets/Index-f6.js', isDynamicEntry: true, imports: ['_react', '_status-lib', '../pkg/client.js'], css: ['assets/Index-f6.css'] },
  };
  const entriesFile = { format: 1, entries: { status: { client: '../pkg/client.js' } }, pages: { 'status::Index': '../pkg/views/Index.js' } };
  const demo = { component: 'demo/Home', props: {}, url: '/', version: null } as unknown as PageObject;
  const status = { component: 'status::Index', props: {}, url: '/status', version: null } as unknown as PageObject;

  /** A fresh root per call: Node caches an imported server entry by its path. */
  function packaged(overrides: { manifest?: unknown; entries?: unknown; ssr?: boolean | string; withManifest?: boolean } = {}): string {
    const dir = tempDir('marmeon-prod-');
    mkdirSync(join(dir, 'dist/client/.vite'), { recursive: true });
    mkdirSync(join(dir, 'dist/server'), { recursive: true });
    writeFileSync(join(dir, 'dist/client/index.html'), '<html><head><script type="module" crossorigin src="/assets/index-a1.js"></script><!--app-head--></head><body><!--app-html--></body></html>');
    if (overrides.withManifest !== false) writeFileSync(join(dir, 'dist/client/.vite/manifest.json'), JSON.stringify(overrides.manifest ?? base));
    writeFileSync(join(dir, 'dist/client/.vite/marmeon-entries.json'), JSON.stringify(overrides.entries ?? entriesFile));
    writeFileSync(join(dir, 'dist/server/ssr.js'), 'export const render = async () => ({ html: "<p>hi</p>" });');
    if (overrides.ssr !== false) writeFileSync(join(dir, 'dist/server/ssr-status.js'), typeof overrides.ssr === 'string' ? overrides.ssr : 'export const render = async () => ({ html: "<p>status</p>" });');
    return dir;
  }

  it("preloads the app's document from the app's entry alone — the shared chunk, nothing only the package reaches", async () => {
    const html = await (await createProductionRenderer({ root: packaged() })).shell(demo, new Request('http://h/'), 'N0NCE');
    expect(html).toContain('href="/assets/Home-b2.js"');
    expect(html).not.toMatch(/pkg-status|status-lib|Index-f6/);
    expect(html).toContain('src="/assets/index-a1.js"');
    // A module the package's entry loads first is not loaded first by the app's: a page of the app that imports it preloads it.
    const shared = await (await createProductionRenderer({ root: packaged() })).shell({ ...demo, component: 'demo/Shared' }, new Request('http://h/'), 'N0NCE');
    expect(shared).toContain('href="/assets/status-lib-e5.js"');
    expect(shared).not.toMatch(/pkg-status|react-c3/);
  });

  it("renders a package's page in the package's document: its entry script with the nonce, its stylesheets, its preloads — none of the app's", async () => {
    const html = await (await createProductionRenderer({ root: packaged() })).shell(status, new Request('http://h/status'), 'N0NCE');
    expect(html).toContain('<script type="module" async crossorigin src="/assets/pkg-status-d4.js" nonce="N0NCE"></script>');
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/status-lib-e5.css" nonce="N0NCE">');
    expect(html).toContain('<link rel="stylesheet" crossorigin href="/assets/pkg-status-d4.css" nonce="N0NCE">');
    expect(html).toContain('<link rel="modulepreload" crossorigin href="/assets/react-c3.js" nonce="N0NCE">');
    expect(html).toContain('<link rel="modulepreload" href="/assets/Index-f6.js" crossorigin nonce="N0NCE">');
    expect(html).not.toMatch(/index-a1|Home-b2/);
    expect(html).not.toContain('__marmeon_csp_nonce__');
    // The nonce sits on every tag the server wrote.
    expect([...html.matchAll(/<(?:script|link)\b[^>]*>/g)].filter(([tag]) => !tag.includes('id="marmeon-page"') && !tag.includes('nonce="N0NCE"'))).toEqual([]);
  });

  it('renders the package page with the package server entry, and the app page with the app one', async () => {
    const renderer = await createProductionRenderer({ root: packaged() });
    const markup = async (page: PageObject) => String(await renderer.render(page, new Request('http://h/'), { complete: true, onError() {}, onWarning() {} }));
    expect(await markup(status)).toContain('<p>status</p>');
    expect(await markup(demo)).toContain('<p>hi</p>');
  });

  it('versions each document by its own template; a package version changes when its entry does', async () => {
    const first = await createProductionRenderer({ root: packaged() });
    expect(first.entryVersions?.get('status')).toMatch(/^[0-9a-f]{12}$/);
    expect(first.entryVersions?.get('status')).not.toBe(first.version);
    // A new build of only the package's entry leaves the app's version alone.
    const renamed = JSON.parse(JSON.stringify(base)) as typeof base;
    renamed['../pkg/client.js'].file = 'assets/pkg-status-zz.js';
    const second = await createProductionRenderer({ root: packaged({ manifest: renamed }) });
    expect(second.entryVersions?.get('status')).not.toBe(first.entryVersions?.get('status'));
    expect(second.version).toBe(first.version);
  });

  it('chooses the document by the view: a namespace without an entry is H16', async () => {
    const renderer = await createProductionRenderer({ root: packaged() });
    expect(renderer.documentOf?.('demo/Home')).toBe('app');
    expect(renderer.documentOf?.('status::Index')).toBe('status');
    expect(() => renderer.documentOf?.('nope::X')).toThrow(/^\[marmeon:H16\]/);
  });

  describe('refuses to boot with H16', () => {
    const refused = (dir: string) => createProductionRenderer({ root: dir });

    it('for a missing server entry of a package', async () => {
      await expect(refused(packaged({ ssr: false }))).rejects.toThrow(/^\[marmeon:H16\] dist\/server\/ssr-status\.js is missing/);
    });

    it('for a server entry without render', async () => {
      await expect(refused(packaged({ ssr: 'export const other = 1;' }))).rejects.toThrow(/^\[marmeon:H16\] .*does not export `render`/);
    });

    it('for a format it does not know', async () => {
      await expect(refused(packaged({ entries: { ...entriesFile, format: 2 } }))).rejects.toThrow(/^\[marmeon:H16\] .*not a list of package entries/);
    });

    it('for a client entry or a page the manifest lacks', async () => {
      await expect(refused(packaged({ entries: { ...entriesFile, entries: { status: { client: 'gone.js' } } } }))).rejects.toThrow(/^\[marmeon:H16\] .*client entry/);
      await expect(refused(packaged({ entries: { ...entriesFile, pages: { 'status::Index': 'gone.js' } } }))).rejects.toThrow(/^\[marmeon:H16\] .*lists a page/);
    });

    it('for a namespace that is none, a page of an unlisted namespace and a listing without a manifest', async () => {
      await expect(refused(packaged({ entries: { ...entriesFile, entries: { 'Not A Namespace': { client: '../pkg/client.js' } } } }))).rejects.toThrow(/^\[marmeon:H16\]/);
      await expect(refused(packaged({ entries: { ...entriesFile, pages: { 'other::Index': '../pkg/views/Index.js' } } }))).rejects.toThrow(/^\[marmeon:H16\]/);
      await expect(refused(packaged({ withManifest: false }))).rejects.toThrow(/^\[marmeon:H16\] .*needs the build's/);
    });
  });
});

describe('createProductionRenderer — an app without package entries', () => {
  const page = { component: 'demo/Home', props: {}, url: '/', version: null } as unknown as PageObject;

  it('renders the very document it always did: the built template, every entry preloaded, the version of the template', async () => {
    build('index-a1.js');
    const template = `<html><head><script src="/assets/index-a1.js"></script><!--app-head--></head><body><!--app-html--></body></html>`;
    const renderer = await createProductionRenderer({ root });
    expect(await renderer.shell(page, new Request('http://h/'), 'N0NCE')).toBe(
      '<html><head><script src="/assets/index-a1.js"></script><link rel="modulepreload" href="/assets/Home-b2.js" crossorigin nonce="N0NCE">\n' +
        `<script type="application/json" id="marmeon-page">${JSON.stringify(page)}</script>\n</head><body></body></html>`,
    );
    expect(renderer.version).toBe(createHash('sha256').update(template).digest('hex').slice(0, 12));
    // No per-entry state at all: the kernel keeps the single version, and every view is the app's.
    expect(renderer.entryVersions).toBeUndefined();
    expect(renderer.documentOf).toBeUndefined();
  });
});
