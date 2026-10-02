/**
 * Layers (E50, E53), UI-free: a region with a history entry of its own over the page — a modal, a slide-over. Its page
 * object is the answer of its route (`this.view(…).layer({ base })`), with its own visits, partial reloads, deferred props,
 * failures and islands (`owner`). Layers stack (up to {@link MAX_LAYER_DEPTH}); Back closes the top one, Forward opens it
 * again from memory. What a layer showed lives only in this tab's memory (E36) — never in `history.state` or any storage.
 * The navigator creates them; an adapter renders `navigator.layers` (handed with every `render`) and calls their methods.
 */
import { MAX_LAYER_DEPTH, type LayerClose, type PageObject } from '../page.ts';
import type { RegionOwner } from './region.ts';
import type { VisitOptions } from './navigation.ts';

export { MAX_LAYER_DEPTH } from '../page.ts';

/** How a layer closes (`layer.close()`): then reload what is beneath it — some of its props, or `true` all of them. */
export interface LayerCloseOptions {
  reload?: LayerClose['reload'];
}

/** What a layer asks of the navigator (its visits, closing) — the navigator implements it. */
export interface LayerHost {
  layerVisit(layer: Layer, url: string, options: VisitOptions): Promise<PageObject | undefined>;
  closeLayer(layer: Layer, close: LayerClose): Promise<void>;
}

/** The navigator's handle on a layer — what changes it (the adapter only reads). */
export interface LayerControl {
  readonly layer: Layer;
  /** A new page object for the layer (props merged in, an answer that replaced it in place). */
  update(page: PageObject): void;
  /** It left the screen: its regions stop, `onClose` listeners run. */
  dismiss(): void;
}

/**
 * One layer on screen. `page` is its page object (a new one whenever something changed — `subscribe` for
 * `useSyncExternalStore`); `visit`/`reload` are its own (a form inside a layer submits as the layer: an answer of the same
 * layer — validation errors — replaces it in place); `close()` closes it (and the ones over it).
 */
export class Layer {
  /** Its history entry (and the key of what memory keeps of it). */
  readonly entry: string;
  /** 1 for the first layer over the page, 2 for one over that, … */
  readonly depth: number;
  /** Where its islands live. */
  readonly owner: RegionOwner;
  readonly #host: LayerHost;
  #page: PageObject;
  #closed = false;
  /** Closing is under way: a second Escape before it is gone closes nothing more (not the layer beneath too). */
  #closing = false;
  readonly #listeners = new Set<() => void>();
  readonly #closeListeners = new Set<() => void>();

  private constructor(host: LayerHost, entry: string, depth: number, page: PageObject, owner: RegionOwner) {
    this.#host = host;
    this.entry = entry;
    this.depth = depth;
    this.#page = page;
    this.owner = owner;
  }

  /** @internal The navigator's: a layer and the handle that changes it. */
  static create(host: LayerHost, entry: string, depth: number, page: PageObject, owner: RegionOwner): LayerControl {
    if (depth < 1 || depth > MAX_LAYER_DEPTH) throw new Error(`A layer's depth is 1 to ${MAX_LAYER_DEPTH}, got ${depth}.`);
    const layer = new Layer(host, entry, depth, page, owner);
    return {
      layer,
      update: (next) => layer.#update(next),
      dismiss: () => layer.#dismiss(),
    };
  }

  /** Its page object — the props its view renders, its URL, its `layer` info. */
  get page(): PageObject {
    return this.#page;
  }

  /** Its key: an answer with the same key replaces it in place. */
  get key(): string {
    return this.#page.layer?.key ?? this.#page.component;
  }

  /** The URL of its declared base (what a deep link shows under it). */
  get base(): string | undefined {
    return this.#page.layer?.base;
  }

  /** The answer of an action, shown once: gone from memory when it leaves the screen, and what is beneath reloads. */
  get once(): boolean {
    return this.#page.layer?.once === true;
  }

  /** It left the screen (closed, Back, a page visit). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Follows `page`. Returns the function that stops it. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * A visit from inside the layer — a link, a form (`useForm`): sent as the layer's (`x-bespoke-region: layer`). The answer
   * decides: the same layer (its key) replaces it in place, another layer opens on top, `closeLayer()` closes it, a page
   * replaces the page (and every layer goes).
   */
  visit(url: string, options: VisitOptions = {}): Promise<PageObject | undefined> {
    return this.#host.layerVisit(this, url, options);
  }

  /** The layer again from the server — `reload({ only: ['profile'] })`: some props. Keeps its state and its entry. */
  reload(options: Omit<VisitOptions, 'method'> = {}): Promise<PageObject | undefined> {
    return this.visit(this.#page.url, { replace: true, preserveScroll: true, preserveState: true, ...options });
  }

  /**
   * Closes the layer — and the ones over it: Back in the history when its entry was opened right over the one beneath
   * (Forward then asks the server again: an explicit close forgets it), else the entry becomes what is beneath. `reload`
   * reloads what is beneath afterwards.
   */
  close({ reload }: LayerCloseOptions = {}): Promise<void> {
    if (this.#closed || this.#closing) return Promise.resolve();
    this.#closing = true;
    return this.#host.closeLayer(this, { layers: 1, ...(reload === undefined ? {} : { reload }) });
  }

  /** Runs `listener` once the layer leaves the screen (closed, Back, a page visit). Returns the function that stops it. */
  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => void this.#closeListeners.delete(listener);
  }

  #update(page: PageObject): void {
    if (page === this.#page) return;
    this.#page = page;
    for (const listener of this.#listeners) call(listener);
  }

  #dismiss(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.owner.close();
    for (const listener of this.#closeListeners) call(listener);
    this.#closeListeners.clear();
  }
}

function call(listener: () => void): void {
  try {
    listener();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
