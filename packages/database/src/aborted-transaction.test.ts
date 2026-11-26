import { afterCommit, afterRollback, ok, TransactionError } from '@marmeon/core';
import { AbortedTransactionError, isAbortedTransactionError, sql, type Kysely, type Transaction as KyselyTransaction } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { drivers, freshConnections, freshDatabase, PGSQL_URL, silent } from './__fixtures__/databases.ts';
import { Connections } from './connections.ts';
import { isServerError, LATE_FAILURE, releasedOpen, UNCLOSED_LEVEL } from './driver.ts';
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
      expect(await notes.tryInsert({ id: 60, label: 'again' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['id'] } });
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
      expect(await bound.tryInsert({ id: 70, label: 'again' })).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['id'] } });
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

/**
 * A statement started inside the callback that fails after the callback returned: the commit of the outermost transaction is answered
 * with a rollback (Kysely skips its own rollback then), the `release` of a savepoint meets the aborted transaction. Either way the
 * app gets D24, nothing of the transaction is committed, and the one pooled connection starts the next transaction cleanly.
 */
type Executor = Kysely<any> | KyselyTransaction<any>;

// Each test waits for a statement that sleeps for 3 s.
describe.runIf(PGSQL_URL !== undefined)('a statement that fails after the callback returned, on pgsql', { timeout: 30_000 }, () => {
  let connections: Connections;
  let monitor: Connections;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    const fresh = await freshDatabase('pgsql', { managed: false });
    drop = fresh.drop;
    const single = { ...fresh.options, poolMax: 1 } as typeof fresh.options;
    connections = new Connections({ connections: { default: single, other: single }, root: '/', logger: silent });
    // A connection of its own: the one of `connections` is busy with the statement it watches.
    monitor = new Connections({ connections: { default: fresh.options }, root: '/', logger: silent });
    // Connected before the first poll: opening it must not take longer than the statement it watches runs.
    await sql`select 1`.execute(monitor.get());
    await sql`select 1`.execute(connections.get());
  });

  afterAll(async () => {
    await connections.destroy();
    await monitor.destroy();
    await drop();
  });

  const settle = (work: Promise<unknown>) =>
    work.then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );

  /**
   * Starts a statement that sleeps and then fails, and returns once the server runs it — so the callback ends while it is in flight.
   * The statement's own promise is not awaited by the caller; it settles with the failure after the transaction asked to commit.
   */
  const startFailingLater = async (on: Executor = connections.get(), fails = true): Promise<{ settled: Promise<string> }> => {
    const marker = `late_${crypto.randomUUID().replaceAll('-', '')}`;
    const query = fails
      ? sql`select pg_sleep(3)::text || (1 / (0 * random()::int))::text as ${sql.id(marker)}`
      : sql`select pg_sleep(1)::text as ${sql.id(marker)}`;
    const statement = query.execute(on).then(
      () => 'resolved',
      () => 'failed later',
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where state = 'active' and pid <> pg_backend_pid() and query like ${`%${marker}%`}`.execute(monitor.get());
      if (rows[0]!.n > 0) return { settled: statement };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The statement never showed up as active on the server.');
  };

  const nextTransactionsBegin = async () => {
    for (let i = 0; i < 3; i++) {
      const value = await connections.transaction(async () => ok((await sql<{ one: number }>`select 1 as one`.execute(connections.get())).rows[0]!.one));
      expect(value).toMatchObject({ ok: true, value: 1 });
    }
  };

  it('transaction(): rejects with D24 and a cause, runs no after-commit work, and the connection begins the next transaction', async () => {
    const ran: string[] = [];
    let later: { settled: Promise<string> } | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await afterCommit(() => void ran.push('commit'));
        await afterRollback(() => void ran.push('rollback'));
        later = await startFailingLater();
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain(LATE_FAILURE);
    expect((outcome.error as Error).message).toContain('D24');
    expect(isAbortedTransactionError((outcome.error as Error).cause)).toBe(true);
    expect(ran).toEqual(['rollback']);
    expect(await later?.settled).toBe('failed later');
    await nextTransactionsBegin();
  });

  it('nested transaction(): the savepoint rejects with D24 and a cause, and the outer transaction and the connection stay usable', async () => {
    await sql`create table if not exists late_notes (id integer primary key)`.execute(connections.get());
    await sql`delete from late_notes`.execute(connections.get());
    const ran: string[] = [];
    let nested: Awaited<ReturnType<typeof settle>> | undefined;
    let later: { settled: Promise<string> } | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into late_notes values (1)`.execute(connections.get());
        nested = await settle(
          connections.transaction(async () => {
            await afterCommit(() => void ran.push('inner commit'));
            await sql`insert into late_notes values (2)`.execute(connections.get());
            later = await startFailingLater();
            return ok('inner done');
          }),
        );
        await sql`insert into late_notes values (3)`.execute(connections.get());
        return ok('outer done');
      }),
    );
    expect(nested?.resolved).toBe(false);
    const rejection = nested?.error as Error;
    expect(rejection).toBeInstanceOf(TransactionError);
    expect(rejection.message).toContain(LATE_FAILURE);
    expect(rejection.message).toContain('D24');
    expect(isServerError(rejection.cause)).toBe(true);
    expect((rejection.cause as { code?: string }).code).toBe('25P02');
    expect(ran).toEqual([]);
    expect(await later?.settled).toBe('failed later');
    expect(outcome.resolved).toBe(true);
    const { rows } = await sql<{ id: number }>`select id from late_notes order by id`.execute(connections.get());
    expect(rows.map((row) => row.id)).toEqual([1, 3]);
    await nextTransactionsBegin();
  });

  it('an aborted commit that escapes from a transaction of another connection leaves no connection open, and the next request commits for real', async () => {
    await sql`create table if not exists probe_notes (id integer primary key)`.execute(connections.get());
    await sql`delete from probe_notes`.execute(connections.get());
    let later: { settled: Promise<string> } | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into probe_notes values (1)`.execute(connections.get());
        await connections.get('other').transaction().execute(async (trx) => {
          later = await startFailingLater(trx);
        });
        return ok('done');
      }),
    );
    expect(await later?.settled).toBe('failed later');
    // The danger first: a connection left in its transaction, and the next request joining it.
    const open = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`.execute(monitor.get());
    expect(open.rows[0]!.n).toBe(0);
    await connections.transaction(async () => ok(await sql`insert into probe_notes values (2)`.execute(connections.get())));
    const { rows } = await sql<{ id: number }>`select id from probe_notes order by id`.execute(monitor.get());
    expect(rows.map((row) => row.id)).toEqual([2]);
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain(LATE_FAILURE);
  });

  it('startTransaction(): commit() throws D24 for a statement that is still running, rollback() then resolves, and the connection begins the next transaction', async () => {
    const trx = await connections.get().startTransaction().execute();
    const later = await startFailingLater(trx);
    // commit() waits for the pending statement, which fails first and taints the transaction: the driver refuses the commit
    // (the message of a failure seen before the commit) without sending it. Postgres is never asked, so there is no rollback answer here.
    const outcome = await settle(trx.commit().execute());
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain('D24');
    expect(await later.settled).toBe('failed later');
    await expect(trx.rollback().execute()).resolves.toBeUndefined();
    await nextTransactionsBegin();
  });

  const idleInTransaction = async () => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%'`.execute(monitor.get());
    return rows[0]!.n;
  };
  const committedIds = async (table: 'marker_notes') => {
    const { rows } = await sql<{ id: number }>`select id from ${sql.table(table)} order by id`.execute(monitor.get());
    return rows.map((row) => row.id);
  };

  const holdingTest = (completed: boolean) => async () => {
    await sql`create table if not exists marker_notes (id integer primary key)`.execute(connections.get());
    await sql`delete from marker_notes`.execute(connections.get());
    const ran: string[] = [];
    const failure = new Error('the callback failed');
    let letGo!: () => void;
    const gate = new Promise<void>((resolve) => (letGo = resolve));
    let holding: Promise<void> | undefined;
    try {
      const outcome = await settle(
        connections.transaction(async () => {
          await afterCommit(() => void ran.push('commit'));
          await afterRollback(() => void ran.push('rollback'));
          await sql`insert into marker_notes values (1)`.execute(connections.get());
          try {
            await connections.get().transaction().execute(async () => {
              throw new AbortedTransactionError();
            });
          } catch {
            // the caller handles it and goes on
          }
          // A holder of the connection that outlives the callback, and with it the release that would end the transaction.
          const started = Promise.withResolvers<void>();
          holding = connections.get().connection().execute(async () => {
            started.resolve();
            await gate;
          });
          await started.promise;
          if (!completed) throw failure;
          return ok('done');
        }),
      );
      expect(await committedIds('marker_notes')).toEqual([]);
      expect(await idleInTransaction()).toBe(0);
      expect(ran).toEqual(['rollback']);
      expect(outcome.resolved).toBe(false);
      if (completed) {
        expect(outcome.error).toBeInstanceOf(TransactionError);
        expect((outcome.error as Error).message).toContain(UNCLOSED_LEVEL);
      } else {
        expect(outcome.error).toBe(failure);
      }
    } finally {
      letGo();
      await holding;
    }
    await nextTransactionsBegin();
  };

  it('work of the transaction still holds the connection when the callback returns after a level was left open: transaction() rejects with D24 and commits nothing', holdingTest(true));

  it('work of the transaction still holds the connection when the callback throws after a level was left open: the caller gets its own error, and nothing is committed', holdingTest(false));

  it('isolated: a raw Kysely transaction that leaves open is rolled back at once, and its rows are not visible afterwards', async () => {
    await sql`create table if not exists marker_notes (id integer primary key)`.execute(connections.get());
    await sql`delete from marker_notes`.execute(connections.get());
    const isolation = await connections.isolate();
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into marker_notes values (1)`.execute(connections.get());
        try {
          await connections.get().transaction().execute(async (trx) => {
            await sql`insert into marker_notes values (2)`.execute(trx);
            throw new AbortedTransactionError();
          });
        } catch {
          // the caller handles it and goes on
        }
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain(UNCLOSED_LEVEL);
    const { rows } = await sql<{ id: number }>`select id from marker_notes order by id`.execute(connections.get());
    expect(rows).toEqual([]);
    await isolation.rollback();
    await nextTransactionsBegin();
  });

  it('isolated: a transaction rejects with D24, and the isolation and the connection stay usable', async () => {
    await sql`create table if not exists late_notes (id integer primary key)`.execute(connections.get());
    const isolation = await connections.isolate();
    let later: { settled: Promise<string> } | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into late_notes values (10)`.execute(connections.get());
        later = await startFailingLater();
        return ok('done');
      }),
    );
    expect(outcome.resolved).toBe(false);
    expect(outcome.error).toBeInstanceOf(TransactionError);
    expect((outcome.error as Error).message).toContain(LATE_FAILURE);
    expect((outcome.error as { cause?: { code?: string } }).cause?.code).toBe('25P02');
    expect(await later?.settled).toBe('failed later');
    await connections.transaction(async () => ok(await sql`insert into late_notes values (11)`.execute(connections.get())));
    const { rows } = await sql<{ id: number }>`select id from late_notes where id >= 10 order by id`.execute(connections.get());
    expect(rows.map((row) => row.id)).toEqual([11]);
    await isolation.rollback();
    await nextTransactionsBegin();
  });
});

/**
 * Kysely skips the rollback of a `db.transaction()` whose callback throws the error it carries a marker on (a commit the database answered
 * with a rollback), even when the error is caught outside it. What the callback of `transaction()` or a raw Kysely transaction inside it
 * does with that error must never leave a level open or report a commit.
 */
describe.each(drivers)('a transaction callback that throws the marker of an aborted commit, on %s', (driver) => {
  const pgsql = driver === 'pgsql';
  let connections: Connections;
  let reader: Connections;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver, { managed: false }));
    await sql`create table marker_notes (id integer primary key)`.execute(connections.get());
    // Another connection sees what is committed: on SQLite there is one for everyone, and nothing is open when a test ends.
    reader = connections;
  });

  afterAll(async () => {
    await close();
  });

  afterEach(() => vi.restoreAllMocks());

  const ids = async (): Promise<number[]> => {
    const { rows } = await sql<{ id: number }>`select id from marker_notes order by id`.execute(reader.get());
    return rows.map((row) => row.id);
  };
  const clear = async () => void (await sql`delete from marker_notes`.execute(connections.get()));
  const settle = (work: Promise<unknown>) =>
    work.then(
      () => ({ resolved: true as const, error: undefined }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
  const nextTransactionBegins = async () => {
    for (let i = 0; i < 3; i++) {
      const value = await connections.transaction(async () => ok((await sql<{ one: number }>`select 1 as one`.execute(connections.get())).rows[0]!.one));
      expect(value).toMatchObject({ ok: true, value: 1 });
    }
  };
  const opened = async (work: (trx: KyselyTransaction<any>) => Promise<unknown>) => {
    try {
      await connections.get<any>().transaction().execute(work);
    } catch {
      // the caller handles it and goes on
    }
  };

  it('outermost transaction(): rejects with that very error, rolls back, and fires no warning', async () => {
    await clear();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const marker = new AbortedTransactionError();
    const ran: string[] = [];
    try {
      const outcome = await settle(
        connections.transaction(async () => {
          await sql`insert into marker_notes values (1)`.execute(connections.get());
          await afterCommit(() => void ran.push('commit'));
          await afterRollback(() => void ran.push('rollback'));
          throw marker;
        }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.error).toBe(marker);
      expect(ran).toEqual(['rollback']);
      expect(await ids()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      await nextTransactionBegins();
    } finally {
      warn.mockRestore();
    }
  });

  it('nested transaction(): the savepoint is rolled back, and the transaction around it commits what it did itself', async () => {
    await clear();
    const ran: string[] = [];
    let escaped: unknown;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into marker_notes values (1)`.execute(connections.get());
        await afterCommit(() => void ran.push('outer commit'));
        try {
          await connections.transaction(async () => {
            await sql`insert into marker_notes values (2)`.execute(connections.get());
            await afterCommit(() => void ran.push('inner commit'));
            throw new AbortedTransactionError();
          });
        } catch (error) {
          escaped = error;
        }
        await sql`insert into marker_notes values (3)`.execute(connections.get());
        return ok('done');
      }),
    );
    expect(isAbortedTransactionError(escaped)).toBe(true);
    expect(outcome.resolved).toBe(true);
    expect(await ids()).toEqual([1, 3]);
    expect(ran).toEqual(['outer commit']);
    await nextTransactionBegins();
  });

  it('a raw Kysely transaction left open inside transaction(): it rejects with D24 and commits nothing', async () => {
    await clear();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      const ran: string[] = [];
      const outcome = await settle(
        connections.transaction(async () => {
          await sql`insert into marker_notes values (1)`.execute(connections.get());
          await afterCommit(() => void ran.push('commit'));
          await afterRollback(() => void ran.push('rollback'));
          await opened(async (trx) => {
            await sql`insert into marker_notes values (2)`.execute(trx);
            throw new AbortedTransactionError();
          });
          await sql`insert into marker_notes values (3)`.execute(connections.get());
          return ok('done');
        }),
      );
      expect(outcome.resolved).toBe(false);
      expect(outcome.error).toBeInstanceOf(TransactionError);
      expect((outcome.error as Error).message).toContain(releasedOpen('default'));
      expect((outcome.error as Error).message).toContain('D24');
      expect(ran).toEqual(['rollback']);
      expect(await ids()).toEqual([]);
      expect(warn).toHaveBeenCalledExactlyOnceWith('A transaction on "default" was still open when its connection was released; Marmeon rolled it back', {
        type: 'MarmeonDatabaseWarning',
        code: 'MARMEON_TRANSACTION_LEFT_OPEN',
      });
    } finally {
      warn.mockRestore();
    }
    await nextTransactionBegins();
  });

  it('a raw Kysely transaction left open inside a nested transaction(): the nested one is undone with D24, the one around it commits its own rows', async () => {
    await clear();
    const ran: string[] = [];
    let nested: Awaited<ReturnType<typeof settle>> | undefined;
    const outcome = await settle(
      connections.transaction(async () => {
        await sql`insert into marker_notes values (1)`.execute(connections.get());
        nested = await settle(
          connections.transaction(async () => {
            await sql`insert into marker_notes values (2)`.execute(connections.get());
            await afterCommit(() => void ran.push('nested commit'));
            await opened(async (trx) => {
              await sql`insert into marker_notes values (3)`.execute(trx);
              throw new AbortedTransactionError();
            });
            return ok('nested done');
          }),
        );
        await sql`insert into marker_notes values (4)`.execute(connections.get());
        return ok('done');
      }),
    );
    expect(nested?.resolved).toBe(false);
    expect(((nested?.error ?? new Error('no error')) as Error).message).toContain(UNCLOSED_LEVEL);
    expect(outcome.resolved).toBe(true);
    expect(await ids()).toEqual([1, 4]);
    expect(ran).toEqual([]);
    await nextTransactionBegins();
  });

  it('a repository whose connections have no transaction() returns that very error and writes nothing', async () => {
    await clear();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const marker = new AbortedTransactionError();
    try {
      const repository = new MarkerNotes({ get: () => connections.get() } as unknown as Connections);
      const outcome = await settle(
        repository.transaction(async (bound) => {
          await bound.insert({ id: 1 });
          throw marker;
        }),
      );
      expect(outcome.error).toBe(marker);
      expect(await ids()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      await nextTransactionBegins();
    } finally {
      warn.mockRestore();
    }
  });

  it.runIf(pgsql)('(pgsql) nothing stays open in the database after any of them', async () => {
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state like 'idle in transaction%'`.execute(connections.get());
    expect(rows[0]!.n).toBe(0);
  });
});

class MarkerNotes extends Repository<'marker_notes', any> {
  static table = 'marker_notes' as const;
}
