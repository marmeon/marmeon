/**
 * Regions (E50), UI-free: a part of a page that shows the view of *another* route — with its own region object
 * (component, props, URL, query), its own partial reloads, deferred and merged props, its own failures and its own place
 * in memory. An island (`<Island route>`, E48) is a region embedded in a page, without a URL of its own; a layer (W5b step
 * 5) will be a region with a history entry over the page. Adapters render a region's snapshot and call `load`/`reload`.
 *
 * Where a region keeps what it loaded is its owner's history entry ({@link RegionOwner}, the slot `REGIONS` in owner.ts) — in this
 * tab's memory only (E36), never in `history.state` or any storage. Back/Forward shows them from there without a request;
 * leaving the document (signing out, a new build) drops them with the pages. The islands feature makes them (`islands.region`).
 */
import type { PageObject, RegionObject, RegionResult } from '../page.ts';
import { mergePage, pick, resetOf, type ResetProps } from './merge.ts';
import { notify } from './notify.ts';
import { PatchQueue, type OptimisticUpdate, type PatchTarget, type PropsPatch, type Reloading, type ReloadSpec } from './optimistic.ts';
import { pageQuery, queryUrl } from './query-state.ts';
import type { RegionOwner } from './owner.ts';
import { partialReloadHeaders } from './request.ts';

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

/**
 * What a region starts with besides nothing: what its owner kept — or what the server streamed with the page (E49),
 * which may also be a failure (`exception`: shown, never kept — Back asks again).
 */
export type RegionInitial = KeptRegion | { readonly status: 'exception'; readonly failure: RegionFailure };

function isRegionObject(kept: RegionInitial | undefined): kept is RegionObject {
  return kept !== undefined && 'component' in kept;
}

/**
 * What a region starts with when the server resolved it while rendering the page (E49) — the {@link RegionResult} streamed
 * into the document. `browser` (not resolved on the server): nothing, the region loads itself.
 */
export function regionInitial(result: RegionResult): RegionInitial | undefined {
  switch (result.status) {
    case 'ready':
      return result.region;
    case 'unauthorized':
    case 'forbidden':
      return { status: result.status };
    case 'exception':
      return { status: 'exception', failure: { status: result.failure.status, message: result.failure.message } };
    default:
      return undefined;
  }
}

/** A region's identity: its URL with the query sorted (`?b=2&a=1` and `?a=1&b=2` are one island). */
export function regionId(url: string): string {
  const parsed = new URL(url, 'http://bespoke.invalid');
  parsed.searchParams.sort();
  return parsed.pathname + parsed.search;
}

/** What a region shown from memory by Back/Forward declares to reload then (E58) — asked for when it is loaded (rendered) again. */
export type DeclaredOnBack = (component: string) => Promise<ReloadSpec | undefined>;

/**
 * The region of `url` in `owner`'s entry — the same one for the same id while the owner is on screen (two identical islands
 * share one request and one state). It starts with what the entry kept of it (`kept`, its slot `REGIONS` in owner.ts — Back/Forward)
 * or with `initial` (what the server streamed with the page, E49: its region object, `unauthorized`/`forbidden` — kept like a
 * loaded one — or an `exception`, shown but not kept), else `loading` until `load()`. Closed with its owner: requests under
 * way are aborted, nothing lands any more.
 */
export function ownedRegion(owner: RegionOwner, kept: Map<string, KeptRegion>, transport: RegionTransport, url: string, initial?: RegionInitial, onBack?: DeclaredOnBack): Region {
  const id = regionId(url);
  const live = owner.live.get(id);
  if (live) return live as Region;
  const known = kept.get(id);
  if (initial && !('failure' in initial) && !known) kept.set(id, initial);
  // Back/Forward brought what it kept: its view may declare props to reload then (E58).
  const region = new Region(owner, kept, transport, id, url, known ?? initial, known && isRegionObject(known) ? onBack : undefined);
  if (!owner.closed) owner.live.set(id, region);
  return region;
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
  /** What its owner's entry keeps of its regions (the slot `REGIONS` in owner.ts). */
  readonly #kept: Map<string, KeptRegion>;
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
  /** Optimistic patches under way (E59) — over its region object, never in it (nor in what its owner keeps). */
  readonly #patches = new PatchQueue();
  /** Patches of succeeded actions that go when the region's next answer lands — carried over to a newer request. */
  #drops: { readonly ids: readonly number[]; readonly done: () => void }[] = [];
  /** What its view declares to reload, once, when it was shown from memory by Back/Forward (E58). */
  #onBack: DeclaredOnBack | undefined;
  readonly #target: PatchTarget = {
    add: (patch) => {
      const id = this.#patches.add(patch);
      this.#emit();
      return id;
    },
    settle: (ids, commit, { quiet = false } = {}) => {
      if (!ids.some((id) => this.#patches.has(id))) return;
      if (commit && this.#region) {
        this.#region = this.#patches.fold(this.#region, ids);
        this.#kept.set(this.id, this.#region);
      }
      this.#patches.remove(ids);
      if (!quiet) this.#emit();
    },
    revalidate: (spec, ids) => {
      const done = new Promise<void>((resolve) => this.#drops.push({ ids, done: resolve }));
      void this.#revalidate(spec);
      return done;
    },
  };

  constructor(owner: RegionOwner, regions: Map<string, KeptRegion>, transport: RegionTransport, id: string, url: string, kept?: RegionInitial, onBack?: DeclaredOnBack) {
    this.#owner = owner;
    this.#kept = regions;
    this.#transport = transport;
    this.#onBack = onBack;
    this.id = id;
    const region = isRegionObject(kept) ? kept : undefined;
    this.#url = region?.url ?? url;
    this.#region = region;
    this.#status = region ? 'ready' : kept && !isRegionObject(kept) ? kept.status : 'loading';
    if (kept && 'failure' in kept) this.#failure = kept.failure;
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

  /** A patch of its props for an action (E59) — shown at once over them, never kept before it succeeded. */
  optimistic(patch: PropsPatch): OptimisticUpdate {
    return { target: this.#target, patch };
  }

  /** A reload of the region for an action to run once it succeeded: some props (`only`), or all. */
  reloading(spec: ReloadSpec = {}): Reloading {
    return { target: this.#target, spec };
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
      const onBack = this.#onBack;
      this.#onBack = undefined;
      // Shown from memory by Back/Forward: what its view declares reloads in the background (E58).
      if (onBack) {
        const component = this.#region.component;
        void onBack(component).then((spec) => {
          if (spec && !this.#owner.closed && this.#region?.component === component) void this.#revalidate(spec);
        });
      }
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

  /** Its props again, as they are now (an action's reload, Back's): what comes replaces merged props (`ReloadSpec.reset`). */
  #revalidate(spec: ReloadSpec): Promise<void> {
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    return this.#fetch(this.#url, partial ? { only: spec.only, except: spec.except, reset: resetOf(spec) } : {});
  }

  async #fetch(url: string, { only, except, reset }: Pick<RegionReloadOptions, 'only' | 'except'> & { reset?: ResetProps | undefined }): Promise<void> {
    if (this.#owner.closed) return this.#settleDrops(false);
    this.#request?.abort();
    const controller = new AbortController();
    this.#request = controller;
    const signal = AbortSignal.any([controller.signal, this.#owner.signal]);
    const current = this.#region;
    const headers = current && (only !== undefined || (except?.length ?? 0) > 0) ? partialReloadHeaders(current.component, only, except) : {};
    this.#pending++;
    this.#emit();
    try {
      const response = await this.#transport.request(url, headers, signal);
      if (this.#owner.closed) return this.#settleDrops(false);
      // Replaced by a newer request of the region: that one settles the patches waiting for an answer.
      if (signal.aborted || response.kind === 'cancelled') return;
      if (response.kind === 'region') {
        const partial = Object.keys(headers).length > 0 && this.#region && response.region.component === this.#region.component;
        this.#land(partial ? (mergePage(this.#region as PageObject, response.region, reset) as RegionObject) : response.region);
        this.#settleDrops(true);
      } else {
        this.#fail(response);
        this.#settleDrops(false);
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
    this.#kept.set(this.id, region);
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
    this.#kept.set(this.id, { status: response.kind });
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
    const response = await this.#transport.request(region.url, partialReloadHeaders(region.component, props, undefined), signal);
    // Moved on meanwhile (another query, another component): these props are not for what the region shows.
    if (signal.aborted || response.kind !== 'region' || this.#region?.url !== region.url || this.#region.component !== region.component) {
      if (response.kind === 'unauthorized' || response.kind === 'forbidden') this.#fail(response);
      this.#emit();
      return;
    }
    const loaded = response.region;
    const only = { ...loaded, props: pick(loaded.props, props) };
    const merged = mergePage(this.#region as PageObject, only) as RegionObject;
    this.#region = merged;
    this.#kept.set(this.id, merged);
    this.#emit();
  }

  /**
   * The patches of succeeded actions waiting for an answer: it `landed` — they go with it (in the same snapshot) — or not
   * (offline, turned away): what they show becomes the region's state, their action did succeed.
   */
  #settleDrops(landed: boolean): void {
    const waiting = this.#drops.splice(0);
    const ids = waiting.flatMap((entry) => entry.ids);
    if (ids.length > 0) {
      if (landed || this.#owner.closed) this.#patches.remove(ids);
      else this.#target.settle(ids, true, { quiet: true });
    }
    for (const entry of waiting) entry.done();
  }

  #take(): RegionSnapshot {
    const region = this.#region ? this.#patches.apply(this.#region as PageObject) : undefined;
    return { status: this.#status, region: region as RegionObject | undefined, pending: this.#pending > 0, failure: this.#failure };
  }

  #emit(): void {
    const next = this.#take();
    const previous = this.#snapshot;
    if (next.status === previous.status && next.region === previous.region && next.pending === previous.pending && next.failure === previous.failure) return;
    this.#snapshot = next;
    notify(this.#listeners);
  }
}
