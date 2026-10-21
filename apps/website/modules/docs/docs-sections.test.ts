import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import docsConfig from '../../docs.config.ts';
import { DocsRepository } from './DocsRepository.ts';
import { ENTRIES, fileOf, repo, results, SECTIONS } from './docs.test-support.ts';
import { SSR_TEST_TIMEOUT } from './test-timeouts.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
}, 30_000);
afterAll(() => server?.close());

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
}, 30_000);
afterAll(() => app?.close());

describe('the docs: sections of pages under /docs', { timeout: 30_000 }, () => {
  it('lists the 82 pages in eleven sections, in this order', () => {
    expect(docsConfig.sections.map((section) => section.title)).toEqual(SECTIONS);
    expect(docsConfig.sections.map((section) => section.pages.length)).toEqual([6, 6, 2, 5, 11, 9, 14, 11, 7, 7, 4]);
    expect(ENTRIES[0]).toEqual({ slug: 'why-marmeon', label: 'Why Marmeon' });
    expect(ENTRIES[1]).toEqual({ slug: 'upgrading', label: 'Upgrade Guide', file: 'UPGRADING.md', changes: true });
    expect(ENTRIES.filter((entry) => entry.file).map((entry) => [entry.slug, entry.file])).toEqual([
      ['upgrading', 'UPGRADING.md'],
      ['contributing', 'CONTRIBUTING.md'],
      ['security-policy', 'SECURITY.md'],
    ]);
  });

  it('answers every page under /docs/<slug> with its title — the file’s # heading — and its section', async () => {
    for (const section of docsConfig.sections) {
      for (const entry of section.pages) {
        const title = /^# (.+)$/m.exec(readFileSync(join(repo, fileOf(entry)), 'utf8'))![1];
        const page = (await app.navigating().get(`/docs/${entry.slug}`).assertOk().assertPage('docs/Page')).page()!;
        expect(page.props, entry.slug).toMatchObject({ title, section: section.title });
      }
    }
  }, 60_000);

  it('an unknown page is a 404 — and the old /guides/ paths are gone', async () => {
    await app.get('/docs/no-such-page').assertNotFound();
    await app.get('/docs/README').assertNotFound();
    await app.get('/guides/deployment').assertNotFound();
  });

  it('the search lives at /docs/search only — the old /search is a 404, not a redirect', async () => {
    await app.get('/search?q=onOneServer').assertNotFound();
    await app.get('/docs/search?q=onOneServer').assertOk();
  });

  it('leads from page to page across the sections — the first has no previous page, the last no next', async () => {
    /** `previous ← page → next`, the pages under /docs by their slugs — short enough that a failure shows the whole line. */
    const neighbours = async (slug: string) => {
      const props = (await app.navigating().get(`/docs/${slug}`).assertOk()).page()!.props as Record<'previous' | 'next', { path: string } | null>;
      const name = (link: { path: string } | null) => link?.path.replace(/^\/docs\//, '') ?? 'none';
      return `${name(props.previous)} ← ${slug} → ${name(props.next)}`;
    };
    expect(await neighbours('deployment')).toBe('first-app ← deployment → recipe-resource');
    expect(await neighbours('recipe-resource')).toBe('deployment ← recipe-resource → recipe-public-form');
    expect(await neighbours('recipe-public-form')).toBe('recipe-resource ← recipe-public-form → lifecycle');
    expect(await neighbours('packages')).toBe('security-policy ← packages → installation');
    expect(await neighbours('why-marmeon')).toBe('none ← why-marmeon → upgrading');
    expect(await neighbours('upgrading')).toBe('why-marmeon ← upgrading → releases');
    expect(await neighbours('health')).toBe('observability ← health → agents');
    expect(await neighbours('agents')).toBe('health ← agents → none');
  });

  it('the start page lists every docs page exactly once, in its section — and no package page', async () => {
    const page = (await app.navigating().get('/docs').assertOk().assertPage('docs/Home')).page()!;
    const sections = page.props.sections as { title: string; pages: { label: string; path: string }[] }[];
    expect(sections.map((section) => section.title)).toEqual(SECTIONS);
    expect(sections.flatMap((section) => section.pages)).toEqual(ENTRIES.map((entry) => ({ label: entry.label, path: `/docs/${entry.slug}` })));
    expect(JSON.stringify(sections)).not.toContain('/packages/');
  });

  it('the start page links the three first steps to existing pages and shows the terminal without a copy button', async () => {
    const docs = app.make(DocsRepository);
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const html = (await ssr.get('/docs', { headers: { accept: 'text/html' } }).assertOk()).body;
    for (const slug of ['installation', 'structure', 'routing']) {
      expect(docs.doc(slug), slug).toBeDefined();
      expect(html).toContain(`href="/docs/${slug}"`);
    }
    expect(html).toContain('pnpm create marmeon my-app');
    expect(html).toContain('class="terminal"');
    expect(html).not.toContain('copy-button');
  }, SSR_TEST_TIMEOUT);

  it('finds the release policy’s sections — and the record of changes comes after every other hit', async () => {
    // "likely" scores the same in the upgrade guide and in the release policy's "How to upgrade": by order alone the guide, the
    // first page of the navigation, would come first.
    const hits = results(await app.navigating().get('/docs/search?q=likely').assertOk());
    expect(hits.some((hit) => hit.href.startsWith('/docs/releases'))).toBe(true);
    const late = hits.map((hit) => hit.href.startsWith('/docs/upgrading'));
    expect(late).toContain(true);
    expect(late.indexOf(true)).toBeGreaterThan(late.lastIndexOf(false));
  });

  it('a link of a page to another page is a visit to it, with the anchor; a link to the root README stays code text', async () => {
    const docs = app.make(DocsRepository);
    const tables = JSON.stringify(docs.doc('tables')!.body);
    expect(tables).toContain('"href":"/docs/requests#how-a-query-is-parsed","data-internal":""');
    expect(docs.pages().flatMap((page) => page.fileLinks).filter((file) => /^docs\/|^[A-Z]+\.md$/.test(file) && file !== 'README.md')).toEqual([]);
    expect(docs.pages().some((page) => page.fileLinks.includes('README.md'))).toBe(true);
  });
});
