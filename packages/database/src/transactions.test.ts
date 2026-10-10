import { setTimeout as sleep } from 'node:timers/promises';
import type { Generated, Kysely } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drivers, freshConnections } from './__fixtures__/databases.ts';
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
    // @ts-expect-error — the options are an object: { connection: 'reporting' }
    await connections.transaction(async () => {}, 'reporting');
    return count;
  });
});
