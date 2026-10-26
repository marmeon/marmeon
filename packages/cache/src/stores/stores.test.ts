import { readdirSync } from 'node:fs';
import { err, ok } from '@marmeon/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreCache, type CacheStore, type LockStore } from '../cache.ts';
import { RateLimiter } from '../rate-limiter.ts';
import { FileStore } from './file.ts';
import { storeKinds, storeUnderTest, type StoreUnderTest } from '../__fixtures__/stores.ts';

const both = <S extends CacheStore & LockStore>(store: S) => ({ store, locks: store });

// ONE suite for every store: memory, file, database on SQLite — and on Postgres (`pnpm test:pgsql`) and Redis
// (`pnpm test:redis`). What a store decides — add, increment, locks — must behave the same everywhere.
describe.each(storeKinds)('the %s store', (kind) => {
  let current: StoreUnderTest | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });
  const open = async () => {
    current = await storeUnderTest(kind);
    return { ...current, cache: new StoreCache({ store: current.store, locks: current.store }, '', current.clock) };
  };

  it('stores, reads, expires and forgets values', async () => {
    const { cache, pass } = await open();
    await cache.put('user', { id: 1, name: 'Ada' });
    await cache.put('short', 'x', 1);
    await cache.put('gone', 'x', -1);
    expect(await cache.get('user')).toEqual({ id: 1, name: 'Ada' });
    expect(await cache.get('short')).toBe('x');
    expect(await cache.get('gone')).toBeUndefined();
    expect(await cache.has('missing')).toBe(false);
    await pass(1_100);
    expect(await cache.get('short')).toBeUndefined();
    await cache.forget('user');
    expect(await cache.get('user')).toBeUndefined();
  });

  it('takes a time to live as seconds or as a duration object, on the test clock', async () => {
    const { cache, pass } = await open();
    await cache.put('object', 1, { seconds: 1 });
    await cache.put('number', 2, 1);
    await cache.put('long', 3, { minutes: 1 });
    expect(await cache.remember('remembered', { milliseconds: 1500 }, () => 4)).toBe(4);
    expect(await cache.get('object')).toBe(1);
    await pass(1_100);
    expect(await cache.get('object')).toBeUndefined();
    expect(await cache.get('number')).toBeUndefined();
    expect(await cache.get('remembered')).toBe(4);
    expect(await cache.get('long')).toBe(3);
    await expect(cache.put('text', 1, '5m' as never)).rejects.toThrow('write `{ minutes: 5 }`');
  });

  it('adds only absent (or expired) keys — and says whether it did', async () => {
    const { cache, pass } = await open();
    expect(await cache.add('welcome-sent:7', true, 1)).toBe(true);
    expect(await cache.add('welcome-sent:7', 'again', 1)).toBe(false);
    expect(await cache.get('welcome-sent:7')).toBe(true);
    await pass(1_100);
    expect(await cache.add('welcome-sent:7', 'after expiry', 60)).toBe(true);
    expect(await cache.get('welcome-sent:7')).toBe('after expiry');
  });

  it('lets exactly one of many concurrent adds win', async () => {
    const { cache } = await open();
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => cache.add('first', i, 60)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('increments within one window — a hit does not restart the expiry', async () => {
    const { cache } = await open();
    expect(await cache.increment('hits', 1, 60)).toBe(1);
    expect(await cache.increment('hits', 2, 3600)).toBe(3);
    expect(await cache.increment('hits', -1)).toBe(2);
    expect(await cache.get('hits')).toBe(2);
    expect(await cache.ttlSeconds('hits')).toBeLessThanOrEqual(60);
    expect(await cache.ttlSeconds('hits')).toBeGreaterThan(55);
  });

  it('starts a counter over once its window passed, or when the key held no integer', async () => {
    const { cache, pass } = await open();
    await cache.increment('window', 5, 1);
    await pass(1_100);
    expect(await cache.increment('window', 1, 60)).toBe(1);
    await cache.put('text', 'not a number', 60);
    expect(await cache.increment('text', 4, 60)).toBe(4);
    await expect(cache.increment('hits', 1.5)).rejects.toThrow(/integers/);
  });

  it('counts every one of 100 concurrent increments', async () => {
    const { cache } = await open();
    const values = await Promise.all(Array.from({ length: 100 }, () => cache.increment('busy', 1, 60)));
    expect(await cache.get('busy')).toBe(100);
    expect(new Set(values).size).toBe(100); // every caller saw its own count
  });

  it('lets exactly 10 of 100 concurrent attempts through a limit of 10 (RateLimiter)', async () => {
    const { cache } = await open();
    const limiter = new RateLimiter(cache);
    const allowed = await Promise.all(Array.from({ length: 100 }, () => limiter.attempt('login:ada', { maxAttempts: 10, decay: 60 })));
    expect(allowed.filter(Boolean)).toHaveLength(10);
    expect(await limiter.tooManyAttempts('login:ada', 10)).toBe(true);
  });

  it('refuses an attempt() whose limit is not named, positive and finite, and counts nothing', async () => {
    const { cache } = await open();
    const limiter = new RateLimiter(cache);
    const attempt = limiter.attempt.bind(limiter) as (...args: unknown[]) => Promise<boolean>;
    const refused: unknown[][] = [
      ['guarded', 5, 60],
      ['guarded', 60, 5],
      ['guarded'],
      ['guarded', undefined],
      ['guarded', null],
      ['guarded', [5, 60]],
      ['guarded', { maxAttempts: 5 }],
      ['guarded', { decay: 60 }],
      ['guarded', { maxAttempts: 0, decay: 60 }],
      ['guarded', { maxAttempts: -1, decay: 60 }],
      ['guarded', { maxAttempts: Number.NaN, decay: 60 }],
      ['guarded', { maxAttempts: Number.POSITIVE_INFINITY, decay: 60 }],
      ['guarded', { maxAttempts: '5', decay: 60 }],
      ['guarded', { maxAttempts: 5, decay: 0 }],
      ['guarded', { maxAttempts: 5, decay: -60 }],
      ['guarded', { maxAttempts: 5, decay: Number.NaN }],
      ['guarded', { maxAttempts: 5, decay: '60' }],
      ['guarded', { maxAttempts: 5, decay: null }],
    ];
    for (const args of refused) await expect(attempt(...args), JSON.stringify(args)).rejects.toThrow(/^RateLimiter\.attempt\(\)[^]*attempt\(key, \{ maxAttempts: 5, decay: 60 \}\)/);
    for (const args of refused) await expect(attempt(...args)).rejects.toBeInstanceOf(TypeError);
    expect(await limiter.attempts('guarded')).toBe(0);
    expect(await limiter.attempt('guarded', { maxAttempts: 1, decay: 60 })).toBe(true);
    expect(await limiter.attempts('guarded')).toBe(1);
  });

  it('keeps apps sharing a store apart with a prefix, and flushes entries but never locks', async () => {
    const { store, clock } = await open();
    await new StoreCache({ store, locks: store }, 'a:', clock).put('k', 'from a');
    expect(await new StoreCache({ store, locks: store }, 'b:', clock).get('k')).toBeUndefined();
    const lock = new StoreCache({ store, locks: store }, 'a:', clock).lock('report', 60);
    expect(await lock.get()).toBe(true);
    await new StoreCache({ store, locks: store }, '', clock).flush();
    expect(await new StoreCache({ store, locks: store }, 'a:', clock).get('k')).toBeUndefined();
    expect(await lock.owned()).toBe(true);
  });

  it('prunes expired entries and locks — and nothing that is still live (cache:prune)', async () => {
    const { cache, pass } = await open();
    await cache.put('forever', 1);
    await cache.put('long', 2, 3600);
    await cache.put('short', 3, 1);
    await cache.increment('hits', 1, 1);
    const held = cache.lock('held', 3600);
    const brief = cache.lock('brief', 1);
    expect([await held.get(), await brief.get()]).toEqual([true, true]);
    await pass(1_100);
    const removed = await cache.prune();
    if (kind === 'redis') {
      expect(removed).toBeUndefined(); // Redis expires keys itself
      return;
    }
    expect(removed).toBe(3); // short, hits, brief
    expect(await cache.get('forever')).toBe(1);
    expect(await cache.get('long')).toBe(2);
    expect(await held.owned()).toBe(true);
    expect(await cache.prune()).toBe(0);
  });

  it('remembers computed values', async () => {
    const { cache } = await open();
    const compute = vi.fn(() => 42);
    expect(await cache.remember('answer', 60, compute)).toBe(42);
    expect(await cache.remember('answer', 60, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  describe('locks', () => {
    it('hands a lock to one owner at a time, and frees it on release', async () => {
      const { cache } = await open();
      const a = cache.lock('avatar:7', 10);
      const b = cache.lock('avatar:7', 10);
      expect(await a.get()).toBe(true);
      expect(await b.get()).toBe(false);
      expect(await a.get()).toBe(true); // the owner may take it again (extends it)
      expect(await b.release()).toBe(false); // not b's to release
      expect(await a.owned()).toBe(true);
      expect(await a.release()).toBe(true);
      expect(await b.get()).toBe(true);
    });

    it('lets exactly one of many concurrent takers win', async () => {
      const { cache } = await open();
      const results = await Promise.all(Array.from({ length: 50 }, () => cache.lock('report', 10).get()));
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("never releases a lock that expired and was taken over — B's lock stays when A releases", async () => {
      const { cache, pass } = await open();
      const a = cache.lock('import', 1);
      expect(await a.get()).toBe(true);
      await pass(1_100); // A's lock expired (A is slow, or hung)
      const b = cache.lock('import', 10);
      expect(await b.get()).toBe(true);
      expect(await a.release()).toBe(false); // A finishes and releases "its" lock
      expect(await b.owned()).toBe(true); // … which is B's now, and stays
      expect(await cache.lock('import', 10).get()).toBe(false);
    });

    it('restores a lock by its owner token (another request, a job) to release it', async () => {
      const { cache } = await open();
      const taken = cache.lock('unique:job-7', 60);
      expect(await taken.get()).toBe(true);
      expect(await cache.lock('unique:job-7', 60, 'someone else').release()).toBe(false);
      expect(await cache.lock('unique:job-7', 60, taken.owner).release()).toBe(true);
      expect(await cache.lock('unique:job-7', 60).get()).toBe(true);
    });

    it('runs a callback while holding the lock and releases it afterwards — also when it throws', async () => {
      const { cache } = await open();
      expect(await cache.lock('task', 10).get(() => 'done')).toStrictEqual(ok('done'));
      await expect(cache.lock('task', 10).get(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
      expect(await cache.lock('task', 10).get()).toBe(true);
      const never = vi.fn(() => 'never');
      expect(await cache.lock('task', 10).get(never)).toStrictEqual(err({ kind: 'locked' }));
      expect(never).not.toHaveBeenCalled();
    });

    it('tells a callback that returns false from a lock that was taken', async () => {
      const { cache } = await open();
      expect(await cache.lock('flag', 10).get(() => false)).toStrictEqual(ok(false));
    });

    it('waits with block() until the lock is free and returns ok, or err timeout', async () => {
      const { cache } = await open();
      const holder = cache.lock('report', 10);
      await holder.get();
      setTimeout(() => void holder.release(), 300);
      expect(await cache.lock('report', 10).block(2, () => 'waited')).toStrictEqual(ok('waited'));
      await holder.get();
      expect(await cache.lock('report', 10).block(0.3, () => 'waited')).toStrictEqual(err({ kind: 'timeout' }));
      await holder.forceRelease();
      expect(await cache.lock('report', 10).block(1, () => 'free')).toStrictEqual(ok('free'));
      expect(await cache.lock('report', 10).get()).toBe(true);
    });

    it('never runs the callback of block() while the lock is held by someone else', async () => {
      const { cache } = await open();
      await cache.lock('held', 10).get();
      const callback = vi.fn(() => 'ran');
      expect(await cache.lock('held', 10).block(0.3, callback)).toStrictEqual(err({ kind: 'timeout' }));
      expect(await cache.lock('held', { milliseconds: 10_000 }).block({ milliseconds: 300 }, callback)).toStrictEqual(err({ kind: 'timeout' }));
      expect(callback).not.toHaveBeenCalled();
    });

    it('throws a TypeError from block() without a callback, pointing to get(), and takes no lock', async () => {
      const { cache } = await open();
      const lock = cache.lock('no-callback', 10);
      await expect((lock.block as (wait: number) => Promise<unknown>)(1)).rejects.toThrow(new TypeError('block() takes a callback — to try once, use get() (lock "no-callback").'));
      expect(await cache.lock('no-callback', 10).get()).toBe(true);
    });

    it('releases the lock after a callback of block() that throws', async () => {
      const { cache } = await open();
      await expect(
        cache.lock('throws', 10).block(1, () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await cache.lock('throws', 10).get()).toBe(true);
    });

    it('refuses a lock that never expires', async () => {
      const { cache } = await open();
      expect(() => cache.lock('forever', 0)).toThrow(/positive number of seconds/);
      expect(() => cache.lock('forever', { minutes: 0 })).toThrow(/positive number of seconds/);
      expect(() => cache.lock('text', '30s' as never)).toThrow('write `{ seconds: 30 }`');
    });

    it('holds a lock for a duration object', async () => {
      const { cache, pass } = await open();
      expect(await cache.lock('timed', { seconds: 1 }).get()).toBe(true);
      expect(await cache.lock('timed', { seconds: 1 }).get()).toBe(false);
      await pass(1_100);
      expect(await cache.lock('timed', { seconds: 1 }).get()).toBe(true);
      expect(await cache.lock('waits', 10).block({ milliseconds: 500 }, () => true)).toStrictEqual(ok(true));
    });
  });

  if (kind === 'file') {
    it('names files by the key hash and keeps locks (and guards) out of the entries', async () => {
      const { cache, target } = await open();
      await cache.put('k', 'v', 60);
      await cache.lock('l', 60).get();
      await cache.increment('n');
      const directory = (target as { directory: string }).directory;
      expect(readdirSync(directory).sort()).toEqual([...readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name)), 'locks'].sort());
      expect(readdirSync(directory).filter((name) => /^[0-9a-f]{64}$/.test(name))).toHaveLength(2);
      await cache.flush();
      expect(readdirSync(directory)).toEqual(['locks']);
    });

    it('survives a restart: a second store on the same directory reads what the first wrote', async () => {
      const { cache, target, clock } = await open();
      await cache.put('k', 'v', 60);
      expect(await new StoreCache(both(new FileStore((target as { directory: string }).directory, clock)), '', clock).get('k')).toBe('v');
    });
  }
});
