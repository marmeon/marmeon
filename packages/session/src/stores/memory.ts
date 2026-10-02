import { SystemClock, type Clock } from '@bespokecore/core';
import type { SessionPayload, SessionStore } from '../store.ts';

/**
 * In-process, lost on restart. For tests. Atomic because every operation runs synchronously — no `await` between
 * looking a session up and writing it.
 */
export class MemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, { data: string; expires: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async read(id: string): Promise<SessionPayload | undefined> {
    const entry = this.#alive(id);
    return entry ? (JSON.parse(entry.data) as SessionPayload) : undefined;
  }

  async write(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<void> {
    // Stored serialized: what a real store would return, no shared object references.
    this.#sessions.set(id, { data: JSON.stringify(data), expires: this.#clock.now() + lifetimeSeconds * 1000 });
  }

  async writeIfExists(id: string, data: SessionPayload, lifetimeSeconds: number): Promise<boolean> {
    if (!this.#alive(id)) return false;
    this.#sessions.set(id, { data: JSON.stringify(data), expires: this.#clock.now() + lifetimeSeconds * 1000 });
    return true;
  }

  async destroy(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  async gc(): Promise<number> {
    let removed = 0;
    const now = this.#clock.now();
    for (const [id, { expires }] of this.#sessions) {
      if (expires <= now) removed += Number(this.#sessions.delete(id));
    }
    return removed;
  }

  #alive(id: string): { data: string; expires: number } | undefined {
    const entry = this.#sessions.get(id);
    return entry && entry.expires > this.#clock.now() ? entry : undefined;
  }
}
