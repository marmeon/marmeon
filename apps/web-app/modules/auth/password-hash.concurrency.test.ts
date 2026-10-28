import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from './warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/**
 * A conditional write under real contention: `database: 'isolated'` runs the app on its pool, so two writers that expect the same
 * stored hash compete for the row. The condition is one statement and decides by itself, so this test also turns red without it
 * under `'refresh'`; what `'refresh'` hides is a check over several statements (see `modules/lab/links.concurrency.test.ts`).
 */
describe('writing a password hash only over the hash that was read', () => {
  let app: TestApp;
  afterEach(() => app.close());

  it('lets exactly one of two writers that expect the same hash win', async () => {
    app = await createTestApp(application, { database: 'isolated' });
    const ada = await app.factory(UserFactory).create({ session_key: null });
    const users = app.make(UserRepository);
    const read = (await users.findForSignIn(ada.email))!.passwordHash!;

    const wrote = await Promise.all(['from the phone', 'from the laptop'].map((name) => users.updatePasswordHash(ada.id, name as never, { expected: read })));

    expect(wrote.filter(Boolean)).toHaveLength(1);
    expect((await users.findForSignIn(ada.email))!.passwordHash).toBe(wrote[0] ? 'from the phone' : 'from the laptop');
  });
});
