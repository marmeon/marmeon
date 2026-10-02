/**
 * The owner of what a history entry shows (UI-free): the entry's key and a signal that ends when the entry leaves the screen
 * or the document is left. The navigator makes one each time it shows an entry — the page's, a layer's — and hands it to the
 * adapter with the render (`RenderOptions.owner`). Features hang what lives on screen with the entry off it: islands (their
 * live regions, `live`), remembered state (`entry`). Closing it aborts what is under way and lets go of what is live.
 */
import type { KeptRegion } from './region.ts';
import type { Reloading, ReloadSpec } from './optimistic.ts';
import { slot } from './feature.ts';

/** A region on screen, as an action sees it: where it is and how it reloads (`reloading({ islands })`, E59). */
export interface LiveRegion {
  readonly url: string;
  reloading(spec?: ReloadSpec): Reloading;
}

/** What a history entry keeps of its islands (E48): their region objects by id — what Back/Forward shows without a request. */
export const REGIONS = slot('regions', () => new Map<string, KeptRegion>());

export class RegionOwner {
  /** The key of its history entry — where what the entry's components keep lives (`host.entry`: islands, remembered state). */
  readonly entry: string | undefined;
  /** Its entry came back by Back/Forward: what the views shown from memory declare reloads (E58). */
  readonly back: boolean;
  /** The regions on screen (islands, by id) — an action reloads some of them by route (`reloading({ islands })`). */
  readonly live = new Map<string, LiveRegion>();
  readonly #controller = new AbortController();

  constructor(entry?: string, back = false) {
    this.entry = entry;
    this.back = back;
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
    this.live.clear();
  }
}
