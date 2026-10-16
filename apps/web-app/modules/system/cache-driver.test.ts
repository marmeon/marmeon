import { Cache } from '@marmeon/cache';
import { createTestApp } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

describe('the app\'s own cache driver', () => {
  it('CACHE_DRIVER=scratch selects it; it keeps entries and holds locks', async () => {
    const app = await createTestApp(application, { env: { CACHE_DRIVER: 'scratch' } });
    const cache = app.make(Cache);
    await cache.put('greeting', 'hello', 60);
    expect(await cache.get('greeting')).toBe('hello');
    expect(await cache.increment('hits', 1, 60)).toBe(1);
    expect(await cache.increment('hits', 1, 60)).toBe(2);
    const lock = cache.lock('report', 30);
    expect(await lock.get()).toBe(true);
    expect(await cache.lock('report', 30).get()).toBe(false);
    expect(await lock.release()).toBe(true);
    await app.close();
  });

  it('decides add and increment atomically when calls overlap', async () => {
    const app = await createTestApp(application, { env: { CACHE_DRIVER: 'scratch' } });
    const cache = app.make(Cache);
    expect((await Promise.all([cache.add('once', 1), cache.add('once', 2)])).sort()).toEqual([false, true]);
    expect((await Promise.all([cache.increment('n', 1, 60), cache.increment('n', 1, 60)])).sort()).toEqual([1, 2]);
    await app.close();
  });

  it('stops the start for a CACHE_DRIVER nobody brought, naming the ones there are', async () => {
    await expect(createTestApp(application, { env: { CACHE_DRIVER: 'scrach' } })).rejects.toThrow(/Known: file, memory, database, redis, scratch\./);
  });
});
