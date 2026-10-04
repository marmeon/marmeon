import { SystemClock, type Clock } from '@bespokecore/core';
import type { SessionStore, SessionWrite, SessionWriteResult, StoredSession } from '../store.ts';

interface Entry {
  data: string;
  version: number;
  expires: number;
}

/**
 * In-process, lost on restart. For tests. Atomic because every operation runs synchronously — no `await` between looking a
 * session up and writing it.
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, Entry>();
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async read(key: string): Promise<StoredSession | undefined> {
    const entry = this.#alive(key);
    return entry ? { data: entry.data, version: entry.version } : undefined;
  }

  async write(key: string, data: string, { expectedVersion, lifetimeSeconds }: SessionWrite): Promise<SessionWriteResult> {
    const current = this.#alive(key);
    if (expectedVersion === undefined) {
      if (current) return 'conflict';
    } else if (!current) return 'gone';
    else if (current.version !== expectedVersion) return 'conflict';
    this.#sessions.set(key, { data, version: (current?.version ?? 0) + 1, expires: this.#clock.now() + lifetimeSeconds * 1000 });
    return 'written';
  }

  async destroy(key: string): Promise<void> {
    this.#sessions.delete(key);
  }

  async gc(): Promise<number> {
    let removed = 0;
    const now = this.#clock.now();
    for (const [key, { expires }] of this.#sessions) {
      if (expires <= now) removed += Number(this.#sessions.delete(key));
    }
    return removed;
  }

  #alive(key: string): Entry | undefined {
    const entry = this.#sessions.get(key);
    return entry && entry.expires > this.#clock.now() ? entry : undefined;
  }
}
