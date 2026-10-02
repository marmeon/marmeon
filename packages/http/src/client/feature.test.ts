import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCATION_HEADER, RELOAD_HEADER } from '../page.ts';
import { defineFeature, slot, type FeatureHost } from './feature.ts';
import { HistoryWriter, type HistoryState } from './history.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';

/** The feature host (Wave 5c step 3, E70/E73): `use`, the slots the core empties, the history writer that refuses props. */

const historyConflict = () => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: '/login', [RELOAD_HEADER]: 'history' } });

function tab(url = '/a', options: Parameters<typeof boot>[2] = {}) {
  const win = new FakeWindow(`${ORIGIN}${url}`);
  win.handler = (to) => pageResponse(page(new URL(to).pathname, {}, 'pages/Other'));
  return { win, ...boot(win, page(url, {}, 'pages/A'), options) };
}

/** The host of a navigator — what a feature's setup gets. */
const hostOf = (navigator: ReturnType<typeof tab>['navigator']) => navigator.use(defineFeature('probe', (host) => host));

describe('navigator.use — a feature attaches once per navigator (E70)', () => {
  it('runs setup on the first use only and hands every caller the same API', () => {
    const { navigator } = tab();
    const setup = vi.fn(() => ({ id: Symbol('api') }));
    const feature = defineFeature('counter', setup);
    const first = navigator.use(feature);
    expect(navigator.use(feature)).toBe(first);
    expect(navigator.use(feature)).toBe(first);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it('counter-check: a hook registered in setup runs once per event, however often the feature is used', async () => {
    const { navigator } = tab();
    const writes = vi.fn();
    const feature = defineFeature('writes', (host) => void host.on('write', writes));
    navigator.use(feature);
    navigator.use(feature);
    await navigator.visit('/a', { method: 'post' });
    expect(writes).toHaveBeenCalledTimes(1);
  });

  it('attaches no feature by default (Wave 5c) — each where it is used', () => {
    const { navigator } = tab('/a');
    expect(navigator.use(defineFeature('probe', (host) => host.layers))).toEqual([]);
    const setup = vi.fn(() => 'api');
    expect(navigator.use(defineFeature('late', setup))).toBe('api');
    expect(setup).toHaveBeenCalledOnce();
  });

  it("runs the hooks in the features' order, whenever each was attached — a hook registered outside a setup last", async () => {
    const { navigator } = tab('/a', { features: [] });
    const ran: string[] = [];
    const host = hostOf(navigator);
    host.on('write', () => void ran.push('outside'));
    const writer = (name: string, order?: number) => defineFeature(name, (given) => given.on('write', () => void ran.push(name)), order);
    // Attached in the order a page uses them: a form guards first, a link prefetches on hover, a third-party feature has no order.
    for (const feature of [writer('third-party'), writer('instant', 3), writer('guard', 1), writer('prefetch', 2), writer('guard-2', 1)]) navigator.use(feature);
    await navigator.visit('/a', { method: 'post' });
    expect(ran).toEqual(['guard', 'guard-2', 'prefetch', 'instant', 'outside', 'third-party']);
  });

  it('takes a hook out again', async () => {
    const { navigator } = tab();
    const writes = vi.fn();
    const off = hostOf(navigator).on('write', writes);
    off();
    await navigator.visit('/a', { method: 'post' });
    expect(writes).not.toHaveBeenCalled();
  });
});

describe('slots — what a feature keeps, emptied by the core (E70)', () => {
  const DRAFTS = slot('drafts', () => new Map<string, string>());

  it('keeps a value per history entry: each entry its own, back with its entry', async () => {
    const { win, navigator } = tab();
    const host = hostOf(navigator);
    host.entry(DRAFTS).set('note', 'on a');
    const first = navigator.page.url;
    await navigator.visit('/b');
    expect(host.entry(DRAFTS).has('note')).toBe(false);
    win.back();
    await settle();
    expect(navigator.page.url).toBe(first);
    expect(host.entry(DRAFTS).get('note')).toBe('on a');
  });

  it('empties an entry’s slots when memory lets go of the entry (LRU) — also the value a feature still holds', async () => {
    const { navigator } = tab('/a', { cacheSize: 2 });
    const host = hostOf(navigator);
    const key = host.key!;
    const held = host.entry(DRAFTS);
    held.set('note', 'secret');
    await navigator.visit('/b');
    await navigator.visit('/c');
    expect(held.size).toBe(0);
    expect(host.peek(DRAFTS, key)).toBeUndefined();
  });

  it('empties an entry’s slots when another page replaces it', async () => {
    const { navigator } = tab();
    const host = hostOf(navigator);
    const key = host.key!;
    const held = host.entry(DRAFTS);
    held.set('note', 'secret');
    await navigator.visit('/b', { replace: true });
    expect(host.key).toBe(key);
    expect(held.size).toBe(0);
    expect(host.entry(DRAFTS).size).toBe(0);
  });

  it('keeps a value per document — emptied with every entry’s when the document is left (a 409: signed out)', async () => {
    const { win, navigator } = tab();
    const host = hostOf(navigator);
    const document = host.document(DRAFTS);
    document.set('note', 'secret');
    const entry = host.entry(DRAFTS);
    entry.set('note', 'secret');
    win.handler = () => historyConflict();
    await navigator.visit('/logout', { method: 'post' });
    expect(win.loads).toEqual(['assign /login']);
    expect(document.size).toBe(0);
    expect(entry.size).toBe(0);
    expect(host.document(DRAFTS)).not.toBe(document);
  });

  it('runs a slot’s own clear (aborting what is under way) — and refuses, as a type, a value that cannot be emptied', () => {
    const controller = new AbortController();
    const REQUESTS = slot('requests', () => new Set<AbortController>(), (requests) => {
      for (const request of requests) request.abort();
      requests.clear();
    });
    const { navigator } = tab();
    const host: FeatureHost = hostOf(navigator);
    host.document(REQUESTS).add(controller);
    host.leave();
    expect(controller.signal.aborted).toBe(true);
    // @ts-expect-error — an object without `clear()` needs a `clear` of the slot's own
    slot('plain', () => ({ token: 'x' }));
  });
});

describe('the history writer — positions only, never props (E36)', () => {
  const state = (extra: Record<string, unknown> = {}): HistoryState => ({ component: 'pages/A', url: '/a', key: 'k', scroll: { x: 0, y: 0 }, ...extra }) as HistoryState;
  const original = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = original;
  });

  it('writes what an entry is: component, URL, key, its place and where it was scrolled', () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const writer = new HistoryWriter(win);
    writer.push(state({ scrollRegions: [{ x: 0, y: 40 }] }), '/a');
    expect(win.history.state).toEqual({ component: 'pages/A', url: '/a', key: 'k', scroll: { x: 0, y: 0 }, scrollRegions: [{ x: 0, y: 40 }], index: 1 });
  });

  it('counter-check: refuses props in development — with what to do instead', () => {
    const writer = new HistoryWriter(new FakeWindow(`${ORIGIN}/a`));
    expect(() => writer.push(state({ props: { email: 'ada@example.com' } }), '/a')).toThrow(
      '[bespoke] A history entry holds where it is, never what it showed (E36): "props" is no field of it. Keep what a page showed in memory — a slot of the feature (host.entry, host.document) — and register a position a feature needs with host.history.field().',
    );
    expect(() => writer.replace(state({ draft: 'secret' }), '/a')).toThrow('"draft" is no field of it');
  });

  it('counter-check: refuses a known field that holds more than a position', () => {
    const writer = new HistoryWriter(new FakeWindow(`${ORIGIN}/a`));
    expect(() => writer.push(state({ scroll: { x: 0, y: 0, props: { email: 'ada@example.com' } } }), '/a')).toThrow('"scroll" is not a position');
    expect(() => writer.push(state({ url: { email: 'ada@example.com' } }), '/a')).toThrow('"url" is not a position');
  });

  it('takes a field a feature registers — checked by the feature’s own rule', () => {
    const win = new FakeWindow(`${ORIGIN}/a`);
    const writer = new HistoryWriter(win);
    writer.field('step', Number.isInteger);
    writer.push(state({ step: 2 }), '/a');
    expect(win.history.state).toMatchObject({ step: 2 });
    expect(() => writer.push(state({ step: { props: {} } }), '/a')).toThrow('"step" is not a position');
  });

  it('in production leaves out what it refuses — the entry is written without it', () => {
    process.env.NODE_ENV = 'production';
    const win = new FakeWindow(`${ORIGIN}/a`);
    new HistoryWriter(win).push(state({ props: { email: 'ada@example.com' } }), '/a');
    expect(win.current.state).not.toContain('ada@example.com');
    expect(win.history.state).toEqual({ component: 'pages/A', url: '/a', key: 'k', scroll: { x: 0, y: 0 }, index: 1 });
  });

  it('is the only way into the history: a feature writing props through the host throws (no feature can put props on disk)', async () => {
    const { navigator } = tab();
    const host = hostOf(navigator);
    expect(() => host.history.replace({ ...state(), props: { email: 'ada@example.com' } } as HistoryState, '/a')).toThrow('"props" is no field of it');
  });
});
