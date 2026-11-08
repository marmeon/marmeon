import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { CHAIN, mistakeLine } from './chain.ts';
import { DEVTOOLS_BAR_TABS, DEVTOOLS_PAGES, sampleValues } from './devtools-sample.ts';
import { PACKAGES } from './packages.ts';
import { SNIPPETS } from './snippets.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

/** The text of some markup: tags cut, entities turned back. */
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, '')
    .replaceAll(/&(?:lt|#x3C);/gi, '<')
    .replaceAll(/&(?:gt|#x3E);/gi, '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll(/&(?:amp|#x26);/gi, '&');

const repo = resolve(import.meta.dirname, '../../../..');
const document = { headers: { accept: 'text/html' } };
const coreVersion = (JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')) as { version: string }).version;

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});
afterAll(() => app?.close());

describe('the landing page', () => {
  it('answers / rendered on the server, with one h1 and the three ways in', async () => {
    const response = await app.get('/', document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(response.body).toContain('<span class="hero-line">Typed end to end.</span> <span class="hero-line">Batteries included.</span>');
    expect(response.body).toMatch(/<a [^>]*class="button"[^>]*href="\/docs\/installation"|<a [^>]*href="\/docs\/installation"[^>]*class="button"/);
    expect(response.body).toMatch(/<a [^>]*href="\/docs"[^>]*class="button button--secondary"|<a [^>]*class="button button--secondary"[^>]*href="\/docs"/);
    expect(response.body).toMatch(/<a [^>]*class="button button--text"[^>]*href="https:\/\/github\.com\/marmeon\/marmeon"/);
    expect(response.body).toContain('pnpm create marmeon my-app');
  });

  it('shows the facts and the controller beside the page in the hero, with nothing that needs JavaScript', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="hero"');
    const end = body.indexOf('</section>', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hero = body.slice(start, end);
    expect(hero).toMatch(/<p class="hero-facts">[^<]*MIT licence[^<]*<\/p>/);
    expect(hero).not.toContain('release in preparation');
    expect(hero).toContain('class="editor editor--split"');
    expect(hero).toContain('<p class="editor-name">modules/notes/controllers/ShowNoteController.ts</p>');
    expect(hero).toContain('<p class="editor-name">modules/notes/views/Show.tsx</p>');
    expect(hero).not.toMatch(/<h[3-6]/);
    expect(hero).not.toContain('role="tablist"');
  });

  it('lists the seven principles and the seven steps of the chain', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body.match(/<li class="principle"/g)).toHaveLength(7);
    expect(body.match(/<li class="chain-step"/g)).toHaveLength(7);
    const section = body.slice(body.indexOf('id="chain-title"'), body.indexOf('id="batteries-title"'));
    expect(section.match(/<h3[\s>]/g)).toHaveLength(7);
    // The step bar needs JavaScript; the server's page has no tablist and no dead button.
    expect(section).not.toContain('role="tablist"');
    // The page shows the misspelt lines and the compiler's answers as text, whatever the markup around them.
    const text = textOf(section);
    for (const step of CHAIN) {
      expect(text, step.id).toContain(mistakeLine(step));
      expect(text, step.id).toContain(`error ${step.error.code}: ${step.error.message}`);
    }
  });

  it('hands the page every chain step with its highlighted mistake line and the compiler error from chain.ts', async () => {
    const props = (await app.navigating().get('/').assertOk().assertPage('site/Landing')).page()!.props as {
      snippets: Record<string, unknown>;
      chain: { id: string; title: string; snippet: string; file: string; mistake: string; error: unknown }[];
    };
    expect(props.chain.map((step) => step.id)).toEqual(CHAIN.map((step) => step.id));
    props.chain.forEach((step, index) => {
      expect(step.mistake, step.id).toContain('<pre class="code"');
      expect(step.mistake, step.id).not.toContain('style=');
      expect(textOf(step.mistake), step.id).toBe(mistakeLine(CHAIN[index]!));
      // The code travels once: the step names its snippet, the page looks it up.
      expect(step.snippet, step.id).toBe(CHAIN[index]!.snippet);
      expect(props.snippets[step.snippet], step.id).toBeDefined();
      expect(step.error, step.id).toEqual(CHAIN[index]!.error);
    });
  });

  it('says who Marmeon is for: four situations, each with a link to its proof, and who it does not fit', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<section class="audience" aria-labelledby="audience-title"');
    expect(body).toContain('<h2 id="audience-title"');
    const [principles, audience, chain] = ['principles-title', 'audience-title', 'chain-title'].map((id) => body.indexOf(`id="${id}"`)) as [number, number, number];
    expect(principles).toBeGreaterThan(-1);
    expect(principles).toBeLessThan(audience);
    expect(audience).toBeLessThan(chain);
    const section = body.slice(audience, chain);
    expect(body.match(/<li class="audience-card"/g)).toHaveLength(4);
    expect(section.match(/<dt>You know this<\/dt>/g)).toHaveLength(4);
    expect(section.match(/With Marmeon<\/dt>/g)).toHaveLength(4);
    expect(section.match(/<h3>/g)).toHaveLength(4);
    for (const href of ['/docs/installation#running-the-app', '/docs/structure', '/docs/authorization', '/docs/authorization#every-route-decides']) expect(section, href).toContain(`href="${href}"`);
    expect(section).toContain('Not the right fit');
  });

  it('points to the community from the start section', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.slice(body.indexOf('id="start-title"')).replaceAll('<!-- -->', '');
    expect(start).toContain('<a href="https://discord.gg/Kv9hvscd9" rel="noopener">Discord</a>');
    expect(start).toContain('<a href="https://github.com/marmeon/marmeon/discussions" rel="noopener">discussion on GitHub</a>');
  });

  it('shows the island section with its code and, without JavaScript, only the fallback', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<section class="islands" aria-labelledby="islands-title"');
    expect(body.indexOf('id="islands-title"')).toBeLessThan(body.indexOf('id="devtools-title"'));
    const section = body.slice(body.indexOf('<section class="islands"'), body.indexOf('<section class="devtools"'));
    expect(section).toContain('<div class="island-frame" data-island="site.render-clock"');
    expect(section).toContain('With JavaScript, the browser loads an island here: a part of the page the server renders on its own.');
    expect(section).toContain('<h3 class="tabs-heading">ShowRenderClockController.ts</h3>');
    expect(section).toContain('<h3 class="tabs-heading">IslandSection.tsx</h3>');
    expect(section).not.toContain('<h4');
    expect(section).toContain('IslandSection.tsx');
    // `load="visible"`: the server renders the fallback only, never the island's answer.
    const frame = section.slice(section.indexOf('data-island="site.render-clock"'), section.indexOf('</div></div>', section.indexOf('data-island="site.render-clock"')));
    expect(frame).toContain('island-fallback');
    expect(frame).not.toContain('<time');
    expect(frame).not.toContain('Rendered on the server');
  });

  it('has the six sections after the chain, each named by its heading', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    for (const name of ['batteries', 'secure', 'testing', 'islands', 'devtools', 'start']) {
      expect(body, name).toMatch(new RegExp(`<section class="${name}" aria-labelledby="${name}-title"`));
      expect(body, name).toMatch(new RegExp(`<h2 id="${name}-title"`));
    }
    expect(body.match(/<h2[ >]/g)).toHaveLength(9);
    expect(body).toContain('<nav aria-label="Start reading">');
    expect(body).not.toContain('<section class="modules"');
  });

  it('shows the nine packages as tabs, each with its code, under h3 headings of the batteries section', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="batteries"');
    const section = body.slice(start, body.indexOf('<section class="secure"'));
    expect(section).toContain('aria-labelledby="batteries-title"');
    const labels = [...section.matchAll(/<h3 class="tabs-heading">([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(labels).toEqual(['Auth', 'Database', 'Migrations', 'Validation', 'Queue', 'Mail', 'Scheduler', 'Storage', 'Modules']);
    // h2 > h3 (the tab) > h4 (the file): no level is skipped, and nothing above the tabs is a heading.
    expect([...section.matchAll(/<h([1-6])[ >]/g)].map((match) => match[1]).join('')).toBe(`2${'34'.repeat(9)}3444`);
    for (const name of Object.keys(SNIPPETS).filter((key) => key.startsWith('battery'))) {
      const { file } = SNIPPETS[name as keyof typeof SNIPPETS] as { file: string };
      expect(section, name).toContain(`<h4 class="editor-name">${file}</h4>`);
    }
    expect(section).toContain('aria-label="Files of the notes module"');
    expect(section).toContain('pnpm add @marmeon/redis');
    expect(section).toContain('Installed packages register themselves');
    for (const href of ['/docs/authorization', '/docs/queries', '/docs/migrations', '/docs/validation', '/docs/queues', '/docs/mail', '/docs/scheduling', '/docs/storage', '/docs/modules#discovery']) {
      expect(section, href).toContain(`href="${href}"`);
    }
    expect(section).not.toMatch(/\sstyle=/);
  });

  it('lists every package of the repository once, with one link each, and counts them from the list', async () => {
    const dirs = readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(repo, 'packages', entry.name, 'package.json')));
    const names = dirs.map((entry) => (JSON.parse(readFileSync(join(repo, 'packages', entry.name, 'package.json'), 'utf8')) as { name: string }).name);
    expect(PACKAGES.map((entry) => entry.name).sort()).toEqual(names.sort());
    expect(new Set(PACKAGES.map((entry) => entry.docs)).size).toBe(PACKAGES.length);
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<div class="package-list"');
    const end = body.indexOf('</section>', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const list = body.slice(start, end);
    expect(list).toContain(`>${PACKAGES.length} packages, one version</h3>`);
    for (const { name, docs } of PACKAGES) {
      expect(list.match(new RegExp(`<a [^>]*href="/docs/${docs}"`, 'g')), name).toHaveLength(1);
      expect(list, name).toContain(name.startsWith('@marmeon/') ? `<span class="package-scope">@marmeon/</span>${name.slice(9)}</code>` : `${name}</code>`);
    }
    expect(list.match(/<li><a /g)).toHaveLength(PACKAGES.length);
    for (const title of ['In every new app', 'Add when you need it', 'Tooling']) expect(list).toContain(title);
  });

  it('shows the test snippet', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('modules/notes/show.test.ts');
  });

  it('shows the devtools as a copy with sample data: every page and tab in the HTML, no link, nothing secret', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<figure class="devtools-replica"');
    expect(start).toBeGreaterThan(-1);
    const figure = body.slice(start, body.indexOf('</figure>', start));
    expect(figure).toMatch(/^<figure class="devtools-replica" aria-label="Devtools, illustration with sample data"/);
    expect(figure).not.toMatch(/<a[\s>]/);
    expect(figure).not.toMatch(/<form[\s>]/);
    for (const secret of ['password', 'secret', 'token=', 'bearer', 'cookie=', 'app_key']) expect(figure.toLowerCase(), secret).not.toContain(secret);
    expect(figure.split('[redacted]').length - 1).toBe(sampleValues().filter((value) => value.includes('[redacted]')).length);
    const text = figure.replaceAll('&amp;', '&');
    for (const name of [...DEVTOOLS_PAGES.map((page) => page.name), ...DEVTOOLS_BAR_TABS.map((tab) => tab.name)]) expect(text, name).toContain(`>${name}<`);
    expect(figure.match(/<table[\s>]/g)?.length).toBeGreaterThanOrEqual(DEVTOOLS_PAGES.length);
    const outline = [...figure.matchAll(/<h([34])[ >][^]*?<\/h\1>/g)].map((match) => Number(match[1]));
    expect(outline).toEqual([3, ...Array(6).fill(4), 3, ...Array(6).fill(4)]);
    const intro = body.slice(body.indexOf('id="devtools-title"'), start);
    expect(intro).toContain('href="/docs/devtools"');
  });

  it('highlights every snippet on the server, with classes and without a style attribute', async () => {
    const props = (await app.navigating().get('/').assertOk().assertPage('site/Landing')).page()!.props as { snippets: Record<string, { file?: string; html: string }> };
    const snippets = Object.entries(props.snippets);
    expect(snippets.map(([name]) => name)).toEqual(Object.keys(SNIPPETS));
    for (const [name, { html }] of snippets) {
      expect(html, name).toContain('<pre class="code"');
      expect(html, name).toMatch(/class="t[kyfsgcp]"/);
      expect(html, name).not.toContain('style=');
    }
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<span class="tk">export</span>');
    expect(body).not.toMatch(/<[a-z][^>]*\sstyle=/i);
  });

  it('is public: cacheable with an ETag, no cookie, a policy without a nonce', async () => {
    const response = await app.get('/', document).assertOk();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('etag')).toMatch(/^"[\w-]{27}"$/);
    expect(response.headers.get('content-security-policy')).toBe("script-src 'self'; object-src 'none'; base-uri 'self'; style-src 'self'; frame-ancestors 'none'");
    expect(response.body).not.toMatch(/<[a-z]+ [^>]*\bnonce=/);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const json = await app.navigating().get('/').assertOk();
    expect(json.headers.get('etag')).not.toBe(response.headers.get('etag'));
    for (const answer of [response, json]) {
      const vary = answer.headers.get('vary')!.toLowerCase().split(/\s*,\s*/);
      expect(vary).toEqual(expect.arrayContaining(['x-marmeon', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-version']));
    }
  });

  it('shares the framework version but not the docs navigation (the navigation belongs to the docs routes)', async () => {
    const props = (await app.navigating().get('/').assertOk().assertPage('site/Landing')).page()!.props;
    expect(props.site).toEqual({ version: coreVersion });
    expect(props).not.toHaveProperty('nav');
    const docs = (await app.navigating().get('/docs/routing').assertOk()).page()!.props;
    expect(docs).toHaveProperty('nav');
    expect(docs.site).toEqual({ version: coreVersion });
  });

  it('answers a revalidation with 304', async () => {
    const etag = (await app.get('/', document).assertOk()).headers.get('etag')!;
    const again = await app.get('/', { headers: { accept: 'text/html', 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });
});

describe('the shared chrome', () => {
  it('renders the header with the docs and GitHub links, the version badge and the footer', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<a class="skip-link" href="#content">');
    expect(body).toMatch(/<nav aria-label="Main"[^>]*>.*href="\/docs".*<\/nav>/);
    expect(body).toMatch(/<a href="https:\/\/github\.com\/marmeon\/marmeon" rel="noopener">GitHub<\/a>/);
    expect(body).toContain(`<span class="badge version-badge">${coreVersion}</span>`);
    expect(body).toContain('<details class="site-menu"');
    const footer = body.slice(body.indexOf('<footer'));
    for (const href of ['/docs', '/docs/security-policy', '/docs/releases', 'https://github.com/marmeon/marmeon/blob/main/LICENSE']) expect(footer).toContain(`href="${href}"`);
    expect(footer).toContain('MIT licence');
    const legal = footer.replaceAll('<!-- -->', '');
    expect(legal).toContain('<a href="https://bespokecode.de" rel="noopener">BespokeCode</a>');
    expect(legal).not.toContain('nofollow');
    expect(legal).toContain('<a href="https://discord.gg/Kv9hvscd9" rel="noopener">Discord</a>');
    expect(legal).toContain('Made with <span role="img" aria-label="love">❤️</span> in Munich');
  });

  it('renders no copy button on the server: it appears with JavaScript only', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).not.toContain('copy-button');
    expect(body).not.toContain('aria-live');
  });

  it('gives an unknown path the header and footer but no version badge', async () => {
    const response = await app.get('/nothing-here', document);
    expect(response.status).toBe(404);
    expect(response.body).toContain('class="site-header"');
    expect(response.body).toContain('class="site-footer"');
    expect(response.body).not.toContain('version-badge');
  });

  it('keeps the docs layout for the docs pages', async () => {
    const body = (await app.get('/docs/routing', document).assertOk()).body;
    expect(body).toContain('class="shell"');
    expect(body).not.toContain('class="site-header"');
  });
});
