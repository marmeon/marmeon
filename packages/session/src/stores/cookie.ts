import { SystemClock, type Clock } from '@marmeon/core';
import type { CookieJar } from '@marmeon/router';
import type { SessionStore, SessionWrite, SessionWriteResult, StoredSession } from '../store.ts';

/**
 * Keeps the whole session in a cookie next to the id cookie — no server storage. Encrypted like every cookie, but limited to
 * ~4 KB. Scoped: it works on the request's cookie jar, so the key it is given does not matter.
 *
 * It cannot know whether another request destroyed or wrote the session meanwhile — the data travels with each response, so
 * every write is `written` (apps with sign-in log a warning at boot), and every read is version 0.
 */
export class CookieSessionStore implements SessionStore {
  readonly #cookies: CookieJar;
  readonly #name: string;
  readonly #clock: Clock;

  constructor(cookies: CookieJar, name: string, clock: Clock = new SystemClock()) {
    this.#cookies = cookies;
    this.#name = `${name}_data`;
    this.#clock = clock;
  }

  async read(): Promise<StoredSession | undefined> {
    const raw = this.#cookies.get(this.#name);
    // `<expires>.<payload>` — the payload as the session wrote it.
    const dot = raw?.indexOf('.') ?? -1;
    if (raw === undefined || dot === -1) return undefined;
    const expires = Number(raw.slice(0, dot));
    return Number.isFinite(expires) && expires > this.#clock.now() ? { data: raw.slice(dot + 1), version: 0 } : undefined;
  }

  async write(_key: string, data: string, { lifetimeSeconds }: SessionWrite): Promise<SessionWriteResult> {
    const value = `${this.#clock.now() + lifetimeSeconds * 1000}.${data}`;
    // Encryption and URI-encoding add roughly a third; browsers drop cookies over 4096 bytes.
    if (value.length > 2800) {
      throw new Error(`The session is too large for the cookie driver (${value.length} bytes) — use SESSION_DRIVER=file.`);
    }
    this.#cookies.set(this.#name, value, { maxAge: lifetimeSeconds });
    return 'written';
  }

  async destroy(): Promise<void> {
    this.#cookies.delete(this.#name);
  }

  async gc(): Promise<number> {
    return 0; // expired cookies expire in the browser
  }
}
