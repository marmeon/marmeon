import type { Clock } from '@marmeon/core';
import type { CacheDriver, CacheEntry, CacheStore, LockStore } from './cache.ts';
import { CacheSetupError } from './errors.ts';
import { withCode } from '@marmeon/core/internal';

const STORE_MEMBERS = ['read', 'write', 'add', 'increment', 'delete', 'clear'] as const;
const LOCK_MEMBERS = ['lock', 'unlock', 'forceUnlock', 'lockOwner'] as const;

function keyOf(what: string, value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`A ${what} is a string (got ${typeof value}).`);
  return value;
}

function ownerOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('A lock owner is a non-empty string.');
  return value;
}

function missingMembers(made: unknown, members: readonly string[]): string[] {
  return members.filter((member) => typeof (made as Record<string, unknown> | null | undefined)?.[member] !== 'function');
}

/**
 * The entries of a driver a provider brought, as the cache gets them: every key is checked here before the driver sees it, the
 * answers are held to the contract (`add` answers `true` only when it said so, `increment` an integer) and an entry past its expiry
 * is never served, whatever the driver kept. The driver's store is held privately and each member delegated.
 */
export class GuardedStore implements CacheStore {
  readonly #store: CacheStore;
  readonly #clock: Clock;
  readonly prune?: () => Promise<number>;

  constructor(driver: string, made: unknown, clock: Clock) {
    const missing = missingMembers(made, STORE_MEMBERS);
    if (typeof made !== 'object' || made === null || missing.length > 0) {
      throw new CacheSetupError(withCode('S1', `The cache driver "${driver}" must return a store with ${STORE_MEMBERS.join(', ')}${missing.length > 0 ? ` — missing: ${missing.join(', ')}` : ''}.`));
    }
    const store = made as CacheStore;
    this.#store = store;
    this.#clock = clock;
    if (typeof store.prune === 'function') this.prune = () => store.prune!();
  }

  async read(key: string): Promise<CacheEntry | undefined> {
    const entry = await this.#store.read(keyOf('cache key', key));
    if (typeof entry !== 'object' || entry === null) return undefined;
    // Expiry is the contract's, not the driver's goodwill: an entry past it is gone.
    if (entry.expires !== null && (typeof entry.expires !== 'number' || entry.expires <= this.#clock.now())) return undefined;
    return entry;
  }

  async write(key: string, entry: CacheEntry): Promise<void> {
    return this.#store.write(keyOf('cache key', key), entry);
  }

  async add(key: string, entry: CacheEntry): Promise<boolean> {
    return (await this.#store.add(keyOf('cache key', key), entry)) === true;
  }

  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const value = await this.#store.increment(keyOf('cache key', key), by, expires);
    if (!Number.isSafeInteger(value)) throw new TypeError(`The cache driver's increment() returned ${String(value)} for "${key}" — it must return the new integer.`);
    return value;
  }

  async delete(key: string): Promise<void> {
    return this.#store.delete(keyOf('cache key', key));
  }

  clear(): Promise<void> {
    return this.#store.clear();
  }
}

/**
 * The locks of a driver a provider brought. What a wrapper can hold the driver to, it does: names are strings and owners
 * non-empty strings (so no missing owner matches a free lock), `lock` and `unlock` answer `true` only when the driver said exactly
 * that, and `lockOwner` is a string or nothing. Whether the driver really excludes a second owner and ignores a foreign `unlock` is
 * proven at the start ({@link verifyDriver}) — a wrapper cannot do that atomically.
 */
export class GuardedLocks implements LockStore {
  readonly #locks: LockStore;
  readonly prune?: () => Promise<number>;

  /** `pruned`: whether this lock store is pruned on its own — false when the same object also is the store, which is pruned once. */
  constructor(driver: string, made: unknown, pruned: boolean) {
    const missing = missingMembers(made, LOCK_MEMBERS);
    if (typeof made !== 'object' || made === null || missing.length > 0) {
      throw new CacheSetupError(withCode('S1', `The cache driver "${driver}" must return locks with ${LOCK_MEMBERS.join(', ')}${missing.length > 0 ? ` — missing: ${missing.join(', ')}` : ''}.`));
    }
    const locks = made as LockStore;
    this.#locks = locks;
    if (pruned && typeof locks.prune === 'function') this.prune = () => locks.prune!();
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    keyOf('lock name', name);
    ownerOf(owner);
    if (!Number.isFinite(expires)) throw new TypeError('A lock expires at a finite time.');
    return (await this.#locks.lock(name, owner, expires)) === true;
  }

  async unlock(name: string, owner: string): Promise<boolean> {
    keyOf('lock name', name);
    ownerOf(owner);
    return (await this.#locks.unlock(name, owner)) === true;
  }

  async forceUnlock(name: string): Promise<void> {
    return this.#locks.forceUnlock(keyOf('lock name', name));
  }

  async lockOwner(name: string): Promise<string | undefined> {
    const owner = await this.#locks.lockOwner(keyOf('lock name', name));
    return typeof owner === 'string' && owner !== '' ? owner : undefined;
  }
}

/** What a cache driver's factory returned, as the cache gets it: both halves checked and wrapped. */
export function guardDriver(driver: string, made: unknown, clock: Clock): CacheDriver {
  const pair = made as Partial<Record<'store' | 'locks', unknown>> | null | undefined;
  if (typeof pair !== 'object' || pair === null || typeof pair.store !== 'object' || pair.store === null || typeof pair.locks !== 'object' || pair.locks === null) {
    throw new CacheSetupError(withCode('S1', `The cache driver "${driver}" must return { store, locks }: the entries and the atomic locks. One object may be both.`));
  }
  return { store: new GuardedStore(driver, pair.store, clock), locks: new GuardedLocks(driver, pair.locks, pair.locks !== pair.store) };
}

/**
 * Tries a driver once at the start with a lock and a key nobody else uses: the lock excludes a second owner, a foreign `unlock`
 * frees nothing, the owner can free it, and `add` refuses an existing key. A driver that fails these would let
 * `withoutOverlapping`, `onOneServer()` and unique jobs run twice, or one job free another's lock — the start stops instead.
 */
export async function verifyDriver(driver: string, { store, locks }: CacheDriver, clock: Clock, prefix: string): Promise<void> {
  const fail = (what: string): never => {
    throw new CacheSetupError(withCode('S1', `The cache driver "${driver}" breaks its contract: ${what}. See docs/drivers.md#cache-drivers.`));
  };
  const probe = `${prefix}marmeon-probe:${crypto.randomUUID()}`;
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()];
  const until = clock.now() + 60_000;
  try {
    if (!(await locks.lock(probe, first, until))) fail('lock() did not take a free lock');
    if (await locks.lock(probe, second, until)) fail('lock() gave a held lock to a second owner');
    if ((await locks.lockOwner(probe)) !== first) fail('lockOwner() did not name the owner');
    if (await locks.unlock(probe, second)) fail('unlock() freed a lock for an owner that does not hold it');
    if ((await locks.lockOwner(probe)) !== first) fail('a foreign unlock() took the lock from its owner');
    if (!(await locks.unlock(probe, first))) fail('unlock() did not free the lock for its owner');
    if ((await locks.lockOwner(probe)) !== undefined) fail('lockOwner() named an owner after the lock was freed');
    if (!(await store.add(probe, { value: 1, expires: until }))) fail('add() did not write an absent key');
    if (await store.add(probe, { value: 2, expires: until })) fail('add() overwrote an existing key');
  } finally {
    // Both run, and neither replaces the contract error above.
    await Promise.allSettled([locks.forceUnlock(probe), store.delete(probe)]);
  }
}
