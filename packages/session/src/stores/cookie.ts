import { SystemClock, type Clock } from '@bespokecore/core';
import type { CookieJar } from '@bespokecore/router';
import type { SessionPayload, SessionStore } from '../store.ts';

/**
 * Keeps the whole session in a cookie next to the id cookie — no server storage.
 * Encrypted like every cookie, but limited to ~4 KB. Scoped: it works on the
 * request's cookie jar.
 *
 * It cannot know whether another request destroyed the session meanwhile — the data travels with each response, so
 * `writeIfExists` always writes (E46: apps with sign-in log a warning at boot).
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

  async read(): Promise<SessionPayload | undefined> {
    const raw = this.#cookies.get(this.#name);
    if (raw === undefined) return undefined;
    try {
      const { expires, data } = JSON.parse(raw) as { expires: number; data: SessionPayload };
      return expires > this.#clock.now() ? data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(_id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    const value = JSON.stringify({ expires: this.#clock.now() + lifetimeSeconds * 1000, data });
    // Encryption and URI-encoding add roughly a third; browsers drop cookies over 4096 bytes.
    if (value.length > 2800) {
      throw new Error(`The session is too large for the cookie driver (${value.length} bytes of JSON) — use SESSION_DRIVER=file.`);
    }
    this.#cookies.set(this.#name, value, { maxAge: lifetimeSeconds });
  }

  async writeIfExists(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<boolean> {
    await this.write(id, data, lifetimeSeconds);
    return true;
  }

  async destroy(): Promise<void> {
    this.#cookies.delete(this.#name);
  }

  async gc(): Promise<number> {
    return 0; // expired cookies expire in the browser
  }
}
