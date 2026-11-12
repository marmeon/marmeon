import { Router } from '@marmeon/http';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
});

describe('the help pages', () => {
  it('lists the pages at /help, for a guest', async () => {
    const response = await app.navigating().get('/help').assertOk().assertPage('help/Show');
    const props = response.page()!.props as { page: unknown; pages: { path: string }[] };
    expect(props.page).toBeNull();
    expect(props.pages.map((page) => page.path)).toEqual(['getting-started', 'getting-started/install', 'accounts/passkeys']);
  });

  it('shows a page and a nested page by the rest of the path', async () => {
    const page = await app.navigating().get('/help/getting-started').assertOk().assertPage('help/Show');
    expect((page.page()!.props.page as { title: string }).title).toBe('Getting started');
    const nested = await app.navigating().get('/help/getting-started/install').assertOk().assertPage('help/Show');
    expect((nested.page()!.props.page as { path: string }).path).toBe('getting-started/install');
    await app.navigating().get('/help/accounts/passkeys').assertOk();
  });

  it('answers 404 for a page the help does not have', async () => {
    await app.navigating().get('/help/no-such-page').assertNotFound();
    await app.navigating().get('/help/getting-started/install/more').assertNotFound();
  });

  it('answers 404 for a path with an empty segment or an encoded slash, before the controller runs', async () => {
    await app.navigating().get('/help/getting-started%2Finstall').assertNotFound();
    await app.navigating().get('/help//getting-started').assertNotFound();
    await app.navigating().get('/help/getting-started//install').assertNotFound();
  });

  it('sends a trailing slash to the page without it', async () => {
    const response = await app.get('/help/getting-started/install/');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/help/getting-started/install');
  });

  it('builds the URL of a page from its path, one segment at a time', () => {
    const router = app.application.container.make(Router);
    expect(router.url('help.page', { path: 'getting-started/install' })).toBe('/help/getting-started/install');
    expect(router.url('help.page')).toBe('/help');
    expect(() => router.url('help.page', { path: 'a//b' })).toThrow('cannot be');
    // @ts-expect-error — a number is no rest of the path.
    expect(() => router.url('help.page', { path: 7 })).toThrow('as a string');
  });
});
