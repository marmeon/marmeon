import { Connections } from '@marmeon/database';
import { RedisConnections } from '@marmeon/redis';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// The first test would pay for the worker's database, the app's modules and the first password hash inside its 5 s.
beforeAll(warmUp, WARM_UP_TIMEOUT);

/** Redis runs when `MARMEON_TEST_REDIS_URL` is set (`pnpm test:redis`). */
const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

// The app's rate limits run on the store CACHE_DRIVER names — in production `database` (this app, see .env.example) or
// `redis`; the other tests use `memory` (.env.test). Here they run on the real stores, with requests sent at once:
// counting and deciding is one atomic step of the store, so no burst gets past a limit.
type Driver = ['database' | 'redis', () => Record<string, string>];
const drivers: Driver[] = [['database', () => ({})]];
if (REDIS_URL) drivers.push(['redis', () => ({ REDIS_URL, REDIS_PREFIX: `web-app-test-${crypto.randomUUID().slice(0, 8)}:` })]);

describe.each(drivers)('rate limits on the %s store', (driver, redisEnv) => {
  let app: TestApp;
  const open = async () => {
    app = await createTestApp(application, { database: 'refresh', env: { CACHE_DRIVER: driver, ...redisEnv() } });
    return app;
  };
  afterEach(async () => {
    if (driver !== 'redis' || !app) return;
    const redis = app.make(RedisConnections).get();
    const keys = await redis.command<string[]>(['KEYS', `${redis.prefix}*`]);
    if (keys.length > 0) await redis.command(['DEL', ...keys]);
  });

  it('lets exactly five of twenty wrong passwords sent at once be checked — the rest are throttled', async () => {
    const app = await open();
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.expectingJson().post('/login', { json: { email: ada.email, password: 'wrong' } })),
    );
    const messages = responses.map((response) => (response.json() as { errors: { email: string[] } }).errors.email[0]!);
    expect(messages.filter((message) => message === 'These credentials do not match our records.')).toHaveLength(5);
    expect(messages.filter((message) => message.startsWith('Too many login attempts'))).toHaveLength(15);
    // Even the right password waits now.
    await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertGuest();
    if (driver === 'database') {
      // The key of the minute holds an HMAC of the address, never the address; this one counted all twenty (plus the right password).
      const rows = await app.make(Connections).get<any>().selectFrom('cache').select(['key', 'value']).execute();
      const minute = rows.filter((row: { key: string }) => row.key.startsWith('limiter:login:'));
      expect(minute.map((row: { value: string }) => row.value)).toEqual(['21']);
      expect(JSON.stringify(rows)).not.toContain('ada@example.com');
    }
  });

  it('holds live validations to 30 a minute per address and route — 40 checks at once, 10 refused', async () => {
    const app = await open();
    const responses = await Promise.all(
      Array.from({ length: 40 }, () => app.validating('email').post('/register', { json: { name: 'Ada', email: 'ada@example.com' } })),
    );
    expect(responses.filter((response) => response.status === 429)).toHaveLength(10);
  });
});
