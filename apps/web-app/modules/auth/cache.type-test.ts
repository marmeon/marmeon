// Type guarantees of the cache, locks and the test clock — compiled by `pnpm typecheck` / `marmeon build`, never run.
import type { Result } from '@marmeon/core';
import { Cache, Limit, RateLimiter } from '@marmeon/cache';
import type { TestApp } from '@marmeon/testing';

export async function LockCallbacks(cache: Cache) {
  const report: Result<'built', { kind: 'locked' }> = await cache.lock('report', 60).get(() => 'built' as const);
  // @ts-expect-error — get(callback) returns a Result, not the value or `false`
  const old: 'built' | false = await cache.lock('report', 60).get(() => 'built' as const);
  const waited: Result<number, { kind: 'timeout' }> = await cache.lock('report', 60).block(5, async () => 42);
  // @ts-expect-error — block() returns a Result, not the callback's value
  const bare: number = await cache.lock('report', 60).block(5, async () => 42);
  // @ts-expect-error — block() takes a callback; to try once, use get()
  await cache.lock('report', 60).block(5);
  const taken: boolean = await cache.lock('report', 60).get();
  // @ts-expect-error — without a callback, get() says whether it took the lock: a boolean, not the callback's value
  const wrong: string = await cache.lock('report', 60).get();
  // @ts-expect-error — the lock expires after seconds (a number); a forever lock does not exist
  cache.lock('report');
  return { report, old, waited, bare, taken, wrong };
}

export async function AtomicCounting(cache: Cache, limiter: RateLimiter) {
  const count: number = await cache.increment('hits', 1, 60);
  const allowed: boolean = await limiter.attempt('login:ada', { maxAttempts: 5, decay: 60 });
  // @ts-expect-error — the numbers go by name: { maxAttempts: 5, decay: 60 }
  await limiter.attempt('login:ada', 5, 60);
  // @ts-expect-error — a limit needs its window
  await limiter.attempt('login:ada', { maxAttempts: 5 });
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
  app.travel(5); // a number is seconds
  // @ts-expect-error — a string is no span of time: { minutes: 5 }
  app.travel('5m');
  // @ts-expect-error — `minute` is no unit (did you mean `minutes`?)
  app.travel({ minute: 5 });
}
