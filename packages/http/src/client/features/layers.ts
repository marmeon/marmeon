/**
 * The layer stack (E53, E54): layers over the page, each with its history entry, page object, visits, deferred props and
 * islands — opened by an answer that is a layer, replaced in place by the same layer, closed by Back, `closeLayer()` or a
 * page; Back/Forward brings them back from memory. What a layer showed lives in this tab's memory only (E36).
 */
import { LAYER_BACKDROP, MAX_LAYER_DEPTH, REGION_HEADER, type FlashMessage, type LayerClose, type PageObject } from '../../page.ts';
import { keptOf, updatePage, type CachedEntry } from '../cache.ts';
import type { NavigatorCore, PlaceOptions } from '../core.ts';
import type { Visit, VisitCallbacks } from '../events.ts';
import { entry, isHistoryState, newKey, type HistoryState } from '../history.ts';
import { Layer, type LayerControl } from '../layer.ts';
import { keepDeferred, mergePage, pick } from '../merge.ts';
import type { VisitOptions } from '../navigation.ts';
import type { ReloadSpec } from '../optimistic.ts';
import { RegionOwner } from '../region.ts';
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
  readonly entry: CachedEntry;
}

/** What memory keeps of an entry's stack: the key of the page's entry, the layers over it. */
export interface CachedStack {
  readonly page: string;
  readonly layers: readonly CachedLevel[];
}

/** The history state of a layer's entry: where it is, how deep, and the keys beneath it — never what it shows (E36). */
function layerEntry(page: PageObject, key: string, position: Scroll, below: readonly string[]): HistoryState {
  return { ...entry(page, key, position), layer: { depth: below.length, below: [...below] } };
}

type LayersCore = Pick<
  NavigatorCore,
  | 'navigator'
  | 'window'
  | 'cache'
  | 'scroll'
  | 'history'
  | 'transport'
  | 'inbox'
  | 'page'
  | 'key'
  | 'owner'
  | 'left'
  | 'emit'
  | 'draw'
  | 'paint'
  | 'setPage'
  | 'leave'
  | 'request'
  | 'send'
  | 'read'
  | 'fetchPage'
  | 'flushFlash'
  | 'visit'
  | 'show'
  | 'restorePage'
  | 'props'
  | 'guards'
  | 'back'
>;

/** The layers of one navigator. */
export class LayerStack {
  readonly #core: LayersCore;
  /**
   * The layers on screen over the page (E53), bottom first. The core's `key` stays the page's entry: the current history entry
   * is the top layer's ({@link top}).
   */
  #controls: LayerControl[] = [];
  /** The layers the document came with (a deep link of a layer's URL) — stacked once the history is taken over. */
  readonly #initial: readonly PageObject[];
  /** A layer closing by going back in the history: what the popstate it caused finishes. */
  #pendingClose: PendingClose | undefined;

  constructor(core: LayersCore, initial: readonly PageObject[]) {
    this.#core = core;
    this.#initial = initial;
  }

  /** The handles of the layers on screen, bottom first. */
  get controls(): readonly LayerControl[] {
    return this.#controls;
  }

  /** The layers on screen, bottom first. */
  get list(): Layer[] {
    return this.#controls.map((control) => control.layer);
  }

  /** The document came with layers (a deep link). */
  get deepLink(): boolean {
    return this.#initial.length > 0;
  }

  /** A layer closes by going back: the popstate it caused is its own. */
  get closing(): boolean {
    return this.#pendingClose !== undefined;
  }

  find(layer: Layer): LayerControl | undefined {
    return this.#controls.find((control) => control.layer === layer);
  }

  indexOf(control: LayerControl): number {
    return this.#controls.indexOf(control);
  }

  /** The current history entry: the top layer's, or the page's. */
  top(): string {
    return this.#controls.at(-1)?.layer.entry ?? this.#core.key!;
  }

  /** The keys on screen — never evicted from memory while they are. */
  onScreen(): ReadonlySet<string> {
    const keys = new Set<string>();
    if (this.#core.key !== undefined) keys.add(this.#core.key);
    for (const control of this.#controls) keys.add(control.layer.entry);
    return keys;
  }

  /**
   * A deep link's layers, stacked over the page's entry `pageKey` once the history is taken over: the page has no entry of its
   * own then, the entry (`key`) is the top layer's.
   */
  adopt(pageKey: string, key: string, position: Scroll): void {
    const below = [pageKey];
    this.#initial.forEach((page, index) => {
      const own = index === this.#initial.length - 1 ? key : newKey();
      const control = Layer.create(this.#core.navigator, own, index + 1, page, new RegionOwner(this.#core.transport));
      // Not pushed over an entry of their own: closing one replaces the entry with what is beneath.
      this.#core.cache.set(own, { page, ...keptOf(control.layer.owner), below: [...below], pushed: false });
      this.#controls.push(control);
      below.push(own);
    });
    const top = this.#controls.at(-1)!.layer;
    this.#core.history.replace(layerEntry(top.page, key, position, below.slice(0, -1)), this.#core.window.location.href);
  }

  /**
   * Where a visit's answer goes, when the layers take it: an answer that is a layer opens over the level it came from — or
   * replaces that layer in place when it is the same one (its key: a failed form) — and a reload of the page under the
   * layers lands there. Undefined: not the layers' — the answer is shown as the page.
   */
  place(from: LayerControl | undefined, page: PageObject, options: PlaceOptions): Promise<PageObject | undefined> | undefined {
    const { method, replace, preserveState, preserveUrl, partial } = options;
    if (!page.layer) {
      // The page under the layers reloaded (a poll, deferred props, `reload({ only })`): it lands there, the layers and
      // their history entries stay.
      if (!from && this.#controls.length > 0 && page.component === this.#core.page.component && (partial || replace || preserveUrl)) {
        return this.#landPage(page, preserveState);
      }
      return undefined;
    }
    const at = from ? this.#controls.indexOf(from) : -1;
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
      // The flash messages of the close (E60): they fire once what stays is on screen.
      if (Array.isArray(body.flash)) this.#core.inbox.push(...(body.flash as FlashMessage[]));
    } catch {
      // No body: close the one layer.
    }
    if (!from || from.layer.closed) return undefined;
    await this.#close(from.layer, close);
    const shown = this.#controls.at(-1)?.layer.page ?? this.#core.page;
    this.#core.emit('success', callbacks.onSuccess, shown, visit);
    return shown;
  }

  /** Closes `layer` and the ones it names — asking first when one that closes holds unsaved changes. See `Navigator.closeLayer`. */
  async closeLayer(layer: Layer, close: LayerClose): Promise<void> {
    const index = this.#controls.findIndex((control) => control.layer === layer);
    if (index < 0 || this.#core.left) return;
    const keep = Math.max(0, index + 1 - Math.max(1, close.layers));
    // Unsaved changes in a layer that closes (E64): asked first — Stay keeps it open.
    if (!(await this.#core.guards.mayLeave((at) => at > keep))) return;
    await this.#close(layer, close);
  }

  /** A layer's reload for an action (E59) — see `LayerHost.reloadLayer`. */
  reloadLayer(layer: Layer, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const control = this.find(layer);
    return control ? this.revalidate(control, spec, drop, signal) : Promise.resolve(false);
  }

  /** Memory keeps what a layer's props became (an action's patches committed). */
  changed(layer: Layer): void {
    updatePage(this.#core.cache, layer.entry, layer.page);
  }

  /** The history state of entry `key` on screen — the page's, or a layer's (with the keys beneath it). */
  stateOf(key: string, position: Scroll): HistoryState {
    const index = this.#controls.findIndex((control) => control.layer.entry === key);
    if (index < 0) return entry(this.#core.page, key, position);
    return layerEntry(this.#controls[index]!.layer.page, key, position, this.#below(index));
  }

  /**
   * The layers from `index` up leave the screen (in their order from the top): their islands stop, `onClose` runs, and a
   * layer shown once is forgotten. Returns them.
   */
  dismissFrom(index: number): Layer[] {
    const removed = this.#controls.splice(Math.max(0, index));
    for (const control of removed.reverse()) {
      control.dismiss();
      if (control.layer.once) this.#core.cache.delete(control.layer.entry);
    }
    return removed.map((control) => control.layer);
  }

  /**
   * The layers on screen become `levels` (from memory): the ones they share at the bottom stay as they are, the others
   * leave, the new ones are made from memory. Returns the layers that left.
   */
  set(levels: readonly CachedLevel[], { restored = true }: { restored?: boolean } = {}): Layer[] {
    let same = 0;
    while (same < levels.length && same < this.#controls.length && this.#controls[same]!.layer.entry === levels[same]!.key) same++;
    const removed = this.dismissFrom(same);
    for (const level of levels.slice(same)) {
      // From memory (Back/Forward): its islands too — what their views declare reloads (E58).
      const owner = new RegionOwner(this.#core.transport, level.entry.regions, { remembered: level.entry.remembered, ...(restored ? { onBack: this.#core.back.region } : {}) });
      const control = Layer.create(this.#core.navigator, level.key, level.depth, level.entry.page, owner);
      this.#controls.push(control);
      this.loadDeferred(control);
    }
    return removed;
  }

  /** The layers changed, the page did not: rendered with the same page (kept as it is). */
  async render(): Promise<void> {
    await this.#core.draw(this.#core.paint(this.#core.key!, this.#core.page), { preserveState: true, owner: this.#core.owner, layers: this.list });
  }

  /** What memory keeps of the stack of entry `key` — its page's entry and the layers' — or undefined when a part is gone. */
  cached(key: string): CachedStack | undefined {
    const cache = this.#core.cache;
    const top = cache.get(key);
    if (!top) return undefined;
    if (!top.below || top.below.length === 0) return { page: key, layers: [] };
    const [page, ...under] = top.below;
    if (!cache.peek(page!)) return undefined;
    const layers: CachedLevel[] = [];
    for (const [index, below] of under.entries()) {
      const cached = cache.peek(below);
      if (!cached) return undefined;
      layers.push({ key: below, depth: index + 1, entry: cached });
    }
    layers.push({ key, depth: under.length + 1, entry: top });
    return { page: page!, layers };
  }

  /** The deferred props of every layer on screen. */
  loadAllDeferred(): void {
    for (const control of this.#controls) this.loadDeferred(control);
  }

  /** A layer's deferred props: one partial request per group, as the layer's — each merged in if it still shows that page. */
  loadDeferred(control: LayerControl): void {
    const page = control.layer.page;
    this.#core.props.each(control.layer.entry, page, (props) => {
      const visit: Visit = { url: page.url, method: 'get', async: true };
      return this.#core.request(visit, {}, async (signal) => {
        const response = await this.#core.send(page.url, { method: 'get', headers: { [REGION_HEADER]: 'layer', ...partialReloadHeaders(page.component, props, undefined) }, signal });
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

  /** A layer's props again from the server, in the background (as `PropLoader.revalidate` does for a page's). */
  async revalidate(control: LayerControl, spec: ReloadSpec, drop: ReadonlySet<number>, signal: AbortSignal): Promise<boolean> {
    const base = control.layer.page;
    if (control.layer.closed || this.#core.left) return false;
    const partial = spec.only !== undefined || (spec.except?.length ?? 0) > 0;
    const headers = { [REGION_HEADER]: 'layer', ...(partial ? partialReloadHeaders(base.component, spec.only, spec.except) : {}) };
    const loaded = await this.#core.fetchPage(base.url, headers, signal);
    const current = control.layer.page;
    if (!loaded || signal.aborted || control.layer.closed || this.#core.left || current.url !== base.url || current.component !== loaded.component) {
      this.#core.flushFlash();
      return false;
    }
    const merged = partial ? mergePage(current, { ...loaded, props: spec.only ? pick(loaded.props, spec.only) : loaded.props }) : keepDeferred(current, loaded);
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
      const response = await this.#core.send(state.url, { method: 'get', headers: { [REGION_HEADER]: 'layer' }, signal });
      const page = await this.#core.read(response, { replace: true, failed: false }, visit, {});
      if (!page || signal.aborted) return undefined;
      if (!page.layer) {
        // A page now (signed out: the login page): the entry is that page.
        await this.#core.restorePage(page, state.key, position);
        return page;
      }
      this.set(beneath.layers);
      const control = Layer.create(this.#core.navigator, state.key, beneath.layers.length + 1, page, new RegionOwner(this.#core.transport));
      const keys = [beneath.page, ...beneath.layers.map((level) => level.key)];
      this.#core.cache.set(state.key, { page, ...keptOf(control.layer.owner), below: keys, pushed: false });
      this.#core.history.replace(layerEntry(page, state.key, position, keys), page.url);
      this.#controls.push(control);
      await this.render();
      this.loadDeferred(control);
      return page;
    });
  }

  /** The close the popstate under way finishes, if a layer closes by going back — taken. */
  takeClose(): PendingClose | undefined {
    const closing = this.#pendingClose;
    this.#pendingClose = undefined;
    return closing;
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
    const layers = [...this.#controls];
    await this.#core.visit(undefined, this.#core.page.url, options);
    for (const control of layers) if (!control.layer.closed) await this.#core.visit(control, control.layer.page.url, options);
  }

  /** The document is left: every layer leaves the screen (their islands stop). */
  leave(): void {
    for (const control of this.#controls) control.dismiss();
    this.#controls = [];
  }

  /** The page under the layers, reloaded: in place — its entry and the layers' stay, nothing scrolls. */
  async #landPage(page: PageObject, preserveState: boolean): Promise<PageObject> {
    updatePage(this.#core.cache, this.#core.key!, page);
    this.#core.setPage(page);
    await this.#core.draw(this.#core.paint(this.#core.key!, page), { preserveState, owner: this.#core.owner, layers: this.list });
    this.#core.props.load();
    return page;
  }

  /**
   * Opens a layer over level `at` (-1: the page) — what was over that level goes. A history entry of its own (Back closes
   * it), the scroll position stays: the page does not move under it.
   */
  async #open(at: number, page: PageObject): Promise<PageObject> {
    const wasTop = at === this.#controls.length - 1;
    this.dismissFrom(at + 1);
    const leaving = this.#core.scroll.current();
    this.#core.scroll.cancelSave();
    const top = this.top();
    // The entry being left keeps where it was scrolled to.
    this.#core.scroll.set(top, leaving);
    if (wasTop) this.#core.history.replace(this.stateOf(top, leaving), this.#core.window.location.href);
    const below = this.#below(at + 1);
    const key = newKey();
    const control = Layer.create(this.#core.navigator, key, below.length, page, new RegionOwner(this.#core.transport));
    // Pushed right over the entry beneath: closing it is Back.
    this.#core.cache.set(key, { page, ...keptOf(control.layer.owner), below, pushed: wasTop });
    this.#core.history.push(layerEntry(page, key, leaving, below), page.url);
    this.#core.scroll.set(key, leaving);
    this.#controls.push(control);
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
    const current = this.#controls[at]!;
    const below = this.#below(at);
    const position = this.#core.scroll.current();
    if (!push && preserveState) {
      current.update(page);
      const cached = this.#core.cache.peek(current.layer.entry);
      this.#core.cache.set(current.layer.entry, { page, ...keptOf(current.layer.owner), below, pushed: cached?.pushed ?? false });
      this.#core.history.replace(layerEntry(page, current.layer.entry, position, below), page.url);
    } else {
      const key = push ? newKey() : current.layer.entry;
      const pushed = push ? true : (this.#core.cache.peek(key)?.pushed ?? false);
      // A new layer object (a fresh state) — the one it replaces is not forgotten when pushed over: Back shows it again.
      this.#controls.splice(at, 1);
      current.dismiss();
      if (!push && current.layer.once) this.#core.cache.delete(current.layer.entry);
      // Replaced in place (a new state, the same entry): what it remembered stays with the entry (E63).
      const control = Layer.create(
        this.#core.navigator,
        key,
        below.length,
        page,
        new RegionOwner(this.#core.transport, new Map(), push ? {} : { remembered: current.layer.owner.remembered }),
      );
      this.#core.cache.set(key, { page, ...keptOf(control.layer.owner), below, pushed });
      if (push) {
        this.#core.scroll.set(current.layer.entry, position);
        this.#core.history.replace(layerEntry(current.layer.page, current.layer.entry, position, below), this.#core.window.location.href);
        this.#core.history.push(layerEntry(page, key, position, below), page.url);
      } else {
        this.#core.history.replace(layerEntry(page, key, position, below), page.url);
      }
      this.#core.scroll.set(key, position);
      this.#controls.splice(at, 0, control);
      this.loadDeferred(control);
    }
    await this.render();
    return page;
  }

  /** Closes `layer` as {@link closeLayer} does — without asking (the server closed it: its form was saved). */
  async #close(layer: Layer, close: LayerClose): Promise<void> {
    const index = this.#controls.findIndex((control) => control.layer === layer);
    if (index < 0 || this.#core.left) return;
    const keep = Math.max(0, index + 1 - Math.max(1, close.layers));
    const closing = this.#controls.slice(keep);
    const target = keep === 0 ? this.#core.key! : this.#controls[keep - 1]!.layer.entry;
    const forget = new Set(closing.map((control) => control.layer.entry));
    const state: unknown = this.#core.window.history.state;
    const onTop = isHistoryState(state) && state.key === this.top();
    const back = this.#core.window.history.go !== undefined && onTop && closing.every((control) => this.#core.cache.peek(control.layer.entry)?.pushed === true);
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
    // Over the neutral surface (E54) there is nothing to go back to: the base is visited — the server says what it shows.
    if (keep === 0 && this.#core.page.component === LAYER_BACKDROP) {
      this.dismissFrom(0);
      // The layers' guards were asked already (or the server closed them).
      await this.#core.navigator.visit(this.#core.page.url, { replace: true, ignoreGuards: true });
      return;
    }
    const position = this.#core.scroll.current();
    this.dismissFrom(keep);
    for (const key of forget) this.#core.cache.delete(key);
    const top = this.top();
    this.#core.history.replace(this.stateOf(top, position), keep === 0 ? this.#core.page.url : this.#controls[keep - 1]!.layer.page.url);
    await this.render();
    if (reload !== undefined) await this.reloadTop(reload);
  }

  /** The keys of the entries beneath the layer at `index`: the page's, then the layers' under it. */
  #below(index: number): string[] {
    return [this.#core.key!, ...this.#controls.slice(0, index).map((control) => control.layer.entry)];
  }
}

