import type { CacheDriverFactory, CacheEntry, CacheStore, LockStore } from '@marmeon/cache';

/** Entries in this process's memory — what a store of your own has to do, in the smallest form. */
class ScratchStore implements CacheStore {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  /** The live entry, dropping an expired one. Synchronous, so what decides on it never yields between reading and writing. */
  #live(key: string): CacheEntry | undefined {
    const entry = this.#entries.get(key);
    if (entry && entry.expires !== null && entry.expires <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async read(key: string): Promise<CacheEntry | undefined> {
    return this.#live(key);
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    this.#entries.set(key, entry);
  }

  // No `await` between reading and writing a key: that is what makes these atomic in one process.
  async add(key: string, entry: CacheEntry): Promise<boolean> {
    if (this.#live(key)) return false;
    this.#entries.set(key, entry);
    return true;
  }

  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const current = this.#live(key);
    const counting = typeof current?.value === 'number' && Number.isSafeInteger(current.value);
    const value = counting ? (current.value as number) + by : by;
    this.#entries.set(key, { value, expires: counting ? current!.expires : expires });
    return value;
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }
}

/** The locks, as a store of their own: only the owner frees a lock, and an expired lock is free. */
class ScratchLocks implements LockStore {
  readonly #held = new Map<string, { owner: string; expires: number }>();
  readonly #now: () => number;

  constructor(now: () => number) {
    this.#now = now;
  }

  #holder(name: string): { owner: string; expires: number } | undefined {
    const lock = this.#held.get(name);
    return lock && lock.expires > this.#now() ? lock : undefined;
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    const holder = this.#holder(name);
    if (holder && holder.owner !== owner) return false;
    this.#held.set(name, { owner, expires });
    return true;
  }

  async unlock(name: string, owner: string): Promise<boolean> {
    if (this.#holder(name)?.owner !== owner) return false;
    this.#held.delete(name);
    return true;
  }

  async forceUnlock(name: string): Promise<void> {
    this.#held.delete(name);
  }

  async lockOwner(name: string): Promise<string | undefined> {
    return this.#holder(name)?.owner;
  }
}

const scratch: CacheDriverFactory = ({ clock }) => ({ store: new ScratchStore(() => clock.now()), locks: new ScratchLocks(() => clock.now()) });

/** A cache driver of the app's own, `CACHE_DRIVER=scratch` — a package brings its drivers the same way (docs/drivers.md#bringing-a-driver). */
export class ScratchCacheServiceProvider {
  static cacheDrivers = { scratch };
}
