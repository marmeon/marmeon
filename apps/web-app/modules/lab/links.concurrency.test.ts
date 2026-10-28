import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { LAB_LINK_LIMIT, LabLinks } from './LabLinks.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/**
 * Check, then act: count the links, insert one. On the app's real pool the requests compete, so the test fails when the row lock is
 * taken out of `LabLinks`. Under `database: 'refresh'` they would take turns and it would pass without the lock.
 */
describe('a limit checked before the write, under real contention', () => {
  let app: TestApp;
  afterEach(() => app.close());

  it('holds the limit with the lock', async () => {
    app = await createTestApp(application, { database: 'isolated' });
    const ada = await app.factory(UserFactory).create();
    const labLinks = app.make(LabLinks);
    await Promise.all(Array.from({ length: 5 }, () => labLinks.add(ada.id)));
    expect((await app.make(Connections).get().selectFrom('profile_links').select('id').where('user_id', '=', ada.id).execute()).length).toBe(LAB_LINK_LIMIT);
  });
});
