import { TestClock } from '@marmeon/core/testing';
import { describe, expect, it } from 'vitest';
import { MemoryStore } from './memory.ts';

describe('the memory store, writing', () => {
  it('drops expired entries of keys nobody reads again, without a prune', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    for (let i = 0; i < 1000; i++) await store.write(`ip:${i}`, { value: 1, expires: clock.now() + 1000 });
    clock.travel({ seconds: 2 });
    // Each write carries the sweep on by a bounded batch, so a few hundred cover the 1000 old keys.
    for (let i = 0; i < 1000; i++) await store.write(`fresh:${i}`, { value: 1, expires: clock.now() + 60_000 });
    expect(await store.prune()).toBe(0);
  });

  it('keeps entries that are still valid, and those without an expiry', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    await store.write('forever', { value: 'a', expires: null });
    await store.write('later', { value: 'b', expires: clock.now() + 60_000 });
    for (let i = 0; i < 500; i++) await store.write(`short:${i}`, { value: i, expires: clock.now() + 1000 });
    clock.travel({ seconds: 2 });
    for (let i = 0; i < 2000; i++) await store.write(`more:${i}`, { value: i, expires: clock.now() + 60_000 });
    expect(await store.read('forever')).toEqual({ value: 'a', expires: null });
    expect((await store.read('later'))?.value).toBe('b');
    expect(await store.read('more:1999')).toBeDefined();
  });

  it('drops expired locks nobody asks about again', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    for (let i = 0; i < 100; i++) await store.lock(`lock:${i}`, 'me', clock.now() + 1000);
    clock.travel({ seconds: 2 });
    for (let i = 0; i < 1000; i++) await store.lock(`fresh:${i}`, 'me', clock.now() + 60_000);
    expect(await store.prune()).toBe(0);
  });

  it('starts a sweep afresh after clear', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    for (let i = 0; i < 1000; i++) await store.write(`old:${i}`, { value: 1, expires: clock.now() + 1000 });
    for (let i = 0; i < 40; i++) await store.write(`more:${i}`, { value: 1, expires: clock.now() + 1000 });
    await store.clear();
    clock.travel({ seconds: 2 });
    for (let i = 0; i < 1000; i++) await store.write(`new:${i}`, { value: 1, expires: clock.now() + 60_000 });
    expect(await store.prune()).toBe(0);
    expect(await store.read('new:999')).toBeDefined();
  });

  it('keeps a counter and its expiry while other keys expire and are swept', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    const expires = clock.now() + 10_000;
    await store.increment('hits', 1, expires);
    for (let i = 0; i < 500; i++) await store.write(`short:${i}`, { value: i, expires: clock.now() + 1000 });
    clock.travel({ seconds: 2 });
    for (let i = 0; i < 500; i++) {
      await store.write(`fresh:${i}`, { value: i, expires: clock.now() + 60_000 });
      expect(await store.increment('hits', 1, expires)).toBe(i + 2);
    }
    expect((await store.read('hits'))?.expires).toBe(expires);
  });

  it('keeps increment atomic while sweeping', async () => {
    const clock = new TestClock();
    const store = new MemoryStore(clock);
    const results = await Promise.all(Array.from({ length: 500 }, () => store.increment('hits', 1, clock.now() + 60_000)));
    expect(results.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  });
});
