/**
 * The layer stack: layers over the page, each with its history entry, page object, visits, deferred props and
 * islands — opened by an answer that is a layer, replaced in place by the same layer, closed by Back, `closeLayer()` or a
 * page; Back/Forward brings them back from memory. What a layer showed lives in this tab's memory only: the layers on
 * screen in a slot of the document, each layer entry's place in the stack in a slot of the entry — both emptied by the core.
 */
import { atOrigin } from '../request.ts';
import type { FlashMessage } from '../../page.ts';
import { LAYER_BACKDROP, pageInfo } from '../../page-support.ts';
import type { LayerClose } from '../../protocol.ts';
import { LAYER_CLOSE_HEADER, MAX_LAYER_DEPTH, REGION_HEADER, type PageObject } from '../../protocol.ts';
import { updatePage } from '../cache.ts';
import type { FeatureHost, PlaceOptions } from '../core.ts';
import type { Visit, VisitCallbacks } from '../events.ts';
import { defineFeature, slot, type EntryStack } from '../feature.ts';
import { takeFlash } from '../flash.ts';
import { entry, isHistoryState, newKey, type HistoryState, type PositionCheck } from '../history.ts';
import { Layer, type LayerControl, type LayerHost } from '../layer.ts';
import { follow } from '../load-live.ts';
import { keepDeferred, mergePage, pick, resetOf } from '../merge.ts';
import type { VisitOptions } from '../navigation.ts';
import type { ReloadSpec } from '../optimistic.ts';
import { REGIONS } from '../owner.ts';
import { partialReloadHeaders } from '../request.ts';
import type { Scroll } from '../scroll.ts';

/** A layer closing by going back: what the popstate it caused finishes (and the closing visit waits for). */
export interface PendingClose {
  /** The entry it goes back to. */
  readonly target: string;
  /** The entries of the layers that close — forgotten: Forward asks the server again. */
  readonly forget: ReadonlySet<string>;
  readonly reload: LayerClose['reload'];
  readonly done: () => void;
}

/** How long a layer's close waits for the browser to go back before it replaces the entry instead (ms). */
const CLOSE_TIMEOUT = 1000;

/** One layer of a stack kept in memory. */
export interface CachedLevel {
  readonly key: string;
  readonly depth: number;
  readonly page: PageObject;
}

/** What memory keeps of an entry's stack: the key of the page's entry, the layers over it. */
export interface CachedStack extends EntryStack {
  readonly layers: readonly CachedLevel[];
}

/** Where a layer's entry is in its stack: the keys of the entries beneath it (the page's first) — keys only, never what they show. */
interface LayerPlace {
  below?: readonly string[] | undefined;
  /** It was pushed right over the entry beneath it, in this document: closing it is Back. */
  pushed?: boolean | undefined;
}

/** The layers on screen, bottom first — a slot of the document: every one leaves the screen when it is left (their islands stop). */
export const STACK = slot(
  'layers',
  (): LayerControl[] => [],
  (controls) => {
    for (const control of controls.splice(0)) control.dismiss();
  },
);

/** A layer entry's place in its stack — a slot of the entry: memory keeps the entries beneath it while it keeps the layer's. */
export const PLACE = slot(
  'layer',
  (): LayerPlace => ({}),
  (place) => void Object.assign(place, { below: undefined, pushed: undefined }),
  (place) => place.below,
);

/** `HistoryState.layer`: a depth and keys — a position, never what the layer showed. */
const isLayerPosition: PositionCheck = (value) => {
  const { depth, below } = (value ?? {}) as { depth?: unknown; below?: unknown };
  return Object.keys(value as object).length === 2 && Number.isInteger(depth) && Array.isArray(below) && below.every((key) => typeof key === 'string');
};

/** The history state of a layer's entry: where it is, how deep, and the keys beneath it — never what it shows. */
function layerEntry(page: PageObject, key: string, position: Scroll, below: readonly string[]): HistoryState {
  return { ...entry(page, key, position), layer: { depth: below.length, below: [...below] } };
}

/** A layer's request header. */
const LAYER_HEADERS = { [REGION_HEADER]: 'layer' };

/**
 * The layers of one navigator — what `navigator.use(layers)` returns, and the host of each layer (its visits, closing, its
 * reloads for actions).
 */
export class LayerStack implements LayerHost {
  readonly #core: FeatureHost;
  /** The layers the document came with (a deep link of a layer's URL) — stacked once the history is taken over. */
  #initial: readonly PageObject[];
  /** A layer closing by going back in the history: what the popstate it caused finishes. */
  #pendingClose: PendingClose | undefined;
  /** The close the popstate under way finishes — taken when it arrives, done when its arrival is. */
  #popClose: PendingClose | undefined;

  constructor(core: FeatureHost) {
    this.#core = core;
    // A deep link of a layer's URL: the page under it (its base, or the neutral surface), the layers apart.
    this.#initial = (core.initial?.layers ?? []).slice(0, MAX_LAYER_DEPTH).map((layer) => core.once.receive(takeFlash(layer).page));
  }

  /** The handles of the layers on screen, bottom first (the document's slot). */
  get controls(): LayerControl[] {
    return this.#core.document(STACK);
  }

  /** The layers on screen, bottom first. */
  get list(): Layer[] {
    return this.controls.map((control) => control.layer);
  }

  /** A layer closes by going back: the popstate it caused is its own. */
  get closing(): boolean {
    return this.#pendingClose !== undefined;
  }

  find(layer: Layer): LayerControl | undefined {
    return this.controls.find((control) => control.layer === layer);
  }

  /** The current history entry: the top layer's, or the page's. */
  top(): string {
    return this.controls.at(-1)?.layer.entry ?? this.#core.key!;
  }

  /**
   * A deep link's layers, stacked once the history is taken over — the entry (`key`) is the top layer's, the page beneath gets
   * a key of its own (returned). Undefined: the document came with no layers.
   */
  adopt(key: string, position: Scroll): string | undefined {
    const initial = this.#initial;
    this.#initial = [];
    if (initial.length === 0) return undefined;
    const pageKey = newKey();
    const below = [pageKey];
    initial.forEach((page, index) => {
      // A deep link's layer that follows live channels: the core's live feature follows them too.
      follow(this.#core.navigator, page);
      const own = index === initial.length - 1 ? key : newKey();
      // Not pushed over an entry of their own: closing one replaces the entry with what is beneath.
      this.#keep(own, page, [...below], false);
      this.controls.push(Layer.create(this, own, index + 1, page, this.#core.ownerOf(own)));
      below.push(own);
    });
    const top = this.controls.at(-1)!.layer;
    this.#core.history.replace(layerEntry(top.page, key, position, below.slice(0, -1)), this.#core.window.location.href);
    return pageKey;
  }

  /**
   * Where a visit's answer goes, when the layers take it: an answer that is a layer opens over the level it came from — or
   * replaces that layer in place when it is the same one (its key: a failed form) — and a reload of the page under the
   * layers lands there. Undefined: not the layers' — the answer is shown as the page.
   */
  place(from: LayerControl | undefined, page: PageObject, options: PlaceOptions): Promise<PageObject | undefined> | undefined {
    const { method, replace, preserveState, preserveUrl, partial } = options;
    const controls = this.controls;
    if (!page.layer) {
      // The page under the layers reloaded (a poll, deferred props, `reload({ only })`): it lands there, the layers and
      // their history entries stay.
      if (!from && controls.length > 0 && page.component === this.#core.page.component && (partial || replace || preserveUrl)) {
        return this.#landPage(page, preserveState);
      }
      return undefined;
    }
    const at = from ? controls.indexOf(from) : -1;
    if (from && at >= 0 && (page.layer.key === from.layer.key || (partial && page.component === from.layer.page.component))) {
      // The same layer — validation errors, a reload, the next step: in place. A GET that is no reload is a step of its own.
      const inPlace = replace || preserveUrl || partial || method !== 'get';
      return this.#replace(at, page, { push: !inPlace, preserveState });
    }
    // One more than the protocol allows: shown as a page.
    if (at + 2 > MAX_LAYER_DEPTH) return this.#core.show(page, 'push', { preserveScroll: false, preserveState: false, hash: '' });
    return this.#open(at, page);
  }

  /** `closeLayer()` answered a layer's request: close, then the visit ends on what is beneath (a success). */
  async closed(from: LayerControl | undefined, response: Response, visit: Visit, callbacks: VisitCallbacks): Promise<PageObject | undefined> {
    let close: LayerClose = { layers: 1 };
    try {
      const body = (await response.json()) as { close?: LayerClose; flash?: unknown };
      if (body.close && Number.isInteger(body.close.layers) && body.close.layers > 0) close = body.close;
      // The flash messages of the close: they fire once what stays is on screen.
      if (Array.isArray(body.flash)) this.#core.inbox.push(...(body.flash as FlashMessage[]));
    } catch {
      // No body: close the one layer.
    }
    if (!from || from.layer.closed) return undefined;
    await this.#close(from.layer, close);
    const shown = this.controls.at(-1)?.layer.page ?? this.#core.page;
    this.#core.emit('success', callbacks.onSuccess, pageInfo(shown), visit);
    return shown;
  }

  /** A visit from inside a layer — `layer.visit()`: sent as the layer's, its answer placed for it. */
  layerVisit(layer: Layer, url: string, options: VisitOptions): Promise<PageObject | undefined> {
    const from = this.find(layer);
    // A layer that left the screen visits nothing any more.
    return from ? this.#core.visit(from, url, options) : Promise.resolve(undefined);
  }

  /** `layer.reload()`: the layer's page again, as the layer's. */
  layerReload(layer: Layer, options: Omit<VisitOptions, 'method'>): Promise<PageObject | undefined> {
    const from = this.find(layer);
    return from ? this.#core.visit(from, atOrigin(layer.page.url, this.#core.window), { replace: true, preserveScroll: true, preserveState: true, ...options }) : Promise.resolve(undefined);
  }

  /**
   * Closes `layer` and `close.layers - 1` beneath it — and every layer over it — asking first when one that closes holds
   * unsaved changes. When their entries were pushed one over the other right over what stays, that is Back in the history
   * (Forward then asks the server again: what closed is forgotten); otherwise the current entry becomes what stays. Then
   * `close.reload` reloads what is beneath — the page and the layers that stay — and a layer shown once (an action's answer)
   * reloads them fully.
   */
  async closeLayer(layer: Layer, close: LayerClose): Promise<void> {
    const index = this.controls.findIndex((control) => control.layer === layer);
    if (index < 0 || this.#core.left) return;
    const keep = Math.max(0, index + 1 - Math.max(1, close.layers));
    // Unsaved changes in a layer that closes: asked first — Stay keeps it open.
    if (!(await this.#core.mayLeave((at) => at > keep))) return;
    await this.#close(layer, close);
  }

  /** A layer's reload for an action — see `LayerHost.reloadLayer`. */
  reloadLayer(layer: Layer, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const control = this.find(layer);
    return control ? this.revalidate(control, spec, drop, signal) : Promise.resolve(false);
  }

  /** Memory keeps what a layer's props became (an action's patches committed). */
  layerChanged(layer: Layer): void {
    updatePage(this.#core.cache, layer.entry, layer.page);
  }

  /** The history state of entry `key` on screen when it is a layer's (with the keys beneath it) — undefined for the page's. */
  stateOf(key: string, position: Scroll): HistoryState | undefined {
    const index = this.controls.findIndex((control) => control.layer.entry === key);
    if (index < 0) return undefined;
    return layerEntry(this.controls[index]!.layer.page, key, position, this.#below(index));
  }

  /**
   * The layers from `index` up leave the screen (in their order from the top): their islands stop, `onClose` runs, and a
   * layer shown once is forgotten. Returns them.
   */
  dismissFrom(index: number): Layer[] {
    const removed = this.controls.splice(Math.max(0, index));
    for (const control of removed.reverse()) {
      control.dismiss();
      if (control.layer.once) this.#core.cache.delete(control.layer.entry);
    }
    return removed.map((control) => control.layer);
  }

  /**
   * The layers on screen become `levels` (from memory, by Back/Forward): the ones they share at the bottom stay as they are, the
   * others leave, the new ones are made from memory — their islands too (what their views declare reloads). Returns the
   * layers that left.
   */
  set(levels: readonly CachedLevel[]): Layer[] {
    const controls = this.controls;
    let same = 0;
    while (same < levels.length && same < controls.length && controls[same]!.layer.entry === levels[same]!.key) same++;
    const removed = this.dismissFrom(same);
    for (const level of levels.slice(same)) {
      const control = Layer.create(this, level.key, level.depth, level.page, this.#core.ownerOf(level.key, true));
      controls.push(control);
      this.loadDeferred(control);
    }
    return removed;
  }

  /** The layers changed, the page did not: rendered with the same page (kept as it is). */
  async render(): Promise<void> {
    await this.#core.draw(this.#core.paint(this.#core.key!, this.#core.page), { preserveState: true });
  }

  /** What memory keeps of the stack of entry `key` — its page's entry and the layers' — or false when a part is gone. */
  cached(key: string): CachedStack | false {
    const cache = this.#core.cache;
    const top = cache.get(key);
    if (!top) return false;
    const beneath = this.#core.peek(PLACE, key)?.below;
    if (!beneath || beneath.length === 0) return { page: key, layers: [] };
    const [page, ...under] = beneath;
    if (!cache.peek(page!)) return false;
    const layers: CachedLevel[] = [];
    for (const [index, below] of under.entries()) {
      const cached = cache.peek(below);
      if (!cached) return false;
      layers.push({ key: below, depth: index + 1, page: cached.page });
    }
    layers.push({ key, depth: under.length + 1, page: top.page });
    return { page: page!, layers };
  }

  /** The deferred props of every layer on screen. */
  loadAllDeferred(): void {
    for (const control of this.controls) this.loadDeferred(control);
  }

  /** A layer's deferred props: one partial request per group, as the layer's — each merged in if it still shows that page. */
  loadDeferred(control: LayerControl): void {
    const page = control.layer.page;
    this.#core.props.each(control.layer.entry, page, (props) => {
      const visit: Visit = { url: page.url, method: 'get', async: true };
      return this.#core.request(visit, {}, async (signal) => {
        const response = await this.#core.send(page.url, { method: 'get', headers: { ...LAYER_HEADERS, ...partialReloadHeaders(page.component, props, undefined) }, signal });
        const loaded = await this.#core.read(response, { replace: true, failed: true }, visit, {});
        const current = control.layer.page;
        if (!loaded || control.layer.closed || this.#core.left || current.url !== page.url || current.component !== loaded.component) return undefined;
        const merged = mergePage(current, { ...loaded, props: pick(loaded.props, props) });
        control.update(merged);
        updatePage(this.#core.cache, control.layer.entry, merged);
        await this.render();
        return merged;
      });
    });
  }

  /** A layer's props again from the server, in the background (as `revalidate()` in `revalidate.ts` does for a page's) — replacing merged props. */
  async revalidate(control: LayerControl, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const base = control.layer.page;
    if (control.layer.closed || this.#core.left) return false;
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    const headers = { ...LAYER_HEADERS, ...(partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}) };
    const loaded = await this.#core.fetchPage(base.url, headers, signal);
    const current = control.layer.page;
    if (!loaded || signal.aborted || control.layer.closed || this.#core.left || current.url !== base.url || current.component !== loaded.component) {
      this.#core.flushFlash();
      return false;
    }
    const merged = partial ? mergePage(current, { ...loaded, props: spec.only ? pick(loaded.props, spec.only) : loaded.props }, resetOf(spec)) : keepDeferred(current, loaded);
    control.update(merged, drop);
    updatePage(this.#core.cache, control.layer.entry, merged);
    await this.render();
    if (!partial) this.loadDeferred(control);
    return true;
  }

  /**
   * Back/Forward to a layer's entry that is not in memory (closed explicitly, shown once, evicted): asked for again — over
   * what is beneath it, when that is on screen or in memory. Otherwise the whole stack loads like a deep link (the server
   * puts the layer's declared base under it).
   */
  async restore(state: HistoryState): Promise<void> {
    const below = state.layer?.below ?? [];
    const beneath = below.length > 0 ? this.cached(below.at(-1)!) : undefined;
    if (!beneath || beneath.page !== this.#core.key) {
      this.#core.leave();
      this.#core.window.location.reload();
      return;
    }
    const position = this.#core.scroll.of(state);
    const visit: Visit = { url: state.url, method: 'get' };
    await this.#core.request(visit, {}, async (signal) => {
      const response = await this.#core.send(state.url, { method: 'get', headers: LAYER_HEADERS, signal });
      const page = await this.#core.read(response, { replace: true, failed: false }, visit, {});
      if (!page || signal.aborted) return undefined;
      if (!page.layer) {
        // A page now (signed out: the login page): the entry is that page.
        await this.#core.restorePage(page, state.key, position);
        return page;
      }
      this.set(beneath.layers);
      const keys = [beneath.page, ...beneath.layers.map((level) => level.key)];
      this.#keep(state.key, page, keys, false);
      const control = Layer.create(this, state.key, beneath.layers.length + 1, page, this.#core.ownerOf(state.key));
      this.#core.history.replace(layerEntry(page, state.key, position, keys), page.url);
      this.controls.push(control);
      await this.render();
      this.loadDeferred(control);
      return page;
    });
  }

  /** The close the popstate under way finishes, if a layer closes by going back — taken. */
  takeClose(): void {
    this.#popClose = this.#pendingClose;
    this.#pendingClose = undefined;
  }

  /** The popstate's arrival is done: the closing visit goes on. */
  popped(): void {
    const closing = this.#popClose;
    this.#popClose = undefined;
    closing?.done();
  }

  /**
   * Back/Forward to the page on screen with other layers (a layer closed by Back, opened again by Forward): only the layers
   * change. Those Forward opened again from memory reload what their views declare — and when an action's answer (shown
   * once) left, what is beneath reloads (or what the closing asked for).
   */
  async rearrange(stack: CachedStack, own: boolean): Promise<void> {
    const closing = this.#popClose;
    const before = new Set(this.controls);
    const removed = this.set(stack.layers);
    for (const key of closing?.forget ?? []) this.#core.cache.delete(key);
    await this.render();
    if (!own) for (const control of this.controls) if (!before.has(control)) this.#core.fire('restored', control.layer.page, control.layer.entry, control.layer);
    const reload = closing?.reload ?? (removed.some((layer) => layer.once) ? true : undefined);
    if (reload !== undefined) await this.reloadTop(reload);
  }

  /** Back/Forward brings a page from memory: the layers that closed are forgotten, the stack's own come back over it. */
  arrive(stack: CachedStack): void {
    for (const key of this.#popClose?.forget ?? []) this.#core.cache.delete(key);
    this.set(stack.layers);
  }

  /**
   * Reloads what is on screen now — the page and every layer still over it, from the bottom up — some props (those a level
   * does not have are ignored), or (`true`) all of them: what the closed layer changed may show on any of them (a removed
   * link on the edit layer and on the profile under it). In the background, each landing in place; the page first, so a
   * flash message reaches the page's layout.
   */
  async reloadTop(reload: NonNullable<LayerClose['reload']>): Promise<void> {
    if (reload !== true && reload.length === 0) return;
    const options: VisitOptions = { replace: true, preserveScroll: true, preserveState: true, async: true, ...(reload === true ? {} : { only: reload }) };
    const layers = [...this.controls];
    await this.#core.visit(undefined, atOrigin(this.#core.page.url, this.#core.window), options);
    for (const control of layers) if (!control.layer.closed) await this.#core.visit(control, atOrigin(control.layer.page.url, this.#core.window), options);
  }

  /** Memory keeps a layer's page — and where it is in its stack, first (what is beneath it is used together with it). */
  #keep(key: string, page: PageObject, below: readonly string[], pushed: boolean): void {
    Object.assign(this.#core.entry(PLACE, key), { below, pushed });
    this.#core.cache.set(key, { page });
  }

  /** The page under the layers, reloaded: in place — its entry and the layers' stay, nothing scrolls. */
  async #landPage(page: PageObject, preserveState: boolean): Promise<PageObject> {
    updatePage(this.#core.cache, this.#core.key!, page);
    this.#core.setPage(page);
    await this.#core.draw(this.#core.paint(this.#core.key!, page), { preserveState });
    this.#core.props.load();
    return page;
  }

  /**
   * Opens a layer over level `at` (-1: the page) — what was over that level goes. A history entry of its own (Back closes
   * it), the scroll position stays: the page does not move under it.
   */
  async #open(at: number, page: PageObject): Promise<PageObject> {
    const wasTop = at === this.controls.length - 1;
    this.dismissFrom(at + 1);
    const leaving = this.#core.scroll.current();
    this.#core.scroll.cancelSave();
    const top = this.top();
    this.#core.scroll.set(top, leaving);
    if (wasTop) this.#core.history.replace(this.stateOf(top, leaving) ?? entry(this.#core.page, top, leaving), this.#core.window.location.href);
    const below = this.#below(at + 1);
    const key = newKey();
    // Pushed right over the entry beneath: closing it is Back.
    this.#keep(key, page, below, wasTop);
    const control = Layer.create(this, key, below.length, page, this.#core.ownerOf(key));
    this.#core.history.push(layerEntry(page, key, leaving, below), page.url);
    this.#core.scroll.set(key, leaving);
    this.controls.push(control);
    await this.render();
    this.loadDeferred(control);
    return page;
  }

  /**
   * The layer at `at` answered with itself: replaced in place (its state kept when `preserveState`) — or, `push`, a new
   * entry at the same depth (a wizard's next step: Back goes to the step before).
   */
  async #replace(at: number, page: PageObject, { push, preserveState }: { push: boolean; preserveState: boolean }): Promise<PageObject> {
    this.dismissFrom(at + 1);
    const controls = this.controls;
    const current = controls[at]!;
    const below = this.#below(at);
    const position = this.#core.scroll.current();
    if (!push && preserveState) {
      current.update(page);
      this.#keep(current.layer.entry, page, below, this.#core.peek(PLACE, current.layer.entry)?.pushed ?? false);
      this.#core.history.replace(layerEntry(page, current.layer.entry, position, below), page.url);
    } else {
      const key = push ? newKey() : current.layer.entry;
      const pushed = push ? true : (this.#core.peek(PLACE, key)?.pushed ?? false);
      // A new layer object (a fresh state) — the one it replaces is not forgotten when pushed over: Back shows it again.
      controls.splice(at, 1);
      current.dismiss();
      // Replaced in place (a new state, the same entry): its islands start over, what it remembered stays with the entry.
      if (!push) this.#core.forget(key, REGIONS);
      this.#keep(key, page, below, pushed);
      const control = Layer.create(this, key, below.length, page, this.#core.ownerOf(key));
      if (push) {
        this.#core.scroll.set(current.layer.entry, position);
        this.#core.history.replace(layerEntry(current.layer.page, current.layer.entry, position, below), this.#core.window.location.href);
        this.#core.history.push(layerEntry(page, key, position, below), page.url);
      } else {
        this.#core.history.replace(layerEntry(page, key, position, below), page.url);
      }
      this.#core.scroll.set(key, position);
      controls.splice(at, 0, control);
      this.loadDeferred(control);
    }
    await this.render();
    return page;
  }

  /** Closes `layer` as {@link closeLayer} does — without asking (the server closed it: its form was saved). */
  async #close(layer: Layer, close: LayerClose): Promise<void> {
    const controls = this.controls;
    const index = controls.findIndex((control) => control.layer === layer);
    if (index < 0 || this.#core.left) return;
    const keep = Math.max(0, index + 1 - Math.max(1, close.layers));
    const closing = controls.slice(keep);
    const target = keep === 0 ? this.#core.key! : controls[keep - 1]!.layer.entry;
    const forget = new Set(closing.map((control) => control.layer.entry));
    const state: unknown = this.#core.history.state;
    const onTop = isHistoryState(state) && state.key === this.top();
    const back = this.#core.window.history.go !== undefined && onTop && closing.every((control) => this.#core.peek(PLACE, control.layer.entry)?.pushed === true);
    const reload = close.reload ?? (closing.some((control) => control.layer.once) ? true : undefined);
    if (back) {
      await new Promise<void>((done) => {
        const pending: PendingClose = { target, forget, reload, done };
        this.#pendingClose = pending;
        this.#core.window.history.go!(-closing.length);
        // The browser did not go back (it may refuse): the entry becomes what stays.
        setTimeout(() => {
          if (this.#pendingClose !== pending) return;
          this.#pendingClose = undefined;
          void this.#closeInPlace(keep, forget, reload).finally(done);
        }, CLOSE_TIMEOUT);
      });
      return;
    }
    await this.#closeInPlace(keep, forget, reload);
  }

  /** Closes every layer above `keep` by replacing the current entry with what stays. */
  async #closeInPlace(keep: number, forget: ReadonlySet<string>, reload: LayerClose['reload']): Promise<void> {
    if (this.#core.left) return;
    // Over the neutral surface there is nothing to go back to: the base is visited — the server says what it shows.
    if (keep === 0 && this.#core.page.component === LAYER_BACKDROP) {
      this.dismissFrom(0);
      // The layers' guards were asked already (or the server closed them).
      await this.#core.navigator.visit(atOrigin(this.#core.page.url, this.#core.window), { replace: true, ignoreGuards: true });
      return;
    }
    const position = this.#core.scroll.current();
    this.dismissFrom(keep);
    for (const key of forget) this.#core.cache.delete(key);
    const top = this.top();
    this.#core.history.replace(this.stateOf(top, position) ?? entry(this.#core.page, top, position), keep === 0 ? this.#core.page.url : this.controls[keep - 1]!.layer.page.url);
    await this.render();
    if (reload !== undefined) await this.reloadTop(reload);
  }

  /** The keys of the entries beneath the layer at `index`: the page's, then the layers' under it. */
  #below(index: number): string[] {
    return [this.#core.key!, ...this.controls.slice(0, index).map((control) => control.layer.entry)];
  }
}

/**
 * Layers as a feature: an answer that is a layer opens over the screen, Back closes it, Forward opens it from memory,
 * a deep link stacks them over their base. Writes its own position into history entries (`layer`: a depth and keys). Loaded
 * on demand (`loadLayers`): by the core when the server answers with a layer, by an adapter where one opens.
 */
export const layers = /* @__PURE__ */ defineFeature('layers', (host) => {
  const stack = new LayerStack(host);
  host.history.field('layer', isLayerPosition);
  host.on('response', (response, visit, event) => (response.headers.get(LAYER_CLOSE_HEADER) === 'true' ? stack.closed(visit.from, response, event, visit.options) : undefined));
  host.on('place', (from, page, options) => stack.place(from, page, options));
  host.on('extras', () => ({ layers: stack.list }));
  host.on('top', () => stack.controls.at(-1)?.layer.entry);
  host.on('state', (key, position) => stack.stateOf(key, position));
  host.on('pinned', () => stack.controls.map((control) => control.layer.entry));
  host.on('adopt', (key, position) => stack.adopt(key, position));
  host.on('own', () => stack.closing || undefined);
  host.on('popState', () => void stack.takeClose());
  host.on('stack', (key) => stack.cached(key));
  host.on('rearrange', (cached, own) => stack.rearrange(cached as CachedStack, own));
  host.on('arrive', (cached) => stack.arrive(cached as CachedStack));
  host.on('popped', () => stack.popped());
  host.on('restore', (state) => (state.layer ? stack.restore(state) : undefined));
  host.on('page', () => void stack.dismissFrom(0));
  host.on('deferred', () => stack.loadAllDeferred());
  return stack;
}, 4);
