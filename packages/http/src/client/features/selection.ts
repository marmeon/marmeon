/**
 * Row selection as a feature: which rows of a table the user ticked — the keys, or "every row that matches" — kept
 * per history entry in a slot (`SELECTIONS`), so the core empties it with the entry (memory lets go of it, another page replaces it)
 * and with the document (every 409: signed out, a new build). In memory only, never in `history.state`. Attached where a
 * table is used (`@marmeon/table/client`, React's `useTable`).
 *
 * A selection belongs to what the entry shows: a sort, a filter or another page is a visit with an entry of its own, which starts
 * with nothing selected — and Back brings the old one back from memory. "Every row that matches" is a flag, never a list of keys:
 * a bulk action sends the table's state instead, and the server parses it again.
 */
import { defineFeature, slot } from '../feature.ts';
import { notify } from '../notify.ts';

/** A row's key, as a table's props carry it. */
export type SelectionKey = string | number;

/** What is selected in one table of one history entry. */
export class Selection {
  #keys = new Set<SelectionKey>();
  #matching = false;
  /** Grows with every change — a snapshot for `useSyncExternalStore`. */
  #version = 0;
  readonly #listeners = new Set<() => void>();

  /** The keys ticked — in the order they were. Empty while every matching row is selected. */
  get keys(): readonly SelectionKey[] {
    return [...this.#keys];
  }

  /** Every row that matches the table's state is selected (not only those on screen). */
  get matching(): boolean {
    return this.#matching;
  }

  get size(): number {
    return this.#keys.size;
  }

  get version(): number {
    return this.#version;
  }

  has(key: SelectionKey): boolean {
    return this.#matching || this.#keys.has(key);
  }

  /** Ticks (`selected`) or unticks `keys`. Unticking one while every matching row was selected selects the others on screen: `among`. */
  set(keys: Iterable<SelectionKey>, selected: boolean, among: Iterable<SelectionKey> = []): void {
    if (this.#matching) {
      this.#matching = false;
      this.#keys = new Set(among);
    }
    for (const key of keys) {
      if (selected) this.#keys.add(key);
      else this.#keys.delete(key);
    }
    this.#changed();
  }

  /** Selects every row that matches — a flag, no keys. */
  selectMatching(): void {
    this.#keys.clear();
    this.#matching = true;
    this.#changed();
  }

  /** Keeps only the keys in `keys` (rows that are gone after a reload are no longer selected). */
  retain(keys: Iterable<SelectionKey>): void {
    const kept = new Set(keys);
    const before = this.#keys.size;
    for (const key of this.#keys) if (!kept.has(key)) this.#keys.delete(key);
    if (this.#keys.size !== before) this.#changed();
  }

  /** Selects nothing — also what the core does when it lets go of the entry or the document. */
  clear(): void {
    if (this.#keys.size === 0 && !this.#matching) return;
    this.#keys.clear();
    this.#matching = false;
    this.#changed();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #changed(): void {
    this.#version++;
    notify(this.#listeners);
  }
}

/** The selections of one history entry, by table name — emptied (each of them too) with the entry and with the document. */
export const SELECTIONS = slot(
  'selections',
  () => new Map<string, Selection>(),
  (tables) => {
    for (const selection of tables.values()) selection.clear();
    tables.clear();
  },
);

/** What adapters use of selections. */
export interface SelectionFeature {
  /** The selection of table `table` in history entry `entry` (default: the page on screen's). */
  of(table: string, entry?: string): Selection;
}

/** Row selection: `navigator.use(selection).of('members', owner.entry)`. */
export const selection = defineFeature(
  'selection',
  (host): SelectionFeature => ({
    of: (table, entry) => {
      const tables = host.entry(SELECTIONS, entry);
      let found = tables.get(table);
      if (!found) tables.set(table, (found = new Selection()));
      return found;
    },
  }),
);
