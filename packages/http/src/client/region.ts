/**
 * Regions (E50), UI-free: a part of a page that shows the view of *another* route — with its own region object
 * (component, props, URL, query), its own partial reloads, deferred and merged props, its own failures and its own place
 * in memory. An island (`<Island route>`, E48) is a region embedded in a page, without a URL of its own; a layer (W5b step
 * 5) will be a region with a history entry over the page. Adapters render a region's snapshot and call `load`/`reload`.
 *
 * Where a region keeps what it loaded is its {@link RegionOwner}: for islands, the history entry of the page — in this
 * tab's memory only (E36), never in `history.state` or any storage. Back/Forward shows them from there without a request;
 * leaving the document (signing out, a new build) drops them with the pages.
 */
import { PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, type PageObject, type RegionObject } from '../page.ts';
import { mergePage } from './merge.ts';
import { pageQuery, queryUrl } from './query-state.ts';

/** Where a region stands: loading (nothing to show yet), ready, or what kept it from showing anything. */
export type RegionStatus = 'loading' | 'ready' | 'unauthorized' | 'forbidden' | 'exception';

/** Why a region's request failed: offline (no `status`), or the server's error (its status, and its message in development). */
export interface RegionFailure {
  readonly status: number | undefined;
  readonly message?: string | undefined;
  readonly cause?: unknown;
}

/** What an adapter renders of a region — a new object whenever something changed (for `useSyncExternalStore`). */
export interface RegionSnapshot {
  readonly status: RegionStatus;
  /** The region object on screen: the last one that loaded. It stays while a reload is under way — and when one fails. */
  readonly region: RegionObject | undefined;
  /** A request of this region is under way (the first load, a reload, a poll). */
  readonly pending: boolean;
  /** Why the last request failed — the reason of `exception`, or of a failed reload while the region still shows what it had. */
  readonly failure: RegionFailure | undefined;
}

/** A reload of a region: a new query (typed by the island route's query schema in the adapter), or some of its props. */
export interface RegionReloadOptions {
  /** Changes the query — some fields (`undefined` takes one back to its default); the others stay. */
  query?: Readonly<Record<string, unknown>>;
  /** Only these props (a partial reload of the region, merged into what it has). */
  only?: readonly string[];
  /** Every prop but these. */
  except?: readonly string[];
  /** Replace these instead of merging them (`merge()` props) — by default those of `only` when the query changes. */
  reset?: readonly string[];
}

/** How a region request ended, as the navigator's transport reports it. */
export type RegionResponse =
  | { readonly kind: 'region'; readonly region: RegionObject }
  | { readonly kind: 'unauthorized' | 'forbidden' }
  | { readonly kind: 'exception'; readonly failure: RegionFailure }
  /** Aborted — or the document is being left (a 409: the whole page loads again). */
  | { readonly kind: 'cancelled' };

/** Sends a region's requests (the navigator: page headers, the asset version, a 409 loads the whole page again). */
export interface RegionTransport {
  request(url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<RegionResponse>;
}

/**
 * What an owner keeps of a region: its region object — or, when its route turned the user away, only that (no data), so
 * Back/Forward shows the fallback again without asking.
 */
export type KeptRegion = RegionObject | { readonly status: 'unauthorized' | 'forbidden' };

function isRegionObject(kept: KeptRegion | undefined): kept is RegionObject {
  return kept !== undefined && 'component' in kept;
}

/** A region's identity: its URL with the query sorted (`?b=2&a=1` and `?a=1&b=2` are one island). */
export function regionId(url: string): string {
  const parsed = new URL(url, 'http://bespoke.invalid');
  parsed.searchParams.sort();
  return parsed.pathname + parsed.search;
}

/**
 * Where regions live — for islands, one history entry of the page (the navigator makes one per entry it shows). It keeps
 * their region objects (`regions`, the entry's memory) and their live {@link Region}s: one per id, so two identical
 * islands share one request and one state. Closed when its entry leaves the screen or the document is left: every request
 * still under way is aborted, and nothing lands any more.
 */
export class RegionOwner {
  /** What this owner keeps of its regions, by {@link regionId} — what Back/Forward shows without a request. */
  readonly regions: Map<string, KeptRegion>;
  readonly #transport: RegionTransport;
  readonly #controller = new AbortController();
  readonly #live = new Map<string, Region>();

  constructor(transport: RegionTransport, regions: Map<string, KeptRegion> = new Map()) {
    this.#transport = transport;
    this.regions = regions;
  }

  /** Aborted once the owner is closed. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#controller.signal.aborted;
  }

  /**
   * The region of `url` — the same one for the same id. It starts `ready` with what this owner kept of it (Back/Forward)
   * or with `initial` (a region object the server sent along, W5b step 4), else `loading` until `load()`.
   */
  region(url: string, initial?: RegionObject): Region {
    const id = regionId(url);
    const live = this.#live.get(id);
    if (live) return live;
    if (initial && !this.regions.has(id)) this.regions.set(id, initial);
    const region = new Region(this, this.#transport, id, url, this.regions.get(id));
    if (!this.closed) this.#live.set(id, region);
    return region;
  }

  /** The owner's entry left the screen (or the document is left): requests under way are aborted, nothing lands any more. */
  close(): void {
    this.#controller.abort();
    this.#live.clear();
  }
}

/** The headers of a partial reload of `component`. */
function partialHeaders(component: string, only: readonly string[] | undefined, except: readonly string[] | undefined): Record<string, string> {
  return {
    [PARTIAL_COMPONENT_HEADER]: component,
    ...(only === undefined ? {} : { [PARTIAL_DATA_HEADER]: only.join(',') }),
    ...(except && except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
  };
}

/**
 * One region of a page: loads its route's region object, reloads it (another query, some props), loads its deferred props
 * and keeps what it has in its owner. Failures never reach the page: a redirect, a 401 or a 403 of its route is
 * `unauthorized`/`forbidden` (and drops what it showed), a 5xx or offline is `exception` — a page never navigates because
 * of a region. A newer request of the region wins over an older one (it aborts it).
 */
export class Region {
  readonly id: string;
  readonly #owner: RegionOwner;
  readonly #transport: RegionTransport;
  #url: string;
  #region: RegionObject | undefined;
  #status: RegionStatus;
  #failure: RegionFailure | undefined;
  #pending = 0;
  /** The latest request of the region itself (load or reload) — a newer one aborts it. */
  #request: AbortController | undefined;
  #loading: Promise<void> | undefined;
  /** Deferred groups being loaded. */
  readonly #deferred = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #snapshot: RegionSnapshot;

  constructor(owner: RegionOwner, transport: RegionTransport, id: string, url: string, kept?: KeptRegion) {
    this.#owner = owner;
    this.#transport = transport;
    this.id = id;
    const region = isRegionObject(kept) ? kept : undefined;
    this.#url = region?.url ?? url;
    this.#region = region;
    this.#status = region ? 'ready' : kept && !isRegionObject(kept) ? kept.status : 'loading';
    this.#snapshot = this.#take();
  }

  get snapshot(): RegionSnapshot {
    return this.#snapshot;
  }

  /** The URL the region shows (its route with the current query). */
  get url(): string {
    return this.#url;
  }

  /** The region's query, defaults filled in — what its controller saw as `ctx.query` (empty before it loaded). */
  get query(): Record<string, unknown> {
    return this.#region ? pageQuery(this.#region) : {};
  }

  /** Follows the snapshot. Returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * Loads the region, unless it has what to show (kept by its owner: Back/Forward) or is loading already — then only
   * its deferred props still missing. Never rejects.
   */
  load(): Promise<void> {
    if (this.#region) {
      this.#loadDeferred();
      return Promise.resolve();
    }
    if (this.#loading) return this.#loading;
    if (this.#status === 'unauthorized' || this.#status === 'forbidden' || this.#status === 'exception') return Promise.resolve();
    this.#loading = this.#fetch(this.#url, {}).finally(() => (this.#loading = undefined));
    return this.#loading;
  }

  /**
   * Asks the server again — the same query (a poll, after a change), another one (`{ query: { range: '30d' } }`, typed
   * by the adapter) or some props (`only`). Only this region; the page and the other regions stay as they are.
   */
  reload({ query, only, except, reset }: RegionReloadOptions = {}): Promise<void> {
    let url = this.#url;
    if (query) {
      const current = this.#region;
      const values: Record<string, unknown> = { ...(current ? pageQuery(current) : {}) };
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) values[key] = value;
        else if (current?.queryDefaults && Object.hasOwn(current.queryDefaults, key)) values[key] = current.queryDefaults[key];
        else delete values[key];
      }
      url = queryUrl(current ?? { url: this.#url }, values);
    }
    // Another query is another list: merged props start over (`reset`), unless said otherwise.
    const changed = url !== this.#url;
    const partial = only !== undefined || (except?.length ?? 0) > 0;
    return this.#fetch(url, partial ? { only, except, reset: reset ?? (changed ? only : undefined) } : {});
  }

  async #fetch(url: string, { only, except, reset }: Pick<RegionReloadOptions, 'only' | 'except' | 'reset'>): Promise<void> {
    if (this.#owner.closed) return;
    this.#request?.abort();
    const controller = new AbortController();
    this.#request = controller;
    const signal = AbortSignal.any([controller.signal, this.#owner.signal]);
    const current = this.#region;
    const headers = current && (only !== undefined || (except?.length ?? 0) > 0) ? partialHeaders(current.component, only, except) : {};
    this.#pending++;
    this.#emit();
    try {
      const response = await this.#transport.request(url, headers, signal);
      if (signal.aborted || this.#owner.closed || response.kind === 'cancelled') return;
      if (response.kind === 'region') {
        const partial = Object.keys(headers).length > 0 && this.#region && response.region.component === this.#region.component;
        this.#land(partial ? (mergePage(this.#region as PageObject, response.region, reset) as RegionObject) : response.region);
      } else {
        this.#fail(response);
      }
    } finally {
      if (this.#request === controller) this.#request = undefined;
      this.#pending--;
      this.#emit();
    }
  }

  #land(region: RegionObject): void {
    this.#region = region;
    this.#url = region.url;
    this.#status = 'ready';
    this.#failure = undefined;
    this.#owner.regions.set(this.id, region);
    this.#loadDeferred();
  }

  #fail(response: Exclude<RegionResponse, { kind: 'region' } | { kind: 'cancelled' }>): void {
    if (response.kind === 'exception') {
      this.#failure = response.failure;
      // A failed reload keeps what the region shows (a poll while offline); a failed first load has nothing to show.
      if (!this.#region) this.#status = 'exception';
      return;
    }
    // Not (or no longer) allowed: what it showed goes — from the screen and from memory (which keeps only that).
    this.#region = undefined;
    this.#owner.regions.set(this.id, { status: response.kind });
    this.#status = response.kind;
    this.#failure = undefined;
  }

  /** The deferred props of the region, one partial request per group — each merged in as it arrives. */
  #loadDeferred(): void {
    const region = this.#region;
    if (!region?.deferredProps || this.#owner.closed) return;
    for (const [group, props] of Object.entries(region.deferredProps)) {
      if (props.length === 0 || this.#deferred.has(group)) continue;
      this.#deferred.add(group);
      void this.#loadGroup(region, props).finally(() => this.#deferred.delete(group));
    }
  }

  async #loadGroup(region: RegionObject, props: readonly string[]): Promise<void> {
    const signal = this.#owner.signal;
    const response = await this.#transport.request(region.url, partialHeaders(region.component, props, undefined), signal);
    // Moved on meanwhile (another query, another component): these props are not for what the region shows.
    if (signal.aborted || response.kind !== 'region' || this.#region?.url !== region.url || this.#region.component !== region.component) {
      if (response.kind === 'unauthorized' || response.kind === 'forbidden') this.#fail(response);
      this.#emit();
      return;
    }
    const loaded = response.region;
    const only = { ...loaded, props: Object.fromEntries(props.filter((prop) => Object.hasOwn(loaded.props, prop)).map((prop) => [prop, loaded.props[prop]])) };
    const merged = mergePage(this.#region as PageObject, only) as RegionObject;
    this.#region = merged;
    this.#owner.regions.set(this.id, merged);
    this.#emit();
  }

  #take(): RegionSnapshot {
    return { status: this.#status, region: this.#region, pending: this.#pending > 0, failure: this.#failure };
  }

  #emit(): void {
    const next = this.#take();
    const previous = this.#snapshot;
    if (next.status === previous.status && next.region === previous.region && next.pending === previous.pending && next.failure === previous.failure) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
