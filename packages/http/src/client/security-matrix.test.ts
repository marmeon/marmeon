import { describe, expect, it } from 'vitest';
import { LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, type FlashMessage, type PageObject, type RegionObject } from '../page.ts';
import type { FeatureHost } from './core.ts';
import { defineFeature, slot, type Feature, type FeatureHook, type PendingVisit, type Slot } from './feature.ts';
import { actions, type ActionsFeature } from './features/actions.ts';
import { DEFAULT_FEATURES } from './features/defaults.ts';
import { instant } from './features/instant.ts';
import { optimistic, type PagePatches } from './features/optimistic.ts';
import { prefetch, type Prefetches } from './features/prefetch.ts';
import { queryState } from './features/query-state.ts';
import { remember, type RememberFeature } from './features/remember.ts';
import { revalidateOnBack } from './features/revalidate-on-back.ts';
import type { ActionOutcome } from './action.ts';
import { REGIONS } from './region.ts';
import { REMEMBERED } from './remember.ts';
import { boot, FakeWindow, ORIGIN, page, pageResponse, settle } from './test-window.ts';
import { TOP } from './scroll.ts';

/**
 * The security matrix (Wave 5c step 3, E70): every feature × every event that must make what a signed-in user saw disappear —
 * a 409 for signing out (`history`), a 409 for a new build (`version`), memory letting go of an entry (LRU), a new scope for
 * once props. Data the server sent while "signed in" carries a canary; afterwards no slot a feature used holds it, no hook a
 * feature registered hands it out again, the feature's API does not show it, and no history entry (what the browser writes to
 * disk) contains it.
 *
 * What it can see, honestly: the slots a feature asks the host for (`entry`, `document` — recorded through the host it gets),
 * the hooks it registers and what they return for probe input, and what its API exposes (enumerable fields, getters). It
 * cannot see a feature's closures or private fields: a feature that hides data there and never hands it out again goes
 * unnoticed — one that hands it out again (a hook, its API) is caught, see the counter-checks at the end.
 */

const CANARY = 'CANARY-signed-in';
const secretPage = (url: string, component = 'pages/Show', extra: Partial<PageObject> = {}): PageObject => ({ ...page(url, { secret: `${CANARY} ${url}` }, component), ...extra });
const conflict = (reason: 'history' | 'version', location = '/login') => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: location, [RELOAD_HEADER]: reason } });
const islandResponse = (body: RegionObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', 'content-type': 'application/json' } });

/** A response that never comes — until the request is aborted. */
const pending = (init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));

/** Whether `value` holds the canary anywhere — strings, arrays, maps, sets, objects, their getters. */
function holdsCanary(value: unknown, seen = new Set<unknown>(), depth = 0): boolean {
  if (typeof value === 'string') return value.includes(CANARY);
  if (typeof value !== 'object' || value === null || seen.has(value) || depth > 8) return false;
  if (value instanceof AbortController || value instanceof AbortSignal || value instanceof Promise) return false;
  seen.add(value);
  const next = (item: unknown) => holdsCanary(item, seen, depth + 1);
  if (value instanceof Map) return [...value].some(([key, item]) => next(key) || next(item));
  if (value instanceof Set || Array.isArray(value)) return [...value].some(next);
  const items: unknown[] = Object.values(value);
  for (let proto = Object.getPrototypeOf(value); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(proto))) {
      if (!descriptor.get) continue;
      try {
        items.push(descriptor.get.call(value));
      } catch {
        // A getter that needs more than the object: not data.
      }
    }
  }
  return items.some(next);
}

/** Whether a slot's value was emptied — its size, its list, or nothing defined left in it. */
function emptied(value: unknown): boolean {
  if (value instanceof Map || value instanceof Set) return value.size === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value !== 'object' || value === null) return true;
  const { size, list } = value as { size?: unknown; list?: unknown };
  if (typeof size === 'number') return size === 0;
  if (Array.isArray(list)) return list.length === 0;
  return Object.values(value).every((item) => item === undefined);
}

/** What the matrix saw a feature do through its host. */
interface Recorded {
  readonly feature: string;
  readonly slots: { readonly slot: Slot<unknown>; readonly key: string | undefined; readonly value: unknown }[];
  readonly hooks: [FeatureHook, (...args: never[]) => unknown][];
  api?: unknown;
}

/** `feature`, set up with a host that records the slots it uses and the hooks it registers. */
function recorded(feature: Feature, into: Recorded[]): Feature {
  return defineFeature(feature.name, (host) => {
    const record: Recorded = { feature: feature.name, slots: [], hooks: [] };
    into.push(record);
    const watched = new Proxy(host, {
      get(target, name) {
        if (name === 'entry') {
          return (slot: Slot<unknown>, key?: string) => {
            const value = target.entry(slot, key);
            record.slots.push({ slot, key: key ?? target.key, value });
            return value;
          };
        }
        if (name === 'document') {
          return (slot: Slot<unknown>) => {
            const value = target.document(slot);
            if (!record.slots.some((seen) => seen.value === value)) record.slots.push({ slot, key: undefined, value });
            return value;
          };
        }
        if (name === 'on') {
          return (hook: FeatureHook, run: (...args: never[]) => unknown) => {
            record.hooks.push([hook, run]);
            return target.on(hook, run as never);
          };
        }
        return Reflect.get(target, name, target);
      },
    });
    record.api = feature.setup(watched);
    return record.api;
  }, feature.order);
}

/** A visit as the `start` hook sees it — a plain GET of `url`, for probing what a feature hands back. */
const probeVisit = (url: string): PendingVisit => ({ options: {}, method: 'get', target: new URL(url, ORIGIN), from: undefined, layer: false, keeps: false, leaving: () => true, url, partial: false, takes: true });

/**
 * What still holds signed-in data after an event, by feature: a slot not emptied, a hook that hands the data out again (probed
 * with canary-free input for every entry key it may know), an API that shows it.
 */
async function leftovers(records: readonly Recorded[], keys: readonly string[], urls: readonly string[], scope: (key: string | undefined) => boolean = () => true): Promise<string[]> {
  const problems: string[] = [];
  const probe = page('/probe', {}, 'pages/Probe');
  for (const { feature, slots, hooks, api } of records) {
    for (const { slot: used, key, value } of slots) {
      if (!scope(key)) continue;
      if (!emptied(value) || holdsCanary(value)) problems.push(`${feature}: its slot "${used.name}"${key ? ` of entry ${key}` : ''} still holds data`);
    }
    for (const [hook, run] of hooks) {
      const calls: unknown[][] = {
        paint: keys.map((key) => [key, probe]),
        stack: keys.map((key) => [key]),
        state: keys.map((key) => [key, TOP]),
        extras: [[]],
        top: [[]],
        pinned: [[]],
        position: [[]],
        unsaved: [[() => true, []]],
        start: urls.map((url) => [probeVisit(url)]),
      }[hook as string] ?? [];
      for (const args of calls) {
        let result = (run as (...args: unknown[]) => unknown)(...args);
        const part = result as { page?: Promise<unknown> } | undefined;
        if (part?.page) result = await part.page;
        if (holdsCanary(result)) problems.push(`${feature}: its hook "${hook}" hands out signed-in data`);
      }
    }
    if (holdsCanary(api)) problems.push(`${feature}: its API still shows signed-in data`);
  }
  return [...new Set(problems)];
}

/**
 * Every feature a navigator can attach: those attached by default and those an adapter attaches where they are used (Wave 5c
 * step 4, E70) — the matrix holds them all to the same rules.
 */
const ALL_FEATURES: readonly Feature[] = [...DEFAULT_FEATURES, optimistic, actions, remember, queryState, prefetch, revalidateOnBack, instant];

/** A signed-in tab where every feature holds the canary somewhere — and what it takes to look at it all again. */
async function stocked({ extra = [], cacheSize }: { extra?: readonly Feature[]; cacheSize?: number } = {}) {
  const win = new FakeWindow(`${ORIGIN}/users/1`);
  win.confirmAnswer = true;
  const records: Recorded[] = [];
  const features = [...ALL_FEATURES, ...extra].map((feature) => recorded(feature, records));
  win.handler = (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/islands/activity') return islandResponse({ component: 'dashboard/Activity', props: { items: [CANARY] }, url: pathname, version: null });
    if (pathname === '/users/1/like') return pending(init);
    if (pathname === '/users/1/edit') return pageResponse(secretPage(pathname, 'users/Edit', { layer: { key: 'edit', base: '/users/1' } }));
    return pageResponse(secretPage(pathname));
  };
  const initial: PageObject = { ...secretPage('/users/1', 'users/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'ada' };
  initial.props.locales = [CANARY];
  const tab = boot(win, initial, { features, ...(cacheSize ? { cacheSize } : {}) });
  const { navigator } = tab;
  const host = navigator.use(defineFeature('probe', (given: FeatureHost) => given));
  const pageKey = host.key!;

  // Every feature (and the core) gets something to keep: a page fetched ahead, an island, remembered input, an action under way
  // with its optimistic patch and its listing, a flash message nobody heard yet, a layer, a guard.
  // What adapters use of the features attached where they are used — through the recorded ones.
  const api = <API>(name: string) => records.find((record) => record.feature === name)!.api as API;
  await api<Prefetches>('prefetch').prefetch('/users/2');
  await navigator.region('/islands/activity').load();
  const submissions = () => api<ActionsFeature>('actions').submissions().list;
  api<RememberFeature>('remember').of(pageKey).set('draft', { note: CANARY });
  const liking = new AbortController();
  const action = api<ActionsFeature>('actions').run('/users/1/like', { data: { note: CANARY }, name: 'like', signal: liking.signal, optimistic: { target: api<PagePatches>('optimistic').target(pageKey), patch: (props) => ({ ...props, liked: CANARY }) } });
  host.flash.deliver([{ id: 'unheard', key: 'toast', data: CANARY } as unknown as FlashMessage]);
  await navigator.visit('/users/1/edit', { layer: true });
  navigator.guard({ message: 'Unsaved', active: () => false });
  const layerKey = navigator.layers[0]!.entry;
  // What the core itself keeps — once props, flash messages, the islands of the page's entry — and the remembered input of it.
  const core = { once: host.once, flash: host.flash, regions: host.entry(REGIONS, pageKey), remembered: host.entry(REMEMBERED, pageKey) };
  const prefetched = () => api<Prefetches>('prefetch').size;
  return { win, tab, navigator, host, records, core, action, liking, pageKey, layerKey, submissions, prefetched };
}

/** What the core still keeps of the signed-in user after the document was left. */
function coreLeftovers({ core, navigator, host, submissions, prefetched }: Awaited<ReturnType<typeof stocked>>): string[] {
  const problems: string[] = [];
  if (core.once.size > 0) problems.push('core: once props');
  const heard: unknown[] = [];
  core.flash.listen((message) => heard.push(message));
  host.flash.listen((message) => heard.push(message));
  if (heard.length > 0) problems.push('core: a flash message nobody heard');
  if (core.regions.size > 0 || holdsCanary(core.regions)) problems.push('core: the islands of the page’s entry');
  if (core.remembered.size > 0) problems.push('remember: remembered input');
  if (navigator.cachedPages > 0) problems.push('core: pages in memory');
  if (navigator.layers.length > 0 || submissions().length > 0 || prefetched() > 0) problems.push('core: the navigator still lists data');
  return problems;
}

/** Every history entry as the browser keeps it (serialized, written to disk) — with the canary in it, or not. */
const historyWithCanary = (win: FakeWindow) => win.entries.filter((entry) => entry.state.includes(CANARY)).map((entry) => entry.url);

describe('the security matrix — every feature × every event that must forget the signed-in user (E70, E36)', () => {
  it('every feature holds something before (or the matrix would prove nothing)', async () => {
    const tab = await stocked();
    expect(tab.core.once.size).toBe(1);
    expect(tab.core.regions.size).toBe(1);
    expect(tab.submissions()).toHaveLength(1);
    expect(tab.prefetched()).toBe(1);
    // What each default feature keeps — so every row of the matrix below checks real data. (Probing takes the prefetched page.)
    expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^prefetch: its slot "prefetched"/),
        expect.stringMatching(/^remember: its slot "remembered"/),
        expect.stringMatching(/^layers: its slot "layers"/),
        expect.stringMatching(/^optimistic: its slot "patches"/),
        expect.stringMatching(/^actions: its slot "submissions"/),
        expect.stringMatching(/^layers: its hook "extras" hands out/),
        expect.stringMatching(/^optimistic: its hook "paint" hands out/),
        expect.stringMatching(/^prefetch: its hook "start" hands out/),
      ]),
    );
  });

  for (const reason of ['history', 'version'] as const) {
    it(`a 409 (${reason === 'history' ? 'signed out' : 'a new build'}) leaves nothing of it — in no feature, not in the core, not in history.state`, async () => {
      const tab = await stocked();
      tab.win.handler = () => conflict(reason);
      await tab.navigator.visit('/users/3');
      expect(tab.win.loads).toEqual(['assign /login']);
      expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual([]);
      expect(coreLeftovers(tab)).toEqual([]);
      expect(historyWithCanary(tab.win)).toEqual([]);
      // The action under way ends without its answer — it lands nowhere.
      expect(await tab.action).toEqual({ ok: false, kind: 'cancelled' } satisfies ActionOutcome);
    });
  }

  it('memory letting go of an entry (LRU) empties what every feature kept of it — the page’s and the layer’s', async () => {
    const tab = await stocked({ cacheSize: 3 });
    // The action ends first (see the next test for one still under way).
    tab.liking.abort();
    await tab.action;
    // Away from the layer and the page, until memory lets go of both.
    tab.win.handler = (url) => pageResponse(page(new URL(url).pathname, {}, 'pages/Other'));
    for (const url of ['/b', '/c', '/d', '/e']) await tab.navigator.visit(url);
    expect(tab.navigator.cachedPages).toBe(3);
    const gone = new Set([tab.pageKey, tab.layerKey]);
    expect(await leftovers(tab.records, [...gone], [], (key) => key !== undefined && gone.has(key))).toEqual([]);
    expect(tab.core.regions.size).toBe(0);
    expect(tab.core.remembered.size).toBe(0);
    for (const key of gone) expect([tab.host.peek(REGIONS, key), tab.host.peek(REMEMBERED, key)]).toEqual([undefined, undefined]);
    // Back to the page: the server is asked — nothing comes back from memory.
    tab.win.index = 0;
    tab.win.dispatch('popstate', { state: tab.win.history.state });
    await settle();
    await settle();
    expect(tab.win.requests.at(-1)?.url).toBe(`${ORIGIN}/users/1`);
    expect(tab.navigator.page).toMatchObject({ url: '/users/1', props: {} });
    expect(tab.navigator.use(remember).of(tab.tab.owner().entry!).has('draft')).toBe(false);
  });

  it('an action still under way keeps its optimistic patch on an entry memory let go of — the user’s own change, until it ends', async () => {
    const tab = await stocked({ cacheSize: 3 });
    tab.win.handler = (url) => pageResponse(page(new URL(url).pathname, {}, 'pages/Other'));
    for (const url of ['/b', '/c', '/d', '/e']) await tab.navigator.visit(url);
    // Per document, not per entry (the action settles it on the entry whether it is in memory or not): Back to the entry while
    // the action is under way shows it over the server's page again.
    expect(await leftovers(tab.records, [tab.pageKey], [], () => false)).toEqual(['optimistic: its hook "paint" hands out signed-in data']);
    tab.liking.abort();
    await tab.action;
    expect(await leftovers(tab.records, [tab.pageKey], [], () => false)).toEqual([]);
  });

  it('a page of another scope (someone else signed in, in another tab) drops every once prop kept — never put back', async () => {
    const tab = await stocked();
    tab.win.handler = () => pageResponse({ ...page('/users/3', {}, 'pages/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'grace' });
    const shown = await tab.navigator.visit('/users/3');
    expect(shown?.props).toEqual({});
    expect(tab.core.once.size).toBe(0);
    // Not a document change: the other features keep their data — the 409 of signing in or out takes it (E66: no tab sync).
  });

  it('counter-check: catches a feature that keeps data outside its slots (a module-level map) and hands it out again', async () => {
    const kept = new Map<string, unknown>();
    const leaky = defineFeature('leaky', (host) => {
      host.on('paint', (key, shown) => {
        if (!kept.has(key)) kept.set(key, shown.props);
        return { ...shown, props: { ...shown.props, earlier: kept.get(key) } };
      });
    });
    const tab = await stocked({ extra: [leaky] });
    tab.win.handler = () => conflict('history');
    await tab.navigator.visit('/users/3');
    expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual(['leaky: its hook "paint" hands out signed-in data']);
  });

  it('counter-check: catches a feature whose slot does not empty', async () => {
    const FORGETFUL = slot('forgetful', () => new Map<string, unknown>(), () => undefined);
    const forgetful = defineFeature('forgetful', (host) => host.on('paint', (key, shown) => (host.document(FORGETFUL).set(key, shown.props), shown)));
    const tab = await stocked({ extra: [forgetful] });
    tab.win.handler = () => conflict('history');
    await tab.navigator.visit('/users/3');
    expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual(['forgetful: its slot "forgetful" still holds data']);
  });
});
