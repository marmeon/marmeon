import { describe, expect, it } from 'vitest';
import { LOCATION_HEADER, ONCE_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, type FlashMessage, type PageObject, type RegionObject } from '../page.ts';
import type { FeatureHost } from './core.ts';
import { defineFeature, slot, type Feature, type FeatureHook, type PendingVisit, type Slot } from './feature.ts';
import { actions, type ActionsFeature } from './features/actions.ts';
import { layers, type LayerStack } from './features/layers.ts';
import { instant } from './features/instant.ts';
import { guard, type Guards } from './features/guard.ts';
import { optimistic, type PagePatches } from './features/optimistic.ts';
import { prefetch, type Prefetches } from './features/prefetch.ts';
import { queryState } from './features/query-state.ts';
import { remember, type RememberFeature } from './features/remember.ts';
import { revalidateOnBack } from './features/revalidate-on-back.ts';
import type { ActionOutcome } from './action.ts';
import { REGIONS } from './owner.ts';
import { islands, type IslandsFeature } from './features/islands.ts';
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
 * Every feature a navigator can attach — an adapter attaches each where it is used (Wave 5c, E70), the core loads the layers
 * itself when the server answers with one (E71): the matrix holds them all to the same rules.
 */
const ALL_FEATURES: readonly Feature[] = [layers, optimistic, actions, remember, queryState, prefetch, revalidateOnBack, instant, guard, islands];

/** A signed-in tab where every feature holds the canary somewhere — and what it takes to look at it all again. */
async function stocked({ extra = [], cacheSize, lazyLayers }: { extra?: readonly Feature[]; cacheSize?: number; lazyLayers?: Promise<void> } = {}) {
  const win = new FakeWindow(`${ORIGIN}/users/1`);
  win.confirmAnswer = true;
  const records: Recorded[] = [];
  // `lazyLayers`: the layers are not attached — their code arrives (recorded like the others) once the promise resolves (E71).
  const features = [...ALL_FEATURES.filter((feature) => !lazyLayers || feature !== layers), ...extra].map((feature) => recorded(feature, records));
  const loadLayers = lazyLayers && (async () => (await lazyLayers, recorded(layers, records) as Feature<LayerStack>));
  win.handler = (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/islands/activity') return islandResponse({ component: 'dashboard/Activity', props: { items: [CANARY] }, url: pathname, version: null });
    if (pathname === '/users/1/like') return pending(init);
    if (pathname === '/users/1/edit') return pageResponse(secretPage(pathname, 'users/Edit', { layer: { key: 'edit', base: '/users/1' } }));
    return pageResponse(secretPage(pathname));
  };
  const initial: PageObject = { ...secretPage('/users/1', 'users/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'ada' };
  initial.props.locales = [CANARY];
  const tab = boot(win, initial, { features, ...(cacheSize ? { cacheSize } : {}), ...(loadLayers ? { loadLayers } : {}) });
  const { navigator } = tab;
  const host = navigator.use(defineFeature('probe', (given: FeatureHost) => given));
  const pageKey = host.key!;

  // Every feature (and the core) gets something to keep: a page fetched ahead, an island, remembered input, an action under way
  // with its optimistic patch and its listing, a flash message nobody heard yet, a layer, a guard.
  // What adapters use of the features attached where they are used — through the recorded ones.
  const api = <API>(name: string) => records.find((record) => record.feature === name)!.api as API;
  await api<Prefetches>('prefetch').prefetch('/users/2');
  await api<IslandsFeature>('islands').region('/islands/activity').load();
  const submissions = () => api<ActionsFeature>('actions').submissions().list;
  api<RememberFeature>('remember').of(pageKey).set('draft', { note: CANARY });
  const liking = new AbortController();
  const action = api<ActionsFeature>('actions').run('/users/1/like', { data: { note: CANARY }, name: 'like', signal: liking.signal, optimistic: { target: api<PagePatches>('optimistic').target(pageKey), patch: (props) => ({ ...props, liked: CANARY }) } });
  host.flash.deliver([{ id: 'unheard', key: 'toast', data: CANARY } as unknown as FlashMessage]);
  if (!lazyLayers) await navigator.visit('/users/1/edit', { layer: true });
  api<Guards>('guard').add({ message: 'Unsaved', active: () => false });
  const layerKey = navigator.layers[0]?.entry ?? 'no-layer';
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
  // The islands on screen live on the page's owner (4k): closed with the document, it holds none of them any more.
  if (navigator.regionOwner.live.size > 0) problems.push('core: the islands on screen');
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
    expect(tab.navigator.regionOwner.live.size).toBe(1);
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

/**
 * Layers loaded on demand (Wave 5c step 5, E71): the server answers with a layer and the layers' code is not here yet. While it
 * loads, the answer is held by the visit alone — no slot, no memory, no history entry — so whatever happens meanwhile (a 409:
 * signing out) leaves nothing of it once the code arrives; a code that cannot load is a full load, never a half state.
 */
describe('the security matrix — a layer answer while the layers’ code loads (E71)', () => {
  /** A stocked tab without the layers attached — and the server answering the edit link with a layer full of the canary. */
  async function waiting() {
    let release!: () => void;
    let fail!: () => void;
    const arrival = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = () => reject(new Error('Failed to fetch dynamically imported module'));
    });
    const tab = await stocked({ lazyLayers: arrival });
    expect(tab.navigator.layers).toEqual([]);
    const answer = { ...secretPage('/users/1/edit', 'users/Edit', { layer: { key: 'edit', base: '/users/1' } }), onceProps: { roles: { key: 'roles' } }, onceScope: 'ada' };
    answer.props.roles = [CANARY];
    answer.flash = [{ id: 'saved', key: 'toast', data: CANARY } as unknown as FlashMessage];
    tab.win.handler = (url) => (new URL(url).pathname === '/users/1/edit' ? pageResponse(answer) : conflict('history'));
    const opening = tab.navigator.visit('/users/1/edit');
    // The answer is here; the code is not.
    await settle();
    await settle();
    expect(tab.records.some((record) => record.feature === 'layers')).toBe(false);
    return { ...tab, opening, release, fail };
  }

  it('a 409 (signed out) while the code loads: once it arrives, nothing of the layer is shown or kept — in no feature, not in the core, not in history.state', async () => {
    const tab = await waiting();
    await tab.navigator.reload({ async: true });
    expect(tab.win.loads).toEqual(['replace /login']);
    tab.release();
    expect(await tab.opening).toBeUndefined();
    await settle();
    // The layers attached once their code came — and hold nothing.
    expect(tab.records.some((record) => record.feature === 'layers')).toBe(true);
    expect(tab.navigator.layers).toEqual([]);
    expect(await leftovers(tab.records, [tab.pageKey], ['/users/2'])).toEqual([]);
    expect(coreLeftovers(tab)).toEqual([]);
    expect(historyWithCanary(tab.win)).toEqual([]);
    expect(tab.win.entries).toHaveLength(1);
    expect(tab.win.loads).toEqual(['replace /login']);
  });

  it('the code cannot load: the browser loads the layer’s URL — and nothing of the signed-in tab survives here', async () => {
    const tab = await waiting();
    tab.fail();
    expect(await tab.opening).toBeUndefined();
    expect(tab.win.loads).toEqual(['assign /users/1/edit']);
    expect(await leftovers(tab.records, [tab.pageKey], ['/users/2'])).toEqual([]);
    expect(coreLeftovers(tab)).toEqual([]);
    expect(historyWithCanary(tab.win)).toEqual([]);
    expect(await tab.action).toEqual({ ok: false, kind: 'cancelled' } satisfies ActionOutcome);
  });
});

/**
 * The same rows with the core alone (Wave 5c step 4): no feature attached — what an app is before it uses any. The security
 * invariants are the core's (E72), not a feature's: the hard switch of a 409, memory and once props dropped with the document,
 * a flash message fired once by its id, no page in `history.state`.
 */
describe('the security matrix — the core alone, no feature attached', () => {
  const toast = (id: string): FlashMessage => ({ id, key: 'toast', data: `${CANARY} ${id}` }) as unknown as FlashMessage;

  /** A signed-in tab with the core alone: pages in memory, once props, a flash message nobody listens to yet. */
  async function bare() {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = (url) => pageResponse(secretPage(new URL(url).pathname));
    const initial: PageObject = { ...secretPage('/users/1', 'users/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'ada', flash: [toast('unheard')] };
    initial.props.locales = [CANARY];
    const tab = boot(win, initial, { features: [] });
    for (const url of ['/users/2', '/users/3']) await tab.navigator.visit(url);
    return { win, ...tab };
  }

  for (const reason of ['history', 'version'] as const) {
    it(`a 409 (${reason === 'history' ? 'signed out' : 'a new build'}) loads the page fully and leaves nothing — not in memory, not in history.state`, async () => {
      const { win, navigator } = await bare();
      expect(navigator.cachedPages).toBeGreaterThan(0);
      expect(win.requests.at(-1)!.headers).toMatchObject({ [ONCE_HEADER]: 'locales' });
      win.handler = () => conflict(reason);
      await navigator.visit('/users/4');
      expect(win.loads).toEqual(['assign /login']);
      expect(navigator.cachedPages).toBe(0);
      expect(historyWithCanary(win)).toEqual([]);
      // Nobody listened before the document was left: the message is gone, not waiting for the first listener.
      const heard: unknown[] = [];
      navigator.on('flash', (message) => heard.push(message));
      expect(heard).toEqual([]);
    });
  }

  /**
   * Signed out by a request in the background (a poll, an island, a deferred prop) while the user's own visit is still under
   * way (W5c.6): the document is left — and that visit, started before, never lands. Its answer is what the signed-in user was
   * about to see: not rendered, not in memory, not in history.state, its once props and flash messages not taken.
   */
  for (const kind of ['a visit', 'Back to an entry not in memory'] as const) {
    it(`a 409 (signed out) of a background request while ${kind} is under way: it never lands — nothing of it shown, kept or in history.state`, async () => {
      const { win, navigator, shown } = await bare();
      const host = navigator.use(defineFeature('probe', (given: FeatureHost) => given));
      let answer!: (response: Response) => void;
      win.handler = (url) => (new URL(url).pathname === '/users/9' ? new Promise<Response>((resolve) => (answer = resolve)) : conflict('history'));
      const rendered = shown.length;
      const under = kind === 'a visit' ? navigator.visit('/users/9') : (win.dispatch('popstate', { state: { component: 'users/Show', url: '/users/9', key: 'gone' } }), undefined);
      await settle();
      expect(win.requests.at(-1)!.url).toBe(`${ORIGIN}/users/9`);
      await navigator.reload({ async: true });
      expect(win.loads).toEqual(['replace /login']);
      // The protected page still arrives — after the document was left.
      answer(pageResponse({ ...secretPage('/users/9'), onceProps: { roles: { key: 'roles' } }, onceScope: 'ada', flash: [toast('late')] }));
      expect(await under).toBeUndefined();
      await settle();
      await settle();
      expect(shown).toHaveLength(rendered);
      expect(navigator.page.url).not.toBe('/users/9');
      expect(navigator.cachedPages).toBe(0);
      expect(host.once.size).toBe(0);
      expect(host.inbox).toEqual([]);
      expect(historyWithCanary(win)).toEqual([]);
      expect(win.entries.some((entry) => entry.url.endsWith('/users/9'))).toBe(false);
      const heard: unknown[] = [];
      navigator.on('flash', (message) => heard.push(message));
      expect(heard).toEqual([]);
      expect(win.loads).toEqual(['replace /login']);
    });
  }

  it('a page of another scope drops the once props kept — never put back into it, and the next request names none', async () => {
    const { win, navigator } = await bare();
    win.handler = () => pageResponse({ ...page('/users/9', {}, 'pages/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'grace' });
    const shown = await navigator.visit('/users/9');
    expect(shown?.props).toEqual({});
    await navigator.visit('/users/1');
    expect(win.requests.at(-1)!.headers[ONCE_HEADER]).toBeUndefined();
  });

  it('a flash message fires once, by its id — the same one delivered again (a race, a partial reload) does not fire again', async () => {
    const { win, navigator } = await bare();
    const fired: string[] = [];
    navigator.on('flash', (message) => fired.push(message.id));
    win.handler = () => pageResponse({ ...secretPage('/users/3'), flash: [toast('saved')] });
    await navigator.visit('/users/3', { method: 'put', data: {} });
    await navigator.reload({ only: ['secret'] });
    expect(fired).toEqual(['unheard', 'saved']);
  });

  it('a visit’s own confirmation is asked by the core — a no sends nothing, with no guard attached (4i)', async () => {
    const win = new FakeWindow(`${ORIGIN}/users/1`);
    win.handler = () => pageResponse(page('/logout-done'));
    const asked: string[] = [];
    const { navigator } = boot(win, page('/users/1'), { features: [], confirm: (request) => (asked.push(request.message), false) });
    expect(await navigator.visit('/users/1/delete', { method: 'delete', confirm: 'Delete your account?' })).toBeUndefined();
    expect(asked).toEqual(['Delete your account?']);
    expect(win.requests).toEqual([]);
  });

  it('history.state holds where an entry is, never what it showed — Back and Forward included', async () => {
    const { win, navigator } = await bare();
    win.back();
    await settle();
    win.forward();
    await settle();
    expect(navigator.page.url).toBe('/users/3');
    expect(historyWithCanary(win)).toEqual([]);
    for (const { state } of win.entries.filter((entry) => entry.state !== 'null')) {
      expect(Object.keys(JSON.parse(state) as object).sort()).toEqual(expect.arrayContaining(['component', 'key', 'url']));
      expect(Object.keys(JSON.parse(state) as object).every((field) => ['component', 'url', 'key', 'index', 'scroll', 'scrollRegions'].includes(field))).toBe(true);
    }
  });
});

