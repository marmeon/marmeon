import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FileStore, MemoryStore, StoreCache, type CacheStore } from './cache.ts';

const directory = mkdtempSync(join(tmpdir(), 'bespoke-cache-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe.each<[string, () => CacheStore]>([
  ['memory', () => new MemoryStore()],
  ['file', () => new FileStore(mkdtempSync(join(directory, 'store-')))],
])('Cache on the %s store', (_name, store) => {
  it('stores, reads, expires and forgets values', async () => {
    const cache = new StoreCache(store());
    await cache.put('user', { id: 1 });
    await cache.put('short', 'x', -1);
    expect(await cache.get('user')).toEqual({ id: 1 });
    expect(await cache.get('short')).toBeUndefined();
    expect(await cache.has('missing')).toBe(false);
    await cache.forget('user');
    expect(await cache.get('user')).toBeUndefined();
  });

  it('adds only absent keys and remembers computed values', async () => {
    const cache = new StoreCache(store());
    expect(await cache.add('lock', 1, 60)).toBe(true);
    expect(await cache.add('lock', 2, 60)).toBe(false);
    const compute = vi.fn(() => 42);
    expect(await cache.remember('answer', 60, compute)).toBe(42);
    expect(await cache.remember('answer', 60, compute)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('increments within one window — a hit does not restart the expiry', async () => {
    const cache = new StoreCache(store());
    expect(await cache.increment('hits', 1, 60)).toBe(1);
    expect(await cache.increment('hits', 2, 3600)).toBe(3);
    expect(await cache.ttl('hits')).toBeLessThanOrEqual(60);
    expect(await cache.ttl('hits')).toBeGreaterThan(55);
  });

  it('keeps apps sharing a store apart with a prefix, and flushes', async () => {
    const shared = store();
    await new StoreCache(shared, 'a:').put('k', 'from a');
    expect(await new StoreCache(shared, 'b:').get('k')).toBeUndefined();
    await new StoreCache(shared).flush();
    expect(await new StoreCache(shared, 'a:').get('k')).toBeUndefined();
  });
});

describe('FileStore', () => {
  it('survives a restart and leaves no temporary files', async () => {
    const dir = mkdtempSync(join(directory, 'restart-'));
    await new StoreCache(new FileStore(dir)).put('k', 'v', 60);
    expect(await new StoreCache(new FileStore(dir)).get('k')).toBe('v');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir)[0]).toMatch(/^[0-9a-f]{64}$/); // keys are hashed: any key is a safe file name
  });
});
