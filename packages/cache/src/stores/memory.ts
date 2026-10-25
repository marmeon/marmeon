import { SystemClock, type Clock } from '@marmeon/core';
import type { CacheEntry, CacheStore, LockStore } from '../cache.ts';

/** Every this many writes, `#sweep` looks at `SWEEP_BATCH` entries: more checked than written, so expired ones cannot pile up. */
const SWEEP_EVERY = 32;
const SWEEP_BATCH = 128;

/**
 * In-process: fast, lost on restart, not shared between processes. Tests and single-process apps. Atomic because every
 * operation runs synchronously — no `await` between reading and writing a key.
 */
export class MemoryStore implements CacheStore, LockStore {
  readonly #entries = new Map<string, { raw: string | undefined; expires: number | null }>();
  readonly #locks = new Map<string, { owner: string; expires: number }>();
  readonly #clock: Clock;
  #writes = 0;
  #entryCursor: Iterator<[string, { expires: number | null }]> | undefined;
  #lockCursor: Iterator<[string, { expires: number }]> | undefined;

  constructor(clock: Clock = new SystemClock()) {
    this.#clock = clock;
  }

  async read(key: string): Promise<CacheEntry | undefined> {
    return this.#alive(key);
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    this.#set(key, entry);
  }

  async add(key: string, entry: CacheEntry): Promise<boolean> {
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
    // A live iterator keeps the cleared table and all its values in memory.
    this.#entryCursor = undefined;
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    const held = this.#lockHeld(name);
    if (held && held.owner !== owner) return false;
    this.#sweepOnWrite();
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

  async prune(): Promise<number> {
    const now = this.#clock.now();
    let removed = 0;
    for (const [key, entry] of this.#entries) if (entry.expires !== null && entry.expires <= now && this.#entries.delete(key)) removed++;
    for (const [name, lock] of this.#locks) if (lock.expires <= now && this.#locks.delete(name)) removed++;
    return removed;
  }

  /** Serialized, like every real store: a cached object is a copy, never shared with the caller. */
  #set(key: string, entry: CacheEntry): void {
    this.#sweepOnWrite();
    this.#entries.set(key, { raw: JSON.stringify(entry.value) as string | undefined, expires: entry.expires });
  }

  /**
   * Nothing else reaches a web process's memory (`cache:prune` runs in the scheduler's), and a key written once and never read
   * again — a rate-limit key per IP — would stay forever. Bounded work per call, a cursor carrying on where the last sweep stopped.
   */
  #sweepOnWrite(): void {
    if (++this.#writes % SWEEP_EVERY !== 0) return;
    const now = this.#clock.now();
    this.#entryCursor = this.#sweep(this.#entries, this.#entryCursor, now);
    this.#lockCursor = this.#sweep(this.#locks, this.#lockCursor, now);
  }

  #sweep<V extends { expires: number | null }>(
    map: Map<string, V>,
    cursor: Iterator<[string, V]> | undefined,
    now: number,
  ): Iterator<[string, V]> | undefined {
    cursor ??= map.entries();
    for (let i = 0; i < SWEEP_BATCH; i++) {
      const next = cursor.next();
      if (next.done) return undefined;
      const [key, value] = next.value;
      if (value.expires !== null && value.expires <= now) map.delete(key);
    }
    return cursor;
  }

  #alive(key: string): CacheEntry | undefined {
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
