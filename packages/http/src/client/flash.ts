/**
 * Flash messages in the client core, UI-free: every answer the user is shown may bring some (`PageObject.flash`, an
 * action's `x-marmeon-flash`, a layer's close) — each fires exactly once, by its id: never again for a partial reload,
 * Back/Forward or a page shown from memory (the core keeps no message with a page), and twice for the same message flashed
 * twice (another id). A message nobody listens to yet waits for the first listener of its key — the page that mounts with it.
 */
import type { FlashKey, FlashMessage } from '../page.ts';
import { FLASH_HEADER, type PageObject } from '../protocol.ts';
import { slot } from './feature.ts';
import { call } from './notify.ts';

/** How many ids the core remembers (a message delivered twice by a race of two requests fires once). */
const SEEN_LIMIT = 200;
/** How many unheard messages wait for a listener (the oldest go). */
const WAITING_LIMIT = 20;

/**
 * Listens to flash messages: all of them, or one key's.
 * @internal
 */
export type FlashListener = (message: FlashMessage) => void;

/**
 * The flash messages of one navigator.
 * @internal
 */
export class FlashChannel {
  readonly #seen = new Set<string>();
  /** Delivered, not heard by anyone yet. */
  #waiting: FlashMessage[] = [];
  readonly #listeners = new Set<{ readonly key: string | undefined; readonly listener: FlashListener }>();

  /**
   * Fires `listener` for every message (of `key`) from now on — and at once for those that arrived before anyone of that key
   * listened (the first page's, a page that brings its own listener). Returns the function that stops it.
   */
  listen(listener: FlashListener, key?: FlashKey): () => void {
    const entry = { key, listener };
    this.#listeners.add(entry);
    const heard = this.#waiting.filter((message) => key === undefined || message.key === key);
    if (heard.length > 0) {
      this.#waiting = this.#waiting.filter((message) => !heard.includes(message));
      for (const message of heard) call(listener, message);
    }
    return () => void this.#listeners.delete(entry);
  }

  /** Messages of an answer: each one not seen before fires (or waits for its first listener). */
  deliver(messages: readonly FlashMessage[]): void {
    for (const message of messages) {
      if (!isMessage(message) || this.#seen.has(message.id)) continue;
      this.#seen.add(message.id);
      if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
      const listeners = [...this.#listeners].filter((entry) => entry.key === undefined || entry.key === message.key);
      if (listeners.length === 0) {
        this.#waiting = [...this.#waiting, message].slice(-WAITING_LIMIT);
        continue;
      }
      for (const { listener } of listeners) call(listener, message);
    }
  }

  /** Nothing waits any more — the document is left (signed out: not for whoever comes next). */
  clear(): void {
    this.#waiting = [];
  }
}

/** The flash messages of the document — a slot of it: what waits for a listener goes when the document is left. */
export const FLASH = slot('flash', () => new FlashChannel());

/** Flash messages of answers on their way to the screen — a slot of the document. */
export const INBOX = slot('inbox', (): FlashMessage[] => [], (inbox) => void inbox.splice(0));

/** The page without its flash messages, and the messages — the core keeps pages, never what they delivered. */
export function takeFlash(page: PageObject): { page: PageObject; flash: readonly FlashMessage[] } {
  if (!('flash' in page)) return { page, flash: [] };
  const { flash, ...rest } = page;
  return { page: rest, flash: Array.isArray(flash) ? flash : [] };
}

/** The flash messages of an action's answer (`x-marmeon-flash`) — none when the header is missing or broken. */
export function flashOfResponse(response: Pick<Response, 'headers'>): readonly FlashMessage[] {
  const header = response.headers.get(FLASH_HEADER);
  if (!header) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(header));
    return Array.isArray(parsed) ? (parsed as FlashMessage[]) : [];
  } catch {
    return [];
  }
}

function isMessage(value: unknown): value is FlashMessage {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string' && typeof (value as { key?: unknown }).key === 'string';
}
