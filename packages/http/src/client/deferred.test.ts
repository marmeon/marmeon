import { describe, expect, it, vi } from 'vitest';
import { LOCATION_HEADER, type PageObject } from '../page.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

// The chunk the deferred props load from: it fails to load as often as `chunk.failures` says, then it is the real one.
const chunk = vi.hoisted(() => ({ failures: 0 }));
vi.mock('./prop-loader.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./prop-loader.ts')>();
  return {
    get PropLoader() {
      if (chunk.failures > 0) {
        chunk.failures--;
        throw new Error('Failed to fetch dynamically imported module');
      }
      return original.PropLoader;
    },
  };
});

const partial = (win: FakeWindow) => win.requests.map((request) => request.headers['x-marmeon-partial-data']).filter((asked) => asked !== undefined);

describe('the loading of deferred props, a chunk of its own', () => {
  it('asks for nothing in a document that was left before the chunk arrived', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (_url, init) =>
      (init.headers as Record<string, string>)['x-marmeon-partial-data'] === undefined
        ? new Response(null, { status: 409, headers: { [LOCATION_HEADER]: `${ORIGIN}/login` } })
        : pageResponse(page('/users/1', { activity: ['of ada'] }));
    const { navigator, shown } = boot(win, { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] } });
    // Signed out in the same tick the page arrived in: the chunk has not resolved yet.
    await navigator.visit('/logout', { method: 'post' });
    await settle();
    expect(win.loads).toEqual([`assign ${ORIGIN}/login`]);
    expect(partial(win)).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('asks again for the chunk when a streamed group arrives, and lands the group once it loads', async () => {
    chunk.failures = 1;
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    const streamed: PageObject = { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] }, streamedProps: ['default'] };
    const { navigator, visible } = boot(win, streamed);
    await settle();
    await navigator.receiveStreamed('default', { props: { activity: ['signed in'] } });
    expect(visible().props).toMatchObject({ name: 'Ada', activity: ['signed in'] });
    expect(partial(win)).toEqual([]);
  });

  it('leaves a streamed group to the next loader when the chunk cannot load at all — it asks for it like any group', async () => {
    chunk.failures = 2;
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (_url, init) => {
      const asked = (init.headers as Record<string, string>)['x-marmeon-partial-data'];
      if (asked === 'audit') return pageResponse(page('/other', { audit: ['log'] }));
      if (asked === 'activity') return pageResponse(page('/users/1', { activity: ['fetched'] }));
      return pageResponse({ ...page('/other', { other: true }), deferredProps: { default: ['audit'] } });
    };
    const streamed: PageObject = { ...page('/users/1', { name: 'Ada' }), deferredProps: { default: ['activity'] }, streamedProps: ['default'] };
    const { navigator, visible } = boot(win, streamed);
    await settle();
    await navigator.receiveStreamed('default', { props: { activity: ['signed in'] } });
    // Nothing landed, nothing was asked for, and no failure was reported.
    expect(visible().props).not.toHaveProperty('activity');
    expect(partial(win)).toEqual([]);
    // The next page that has groups tries the chunk again (it loads now) and its groups are asked for.
    await navigator.visit('/other');
    await settle();
    expect(partial(win)).toEqual(['audit']);
    expect(visible().props).toMatchObject({ other: true, audit: ['log'] });
    // Back to the first page: its streamed group never came, so it is asked for now.
    win.back();
    await settle();
    expect(partial(win)).toEqual(['audit', 'activity']);
    expect(visible().props).toMatchObject({ name: 'Ada', activity: ['fetched'] });
  });
});
