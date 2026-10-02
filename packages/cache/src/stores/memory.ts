import { SystemClock, type Clock } from '@bespokecore/core';
import type { CacheStore, Entry } from '../cache.ts';

/**
 * In-process: fast, lost on restart, not shared between processes. Tests and single-process apps. Atomic because every
 * operation runs synchronously — no `await` between reading and writing a key.
 */
export class MemoryStore implements CacheStore {
  readonly #entries = new Map<string, { raw: string | undefined; expires: number | null }>();
  readonly #locks = new Map<string, { owner: string; expires: number }>();
  readonly #clock: Clock;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async read(key: string): Promise<Entry | undefined> {
    return this.#alive(key);
  }

  async write(key: string, entry: Entry): Promise<void> {
    this.#set(key, entry);
  }

  async add(key: string, entry: Entry): Promise<boolean> {
    if (this.#alive(key)) return false;
    this.#set(key, entry);
    return true;
  }

  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const entry = this.#alive(key);
    if (entry && Number.isSafeInteger(entry.value)) {
      const value = (entry.value as number) + by;
      this.#set(key, { value, expires: entry.expires });
      return value;
    }
    this.#set(key, { value: by, expires });
    return by;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    const held = this.#lockHeld(name);
    if (held && held.owner !== owner) return false;
    this.#locks.set(name, { owner, expires });
    return true;
  }

  async unlock(name: string, owner: string): Promise<boolean> {
    if (this.#lockHeld(name)?.owner !== owner) return false;
    this.#locks.delete(name);
    return true;
  }

  async forceUnlock(name: string): Promise<void> {
    this.#locks.delete(name);
  }

  async lockOwner(name: string): Promise<string | undefined> {
    return this.#lockHeld(name)?.owner;
  }

  /** Serialized, like every real store: a cached object is a copy, never shared with the caller. */
  #set(key: string, entry: Entry): void {
    this.#entries.set(key, { raw: JSON.stringify(entry.value) as string | undefined, expires: entry.expires });
  }

  #alive(key: string): Entry | undefined {
    const stored = this.#entries.get(key);
    if (!stored) return undefined;
    if (stored.expires !== null && stored.expires <= this.#clock.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return { value: stored.raw === undefined ? undefined : (JSON.parse(stored.raw) as unknown), expires: stored.expires };
  }

  #lockHeld(name: string): { owner: string; expires: number } | undefined {
    const lock = this.#locks.get(name);
    return lock && lock.expires > this.#clock.now() ? lock : undefined;
  }
}
