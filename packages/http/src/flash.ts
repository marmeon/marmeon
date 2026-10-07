/**
 * Flash messages (E60), server side: what a controller hands the page the user sees next — once. A message has an id of its
 * own, so the browser fires it exactly once (and twice for the same message flashed twice). Where it waits in between is
 * the session's ({@link Flasher}): until a response the user is shown takes it — a page, a layer, a partial reload, an
 * action's answer. A prefetch, an island or any other read-only request never takes one.
 */
import type { CheckFlashKey, FlashMessage, FlashValue } from './page.ts';

/** A message as it is flashed — its data as the controller gave it (JSON makes it a {@link FlashMessage}). */
export interface FlashEntry {
  readonly id: string;
  readonly key: string;
  readonly data: unknown;
  /**
   * The document whose request flashed it (E165, `x-marmeon-document` — the tabSync feature names it): only a request of that
   * document, or one naming none (a full page load), takes it. Never sent to the browser.
   */
  readonly document?: string;
}

/** A new message with an id of its own. */
export function flashEntry(key: string, data: unknown): FlashEntry {
  return { id: crypto.randomUUID(), key, data };
}

/** The `.flash(key, data)` of a result — typed by the app's `FlashData`. */
export type FlashMethod<R> = <const K extends string>(key: CheckFlashKey<K>, data: FlashValue<K>) => R;

/** Messages a result carries itself (a page's, delivered with it) — kept beside the result, never one of its fields. */
const carried = new WeakMap<object, FlashEntry[]>();

/** Adds a message to `result` (a page, a layer, JSON) — it goes out with that result's response. */
export function addFlash<R extends object>(result: R, key: string, data: unknown): R {
  carried.set(result, [...(carried.get(result) ?? []), flashEntry(key, data)]);
  return result;
}

/** The messages `result` carries. */
export function flashOf(result: object): readonly FlashEntry[] {
  return carried.get(result) ?? [];
}

/** `to` (made from `from`: a layer from its view) carries what `from` did. */
export function carryFlash(from: object, to: object): void {
  const messages = carried.get(from);
  if (messages) carried.set(to, [...messages]);
}

/** Defines `.flash()` on a plain result object — not enumerable: a result is data (spread, compared in tests). */
export function withFlashMethod<R extends object>(result: R): R {
  Object.defineProperty(result, 'flash', { enumerable: false, value: (key: string, data: unknown) => addFlash(result, key, data) });
  return result;
}

/** As the browser gets them: JSON, so a `Date` is its string — what the type says (`FlashMessage`). */
export function serializedFlash(entries: readonly FlashEntry[]): FlashMessage[] {
  return JSON.parse(JSON.stringify(entries.map(({ id, key, data }) => ({ id, key, data })))) as FlashMessage[];
}
