/**
 * Once props, UI-free: the values the browser keeps of props marked `once()` on the server — in this document's memory
 * only (never in `history.state` or any storage). Every page request names the keys it holds (`x-marmeon-once`) with the
 * scope they came under (`x-marmeon-once-scope`); the server skips those, and the page they are missing from gets them back
 * here before anything renders.
 *
 * Scoped to who they were sent to (`PageObject.onceScope`): a page of another scope — someone else signed in in another tab,
 * the session cookie changed under this one — drops everything kept, and the server, seeing a scope that is not the
 * session's, sends them anyway. A full load (sign-in, sign-out, a new build, a language switch) starts with nothing.
 */
import { ONCE_HEADER, ONCE_SCOPE_HEADER, type PageObject } from '../page.ts';
import { slot } from './feature.ts';

interface Kept {
  readonly value: unknown;
  readonly expiresAt: number | undefined;
}

export class OnceStore {
  #scope: string | undefined;
  readonly #values = new Map<string, Kept>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** How many values are kept (tests). */
  get size(): number {
    return this.#values.size;
  }

  /** The keys held now — those not expired. */
  keys(): string[] {
    const now = this.#now();
    return [...this.#values].filter(([, kept]) => kept.expiresAt === undefined || kept.expiresAt > now).map(([key]) => key);
  }

  /** The headers of a page request: what is held, under which scope — none when nothing is. */
  headers(): Record<string, string> {
    const keys = this.keys();
    if (keys.length === 0) return {};
    return { [ONCE_HEADER]: keys.join(','), ...(this.#scope !== undefined ? { [ONCE_SCOPE_HEADER]: this.#scope } : {}) };
  }

  /**
   * A page object as it arrived: its once props are kept (those it brings) or put back (those the server skipped) — the page
   * the adapter renders has them all. A page of another scope drops what was kept first.
   */
  receive(page: PageObject): PageObject {
    if (!page.onceProps) return page;
    if (page.onceScope !== this.#scope) {
      this.#values.clear();
      this.#scope = page.onceScope;
    }
    let props: Record<string, unknown> | undefined;
    for (const [name, info] of Object.entries(page.onceProps)) {
      if (Object.hasOwn(page.props, name)) {
        this.#values.set(info.key, { value: page.props[name], expiresAt: info.expiresAt });
        continue;
      }
      // Skipped by the server because it is held: back in, as it was received (even if it expired since it was named).
      const kept = this.#values.get(info.key);
      if (kept) (props ??= { ...page.props })[name] = kept.value;
    }
    return props ? { ...page, props } : page;
  }

  /** The document is left (a full load): nothing kept survives it. */
  clear(): void {
    this.#values.clear();
    this.#scope = undefined;
  }
}

/** The once props of the document — a slot of it: the core empties it when the document is left. */
export const ONCE = slot('once', () => new OnceStore());
