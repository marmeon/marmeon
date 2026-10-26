// One of two processes racing on a shared store (`atomic.test.ts`). Opens the store named by argv[2] (a JSON
// StoreTarget), says "ready", waits for "go" on stdin, then fires argv[4] operations of kind argv[3] at once and prints
// how many succeeded. Run with `node --conditions=@marmeon/source`.
import { createInterface } from 'node:readline';
import { SystemClock } from '@marmeon/core';
import { StoreCache } from '../cache.ts';
import { RateLimiter } from '../rate-limiter.ts';
import { openStore, type StoreTarget } from './stores.ts';

const [targetJson, operation, countText, key] = process.argv.slice(2);
const target = JSON.parse(targetJson!) as StoreTarget;
const count = Number(countText);
const { store, close } = openStore(target, new SystemClock());
const cache = new StoreCache({ store, locks: store });
const limiter = new RateLimiter(cache);

// Warm up (connection, client import) on another key, so the race starts with everything open.
await cache.put(`warm-up:${process.pid}`, 1, 60);
process.stdout.write('ready\n');
for await (const line of createInterface({ input: process.stdin })) if (line === 'go') break;

const results = await Promise.all(
  Array.from({ length: count }, () => (operation === 'hit' ? limiter.attempt(key!, { maxAttempts: 10, decay: 60 }) : cache.add(key!, process.pid, 60))),
);
process.stdout.write(`${results.filter(Boolean).length}\n`);
await close();
