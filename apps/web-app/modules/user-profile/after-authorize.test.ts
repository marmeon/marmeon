import { UserRepository, type User } from '#modules/auth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

let app: TestApp;
let ada: User, alan: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada, alan] = users as [User, User];
});

describe('what a route shares once every check has passed', () => {
  it("names whose profile a page works on for its owner, and leaves it out of the 403 of somebody else's", async () => {
    await app.actingAs(ada).navigating().get(`/users/${ada.public_id}/edit`).assertOk().assertSee('"profileOwner":{"name":"Ada Lovelace"}');
    const refused = app.actingAs(alan).navigating().get(`/users/${ada.public_id}/edit`).assertForbidden();
    await refused.assertDontSee('profileOwner').assertDontSee('Ada Lovelace');
  });
});
