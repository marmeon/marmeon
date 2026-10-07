import { AssertionError } from 'node:assert';

/** A refresh as a test sees it: once its transaction committed (or at once, outside one). */
export interface RecordedRefresh {
  readonly channel: string;
  /** What it named (`null`: nothing — every prop each follower follows). */
  readonly only: readonly string[] | null;
  /** The tab that caused it (`x-marmeon-connection`), if the request named one. */
  readonly connection: string | undefined;
}

const sameProps = (a: readonly string[] | null, b: readonly string[] | null) => (a === null || b === null ? a === b : a.length === b.length && [...a].sort().every((prop, i) => prop === [...b].sort()[i]));

/**
 * What the app's `Broadcaster` sent (W6.10) — `app.broadcast` in tests: every refresh that went out (after its commit), as it
 * went out; the hints themselves reach the streams as in production (`app.live(path)`).
 */
export class BroadcastRecorder {
  readonly #refreshed: RecordedRefresh[] = [];

  /** @internal — the broadcaster, when a refresh goes out. */
  record(refresh: RecordedRefresh): void {
    this.#refreshed.push(refresh);
  }

  /** What went out — of one channel, or all. */
  refreshed(channel?: string): readonly RecordedRefresh[] {
    return channel === undefined ? [...this.#refreshed] : this.#refreshed.filter((refresh) => refresh.channel === channel);
  }

  /**
   * `channel` was refreshed — with exactly these props (`only`; `null`: none named), when given, and `times` times when
   * given: `app.broadcast.assertRefreshed(\`users.${ada.id}\`, { only: ['profile'] })`.
   */
  assertRefreshed(channel: string, { only, times }: { only?: readonly string[] | null; times?: number } = {}): this {
    const matching = this.refreshed(channel).filter((refresh) => only === undefined || sameProps(refresh.only, only));
    if (matching.length === 0 || (times !== undefined && matching.length !== times)) {
      const sent = this.#refreshed.map((refresh) => `${refresh.channel} ${JSON.stringify(refresh.only)}`).join(', ') || 'nothing';
      const what = only === undefined ? '' : ` with only ${JSON.stringify(only)}`;
      throw new AssertionError({ message: `Expected ${channel}${what} to be refreshed${times === undefined ? '' : ` ${times} times`} — refreshed: ${sent}.` });
    }
    return this;
  }

  /** `channel` was not refreshed. */
  assertNotRefreshed(channel: string): this {
    const sent = this.refreshed(channel);
    if (sent.length > 0) throw new AssertionError({ message: `Expected ${channel} not to be refreshed — it was, ${sent.length} times.` });
    return this;
  }

  /** Nothing was refreshed. */
  assertNothingRefreshed(): this {
    if (this.#refreshed.length > 0) throw new AssertionError({ message: `Expected nothing refreshed — refreshed: ${this.#refreshed.map((refresh) => refresh.channel).join(', ')}.` });
    return this;
  }

  /** Forgets what was recorded. */
  clear(): void {
    this.#refreshed.length = 0;
  }
}
