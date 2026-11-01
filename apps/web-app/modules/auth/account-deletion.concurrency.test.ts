import { EventRegistry } from '@marmeon/core';
import { Connections, sql } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AccountDeleting, AccountDeletion } from './AccountDeletion.ts';
import { UserFactory } from './factories/UserFactory.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from './warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/**
 * Two administrators of one workspace delete themselves at once, each in its own call. The listener of docs/verification.md#unconfirmed-accounts locks
 * all the workspace's memberships of administrators (rows of its own table, which cascade with the account), so the second
 * transaction waits, finds the first one's row gone and refuses. `database: 'isolated'`
 * runs both on real connections; on SQLite there is one writer at a time and the test passes all the same.
 */
describe('two deletions of the last two administrators at once', () => {
  let app: TestApp;
  afterEach(() => app.close());

  it('refuses exactly one', async () => {
    app = await createTestApp(application, { database: 'isolated' });
    const [first, second] = (await Promise.all(['first', 'second'].map((name) => app.factory(UserFactory).create({ email: `${name}@example.com` })))) as User[];
    const connections = app.make(Connections);
    const db = connections.get<any>();
    await sql`create table workspace_administrators (workspace_id integer not null, user_id integer not null references users (id) on delete cascade)`.execute(db);
    try {
      const ids = [first!.id, second!.id];
      for (const id of ids) await sql`insert into workspace_administrators (workspace_id, user_id) values (1, ${id})`.execute(db);
      app.make(EventRegistry).listen(AccountDeleting, async (event: AccountDeleting) => {
        // All the workspace's administrators, locked in the order of their ids — not only the row of the account being deleted.
        const rows = await connections.get<any>().selectFrom('workspace_administrators').select('user_id').where('workspace_id', '=', 1).orderBy('user_id').forUpdate().execute();
        if (rows.length === 1 && rows[0]?.user_id === event.user.id) event.refuse('This account is the last administrator of a workspace.');
      });

      const outcomes = await Promise.all(ids.map((id) => app.make(AccountDeletion).delete([id])));

      expect(outcomes.flatMap((outcome) => outcome.refused)).toHaveLength(1);
      expect(outcomes.flatMap((outcome) => outcome.deleted)).toHaveLength(1);
      await app.assertDatabaseCount('users', 1);
    } finally {
      await sql`drop table workspace_administrators`.execute(db);
    }
  });
});
