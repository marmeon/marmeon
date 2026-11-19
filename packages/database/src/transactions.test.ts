import { setTimeout as sleep } from 'node:timers/promises';
import { commitAnyway, err, ok, type Result } from '@marmeon/core';
import { sql, type Generated, type Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections, withMysql } from './__fixtures__/databases.ts';
import { DatabaseConnectionError } from './driver.ts';
import { migratorConnection } from './migrator-connection.ts';
import { afterCommit, afterRollback, inTransaction, outsideTransaction, Repository, TransactionError, TransactionFinishedError, type Connections } from './index.ts';

// The ambient transaction context: `connections.transaction(callback)` and everything awaited inside it.

interface NoteTables {
  notes: { id: Generated<number>; title: string };
}

class NoteRepository extends Repository<'notes', NoteTables> {
  static table = 'notes' as const;

  titles(): Promise<string[]> {
    return this.query()
      .select('title')
      .orderBy('id')
      .execute()
      .then((rows) => rows.map((row) => row.title));
  }
}

class Rollback extends Error {}

/** A hang is a failure, not a stuck suite: a second transaction on SQLite's one connection hangs forever. */
function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  return Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(`hung for ${ms} ms`)))]);
}

async function createNotes(db: Kysely<any>, driver: 'sqlite' | 'pgsql'): Promise<void> {
  await db.schema
    .createTable('notes')
    .addColumn('id', driver === 'sqlite' ? 'integer' : 'bigint', (c) => (driver === 'sqlite' ? c.primaryKey().autoIncrement() : c.primaryKey().generatedByDefaultAsIdentity()))
    .addColumn('title', 'text', (c) => c.notNull())
    .execute();
}

describe.each(drivers)('connections.transaction() on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let notes: NoteRepository;
  let db: Kysely<NoteTables>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    db = connections.get<NoteTables>();
    await createNotes(db, driver);
    notes = new NoteRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.deleteFrom('notes').execute();
  });

  it('lets a repository join without using(trx): its writes commit and roll back with the transaction', async () => {
    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'committed' });
      }),
    );
    await expect(
      within(
        connections.transaction(async () => {
          await notes.insert({ title: 'rolled back' });
          // Also a plain `db` of the connection joins — and sees the uncommitted row.
          expect(await db.selectFrom('notes').select('title').where('title', '=', 'rolled back').executeTakeFirst()).toEqual({ title: 'rolled back' });
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await notes.titles()).toEqual(['committed']);
  });

  it('passes the Kysely transaction to the callback, for using(trx) and code outside the call chain', async () => {
    const result = await within(
      connections.transaction(async (trx) => {
        expect(trx.isTransaction).toBe(true);
        await notes.using(trx as unknown as Kysely<NoteTables>).insert({ title: 'through trx' });
        return notes.titles();
      }),
    );
    expect(result).toEqual(['through trx']);
  });

  it('makes a repository transaction() ambient too', async () => {
    await expect(
      within(
        notes.transaction(async () => {
          await notes.insert({ title: 'a' });
          await new NoteRepository(connections).insert({ title: 'b' });
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await notes.titles()).toEqual([]);
  });

  it('turns a nested transaction into a savepoint — an inner rollback keeps the outer writes, without hanging', async () => {
    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer' });
        await expect(
          connections.transaction(async () => {
            // The savepoint sees the outer transaction's rows (a second real transaction would not, or would hang on SQLite).
            expect(await notes.titles()).toEqual(['outer']);
            await notes.insert({ title: 'inner, rolled back' });
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
        await connections.transaction(() => notes.insert({ title: 'inner, kept' }));
        // Kysely's own transaction inside the ambient one: a savepoint as well.
        await db.transaction().execute((trx) => trx.insertInto('notes').values({ title: 'kysely' }).execute());
      }),
    );
    expect(await notes.titles()).toEqual(['outer', 'inner, kept', 'kysely']);
  });

  it('undoes a committed savepoint when the outer transaction rolls back', async () => {
    await expect(
      within(
        connections.transaction(async () => {
          await connections.transaction(() => notes.insert({ title: 'inner, committed' }));
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(await notes.titles()).toEqual([]);
  });

  it('refuses work started inside that runs after the transaction finished — loud, never on the bare connection', async () => {
    let late!: Promise<unknown>;
    let timer!: Promise<unknown>;
    await within(
      connections.transaction(async () => {
        // Not awaited: runs after the commit.
        late = sleep(20).then(() => notes.insert({ title: 'late' }));
        timer = new Promise((resolve, reject) => setTimeout(() => db.insertInto('notes').values({ title: 'timer' }).execute().then(resolve, reject), 20));
      }),
    );
    await expect(late).rejects.toBeInstanceOf(TransactionFinishedError);
    await expect(late).rejects.toThrow(
      'This work was started inside transaction() on "default" but ran after that transaction was committed — await it inside the callback, or wrap it in outsideTransaction() if it should run on its own.',
    );
    await expect(timer).rejects.toBeInstanceOf(TransactionFinishedError);

    let lateAfterRollback!: Promise<unknown>;
    await expect(
      within(
        connections.transaction(async () => {
          lateAfterRollback = sleep(20).then(() => notes.insert({ title: 'after rollback' }));
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    await expect(lateAfterRollback).rejects.toThrow('ran after that transaction was rolled back');
    expect(await notes.titles()).toEqual([]);
  });

  it('runs afterCommit work after the outermost commit, outside the transaction — and never after a rollback', async () => {
    const seen: string[] = [];
    await afterCommit(() => seen.push('no transaction: at once'));
    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'kept' });
        await afterCommit(async () => {
          seen.push(`outer: in transaction ${inTransaction()}, sees ${(await notes.titles()).join()}`);
        });
        await connections.transaction(() => afterCommit(() => seen.push('savepoint, committed with the outer')));
        await expect(
          connections.transaction(async () => {
            await afterCommit(() => seen.push('savepoint rolled back — never'));
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
        seen.push('callback done');
      }),
    );
    await expect(
      within(
        connections.transaction(async () => {
          await afterCommit(() => seen.push('rolled back — never'));
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(seen).toEqual(['no transaction: at once', 'callback done', 'outer: in transaction false, sees kept', 'savepoint, committed with the outer']);
  });

  it('runs afterRollback work right after a rollback, outside the transaction — and never after a commit', async () => {
    const seen: string[] = [];
    await afterRollback(() => seen.push('no transaction: never'));
    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'kept' });
        await afterRollback(() => seen.push('outer committed — never'));
        // A savepoint that commits hands its work to the transaction around it — which commits: never.
        await connections.transaction(() => afterRollback(() => seen.push('savepoint committed, outer committed — never')));
        // A savepoint that rolls back: what the work cleans up after is gone for good — it runs now, outside of any transaction.
        await expect(
          connections.transaction(async () => {
            await notes.insert({ title: 'savepoint' });
            await afterRollback(async () => {
              seen.push(`savepoint rolled back: in transaction ${inTransaction()}`);
            });
            throw new Rollback();
          }),
        ).rejects.toBeInstanceOf(Rollback);
        seen.push('callback done');
      }),
    );
    await expect(
      within(
        connections.transaction(async () => {
          await notes.insert({ title: 'rolled back' });
          await afterRollback(() => seen.push('outermost rolled back'));
          // Committed into the outer one, which then rolls back: runs with it.
          await connections.transaction(() => afterRollback(() => seen.push('savepoint committed, outer rolled back')));
          seen.push('about to throw');
          throw new Rollback();
        }),
      ),
    ).rejects.toBeInstanceOf(Rollback);
    expect(seen).toEqual([
      'savepoint rolled back: in transaction false',
      'callback done',
      'about to throw',
      'outermost rolled back',
      'savepoint committed, outer rolled back',
    ]);
    expect(await notes.titles()).toEqual(['kept']);
  });

  it('keeps the error that rolled back when afterRollback work fails — as a SuppressedError', async () => {
    const original = new Rollback('the reason it rolled back');
    const error = await within(
      connections.transaction(async () => {
        await afterRollback(() => {
          throw new Error('the lock server is down');
        });
        await afterRollback(() => undefined); // still runs
        throw original;
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SuppressedError);
    expect((error as SuppressedError).suppressed).toBe(original);
    expect((error as SuppressedError).error).toEqual(new Error('the lock server is down'));
    expect((error as Error).message).toContain('After-rollback work failed (the transaction on "default" is rolled back): the lock server is down');
  });

  it('throws an error of afterCommit work from transaction() — after the commit', async () => {
    await expect(
      within(
        connections.transaction(async () => {
          await notes.insert({ title: 'committed anyway' });
          await afterCommit(() => {
            throw new Error('the mail server is down');
          });
        }),
      ),
    ).rejects.toThrow('the mail server is down');
    expect(await notes.titles()).toEqual(['committed anyway']);
  });

  it('refuses two transactions at once inside one transaction', async () => {
    await within(
      connections.transaction(async () => {
        await expect(Promise.all([connections.transaction(() => sleep(10)), connections.transaction(() => sleep(10))])).rejects.toThrow(
          'Two transactions were opened at the same time inside one transaction on "default"',
        );
        await sleep(30);
      }),
    );
  });

  it('refuses an isolation level on a nested transaction (a savepoint has none)', async () => {
    await within(
      connections.transaction(async () => {
        await expect(connections.transaction(async () => {}, { isolationLevel: 'serializable' })).rejects.toThrow('becomes a savepoint, which has no isolation level');
      }),
    );
  });

  it('refuses an isolation level it does not know, before beginning', async () => {
    let ran = false;
    // @ts-expect-error — 'snapshot' is Kysely's, not Marmeon's
    const snapshot = connections.transaction(async () => { ran = true; }, { isolationLevel: 'snapshot' });
    await expect(snapshot).rejects.toThrow(TypeError);
    await expect(snapshot).rejects.toThrow("the level is one of 'read committed', 'repeatable read', 'serializable'");
    expect(ran).toBe(false);
  });

  it('keeps the context to its own call chain: concurrent transactions never see each other (AsyncLocalStorage)', async () => {
    // On Postgres the three run at once (three connections): each step waits for the others to have looked — not for a
    // guessed time, which a loaded machine overran. On SQLite (one connection) they queue: b and the plain chain
    // start a moment later and wait for a's commit.
    const signal = () => {
      let open!: () => void;
      return Object.assign(new Promise<void>((resolve) => (open = resolve)), { open: () => open() });
    };
    const aInserted = signal();
    const bLooked = signal();
    const plainLooked = signal();
    const after = (event: Promise<unknown>, ms: number) => (driver === 'pgsql' ? event : sleep(ms));
    const chain = (title: string, start: Promise<unknown>, inserted: () => void, looked: () => void, hold: Promise<unknown>) =>
      start.then(() =>
        within(
          connections.transaction(async () => {
            await notes.insert({ title });
            inserted();
            const seen = { inTransaction: inTransaction(), titles: await notes.titles() };
            looked();
            await hold;
            return seen;
          }),
        ),
      );
    const outside = after(bLooked, 15).then(async () => {
      const seen = { inTransaction: inTransaction(), titles: await within(notes.titles()) };
      plainLooked.open();
      return seen;
    });
    // a stays open until b and the plain chain have looked; b starts while it is open and stays open until the plain chain has looked.
    const [a, b, plain] = await Promise.all([
      chain('a', sleep(0), aInserted.open, () => {}, after(Promise.all([bLooked, plainLooked]), 80)),
      chain('b', after(aInserted, 5), () => {}, bLooked.open, after(plainLooked, 10)),
      outside,
    ]);
    expect(a).toEqual({ inTransaction: true, titles: ['a'] });
    // On SQLite (one connection) b waits for a's commit, so it sees a; on Postgres both run at once and b sees only its own.
    expect(b).toEqual({ inTransaction: true, titles: driver === 'sqlite' ? ['a', 'b'] : ['b'] });
    // A chain outside any transaction never joins one — on SQLite it waits for the connection, on Postgres it sees no uncommitted row.
    expect(plain.inTransaction).toBe(false);
    if (driver === 'pgsql') expect(plain.titles).toEqual([]);
  });

  it(
    driver === 'pgsql'
      ? 'keeps an outsideTransaction() write when the transaction rolls back'
      : 'fails outsideTransaction() at once while the transaction holds SQLite\'s one connection (instead of hanging)',
    async () => {
      const run = within(
        connections.transaction(async () => {
          await notes.insert({ title: 'rolled back' });
          await outsideTransaction(() => notes.insert({ title: 'failed attempt' }));
          throw new Rollback();
        }),
      );
      if (driver === 'pgsql') {
        await expect(run).rejects.toBeInstanceOf(Rollback);
        expect(await notes.titles()).toEqual(['failed attempt']);
      } else {
        await expect(run).rejects.toThrow(
          'outsideTransaction() cannot reach the database connection "default" while the transaction it stepped out of is open: the connection has a single physical connection (SQLite)',
        );
        expect(await notes.titles()).toEqual([]);
      }
      // After the transaction, outsideTransaction() is a plain call.
      await outsideTransaction(() => notes.insert({ title: 'later' }));
      expect(await notes.titles()).toContain('later');
    },
  );

  it.runIf(driver === 'sqlite')("fails a transaction opened in outsideTransaction() at once instead of waiting for SQLite's one connection", { timeout: 5000 }, async () => {
    await expect(
      connections.transaction(() => outsideTransaction(() => connections.transaction(() => notes.insert({ title: 'never' })))),
    ).rejects.toThrow('cannot start inside outsideTransaction()');
    expect(await notes.titles()).not.toContain('never');
  });
});

describe.each(drivers)('a transaction callback that returns a Result on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let notes: NoteRepository;
  let db: Kysely<NoteTables>;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    db = connections.get<NoteTables>();
    await createNotes(db, driver);
    notes = new NoteRepository(connections);
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.deleteFrom('notes').execute();
  });

  it('rolls back on an err and hands the err to the caller unchanged — not thrown', async () => {
    const failed = err({ kind: 'invalid' });
    const result = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'rolled back' });
        return failed;
      }),
    );
    expect(result).toBe(failed);
    expect(await notes.titles()).toEqual([]);
    const fine = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'committed' });
        return ok(1);
      }),
    );
    expect(fine).toEqual({ ok: true, value: 1 });
    expect(await notes.titles()).toEqual(['committed']);
  });

  it('rolls a savepoint back on its err and keeps the writes of the transaction around it', async () => {
    const inner = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer' });
        const result = await connections.transaction(async () => {
          await notes.insert({ title: 'inner, rolled back' });
          return err({ kind: 'invalid' });
        });
        await notes.insert({ title: 'outer, after' });
        return result;
      }),
    );
    // The outer callback returned the inner err as its own: the outer transaction rolls back too.
    expect(inner).toEqual({ ok: false, error: { kind: 'invalid' } });
    expect(await notes.titles()).toEqual([]);

    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer' });
        const result = await connections.transaction(async () => {
          await notes.insert({ title: 'inner, rolled back' });
          return err({ kind: 'invalid' });
        });
        expect(result.ok).toBe(false);
        await notes.insert({ title: 'outer, after' });
      }),
    );
    expect(await notes.titles()).toEqual(['outer', 'outer, after']);
  });

  it('runs afterRollback work and drops afterCommit work after an err — in a savepoint and outermost', async () => {
    const seen: string[] = [];
    await within(
      connections.transaction(async () => {
        await afterCommit(() => seen.push('outer committed'));
        await connections.transaction(async () => {
          await afterCommit(() => seen.push('savepoint err — never'));
          await afterRollback(() => seen.push(`savepoint err: in transaction ${inTransaction()}`));
          return err({ kind: 'invalid' });
        });
        seen.push('callback done');
      }),
    );
    await within(
      connections.transaction(async () => {
        await afterCommit(() => seen.push('outermost err — never'));
        await afterRollback(() => seen.push('outermost err'));
        return err({ kind: 'invalid' });
      }),
    );
    expect(seen).toEqual(['savepoint err: in transaction false', 'callback done', 'outer committed', 'outermost err']);
  });

  it('commits a commitAnyway(err) — afterCommit runs, and the caller gets a plain err', async () => {
    const seen: string[] = [];
    const result = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'request dropped' });
        await afterCommit(() => seen.push('committed'));
        await afterRollback(() => seen.push('rolled back — never'));
        return commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
      }),
    );
    expect(result).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
    expect(JSON.stringify(result)).toBe('{"ok":false,"error":{"kind":"taken","email":"ada@example.com"}}');
    expect(seen).toEqual(['committed']);
    expect(await notes.titles()).toEqual(['request dropped']);

    // Plain: returned again from a transaction of its own, the err rolls that one back — commitAnyway is local to one callback.
    await db.deleteFrom('notes').execute();
    const again = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer, rolled back' });
        return connections.transaction(async () => {
          await notes.insert({ title: 'savepoint, committed' });
          return commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
        });
      }),
    );
    expect(again.ok).toBe(false);
    expect(await notes.titles()).toEqual([]);
  });

  it('commits a look-alike { ok: false } that err() did not make, like any other value', async () => {
    const payload = { ok: false, error: { kind: 'invalid' } };
    const result = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'committed' });
        return payload;
      }),
    );
    expect(result).toBe(payload);
    expect(await notes.titles()).toEqual(['committed']);
    // A copy of a real err loses the mark: data, not a result.
    await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'copied' });
        return { ...err({ kind: 'invalid' }) };
      }),
    );
    expect(await notes.titles()).toEqual(['committed', 'copied']);
  });

  it('throws the error of afterRollback work after an err — one as it is, several as an AggregateError', async () => {
    const lockServer = new Error('the lock server is down');
    await expect(
      within(
        connections.transaction(async () => {
          await notes.insert({ title: 'rolled back' });
          await afterRollback(() => {
            throw lockServer;
          });
          return err({ kind: 'invalid' });
        }),
      ),
    ).rejects.toBe(lockServer);
    expect(await notes.titles()).toEqual([]);

    const seen: string[] = [];
    const error = await within(
      connections.transaction(async () => {
        await afterRollback(() => {
          throw new Error('first');
        });
        await afterRollback(() => seen.push('still runs'));
        await afterRollback(() => {
          throw new Error('second');
        });
        return err({ kind: 'invalid' });
      }),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([new Error('first'), new Error('second')]);
    expect((error as Error).message).toBe('2 pieces of after-rollback work failed (the transaction on "default" returned an err and is rolled back).');
    expect(seen).toEqual(['still runs']);
  });

  describe.each([
    ['ambient, through connections.transaction()', (repository: NoteRepository) => repository],
    ['without Connections, directly over Kysely', (repository: NoteRepository) => repository.using(db)],
  ])('repository.transaction() %s', (_, repositoryOf) => {
    it('rolls back on an err and returns it, commits a commitAnyway(err) as a plain err, commits a look-alike', async () => {
      const repository = repositoryOf(notes);
      const failed = err({ kind: 'invalid' });
      expect(
        await within(
          repository.transaction(async (inside) => {
            await inside.insert({ title: 'rolled back' });
            return failed;
          }),
        ),
      ).toBe(failed);
      expect(await notes.titles()).toEqual([]);

      const dropped = await within(
        repository.transaction(async (inside) => {
          await inside.insert({ title: 'committed anyway' });
          return commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
        }),
      );
      expect(dropped).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
      // A plain err now: the next transaction that returns it rolls back.
      expect(
        await within(
          repository.transaction(async (inside) => {
            await inside.insert({ title: 'rolled back' });
            return dropped;
          }),
        ),
      ).toBe(dropped);

      await within(
        repository.transaction(async (inside) => {
          await inside.insert({ title: 'look-alike' });
          return { ok: false, error: { kind: 'invalid' } };
        }),
      );
      expect(await notes.titles()).toEqual(['committed anyway', 'look-alike']);
    });
  });

  it('keeps a commitAnyway write only while the transactions around it keep it: propagated plainly it is rolled back, with commitAnyway it stays', async () => {
    const dropRequest = () =>
      connections.transaction(async () => {
        await notes.insert({ title: 'request dropped' });
        return commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
      });

    const plainly = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer' });
        const result = await dropRequest();
        if (!result.ok) return result;
        return ok(undefined);
      }),
    );
    expect(plainly).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
    expect(await notes.titles()).toEqual([]);

    const kept = await within(
      connections.transaction(async () => {
        await notes.insert({ title: 'outer' });
        const result = await dropRequest();
        if (!result.ok) return commitAnyway(result);
        return ok(undefined);
      }),
    );
    expect(kept).toEqual({ ok: false, error: { kind: 'taken', email: 'ada@example.com' } });
    expect(await notes.titles()).toEqual(['outer', 'request dropped']);
  });

  it('repository.transaction() without Connections still rejects with a thrown error and rolls back', async () => {
    const thrown = new Rollback();
    await expect(
      within(
        notes.using(db).transaction(async (inside) => {
          await inside.insert({ title: 'rolled back' });
          throw thrown;
        }),
      ),
    ).rejects.toBe(thrown);
    expect(await notes.titles()).toEqual([]);
  });

  it('repository.transaction() on using(trx) rolls its own savepoint back on an err and keeps the outer writes', async () => {
    // Kysely's own transaction, outside the ambient context: the repository bound to it opens a savepoint of its own.
    const results = await within(
      db.transaction().execute(async (trx) => {
        const bound = notes.using(trx);
        await bound.insert({ title: 'outer' });
        const failed = await bound.transaction(async (inside) => {
          await inside.insert({ title: 'savepoint, rolled back' });
          return err({ kind: 'invalid' });
        });
        const dropped = await bound.transaction(async (inside) => {
          await inside.insert({ title: 'savepoint, committed anyway' });
          return commitAnyway(err({ kind: 'taken', email: 'ada@example.com' }));
        });
        await bound.transaction(async (inside) => {
          await inside.insert({ title: 'savepoint, look-alike' });
          return { ok: false, error: { kind: 'invalid' } };
        });
        return [failed, dropped];
      }),
    );
    expect(results).toEqual([
      { ok: false, error: { kind: 'invalid' } },
      { ok: false, error: { kind: 'taken', email: 'ada@example.com' } },
    ]);
    expect(await notes.titles()).toEqual(['outer', 'savepoint, committed anyway', 'savepoint, look-alike']);
  });
});

describe.each(drivers)('transactions in an isolated test connection on %s', (driver) => {
  let connections: Connections;
  let close: () => Promise<void>;
  let notes: NoteRepository;

  beforeAll(async () => {
    ({ connections, close } = await freshConnections(driver));
    await createNotes(connections.get(), driver);
    notes = new NoteRepository(connections);
  });
  afterAll(() => close());

  it('become savepoints in the test transaction, take turns when concurrent, and are undone with it', async () => {
    const isolation = await connections.isolate();
    try {
      await within(connections.transaction(() => notes.insert({ title: 'kept in the test' })));
      await expect(
        within(
          connections.transaction(async () => {
            await notes.insert({ title: 'rolled back' });
            throw new Rollback();
          }),
        ),
      ).rejects.toBeInstanceOf(Rollback);
      // Two requests at once, each in its own transaction, on the one pinned connection: one after the other.
      await within(
        Promise.all(
          ['x', 'y'].map((title) =>
            connections.transaction(async () => {
              await notes.insert({ title });
              await sleep(10);
              if (title === 'x') throw new Rollback();
            }).catch((error: unknown) => {
              if (!(error instanceof Rollback)) throw error;
            }),
          ),
        ),
      );
      expect(await notes.titles()).toEqual(['kept in the test', 'y']);
      // An err rolls back the same way here, where the app's outermost transaction is a savepoint of the test's.
      const failed = err({ kind: 'invalid' });
      expect(
        await within(
          connections.transaction(async () => {
            await notes.insert({ title: 'err, rolled back' });
            return failed;
          }),
        ),
      ).toBe(failed);
      expect(await notes.titles()).toEqual(['kept in the test', 'y']);
      // outsideTransaction() cannot leave the test's single connection while a transaction is open on it.
      await expect(within(connections.transaction(() => outsideTransaction(() => notes.insert({ title: 'out' }))))).rejects.toBeInstanceOf(TransactionError);
    } finally {
      await isolation.rollback();
    }
    expect(await notes.titles()).toEqual([]);
  });
});

it('types the callback and the result', () => {
  // Never called: only type-checked (and its body really runs through Vitest's transform).
  void (async (connections: Connections) => {
    const count: number = await connections.transaction(async (trx) => (trx.isTransaction ? 1 : 0));
    // A Result comes back as the callback returned it — narrowed by ok.
    const outcome: Result<number, { kind: 'invalid' }> = await connections.transaction(async () => (count > 0 ? ok(count) : err({ kind: 'invalid' })));
    if (!outcome.ok) return outcome.error.kind;
    // @ts-expect-error — the options are an object: { connection: 'reporting' }
    await connections.transaction(async () => {}, 'reporting');
    return count;
  });
});

// The cases on MySQL run where the server is (MARMEON_TEST_MYSQL_URL, `pnpm test:mysql`). A transaction that the server ended (a deadlock, a lock wait timeout, an implicit commit) refuses what follows, instead of letting it autocommit.
withMysql('connections.transaction() on mysql', () => {
  interface MysqlTables {
    lockers: { id: number; v: number };
    marks: { id: Generated<number>; name: string };
  }
  let connections: Connections;
  let close: () => Promise<void>;
  let db: Kysely<MysqlTables>;
  const D24 = /^\[marmeon:D24\] This transaction was ended by MySQL: /;

  /** What a refused or failed statement threw, or `undefined` when it went through. */
  const thrown = (work: Promise<unknown>): Promise<unknown> => work.then(() => undefined, (error: unknown) => error);
  const names = async () => (await db.selectFrom('marks').select('name').orderBy('name').execute()).map((row) => row.name);
  /** The statements the session of `trx` has run of one kind (`Com_do` for `do 0`): the server counts them for the connection. */
  const counted = async (trx: Kysely<any>, name: string) =>
    Number((await sql.raw<{ Value: string }>(`show session status like '${name}'`).execute(trx)).rows[0]!.Value);

  beforeAll(async () => {
    ({ connections, close } = await freshConnections('mysql'));
    db = connections.get<MysqlTables>();
    const setup = migratorConnection(connections);
    await setup.schema.createTable('lockers').addColumn('id', 'integer', (c) => c.primaryKey()).addColumn('v', 'integer', (c) => c.notNull()).execute();
    await setup.schema.createTable('marks').addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement()).addColumn('name', 'varchar(50)', (c) => c.notNull().unique()).execute();
  });
  afterAll(() => close());
  beforeEach(async () => {
    await db.deleteFrom('lockers').execute();
    await db.deleteFrom('marks').execute();
    await db.insertInto('lockers').values([{ id: 1, v: 0 }, { id: 2, v: 0 }]).execute();
  });

  /**
   * Two transactions that lock the two rows in opposite order: the server ends one of them with a deadlock, and its callback catches the error and runs
   * `afterwards`. `how` is the way the second update goes to the server: the builder (prepared, with parameters), raw text, or inside a nested `transaction()`.
   */
  async function deadlock(afterwards: (trx: Kysely<any>) => Promise<unknown>, how: 'prepared' | 'text' | 'nested' = 'prepared') {
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => (release = resolve));
    // A hang is a failure and not a stuck suite: the lock wait would end after 50 seconds.
    const timer = setTimeout(release, 5000);
    const losers: string[] = [];
    const cross = (trx: Kysely<any>, first: number, second: number) =>
      how === 'text' ? sql.raw(`update lockers set v = ${first} where id = ${second}`).execute(trx) : trx.updateTable('lockers').set({ v: first }).where('id', '=', second).execute();
    const run = (first: number, second: number, name: string) =>
      connections.transaction(async (trx: Kysely<any>) => {
        await trx.updateTable('lockers').set({ v: first }).where('id', '=', first).execute();
        if (++arrived === 2) release();
        await both;
        try {
          if (how === 'nested') await connections.transaction(async (inner: Kysely<any>) => void (await cross(inner, first, second)));
          else await cross(trx, first, second);
        } catch (error) {
          expect((error as { errno?: number }).errno).toBe(1213);
          losers.push(name);
          // The code catches the error and goes on, as it may on SQLite: this is what must not autocommit.
          await afterwards(trx);
        }
        return name;
      });
    try {
      const outcomes = await within(Promise.allSettled([run(1, 2, 'first'), run(2, 1, 'second')]), 15_000);
      return { losers, outcomes };
    } finally {
      clearTimeout(timer);
    }
  }

  it.each(['prepared', 'text', 'nested'] as const)('refuses the statement after a deadlock and the commit with D24, and nothing of the loser is committed (%s)', async (how) => {
    const { losers, outcomes } = await deadlock(async (trx) => {
      const refusal = await thrown(trx.insertInto('marks').values({ name: 'after the deadlock' }).execute());
      expect(refusal).toBeInstanceOf(TransactionError);
      expect((refusal as Error).message).toMatch(D24);
      expect((refusal as Error).message).toContain('deadlock (error 1213)');
    }, how);
    expect(losers).toHaveLength(1);
    const results = losers[0] === 'first' ? outcomes : [...outcomes].reverse();
    // The loser's callback returned, and its commit was refused; the other one committed.
    expect(results[0]).toMatchObject({ status: 'rejected', reason: expect.any(TransactionError) });
    expect(((results[0] as PromiseRejectedResult).reason as Error).message).toMatch(D24);
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    expect(await names()).toEqual([]);
    // The loser's first update was rolled back: only the winner's two rows changed.
    const winner = losers[0] === 'first' ? 2 : 1;
    expect(await db.selectFrom('lockers').select(['id', 'v']).orderBy('id').execute()).toEqual([{ id: 1, v: winner }, { id: 2, v: winner }]);
  });

  it('does not let a statement after a deadlock autocommit: a transaction of the next caller on the same connection starts clean', async () => {
    await deadlock(async (trx) => void (await thrown(trx.insertInto('marks').values({ name: 'after the deadlock' }).execute())));
    await connections.transaction(async (trx: Kysely<any>) => {
      await trx.insertInto('marks').values({ name: 'next' }).execute();
    });
    expect(await names()).toEqual(['next']);
  });

  it('ends a transaction at a lock wait timeout (a real error 1205) the same way: the next statement and the commit are refused', async () => {
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const timer = setTimeout(() => (held(), done()), 10_000);
    const holder = connections.transaction(async (trx: Kysely<any>) => {
      await trx.updateTable('lockers').set({ v: 5 }).where('id', '=', 1).execute();
      held();
      await finished;
    });
    await holding;
    let after: unknown;
    const commit = await thrown(
      within(
        connections.transaction(async (trx: Kysely<any>) => {
          await sql`set session innodb_lock_wait_timeout = 1`.execute(trx);
          const timeout = await thrown(trx.updateTable('lockers').set({ v: 6 }).where('id', '=', 1).execute());
          expect((timeout as { errno?: number }).errno).toBe(1205);
          after = await thrown(trx.insertInto('marks').values({ name: 'after the timeout' }).execute());
        }),
        8000,
      ),
    );
    done();
    clearTimeout(timer);
    await holder;
    expect((after as Error).message).toMatch(/a lock wait timed out \(error 1205\)/);
    expect(commit).toBeInstanceOf(TransactionError);
    expect(await names()).toEqual([]);
    expect((await db.selectFrom('lockers').select('v').where('id', '=', 1).executeTakeFirstOrThrow()).v).toBe(5);
  });

  it('refuses what follows a raw schema change in a transaction, with D24 for the statement and the commit; what ran before it is committed', async () => {
    let after: unknown;
    const commit = await thrown(
      connections.transaction(async (trx: Kysely<any>) => {
        await trx.insertInto('marks').values({ name: 'before' }).execute();
        await sql`create table t2 (id int)`.execute(trx);
        after = await thrown(trx.insertInto('marks').values({ name: 'after' }).execute());
      }),
    );
    expect(after).toBeInstanceOf(TransactionError);
    expect((after as Error).message).toMatch(/^\[marmeon:D24\] This transaction was ended by MySQL: a statement committed it \(/);
    expect(commit).toBeInstanceOf(TransactionError);
    expect((commit as Error).message).toMatch(D24);
    // The insert before the statement is committed by it; the one after it never ran.
    expect(await names()).toEqual(['before']);
    await sql`drop table t2`.execute(db);
    // The connection is clean for the next transaction.
    await connections.transaction(async (trx: Kysely<any>) => void (await trx.insertInto('marks').values({ name: 'next' }).execute()));
    expect(await names()).toEqual(['before', 'next']);
  });

  it('refuses what follows a statement that commits, also one that is prepared (a call with a parameter)', async () => {
    const setup = migratorConnection(connections);
    await sql`create procedure commits_in(in x int) begin update lockers set v = x where id = 1; commit; end`.execute(setup);
    await sql`create procedure keeps_in(in x int) begin select x as one; update lockers set v = x where id = 1; end`.execute(setup);
    let after: unknown;
    const commit = await thrown(
      connections.transaction(async (trx: Kysely<any>) => {
        await sql`call commits_in(${7})`.execute(trx);
        after = await thrown(trx.insertInto('marks').values({ name: 'after the call' }).execute());
      }),
    );
    expect(after).toBeInstanceOf(TransactionError);
    expect(commit).toBeInstanceOf(TransactionError);
    expect(await names()).toEqual([]);
    // A call with a parameter that stays in the transaction is not an alarm, and commits with it.
    await connections.transaction(async (trx: Kysely<any>) => {
      await sql`call keeps_in(${8})`.execute(trx);
      await trx.insertInto('marks').values({ name: 'after the second call' }).execute();
    });
    expect(await names()).toEqual(['after the second call']);
    expect((await db.selectFrom('lockers').select('v').where('id', '=', 1).executeTakeFirstOrThrow()).v).toBe(8);
  });

  it('refuses a schema change of the builder in a transaction before it is sent, and the insert before it is rolled back', async () => {
    const events: Array<{ sql: string; error?: unknown }> = [];
    const stop = connections.onQuery((query) => events.push({ sql: query.sql, error: query.error }));
    const error = await thrown(
      connections.transaction(async (trx: Kysely<any>) => {
        await trx.insertInto('marks').values({ name: 'before' }).execute();
        await trx.schema.createTable('t3').addColumn('id', 'integer').execute();
      }),
    );
    stop?.();
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D30\] MySQL commits a transaction at a schema change/);
    expect(await names()).toEqual([]);
    // The log has the attempt, failed with the refusal: the server never saw a `create table`, and the table does not exist.
    expect(events.filter((event) => event.sql.startsWith('create table'))).toEqual([{ sql: expect.stringMatching(/^create table `t3`/), error: expect.any(TransactionError) }]);
    expect(await sql<{ n: number }>`select count(*) as n from information_schema.tables where table_schema = database() and table_name = 't3'`.execute(db).then((r) => Number(r.rows[0]!.n))).toBe(0);
  });

  it('lets a temporary table through, made and dropped, which MySQL does not commit for: the transaction stays open and rolls back', async () => {
    const error = await thrown(
      connections.transaction(async (trx: Kysely<any>) => {
        await trx.insertInto('marks').values({ name: 'before' }).execute();
        await trx.schema.createTable('scratch').temporary().addColumn('id', 'integer').execute();
        await trx.insertInto('marks').values({ name: 'middle' }).execute();
        await trx.schema.dropTable('scratch').temporary().execute();
        await trx.insertInto('marks').values({ name: 'after' }).execute();
        throw new Rollback();
      }),
    );
    expect(error).toBeInstanceOf(Rollback);
    expect(await names()).toEqual([]);
  });

  it('keeps the outer transaction when a savepoint of a caught duplicate-key error is rolled back, as on SQLite', async () => {
    await connections.transaction(async (trx: Kysely<any>) => {
      await trx.insertInto('marks').values({ name: 'taken' }).execute();
      const error = await thrown(connections.transaction(async (inner: Kysely<any>) => void (await inner.insertInto('marks').values({ name: 'taken' }).execute())));
      expect((error as { errno?: number }).errno).toBe(1062);
      await trx.insertInto('marks').values({ name: 'after' }).execute();
    });
    expect(await names()).toEqual(['after', 'taken']);
  });

  it('runs a transaction at its isolation level, shown by what it locks, and refuses a write in a read only one', async () => {
    // A serializable read takes a shared lock, so another connection cannot lock the row for update.
    const nowait = (id: number) => connections.transaction((other: Kysely<any>) => sql`select id from lockers where id = ${id} for update nowait`.execute(other));
    await connections.transaction(
      async (trx: Kysely<any>) => {
        await sql`select v from lockers where id = 1`.execute(trx);
        const blocked = await thrown(outsideTransaction(() => nowait(1)));
        expect((blocked as { errno?: number }).errno).toBe(3572);
      },
      { isolationLevel: 'serializable' },
    );
    // At the default level the same read takes no lock.
    await connections.transaction(async (trx: Kysely<any>) => {
      await sql`select v from lockers where id = 1`.execute(trx);
      expect((await outsideTransaction(() => nowait(1))).rows).toEqual([{ id: 1 }]);
    });
    const error = await thrown(db.transaction().setAccessMode('read only').execute(async (trx) => void (await trx.insertInto('marks').values({ name: 'nope' }).execute())));
    expect((error as { errno?: number }).errno).toBe(1792);
    expect(await names()).toEqual([]);
    // A read only transaction is a transaction: it can be committed, and its answers (IN_TRANS and read only) are not taken for an implicit commit.
    expect(await db.transaction().setAccessMode('read only').execute((trx) => trx.selectFrom('lockers').select('id').orderBy('id').execute())).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('does not take `set autocommit = 1` for an end: the transaction stays open, and rolls back whole', async () => {
    const error = await thrown(
      connections.transaction(async (trx: Kysely<any>) => {
        await trx.insertInto('marks').values({ name: 'before' }).execute();
        await sql`set autocommit = 1`.execute(trx);
        await trx.insertInto('marks').values({ name: 'after' }).execute();
        throw new Rollback();
      }),
    );
    expect(error).toBeInstanceOf(Rollback);
    expect(await names()).toEqual([]);
  });

  it('isolates a test in a transaction: its rows are undone, and a schema change of the builder is refused instead of committing them', async () => {
    const isolation = await connections.isolate();
    await db.insertInto('marks').values({ name: 'of the test' }).execute();
    const error = await thrown(db.schema.createTable('t4').addColumn('id', 'integer').execute());
    expect(error).toBeInstanceOf(TransactionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D30\] /);
    // The refusal sent nothing: the transaction is still the test's, and goes on.
    await db.insertInto('marks').values({ name: 'second' }).execute();
    await isolation.rollback();
    expect(await names()).toEqual([]);
  });

  it('under isolate(), a raw schema change ends the test’s transaction: what follows is refused (D24), and the rollback still goes out', async () => {
    const isolation = await connections.isolate();
    await db.insertInto('marks').values({ name: 'of the test' }).execute();
    await sql`create table t5 (id int)`.execute(db);
    const refused = await thrown(db.insertInto('marks').values({ name: 'after' }).execute());
    expect(refused).toBeInstanceOf(TransactionError);
    expect((refused as Error).message).toMatch(D24);
    await isolation.rollback();
    await sql`drop table t5`.execute(db);
    // The insert before the schema change was committed by it, the one after it never ran.
    expect(await names()).toEqual(['of the test']);
    await db.insertInto('marks').values({ name: 'works again' }).execute();
  });

  describe('after an answer without a status', () => {
    beforeAll(async () => {
      const setup = migratorConnection(connections);
      await sql`create procedure p_fail() begin select 1 as one; signal sqlstate '45000' set message_text = 'only a signal'; end`.execute(setup);
      await sql`create procedure commits_then_signals() begin update lockers set v = 3 where id = 1; commit; signal sqlstate '45000' set message_text = 'after the commit'; end`.execute(setup);
    });

    const afterwards = async (statement: (trx: Kysely<any>) => Promise<unknown>) => {
      let seen: unknown;
      let failure: unknown;
      const commit = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          failure = await thrown(statement(trx));
          seen = await thrown(trx.insertInto('marks').values({ name: 'after' }).execute());
        }),
      );
      return { failure, seen, commit };
    };

    it('asks the server first: rows of analyze table, a create table that failed, a drop of a missing table, a call that committed and then signalled', async () => {
      for (const statement of [
        (trx: Kysely<any>) => sql`analyze table lockers`.execute(trx),
        (trx: Kysely<any>) => sql`create table lockers (id int)`.execute(trx),
        (trx: Kysely<any>) => sql`drop table missing`.execute(trx),
        (trx: Kysely<any>) => sql`alter table missing add column a int`.execute(trx),
        (trx: Kysely<any>) => sql`call commits_then_signals()`.execute(trx),
      ]) {
        const { seen, commit } = await afterwards(statement);
        expect(seen, statement.toString()).toBeInstanceOf(TransactionError);
        expect((seen as Error).message).toMatch(D24);
        expect(commit).toBeInstanceOf(TransactionError);
        expect(await names()).toEqual([]);
      }
    });

    it('asks before a stream too: a stream after a create table that failed is refused, and nothing leaks', async () => {
      let streamed: unknown;
      let failure: unknown;
      const commit = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          await trx.insertInto('marks').values({ name: 'before' }).execute();
          failure = await thrown(sql`create table lockers (id int)`.execute(trx));
          streamed = await thrown(
            (async () => {
              for await (const _row of trx.selectFrom('lockers').selectAll().stream()) void _row;
            })(),
          );
        }),
      );
      expect((failure as { errno?: number }).errno).toBe(1050);
      expect(streamed).toBeInstanceOf(TransactionError);
      expect((streamed as Error).message).toMatch(D24);
      expect(commit).toBeInstanceOf(TransactionError);
      // The failed `create table` committed the insert before it, as a successful one does; the stream never ran.
      expect(await names()).toEqual(['before']);
    });

    it('asks after a stream that was left before its end: the next statement is asked about first, and the transaction goes on', async () => {
      await connections.transaction(async (trx: Kysely<any>) => {
        const before = await counted(trx, 'Com_do');
        for await (const _row of trx.selectFrom('lockers').selectAll().stream()) {
          void _row;
          break;
        }
        expect(await counted(trx, 'Com_do')).toBe(before + 1);
        await trx.insertInto('marks').values({ name: 'after the break' }).execute();
      });
      expect(await names()).toEqual(['after the break']);
    });

    it('does not cry wolf for a call that only signals: the transaction goes on and commits', async () => {
      const { failure, seen, commit } = await afterwards((trx) => sql`call p_fail()`.execute(trx));
      expect(failure).toBeDefined();
      expect(seen).toBeUndefined();
      expect(commit).toBeUndefined();
      expect(await names()).toEqual(['after']);
    });

    it('keeps the original error visible when a nested transaction fails with a statement that committed: nothing leaks, the outer commit is refused', async () => {
      let inner: unknown;
      let after: unknown;
      const commit = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          await trx.insertInto('marks').values({ name: 'before' }).execute();
          inner = await thrown(connections.transaction((nested: Kysely<any>) => sql`create table lockers (id int)`.execute(nested)));
          after = await thrown(trx.insertInto('marks').values({ name: 'after' }).execute());
        }),
      );
      // The error of the statement, not "SAVEPOINT does not exist" from the rollback of the savepoint.
      expect((inner as { errno?: number }).errno).toBe(1050);
      expect(after).toBeInstanceOf(TransactionError);
      expect(commit).toBeInstanceOf(TransactionError);
      // The `create table` that failed committed the insert before it, as a successful one does.
      expect(await names()).toEqual(['before']);
    });

    it('asks only after such an answer: a select in a transaction sends no question, a call that failed does', async () => {
      await connections.transaction(async (trx: Kysely<any>) => {
        const before = await counted(trx, 'Com_do');
        await sql`select 1`.execute(trx);
        await trx.selectFrom('lockers').selectAll().execute();
        await trx.updateTable('lockers').set({ v: 1 }).where('id', '=', 1).execute();
        expect(await counted(trx, 'Com_do')).toBe(before);
        await thrown(sql`call p_fail()`.execute(trx));
        // The reading itself is the statement that comes after, so the question went out before it.
        expect(await counted(trx, 'Com_do')).toBe(before + 1);
        expect(await counted(trx, 'Com_do')).toBe(before + 1);
      });
    });
  });

  describe('a version comment', () => {
    it('is read against the version of the server: one of a newer version hides nothing that runs, so no commit is taken for one (a transaction that goes on)', async () => {
      await connections.transaction(async (trx: Kysely<any>) => {
        await trx.insertInto('marks').values({ name: 'before' }).execute();
        await sql.raw('/*!99999 COMMIT */ SELECT 1').execute(trx);
        await sql.raw('/*!80000 select 1 */').execute(trx);
        await trx.insertInto('marks').values({ name: 'after' }).execute();
      });
      expect(await names()).toEqual(['after', 'before']);
    });

    it.each(['/*!80000 begin */', '/*!99999 x */ /*!80000 begin */', '/*!80000 commit and chain */', '/*!99999 /* a */ x */ begin'])('that runs a begin or commit ends the transaction for what follows: %s', async (statement) => {
      let after: unknown;
      const commit = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          await sql.raw(statement).execute(trx);
          after = await thrown(trx.insertInto('marks').values({ name: 'after' }).execute());
        }),
      );
      expect(after).toBeInstanceOf(TransactionError);
      expect(commit).toBeInstanceOf(TransactionError);
      expect(await names()).toEqual([]);
    });
  });

  describe('a session that changes how transactions end', () => {
    it('refuses what follows a change of completion_type, the commit included, before anything is committed: another connection sees nothing', async () => {
      let after: unknown;
      const error = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          await trx.insertInto('marks').values({ name: 'chained' }).execute();
          await sql`set session completion_type = 1`.execute(trx);
          after = await thrown(trx.insertInto('marks').values({ name: 'after' }).execute());
        }),
      );
      expect(after).toBeInstanceOf(DatabaseConnectionError);
      expect((after as Error).message).toMatch(/^\[marmeon:D28\] .*completion_type is no longer NO_CHAIN \(now "CHAIN"\)/);
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      // The connection was discarded with its transaction: the commit never went out.
      expect(await names()).toEqual([]);
      await connections.transaction(async (trx: Kysely<any>) => void (await trx.insertInto('marks').values({ name: 'next' }).execute()));
      expect(await names()).toEqual(['next']);
    });

    it('refuses everything after autocommit is turned off, and discards the connection', async () => {
      // One connection for both statements: a lease ends at its release, and the next one starts from the reset.
      const refused = await db.connection().execute(async (connection) => {
        await sql`set autocommit = 0`.execute(connection);
        return thrown(connection.selectFrom('lockers').selectAll().execute());
      });
      expect(refused).toBeInstanceOf(DatabaseConnectionError);
      expect((refused as Error).message).toMatch(/autocommit is OFF/);
      expect(await db.selectFrom('lockers').select('id').orderBy('id').execute()).toEqual([{ id: 1 }, { id: 2 }]);
    });
  });

  describe('a stored procedure', () => {
    beforeAll(async () => {
      const setup = migratorConnection(connections);
      await sql`create procedure keeps() begin select 1 as one; update lockers set v = 7 where id = 1; end`.execute(setup);
      await sql`create procedure commits() begin update lockers set v = 8 where id = 1; commit; end`.execute(setup);
      await sql`create procedure opens() begin start transaction; update lockers set v = 9 where id = 2; end`.execute(setup);
    });

    it('that stays in the transaction leaves it open: its answer says IN_TRANS', async () => {
      await connections.transaction(async (trx: Kysely<any>) => {
        await sql`call keeps()`.execute(trx);
        await trx.insertInto('marks').values({ name: 'after the call' }).execute();
        await sql`call keeps()`.execute(trx);
        await trx.insertInto('marks').values({ name: 'after the second call' }).execute();
      });
      expect(await names()).toEqual(['after the call', 'after the second call']);
    });

    it('that commits ends the transaction for what follows, however its answer is read', async () => {
      let after: unknown;
      const commit = await thrown(
        connections.transaction(async (trx: Kysely<any>) => {
          await sql`call commits()`.execute(trx);
          after = await thrown(trx.insertInto('marks').values({ name: 'after the call' }).execute());
        }),
      );
      expect(after).toBeInstanceOf(TransactionError);
      expect(commit).toBeInstanceOf(TransactionError);
      expect(await names()).toEqual([]);
    });

    it('that begins a transaction of its own while none is open leaves no lock for the next transaction: the reset of the way back ended it', async () => {
      await sql`call opens()`.execute(db);
      // `nowait` fails at once on a row that another transaction still holds.
      expect(await connections.transaction((trx: Kysely<any>) => sql`select id from lockers where id = 2 for update nowait`.execute(trx).then((result) => result.rows))).toEqual([{ id: 2 }]);
    });
  });
});
