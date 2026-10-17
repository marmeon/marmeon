import { createApplication, Logger, SystemClock, type Application, type ServiceProviderClass } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { silent } from './__fixtures__/stores.ts';
import { Cache, StoreCache, type CacheDriver, type CacheDriverFactory, type CacheStore, type Entry, type LockStore } from './cache.ts';
import { guardDriver } from './guarded.ts';
import { CacheServiceProvider, CacheSetupError } from './index.ts';
import { RateLimiter } from './rate-limiter.ts';

// Cache drivers that providers bring (`static cacheDrivers`): they carry the cache, the rate limiter and locks, see only keys and
// owners the cache checked, and every wrong name — built-in, twice, unknown — or a lock store that does not exclude stops the start.

/** Entries in a map; the expiry is its own to keep — unless `keepsExpired`. */
class DictStore implements CacheStore {
  readonly entries = new Map<string, Entry>();
  readonly keys: unknown[] = [];
  pruned = 0;
  prune?: () => Promise<number>;
  readonly #keepsExpired: boolean;
  constructor(options: { keepsExpired?: boolean; prune?: boolean } = {}) {
    this.#keepsExpired = options.keepsExpired ?? false;
    if (options.prune) this.prune = async () => ++this.pruned;
  }
  async read(key: string): Promise<Entry | undefined> {
    this.keys.push(key);
    const entry = this.entries.get(key);
    return entry && (this.#keepsExpired || entry.expires === null || entry.expires > Date.now()) ? entry : undefined;
  }
  async write(key: string, entry: Entry): Promise<void> {
    this.keys.push(key);
    this.entries.set(key, entry);
  }
  async add(key: string, entry: Entry): Promise<boolean> {
    if (await this.read(key)) return false;
    this.entries.set(key, entry);
    return true;
  }
  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const current = await this.read(key);
    const value = typeof current?.value === 'number' ? current.value + by : by;
    this.entries.set(key, { value, expires: current ? current.expires : expires });
    return value;
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
  async clear(): Promise<void> {
    this.entries.clear();
  }
}

/** Locks in a map. `flaw` breaks one promise of the contract. */
class DictLocks implements LockStore {
  readonly held = new Map<string, { owner: string; expires: number }>();
  readonly calls: unknown[][] = [];
  readonly #flaw: 'shares' | 'foreign-unlock' | undefined;
  constructor(flaw?: 'shares' | 'foreign-unlock') {
    this.#flaw = flaw;
  }
  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    this.calls.push(['lock', name, owner]);
    const held = this.held.get(name);
    if (held && held.expires > Date.now() && held.owner !== owner && this.#flaw !== 'shares') return false;
    this.held.set(name, { owner, expires });
    return true;
  }
  async unlock(name: string, owner: string): Promise<boolean> {
    this.calls.push(['unlock', name, owner]);
    const held = this.held.get(name);
    if (!held || (held.owner !== owner && this.#flaw !== 'foreign-unlock')) return false;
    this.held.delete(name);
    return true;
  }
  async forceUnlock(name: string): Promise<void> {
    this.held.delete(name);
  }
  async lockOwner(name: string): Promise<string | undefined> {
    return this.held.get(name)?.owner;
  }
}

/** One object that is the store and the lock store. */
class Both extends DictStore implements LockStore {
  readonly #locks = new DictLocks();
  lock = (name: string, owner: string, expires: number) => this.#locks.lock(name, owner, expires);
  unlock = (name: string, owner: string) => this.#locks.unlock(name, owner);
  forceUnlock = (name: string) => this.#locks.forceUnlock(name);
  lockOwner = (name: string) => this.#locks.lockOwner(name);
}

function pluginProvider(name: string, cacheDrivers: Record<string, CacheDriverFactory> | undefined): ServiceProviderClass {
  const Provider = class {
    static cacheDrivers = cacheDrivers;
  };
  Object.defineProperty(Provider, 'name', { value: name });
  return Provider as unknown as ServiceProviderClass;
}

const dict = (store = new DictStore(), locks: LockStore = new DictLocks()): CacheDriverFactory => () => ({ store, locks });

function boot(providers: ServiceProviderClass[], env: Record<string, string> = {}): Promise<Application> {
  return createApplication(
    { root: '/tmp', discover: false, providers: [CacheServiceProvider, ...providers] },
    { env: { NODE_ENV: 'test', CACHE_DRIVER: 'dict', ...env }, override: (container) => container.instance(Logger, silent) },
  );
}

describe('a cache driver of a provider', () => {
  it('carries the cache, the rate limiter and locks — store and lock store are two objects', async () => {
    const store = new DictStore();
    const locks = new DictLocks();
    await using app = await boot([pluginProvider('DictPackage', { dict: dict(store, locks) })], { CACHE_PREFIX: 'app:' });
    const cache = app.container.make(Cache);
    await cache.put('user', { id: 1 }, 60);
    expect(await cache.get('user')).toEqual({ id: 1 });
    expect([...store.entries.keys()]).toEqual(['app:user']);

    const limiter = app.container.make(RateLimiter);
    expect(await limiter.attempt('login', 2, 60)).toBe(true);
    expect(await limiter.attempt('login', 2, 60)).toBe(true);
    expect(await limiter.attempt('login', 2, 60)).toBe(false);

    const lock = cache.lock('report', 30);
    expect(await lock.get()).toBe(true);
    expect(await cache.lock('report', 30).get()).toBe(false);
    expect(locks.held.get('app:report')?.owner).toBe(lock.owner);
    expect(await lock.release()).toBe(true);
    // The lock store is the one the driver returned: it never saw an entry, the store never saw a lock.
    expect([...store.entries.keys()].some((key) => key.includes('report'))).toBe(false);
  });

  it('gives the factory its name, the container, the clock and the prefix', async () => {
    let seen: Record<string, unknown> | undefined;
    await using app = await boot([pluginProvider('DictPackage', { dict: (context) => ((seen = { ...context }), { store: new DictStore(), locks: new DictLocks() }) })], { CACHE_PREFIX: 'p:' });
    expect(seen).toMatchObject({ name: 'dict', prefix: 'p:' });
    expect(seen?.container).toBeDefined();
    expect(seen?.clock).toBeDefined();
    expect(app.container.has(Cache)).toBe(true);
  });

  it('is a valid provider with nothing but a driver record', async () => {
    await using app = await boot([pluginProvider('DictPackage', { dict: dict() })]);
    expect(app.container.make(Cache)).toBeInstanceOf(StoreCache);
  });

  it('is built once, at the start', async () => {
    let made = 0;
    await using app = await boot([pluginProvider('DictPackage', { dict: () => (made++, { store: new DictStore(), locks: new DictLocks() }) })]);
    app.container.make(Cache);
    app.container.make(Cache);
    expect(made).toBe(1);
  });

  describe('the guard around it', () => {
    it('lets the driver see only text as keys and lock names, and only non-empty text as an owner', async () => {
      const store = new DictStore();
      const locks = new DictLocks();
      await using app = await boot([pluginProvider('DictPackage', { dict: dict(store, locks) })]);
      const cache = app.container.make(Cache);
      store.keys.length = 0;
      locks.calls.length = 0;
      // The cache joins prefix and key into text; the driver never gets the object a key was passed as.
      await cache.put({ toString: () => 'object-key' } as unknown as string, 1);
      await cache.lock(7 as unknown as string, 5).get();
      expect(store.keys).toEqual(['object-key']);
      expect(locks.calls).toEqual([['lock', '7', expect.any(String)]]);
      locks.calls.length = 0;
      // An owner that is empty would match a lock with no owner: refused before the driver sees it.
      await expect(cache.lock('report', 5, '').get()).rejects.toThrow(/non-empty string/);
      await expect(cache.lock('report', 5, '').release()).rejects.toThrow(/non-empty string/);
      expect(locks.calls).toEqual([]);
    });

    it('refuses what is no text when it reaches the wrapper', async () => {
      const store = new DictStore();
      const locks = new DictLocks();
      const guarded = guardDriver('dict', { store, locks }, new SystemClock());
      await expect(guarded.store.read(7 as unknown as string)).rejects.toThrow(/cache key is a string/);
      await expect(guarded.store.write({} as unknown as string, { value: 1, expires: null })).rejects.toThrow(/cache key is a string/);
      await expect(guarded.locks.lock(null as unknown as string, 'o', Date.now() + 1000)).rejects.toThrow(/lock name is a string/);
      await expect(guarded.locks.unlock('a', undefined as unknown as string)).rejects.toThrow(/non-empty string/);
      await expect(guarded.locks.lock('a', 'o', Number.NaN)).rejects.toThrow(/finite time/);
      expect(store.keys).toEqual([]);
      expect(locks.calls).toEqual([]);
    });

    it('answers true only when the driver said exactly true — a truthy answer never takes or frees a lock', async () => {
      // A driver that answers with whatever is truthy, and an owner that is no text.
      const sloppy: LockStore = {
        lock: async () => 1 as unknown as boolean,
        unlock: async () => 'yes' as unknown as boolean,
        forceUnlock: async () => {},
        lockOwner: async () => 42 as unknown as string,
      };
      const { locks } = guardDriver('sloppy', { store: new DictStore(), locks: sloppy }, new SystemClock());
      expect(await locks.lock('a', 'o', Date.now() + 10_000)).toBe(false);
      expect(await locks.unlock('a', 'o')).toBe(false);
      expect(await locks.lockOwner('a')).toBeUndefined();
    });

    it('never serves an entry past its expiry, whatever the driver kept', async () => {
      const store = new DictStore({ keepsExpired: true });
      await using app = await boot([pluginProvider('DictPackage', { dict: dict(store) })]);
      const cache = app.container.make(Cache);
      store.entries.set('stale', { value: 'old', expires: Date.now() - 1000 });
      expect(await cache.get('stale')).toBeUndefined();
      expect(await cache.has('stale')).toBe(false);
    });

    it('refuses an increment that does not answer with an integer', async () => {
      const store = new DictStore();
      store.increment = async () => '5' as unknown as number;
      await using app = await boot([pluginProvider('DictPackage', { dict: dict(store) })]);
      await expect(app.container.make(Cache).increment('hits')).rejects.toThrow(/must return the new integer/);
    });
  });

  describe('prune', () => {
    it('sums what the store and the lock store prune — either may have none', async () => {
      const both = new StoreCache({ store: new DictStore({ prune: true }), locks: Object.assign(new DictLocks(), { prune: async () => 3 }) });
      expect(await both.prune()).toBe(4);
      expect(await new StoreCache({ store: new DictStore({ prune: true }), locks: new DictLocks() }).prune()).toBe(1);
      expect(await new StoreCache({ store: new DictStore(), locks: Object.assign(new DictLocks(), { prune: async () => 2 }) }).prune()).toBe(2);
      expect(await new StoreCache({ store: new DictStore(), locks: new DictLocks() }).prune()).toBeUndefined();
    });

    it('prunes one object that is both once', async () => {
      let calls = 0;
      const one = new Both({ prune: false });
      one.prune = async () => ++calls;
      expect(await new StoreCache({ store: one, locks: one }).prune()).toBe(1);

      calls = 0;
      await using app = await boot([pluginProvider('DictPackage', { dict: () => ({ store: one, locks: one }) })]);
      expect(await app.container.make(Cache).prune()).toBe(1);
      expect(calls).toBe(1);
    });
  });

  describe('stops the start', () => {
    it('when CACHE_DRIVER names no driver, listing the known ones', async () => {
      await expect(boot([pluginProvider('DictPackage', { dict: dict() })], { CACHE_DRIVER: 'dyct' })).rejects.toThrow(
        /CACHE_DRIVER=dyct is not a cache driver\. Known: file, memory, database, redis, dict\./,
      );
      await expect(boot([], { CACHE_DRIVER: 'nope' })).rejects.toThrow(CacheSetupError);
      await expect(boot([], { CACHE_DRIVER: 'nope' })).rejects.toThrow('[marmeon:S1] CACHE_DRIVER=nope is not a cache driver.');
    });

    it('for a built-in name, a malformed name, a name twice and a record that is no object — also when unused', async () => {
      await expect(boot([pluginProvider('Evil', { redis: dict() })], { CACHE_DRIVER: 'memory' })).rejects.toThrow(/Evil brings a cache driver named "redis", but that name belongs to the built-in one/);
      await expect(boot([pluginProvider('Evil', { memory: dict() })], { CACHE_DRIVER: 'file' })).rejects.toThrow(/named "memory"/);
      await expect(boot([pluginProvider('Odd', { 'My Cache': dict() })], { CACHE_DRIVER: 'memory' })).rejects.toThrow(/named "My Cache", but a name is lowercase/);
      await expect(boot([pluginProvider('One', { dict: dict() }), pluginProvider('Two', { dict: dict() })], { CACHE_DRIVER: 'memory' })).rejects.toThrow(
        /"dict" is brought by both One and Two/,
      );
      await expect(boot([pluginProvider('Wrong', { dict: 'not a function' as unknown as CacheDriverFactory })], { CACHE_DRIVER: 'memory' })).rejects.toThrow(/Wrong\.cacheDrivers\.dict must be a function/);
    });

    it('for a CACHE_DRIVER that is no driver name at all', async () => {
      await expect(boot([], { CACHE_DRIVER: 'Dict/../x' })).rejects.toThrow(/driver name/);
    });

    it('for a factory that throws, and does not run it again', async () => {
      let made = 0;
      const provider = pluginProvider('Broken', {
        dict: () => {
          made++;
          throw new Error('no credentials');
        },
      });
      await expect(boot([provider])).rejects.toThrow('no credentials');
      expect(made).toBe(1);
    });

    it('for a driver that is no pair, or lacks a member of either half', async () => {
      const half = (made: unknown): ServiceProviderClass => pluginProvider('Half', { dict: () => made as CacheDriver });
      await expect(boot([half(undefined)])).rejects.toThrow(/must return \{ store, locks \}/);
      await expect(boot([half({ store: new DictStore() })])).rejects.toThrow(/must return \{ store, locks \}/);
      await expect(boot([half({ store: new DictStore(), locks: { lock: async () => true } })])).rejects.toThrow(/locks with lock, unlock, forceUnlock, lockOwner — missing: unlock, forceUnlock, lockOwner/);
      await expect(boot([half({ store: { read: async () => undefined }, locks: new DictLocks() })])).rejects.toThrow(/store with read, write, add, increment, delete, clear — missing: write, add, increment, delete, clear/);
    });

    it('for a lock store that gives a held lock to a second owner', async () => {
      await expect(boot([pluginProvider('Weak', { dict: dict(new DictStore(), new DictLocks('shares')) })])).rejects.toThrow(/lock\(\) gave a held lock to a second owner/);
    });

    it('for a lock store that frees a lock for an owner that does not hold it', async () => {
      await expect(boot([pluginProvider('Weak', { dict: dict(new DictStore(), new DictLocks('foreign-unlock')) })])).rejects.toThrow(
        /unlock\(\) freed a lock for an owner that does not hold it/,
      );
    });

    it('for a store whose add overwrites', async () => {
      const store = new DictStore();
      store.add = async (key, entry) => (store.entries.set(key, entry), true);
      await expect(boot([pluginProvider('Weak', { dict: dict(store) })])).rejects.toThrow(/add\(\) overwrote an existing key/);
    });

    it('keeps the contract error when cleaning up the probe throws too', async () => {
      const locks = new DictLocks('shares');
      locks.forceUnlock = async () => {
        throw new Error('cleanup failed');
      };
      const store = new DictStore();
      let deleted = false;
      const remove = store.delete.bind(store);
      store.delete = async (key) => ((deleted = true), remove(key));
      await expect(boot([pluginProvider('Weak', { dict: dict(store, locks) })])).rejects.toThrow(/lock\(\) gave a held lock to a second owner/);
      expect(deleted).toBe(true);
    });

    it('and leaves no probe behind in a driver that passes', async () => {
      const store = new DictStore();
      const locks = new DictLocks();
      await using _app = await boot([pluginProvider('DictPackage', { dict: dict(store, locks) })]);
      expect(store.entries.size).toBe(0);
      expect(locks.held.size).toBe(0);
    });
  });

  it('is not tried when the app uses a built-in driver, which a provider may share the process with', async () => {
    let made = 0;
    await using app = await boot([pluginProvider('DictPackage', { dict: () => (made++, { store: new DictStore(), locks: new DictLocks() }) })], { CACHE_DRIVER: 'memory' });
    await app.container.make(Cache).put('k', 1);
    expect(made).toBe(0);
  });
});

describe('the pair', () => {
  it('needs both halves: a factory that returns only a store is no CacheDriverFactory', () => {
    // @ts-expect-error a cache driver without locks does not compile
    const noLocks: CacheDriverFactory = () => ({ store: new DictStore() });
    // @ts-expect-error a store alone is not a driver
    const justStore: CacheDriverFactory = () => new DictStore();
    expect(typeof noLocks).toBe('function');
    expect(typeof justStore).toBe('function');
  });

  it('has no lock methods on a CacheStore — the locks are a LockStore', () => {
    const store: CacheStore = new DictStore();
    // @ts-expect-error CacheStore has no lock()
    void store.lock;
    // @ts-expect-error CacheStore has no unlock()
    void store.unlock;
    const locks: LockStore = new DictLocks();
    // @ts-expect-error LockStore has no read()
    void locks.read;
    expect(true).toBe(true);
  });
});
