import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import application from '../../bootstrap/app.ts';
import { LegalPages } from './LegalPages.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

const document = { headers: { accept: 'text/html' } };

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});
afterAll(() => app?.close());

describe.each([
  { path: '/imprint', title: 'Site Notice', text: 'HRB 305214' },
  { path: '/privacy', title: 'Privacy Policy', text: 'Fathom Analytics' },
])('$path', ({ path, title, text }) => {
  it('renders on the server with one h1, its title and its text', async () => {
    const response = await app.get(path, document).assertOk().assertServerRendered().assertHydrates();
    expect(response.body.match(/<h1[ >]/g)).toHaveLength(1);
    expect(response.body).toContain(`<h1>${title}</h1>`);
    expect(response.body).toContain(`>${title} — Marmeon</title>`);
    expect(response.body).toContain(text);
    expect(response.body).toContain('<article class="doc">');
  });

  it('is cached publicly, sets no cookie and carries no style attribute', async () => {
    const response = await app.get(path, document).assertOk();
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.body).not.toMatch(/<[a-z][^>]*\sstyle=|<style\b/i);
  });
});

describe('the legal texts', () => {
  it('keep the line breaks of the address and the external links as links', async () => {
    const imprint = (await app.get('/imprint', document).assertOk()).body;
    expect(imprint).toContain('BespokeCode UG (haftungsbeschränkt)<br/>Mauthäuslstraße 25a<br/>81379 München');
    expect(imprint).toContain('<strong>Represented by:</strong>');
    const privacy = (await app.get('/privacy', document).assertOk()).body;
    expect(privacy).toContain('<a href="https://www.hetzner.com/de/legal/privacy-policy/" rel="noopener">');
    expect(privacy).toContain('IN THE EVENT THAT DATA ARE PROCESSED ON THE BASIS OF ART. 6(1)(E) OR (F) GDPR');
    expect(privacy.match(/<ul>/g)).toHaveLength(2);
  });

  it('are no pages of the docs: not found by its search', async () => {
    const body = (await app.get('/docs/search?q=HRB+305214', document).assertOk()).body;
    expect(body).toContain('Nothing found for');
  });
});

describe('the footer', () => {
  it.each(['/', '/docs/routing', '/imprint'])('links to the imprint and the privacy policy on %s', async (path) => {
    const body = (await app.get(path, document).assertOk()).body;
    const footer = body.slice(body.indexOf('<footer'));
    expect(footer).toMatch(/<a [^>]*href="\/imprint"[^>]*>Imprint<\/a>/);
    expect(footer).toMatch(/<a [^>]*href="\/privacy"[^>]*>Privacy Policy<\/a>/);
  });
});

describe('LegalPages', () => {
  it('fails to load when a file is missing', () => {
    const directory = tempDir('marmeon-legal-');
    writeFileSync(join(directory, 'imprint.md'), '# Site Notice\n\nText\n');
    expect(() => new LegalPages(directory).load()).toThrow(/privacy\.md/);
  });

  it('fails to load a file without a title, and before load() has run', () => {
    const directory = tempDir('marmeon-legal-');
    for (const name of ['imprint', 'privacy']) writeFileSync(join(directory, `${name}.md`), 'No heading\n');
    const pages = new LegalPages(directory);
    expect(() => pages.page('imprint')).toThrow(/not loaded/);
    expect(() => pages.load()).toThrow(/no "# " heading/);
  });
});
