/**
 * The feature host: how a feature of the client core attaches to the navigator. A feature is a name and a `setup` that runs
 * once per navigator (`navigator.use(feature)`, idempotent) and returns the feature's API. Setup registers hooks into the
 * visit pipeline (`host.on('place', …)`); the core calls them in the features' `order`, without knowing any feature.
 *
 * What a feature keeps from the server or the user (pages, props, messages, typed input, requests under way) it keeps in
 * SLOTS only — per history entry (`host.entry(slot, key)`) or per document (`host.document(slot)`). The core empties them
 * itself: an entry's when memory lets go of it, and all of them when the document is left (signing in or out, a new build),
 * so a feature cannot leak what it holds past a sign-out. Its own wiring (listeners, flags) is no data and may live in `setup`.
 */
import type { PageObject } from '../protocol.ts';
import type { Visit } from './events.ts';
import type { NavigationGuard } from './features/guard.ts';
import type { HistoryState, NavigateEvent } from './history.ts';
import type { RenderOptions, VisitMethod, VisitOptions } from './navigation.ts';
import type { FeatureHost, PlaceOptions } from './core.ts';
import type { Layer, LayerControl } from './layer.ts';
import type { RegionOwner } from './owner.ts';
import type { ReloadSpec } from './optimistic.ts';
import type { Scroll } from './scroll.ts';

export type { FeatureHost } from './core.ts';

/** A feature of the client core: `setup` runs once per navigator and returns what adapters use of it. */
export interface Feature<API = unknown> {
  readonly name: string;
  setup(host: FeatureHost): API;
  /**
   * Where its hooks run among those of the other features: lower first; without one, after all that have one; then in the
   * order the features were attached. The guard comes before the features that take a visit (it sees a Back first, and may
   * stop it); the hook API, the History fallback and view transitions come at 0 (they see a visit or a Back/Forward before
   * anyone takes it).
   */
  readonly order?: number;
}

/** A feature — `defineFeature('islands', (host) => ({ region: … }), 7)`. */
export function defineFeature<API>(name: string, setup: (host: FeatureHost) => API, order?: number): Feature<API> {
  return { name, setup, order };
}

/**
 * A place for what a feature keeps — per history entry or per document. The core creates the value on first use and empties
 * it (`clear`, by default the value's own `clear()`) when it lets go of the entry or the document: a slot whose value cannot
 * be emptied cannot be declared.
 */
export interface Slot<T> {
  readonly name: string;
  create(): T;
  clear?(value: T): void;
  /** The entries an entry slot's value is used together with — memory keeps them while this entry stays (what is beneath a layer). */
  along?(value: T): Iterable<string> | undefined;
}

/** What a slot's value must be when the slot names no `clear`: something that empties itself. */
type Emptiable<T> = T extends { clear(): void } ? unknown : "a slot's value must empty itself (clear()) — or say how to empty it: slot(name, create, clear)";

/** A slot whose value empties itself (`Map`, `Set`, …). */
export function slot<T>(name: string, create: () => T & Emptiable<T>): Slot<T>;
/** A slot with its own way of emptying the value — it must leave nothing of what the value held. */
export function slot<T>(name: string, create: () => T, clear: (value: T) => void, along?: (value: T) => Iterable<string> | undefined): Slot<T>;
export function slot<T>(name: string, create: () => T, clear?: (value: T) => void, along?: (value: T) => Iterable<string> | undefined): Slot<T> {
  return { name, create, clear, along };
}

/** Empties what `slot` holds — its own `clear`, or the value's. */
export function emptySlot<T>(slot: Slot<T>, value: T): void {
  if (slot.clear) slot.clear(value);
  else (value as { clear(): void }).clear();
}

/** Empties every slot of `slots` and forgets them. */
export function emptySlots(slots: Map<Slot<unknown>, unknown>): void {
  for (const [slot, value] of slots) emptySlot(slot, value);
  slots.clear();
}

/** A visit about to start — what the `visit` and `start` hooks see. */
export interface PendingVisit {
  readonly options: VisitOptions;
  readonly method: VisitMethod;
  readonly target: URL;
  /** The layer it is sent from — undefined: the page. */
  readonly from: LayerControl | undefined;
  /** A layer's request: sent from one, or opening one (`layer: true`). */
  readonly layer: boolean;
  /** It keeps what is on screen (in the background, a partial reload, "load more", a reload of the same page). */
  readonly keeps: boolean;
  /** Whether it takes level `at` off the screen (0: the page, 1…: the layers' depths). */
  leaving(at: number): boolean;
  /** Its request's URL (a GET's `data` in the query) — set before `start`. */
  url: string;
  /** A partial reload. */
  partial: boolean;
  /** A plain GET (no partial reload, no headers of its own): it may take a page fetched ahead. */
  takes: boolean;
  /** Set by a feature in `start` that has the page here already (fetched ahead): no placeholder is needed for it. */
  ready?: boolean;
}

/** What a feature adds to a visit that starts (`start` hook). */
export interface VisitPart {
  /** The page, without asking the server (fetched ahead) — undefined when it did not come: then the server is asked. */
  readonly page?: Promise<PageObject | undefined> | undefined;
  /** Headers of its request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Its request starts — the visit took the screen (an older one was cancelled). */
  sending?(signal: AbortSignal): void;
  /** Its page landed — before it is placed. */
  landed?(): void;
  /** It ended, with its page or without — in the reverse order of the features. */
  end?(): void;
}

/** What memory has of an entry's stack: its page's entry (and what features put over it — layers). */
export interface EntryStack {
  readonly page: string;
}

/**
 * The hooks of the pipeline. Pipeline hooks run in the features' order (`Feature.order`, then the order they were attached) and
 * the first result that is not `undefined` wins; events (`void`) all run.
 */
export interface FeatureHooks {
  /** Before a visit: `false` (or a promise of it) stops it — a confirmation, unsaved changes. A promise only when asking. */
  visit(visit: PendingVisit): boolean | Promise<boolean> | void;
  /** The visit starts: what a feature adds to it (a page fetched ahead, a placeholder, patches, headers). */
  start(visit: PendingVisit): VisitPart | void;
  /** The response of a visit, before it is read as a page: a feature answers it (a layer's close) — with the page it ends on. */
  response(response: Response, visit: PendingVisit, event: Visit): Promise<PageObject | undefined> | void;
  /** Where a visit's answer goes: a feature takes it (layers) — else it is the page. */
  place(from: LayerControl | undefined, page: PageObject, options: PlaceOptions): Promise<PageObject | undefined> | void;
  /** The page of entry `key` as it is shown: features paint over it (optimistic patches), never into it. */
  paint(key: string, page: PageObject): PageObject;
  /** Unsaved changes on the levels `leaving` takes off the screen — but those in `ignore`. */
  unsaved(leaving: (level: number) => boolean, ignore: readonly NavigationGuard[]): readonly NavigationGuard[];
  /** What a feature contributes to every render of the page (layers). */
  extras(): Partial<RenderOptions>;
  /** The current history entry, when a feature put one over the page's (the top layer's). */
  top(): string | void;
  /** The history state of entry `key`, when it is a feature's (a layer's, with the keys beneath it). */
  state(key: string, position: Scroll): HistoryState | void;
  /** Where the page being left was scrolled to, when a feature changed the screen meanwhile (an instant visit's placeholder). */
  position(): Scroll | void;
  /** Entries on screen besides the page's — never evicted from memory while they are. */
  pinned(): readonly string[];
  /** The document came with more than its page (a deep link of a layer): those go over `key`'s page — returns the page's key. */
  adopt(key: string, position: Scroll): string | void;
  /** A Back/Forward a feature caused itself (a layer closing by going back): the visit under way is not cancelled by it. */
  own(): boolean | void;
  /**
   * Back/Forward to an entry of this navigator (the Navigation API's `navigate`), before the navigator intercepts it: `true`
   * — a feature took it (the guard cancelled it, or goes back). Not in the History fallback (its `popstate` comes after the move).
   */
  navigate(event: NavigateEvent, state: HistoryState, own: boolean): boolean | void;
  /** Back/Forward to an entry of this navigator, before it follows it: `true` — a feature took it (tab sync: an entry of another epoch). */
  popState(state: HistoryState, own: boolean): boolean | void;
  /** What memory has of entry `key`'s stack — `false`: a part of it is gone (then it is asked for again). */
  stack(key: string): EntryStack | false | void;
  /**
   * A page takes the screen — a visit's (`push`, `replace`) or Back/Forward's (`traverse`): `run` renders it. A feature runs it itself
   * and resolves once it ran (in a view transition's update) — else the core runs it; the history entry and the scroll follow.
   * `keep`: the page keeps its state (a partial reload, a form's errors).
   */
  swap(run: () => Promise<void>, how: 'push' | 'replace' | 'traverse', keep: boolean): Promise<void> | void;
  /** Back/Forward to the page on screen: only what features put over it changes (layers) — the page stays. */
  rearrange(stack: EntryStack, own: boolean): Promise<void> | void;
  /** Back/Forward to an entry not in memory that is a feature's (a layer's): it asks for it itself. */
  restore(state: HistoryState): Promise<void> | void;
  /** What a view declares to reload when Back/Forward shows it from memory. */
  declared(component: string): Promise<ReloadSpec | undefined> | void;
  /** Whether a request of route `name` a feature has under way (an action) is pending — `true`, or nothing. */
  pending(name: string): true | void;

  // Events.
  /** A write (a non-GET visit or action) changed what the server shows. */
  write(): void;
  /** A request of a feature goes out (an action, a live validation): features add their headers (the live connection). */
  send(headers: Record<string, string>): void;
  /** A page keeping its state takes the place of the one on screen in another entry: what `from`'s entry kept goes along (islands). */
  carry(from: RegionOwner, to: RegionOwner): void;
  /** The user chose to leave the document (another site, a full load): the browser's own question must not ask again. */
  unload(): void;
  /** The navigator took over the history (`start()`) / gave it back. */
  started(): void;
  stopped(): void;
  /**
   * The session changed in another tab while unsaved changes keep the page (tab sync — `true`: the page on screen is of the old
   * session, the user is asked or chose to stay); `false` once a page of the new session landed. What runs in the background
   * against the session (the live stream) waits meanwhile.
   */
  stale(stale: boolean): void;
  /** Rendering starts. */
  draw(): void;
  /** A page takes the screen as the page: what features put over the one before goes (layers). */
  page(): void;
  /** Back/Forward brings entry `stack.page`'s page from memory: features put back what they had over it. */
  arrive(stack: EntryStack): void;
  /** A Back/Forward's arrival is done (or it asked the server). */
  popped(): void;
  /** What is on screen was rendered without some props: load them (layers load theirs). */
  deferred(): void;
  /** Back/Forward showed a page (or a feature's layer) from memory. */
  restored(page: PageObject, key: string, layer?: Layer): void;
}

export type FeatureHook = keyof FeatureHooks;
