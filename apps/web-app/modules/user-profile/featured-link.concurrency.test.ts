import { Connections, sql } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';
import { ProfileLinkRepository } from './ProfileLinkRepository.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

/**
 * Locks a row in a transaction of its own and keeps it until the returned function is called. That function runs `whileHeld`
 * inside the transaction, then ends it (`docs/database-testing.md#make-the-overlap-certain`). `for no key update` makes the
 * `for update` of the code under test wait.
 */
export async function holdRow(
  connections: Connections,
  table: string,
  id: string,
  whileHeld?: () => Promise<void>,
): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let locked!: () => void;
  const hasLock = new Promise<void>((resolve) => (locked = resolve));
  const holder = connections.transaction(async () => {
    await sql`select id from ${sql.table(table)} where id = ${id} for no key update`.execute(connections.get());
    locked();
    await gate;
    await whileHeld?.();
  });
  await Promise.race([hasLock, holder]);
  return async () => {
    release();
    await holder;
  };
}

/** Passes once a backend of the test database waits in a `for update` read, and fails after five seconds. */
export async function untilSomeoneWaits(connections: Connections): Promise<void> {
  await vi.waitFor(
    async () => {
      const { rows } = await sql<{ waiting: number }>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query ilike '%for update%'
      `.execute(connections.get());
      expect(rows[0]?.waiting).toBe(1);
    },
    { timeout: 5000 },
  );
}

/**
 * Featuring keeps a link's version (`updated_at`, what a rename compares). It reads the version under the row lock: a rename that
 * commits while the write waits for the row must not be set back to the version the write started from. Without the lock the
 * write reads the old version, waits on the update, and writes it back after the rename.
 */
describe.skipIf(process.env.DB_DRIVER !== 'pgsql')('the version of a link while it is featured or unfeatured, under real contention', () => {
  let app: TestApp;
  afterEach(() => app.close());

  for (const name of ['unfeature', 'feature'] as const) {
    it(`${name}() keeps the version a rename committed while it waited for the row`, async () => {
      app = await createTestApp(application, { database: 'isolated' });
      const connections = app.make(Connections);
      const links = app.make(ProfileLinkRepository);
      const ada = await app.factory(UserFactory).create();
      const link = await links.insert({ user_id: ada.id, label: 'Before', url: 'https://example.com', featured: name === 'unfeature' });
      const renamedAt = new Date(new Date(link.updated_at).getTime() + 60_000);

      const release = await holdRow(connections, 'profile_links', link.id, async () => {
        await connections.get().updateTable('profile_links').set({ label: 'Renamed', updated_at: renamedAt.toISOString() }).where('id', '=', link.id).execute();
      });
      const change = name === 'unfeature' ? links.unfeature(link.id) : links.feature(link);
      try {
        await untilSomeoneWaits(connections);
      } finally {
        await release();
      }

      expect((await change).ok).toBe(true);
      const after = (await links.find(link.id))!;
      expect(after).toMatchObject({ label: 'Renamed', featured: name === 'feature' });
      expect(new Date(after.updated_at).getTime()).toBe(renamedAt.getTime());
    });
  }
});
