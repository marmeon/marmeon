import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageObject } from '@marmeon/http';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createProductionRenderer } from './production.ts';

// Builds a fixture app against the real `packages/http/dist` — run `pnpm build` first, as the bundle-size test needs.
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const vitePackage = dirname(createRequire(import.meta.url).resolve('vite/package.json'));

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

const root = tempDir('marmeon-preloads-');
const cdnRoot = tempDir('marmeon-preloads-cdn-');

/** Builds the fixture app into `root`; `base` is Vite's, absent for its default. */
function buildFixture(root: string, base?: string): void {
  write(root, {
    'package.json': JSON.stringify({ name: 'fixture', private: true, type: 'module' }),
    'index.html': '<!doctype html><html><head><!--app-head--></head><body><div id="app"><!--app-html--></div></body></html>',
    'bootstrap/client.ts': [
      "import './entry.css';",
      "import pages from 'virtual:marmeon/pages';",
      "import { loadHistoryFallback, loadTabSync } from '@marmeon/http/client/adapter';",
      'const navigation = (window as { navigation?: unknown }).navigation;',
      'void loadTabSync();',
      'if (!navigation) void loadHistoryFallback();',
      'for (const load of Object.values(pages)) void load();',
    ].join('\n'),
    'bootstrap/entry.css': '@layer base, marmeon;\n.entry-rule { color: rgb(7, 8, 9); }\n',
    'bootstrap/ssr.ts': 'export const render = async () => ({ html: "" });\n',
    'modules/demo/components/Shared.tsx': "import './shared.css';\nexport const shared = 'shared chunk content';\n",
    'modules/demo/components/OnlyHome.tsx': "export const onlyHome = 'only on home';\n",
    'modules/demo/components/shared.css': '.shared-rule { color: rgb(1, 2, 3); }\n',
    'modules/demo/views/home.css': '.home-rule { color: rgb(4, 5, 6); }\n',
    'modules/demo/views/Home.tsx': "import './home.css';\nimport { onlyHome } from '../components/OnlyHome.tsx';\nimport { shared } from '../components/Shared.tsx';\nexport default `home ${shared} ${onlyHome}`;\n",
    'modules/demo/views/Other.tsx': "import { shared } from '../components/Shared.tsx';\nexport default `other ${shared}`;\n",
    'vite.config.ts': [
      "import { marmeon } from '@marmeon/vite';",
      `export default { ${base === undefined ? '' : `base: ${JSON.stringify(base)}, `}plugins: [marmeon({ entries: { client: 'bootstrap/client.ts', ssr: 'bootstrap/ssr.ts' } })] };`,
    ].join('\n'),
  });
  mkdirSync(join(root, 'node_modules/@marmeon'), { recursive: true });
  symlinkSync(vitePackage, join(root, 'node_modules/vite'), 'dir');
  symlinkSync(join(repo, 'packages/vite'), join(root, 'node_modules/@marmeon/vite'), 'dir');
  symlinkSync(join(repo, 'packages/http'), join(root, 'node_modules/@marmeon/http'), 'dir');

  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV' || key === 'NODE_OPTIONS') delete env[key];
  const result = spawnSync(process.execPath, [join(repo, 'packages/cli/bin/marmeon.js'), 'build', '--no-typecheck'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  expect(`${result.stdout}${result.stderr}`).toContain('Built dist/client and dist/server');
  expect(result.status).toBe(0);
}

describe('preloads against a real build', { timeout: 60_000 }, () => {
  beforeAll(() => buildFixture(root), 60_000);

  const page = (component: string) => ({ component, props: {}, url: '/', version: null }) as unknown as PageObject;

  /** The `href`s of the modulepreload tags the server added, each with the tag's full text. */
  async function preloads(component: string): Promise<{ hrefs: string[]; tags: string[] }> {
    const html = await (await createProductionRenderer({ root })).shell(page(component), new Request('http://h/'), 'N0NCE');
    const tags = html.match(/<link rel="modulepreload"[^>]*>/g) ?? [];
    return { tags, hrefs: tags.map((tag) => /href="([^"]+)"/.exec(tag)![1]!) };
  }

  const names = (hrefs: string[]) => hrefs.map((href) => href.replace(/^\/assets\//, '').replace(/-[\w-]{8}\.js$/, ''));

  it('preloads a page, the chunks it shares or owns, and tab sync — once each, with the nonce', async () => {
    const { hrefs, tags } = await preloads('demo/Home');
    const found = names(hrefs);
    // `history` is the chunk tab sync shares with history-fallback: tab sync needs it, so it is preloaded with it.
    expect([...found].sort()).toEqual(['Home', 'Shared', 'history', 'tab-sync']);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const tag of tags) expect(tag).toContain('nonce="N0NCE"');
    expect(readFileSync(join(root, 'dist/client', hrefs[0]!), 'utf8')).toContain('only on home');
    for (const href of hrefs) expect(existsSync(join(root, 'dist/client', href))).toBe(true);
    // The entry and its vendor chunk are the template's; history-fallback loads only without the Navigation API.
    expect(found.some((name) => /^(index|vendor|rolldown-runtime|history-fallback)$/.test(name))).toBe(false);
  });

  it('links the stylesheets of a page and of the chunks it shares in the first document, after the entry\'s', async () => {
    const html = await (await createProductionRenderer({ root })).shell(page('demo/Home'), new Request('http://h/'), 'N0NCE');
    const links = (html.match(/<link rel="stylesheet"[^>]*>/g) ?? []).filter((link) => !link.includes('/assets/index-'));
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toContain('nonce="N0NCE"');
    const css = links.map((link) => readFileSync(join(root, 'dist/client', /href="([^"]+)"/.exec(link)![1]!), 'utf8'));
    expect(css[0]).toContain('.shared-rule');
    expect(css[1]).toContain('.home-rule');
    // The entry's stylesheet declares the layer order: it comes before every page stylesheet.
    const entryLink = html.indexOf('<link rel="stylesheet" crossorigin href="/assets/index-');
    expect(entryLink).toBeGreaterThan(-1);
    expect(entryLink).toBeLessThan(html.indexOf(links[0]!));
    const other = await (await createProductionRenderer({ root })).shell(page('demo/Other'), new Request('http://h/'));
    expect(other.match(/<link rel="stylesheet"/g)).toHaveLength(2); // the entry's and the shared one
  });

  it('leaves out what another page owns', async () => {
    const { hrefs } = await preloads('demo/Other');
    const found = names(hrefs);
    const hrefOf = (name: string) => hrefs.find((href) => href.startsWith(`/assets/${name}-`))!;
    expect([...found].sort()).toEqual(['Other', 'Shared', 'history', 'tab-sync']);
    // A module only one page imports is part of that page's chunk (OnlyHome is in Home's, not in Other's).
    const chunk = (name: string) => readFileSync(join(root, 'dist/client', hrefOf(name)), 'utf8');
    expect(chunk('Other')).not.toContain('only on home');
  });

  it('links chunks and stylesheets under a URL base, and nothing under / besides', async () => {
    buildFixture(cdnRoot, 'https://cdn.example/app/');
    const html = await (await createProductionRenderer({ root: cdnRoot })).shell(page('demo/Home'), new Request('http://h/'), 'N0NCE');
    const hrefs = [...html.matchAll(/<link rel="(?:modulepreload|stylesheet)"[^>]*href="([^"]+)"/g)].map((match) => match[1]!);
    // The entry's stylesheet is the template's own; the page's two and the page's chunks are the server's.
    expect(hrefs.length).toBeGreaterThanOrEqual(6);
    for (const href of hrefs) expect(href.startsWith('https://cdn.example/app/assets/')).toBe(true);
    expect(html).not.toMatch(/href="\/assets\//);
    for (const href of hrefs) expect(existsSync(join(cdnRoot, 'dist/client', href.slice('https://cdn.example/app/'.length)))).toBe(true);
  });
});
