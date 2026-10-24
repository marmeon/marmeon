/**
 * The in-page bar: plain DOM in a shadow root, so it shows any adapter's app (docs/devtools.md#the-bar-on-every-page). The
 * app's data it shows is read from the data feature's slots when it renders and kept nowhere else; `sessionStorage` holds
 * only whether the panel is open and which tab — never props.
 */
import type { DevtoolsFeature } from '@marmeon/http/client/adapter';
import type { Layer, Navigator, Region, TimelineEntry } from '@marmeon/http/client/adapter';
import type { PageObject } from '@marmeon/http/protocol';
import type { AnyEntry, RequestEntryContent } from '../entry.ts';
import { h, json, jsonBytes, size, STYLES, type Child } from './dom.ts';

export const TABS = ['visits', 'page', 'layers', 'optimistic', 'server', 'ssr'] as const;
export type BarTab = (typeof TABS)[number];
const LABELS: Record<BarTab, string> = { visits: 'Visits', page: 'Page', layers: 'Layers & regions', optimistic: 'Optimistic', server: 'Server', ssr: 'SSR' };

/** Where the panel's state is kept — `{ open, tab }`, nothing else. */
export const STATE_KEY = 'marmeon-devtools';
/** The devtools' JSON API. */
const API = '/_marmeon/devtools/api';
/** Opens and closes the panel. */
export const SHORTCUT = 'Alt+Shift+D';

/** What the server recorded for a request (`/api/requests/:id`). */
interface ServerRecord {
  readonly requestId: string;
  readonly entries: readonly AnyEntry[];
}

/** A place in the app's sources (`/api/source`). */
interface SourceLocation {
  readonly display: string;
  readonly editor: string;
}

/** What the bar fetched — kept in the data feature's slot (`cache`), so it goes with the document. */
type Fetched = { readonly state: 'loading' } | { readonly state: 'failed'; readonly status: number } | { readonly state: 'done'; readonly value: unknown };

export interface BarOptions {
  readonly navigator: Navigator;
  readonly api: DevtoolsFeature;
  /** Where the bar's host element goes — default `document.body`. */
  readonly parent?: HTMLElement;
  /** The window (its `sessionStorage`, keys and `fetch`) — default `window`. */
  readonly window?: Window;
}

/** The panel's state as stored: open or not, which tab — never anything of the page. */
interface StoredState {
  readonly open: boolean;
  readonly tab: BarTab;
}

function readState(win: Window): StoredState {
  try {
    const stored = JSON.parse(win.sessionStorage.getItem(STATE_KEY) ?? 'null') as Partial<StoredState> | null;
    return { open: stored?.open === true, tab: TABS.includes(stored?.tab as BarTab) ? (stored!.tab as BarTab) : 'visits' };
  } catch {
    return { open: false, tab: 'visits' };
  }
}

/** `0.16 ms`, `12 ms`. */
const ms = (value: number) => `${value < 10 ? value.toFixed(2).replace(/\.?0+$/, '') : Math.round(value)} ms`;
const since = (at: number, from: number) => `+${((at - from) / 1000).toFixed(2)}s`;
const duration = (entry: TimelineEntry) => (entry.end === undefined ? '…' : `${entry.end - entry.at} ms`);
const statusClass = (entry: TimelineEntry) =>
  entry.outcome === 'failed' ? 'bad' : entry.outcome === 'invalid' || entry.outcome === 'reload' || entry.outcome === 'cancelled' ? 'warn' : 'ok';

export class DevtoolsBar {
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
  readonly #navigator: Navigator;
  readonly #api: DevtoolsFeature;
  readonly #window: Window;
  readonly #fetch: Window['fetch'];
  #open: boolean;
  #tab: BarTab;
  /** The request the Server tab shows — chosen in the Visits tab (a request id, no data). */
  #selected: string | undefined;
  #scheduled = false;
  #destroyed = false;
  readonly #stops: (() => void)[] = [];
  /** What the panel follows besides the feature: the regions and layers on screen. */
  #watched: (() => void)[] = [];
  /** What "open in editor" said last, by view or controller (a file's path — no data of the app). */
  readonly #opened = new Map<string, string>();

  constructor({ navigator, api, parent = document.body, window: win = window }: BarOptions) {
    this.#navigator = navigator;
    this.#api = api;
    this.#window = win;
    // The window's own fetch at the time the bar starts — the data feature records only the core's requests, never these.
    this.#fetch = win.fetch.bind(win);
    ({ open: this.#open, tab: this.#tab } = readState(win));
    this.host = h('div', { 'data-marmeon-devtools': true });
    this.root = this.host.attachShadow({ mode: 'open' });
    adoptStyles(this.root, win);
    parent.append(this.host);
    // A modal dialog (a layer) makes everything outside it inert — the bar too: while one is open, the bar lives in the top one.
    const observer = new MutationObserver(() => this.#place(parent));
    observer.observe(parent.ownerDocument.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    this.#stops.push(() => observer.disconnect());
    this.#stops.push(api.subscribe(() => this.#schedule()), navigator.subscribe(() => this.#schedule()));
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();
        this.toggle();
      }
    };
    win.addEventListener('keydown', onKey);
    this.#stops.push(() => win.removeEventListener('keydown', onKey));
    this.render();
  }

  get open(): boolean {
    return this.#open;
  }

  get tab(): BarTab {
    return this.#tab;
  }

  toggle(open = !this.#open): void {
    this.#open = open;
    this.#store();
    this.render();
  }

  show(tab: BarTab): void {
    this.#tab = tab;
    this.#open = true;
    this.#store();
    this.render();
  }

  /** Shows what the server recorded for request `requestId`. */
  showRequest(requestId: string): void {
    this.#selected = requestId;
    this.show('server');
  }

  destroy(): void {
    this.#destroyed = true;
    for (const stop of this.#stops.splice(0)) stop();
    for (const stop of this.#watched.splice(0)) stop();
    this.host.remove();
  }

  /** In the topmost modal dialog while one is open (the rest of the page is inert then), else in `parent`. */
  #place(parent: HTMLElement): void {
    let modal: Element | undefined;
    try {
      modal = [...parent.ownerDocument.querySelectorAll('dialog[open]')].findLast((dialog) => dialog.matches(':modal') && dialog.isConnected);
    } catch {
      modal = undefined; // a DOM without `:modal`
    }
    const target = modal ?? parent;
    if (this.host.parentNode !== target && !this.#destroyed) target.append(this.host);
  }

  #store(): void {
    try {
      this.#window.sessionStorage.setItem(STATE_KEY, JSON.stringify({ open: this.#open, tab: this.#tab } satisfies StoredState));
    } catch {
      // No storage (a private window, a sandbox): the panel starts closed next time.
    }
  }

  #schedule(): void {
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.render();
    });
  }

  /** Draws the pill, and the panel when it is open — from scratch: what it shows is read now. */
  render(): void {
    for (const stop of this.#watched.splice(0)) stop();
    // What the user opened and where they scrolled stay as they were (a request landing draws the panel again).
    const opened = new Set([...this.root.querySelectorAll('details[open][data-key]')].map((element) => element.getAttribute('data-key')));
    const scrolled = this.root.querySelector('.body')?.scrollTop ?? 0;
    const container = h('div', { class: 'marmeon-devtools' }, this.#pill(), this.#open ? this.#panel() : null);
    for (const element of container.querySelectorAll('details[data-key]')) if (opened.has(element.getAttribute('data-key'))) element.setAttribute('open', '');
    const style = this.root.querySelector('style');
    this.root.replaceChildren(...(style ? [style] : []), container);
    const body = this.root.querySelector('.body');
    if (body) body.scrollTop = scrolled;
  }

  #pill(): HTMLElement {
    const api = this.#api;
    const last = api.left ? undefined : api.timeline.findLast((entry) => entry.kind !== 'live');
    const problem = api.hydration.length > 0 || last?.outcome === 'failed';
    const label = api.left ? 'leaving' : last ? `${last.kind} ${last.status ?? ''} ${last.end !== undefined ? `${last.end - last.at} ms` : '…'}`.replace(/\s+/g, ' ').trim() : 'devtools';
    return h(
      'button',
      { class: 'pill', type: 'button', title: `Marmeon devtools — development only (${SHORTCUT})`, 'aria-expanded': String(this.#open), onclick: () => this.toggle() },
      h('span', { class: `dot${problem ? ' bad' : last?.outcome === 'invalid' || last?.outcome === 'reload' ? ' warn' : ''}` }),
      h('span', {}, 'Marmeon'),
      h('span', { class: 'muted' }, label),
    );
  }

  #panel(): HTMLElement {
    const tabs = TABS.map((tab) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(tab === this.#tab), onclick: () => this.show(tab) }, LABELS[tab], tab === 'ssr' && this.#api.hydration.length > 0 ? ` (${this.#api.hydration.length})` : ''),
    );
    return h(
      'section',
      { class: 'panel', role: 'dialog', 'aria-label': 'Marmeon devtools' },
      h('div', { class: 'head', role: 'tablist' }, h('strong', {}, 'Marmeon'), tabs, h('span', { class: 'spacer' }), h('a', { href: '/_marmeon/devtools', target: '_blank', rel: 'noopener' }, 'All requests ↗'), h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => this.toggle(false) }, '×')),
      h('div', { class: 'body' }, this.#api.left ? h('p', { class: 'empty' }, 'This document is being left (signed in or out, or a new build) — nothing of it is shown or kept.') : this.#body()),
    );
  }

  #body(): Node | Node[] {
    switch (this.#tab) {
      case 'visits':
        return this.#visits();
      case 'page':
        return this.#pages();
      case 'layers':
        return this.#layers();
      case 'optimistic':
        return this.#optimistic();
      case 'server':
        return this.#serverTab();
      case 'ssr':
        return this.#ssr();
    }
  }

  // -- Visits --------------------------------------------------------------------------------------------------------------

  #visits(): Node {
    const timeline = this.#api.timeline;
    if (timeline.length === 0) return h('p', { class: 'empty' }, 'No requests yet.');
    const from = timeline[0]!.at;
    const rows = [...timeline].reverse().map((entry) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono muted' }, since(entry.at, from)),
        h('td', {}, h('span', { class: `badge kind k-${entry.kind}` }, entry.kind)),
        h('td', { class: 'mono' }, `${entry.method} ${entry.url}`, entry.answered && entry.answered !== entry.url ? h('span', { class: 'muted' }, ` → ${entry.answered}`) : null),
        h('td', { class: `mono ${statusClass(entry)}` }, entry.status ?? '', entry.outcome && entry.outcome !== 'ok' ? ` ${entry.outcome}` : ''),
        h('td', { class: 'mono' }, entry.kind === 'live' ? '' : duration(entry)),
        h('td', {}, this.#details(entry)),
        h('td', {}, entry.requestId ? h('button', { class: 'link', type: 'button', title: `Request ${entry.requestId}`, onclick: () => this.showRequest(entry.requestId!) }, 'server') : null),
      ),
    );
    return h('table', {}, h('thead', {}, h('tr', {}, ['', 'Kind', 'Request', 'Status', 'Time', 'Details', ''].map((title) => h('th', {}, title)))), h('tbody', {}, rows));
  }

  #details(entry: TimelineEntry): Node[] {
    const parts: Node[] = [];
    if (entry.component) parts.push(h('span', { class: 'badge' }, entry.component));
    if (entry.name) parts.push(h('span', { class: 'badge' }, `route ${entry.name}`));
    if (entry.only) parts.push(h('span', { class: 'badge' }, `only ${entry.only.join(', ')}`));
    if (entry.except) parts.push(h('span', { class: 'badge' }, `except ${entry.except.join(', ')}`));
    if (entry.location) parts.push(h('span', { class: 'badge' }, `${entry.reload === 'version' ? 'new build' : 'reload'} → ${entry.location}`));
    if (entry.channel) parts.push(h('span', { class: 'badge' }, `channel ${entry.channel}${entry.hinted ? ` (${entry.hinted.join(', ')})` : ''}`));
    if (entry.patches?.length) parts.push(h('button', { class: 'link', type: 'button', onclick: () => this.show('optimistic') }, `${entry.patches.length} optimistic patch${entry.patches.length > 1 ? 'es' : ''}`));
    if (entry.errors) {
      parts.push(
        h('details', { 'data-key': `errors:${entry.id}` }, h('summary', { class: 'warn' }, `${Object.keys(entry.errors).length} invalid field(s)`), h('pre', {}, Object.entries(entry.errors).map(([field, messages]) => `${field}: ${[messages].flat().join(' · ')}`).join('\n'))),
      );
    }
    return parts;
  }

  // -- Page ----------------------------------------------------------------------------------------------------------------

  #pages(): Node[] {
    const levels: [string, PageObject, Layer | undefined][] = [['Page', this.#navigator.page, undefined], ...this.#navigator.layers.map((layer): [string, PageObject, Layer] => [`Layer ${layer.depth}`, layer.page, layer])];
    for (const [, , layer] of levels) if (layer) this.#watched.push(layer.subscribe(() => this.#schedule()));
    return levels.map(([title, page, layer]) => this.#page(title, page, layer));
  }

  #page(title: string, page: PageObject, layer: Layer | undefined): Node {
    const answer = this.#api.answerFor(page.url);
    const record = answer?.requestId ? this.#record(answer.requestId) : undefined;
    const request = record?.entries.find((entry): entry is AnyEntry & { type: 'request'; content: RequestEntryContent } => entry.type === 'request' && !(entry.content as RequestEntryContent).inProcess && (entry.content as RequestEntryContent).page?.component === page.component)
      ?? record?.entries.find((entry): entry is AnyEntry & { type: 'request'; content: RequestEntryContent } => entry.type === 'request' && !(entry.content as RequestEntryContent).inProcess);
    const summary = request?.content.page;
    const shared = new Set(summary?.shared ?? []);
    const optional = summary?.optional ?? [];
    const deferred = Object.entries(page.deferredProps ?? {});
    const streamed = new Set((page.streamedProps ?? []).flatMap((group) => page.deferredProps?.[group] ?? []));
    const merged = new Set([...(page.mergeProps ?? []), ...(page.deepMergeProps ?? [])]);
    const once = new Set(Object.keys(page.onceProps ?? {}));
    const live = new Set((page.live ?? []).flatMap((subscription) => subscription.only ?? []));
    const deferredKeys = new Set(deferred.flatMap(([, keys]) => keys));
    const keys = [...new Set([...Object.keys(page.props), ...deferredKeys, ...optional])];
    const badges = (key: string) => [
      deferredKeys.has(key) && 'deferred',
      streamed.has(key) && 'streamed',
      optional.includes(key) && 'optional',
      merged.has(key) && 'merged',
      once.has(key) && 'once',
      live.has(key) && 'live',
      shared.has(key) && 'shared',
    ].filter((badge): badge is string => typeof badge === 'string');
    const total = jsonBytes(page.props);
    const url = new URL(page.url, this.#window.location.origin);
    return h(
      'div',
      {},
      h('h3', {}, `${title}: `, h('code', {}, page.component), ' ', this.#editor('view', page.component)),
      h(
        'p',
        {},
        h('span', { class: 'badge' }, `url ${page.url}`),
        page.route ? h('span', { class: 'badge' }, `route ${page.route}`) : null,
        request?.content.routePath ? h('span', { class: 'badge' }, `${request.content.method} ${request.content.routePath}`) : null,
        request?.content.controller ? [h('span', { class: 'badge' }, `controller ${request.content.controller}`), ' ', this.#editor('controller', request.content.controller)] : null,
        layer ? h('span', { class: 'badge' }, `key ${layer.key}${layer.once ? ' · once' : ''}`) : null,
      ),
      h(
        'p',
        { class: 'muted' },
        answer
          ? [`Answered by a ${answer.kind} (${answer.status ?? '?'}, ${duration(answer)})`, answer.only ? ` · only ${answer.only.join(', ')}` : '', answer.except ? ` · except ${answer.except.join(', ')}` : '', ' · ', answer.requestId ? h('button', { class: 'link', type: 'button', onclick: () => this.showRequest(answer.requestId!) }, `request ${answer.requestId}`) : 'no request id']
          : 'No answer recorded for this URL (it came before the bar).',
        summary?.only ? ` · server sent only ${summary.only.join(', ')}` : '',
      ),
      url.search || page.query
        ? h(
            'details',
            { 'data-key': `query:${title}` },
            h('summary', {}, 'Query — raw and parsed'),
            h('table', {}, h('tbody', {}, h('tr', {}, h('th', {}, 'raw'), h('td', { class: 'mono' }, url.search || '(none)')), h('tr', {}, h('th', {}, 'parsed'), h('td', {}, h('pre', {}, page.query ? json(page.query) : 'no query schema'))), page.queryDefaults ? h('tr', {}, h('th', {}, 'defaults'), h('td', {}, h('pre', {}, json(page.queryDefaults)))) : null)),
          )
        : null,
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, `Props (${size(total)})`), h('th', {}, ''), h('th', {}, 'Size'))),
        h(
          'tbody',
          {},
          keys.map((key) => {
            const present = Object.hasOwn(page.props, key);
            return h(
              'tr',
              {},
              h('td', { class: 'mono' }, present ? h('details', { 'data-key': `prop:${title}:${key}` }, h('summary', {}, key), h('pre', {}, json(page.props[key]))) : h('span', { class: 'muted' }, `${key} (not sent)`)),
              h('td', {}, badges(key).map((badge) => h('span', { class: 'badge' }, badge))),
              h('td', { class: 'mono' }, present ? size(jsonBytes(page.props[key])) : ''),
            );
          }),
        ),
      ),
      (page.live ?? []).length > 0 ? h('p', { class: 'muted' }, `Live: ${page.live!.map((subscription) => `${subscription.channel}${subscription.only ? ` → ${subscription.only.join(', ')}` : ' → every prop'}`).join(' · ')}`) : null,
    );
  }

  /** "Open in editor" for a view or a controller — through `/api/source` and Vite's `/__open-in-editor`. */
  #editor(kind: 'view' | 'controller', name: string): Node {
    const key = `source:${kind}:${name}`;
    const found = this.#api.cache.get(key) as Fetched | undefined;
    const said = (text: string) => {
      this.#opened.set(key, text);
      this.#schedule();
    };
    const status = h('span', { class: 'muted' }, this.#opened.get(key) ?? '');
    return h(
      'span',
      {},
      h(
        'button',
        {
          class: 'link',
          type: 'button',
          title: found?.state === 'done' ? (found.value as SourceLocation).display : `Open the ${kind} in the editor`,
          onclick: async () => {
            said(' …');
            const location = (await this.#json(key, `${API}/source?${kind}=${encodeURIComponent(name)}`)) as SourceLocation | undefined;
            if (!location) return said(` ${kind} not found`);
            const response = await this.#fetch(location.editor).catch(() => undefined);
            said(response?.ok ? ` opened ${location.display}` : ` could not open ${location.display} (${response?.status ?? 'offline'})`);
          },
        },
        'open in editor',
      ),
      status,
    );
  }

  // -- Layers & regions ------------------------------------------------------------------------------------------------------

  #layers(): Node[] {
    const page = this.#navigator.page;
    const levels: [string, PageObject, Iterable<Region>][] = [
      ['Page', page, this.#navigator.regionOwner.live.values() as Iterable<Region>],
      ...this.#navigator.layers.map((layer): [string, PageObject, Iterable<Region>] => [`Layer ${layer.depth} (${layer.key}${layer.once ? ', once' : ''})`, layer.page, layer.owner.live.values() as Iterable<Region>]),
    ];
    for (const layer of this.#navigator.layers) this.#watched.push(layer.subscribe(() => this.#schedule()));
    return levels.map(([title, shown, regions]) => {
      const islands = [...regions];
      for (const region of islands) this.#watched.push(region.subscribe(() => this.#schedule()));
      return h(
        'div',
        {},
        h('h3', {}, `${title}: `, h('code', {}, shown.component), h('span', { class: 'muted' }, ` ${shown.url}`)),
        islands.length === 0
          ? h('p', { class: 'muted' }, 'No islands.')
          : h(
              'table',
              {},
              h('thead', {}, h('tr', {}, ['Island', 'Status', 'View', ''].map((label) => h('th', {}, label)))),
              h(
                'tbody',
                {},
                islands.map((region) => {
                  const snapshot = region.snapshot;
                  return h(
                    'tr',
                    {},
                    h('td', { class: 'mono' }, region.url),
                    h('td', { class: snapshot.status === 'ready' ? 'ok' : snapshot.status === 'loading' ? 'muted' : 'bad' }, snapshot.status, snapshot.pending ? ' (loading)' : '', snapshot.failure ? ` — ${snapshot.failure.status ?? 'offline'}${snapshot.failure.message ? ` ${snapshot.failure.message}` : ''}` : ''),
                    h('td', { class: 'mono' }, snapshot.region?.component ?? ''),
                    h('td', { class: 'mono muted' }, snapshot.region ? size(jsonBytes(snapshot.region.props)) : ''),
                  );
                }),
              ),
            ),
      );
    });
  }

  // -- Optimistic ----------------------------------------------------------------------------------------------------------

  #optimistic(): Node {
    const snapshots = this.#api.snapshots;
    if (snapshots.length === 0) return h('p', { class: 'empty' }, 'No optimistic patches yet (useAction, router.optimistic, a form with optimistic).');
    const requests = new Map(this.#api.timeline.map((entry) => [entry.id, entry]));
    return h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ['#', 'With', 'State', 'Changed', 'Before', 'Shown'].map((label) => h('th', {}, label)))),
      h(
        'tbody',
        {},
        [...snapshots].reverse().map((snapshot) => {
          const request = snapshot.request === undefined ? undefined : requests.get(snapshot.request);
          // Taken out: by the server's props when its request went through (reloaded), else rolled back.
          const state = snapshot.state !== 'removed' ? snapshot.state : request?.outcome === 'ok' || request?.outcome === 'redirect' ? 'replaced by the server' : 'rolled back';
          return h(
            'tr',
            {},
            h('td', { class: 'mono' }, snapshot.id),
            h('td', { class: 'mono' }, request ? `${request.kind} ${request.method} ${request.url}${request.status ? ` → ${request.status}` : ''}` : ''),
            h('td', { class: snapshot.state === 'shown' ? 'warn' : state === 'rolled back' ? 'bad' : 'ok' }, state),
            h('td', { class: 'mono' }, Object.keys(snapshot.after ?? {}).join(', ')),
            h('td', {}, snapshot.before ? h('pre', {}, json(snapshot.before, 4000)) : ''),
            h('td', {}, snapshot.after ? h('pre', {}, json(snapshot.after, 4000)) : ''),
          );
        }),
      ),
    );
  }

  // -- Server --------------------------------------------------------------------------------------------------------------

  #serverTab(): Node[] {
    const timeline = this.#api.timeline;
    const choices = [...timeline].reverse().filter((entry) => entry.requestId).slice(0, 40);
    const current = this.#selected ?? this.#api.answerFor(this.#navigator.page.url)?.requestId ?? choices[0]?.requestId;
    const picker = h(
      'select',
      { 'aria-label': 'Request', onchange: (event: Event) => this.showRequest((event.target as HTMLSelectElement).value) },
      choices.map((entry) => {
        const option = h('option', { value: entry.requestId! }, `${entry.kind} ${entry.method} ${entry.url} → ${entry.status ?? ''}`);
        option.selected = entry.requestId === current;
        return option;
      }),
    );
    if (!current) return [h('p', { class: 'empty' }, 'No request with a request id yet.')];
    const fetched = this.#api.cache.get(`request:${current}`) as Fetched | undefined;
    const record = this.#record(current);
    return [
      h('p', {}, picker, ' ', h('a', { href: `/_marmeon/devtools/requests/${encodeURIComponent(current)}`, target: '_blank', rel: 'noopener', class: 'link' }, 'in the devtools ↗')),
      record ? this.#server(record) : h('p', { class: 'empty' }, fetched?.state === 'failed' ? `The server's record could not be read (${fetched.status}).` : 'Loading what the server recorded…'),
    ];
  }

  #server(record: ServerRecord): Node {
    const byType = (type: AnyEntry['type']) => record.entries.filter((entry) => entry.type === type);
    const requests = byType('request') as (AnyEntry & { content: RequestEntryContent })[];
    const section = (title: string, items: readonly AnyEntry[], line: (entry: AnyEntry) => Child) =>
      items.length === 0 ? null : [h('h3', {}, `${title} (${items.length})`), h('table', {}, h('tbody', {}, items.map((entry) => h('tr', {}, h('td', { class: 'mono' }, line(entry))))))];
    const text = (entry: AnyEntry, fields: readonly string[]) =>
      fields
        .map((field) => [field, (entry.content as unknown as Record<string, unknown>)[field]] as const)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([field, value]) => (field === 'durationMs' && typeof value === 'number' ? ms(value) : String(value)))
        .join(' · ');
    if (record.entries.length === 0) return h('p', { class: 'empty' }, 'Nothing recorded for it (ignored by config/devtools.ts, or older than the ring keeps).');
    return h(
      'div',
      {},
      requests.map((entry) =>
        h(
          'p',
          {},
          h('strong', {}, `${entry.content.method} ${entry.content.path}`),
          ` → ${entry.content.status ?? '?'} in ${entry.content.durationMs === undefined ? '?' : ms(entry.content.durationMs)}`,
          entry.content.route ? ` · route ${entry.content.route}` : '',
          entry.content.controller ? ` · ${entry.content.controller}` : '',
          entry.content.inProcess ? ' · in-process' : '',
          entry.content.ssr ? ` · SSR ${entry.content.ssr.durationMs === undefined ? '?' : ms(entry.content.ssr.durationMs)}${entry.content.ssr.failed ? ' (failed)' : ''}` : '',
        ),
      ),
      section('Queries', byType('query'), (entry) => text(entry, ['durationMs', 'sql'])),
      section('Log', byType('log'), (entry) => text(entry, ['level', 'message'])),
      section('Events', byType('event'), (entry) => text(entry, ['name'])),
      section('Jobs', byType('job'), (entry) => text(entry, ['job', 'status', 'durationMs', 'attempt'])),
      section('Mails', byType('mail'), (entry) => text(entry, ['mailable', 'subject'])),
      section('Notifications', byType('notification'), (entry) => text(entry, ['notification', 'channel'])),
      section('Live', byType('live'), (entry) => text(entry, ['channel'])),
      section('Exceptions', byType('exception'), (entry) => text(entry, ['class', 'message'])),
    );
  }

  /** What the server recorded for `requestId` — fetched once, kept in the feature's slot (gone with the document). */
  #record(requestId: string): ServerRecord | undefined {
    const key = `request:${requestId}`;
    const found = this.#api.cache.get(key) as Fetched | undefined;
    if (found?.state === 'done') return found.value as ServerRecord;
    if (!found) void this.#json(key, `${API}/requests/${encodeURIComponent(requestId)}`);
    return undefined;
  }

  /** GET `url` as JSON into the feature's cache under `key` — once; renders again when it is there. */
  async #json(key: string, url: string): Promise<unknown> {
    const cache = this.#api.cache;
    const found = cache.get(key) as Fetched | undefined;
    if (found?.state === 'done') return found.value;
    cache.set(key, { state: 'loading' });
    try {
      const response = await this.#fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store', credentials: 'omit' });
      // The document was left meanwhile: its cache is a new one — nothing lands in it.
      if (this.#api.cache !== cache) return undefined;
      if (!response.ok) {
        cache.set(key, { state: 'failed', status: response.status });
        return undefined;
      }
      const value: unknown = await response.json();
      if (this.#api.cache !== cache) return undefined;
      cache.set(key, { state: 'done', value });
      return value;
    } catch {
      if (this.#api.cache === cache) cache.set(key, { state: 'failed', status: 0 });
      return undefined;
    } finally {
      this.#schedule();
    }
  }

  // -- SSR -----------------------------------------------------------------------------------------------------------------

  #ssr(): Node[] {
    const issues = this.#api.hydration;
    const document = this.#api.timeline.find((entry) => entry.kind === 'document');
    const record = document?.requestId ? this.#record(document.requestId) : undefined;
    const ssr = (record?.entries.find((entry) => entry.type === 'request' && !(entry.content as RequestEntryContent).inProcess)?.content as RequestEntryContent | undefined)?.ssr;
    return [
      h('h3', {}, 'Server rendering of this document'),
      h('p', { class: 'muted' }, ssr ? `${ssr.component}: ${ssr.durationMs === undefined ? '?' : ms(ssr.durationMs)}${ssr.streamed ? ', streamed' : ''}${ssr.complete ? '' : ', shell first'}${ssr.failed ? ' — failed, rendered in the browser' : ''}` : 'Not recorded (rendered in the browser, or before the bar).'),
      h('h3', {}, `Hydration (${issues.length})`),
      issues.length === 0
        ? h('p', { class: 'empty' }, 'No hydration errors — the server’s markup matched.')
        : h(
            'div',
            {},
            [...issues].reverse().map((issue) =>
              h('details', { open: true }, h('summary', { class: 'bad' }, `${issue.server ? 'Failed on the server' : 'Mismatch'} in ${issue.component}: ${issue.message.split('\n')[0]}`), h('pre', {}, issue.message, issue.stack ? `\n\n${issue.stack}` : '')),
            ),
          ),
    ];
  }
}

/**
 * The bar's look as a constructed stylesheet of its shadow root: the CSSOM, which no `style-src` blocks — a `<style>` element
 * without the response's nonce is what a strict policy refuses (the app's `contentSecurityPolicy({ styleSrc: ["'self'"] })` runs
 * under `marmeon dev` too). A browser (or test DOM) without constructed stylesheets gets the `<style>` element.
 */
function adoptStyles(root: ShadowRoot, win: Window): void {
  const Sheet = (win as Window & { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet;
  if (Sheet && 'adoptedStyleSheets' in root && typeof Sheet.prototype.replaceSync === 'function') {
    const sheet = new Sheet();
    sheet.replaceSync(STYLES);
    root.adoptedStyleSheets = [sheet];
    return;
  }
  root.append(h('style', {}, STYLES));
}
