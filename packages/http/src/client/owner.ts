/**
 * The owner of what a history entry shows (UI-free): the entry's key and a signal that ends when the entry leaves the screen
 * or the document is left. The navigator makes one each time it shows an entry — the page's, a layer's — and hands it to the
 * adapter with the render (`RenderOptions.owner`). Features hang what lives on screen with the entry off it: islands (their
 * live regions, `live`), remembered state (`entry`). Closing it aborts what is under way and lets go of what is live.
 */
import type { KeptRegion, RegionReloadOptions } from './region.ts';
import type { RegionObject } from '../protocol.ts';
import type { Reloading, ReloadSpec } from './optimistic.ts';
import { slot } from './feature.ts';
import type { FeatureHost } from './core.ts';

/** A region on screen, as an action sees it: where it is and how it reloads (`reloading({ islands })`). */
export interface LiveRegion {
  readonly url: string;
  reloading(spec?: ReloadSpec): Reloading;
  /** What it shows — the channels it follows are in its region object (`live`). */
  readonly snapshot: { readonly region: RegionObject | undefined };
  /** Asks the server again — some props (`only`): a live hint's reload. */
  reload(options?: RegionReloadOptions): Promise<void>;
}

/** What a history entry keeps of its islands: their region objects by id — what Back/Forward shows without a request. */
export const REGIONS = slot('regions', () => new Map<string, KeptRegion>());

export class RegionOwner {
  /** The key of its history entry — where what the entry's components keep lives (`host.entry`: islands, remembered state). */
  readonly entry: string | undefined;
  /** Its entry came back by Back/Forward: what the views shown from memory declare reloads. */
  readonly back: boolean;
  /** The regions on screen (islands, by id) — an action reloads some of them by route (`reloading({ islands })`). */
  readonly live: ReadonlyMap<string, LiveRegion>;
  readonly #live = new Map<string, LiveRegion>();
  readonly #controller = new AbortController();

  /** @internal Only the navigator makes owners ({@link mintOwner}): the features refuse any other. */
  constructor(entry?: string, back = false) {
    this.entry = entry;
    this.back = back;
    this.live = this.#live;
  }

  /** @internal Puts a region on screen under this owner, unless it is closed. */
  keep(id: string, region: LiveRegion): void {
    if (!this.closed) this.#live.set(id, region);
  }

  /** Aborted once the owner is closed. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get closed(): boolean {
    return this.#controller.signal.aborted;
  }

  /** The owner's entry left the screen (or the document is left): requests under way are aborted, nothing lands any more. */
  close(): void {
    this.#controller.abort();
    this.#live.clear();
  }
}

/** The owners the navigators made, each with its maker: a feature takes no other, so neither a forged owner nor another app's writes into an entry's slots. */
const minted = new WeakMap<RegionOwner, object>();

/** @internal The navigator's way to make an owner for an entry it shows. */
export function mintOwner(entry: string | undefined, back: boolean | undefined, navigator: object): RegionOwner {
  const owner = new RegionOwner(entry, back);
  minted.set(owner, navigator);
  const owners = made.get(navigator) ?? new Set<RegionOwner>();
  made.set(navigator, owners);
  owners.add(owner);
  owner.signal.addEventListener('abort', () => owners.delete(owner), { once: true });
  return owner;
}

/** The owners each navigator made and that are not closed: the entries it shows (or is about to show). */
const made = new WeakMap<object, Set<RegionOwner>>();

/** @internal Whether `navigator` shows history entry `key` now: an owner it made for it is not closed. */
export function showsEntry(navigator: object, key: string): boolean {
  const owners = made.get(navigator);
  if (!owners) return false;
  let shown = false;
  for (const owner of owners) {
    if (owner.closed) owners.delete(owner);
    else if (owner.entry === key) shown = true;
  }
  return shown;
}

/** @internal Whether `navigator` made `owner`. */
export function isMintedOwner(owner: unknown, navigator: object): owner is RegionOwner {
  return typeof owner === 'object' && owner !== null && minted.get(owner as RegionOwner) === navigator;
}

/**
 * @internal Whether the core shows history entry `key` now. A key it does not show (the page was left, the layer closed)
 * gets a detached store from the feature: nothing creates a slot for an entry that does not exist, or reaches another by guessing.
 */
export function isHeld(host: FeatureHost, key: string): boolean {
  const held = showsEntry(host.navigator, key);
  // Development only: a bundler replaces `process.env.NODE_ENV`, and a production bundle drops the message.
  if (!held && (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test')) {
    console.warn(`[marmeon] The history entry ${JSON.stringify(key)} is not on screen: what is kept for it is detached and lost. Take the key from the owner of the page or the layer (RegionOwner.entry).`);
  }
  return held;
}
