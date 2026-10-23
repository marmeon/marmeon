import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { Navigation } from './DocsRepository.ts';
import { ENTRIES, SECTIONS } from './docs.test-support.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(application);
});
afterAll(() => app?.close());

describe('pages', () => {
  it('has no package pages — a package README is a card for npm: /packages/… is a 404', async () => {
    await app.get('/packages/http').assertNotFound();
    await app.get('/packages/core/README.md').assertNotFound();
    await app.navigating().get('/packages/http').assertNotFound();
  });

  it('a path without a route is a 404 page in the site layout — without the navigation (no shared props there), rendered on the server', async () => {
    const ssr = await createTestApp(application, { ssr: true, ssrServer: server });
    const response = await ssr.get('/no/such/page', { headers: { accept: 'text/html' } }).assertNotFound().assertServerRendered();
    expect(response.body).toContain('Not Found');
    expect(response.body).toContain('class="site-header"');
    expect(response.body).not.toContain('id="sidebar"');
  });

  it('shares the navigation — the eleven sections with their pages, nothing else — once per tab', async () => {
    const page = (await app.navigating().get('/docs/routing').assertOk()).page()!;
    const nav = page.props.nav as Navigation;
    expect(nav.groups.map((group) => group.title)).toEqual(SECTIONS);
    expect(nav.groups.flatMap((group) => group.pages.map((entry) => entry.path))).toEqual(ENTRIES.map((entry) => `/docs/${entry.slug}`));
    expect(nav.groups.flatMap((group) => group.pages.map((entry) => entry.label))).toEqual(ENTRIES.map((entry) => entry.label));
    expect(page.props).toMatchObject({ previous: { path: '/docs/context' }, next: { path: '/docs/middleware' }, section: 'The Basics', title: 'Routing' });
  });
});
