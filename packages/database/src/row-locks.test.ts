import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshConnections } from './__fixtures__/databases.ts';
import { Repository, type Connections } from './index.ts';

interface Tables {
  seats: { id: Generated<number>; free: number };
}

class SeatRepository extends Repository<'seats', Tables> {
  static table = 'seats' as const;

  lockAll() {
    return this.query().select('id').forUpdate().execute();
  }

  lockViaDb() {
    return this.db.selectFrom('seats').select('id').forUpdate().execute();
  }

  /** Reads the free seats under the lock, waits for the other transaction to get in line, then writes one less. */
  async take() {
    return this.transaction(async (seats) => {
      const row = await seats.query().select('free').where('id', '=', 1).forUpdate().executeTakeFirstOrThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await seats.db.updateTable('seats').set({ free: row.free - 1 }).where('id', '=', 1).execute();
    });
  }
}

// One query for both drivers: Postgres locks the rows, SQLite leaves the clause out (its transaction holds the only write lock).
describe.each([
  ['sqlite', true],
  ['pgsql', process.env.MARMEON_TEST_PGSQL_URL !== undefined],
] as const)('row locks — on %s', (driver, available) => {
  describe.runIf(available)('queries', () => {
    let connections: Connections;
    let close: () => Promise<void>;
    let seats: SeatRepository;

    beforeAll(async () => {
      ({ connections, close } = await freshConnections(driver, { managed: false }));
      await sql`create table seats (id integer primary key, free integer not null)`.execute(connections.get());
      await sql`insert into seats (id, free) values (1, 10)`.execute(connections.get());
      seats = new SeatRepository(connections);
    });
    afterAll(() => close());

    const sqlOf = (clause: 'forUpdate' | 'forShare' | 'forNoKeyUpdate' | 'forKeyShare') =>
      (connections.get<Tables>().selectFrom('seats').select('id') as any)[clause]().compile().sql as string;

    it('compiles the lock clause on Postgres only', () => {
      const compiled = [sqlOf('forUpdate'), sqlOf('forShare'), sqlOf('forNoKeyUpdate'), sqlOf('forKeyShare')];
      for (const text of compiled) expect(/ for (?:no key )?(?:update|share|key share)/.test(text)).toBe(driver === 'pgsql');
      const modifiers = connections.get<Tables>().selectFrom('seats').select('id').forUpdate().skipLocked().compile().sql;
      expect(modifiers.endsWith(driver === 'pgsql' ? 'for update skip locked' : 'from "seats"')).toBe(true);
    });

    it('runs through Repository.query(), the repository connection and connections.get()', async () => {
      expect(await seats.lockAll()).toEqual([{ id: 1 }]);
      expect(await seats.lockViaDb()).toEqual([{ id: 1 }]);
      expect(await connections.get<Tables>().selectFrom('seats').select('id').forUpdate().execute()).toEqual([{ id: 1 }]);
      expect(await connections.get<Tables>().selectFrom('seats').select('id').forUpdate().skipLocked().execute()).toEqual([{ id: 1 }]);
    });

    it('runs inside a transaction and in a subquery', async () => {
      await connections.transaction(async () => {
        const rows = await connections
          .get<Tables>()
          .selectFrom('seats')
          .select('id')
          .where('id', 'in', (eb) => eb.selectFrom('seats').select('id').forUpdate())
          .forUpdate()
          .execute();
        expect(rows).toEqual([{ id: 1 }]);
      });
    });

    // On SQLite the driver's own lock already serializes the transactions: this proves the lock on Postgres and that the stripped query
    // leaves SQLite's result right, the compile and run-through cases above are what fail without the compiler.
    it('serializes two transactions that read with forUpdate() and then write', async () => {
      await Promise.all([seats.take(), seats.take(), seats.take()]);
      const row = await connections.get<Tables>().selectFrom('seats').select('free').where('id', '=', 1).executeTakeFirstOrThrow();
      expect(row.free).toBe(7);
    });
  });
});
