/**
 * Remembered state as a feature: what the components of a history entry keep for Back/Forward — in a slot of the entry
 * (`REMEMBERED`), so the core empties it with the entry (memory lets go of it, another page replaces it) and with the document
 * (every 409). In memory only, never in `history.state`. Attached where a component remembers (`useRemember`, a form's
 * `remember`).
 */
import { defineFeature } from '../feature.ts';
import { REMEMBERED, type Remembered } from '../remember.ts';

/** What adapters use of remembered state. */
export interface RememberFeature {
  /** What history entry `entry` remembered (a region owner's `entry`: the page's, or a layer's). */
  of(entry: string): Remembered;
}

/** Remembered state: `navigator.use(remember).of(owner.entry)`. */
export const remember = /* @__PURE__ */ defineFeature('remember', (host): RememberFeature => ({ of: (entry) => host.entry(REMEMBERED, entry) }));
