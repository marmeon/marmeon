import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AGENT_SKILLS, AGENT_TOOLS } from './agents.ts';
import { CACHE, I18N, JOBS, LIVE, MAIL, NOTES_TABLE, NOTIFICATION, SCHEDULE, STORAGE } from './batteries.ts';
import { CHAIN, mistakeLine } from './chain.ts';
import { DEVTOOLS_BAR_TABS, DEVTOOLS_PAGES, sampleValues } from './devtools-sample.ts';
import { FAKES } from './fakes.ts';
import { GITHUB_URL } from './links.ts';
import { MODULE_FILES } from './module-files.ts';
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
const SECTIONS = ['hero', 'batteries', 'audience', 'chain', 'devtools', 'agents', 'secure', 'testing', 'islands', 'principles', 'packages', 'start'];
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
    expect(response.body).toContain('<span class="hero-line">The modern <span class="nowrap">full-stack</span> framework</span> <span class="hero-line serif-accent">for TypeScript.</span>');
    expect(response.body).toMatch(/<a [^>]*class="button button--sand"[^>]*href="\/docs\/installation"|<a [^>]*href="\/docs\/installation"[^>]*class="button button--sand"/);
    expect(response.body).toMatch(/<a [^>]*href="\/docs"[^>]*class="button button--ghost"|<a [^>]*class="button button--ghost"[^>]*href="\/docs"/);
  });

  it('shows the release link, the install line, the new framing, the five layers and the eight chips in the hero, with nothing that needs JavaScript', async () => {
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
    expect(textOf(hero.slice(hero.indexOf('<h1'), hero.indexOf('</h1>')))).toBe('The modern full-stack framework for TypeScript.');
    expect(textOf(hero.slice(hero.indexOf('<p class="lead">'), hero.indexOf('</p>', hero.indexOf('<p class="lead">'))))).toBe(
      'Routes, database, auth, queues, mail and pages in one TypeScript framework. One type runs from the column to the form, and every page renders on the server first.',
    );

    const from = hero.indexOf('<div class="hero-composition"');
    const last = hero.indexOf('aria-label="More batteries"');
    const diagram = hero.slice(from, hero.indexOf('</ul>', last) + '</ul>'.length);
    expect(diagram).toContain('aria-label="The layers of a Marmeon app"');
    expect(diagram).not.toContain('aria-hidden');
    const layers = diagram.slice(diagram.indexOf('<ol class="hero-layer-list"'), diagram.indexOf('</ol>'));
    expect([...layers.matchAll(/<a href="([^"]+)" class="hero-layer"><span class="hero-layer-title">([^<]*)<\/span>/g)].map((match) => [match[2], match[1]])).toEqual([
      ['Forms', '/docs/forms'],
      ['Pages', '/docs/pages'],
      ['Controllers', '/docs/controllers'],
      ['Queries', '/docs/queries'],
      ['Database', '/docs/migrations'],
    ]);
    expect(diagram).toContain('<span class="hero-thread-label">one type</span>');
    const chips = [...diagram.matchAll(/<a href="([^"]+)" class="hero-chip">([^<]*)<\/a>/g)].map((match) => [match[2], match[1]]);
    const docsOf = (name: string) => `/docs/${PACKAGES.find((entry) => entry.name === name)!.docs}`;
    expect(chips).toEqual([
      ['Auth', docsOf('@marmeon/auth')],
      ['Mail', docsOf('@marmeon/mail')],
      ['Queue', docsOf('@marmeon/queue')],
      ['Storage', docsOf('@marmeon/storage')],
      ['Scheduler', docsOf('@marmeon/scheduler')],
      ['Cache', docsOf('@marmeon/cache')],
      ['Notifications', docsOf('@marmeon/notifications')],
      ['Live', docsOf('@marmeon/live')],
    ]);
    for (const gone of ['hero-rail', 'hero-card', 'hero-error']) expect(hero, gone).not.toContain(gone);
    expect(hero).not.toContain('<button');
    expect(hero).not.toContain('copy-button');
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
    expect(textOf(body.slice(body.indexOf('<h2 id="principles-title"'), body.indexOf('</h2>', body.indexOf('<h2 id="principles-title"'))))).toBe('What Marmeon stands for.');
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
    const section = body.slice(body.indexOf('id="chain-title"'), body.indexOf('id="devtools-title"'));
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
    const [batteries, audience, chain] = ['batteries-title', 'audience-title', 'chain-title'].map((id) => body.indexOf(`id="${id}"`)) as [number, number, number];
    expect(batteries).toBeGreaterThan(-1);
    expect(batteries).toBeLessThan(audience);
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
    const section = body.slice(body.indexOf('<section class="islands '), body.indexOf('<section class="principles'));
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

  it('shows the twelve batteries as cards: the policy as code, the rest as pictures, each with its package and its docs link', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<section class="batteries');
    const section = body.slice(start, body.indexOf('</section>', start));
    expect(section).toContain('aria-labelledby="batteries-title"');
    expect(section).not.toContain('tabs-heading');
    const titles = [...section.matchAll(/<h3>([^<]*)<\/h3>/g)].map((match) => match[1]);
    expect(titles).toEqual(['Auth and policies', 'Database and migrations', 'Queue', 'Mail', 'Validation', 'Live', 'Scheduler', 'Modules', 'Storage', 'Cache', 'Notifications', 'Localization']);
    expect(section.match(/<article class="card battery/g)).toHaveLength(12);
    // The Auth card is the wide one and holds the section's only code: one window, with the policy's file as its h4.
    // Three wide cards (Auth, Live, Notifications) and nine single ones fill fifteen cells: five rows of three.
    expect([...section.matchAll(/<article class="card battery( battery--wide)?"><div class="battery-head"><h3>([^<]*)/g)].filter((match) => match[1]).map((match) => match[2])).toEqual(['Auth and policies', 'Live', 'Notifications']);
    expect(section.match(/<div role="group"[^>]*class="editor /g)).toHaveLength(1);
    expect(section.match(/class="code-block"/g)).toHaveLength(1);
    expect(section.indexOf('class="code-block"')).toBeLessThan(section.indexOf('<h3>Database and migrations</h3>'));
    expect(section.match(/<pre/g)).toHaveLength(1);
    expect(section).toMatch(/<article class="card battery battery--wide">.*?class="editor battery-editor"/);
    // h2 > h3 (the card) > h4 (the policy's file, in the first card only): no level is skipped.
    expect([...section.matchAll(/<h([1-6])[ >]/g)].map((match) => match[1]).join('')).toBe(`234${'3'.repeat(11)}`);
    expect([...section.matchAll(/<h4 class="editor-name">([^<]*)<\/h4>/g)].map((match) => match[1])).toEqual([SNIPPETS.batteryAuth.file]);
    const packages = [...section.matchAll(/<p class="battery-foot"><code>([^<]*)<\/code>/g)].map((match) => match[1]!);
    expect(packages).toEqual(['@marmeon/auth', '@marmeon/database', '@marmeon/queue', '@marmeon/mail', '@marmeon/validation', '@marmeon/live', '@marmeon/scheduler', '@marmeon/core', '@marmeon/storage', '@marmeon/cache', '@marmeon/notifications', '@marmeon/i18n']);
    for (const name of packages) expect(PACKAGES.map((entry) => entry.name), name).toContain(name);
    const heads = [...section.matchAll(/<div class="battery-head"><h3>([^<]*)<\/h3><p>([^<]+)<\/p><\/div>/g)];
    expect(heads.map((match) => match[1])).toEqual(titles);
    for (const match of heads) expect(match[2]!.trim().length, match[1]).toBeGreaterThan(20);
    expect([...section.matchAll(/<p class="battery-foot">.*?<a [^>]*href="([^"]*)"[^>]*>([^<]*)</g)].map((match) => [match[2], match[1]])).toEqual([
      ['Authorization', '/docs/authorization'],
      ['Migrations', '/docs/migrations'],
      ['Queues', '/docs/queues'],
      ['Mail', '/docs/mail'],
      ['Validation', '/docs/validation'],
      ['Real-time updates', '/docs/realtime'],
      ['Task scheduling', '/docs/scheduling'],
      ['Modules and discovery', '/docs/modules#discovery'],
      ['File storage', '/docs/storage'],
      ['Cache', '/docs/cache'],
      ['Notifications', '/docs/notifications'],
      ['Localization', '/docs/localization'],
    ]);
    // Each picture is there, with the real names the data module pins to their files.
    const article = (title: string): string => {
      const at = section.indexOf(`<h3>${title}</h3>`);
      return section.slice(at, section.indexOf('</article>', at));
    };
    expect(textOf(article('Database and migrations'))).toContain('notes');
    for (const { name, type } of NOTES_TABLE.rows) expect(textOf(article('Database and migrations')), name).toContain(`${name}${type}`);
    const queue = article('Queue');
    expect(queue).toContain('aria-label="Jobs in the queue"');
    for (const { name, state } of JOBS) expect(textOf(queue), name).toContain(`${name}${state}`);
    expect([...queue.matchAll(/art-dot--(\w+)/g)].map((match) => match[1])).toEqual(JOBS.map((job) => job.status));
    const mail = article('Mail');
    expect(textOf(mail)).toContain(`To ${MAIL.to}`);
    expect(textOf(mail)).toContain(`Subject ${MAIL.subject}`);
    expect(textOf(mail)).toContain(MAIL.button);
    const validation = article('Validation');
    expect(validation).toMatch(/<label for="battery-validation-title">Title<\/label>/);
    expect(validation).toContain('aria-describedby="battery-validation-error"');
    expect(validation).toMatch(/<small id="battery-validation-error">The title field must not be longer than 120 characters\.<\/small>/);
    expect(validation).not.toContain('role="alert"');
    const schedule = article('Scheduler');
    for (const { when, what } of SCHEDULE) expect(textOf(schedule), what).toContain(`${when}${what}`);
    const modules = article('Modules');
    expect(modules).toContain('aria-label="Files of the notes module"');
    for (const { name } of MODULE_FILES) expect(textOf(modules), name).toContain(name);
    const storage = article('Storage');
    expect(textOf(storage)).toContain('locals3');
    expect(textOf(storage)).toContain(`${STORAGE.key} · signed for ${STORAGE.minutes} min`);
    for (const label of ['A profile page that reloads when the server hints its channel', 'One notification delivered over three channels', 'One key with its translations', 'A cached value with its time to live']) expect(section, label).toContain(`aria-label="${label}"`);
    const live = textOf(article('Live'));
    expect(live).toContain(LIVE.page);
    expect(live).toContain(`hint ${LIVE.channel}`);
    expect(live).toContain(`reloads ${LIVE.prop}`);
    for (const link of [...LIVE.links, LIVE.added]) expect(live, link).toContain(link);
    const notifications = article('Notifications');
    expect(textOf(notifications)).toContain(NOTIFICATION.name);
    expect(textOf(notifications)).toContain(NOTIFICATION.className);
    for (const { name, where, text, detail } of NOTIFICATION.channels) {
      expect(notifications, name).toContain(`<p class="art-channel-text">${text}</p>`);
      expect(textOf(notifications), name).toContain(`${name} ${where}`);
      if (detail !== null) expect(textOf(notifications), name).toContain(detail);
    }
    const i18n = textOf(article('Localization'));
    expect(i18n).toContain(I18N.key);
    for (const { locale, text } of I18N.texts) expect(i18n, locale).toContain(`${locale}${text}`);
    for (const { locale, text } of I18N.numbers) expect(i18n, locale).toContain(`${locale}format.number(${I18N.number}) ${text}`);
    const cache = textOf(article('Cache'));
    expect(cache).toContain(`${CACHE.key} ${CACHE.seconds} s`);
    expect(cache).toContain(CACHE.hit);
    expect(cache).toContain(CACHE.miss);
    expect(textOf(section)).toContain('Installed packages register themselves');
    expect(textOf(section)).not.toContain('pnpm add');
    // The pictures are decoration or have a label: no button, no script, no live role.
    expect(section).not.toMatch(/<button|<script|role="alert"/);
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
    expect(header).toMatch(/<a [^>]*href="\/docs\/installation"[^>]*class="button button--sand site-start"[^>]*>Get started<\/a>|<a [^>]*class="button button--sand site-start"[^>]*href="\/docs\/installation"[^>]*>Get started<\/a>/);
    expect(header).toContain('<details class="site-menu"');
    expect(header).toMatch(/<summary>(?:<svg[^>]*>.*?<\/svg>){2}<span class="visually-hidden">Menu<\/span><\/summary>/);
    // Below 900px the labelled link is hidden: a magnifier link outside the closed menu keeps a trigger the shortcut can click.
    const icon = header.match(/<a [^>]*class="site-search-icon"[^>]*>/)?.[0] ?? '';
    expect(icon).toContain('data-search-trigger="true"');
    expect(icon).toContain('aria-label="Search the docs"');
    expect(icon).toContain('aria-keyshortcuts="Control+K Meta+K"');
    expect(icon).toContain('href="/docs/search"');
    expect(header.indexOf('class="site-search-icon"')).toBeLessThan(header.indexOf('<details class="site-menu"'));
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

  it('folds the same targets into the phone menu: a <details> group per panel in order, every desktop package once, Docs and GitHub rows, Get started inside', async () => {
    const body = (await app.get('/', document).assertOk()).body;
    const start = body.indexOf('<nav aria-label="Menu"');
    const menu = body.slice(start, body.indexOf('</nav>', start));
    const groups = [...menu.matchAll(/<details class="site-menu-group" name="site-menu-group"><summary>(?:<svg[^>]*>.*?<\/svg>)?([^<]*)<svg/g)].map((match) => match[1]);
    expect(groups).toEqual(['Framework', 'Packages', 'Resources']);
    expect(menu).not.toContain('>More<');
    expect(menu).not.toContain('<details class="site-menu-group" name="site-menu-group" open');
    // Every group holds links: none is a title without targets.
    for (const group of menu.split('<details class="site-menu-group"').slice(1)) expect(group.slice(0, group.indexOf('</details>'))).toMatch(/<a [^>]*class="site-menu-link"/);
    const desktop = body.slice(body.indexOf('<nav aria-label="Main"'), body.indexOf('</nav>'));
    const packages = [...desktop.matchAll(/<span class="site-panel-item-title">(@marmeon\/[a-z]+)<\/span>/g)].map((match) => match[1]!);
    expect(packages).toHaveLength(11);
    const group = menu.slice(menu.indexOf('Packages<svg'), menu.indexOf('Resources<svg'));
    for (const name of packages) expect(group, name).toContain(`>${name}</a>`);
    // Column titles are the section labels inside a group, each naming the list below it.
    const titles = (text: string) => [...text.matchAll(/<p id="[^"]+" class="site-menu-title">([^<]*)<\/p>/g)].map((match) => match[1]);
    const sections = menu.split('<details class="site-menu-group"').slice(1);
    expect(sections.map(titles)).toEqual([
      ['Overview', 'Features'],
      ['In every new app', 'Add when you need it', 'Tooling'],
      ['Learn', 'Community'],
    ]);
    const ids = [...menu.matchAll(/<p id="([^"]+)" class="site-menu-title">/g)].map((match) => match[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(menu).toContain(`<ul aria-labelledby="${id}" class="site-menu-list">`);
    // No page shows twice within a group.
    for (const section of sections) {
      const hrefs = [...section.slice(0, section.indexOf('</details>')).matchAll(/<a href="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(hrefs).size).toBe(hrefs.length);
    }
    // Docs and GitHub follow the groups as plain rows; Get started closes the sheet.
    const rows = menu.slice(menu.lastIndexOf('</details>'));
    expect(rows).toMatch(/<a [^>]*href="\/docs"[^>]*>Docs<\/a>/);
    expect(rows).toMatch(/<a [^>]*href="https:\/\/github\.com\/marmeon\/marmeon"[^>]*rel="noopener"[^>]*>GitHub<\/a>|<a [^>]*rel="noopener"[^>]*href="https:\/\/github\.com\/marmeon\/marmeon"[^>]*>GitHub<\/a>/);
    expect(rows).toMatch(/class="button button--sand site-menu-start"[^>]*>Get started<\/a>|href="\/docs\/installation"[^>]*class="button button--sand site-menu-start"[^>]*>Get started<\/a>/);
    expect(rows.indexOf('>Docs<')).toBeLessThan(rows.indexOf('>GitHub<'));
    expect(rows.indexOf('>GitHub<')).toBeLessThan(rows.indexOf('>Get started<'));
    // The top level mirrors the desktop bar's Docs and GitHub, which Resources also lists: these two appear twice, by design.
    expect(menu.match(/href="\/docs"/g)).toHaveLength(2); // Resources › Documentation and the Docs row
    expect(menu.match(/href="https:\/\/github\.com\/marmeon\/marmeon"/g)).toHaveLength(2); // Resources › GitHub and the GitHub row
    expect(menu).not.toContain('data-search-trigger'); // the header's magnifier is the trigger below 900px
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
    const start = response.body.indexOf('<nav aria-label="Menu"');
    const menu = response.body.slice(start, response.body.indexOf('</nav>', start));
    expect(menu).not.toContain('site-menu-group');
    const rows = [...menu.matchAll(/<a [^>]*class="site-menu-link site-menu-row"[^>]*>([^<]*)<\/a>/g)].map((match) => match[1]);
    expect(rows).toEqual(['Packages', 'Docs', 'GitHub']);
    expect(menu).toContain('href="/docs/packages"');
    expect(menu).toContain('class="button button--sand site-menu-start"');
  });

  it('keeps the docs layout for the docs pages', async () => {
    const body = (await app.get('/docs/routing', document).assertOk()).body;
    expect(body).toContain('class="shell"');
    expect(body).not.toContain('class="site-header stage"');
  });
});
