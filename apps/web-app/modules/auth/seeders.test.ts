import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { DemoUsersSeeder } from './seeders/DemoUsersSeeder.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

// The web app's seeder (like make:auth's) creates accounts with a known password, so it runs only in development and tests.
// Runs on SQLite and Postgres.

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);
afterEach(() => vi.unstubAllEnvs());

const seed = () => app.make(DemoUsersSeeder).handle({ factory: (definition) => app.factory(definition), db: app.make(Connections).get() });
const users = async () => (await app.make(Connections).get<any>().selectFrom('users').select('email').execute()).map((row: { email: string }) => row.email).sort();

describe('DemoUsersSeeder', { timeout: 30_000 }, () => {
  it('creates the three people under NODE_ENV=test', async () => {
    await seed();
    expect(await users()).toEqual(['ada@example.com', 'alan@example.com', 'grace@example.com']);
  });

  it('refuses outside development and tests, and creates no account', async () => {
    for (const name of ['production', 'staging', '']) {
      vi.stubEnv('NODE_ENV', name);
      await expect(seed(), `NODE_ENV=${name}`).rejects.toThrow(/runs only in development and tests/);
    }
    vi.unstubAllEnvs();
    expect(await users()).toEqual([]);
  });
});
