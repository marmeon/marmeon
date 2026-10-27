import { afterCommit, afterRollback, ok, TransactionError } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
import type { Connections } from './connections.ts';
import { isServerError } from './driver.ts';
import { Repository } from './index.ts';

class NoteRepository extends Repository<'notes', any> {
  static table = 'notes' as const;
}

/**
 * On Postgres a failed statement aborts the transaction (or savepoint) it ran in: every later statement fails, and COMMIT answers with a
 * ROLLBACK tag instead of an error. A callback that catches such a failure itself, not through a nested transaction, must not end in a
 * transaction() that reports a commit.
 */
describe.each(drivers)('a statement that fails inside a transaction and is caught there, on %s', (driver) => {
  const pgsql = driver === 'pgsql';
  let connections: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver, { managed: false }));
    await sql`create table notes (id integer primary key, label text not null)`.execute(connections.get());
  });

  afterAll(async () => {
    await close();
  });

  const labels = async (): Promise<string[]> => {
    const { rows } = await sql<{ label: string }>`select label from notes order by id`.execute(connections.get());
    return rows.map((row) => row.label);
  };

  const reset = async (): Promise<void> => {
    await sql`delete from notes`.execute(connections.get());
  };

  const settle = (work: Promise<unknown>) =>
    work.then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

  /** Inserts a row that is taken, catching the failure — the pattern that must not report a commit. */
  const duplicate = async (id: number): Promise<string | undefined> => {
    try {
      await sql`insert into notes values (${id}, 'duplicate')`.execute(connections.get());
    } catch (error) {
      return (error as { code?: string }).code;
    }
    return undefined;
  };

  it.runIf(pgsql)('outermost: the transaction rejects with D24, rolls back, and runs no after-commit work', async () => {
    await reset();
    await sql`insert into notes values (1, 'existing')`.execute(connections.get());
    const ran: string[] = [];
    let caught: string | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into notes values (2, 'before the failure')`.execute(connections.get());
        await afterCommit(() => void ran.push('commit'));
        await afterRollback(() => void ran.push('rollback'));
        caught = await duplicate(1);
        return ok('done');
      }),
    );
    expect(caught).toBe('23505');
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain('D24');
    expect(ran).toEqual(['rollback']);
    expect(await labels()).toEqual(['existing']);
  });

  it.runIf(pgsql)('savepoint: the inner transaction rejects, and the one around it keeps its writes and commits', async () => {
    await reset();
    const ran: string[] = [];
    let caught: string | undefined;
    let nested: Awaited<ReturnType<typeof settle>> | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into notes values (10, 'outer before')`.execute(connections.get());
        await afterCommit(() => void ran.push('commit'));
        nested = await settle(
          connections.transaction(async () => {
            await sql`insert into notes values (11, 'inner')`.execute(connections.get());
            caught = await duplicate(10);
            return ok('inner done');
          }),
        );
        await sql`insert into notes values (12, 'outer after')`.execute(connections.get());
        return ok('outer done');
      }),
    );
    expect(caught).toBe('23505');
    expect(nested?.resolved).toBe(false);
    expect(nested?.error).toBeInstanceOf(TransactionError);
    expect(outcome.resolved).toBe(true);
    expect(ran).toEqual(['commit']);
    expect(await labels()).toEqual(['outer before', 'outer after']);
  });

  it.runIf(pgsql)('three levels: only the innermost is undone', async () => {
    await reset();
    await connections.transaction(async () => {
      await sql`insert into notes values (20, 'outermost')`.execute(connections.get());
      const middle = await settle(
        connections.transaction(async () => {
          await sql`insert into notes values (21, 'middle before')`.execute(connections.get());
          const inner = await settle(
            connections.transaction(async () => {
              await sql`insert into notes values (22, 'inner')`.execute(connections.get());
              await duplicate(20);
              return ok('inner');
            }),
          );
          expect(inner.resolved).toBe(false);
          await sql`insert into notes values (23, 'middle after')`.execute(connections.get());
          return ok('middle');
        }),
      );
      expect(middle.resolved).toBe(true);
      return ok('outermost');
    });
    expect(await labels()).toEqual(['outermost', 'middle before', 'middle after']);
  });

  it.runIf(pgsql)('a failure that is not caught rolls back as before, and the connection is usable afterwards', async () => {
    await reset();
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into notes values (30, 'lost')`.execute(connections.get());
        await sql`insert into notes values (30, 'duplicate')`.execute(connections.get());
        return ok('never');
      }),
    );
    expect((outcome.error as { code?: string }).code).toBe('23505');
    await connections.transaction(async () => {
      await sql`insert into notes values (31, 'next')`.execute(connections.get());
      return ok('next');
    });
    expect(await labels()).toEqual(['next']);
  });

  it.runIf(pgsql)('isolated: the same holds, and the isolation stays intact', async () => {
    await reset();
    const isolation = await connections.isolate();
    let rolledBack = false;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into notes values (50, 'in the test')`.execute(connections.get());
        await afterRollback(() => void (rolledBack = true));
        await duplicate(50);
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect(rolledBack).toBe(true);
    await connections.transaction(async () => {
      await sql`insert into notes values (51, 'after')`.execute(connections.get());
      const inner = await settle(
        connections.transaction(async () => {
          await duplicate(51);
          return ok('inner');
        }),
      );
      expect(inner.resolved).toBe(false);
      return ok('outer');
    });
    expect(await labels()).toEqual(['after']);
    await isolation.rollback();
    expect(await labels()).toEqual([]);
  });

  it('tryInsert() on a taken value inside a transaction gives a duplicate err, and the transaction commits', async () => {
    await reset();
    const notes = new NoteRepository(connections);
    await notes.insert({ id: 60, label: 'taken' });
    await connections.transaction(async () => {
      expect(await notes.tryInsert({ id: 60, label: 'again' })).toEqual({ ok: false, error: { kind: 'duplicate' } });
      expect((await notes.tryInsert({ id: 61, label: 'fresh' })).ok).toBe(true);
      return ok('done');
    });
    expect(await labels()).toEqual(['taken', 'fresh']);
  });

  it('tryInsert() on a repository bound with using(trx) gives a duplicate err, and the transaction commits', async () => {
    await reset();
    const notes = new NoteRepository(connections);
    await notes.insert({ id: 70, label: 'taken' });
    await connections.get().transaction().execute(async (trx) => {
      const bound = notes.using(trx);
      expect(await bound.tryInsert({ id: 70, label: 'again' })).toEqual({ ok: false, error: { kind: 'duplicate' } });
      await bound.insert({ id: 71, label: 'fresh' });
    });
    expect(await labels()).toEqual(['taken', 'fresh']);
  });

  it('a savepoint of your own that you roll back after a caught error leaves the transaction committable', async () => {
    await reset();
    await sql`insert into notes values (80, 'taken')`.execute(connections.get());
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`savepoint mine`.execute(connections.get());
        expect(await duplicate(80)).not.toBeUndefined();
        await sql`rollback to savepoint mine`.execute(connections.get());
        await sql`insert into notes values (81, 'after')`.execute(connections.get());
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(true);
    expect(await labels()).toEqual(['taken', 'after']);
  });

  it('a commit that fails (a deferred constraint) rejects with its own error and leaves the connection usable', async () => {
    await sql`create table if not exists parents (id integer primary key)`.execute(connections.get());
    await sql`create table if not exists children (id integer primary key, parent integer references parents (id) deferrable initially deferred)`.execute(connections.get());
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into children values (1, 999)`.execute(connections.get());
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(false);
    expect((outcome.error as Error).message).not.toContain('No transaction is open');
    expect((outcome.error as Error).message).toMatch(/foreign key/i);
    await connections.transaction(async () => {
      await sql`insert into parents values (1)`.execute(connections.get());
      await sql`insert into children values (2, 1)`.execute(connections.get());
      return ok('next');
    });
    const { rows } = await sql<{ id: number }>`select id from children order by id`.execute(connections.get());
    expect(rows.map((row) => row.id)).toEqual([2]);
  });

  it.runIf(pgsql)('only an error from the server taints a transaction: a client-side failure with a code that looks alike does not', () => {
    const server = Object.assign(new Error('duplicate'), { code: '23505', severity: 'ERROR' });
    expect(isServerError(server)).toBe(true);
    expect(isServerError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).toBe(false);
    expect(isServerError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(false);
    expect(isServerError(undefined)).toBe(false);
  });

  it.runIf(!pgsql)('SQLite: a failure caught inside a transaction leaves the other rows committed', async () => {
    await reset();
    await sql`insert into notes values (1, 'existing')`.execute(connections.get());
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into notes values (2, 'before the failure')`.execute(connections.get());
        await duplicate(1);
        await sql`insert into notes values (3, 'after the failure')`.execute(connections.get());
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(true);
    expect(await labels()).toEqual(['existing', 'before the failure', 'after the failure']);
  });
});
