import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlashMessage } from '../page.ts';
import { LAYER_BACKDROP } from '../page-support.ts';
import { LOCATION_HEADER, ONCE_HEADER, PAGE_HEADER, REGION_HEADER, RELOAD_HEADER, type PageObject, type RegionObject, PROTOCOL_VERSION } from '../protocol.ts';
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
import { uploads, type UploadsFeature } from './features/uploads.ts';
import { live } from './features/live.ts';
import { liveValidation } from './features/live-validation.ts';
import { devtools, devtoolsReports, type DevtoolsFeature, type DevtoolsGlobal } from './features/devtools.ts';
import { hooks, type ClientHooks } from './features/hooks.ts';
import { tabSync } from './features/tab-sync.ts';
import { selection, type SelectionFeature } from './features/selection.ts';
import { historyFallback } from './features/history-fallback.ts';
import { viewTransitions } from './features/view-transitions.ts';
import { SESSION_PATH } from '../tab-sync-protocol.ts';
import type { Upload } from '../page.ts';
import type { ActionOutcome } from './action.ts';
import { REGIONS } from './owner.ts';
import { visitUrlOf } from './links.ts';
import { Navigator } from './navigation.ts';
import { islands, type IslandsFeature } from './features/islands.ts';
import { REMEMBERED } from './remember.ts';
import { boot, FakeChannels, FakeWindow, ORIGIN, page, pageResponse, PATHS, settle, type FakeEventSource } from './test-window.ts';
import { TOP } from './scroll.ts';
import { loadSensitiveFields } from './remember.ts';

// The rules that tell sensitive fields load on first use; these tests write and read at once.
await loadSensitiveFields();

/**
 * The security matrix: every feature × every event that must make what a signed-in user saw disappear —
 * a 409 for signing out (`history`), a 409 for a new build (`version`), memory letting go of an entry (LRU), a new scope for
 * once props. Data the server sent while "signed in" carries a canary; afterwards no slot a feature used holds it, no hook a
 * feature registered hands it out again, the feature's API does not show it, and no history entry (what the browser writes to
 * disk) contains it.
 *
 * What it can see, honestly: the slots a feature asks the host for (`entry`, `document` — recorded through the host it gets),
 * the hooks it registers and what they return for probe input, and what its API exposes (enumerable fields, getters). It
 * cannot see a feature's closures or private fields: a feature that hides data there and never hands it out again goes
 * unnoticed — one that hands it out again (a hook, its API) is caught, see the last tests of the matrix.
 */

const CANARY = 'CANARY-signed-in';
const secretPage = (url: string, component = 'pages/Show', extra: Partial<PageObject> = {}): PageObject => ({ ...page(url, { secret: `${CANARY} ${url}` }, component), ...extra });
const conflict = (reason: 'history' | 'version', location = '/login') => new Response(null, { status: 409, headers: { [LOCATION_HEADER]: location, [RELOAD_HEADER]: reason } });
const islandResponse = (body: RegionObject) => new Response(JSON.stringify(body), { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, [REGION_HEADER]: 'island', 'content-type': 'application/json' } });

/** An XHR that sends nothing back — until it is aborted (an upload under way): what it was sent, and whether it was aborted. */
class PendingXhr extends EventTarget {
  static readonly opened: PendingXhr[] = [];
  readonly upload = new EventTarget();
  status = 0;
  statusText = '';
  responseText = '';
  responseURL = '';
  url = '';
  aborted = false;
  constructor() {
    super();
    PendingXhr.opened.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getAllResponseHeaders() {
    return '';
  }
  send() {
    this.upload.dispatchEvent(Object.assign(new Event('progress'), { lengthComputable: true, loaded: 1, total: 2 }));
  }
  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }
}

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
 * Every feature a navigator can attach — an adapter attaches each where it is used, the core loads the layers
 * itself when the server answers with one: the matrix holds them all to the same rules.
 */
const ALL_FEATURES: readonly Feature[] = [layers, optimistic, actions, remember, queryState, prefetch, revalidateOnBack, instant, guard, islands, uploads, live, liveValidation, hooks, devtools, tabSync, selection, historyFallback, viewTransitions];

/**
 * Live props are server-driven: the core attaches the feature object it imports (`features/live.ts`) when a page follows a
 * channel. A feature is frozen, so the matrix cannot swap its setup: it hands `use` the recording stand-in for that very
 * feature instead, wherever the core attaches it.
 */
function recordInPlace(feature: Feature, into: Recorded[]): () => void {
  const stand = recorded(feature, into);
  const use = Navigator.prototype.use;
  const spy = vi.spyOn(Navigator.prototype, 'use').mockImplementation(function (this: Navigator, handle: Parameters<Navigator['use']>[0]) {
    return use.call(this, handle === feature ? stand : handle);
  } as Navigator['use']);
  return () => spy.mockRestore();
}

/** A signed-in tab where every feature holds the canary somewhere — and what it takes to look at it all again. */
async function stocked({ extra = [], cacheSize, lazyLayers }: { extra?: readonly Feature[]; cacheSize?: number; lazyLayers?: Promise<void> } = {}) {
  // The browser's channels (tab sync) and the server's session epoch — another tab may change it.
  const channels = new FakeChannels();
  const server = { epoch: 'e1' };
  const win = new FakeWindow(`${ORIGIN}/users/1`, channels);
  win.confirmAnswer = true;
  const records: Recorded[] = [];
  // `lazyLayers`: the layers are not attached — their code arrives (recorded like the others) once the promise resolves.
  // The History fallback only where the tab has no Navigation API — as createMarmeonApp attaches it.
  const features = [...ALL_FEATURES.filter((feature) => feature !== live && (!lazyLayers || feature !== layers) && (!win.navigation || feature !== historyFallback)), ...extra].map((feature) => recorded(feature, records));
  const restoreLive = recordInPlace(live, records);
  const loadLayers = lazyLayers && (async () => (await lazyLayers, recorded(layers, records) as Feature<LayerStack>));
  win.XMLHttpRequest = PendingXhr as never;
  win.handler = (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === SESSION_PATH) return Response.json({ epoch: server.epoch });
    // An upload's target: its token is the signed-in user's — the canary.
    if ((init.headers as Record<string, string> | undefined)?.['x-marmeon-upload']) {
      return Response.json({ token: `tu_${CANARY}`, upload: { method: 'PUT', url: `/_marmeon/uploads/1?signature=${CANARY}` } });
    }
    if (pathname === '/islands/activity') return islandResponse({ component: 'dashboard/Activity', props: { items: [CANARY] }, url: pathname, version: null });
    if (pathname === '/users/1/like') return pending(init);
    if (pathname === '/users/1/edit') return pageResponse(secretPage(pathname, 'users/Edit', { layer: { key: 'edit', base: '/users/1' } }));
    return pageResponse(secretPage(pathname));
  };
  // The page follows a live channel: its token is the signed-in user's — the canary.
  const initial: PageObject = { ...secretPage('/users/1', 'users/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'ada', epoch: 'e1', live: [{ channel: 'users.1', only: ['secret'], token: CANARY }] };
  initial.props.locales = [CANARY];
  const tab = boot(win, initial, { features, ...(cacheSize ? { cacheSize } : {}), ...(loadLayers ? { loadLayers } : {}) });
  // The core loads the live feature: its stream opens, says hello and hints a change — kept until the burst ends.
  for (let i = 0; i < 50 && !win.source; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  restoreLive();
  const stream = win.source as FakeEventSource;
  stream.emit('hello', { seq: { 'users.1': 1 } });
  stream.emit('refresh', { channel: 'users.1', only: ['secret'], seq: 2 });
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
  (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__ = devtoolsReports(() => api<DevtoolsFeature>('devtools'));
  const action = api<ActionsFeature>('actions').run('/users/1/like', { data: { note: CANARY }, name: 'like', signal: liking.signal, optimistic: { target: api<PagePatches>('optimistic').target(pageKey), patch: (props) => ({ ...props, liked: CANARY }) } });
  host.flash.deliver([{ id: 'unheard', key: 'toast', data: CANARY } as unknown as FlashMessage]);
  if (!lazyLayers) await navigator.visit('/users/1/edit', { layer: true });
  // Rows ticked in a table: their keys are the signed-in user's — on the page's entry and on the layer's.
  api<SelectionFeature>('selection').of('members', pageKey).set([CANARY, 7], true);
  if (!lazyLayers) api<SelectionFeature>('selection').of('members', navigator.layers[0]!.entry).selectMatching();
  api<Guards>('guard').add({ message: 'Unsaved', active: () => false });
  // The hook API keeps listeners only; the devtools' bar records every request above — and, through its dev
  // hook, the action's optimistic patch and a hydration error with the page's text.
  api<ClientHooks>('hooks').on('before', () => {});
  const recorder = api<DevtoolsFeature>('devtools');
  recorder.record.recoverable(new Error(`Text content does not match: ${CANARY}`), 'users/Show', false);
  recorder.cache.set('request:1', { entries: [CANARY] });
  // An upload under way: its target answered with the token, its bytes still going (the XHR never answers).
  const uploaded: (Upload | null)[] = [];
  api<UploadsFeature>('uploads').start({ method: 'put', url: '/users/1/avatar', field: 'avatar', file: new File(['png'], 'me.png', { type: 'image/png' }), onChange: (upload) => uploaded.push(upload) });
  await settle();
  await settle();
  const layerKey = navigator.layers[0]?.entry ?? 'no-layer';
  // What the core itself keeps — once props, flash messages, the islands of the page's entry — and the remembered input of it.
  const core = { once: host.once, flash: host.flash, regions: host.entry(REGIONS, pageKey), remembered: host.entry(REMEMBERED, pageKey) };
  const prefetched = () => api<Prefetches>('prefetch').size;
  return { win, tab, navigator, host, records, core, action, liking, pageKey, layerKey, submissions, prefetched, uploaded, stream, channels, server };
}

afterEach(() => {
  delete (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__;
});

/**
 * The records held to what memory lets go of, entry by entry: all but the devtools' bar (development only) — it records
 * the document's requests across its entries (a timeline), and lets go of all of it when the document is left (the 409 rows).
 */
const perEntry = (records: readonly Recorded[]) => records.filter((record) => record.feature !== 'devtools');

/** What the core still keeps of the signed-in user after the document was left. */
function coreLeftovers({ core, navigator, host, submissions, prefetched }: Awaited<ReturnType<typeof stocked>>): string[] {
  const problems: string[] = [];
  if (core.once.size > 0) problems.push('core: once props');
  const heard: unknown[] = [];
  core.flash.listen((message) => heard.push(message));
  host.flash.listen((message) => heard.push(message));
  if (heard.length > 0) problems.push('core: a flash message nobody heard');
  if (core.regions.size > 0 || holdsCanary(core.regions)) problems.push('core: the islands of the page’s entry');
  // The islands on screen live on the page's owner: closed with the document, it holds none of them any more.
  if (navigator.regionOwner.live.size > 0) problems.push('core: the islands on screen');
  if (core.remembered.size > 0) problems.push('remember: remembered input');
  if (navigator.cachedPages > 0) problems.push('core: pages in memory');
  if (navigator.layers.length > 0 || submissions().length > 0 || prefetched() > 0) problems.push('core: the navigator still lists data');
  return problems;
}

/** Every history entry as the browser keeps it (serialized, written to disk) — with the canary in it, or not. */
const historyWithCanary = (win: FakeWindow) => win.entries.filter((entry) => entry.disk.includes(CANARY)).map((entry) => entry.url);

describe.each(PATHS)('%s path', (path) => {
  beforeEach(() => void (FakeWindow.path = path));
  afterEach(() => void (FakeWindow.path = 'navigation'));

  describe('the security matrix — every feature × every event that must forget the signed-in user', () => {
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
          expect.stringMatching(/^uploads: its slot "uploads"/),
          expect.stringMatching(/^live: its slot "live"/),
          expect.stringMatching(/^devtools: its slot "devtools-timeline"/),
          expect.stringMatching(/^devtools: its slot "devtools-snapshots"/),
          expect.stringMatching(/^devtools: its slot "devtools-hydration"/),
          expect.stringMatching(/^devtools: its slot "devtools-cache"/),
          expect.stringMatching(/^devtools: its API still shows/),
          expect.stringMatching(/^tabSync: its slot "tab-sync"/),
          expect.stringMatching(/^selection: its slot "selections" of entry /),
        ]),
      );
      // The live stream is open, its URL holds the signed-in user's token.
      expect([tab.stream.closed, tab.stream.url.includes(CANARY)]).toEqual([false, true]);
      // The upload is on its way: its progress came, its XHR is open.
      expect([tab.uploaded.at(-1)?.status, tab.uploaded.at(-1)?.progress]).toEqual(['uploading', 0.5]);
      expect(PendingXhr.opened.at(-1)?.url).toContain(CANARY);
    });

    it('holds every feature module of the core to its rules — a feature left out of the matrix is one nobody checks', async () => {
      const directory = new URL('./features/', import.meta.url);
      const modules = readdirSync(directory).filter((file) => file.endsWith('.ts') && !file.includes('.test.'));
      const features: string[] = [];
      for (const file of modules) {
        for (const value of Object.values(await import(new URL(file, directory).href))) {
          if (typeof value === 'object' && value !== null && typeof (value as Feature).setup === 'function' && typeof (value as Feature).name === 'string') features.push((value as Feature).name);
        }
      }
      const missing = features.filter((name) => !ALL_FEATURES.some((feature) => feature.name === name));
      expect(missing, `not in ALL_FEATURES: ${missing.join(', ')}`).toEqual([]);
      expect(features.length).toBeGreaterThanOrEqual(17);
    });

    it('an upload under way when the user signs out in another tab (a 409): aborted, its token nowhere — not in the slot, not in its Upload', async () => {
      const tab = await stocked();
      const xhr = PendingXhr.opened.at(-1)!;
      const upload = tab.uploaded.at(-1)!;
      expect(xhr.aborted).toBe(false);
      tab.win.handler = () => conflict('history');
      await tab.navigator.visit('/users/3');
      expect(tab.win.loads).toEqual(['assign https://app.test/login']);
      expect(xhr.aborted).toBe(true);
      expect(JSON.stringify(upload)).toBe('""'); // what a form would send now
      expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual([]);
    });

    it('a 409 in the background (signed out in another tab): the live stream is closed, its slot empty — no hint reloads anything', async () => {
      const tab = await stocked();
      expect(tab.stream.closed).toBe(false);
      tab.win.handler = () => conflict('history');
      await tab.navigator.reload({ async: true });
      expect(tab.win.loads).toEqual(['replace https://app.test/login']);
      expect(tab.stream.closed).toBe(true);
      expect(await leftovers(tab.records.filter((record) => record.feature === 'live'), [tab.pageKey], [])).toEqual([]);
      // What still arrives on the closed stream, or a tab coming back, opens nothing and reloads nothing.
      const requests = tab.win.requests.length;
      tab.stream.emit('refresh', { channel: 'users.1', only: ['secret'], seq: 3 });
      tab.win.show();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(tab.win.sources).toHaveLength(1);
      expect(tab.win.requests).toHaveLength(requests);
      expect(tab.navigator.use(live).updates.pending).toBe(false);
    });

    it('an upload that arrived holds its token until the document is left — then its Upload sends nothing', async () => {
      const tab = await stocked();
      const done: (Upload | null)[] = [];
      class AnsweringXhr extends PendingXhr {
        override send() {
          Object.assign(this, { status: 200, responseText: '{"size":3}' });
          this.dispatchEvent(new Event('load'));
        }
      }
      tab.win.XMLHttpRequest = AnsweringXhr as never;
      tab.navigator.use(uploads).start({ method: 'put', url: '/users/1/avatar', field: 'avatar', file: new File(['png'], 'b.png'), onChange: (upload) => done.push(upload) });
      for (let i = 0; i < 6; i++) await settle();
      const arrived = done.at(-1)!;
      expect([arrived.status, arrived.progress]).toEqual(['uploaded', 1]);
      expect(JSON.stringify({ avatar: arrived })).toBe(`{"avatar":"tu_${CANARY}"}`);
      // Never a property of the Upload — only what it hands to JSON.
      expect(holdsCanary(Object.fromEntries(Object.entries(arrived)))).toBe(false);
      tab.win.handler = () => conflict('history');
      await tab.navigator.visit('/users/3');
      expect(JSON.stringify({ avatar: arrived })).toBe('{"avatar":""}');
    });

    for (const reason of ['history', 'version'] as const) {
      it(`a 409 (${reason === 'history' ? 'signed out' : 'a new build'}) leaves nothing of it — in no feature, not in the core, not in history.state`, async () => {
        const tab = await stocked();
        tab.win.handler = () => conflict(reason);
        await tab.navigator.visit('/users/3');
        expect(tab.win.loads).toEqual(['assign https://app.test/login']);
        const problems = await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2']);
        // The problems as the assertion's message (Vitest shortens the list it prints).
        expect(problems, problems.join('; ')).toEqual([]);
        expect(coreLeftovers(tab)).toEqual([]);
        expect(historyWithCanary(tab.win)).toEqual([]);
        // The action under way ends without its answer — it lands nowhere.
        expect(await tab.action).toEqual({ ok: false, kind: 'cancelled' } satisfies ActionOutcome);
      });
    }

    it('another tab changed the session’s epoch (signed out there): nothing of it is left — in no feature, not in the core, not in history.state', async () => {
      const tab = await stocked();
      // What the core keeps, held from before: it forgets its slot maps when the document is left (a later look would find new ones).
      const { core } = tab;
      tab.server.epoch = 'e2';
      tab.channels.inject({ v: 1, epoch: 'e2' });
      for (let i = 0; i < 6; i++) await settle();
      expect(tab.win.loads).toEqual(['reload']);
      expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual([]);
      expect(coreLeftovers({ ...tab, core })).toEqual([]);
      expect(historyWithCanary(tab.win)).toEqual([]);
      // The action under way ends without its answer, the live stream is closed.
      expect(await tab.action).toEqual({ ok: false, kind: 'cancelled' } satisfies ActionOutcome);
      expect(tab.stream.closed).toBe(true);
    });

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
      const problems = await leftovers(perEntry(tab.records), [...gone], [], (key) => key !== undefined && gone.has(key));
      expect(problems, problems.join('; ')).toEqual([]);
      expect(tab.core.regions.size).toBe(0);
      expect(tab.core.remembered.size).toBe(0);
      for (const key of gone) expect([tab.host.peek(REGIONS, key), tab.host.peek(REMEMBERED, key)]).toEqual([undefined, undefined]);
      // Back to the page: the server is asked — nothing comes back from memory.
      tab.win.goTo(0);
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
      expect(await leftovers(perEntry(tab.records), [tab.pageKey], [], () => false)).toEqual(['optimistic: its hook "paint" hands out signed-in data']);
      tab.liking.abort();
      await tab.action;
      expect(await leftovers(perEntry(tab.records), [tab.pageKey], [], () => false)).toEqual([]);
    });

    it('a page of another scope (someone else signed in, in another tab) drops every once prop kept — never put back', async () => {
      const tab = await stocked();
      tab.win.handler = () => pageResponse({ ...page('/users/3', {}, 'pages/Show'), onceProps: { locales: { key: 'locales' } }, onceScope: 'grace' });
      const shown = await tab.navigator.visit('/users/3');
      expect(shown?.props).toEqual({});
      expect(tab.core.once.size).toBe(0);
      // Not a document change: the other features keep their data — the 409 of signing in or out takes it.
    });

    it('catches a feature that keeps data outside its slots (a module-level map) and hands it out again', async () => {
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

    it('catches a feature whose slot does not empty', async () => {
      const FORGETFUL = slot('forgetful', () => new Map<string, unknown>(), () => undefined);
      const forgetful = defineFeature('forgetful', (host) => host.on('paint', (key, shown) => (host.document(FORGETFUL).set(key, shown.props), shown)));
      const tab = await stocked({ extra: [forgetful] });
      tab.win.handler = () => conflict('history');
      await tab.navigator.visit('/users/3');
      expect(await leftovers(tab.records, [tab.pageKey, tab.layerKey], ['/users/2'])).toEqual(['forgetful: its slot "forgetful" still holds data']);
    });
  });

  /**
   * Layers loaded on demand: the server answers with a layer and the layers' code is not here yet. While it
   * loads, the answer is held by the visit alone — no slot, no memory, no history entry — so whatever happens meanwhile (a 409:
   * signing out) leaves nothing of it once the code arrives; a code that cannot load is a full load, never a half state.
   */
  describe('the security matrix — a layer answer while the layers’ code loads', () => {
    /** A stocked tab without the layers attached — and the server answering the edit link with a layer full of the canary. */
    async function waiting(url = '/users/1/edit') {
      let release!: () => void;
      let fail!: () => void;
      const arrival = new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = () => reject(new Error('Failed to fetch dynamically imported module'));
      });
      const tab = await stocked({ lazyLayers: arrival });
      expect(tab.navigator.layers).toEqual([]);
      const answer = { ...secretPage(url, 'users/Edit', { layer: { key: 'edit', base: '/users/1' } }), onceProps: { roles: { key: 'roles' } }, onceScope: 'ada' };
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
      expect(tab.win.loads).toEqual(['replace https://app.test/login']);
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
      expect(tab.win.loads).toEqual(['replace https://app.test/login']);
    });

    it('the code cannot load: the browser loads the layer’s URL — and nothing of the signed-in tab survives here', async () => {
      const tab = await waiting();
      tab.fail();
      expect(await tab.opening).toBeUndefined();
      expect(tab.win.loads).toEqual(['assign https://app.test/users/1/edit']);
      expect(await leftovers(tab.records, [tab.pageKey], ['/users/2'])).toEqual([]);
      expect(coreLeftovers(tab)).toEqual([]);
      expect(historyWithCanary(tab.win)).toEqual([]);
      expect(await tab.action).toEqual({ ok: false, kind: 'cancelled' } satisfies ActionOutcome);
    });

    it('the code cannot load and the layer’s URL starts with two slashes: the browser loads that path of this site, never another host', async () => {
      const tab = await waiting('//evil.example/x');
      tab.fail();
      expect(await tab.opening).toBeUndefined();
      expect(tab.win.loads).toEqual([`assign ${ORIGIN}//evil.example/x`]);
    });

    it('the code cannot load and the layer’s URL is no http(s) address: the browser loads nothing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const tab = await waiting('javascript:alert(1)');
        tab.fail();
        expect(await tab.opening).toBeUndefined();
        expect(tab.win.loads).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * The same rows with the core alone: no feature attached — what an app is before it uses any. The security
   * invariants are the core's, not a feature's: the hard switch of a 409, memory and once props dropped with the document,
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
        expect(win.loads).toEqual(['assign https://app.test/login']);
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
     * way: the document is left — and that visit, started before, never lands. Its answer is what the signed-in user was
     * about to see: not rendered, not in memory, not in history.state, its once props and flash messages not taken.
     */
    for (const kind of ['a visit', 'Back to an entry not in memory'] as const) {
      it(`a 409 (signed out) of a background request while ${kind} is under way: it never lands — nothing of it shown, kept or in history.state`, async () => {
        const { win, navigator, shown } = await bare();
        const host = navigator.use(defineFeature('probe', (given: FeatureHost) => given));
        let answer!: (response: Response) => void;
        win.handler = (url) => (new URL(url).pathname === '/users/9' ? new Promise<Response>((resolve) => (answer = resolve)) : conflict('history'));
        const rendered = shown.length;
        if (kind !== 'a visit') {
          // An entry whose page memory let go of, right before the one on screen.
          win.entries.splice(win.index, 0, win.entryOf(`${ORIGIN}/users/9`, { component: 'users/Show', url: '/users/9', key: 'gone', scroll: { x: 0, y: 0 } }));
          win.index++;
        }
        const under = kind === 'a visit' ? navigator.visit('/users/9') : (win.back(), undefined);
        await settle();
        expect(win.requests.at(-1)!.url).toBe(`${ORIGIN}/users/9`);
        await navigator.reload({ async: true });
        expect(win.loads).toEqual(['replace https://app.test/login']);
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
        // No entry written for it — Back's own entry (there before) keeps what it held.
        expect(win.entries.filter((entry) => entry.url.endsWith('/users/9')).map((entry) => JSON.parse(entry.state).key)).toEqual(kind === 'a visit' ? [] : ['gone']);
        const heard: unknown[] = [];
        navigator.on('flash', (message) => heard.push(message));
        expect(heard).toEqual([]);
        expect(win.loads).toEqual(['replace https://app.test/login']);
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

    it('a visit’s own confirmation is asked by the core — a no sends nothing, with no guard attached', async () => {
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
});

describe.each(PATHS)('%s path — requests go to the origin that was checked', (path) => {
  beforeEach(() => void (FakeWindow.path = path));
  afterEach(() => void (FakeWindow.path = 'navigation'));

  const EVIL = '//evil.example/x';
  const at = (path: string) => `${ORIGIN}${path}`;

  /** A tab whose page is a path that starts with two slashes — a path on this site, and a host to a careless `fetch`. */
  function odd() {
    const win = new FakeWindow(at(EVIL));
    win.handler = (url) => pageResponse(page(new URL(url).pathname, {}, 'pages/Show'));
    const tab = boot(win, page(EVIL, {}, 'pages/Show'), { features: [] });
    return { win, ...tab };
  }

  it('a reload, a partial reload and a form write fetch this site, never the host the path names', async () => {
    // One tab each: the fake window, like a browser, moves nowhere the first answer's entry could not.
    const sent: string[] = [];
    for (const send of [(tab: ReturnType<typeof odd>) => tab.navigator.reload({ preserveUrl: true }), (tab: ReturnType<typeof odd>) => tab.navigator.reload({ only: ['a'], preserveUrl: true }), (tab: ReturnType<typeof odd>) => tab.navigator.visit(at(EVIL), { method: 'post', data: {}, preserveUrl: true })]) {
      const tab = odd();
      await send(tab);
      sent.push(tab.win.requests[0]!.url);
    }
    expect(sent).toEqual([at(EVIL), at(EVIL), at(EVIL)]);
  });

  it('an action and a prefetch fetch this site as well', async () => {
    const { win, navigator } = odd();
    await navigator.use(actions).run(at(EVIL), { data: {} });
    await navigator.use(prefetch).prefetch(at(EVIL), { layer: true });
    expect(win.requests.length).toBeGreaterThan(1);
    expect(win.requests.map((request) => request.url).every((url) => url === at(EVIL))).toBe(true);
  });

  /** The answer a redirect to another site gives: a page, from a URL that is not this site's. */
  const foreign = () => {
    const response = pageResponse(page('/stolen', { a: 'stolen' }, 'pages/Show'));
    Object.defineProperty(response, 'url', { value: 'https://evil.example/phish' });
    return response;
  };

  it('a visit answered from another site is never read as a page: the browser loads it', async () => {
    const { win, navigator, shown } = odd();
    win.handler = foreign;
    expect(await navigator.visit('/users/2')).toBeUndefined();
    expect(win.loads).toEqual(['assign https://evil.example/phish']);
    expect(shown.map((shownPage) => shownPage.url)).not.toContain('/stolen');
  });

  it('a prefetch answered from another site is dropped — and one from this site is kept', async () => {
    const { win, navigator } = odd();
    const prefetches = navigator.use(prefetch);
    await prefetches.prefetch('/users/3');
    expect(prefetches.size).toBe(1);
    const other = odd();
    other.win.handler = foreign;
    const dropped = other.navigator.use(prefetch);
    await dropped.prefetch('/users/3');
    expect(dropped.size).toBe(0);
    expect(other.win.loads).toEqual([]);
    expect(win.loads).toEqual([]);
  });

  it('a revalidation after an action, answered from another site, changes nothing on the page', async () => {
    const { win, navigator } = odd();
    const target = navigator.use(optimistic).target(navigator.use(defineFeature('probe', (given: FeatureHost) => given)).key!);
    win.handler = (_url, init) => (init.method === 'POST' ? new Response(null, { status: 204 }) : foreign());
    await navigator.use(actions).run(at(EVIL), { data: {}, reload: { target, spec: { only: ['a'] } } });
    expect(navigator.page.props).toEqual({});
    expect(win.loads).toEqual([]);
  });

  it('a layer reloads from this site, and what another site answers is not read as the layer', async () => {
    const { win, navigator } = odd();
    navigator.use(layers);
    win.handler = (url) => pageResponse({ ...page(new URL(url).pathname, {}, 'users/Edit'), layer: { key: 'edit', base: '/users/1' } });
    await navigator.visit(at('//evil.example/edit'), { layer: true });
    const layer = navigator.layers[0]!;
    expect(layer.page.url).toBe('//evil.example/edit');
    win.requests.length = 0;
    await layer.reload();
    expect(win.requests.map((request) => request.url)).toEqual([at('//evil.example/edit')]);
  });

  it('a layer reload answered from another site is not read as the layer: the browser loads it', async () => {
    const { win, navigator } = odd();
    navigator.use(layers);
    win.handler = (url) => pageResponse({ ...page(new URL(url).pathname, {}, 'users/Edit'), layer: { key: 'edit', base: '/users/1' } });
    await navigator.visit('/users/1/edit', { layer: true });
    win.handler = foreign;
    await navigator.layers[0]!.reload();
    expect(win.loads).toEqual(['assign https://evil.example/phish']);
    expect(navigator.page.props).not.toHaveProperty('a', 'stolen');
  });

  it('closing a layer reloads the page from this site', async () => {
    const { win, navigator } = odd();
    navigator.use(layers);
    win.handler = (url) => pageResponse(new URL(url).pathname === '/users/1/edit' ? { ...page('/users/1/edit', {}, 'users/Edit'), layer: { key: 'edit', base: EVIL } } : page(new URL(url).pathname, {}, 'pages/Show'));
    await navigator.visit('/users/1/edit', { layer: true });
    win.requests.length = 0;
    await navigator.layers[0]!.close({ reload: true });
    expect(win.requests.length).toBeGreaterThan(0);
    expect(win.requests.map((request) => request.url).every((url) => url === at(EVIL))).toBe(true);
  });

  it('closing the top layer reloads the layer beneath from this site as well', async () => {
    const { win, navigator } = odd();
    navigator.use(layers);
    win.handler = (url) => {
      const { pathname } = new URL(url);
      const key = pathname === '/b' ? 'b' : 'a';
      return pageResponse(pathname === EVIL ? page(pathname, {}, 'pages/Show') : { ...page(pathname, {}, 'users/Edit'), layer: { key, base: EVIL } });
    };
    await navigator.visit(at('//evil.example/a'), { layer: true });
    await navigator.layers[0]!.visit('/b', { layer: true });
    expect(navigator.layers).toHaveLength(2);
    win.requests.length = 0;
    await navigator.layers[1]!.close({ reload: true });
    expect(win.requests.map((request) => request.url)).toContain(at('//evil.example/a'));
    expect(win.requests.map((request) => request.url).every((url) => url.startsWith(`${ORIGIN}//evil.example/`))).toBe(true);
  });

  it('closing a deep-linked layer over a backdrop visits the page from this site', async () => {
    const win = new FakeWindow(at('/b'));
    win.handler = (url) => pageResponse(page(new URL(url).pathname, {}, 'pages/Show'));
    const { navigator } = boot(win, { ...page(EVIL, {}, LAYER_BACKDROP), layers: [{ ...page('/b', {}, 'users/Edit'), layer: { key: 'b', base: EVIL } }] }, { features: [layers] });
    expect(navigator.layers).toHaveLength(1);
    await navigator.layers[0]!.close();
    expect(win.requests.map((request) => request.url)).toEqual([at(EVIL)]);
  });

  it('an island loads from this site', async () => {
    const { win, navigator } = odd();
    win.handler = () => islandResponse({ component: 'app/Members', props: {}, url: EVIL, version: null } as RegionObject);
    await navigator.use(islands).region(at(EVIL)).load();
    expect(win.requests.map((request) => request.url)).toEqual([at(EVIL)]);
  });

  it('an upload asks its own route at this site — and refuses a route on another', async () => {
    const { win, navigator } = odd();
    const uploading = navigator.use(uploads);
    const file = new File(['png'], 'me.png', { type: 'image/png' });
    uploading.start({ method: 'put', url: at(EVIL), field: 'avatar', file, onChange: () => {} });
    await settle();
    expect(win.requests.map((request) => request.url)).toEqual([at(EVIL)]);
    win.requests.length = 0;
    const states: (Upload | null)[] = [];
    uploading.start({ method: 'put', url: 'https://evil.example/avatar', field: 'avatar', file, onChange: (upload) => states.push(upload) });
    await settle();
    expect(win.requests).toEqual([]);
    expect(states.at(-1)?.status).toBe('failed');
  });

  it('a 409 to another host loads it fully — it is never a client visit', async () => {
    const { win, navigator } = odd();
    win.handler = () => conflict('history', 'https://evil.example/');
    await navigator.visit('/users/2');
    expect(win.loads).toEqual(['assign https://evil.example/']);
    expect(win.requests).toHaveLength(1);
  });

  it('an answer that is no page and has no address of its own is loaded from this site, never as another host', async () => {
    const { win, navigator } = odd();
    win.handler = () => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    await navigator.reload({ preserveUrl: true });
    expect(win.loads).toEqual([`assign ${at(EVIL)}`]);
  });

  it('an action’s 409 that names a path of two slashes loads it from this site', async () => {
    const { win, navigator } = odd();
    win.handler = () => conflict('history', '//evil.example/x');
    await navigator.use(actions).run(at(EVIL), { data: {} });
    expect(win.loads).toEqual([`assign ${at('//evil.example/x')}`]);
  });

  it('a 409 that names a path of two slashes loads it from this site, never as another host', async () => {
    const { win, navigator } = odd();
    win.handler = () => conflict('history', '//evil.example/x');
    await navigator.visit('/users/2');
    expect(win.loads).toEqual([`assign ${at('//evil.example/x')}`]);
  });

  it.each(['/.//evil.example/x', '/a/..//evil.example/x', '/%2e//evil.example/x'])('a link to %s visits this site: a click never leaves it', async (href) => {
    const { win, navigator } = odd();
    const url = visitUrlOf({ button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, href, undefined, win.location);
    expect(url).toBeDefined();
    await navigator.visit(url!);
    expect(win.loads).toEqual([]);
    expect(win.requests.length).toBe(1);
    expect(new URL(win.requests[0]!.url).origin).toBe(ORIGIN);
  });

  describe('only http and https are loaded', () => {
    const REFUSED = ['javascript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'blob:https://app.test/1', 'file:///etc/passwd'];
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => void (errors = vi.spyOn(console, 'error').mockImplementation(() => {})));
    afterEach(() => errors.mockRestore());

    it.each(REFUSED)('a visit to %j loads nothing and sends nothing', async (url) => {
      const { win, navigator } = odd();
      expect(await navigator.visit(url)).toBeUndefined();
      expect(await navigator.visit(url, { method: 'post', data: {} })).toBeUndefined();
      expect(win.loads).toEqual([]);
      expect(win.requests).toEqual([]);
      expect(String(errors.mock.calls[0]?.[0])).toContain('Navigation refused');
    });

    it('a visit to another site over https still loads it', async () => {
      const { win, navigator } = odd();
      await navigator.visit('https://other.example/page');
      expect(win.loads).toEqual(['assign https://other.example/page']);
    });

    it.each(REFUSED)('a 409 that names %j loads no such address', async (url) => {
      for (const reason of ['history', 'version'] as const) {
        const { win, navigator } = odd();
        win.handler = () => conflict(reason, url);
        await navigator.visit('/users/2');
        // Signing in or out still ends this document — the page on screen loads again; a new build waits for an address it can load.
        expect(win.loads).toEqual(reason === 'history' ? ['reload'] : []);
      }
    });

    it('a 409 on a replacing visit and on an action loads the page on screen again, no such address', async () => {
      for (const send of [(tab: ReturnType<typeof odd>) => tab.navigator.visit('/users/2', { replace: true }), (tab: ReturnType<typeof odd>) => tab.navigator.use(actions).run('/users/2', { data: {} })]) {
        const tab = odd();
        tab.win.handler = () => conflict('history', 'javascript:alert(1)');
        await send(tab);
        expect(tab.win.loads).toEqual(['reload']);
      }
    });

    it('a redirect an action reports is visited like any address: nothing for a script URL', async () => {
      const { win, navigator } = odd();
      win.handler = () => new Response(null, { status: 204, headers: { 'x-marmeon-redirect': 'data:text/html,x' } });
      await navigator.use(actions).run('/users/2', { data: {}, onRedirect: 'visit' });
      expect(win.loads).toEqual([]);
    });
  });
});
