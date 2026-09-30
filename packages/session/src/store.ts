import { mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { token } from '@bespokecore/core';
import type { CookieJar } from '@bespokecore/router';

export type SessionPayload = Record<string, unknown>;

/**
 * Where session data lives (Laravel's session handlers). `database` and `redis`
 * follow with Waves 3 and 6 — as further implementations of this contract.
 */
export interface SessionStore {
  read(id: string): Promise<SessionPayload | undefined>;
  write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Removes expired sessions; returns how many. */
  gc(lifetimeSeconds: number): Promise<number>;
}
export const SessionStore = token<SessionStore>('SessionStore');

/** Session ids are 40 URL-safe characters — anything else is never looked up (no path tricks). */
export const SESSION_ID = /^[A-Za-z0-9_-]{40}$/;

export function createSessionId(): string {
  return crypto.getRandomValues(new Uint8Array(30)).toBase64({ alphabet: 'base64url' });
}

/** In-process, lost on restart. For tests. */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, { data: string; expires: number }>();

  async read(id: string): Promise<SessionPayload | undefined> {
    const entry = this.#sessions.get(id);
    if (!entry || entry.expires <= Date.now()) return undefined;
    return JSON.parse(entry.data) as SessionPayload;
  }

  async write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    // Stored serialized: what a real store would return, no shared object references.
    this.#sessions.set(id, { data: JSON.stringify(data), expires: Date.now() + lifetimeSeconds * 1000 });
  }

  async destroy(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  async gc(): Promise<number> {
    let removed = 0;
    for (const [id, { expires }] of this.#sessions) {
      if (expires <= Date.now()) removed += Number(this.#sessions.delete(id));
    }
    return removed;
  }
}

/** One JSON file per session (Laravel's default). Survives restarts; writes are atomic. */
export class FileSessionStore implements SessionStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  async read(id: string): Promise<SessionPayload | undefined> {
    try {
      const { expires, data } = JSON.parse(await readFile(this.#path(id), 'utf8')) as { expires: number; data: SessionPayload };
      return expires > Date.now() ? data : undefined;
    } catch {
      return undefined; // missing or unreadable: a new session starts
    }
  }

  async write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    const file = this.#path(id);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ expires: Date.now() + lifetimeSeconds * 1000, data }), { mode: 0o600 });
    await rename(temporary, file);
  }

  async destroy(id: string): Promise<void> {
    await rm(this.#path(id), { force: true });
  }

  async gc(lifetimeSeconds: number): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.#directory)) {
      const file = join(this.#directory, name);
      try {
        if ((await stat(file)).mtimeMs + lifetimeSeconds * 1000 < Date.now()) {
          await rm(file, { force: true });
          removed++;
        }
      } catch {
        // Removed concurrently.
      }
    }
    return removed;
  }

  #path(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id "${id}".`);
    return join(this.#directory, id);
  }
}

/**
 * Keeps the whole session in a cookie next to the id cookie — no server storage.
 * Encrypted like every cookie, but limited to ~4 KB. Scoped: it works on the
 * request's cookie jar.
 */
export class CookieSessionStore implements SessionStore {
  readonly #cookies: CookieJar;
  readonly #name: string;

  constructor(cookies: CookieJar, name: string) {
    this.#cookies = cookies;
    this.#name = `${name}_data`;
  }

  async read(): Promise<SessionPayload | undefined> {
    const raw = this.#cookies.get(this.#name);
    if (raw === undefined) return undefined;
    try {
      const { expires, data } = JSON.parse(raw) as { expires: number; data: SessionPayload };
      return expires > Date.now() ? data : undefined;
    } catch {
      return undefined;
    }
  }

  async write(_id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    const value = JSON.stringify({ expires: Date.now() + lifetimeSeconds * 1000, data });
    // Encryption and URI-encoding add roughly a third; browsers drop cookies over 4096 bytes.
    if (value.length > 2800) {
      throw new Error(`The session is too large for the cookie driver (${value.length} bytes of JSON) — use SESSION_DRIVER=file.`);
    }
    this.#cookies.set(this.#name, value, { maxAge: lifetimeSeconds });
  }

  async destroy(): Promise<void> {
    this.#cookies.delete(this.#name);
  }

  async gc(): Promise<number> {
    return 0; // expired cookies expire in the browser
  }
}
