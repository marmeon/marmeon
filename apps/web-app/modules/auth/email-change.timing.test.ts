import { Limit, RateLimiter } from '@marmeon/cache';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', env: { AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '0' } });
  ({ session: SESSION } = cookieNames(app));
});

type Session = ReturnType<TestApp['withCookie']>;
const signIn = async (user: User): Promise<Session> => {
  const login = await app.post('/login', { form: { email: user.email, password: 'password' } }).assertRedirect('/users/me');
  return app.withCookie(SESSION, login.cookie(SESSION)!);
};
const change = (session: Session, email: string) => session.put('/settings/email', { form: { current_password: 'password', email }, headers: { referer: 'http://localhost/settings/security' } });

describe('the time of a change of address', () => {
  // Runs alone and last (the `timing` project). A leak is a ratio far from 1; the median of paired ratios holds the bounds without a
  // repeat, and `email-change.test.ts` proves the same work for both addresses without a clock.
  it('takes as long for a taken address as for a free one — the request does the same either way (paired)', { timeout: 30_000 /* 176 changes, each a request */ }, async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    app.freeze(); // no sudo window, throttle window or expiry passes while it measures
    // The throttle still counts every change — with room for all of them.
    app.make(RateLimiter).for('auth.email-change', (ctx) => Limit.perMinute(1_000_000).by(String(ctx.user?.id)));
    // A change takes well under a millisecond. So a measurement is a run of four changes, and a pair is two runs of each kind in
    // mirrored order (free, taken, taken, free — the next pair the other way round: no "first of the pair" effect). Twenty-one pairs
    // counted, the first pair warms up; the median of the paired ratios counts — a slow stretch slows both halves of a pair alike, a
    // lone stall moves one ratio, not the median.
    const run = async (kind: 'free' | 'taken', pair: number, n: number) => {
      const started = performance.now();
      for (let k = 0; k < 4; k++) await change(session, kind === 'free' ? `person${pair}.${n}.${k}@example.com` : 'ada@example.com').assertRedirect('/settings/security');
      return performance.now() - started;
    };
    const ratios: number[] = [];
    const took = { free: [] as number[], taken: [] as number[] };
    for (let i = 0; i <= 21; i++) {
      const pair = { free: 0, taken: 0 };
      const order = i % 2 === 0 ? (['free', 'taken', 'taken', 'free'] as const) : (['taken', 'free', 'free', 'taken'] as const);
      for (const [n, kind] of order.entries()) pair[kind] += await run(kind, i, n);
      if (i === 0) continue;
      ratios.push(pair.taken / pair.free);
      took.free.push(pair.free / 8);
      took.taken.push(pair.taken / 8);
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[(values.length - 1) / 2]!;
    const ratio = median(ratios);
    const seen = `median of ${ratios.length} paired ratios ${ratio.toFixed(3)} (a change: median taken ${median(took.taken).toFixed(2)} ms, free ${median(took.free).toFixed(2)} ms)`;
    expect(ratio, seen).toBeGreaterThan(0.75);
    expect(ratio, seen).toBeLessThan(1.33);
  });
});
