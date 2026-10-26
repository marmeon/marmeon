import { setTimeout as sleep } from 'node:timers/promises';
import { SystemClock, durationToMilliseconds, durationToSeconds, err, ok, token, type Clock, type Duration, type Resolver, type Result } from '@marmeon/core';

/**
 * A key-value store with expiry. Values must survive `JSON.stringify`. `add`, `increment`
 * and locks are atomic in every store — across processes for `file`, `database` and `redis`.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Stores a value; without `ttl` (seconds, or `{ minutes: 5 }`) it never expires. */
  put(key: string, value: unknown, ttl?: Duration): Promise<void>;
  /** Stores the value only if the key is absent (or expired); returns whether it did. Atomic: of two at once, one wins. */
  add(key: string, value: unknown, ttl?: Duration): Promise<boolean>;
  has(key: string): Promise<boolean>;
  forget(key: string): Promise<void>;
  /**
   * Adds `by` (an integer, negative to count down) to the integer at `key` and returns the result — atomically, in one
   * step of the store: two processes counting at once never lose a count. A missing key (or one holding no integer)
   * starts at 0 and gets `ttl`; an existing one keeps its expiry — a rate limit window does not restart with
   * every hit.
   */
  increment(key: string, by?: number, ttl?: Duration): Promise<number>;
  /** The cached value, or `compute()` stored for `ttl`. Not a lock: two misses at once both compute. */
  remember<T>(key: string, ttl: Duration | undefined, compute: () => T | Promise<T>): Promise<T>;
  /** Seconds until the key expires, undefined if absent or without expiry. */
  ttlSeconds(key: string): Promise<number | undefined>;
  /** Empties the cache. Locks stay — they belong to whoever holds them. */
  flush(): Promise<void>;
  /**
   * Removes expired entries and expired locks (`marmeon cache:prune`, for the scheduler) — how many; undefined when the
   * store expires them by itself (Redis).
   */
  prune(): Promise<number | undefined>;
  /**
   * An atomic lock, held for at most `ttl` (seconds, or `{ seconds: 30 }`; it expires, so a crashed holder cannot block forever). `owner` restores a
   * lock taken elsewhere (another request, a job) to release it. See `docs/cache.md#locks`.
   */
  lock(name: string, ttl: Duration, owner?: string): Lock;
}
export const Cache = token<Cache>('Cache');

/** A cached value and when it expires: epoch milliseconds (by the store's {@link Clock}), null = never. */
export interface CacheEntry {
  value: unknown;
  expires: number | null;
}

/**
 * The entries behind a cache (memory, file, database, redis). Every operation that decides on what is stored — `add`,
 * `increment` — is one atomic step of the store, never read-then-write in the cache above it. Expiry is the store's: it reads
 * the time from its {@link Clock} (Redis from its own clock, `PX`). The locks are a {@link LockStore}, beside it in a {@link CacheDriver}.
 */
export interface CacheStore {
  /** The entry, if present and not expired. */
  read(key: string): Promise<CacheEntry | undefined>;
  write(key: string, entry: CacheEntry): Promise<void>;
  /** Writes `entry` only if the key is absent or expired — atomically. Whether it wrote. */
  add(key: string, entry: CacheEntry): Promise<boolean>;
  /**
   * Adds `by` to the integer at `key` — atomically — and returns the new value. Absent, expired or not an integer: the
   * key starts over at `by` and expires at `expires`. An existing integer keeps its expiry.
   */
  increment(key: string, by: number, expires: number | null): Promise<number>;
  delete(key: string): Promise<void>;
  /** Removes every entry of this store. Never a lock: `marmeon cache:clear` must not free what a running job holds. */
  clear(): Promise<void>;
  /**
   * Removes expired entries — which file and database stores keep until read or overwritten — and returns how many. Stores
   * whose entries expire on their own (Redis) have none (`marmeon cache:prune` says so).
   */
  prune?(): Promise<number>;
}

/**
 * The locks behind `cache.lock()`, `withoutOverlapping`, `onOneServer()` and unique jobs. Every operation is one atomic step of
 * the store — across processes, when the app runs on more than one. See `docs/drivers.md#cache-drivers`.
 */
export interface LockStore {
  /** Takes the lock `name` for `owner` until `expires` if it is free, expired, or already `owner`'s — atomically. Whether it did. */
  lock(name: string, owner: string, expires: number): Promise<boolean>;
  /** Frees the lock only while `owner` holds it — atomically (an expired lock taken over by another stays). Whether it did. */
  unlock(name: string, owner: string): Promise<boolean>;
  /** Frees the lock whoever holds it. */
  forceUnlock(name: string): Promise<void>;
  /** Who holds the lock now; undefined when it is free or expired. */
  lockOwner(name: string): Promise<string | undefined>;
  /** Removes expired locks which the store keeps until read or overwritten, and returns how many. Absent when they expire on their own. */
  prune?(): Promise<number>;
}

/**
 * What a cache driver provides: the entries and the locks. Both are required, so there is no cache without atomic locks. A
 * built-in store implements both interfaces in one class (`{ store, locks: store }`); a driver of your own may do the same, or
 * return two objects. See `docs/drivers.md#cache-drivers`.
 */
export interface CacheDriver {
  readonly store: CacheStore;
  readonly locks: LockStore;
}

/** What a {@link CacheDriverFactory} is given. */
export interface CacheDriverContext {
  /** The name the driver was registered under (`CACHE_DRIVER=dynamo`). */
  readonly name: string;
  readonly container: Resolver;
  readonly clock: Clock;
  /** `CACHE_PREFIX`. Keys and lock names arrive with it already prepended; this is for a namespace of your own (a table, an index). */
  readonly prefix: string;
}

/** Creates a cache driver: `static cacheDrivers = { dynamo: (context) => … }` on a service provider. */
export type CacheDriverFactory = (context: CacheDriverContext) => CacheDriver;

/**
 * One atomic lock, made by `cache.lock(name, ttl)`. Its owner token is random per lock object:
 * only the object that took the lock (or one restored with the same `owner`) can release it.
 */
export class Lock {
  readonly name: string;
  readonly seconds: number;
  readonly owner: string;
  readonly #store: LockStore;
  readonly #key: string;
  readonly #clock: Clock;

  /** @internal Made by `cache.lock()`. */
  constructor(store: LockStore, options: { name: string; key: string; seconds: number; owner?: string; clock: Clock }) {
    if (!(options.seconds > 0) || !Number.isFinite(options.seconds)) {
      throw new TypeError(`A lock needs a positive number of seconds after which it expires (got ${options.seconds} for "${options.name}").`);
    }
    this.#store = store;
    this.name = options.name;
    this.#key = options.key;
    this.seconds = options.seconds;
    this.owner = options.owner ?? crypto.randomUUID();
    this.#clock = options.clock;
  }

  /**
   * Tries once to take the lock. With `callback`: runs it while holding the lock, releases it afterwards and returns
   * `ok(its result)`, or `err({ kind: 'locked' })` without calling it when someone else holds the lock. See `docs/cache.md#locks`.
   */
  get(): Promise<boolean>;
  get<T>(callback: () => T | Promise<T>): Promise<Result<Awaited<T>, { kind: 'locked' }>>;
  async get<T>(callback?: () => T | Promise<T>): Promise<boolean | Result<Awaited<T>, { kind: 'locked' }>> {
    const acquired = await this.#store.lock(this.#key, this.owner, this.#clock.now() + this.seconds * 1000);
    if (!callback) return acquired;
    if (!acquired) return err({ kind: 'locked' });
    try {
      return ok(await callback());
    } finally {
      await this.release();
    }
  }

  /**
   * Waits up to `wait` (real time, polled every 250 ms) for the lock, runs `callback` while holding it, releases it afterwards and
   * returns `ok(its result)`. A lock that stays held gives `err({ kind: 'timeout' })` and the callback never runs. To try once, use `get()`.
   * See `docs/cache.md#locks`.
   */
  async block<T>(wait: Duration, callback: () => T | Promise<T>): Promise<Result<Awaited<T>, { kind: 'timeout' }>> {
    if (typeof callback !== 'function') throw new TypeError(`block() takes a callback — to try once, use get() (lock "${this.name}").`);
    if (!(await waitForLock(this, wait))) return err({ kind: 'timeout' });
    try {
      return ok(await callback());
    } finally {
      await this.release();
    }
  }

  /** Frees the lock if this owner still holds it — after it expired and another took it, never. Whether it did. */
  release(): Promise<boolean> {
    return this.#store.unlock(this.#key, this.owner);
  }

  /** Frees the lock, whoever holds it. */
  forceRelease(): Promise<void> {
    return this.#store.forceUnlock(this.#key);
  }

  /** Whether this owner holds the lock right now. */
  async owned(): Promise<boolean> {
    return (await this.#store.lockOwner(this.#key)) === this.owner;
  }
}

/**
 * Waits up to `wait` (real time, polled every 250 ms) until `lock` is taken, and says whether it was. The caller holds the lock
 * when this is `true` and has to release it.
 */
export async function waitForLock(lock: Lock, wait: Duration): Promise<boolean> {
  const deadline = performance.now() + durationToSeconds(wait) * 1000;
  while (!(await lock.get())) {
    if (performance.now() + 250 > deadline) return false;
    await sleep(250);
  }
  return true;
}

/** A span → an expiry by `clock`; undefined = never. */
function expiresAt(clock: Clock, ttl: Duration | undefined): number | null {
  return ttl === undefined ? null : clock.now() + durationToMilliseconds(ttl);
}

/** The cache on top of a driver: keys get the prefix, TTLs become expiry times, everything atomic is the driver's. */
export class StoreCache implements Cache {
  readonly #store: CacheStore;
  readonly #locks: LockStore;
  readonly #prefix: string;
  readonly #clock: Clock;

  constructor({ store, locks }: CacheDriver, prefix = '', clock: Clock = new SystemClock()) {
    this.#store = store;
    this.#locks = locks;
    this.#prefix = prefix;
    this.#clock = clock;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.#store.read(this.#prefix + key))?.value as T | undefined;
  }

  async put(key: string, value: unknown, ttl?: Duration): Promise<void> {
    await this.#store.write(this.#prefix + key, { value, expires: expiresAt(this.#clock, ttl) });
  }

  add(key: string, value: unknown, ttl?: Duration): Promise<boolean> {
    return this.#store.add(this.#prefix + key, { value, expires: expiresAt(this.#clock, ttl) });
  }

  async has(key: string): Promise<boolean> {
    return (await this.#store.read(this.#prefix + key)) !== undefined;
  }

  async forget(key: string): Promise<void> {
    await this.#store.delete(this.#prefix + key);
  }

  async increment(key: string, by = 1, ttl?: Duration): Promise<number> {
    if (!Number.isSafeInteger(by)) throw new TypeError(`cache.increment() counts in integers (got ${by} for "${key}").`);
    return this.#store.increment(this.#prefix + key, by, expiresAt(this.#clock, ttl));
  }

  async remember<T>(key: string, ttl: Duration | undefined, compute: () => T | Promise<T>): Promise<T> {
    const entry = await this.#store.read(this.#prefix + key);
    if (entry) return entry.value as T;
    const value = await compute();
    await this.put(key, value, ttl);
    return value;
  }

  async ttlSeconds(key: string): Promise<number | undefined> {
    const entry = await this.#store.read(this.#prefix + key);
    return entry?.expires ? Math.max(0, Math.ceil((entry.expires - this.#clock.now()) / 1000)) : undefined;
  }

  async flush(): Promise<void> {
    await this.#store.clear();
  }

  async prune(): Promise<number | undefined> {
    // One class implementing both interfaces is pruned once.
    const stores = (this.#locks as unknown) === this.#store ? [this.#store] : [this.#store, this.#locks];
    const counts = await Promise.all(stores.map((store) => store.prune?.()));
    return counts.some((count) => count !== undefined) ? counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) : undefined;
  }

  lock(name: string, ttl: Duration, owner?: string): Lock {
    return new Lock(this.#locks, { name, key: this.#prefix + name, seconds: durationToSeconds(ttl), clock: this.#clock, ...(owner === undefined ? {} : { owner }) });
  }
}
