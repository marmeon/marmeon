/** A write a read-only request tried — thrown in development and tests, so the mistake shows where it is made. */
export class ReadOnlyViolation extends Error {
  override name = 'ReadOnlyViolation';
}

/** What engages a request's {@link ReadOnly} guard. */
export interface ReadOnlyOptions {
  /** What the request is, for the message: `an island request (GET /dashboard/islands/sign-ins)`. */
  readonly reason: string;
  /** Throw on a write (development, tests) — otherwise the write is dropped and reported. */
  readonly strict: boolean;
  /** Where a dropped write is reported (the log). */
  readonly report: (message: string) => void;
  /** Why it may not write, and where to do it instead — default: an island's rule. Every other read-only request names its own. */
  readonly rule?: string;
}

const ISLAND_RULE =
  'an island is read-only — it cannot change the session, cookies or flash data, nor defer work after the response. Do that in the page or an action, not in an island.';

/**
 * Whether the current request may leave anything behind — per request (scoped). An island's request is read-only: it runs
 * beside and after the page, so a write to the session, cookies or work after the response would race the page's own
 * requests, or, streamed with the page, never reach the browser. Every writer asks {@link permit} first.
 *
 * In development and tests a write throws a {@link ReadOnlyViolation}; in production it is dropped and logged.
 */
export class ReadOnly {
  #options: ReadOnlyOptions | undefined;

  /** Whether this request is read-only. */
  get active(): boolean {
    return this.#options !== undefined;
  }

  /** @internal — the kernel engages it for a region request. */
  engage(options: ReadOnlyOptions): void {
    this.#options = options;
  }

  /**
   * Asked before a write (`what`: `session.put('cart')`): true when the request may write. A read-only request throws
   * (strict) or reports the write and answers false — the caller drops it.
   */
  permit(what: string): boolean {
    const options = this.#options;
    if (!options) return true;
    const message = `${what} in ${options.reason}: ${options.rule ?? ISLAND_RULE}`;
    if (options.strict) throw new ReadOnlyViolation(message);
    options.report(`${message} (dropped)`);
    return false;
  }
}

/** A write check, as the session, the cookie jar and `AfterResponse` take it (`lock(…)`). */
export type WritePermit = (what: string) => boolean;
