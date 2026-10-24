import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('the time of a registration', () => {
  const register = (form: Record<string, string>) =>
    app.post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse', password_confirmation: 'correct horse', ...form }, headers: { referer: 'http://localhost/register' } });

  // Runs alone and last (the `timing` project). A leak is a ratio far from 1; the median of paired ratios holds the bounds without a
  // repeat. The hashing itself is counted in `hashing.test.ts` of @marmeon/auth.
  it('takes as long for a known address as for a new one — the password is hashed either way (the configured costs)', { timeout: 120_000 /* 352 sign-ups at the configured hash costs: seconds of real hashing */ }, async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { HASH_ARGON_MEMORY: '19456', HASH_ARGON_TIME: '2' } });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    // A measurement is a run of four sign-ups of one kind, and a pair is two runs of each kind in mirrored order (new, known, known,
    // new — the next pair the other way round: no "first of the pair" effect), as for the change of address: a lone sign-up's
    // time swings with the machine's load. Twenty-one pairs counted, the first warms up; the median of the paired ratios counts —
    // a slow stretch slows both halves of a pair alike, a lone stall moves one ratio, not the median. A minute passes before
    // every run (the throttle allows ten sign-ups a minute from one address); the bound stays.
    const run = async (kind: 'fresh' | 'known', pair: number, n: number) => {
      app.travel({ seconds: 61 });
      const started = performance.now();
      for (let k = 0; k < 4; k++) await register({ email: kind === 'fresh' ? `person${pair}.${n}.${k}@example.com` : 'ada@example.com' }).assertRedirect('/register/sent');
      return performance.now() - started;
    };
    const ratios: number[] = [];
    const took = { fresh: [] as number[], known: [] as number[] };
    for (let i = 0; i <= 21; i++) {
      const pair = { fresh: 0, known: 0 };
      const order = i % 2 === 0 ? (['fresh', 'known', 'known', 'fresh'] as const) : (['known', 'fresh', 'fresh', 'known'] as const);
      for (const [n, kind] of order.entries()) pair[kind] += await run(kind, i, n);
      if (i === 0) continue;
      ratios.push(pair.known / pair.fresh);
      took.fresh.push(pair.fresh / 8);
      took.known.push(pair.known / 8);
    }
    const median = (values: number[]) => values.toSorted((a, b) => a - b)[(values.length - 1) / 2]!;
    const ratio = median(ratios);
    const seen = `median of ${ratios.length} paired ratios ${ratio.toFixed(3)} (a sign-up: median known ${median(took.known).toFixed(1)} ms, new ${median(took.fresh).toFixed(1)} ms)`;
    expect(ratio, seen).toBeGreaterThan(0.75);
    expect(ratio, seen).toBeLessThan(1.33);
  });
});
