// Type guarantees of the cache, locks and the test clock — compiled by `pnpm typecheck` / `marmeon build`, never run.
import type { Result } from '@marmeon/core';
import { Cache, Limit, RateLimiter } from '@marmeon/cache';
import type { TestApp } from '@marmeon/testing';

export async function LockCallbacks(cache: Cache) {
  const report: Result<'built', { kind: 'locked' }> = await cache.lock('report', 60).get(() => 'built' as const);
  // @ts-expect-error — get(callback) returns a Result, not the value or `false`
  const old: 'built' | false = await cache.lock('report', 60).get(() => 'built' as const);
  const waited: number = await cache.lock('report', 60).block(5, async () => 42);
  const taken: boolean = await cache.lock('report', 60).get();
  // @ts-expect-error — without a callback, get() says whether it took the lock: a boolean, not the callback's value
  const wrong: string = await cache.lock('report', 60).get();
  // @ts-expect-error — the lock expires after seconds (a number); a forever lock does not exist
  cache.lock('report');
  return { report, old, waited, taken, wrong };
}

export async function AtomicCounting(cache: Cache, limiter: RateLimiter) {
  const count: number = await cache.increment('hits', 1, 60);
  const allowed: boolean = await limiter.attempt('login:ada', 5, 60);
  const added: boolean = await cache.add('welcome-sent:7', true, 86_400);
  return { count, allowed, added };
}

export function LimiterUser(limiter: RateLimiter) {
  limiter.for('per-user', (ctx) => {
    // The app's user, when authenticate() runs before throttle() — no cast.
    const id: number | undefined = ctx.user?.id;
    // @ts-expect-error — only there when authenticate() ran first: 'ctx.user' is possibly 'undefined'
    const always: number = ctx.user.id;
    // @ts-expect-error — the user type is the app's: 'nickname' does not exist on it
    void ctx.user?.nickname;
    return Limit.perMinute(3).by(String(id ?? always ?? ctx.ip));
  });
}

export function TravelInTime(app: TestApp) {
  app.travel({ minutes: 5, seconds: 1 });
  app.freeze();
  // @ts-expect-error — a duration names its unit: { seconds: 5 } (a bare number would be ambiguous)
  app.travel(5);
  // @ts-expect-error — `minute` is no unit (did you mean `minutes`?)
  app.travel({ minute: 5 });
}
