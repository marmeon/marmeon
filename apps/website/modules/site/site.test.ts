import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AGENT_SKILLS, AGENT_TOOLS } from './agents.ts';
import { CHAIN, mistakeLine } from './chain.ts';
import { DEVTOOLS_BAR_TABS, DEVTOOLS_PAGES, sampleValues } from './devtools-sample.ts';
import { FAKES } from './fakes.ts';
import { GITHUB_URL } from './links.ts';
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
/** The landing's sections in their order, the hero first: the order test and the h2 count read this one list. */
const SECTIONS = ['hero', 'principles', 'audience', 'chain', 'batteries', 'devtools', 'agents', 'secure', 'testing', 'islands', 'packages', 'start'];
const coreVersion = (JSON.parse(readFileSync(join(repo, 'packages/core/package.json'), 'utf8')) as { version: string }).version;

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});
afterAll(() => app?.close());

describe('the landing page', () => {
  it('answers / rendered on the server, with one h1, two buttons and the install line', async () => {
    const response = await app.get('/', document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(response.body).toContain('<span class="hero-line">Typed end to end.</span> <span class="hero-line serif-accent">Batteries included.</span>');
    expect(response.body).toMatch(/<a [^>]*class="button button--sand"[^>]*href="\/docs\/installation"|<a [^>]*href="\/docs\/installation"[^>]*class="button button--sand"/);
    expect(response.body).toMatch(/<a [^>]*href="\/docs"[^>]*class="button button--ghost"|<a [^>]*class="button button--ghost"[^>]*href="\/docs"/);
  });

  it('shows the release link, two buttons, the install line, the three files, the rail and the props error in the hero, with nothing that needs JavaScript', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="hero stage');
    const end = body.indexOf('</section>', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const hero = body.slice(start, end);
    const escaped = coreVersion.replaceAll(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    expect(hero).toMatch(new RegExp(`<a class="hero-release" href="https://github\\.com/marmeon/marmeon/releases/tag/v${escaped}" rel="noopener"><span class="hero-release-version">${escaped}</span>`));
    expect(hero).toContain('<code>pnpm create marmeon my-app</code>');
    expect(hero).toMatch(/<p class="hero-facts">[^<]*MIT licence[^<]*<\/p>/);
    expect(hero).not.toContain('release in preparation');
    const cards = [['migration', 'migrationColumns'], ['controller', 'controller'], ['props', 'page']] as const;
    expect([...hero.matchAll(/<figure class="hero-card hero-card--(\w+)"/g)].map((match) => match[1])).toEqual(cards.map(([step]) => step));
    for (const [step, name] of cards) {
      const title = CHAIN.find((candidate) => candidate.id === step)!.title;
      expect(hero, step).toContain(`<span class="hero-card-file">${SNIPPETS[name].file}</span><span class="hero-card-tag">${title}</span>`);
    }
    const rail = hero.slice(hero.indexOf('<ol class="hero-rail"'), hero.indexOf('</ol>'));
    expect([...rail.matchAll(/<li class="([^"]*)"><span class="hero-rail-dot"><\/span>([^<]*)<\/li>/g)].map((match) => match[2])).toEqual(CHAIN.map((step) => step.title));
    expect([...rail.matchAll(/<li class="([^"]*is-error[^"]*)"><span class="hero-rail-dot"><\/span>([^<]*)<\/li>/g)].map((match) => match[2])).toEqual(['Props']);
    expect(hero).not.toContain('<button');
    expect(hero).not.toContain('copy-button');
    const props = CHAIN.find((step) => step.id === 'props')!;
    expect(hero).toMatch(/<div class="hero-error" role="note"/);
    expect(textOf(hero.slice(hero.indexOf('class="hero-error"')))).toContain(`${mistakeLine(props)}error ${props.error.code}: ${props.error.message}`);
    expect(hero).not.toMatch(/<h[2-6]/);
    expect(hero).not.toContain('role="tablist"');
  });

  it('counts the stats under the hero from the code: packages, fakes and MCP tools', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<dl class="stats"');
    const stats = body.slice(start, body.indexOf('</dl>', start));
    expect(start).toBeGreaterThan(-1);
    const pairs = [...stats.matchAll(/<dt>([^<]*)<\/dt><dd>(\d+)<\/dd>/g)].map(([, label, value]) => [label, Number(value)]);
    expect(pairs).toEqual([
      ['packages, released as one version', PACKAGES.length],
      ['typos the compiler catches, from the migration to the form error', CHAIN.length],
      ['fakes that come with createTestApp()', FAKES.length],
      ['MCP tools your coding agent can call', AGENT_TOOLS.length],
    ]);
  });

  it('lists the seven principles with their numerals and the seven steps of the chain', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body.match(/<li class="principle"/g)).toHaveLength(7);
    expect(body).toContain('<h2 id="principles-title"');
    expect(textOf(body.slice(body.indexOf('<h2 id="principles-title"'), body.indexOf('</h2>', body.indexOf('<h2 id="principles-title"'))))).toBe('Seven rules, set in stone.');
    const principles = body.slice(body.indexOf('<ol class="principle-list"'), body.indexOf('</ol>', body.indexOf('<ol class="principle-list"')));
    expect([...principles.matchAll(/<span class="principle-numeral" aria-hidden="true">([^<]*)<\/span><h3>([^<]*)<\/h3>/g)].map((match) => [match[1], match[2]])).toEqual([
      ['I', 'Typed end to end'],
      ['II', 'No global state'],
      ['III', 'TypeScript runs natively on Node'],
      ['IV', 'Modules first'],
      ['V', 'One endpoint, one class'],
      ['VI', 'Batteries included, behind contracts'],
      ['VII', 'Secure by default'],
    ]);
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
    const headings = [...section.matchAll(/<h3 class="tabs-heading">(.*?)<\/h3>/g)].map((match) => textOf(match[1]!));
    expect(headings).toEqual(CHAIN.map((step, index) => `${index + 1} / ${CHAIN.length} ${step.title}`));
    for (const href of ['/docs/migrations', '/docs/queries#table-types', '/docs/queries', '/docs/routing#route-model-binding', '/docs/routing', '/docs/pages', '/docs/forms']) expect(section, href).toContain(`href="${href}"`);
    expect(section.match(/This does not compile/g)).toHaveLength(CHAIN.length);
    // Each step reads on its own without JavaScript: its file name, a line of its code, its mistake and its docs link.
    const steps = section.split('<li class="chain-step"').slice(1);
    expect(steps).toHaveLength(CHAIN.length);
    const docs = ['/docs/migrations', '/docs/queries#table-types', '/docs/queries', '/docs/routing#route-model-binding', '/docs/routing', '/docs/pages', '/docs/forms'];
    CHAIN.forEach((step, index) => {
      const snippet = SNIPPETS[step.snippet] as { file?: string; source: { app?: string; repo?: string }; code: string };
      const file = snippet.file ?? snippet.source.app ?? snippet.source.repo;
      const markup = steps[index]!;
      expect(markup, step.id).toContain(`<h4 class="editor-name">${file}</h4>`);
      const line = snippet.code.split('\n').find((candidate) => candidate.trim() !== '')!.trim();
      expect(textOf(markup), step.id).toContain(line);
      expect(markup, step.id).toContain(`href="${docs[index]}"`);
      expect(markup, step.id).toContain('This does not compile');
    });
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
    expect(body).toContain('<section class="audience landing-light" aria-labelledby="audience-title"');
    expect(body).toContain('<h2 id="audience-title"');
    const [principles, audience, chain] = ['principles-title', 'audience-title', 'chain-title'].map((id) => body.indexOf(`id="${id}"`)) as [number, number, number];
    expect(principles).toBeGreaterThan(-1);
    expect(principles).toBeLessThan(audience);
    expect(audience).toBeLessThan(chain);
    const section = body.slice(audience, chain);
    expect(body.match(/<li class="audience-card"/g)).toHaveLength(4);
    expect(section.match(/<dt class="visually-hidden">You know this<\/dt>/g)).toHaveLength(4);
    expect(section.match(/With Marmeon<\/dt>/g)).toHaveLength(4);
    expect(section.match(/<h3>/g)).toHaveLength(4);
    for (const href of ['/docs/installation#running-the-app', '/docs/structure', '/docs/authorization', '/docs/authorization#every-route-decides']) expect(section, href).toContain(`href="${href}"`);
    expect(section).toContain('Not the right fit');
  });

  it('points to the community from the footer', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const footer = body.slice(body.indexOf('<footer')).replaceAll('<!-- -->', '');
    expect(footer).toContain('<a href="https://discord.gg/Kv9hvscd9" rel="noopener">Discord</a>');
    expect(footer).toContain('<a href="https://github.com/marmeon/marmeon/discussions" rel="noopener">discussion on GitHub</a>');
  });

  it('shows the island section with its code and, without JavaScript, only the fallback', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<section class="islands duo-card" aria-labelledby="islands-title"');
    expect(body.indexOf('id="islands-title"')).toBeLessThan(body.indexOf('id="start-title"'));
    const section = body.slice(body.indexOf('<section class="islands '), body.indexOf('<section class="packages'));
    expect(section).toContain('<div class="island-frame" data-island="site.render-clock"');
    expect(section).toContain('With JavaScript, the browser loads an island here: a part of the page the server renders on its own.');
    expect(section).toContain('<h3 class="tabs-heading">ShowRenderClockController.ts</h3>');
    expect(section).toContain('<h3 class="tabs-heading">IslandSection.tsx</h3>');
    expect(section.indexOf('island-stage')).toBeGreaterThan(section.indexOf('<h3 class="tabs-heading">IslandSection.tsx</h3>'));
    expect(section).not.toContain('<h4');
    expect(section).toContain('IslandSection.tsx');
    // `load="visible"`: the server renders the fallback only, never the island's answer.
    const frame = section.slice(section.indexOf('data-island="site.render-clock"'), section.indexOf('</div></div>', section.indexOf('data-island="site.render-clock"')));
    expect(frame).toContain('island-fallback');
    expect(frame).not.toContain('<time');
    expect(frame).not.toContain('Rendered on the server');
  });

  it('orders the sections from the hero to the start', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const ids = SECTIONS.map((name) => `${name}-title`);
    const positions = ids.map((id) => body.indexOf(`id="${id}"`));
    expect(positions.every((position) => position > -1), ids.join()).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(ids.length);
  });

  it('names every section after the hero by its h2, and counts the h2s from that list', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const sections = SECTIONS.slice(1);
    for (const name of sections) {
      expect(body, name).toMatch(new RegExp(`<section class="${name}[ "][^>]*aria-labelledby="${name}-title"`));
      expect(body, name).toMatch(new RegExp(`<h2 id="${name}-title"`));
    }
    expect(body.match(/<h2[ >]/g)).toHaveLength(sections.length);
    expect(body).not.toContain('<section class="modules"');
  });

  it('puts the agents section after the devtools and before the secure section', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toMatch(/<section class="agents" aria-labelledby="agents-title"/);
    expect(body.indexOf('id="devtools-title"')).toBeLessThan(body.indexOf('id="agents-title"'));
    expect(body.indexOf('id="agents-title"')).toBeLessThan(body.indexOf('id="secure-title"'));
    const section = body.slice(body.indexOf('<section class="agents"'), body.indexOf('<section class="secure '));
    expect(textOf(section)).toContain('Your coding agent sees what you see.');
    expect(section).toContain('href="/docs/agents"');
    expect(section).toContain('href="/docs/mcp"');
    expect(section).toContain('<samp class="terminal-output">✓ Wrote .mcp.json.');
    expect(section).not.toContain('<span class="prompt" aria-hidden="true">$ </span>✓');
    // The two lists name their counts, taken from agents.ts, and show every entry.
    const text = section.replaceAll('<!-- -->', '');
    expect(text).toContain(`Skills <span>${AGENT_SKILLS.length}</span>`);
    expect(text).toContain(`MCP tools <span>${AGENT_TOOLS.length}</span>`);
    for (const { name } of [...AGENT_SKILLS, ...AGENT_TOOLS]) expect(text, name).toContain(`<code>${name}</code>`);
    expect(text.match(/<li><code>/g)).toHaveLength(AGENT_SKILLS.length + AGENT_TOOLS.length);
  });

  it('shows the six protections of the secure section, each with the page that backs it, and a link to the overview', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="secure ');
    const section = body.slice(start, body.indexOf('<div class="landing-tail"'));
    expect(start).toBeGreaterThan(body.indexOf('id="agents-title"'));
    expect(section).toContain('<a href="/docs/security" class="secure-overview">Security overview</a>');
    const items = section.split('<li>').slice(1);
    expect(items).toHaveLength(6);
    expect(items.map((item) => /<h3>([^<]*)<\/h3>/.exec(item)?.[1])).toEqual([
      'Fails closed',
      'CSRF protection',
      'Strict Content-Security-Policy',
      'Signed-in pages are never cached',
      'Page data stays out of browser storage',
      'Devtools only in development',
    ]);
    const hrefs = items.map((item) => /<a href="([^"]*)"/.exec(item)?.[1]);
    expect(hrefs).toEqual(['/docs/security#the-environment-decides-and-fails-closed', '/docs/csrf', '/docs/csp', '/docs/authentication#signed-in-pages-are-never-cached', '/docs/navigation#what-the-history-holds', '/docs/security#development-routes']);
    for (const item of items) expect(item).toMatch(/<span class="protection-icon" aria-hidden="true"><svg[^>]*><path d="[^"]+"><\/path><\/svg><\/span>/);
    expect(section).not.toMatch(/\sstyle=/);
  });

  it('shows the testing card with its snippet and the fakes from the list, beside the islands card', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="testing duo-card"');
    const section = body.slice(start, body.indexOf('<section class="islands '));
    expect(start).toBeGreaterThan(body.indexOf('id="secure-title"'));
    expect(section).toContain(`<span class="code-caption">${SNIPPETS.test.file}</span>`);
    const squash = (text: string) => text.replaceAll(/\s+/g, ' ').trim();
    expect(squash(textOf(section))).toContain(squash(SNIPPETS.test.code));
    // Both cards stand side by side in one frame of the white band.
    const tail = body.indexOf('<div class="landing-tail">');
    const frame = body.indexOf('<div class="landing-inner landing-tail-frame">', tail);
    expect(tail).toBeGreaterThan(body.indexOf('id="secure-title"'));
    expect(frame).toBe(tail + '<div class="landing-tail">'.length);
    expect(start).toBeGreaterThan(frame);
    expect(body.indexOf('<section class="islands duo-card"')).toBeGreaterThan(start);
    expect(body.indexOf('<section class="islands duo-card"')).toBeLessThan(body.indexOf('<section class="packages'));
    expect([...section.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1])).toEqual([...FAKES]);
    expect(section).toContain('href="/docs/testing-pages"');
    expect(section).toContain('href="/docs/fakes"');
  });

  it('ends with the three commands, the installation guide, GitHub and three places to read next', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="start stage stage--veins-band"');
    expect(start).toBeGreaterThan(body.indexOf('id="packages-title"'));
    const section = body.slice(start, body.indexOf('</section>', start));
    expect(section).toMatch(/<a [^>]*class="button button--sand"[^>]*href="\/docs\/installation"|<a [^>]*href="\/docs\/installation"[^>]*class="button button--sand"/);
    expect(section).toContain('Read the installation guide');
    expect(section).toContain(`<a class="button button--ghost" href="${GITHUB_URL}" rel="noopener">Star on GitHub</a>`);
    expect([...section.matchAll(/<span class="terminal-line">.*?<\/span>([^<]*)</g)].map((match) => match[1]!.trim())).toEqual(['pnpm create marmeon my-app', 'cd my-app', 'pnpm dev']);
    expect(section).not.toContain('Ready on');
    const nav = section.slice(section.indexOf('<nav aria-label="Start reading">'));
    expect([...nav.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1])).toEqual(['/docs/installation', '/docs/structure', '/docs/routing']);
    expect(section).not.toMatch(/\sstyle=/);
  });

  it('shows the nine batteries as cards, each with its checked code, its package and its docs link', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="batteries');
    const section = body.slice(start, body.indexOf('<div class="landing-band'));
    expect(section).toContain('aria-labelledby="batteries-title"');
    expect(section).not.toContain('tabs-heading');
    const titles = [...section.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(titles).toEqual(['Auth and policies', 'Database', 'Migrations', 'Validation', 'Queue', 'Mail', 'Scheduler', 'Storage', 'Modules']);
    expect(section.match(/<article class="card battery/g)).toHaveLength(9);
    // h2 > h3 (the card) > h4 (the file): no level is skipped.
    expect([...section.matchAll(/<h([1-6])[ >]/g)].map((match) => match[1]).join('')).toBe(`2${'34'.repeat(9)}`);
    const files = Object.keys(SNIPPETS).filter((key) => key.startsWith('battery')).map((name) => (SNIPPETS[name as keyof typeof SNIPPETS] as { file: string }).file);
    expect(files).toHaveLength(9);
    // The cards stand in the order of the snippets, each with its file name as an h4.
    expect([...section.matchAll(/<h4 class="editor-name">([^<]*)<\/h4>/g)].map((match) => match[1])).toEqual(files);
    const packages = [...section.matchAll(/<p class="battery-foot"><code>([^<]*)<\/code>/g)].map((match) => match[1]!);
    // The package each card names is the one its code comes from.
    expect(packages).toEqual(['@marmeon/auth', '@marmeon/database', '@marmeon/database', '@marmeon/validation', '@marmeon/queue', '@marmeon/mail', '@marmeon/scheduler', '@marmeon/storage', '@marmeon/core']);
    for (const name of packages) expect(PACKAGES.map((entry) => entry.name), name).toContain(name);
    const heads = [...section.matchAll(/<div class="battery-head"><h3>([^<]*)<\/h3><p>([^<]+)<\/p><\/div>/g)];
    expect(heads.map((match) => match[1])).toEqual(titles);
    for (const match of heads) expect(match[2]!.trim().length, match[1]).toBeGreaterThan(20);
    // The link at the foot of each card, in the order of the cards.
    expect([...section.matchAll(/<p class="battery-foot">.*?<a [^>]*href="([^"]*)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])).toEqual([
      ['Authorization', '/docs/authorization'],
      ['Transactions', '/docs/transactions'],
      ['Migrations', '/docs/migrations'],
      ['Validation', '/docs/validation'],
      ['Queues', '/docs/queues'],
      ['Mail', '/docs/mail'],
      ['Task scheduling', '/docs/scheduling'],
      ['File storage', '/docs/storage'],
      ['Modules and discovery', '/docs/modules#discovery'],
    ]);
    expect(section).toContain('aria-label="Files of the notes module"');
    expect(textOf(section)).toContain('pnpm add -E @marmeon/redis@<version of your app>');
    expect(textOf(section)).toContain('An installed package registers itself');
    expect(textOf(section)).not.toContain('pnpm add @marmeon/redis');
    expect(section).toContain('Installed packages register themselves');
    for (const href of ['/docs/authorization', '/docs/transactions', '/docs/migrations', '/docs/validation', '/docs/queues', '/docs/mail', '/docs/scheduling', '/docs/storage', '/docs/modules#discovery']) {
      expect(section, href).toContain(`href="${href}"`);
    }
    expect(section).not.toMatch(/\sstyle=/);
  });

  it('lists every package of the repository once, in three groups with their counts, after the testing and islands and before the start', async () => {
    const dirs = readdirSync(join(repo, 'packages'), { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(repo, 'packages', entry.name, 'package.json')));
    // The landing page lists what an app can install: a private package is not published yet.
    const manifests = dirs.map((entry) => JSON.parse(readFileSync(join(repo, 'packages', entry.name, 'package.json'), 'utf8')) as { name: string; private?: boolean });
    const names = manifests.filter((manifest) => manifest.private !== true).map((manifest) => manifest.name);
    expect(PACKAGES.map((entry) => entry.name).sort()).toEqual(names.sort());
    expect(new Set(PACKAGES.map((entry) => entry.docs)).size).toBe(PACKAGES.length);
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="packages');
    const end = body.indexOf('</section>', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(body.indexOf('id="islands-title"'));
    expect(end).toBeLessThan(body.indexOf('<section class="start '));
    const list = body.slice(start, end);
    expect(textOf(list.slice(list.indexOf('<h2'), list.indexOf('</h2>')))).toBe(`${PACKAGES.length} packages, one version.`);
    for (const { name, docs } of PACKAGES) {
      expect(list.match(new RegExp(`<a [^>]*href="/docs/${docs}"`, 'g')), name).toHaveLength(1);
      expect(list, name).toContain(name.startsWith('@marmeon/') ? `<span class="package-scope">@marmeon/</span>${name.slice(9)}</code>` : `${name}</code>`);
    }
    expect(list.match(/<li><a /g)).toHaveLength(PACKAGES.length);
    const text = list.replaceAll('<!-- -->', '');
    const groups = text.split('<h3 class="package-group-title">').slice(1);
    expect(groups).toHaveLength(3);
    const expected = [
      ['In every new app', 'app'],
      ['Add when you need it', 'add'],
      ['Dev tools', 'tooling'],
    ] as const;
    expected.forEach(([title, group], index) => {
      const markup = groups[index]!;
      const members = PACKAGES.filter((entry) => entry.group === group).map((entry) => entry.name);
      expect(markup, title).toMatch(new RegExp(`^${title} <span>${members.length}</span></h3>`));
      const named = [...markup.matchAll(/<li><a [^>]*><code>(?:<span class="package-scope">@marmeon\/<\/span>)?([^<]*)<\/code>/g)].map((match) => match[1]);
      expect(named, title).toEqual(members.map((name) => name.replace('@marmeon/', '')));
    });
    expect(groups[2]).toContain("@marmeon/vite, @marmeon/testing and @marmeon/devtools are in every new app&#x27;s dev dependencies; create-marmeon starts a new app.");
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
    expect(props.site).toEqual({ version: coreVersion, license: 'MIT', origin: 'http://localhost', menu: expect.any(Array) });
    expect((props.site as { menu: { label: string }[] }).menu.map((panel) => panel.label)).toEqual(['Framework', 'Packages', 'Resources']);
    expect(props).not.toHaveProperty('nav');
    const docs = (await app.navigating().get('/docs/routing').assertOk()).page()!.props;
    expect(docs).toHaveProperty('nav');
    expect(docs.site).toMatchObject({ version: coreVersion, license: 'MIT', origin: 'http://localhost' });
  });

  it('answers a revalidation with 304', async () => {
    const etag = (await app.get('/', document).assertOk()).headers.get('etag')!;
    const again = await app.get('/', { headers: { accept: 'text/html', 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });
});

describe('the shared chrome', () => {
  it('renders the stage header: the search trigger, the buttons, the menus; no shortcut hint on the server', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).toContain('<a class="skip-link" href="#content">');
    const header = body.slice(body.indexOf('<header class="site-header stage"'), body.indexOf('</header>'));
    expect(header).toMatch(/<nav aria-label="Main"[^>]*>.*href="\/docs".*<\/nav>/);
    expect(header).toMatch(/<a [^>]*href="\/docs\/search"[^>]*data-search-trigger="true"[^>]*aria-keyshortcuts="Control\+K Meta\+K"|<a [^>]*aria-keyshortcuts="Control\+K Meta\+K"[^>]*data-search-trigger="true"[^>]*href="\/docs\/search"/);
    expect(header).toMatch(/<a [^>]*href="https:\/\/github\.com\/marmeon\/marmeon"[^>]*>GitHub<\/a>/);
    expect(header).toMatch(/<a [^>]*href="\/docs\/installation"[^>]*class="button button--sand"[^>]*>Get started<\/a>|<a [^>]*class="button button--sand"[^>]*href="\/docs\/installation"[^>]*>Get started<\/a>/);
    expect(header).toContain('<details class="site-menu"');
    expect(header).not.toContain('<kbd');
    expect(header).not.toContain('version-badge');
    expect(header).not.toContain('style=');
  });

  it('opens the mega menu panels without JavaScript: closed <details> with real targets, one group so that opening one closes the others', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const nav = body.slice(body.indexOf('<nav aria-label="Main"'), body.indexOf('</nav>'));
    expect(nav.match(/<details class="site-panel" name="site-panel">/g)).toHaveLength(3);
    for (const label of ['Framework', 'Packages', 'Resources']) expect(nav).toMatch(new RegExp(`<summary>${label}<svg`));
    for (const href of ['/docs/why-marmeon', '/docs/modules', '/docs/upgrading', '/docs/installation', '/docs/packages']) expect(nav).toContain(`href="${href}"`);
    expect(nav).not.toContain('<details class="site-panel" name="site-panel" open');
    // Only what the site has: the Resources panel's targets, and none of the design's Blog, Guides or Discord.
    const titles = [...nav.matchAll(/<span class="site-panel-item-title">([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(titles).toContain('Upgrade Guide');
    expect(titles).toContain('GitHub Discussions');
    expect(nav).not.toMatch(/Blog|Guides|Discord/);
  });

  it('folds the same targets into the phone menu: groups, every desktop package once, /docs once', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<nav aria-label="Menu"');
    const menu = body.slice(start, body.indexOf('</nav>', start));
    expect([...menu.matchAll(/<p class="site-menu-title">([^<]*)<\/p>/g)].map((match) => match[1])).toEqual(['Framework', 'Packages', 'Resources', 'More']);
    const desktop = body.slice(body.indexOf('<nav aria-label="Main"'), body.indexOf('</nav>'));
    const packages = [...desktop.matchAll(/<span class="site-panel-item-title">(@marmeon\/[a-z]+)<\/span>/g)].map((match) => match[1]!);
    expect(packages).toHaveLength(11);
    const group = menu.slice(menu.indexOf('Packages</p>'), menu.indexOf('Resources</p>'));
    for (const name of packages) expect(group, name).toContain(`>${name}</a>`);
    expect(menu.match(/href="\/docs"/g)).toHaveLength(1);
    expect(menu).toContain('data-search-trigger');
  });

  it('renders the footer with its three columns and the legal line', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const footer = body.slice(body.indexOf('<footer')).replaceAll('<!-- -->', '');
    expect(footer).toContain('<nav aria-label="Footer"');
    for (const title of ['Framework', 'Community', 'Legal']) expect(footer).toContain(`<p class="site-footer-title">${title}</p>`);
    for (const href of ['/docs', '/docs/packages', '/docs/releases', '/docs/security-policy', '/imprint', '/privacy', 'https://github.com/marmeon/marmeon/blob/main/LICENSE', 'https://github.com/marmeon/marmeon/discussions'])
      expect(footer).toContain(`href="${href}"`);
    expect(footer).toContain('MIT licence');
    expect(footer).toContain('<a href="https://bespokecode.de" rel="noopener">BespokeCode</a>');
    expect(footer).not.toContain('nofollow');
    expect(footer).toContain('<a href="https://discord.gg/Kv9hvscd9" rel="noopener">Discord</a>');
    expect(footer).toContain('Made with <span role="img" aria-label="love">❤️</span> in Munich');
  });

  it('renders no copy button on the server: it appears with JavaScript only', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    expect(body).not.toContain('copy-button');
    expect(body).not.toContain('aria-live');
  });

  it('gives an unknown path the header and footer: flat links, no mega menu (it has no shared props)', async () => {
    const response = await app.get('/nothing-here', document);
    expect(response.status).toBe(404);
    expect(response.body).toContain('class="site-header stage"');
    expect(response.body).toContain('class="site-footer stage"');
    const nav = response.body.slice(response.body.indexOf('<nav aria-label="Main"'), response.body.indexOf('</nav>'));
    expect(nav).toContain('href="/docs/packages"');
    expect(nav).toContain('href="/docs"');
    expect(response.body).toContain('data-search-trigger');
    expect(response.body).not.toContain('site-panel');
  });

  it('keeps the docs layout for the docs pages', async () => {
    const body = (await app.get('/docs/routing', document).assertOk()).body;
    expect(body).toContain('class="shell"');
    expect(body).not.toContain('class="site-header stage"');
  });
});
