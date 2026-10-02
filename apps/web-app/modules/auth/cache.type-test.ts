// Type guarantees of the cache, locks and the test clock (W6 step 1) — compiled by `pnpm typecheck` / `bespoke build`, never run.
import { Cache, RateLimiter } from '@bespokecore/cache';
import type { TestApp } from '@bespokecore/testing';

export async function LockCallbacks(cache: Cache) {
  const report: 'built' | false = await cache.lock('report', 60).get(() => 'built' as const);
  const waited: number = await cache.lock('report', 60).block(5, async () => 42);
  const taken: boolean = await cache.lock('report', 60).get();
  // @ts-expect-error — without a callback, get() says whether it took the lock: a boolean, not the callback's value
  const wrong: string = await cache.lock('report', 60).get();
  // @ts-expect-error — the lock expires after seconds (a number); a forever lock does not exist
  cache.lock('report');
  return { report, waited, taken, wrong };
}

export async function AtomicCounting(cache: Cache, limiter: RateLimiter) {
  const count: number = await cache.increment('hits', 1, 60);
  const allowed: boolean = await limiter.attempt('login:ada', 5, 60);
  const added: boolean = await cache.add('welcome-sent:7', true, 86_400);
  return { count, allowed, added };
}

export function TravelInTime(app: TestApp) {
  app.travel({ minutes: 5, seconds: 1 });
  app.freeze();
  // @ts-expect-error — a duration names its unit: { seconds: 5 } (a bare number would be ambiguous)
  app.travel(5);
  // @ts-expect-error — `minute` is no unit (did you mean `minutes`?)
  app.travel({ minute: 5 });
}
