import { describe, expect, it } from 'vitest';
import { PAGE_HEADER, PARTIAL_DATA_HEADER, REGION_HEADER, type LiveSubscription, type PageObject, PROTOCOL_VERSION } from '../protocol.ts';
import { islands } from './features/islands.ts';
import { LIVE_QUIET } from './features/live.ts';
import { mergePage } from './merge.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle, withActions } from './test-window.ts';

/**
 * Merged props: a revalidation — an action's reload, a live hint's, Back's — replaces what it brings,
 * also a `merge()`d list; "load more" (a visit with `data`/`query`) appends. The difference comes from where a reload comes from,
 * never from what it looks like.
 */

type Row = { id: number };
type Feed = { data: Row[]; meta: { nextCursor: string | null } };
const rows = (...ids: number[]): Row[] => ids.map((id) => ({ id }));
const idsOf = (shown: PageObject) => (shown.props.inbox as Feed).data.map((row) => row.id);

/** The inbox as the server marks it: `merge(…).matchOn('data.id')` — a paginator, merged by its `data`. */
const inbox = (url: string, ids: number[], next: string | null, extra: Partial<PageObject> = {}): PageObject => ({
  ...page(url, { inbox: { data: rows(...ids), meta: { nextCursor: next } }, bell: ids.length }, 'notifications/Index'),
  mergeProps: ['inbox'],
  matchPropsOn: ['inbox.data.id'],
  ...extra,
});

/** A tab on the inbox (rows 1–3) that loaded more (rows 4–6) — what the server has now is up to the test. */
async function loadedMore(extra: Partial<PageObject> = {}) {
  const win = new FakeWindow(`${ORIGIN}/notifications`);
  let server = { first: [1, 2, 3], more: [4, 5, 6] };
  win.handler = (url) => {
    const cursor = new URL(url).searchParams.get('cursor');
    return pageResponse(cursor === 'c3' ? inbox(`/notifications?cursor=c3`, server.more, null, extra) : inbox('/notifications', server.first, 'c3', extra));
  };
  const booted = boot(win, inbox('/notifications', [1, 2, 3], 'c3', extra));
  // "Load more": the next page appended, the URL stays the list's.
  await booted.navigator.reload({ data: { cursor: 'c3' }, only: ['inbox'], preserveUrl: true });
  expect(idsOf(booted.visible()), 'load more replaced the list').toEqual([1, 2, 3, 4, 5, 6]);
  return { win, ...booted, serve: (next: typeof server) => (server = next) };
}

describe('mergePage', () => {
  it('merge() merges a paginator by its data — appended, matched on the key — and takes the rest (meta) from the new page', () => {
    const current = inbox('/notifications', [1, 2], 'c2');
    const merged = mergePage(current, inbox('/notifications?cursor=c2', [2, 3], null));
    expect(merged.props.inbox, 'the paginator’s data was replaced').toEqual({ data: rows(1, 2, 3), meta: { nextCursor: null } });
  });

  it('matches on a path into each item (matchOn("user.id")) — not only a key right at it', () => {
    const current: PageObject = { ...page('/feed', { feed: [{ user: { id: 1 }, n: 1 }, { user: { id: 2 }, n: 1 }] }), mergeProps: ['feed'], matchPropsOn: ['feed.user.id'] };
    const merged = mergePage(current, { ...page('/feed', { feed: [{ user: { id: 2 }, n: 2 }, { user: { id: 3 }, n: 1 }] }), mergeProps: ['feed'], matchPropsOn: ['feed.user.id'] });
    expect(merged.props.feed, 'not matched on the path').toEqual([{ user: { id: 1 }, n: 1 }, { user: { id: 2 }, n: 2 }, { user: { id: 3 }, n: 1 }]);
  });

  it('reset: true replaces every prop the partial brought — a revalidation', () => {
    const merged = mergePage(inbox('/notifications', [1, 2, 3, 4], 'c4'), inbox('/notifications', [1, 3], 'c3'), true);
    expect(merged.props.inbox).toEqual({ data: rows(1, 3), meta: { nextCursor: 'c3' } });
  });

  it('what a page says about merging is the partial’s for the props it brought — it never piles up over reloads', () => {
    const current: PageObject = { ...page('/p', { a: [1], b: [1] }), mergeProps: ['a', 'b'], matchPropsOn: ['a.id'] };
    // The server no longer marks `a` (another query: a plain list now); `b` was not reloaded and keeps its mark.
    const merged = mergePage(current, page('/p', { a: [2] }));
    expect(merged.props.a).toEqual([2]);
    expect(merged.mergeProps).toEqual(['b']);
    expect(merged.matchPropsOn).toBeUndefined();
    // Marked again, then reloaded unmarked: gone again — never the union of every response there was.
    const again = mergePage(mergePage(merged, { ...page('/p', { a: [3] }), mergeProps: ['a'] }), page('/p', { a: [4] }));
    expect(again.mergeProps).toEqual(['b']);
  });
});

describe('a revalidation replaces merged props — load more appends', () => {
  it('an action’s reload: the row it deleted stays gone, though the list was merge()d and had loaded more', async () => {
    const { win, navigator, visible, serve } = await loadedMore();
    win.handler = (url, init) => {
      if (init.method === 'DELETE') return Response.json({ deleted: 2 });
      return pageResponse(inbox('/notifications', [1, 3, 4], 'c4'));
    };
    serve({ first: [1, 3, 4], more: [] });
    const actions = withActions(navigator);
    await actions.action('/notifications/2', { method: 'delete', reload: actions.reloading({ only: ['inbox'] }) });
    await settle();
    expect(win.requests.at(-1)!.headers[PARTIAL_DATA_HEADER]).toBe('inbox');
    expect(idsOf(visible()), 'the deleted row came back').toEqual([1, 3, 4]);
    expect(idsOf(navigator.page)).toEqual([1, 3, 4]);
    expect((visible().props.inbox as Feed).meta.nextCursor).toBe('c4');
  });

  it('reset: [] keeps merging — the way back to appending', async () => {
    const { win, navigator, visible } = await loadedMore();
    win.handler = (_url, init) => (init.method === 'DELETE' ? Response.json({ deleted: 2 }) : pageResponse(inbox('/notifications', [1, 3, 4], 'c4')));
    const actions = withActions(navigator);
    await actions.action('/notifications/2', { method: 'delete', reload: actions.reloading({ only: ['inbox'], reset: [] }) });
    await settle();
    expect(idsOf(visible())).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a live hint’s reload: the row deleted in another tab is gone', async () => {
    const subscription: LiveSubscription = { channel: 'notifications.user.1', only: ['inbox'], token: 't-notifications' };
    const { win, visible } = await loadedMore({ live: [subscription] });
    // The stream is opened by the live feature, which loads because the page follows a channel.
    for (let i = 0; i < 50 && !win.source; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    win.handler = () => pageResponse(inbox('/notifications', [1, 3, 4], 'c4', { live: [subscription] }));
    win.source!.emit('hello', { seq: { 'notifications.user.1': 0 } });
    win.source!.emit('refresh', { channel: 'notifications.user.1', only: ['inbox'], seq: 1 });
    await new Promise((resolve) => setTimeout(resolve, LIVE_QUIET + 50));
    await settle();
    expect(win.requests.at(-1)!.headers[PARTIAL_DATA_HEADER]).toBe('inbox');
    expect(idsOf(visible()), 'the deleted row came back').toEqual([1, 3, 4]);
  });

  it('load more after a revalidation appends again — the difference is where a reload comes from', async () => {
    const { win, navigator, visible, serve } = await loadedMore();
    win.handler = (_url, init) => (init.method === 'DELETE' ? Response.json({ deleted: 2 }) : pageResponse(inbox('/notifications', [1, 3, 4], 'c4')));
    const actions = withActions(navigator);
    await actions.action('/notifications/2', { method: 'delete', reload: actions.reloading({ only: ['inbox'] }) });
    await settle();
    expect(idsOf(visible())).toEqual([1, 3, 4]);
    serve({ first: [1, 3, 4], more: [5, 6, 7] });
    win.handler = (url) => pageResponse(inbox(`/notifications?cursor=c4`, new URL(url).searchParams.get('cursor') === 'c4' ? [5, 6, 7] : [], null));
    await navigator.reload({ data: { cursor: 'c4' }, only: ['inbox'], preserveUrl: true });
    expect(idsOf(visible()), 'load more replaced the list').toEqual([1, 3, 4, 5, 6, 7]);
    expect(visible().url).toBe('/notifications');
  });

  it('a layer’s revalidation replaces its merged props too', async () => {
    const win = new FakeWindow(`${ORIGIN}/notifications`);
    const layerPage = (ids: number[]): PageObject => ({ ...inbox('/notifications/all', ids, null), layer: { key: 'notifications/Index', base: '/notifications' } });
    win.handler = () => pageResponse(layerPage([1, 2, 3]));
    const app = boot(win, page('/notifications', {}, 'notifications/Home'));
    await app.navigator.visit('/notifications/all', { layer: true });
    const [layer] = app.layers();
    win.handler = (_url, init) => (init.method === 'DELETE' ? Response.json({ deleted: 2 }) : pageResponse(layerPage([1, 3])));
    await withActions(app.navigator).action('/notifications/2', { method: 'delete', reload: layer!.reloading({ only: ['inbox'] }) });
    await settle();
    expect(idsOf(layer!.page), 'the deleted row came back').toEqual([1, 3]);
  });
});

describe('an island’s revalidation', () => {
  it('replaces its merged props too — the row an action deleted stays gone', async () => {
    const win = new FakeWindow(`${ORIGIN}/dashboard`);
    const island = (ids: number[], next: string | null) =>
      new Response(JSON.stringify({ component: 'dashboard/Inbox', props: { inbox: { data: rows(...ids), meta: { nextCursor: next } } }, url: '/islands/inbox', version: null, mergeProps: ['inbox'], matchPropsOn: ['inbox.data.id'] }), {
        headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island', 'content-type': 'application/json' },
      });
    win.handler = (url) => (new URL(url).searchParams.get('cursor') === 'c3' ? island([4, 5], null) : island([1, 2, 3], 'c3'));
    const { navigator } = boot(win, page('/dashboard', {}, 'dashboard/Show'));
    const region = navigator.use(islands).region('/islands/inbox');
    await region.load();
    await region.reload({ query: { cursor: 'c3' }, only: ['inbox'], reset: [] });
    const shown = () => (region.snapshot.region!.props.inbox as Feed).data.map((row) => row.id);
    expect(shown()).toEqual([1, 2, 3, 4, 5]);
    win.handler = (_url, init) => (init.method === 'DELETE' ? Response.json({ deleted: 2 }) : island([1, 3, 4], 'c4'));
    await withActions(navigator).action('/inbox/2', { method: 'delete', reload: region.reloading({ only: ['inbox'] }) });
    await settle();
    expect(shown(), 'the deleted row came back').toEqual([1, 3, 4]);
  });
});

describe('GET data in the query string', () => {
  it('a list is the key repeated — what the server’s query schema reads as a list', async () => {
    const win = new FakeWindow(`${ORIGIN}/people?role=guest&q=ada`);
    win.handler = (url) => pageResponse(page(new URL(url).pathname + new URL(url).search, {}));
    const { navigator } = boot(win, page('/people?role=guest&q=ada', {}));
    await navigator.reload({ data: { role: ['admin', 'owner'], empty: [] } });
    const sent = new URL(win.requests.at(-1)!.url);
    expect(sent.search, 'the list went as one value').toBe('?q=ada&role=admin&role=owner');
    expect(sent.searchParams.getAll('role')).toEqual(['admin', 'owner']);
  });
});
