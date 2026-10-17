import { sql } from '@marmeon/database';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, queueKinds, queueUnderTest, type QueueUnderTest } from '../__fixtures__/targets.ts';
import type { ReservedJob } from '../driver.ts';
import { claimAnyStatement, DatabaseQueueDriver, FAIR_CLAIM_INDEX } from './database.ts';

async function withQueue(kind: (typeof queueKinds)[number], test: (queue: QueueUnderTest) => Promise<void>, options: { retryAfter?: number } = {}): Promise<void> {
  const queue = await queueUnderTest(kind, options);
  try {
    await test(queue);
  } finally {
    await queue.close();
  }
}

// One suite, every driver: the contract a worker relies on.
describe.each(queueKinds)('the %s queue driver', (kind) => {
  it('hands out jobs oldest first, counting the attempt at the claim', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('default', 'a', 0);
      await driver.push('default', 'b', 0);
      const first = await driver.reserve(['default']);
      const second = await driver.reserve(['default']);
      expect([first?.payload, second?.payload]).toEqual(['a', 'b']);
      expect(first?.attempts).toBe(1);
      expect(await driver.reserve(['default'])).toBeUndefined();
      expect(await driver.size('default')).toBe(2);
    });
  });

  it('takes the queues in the order given', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('default', 'later', 0);
      await driver.push('mail', 'first', 0);
      expect((await driver.reserve(['mail', 'default']))?.payload).toBe('first');
      expect((await driver.reserve(['mail', 'default']))?.payload).toBe('later');
      expect(await driver.reserve(['other'])).toBeUndefined();
    });
  });

  it('keeps a delayed job back until its time (the queue clock)', async () => {
    await withQueue(kind, async ({ driver, clock }) => {
      clock.freeze();
      await driver.push('default', 'later', 30);
      expect(await driver.reserve(['default'])).toBeUndefined();
      clock.travel({ seconds: 30 });
      expect((await driver.reserve(['default']))?.payload).toBe('later');
    });
  });

  it('acknowledges by removing the job', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('default', 'a', 0);
      const job = (await driver.reserve(['default']))!;
      expect(await driver.ack(job)).toBe(true);
      expect(await driver.size('default')).toBe(0);
      expect(await driver.ack(job)).toBe(false);
    });
  });

  it('releases a job back, with a delay, keeping the attempt', async () => {
    await withQueue(kind, async ({ driver, clock }) => {
      clock.freeze();
      await driver.push('default', 'a', 0);
      const job = (await driver.reserve(['default']))!;
      expect(await driver.release(job, 10)).toBe(true);
      expect(await driver.reserve(['default'])).toBeUndefined();
      clock.travel({ seconds: 10 });
      const again = (await driver.reserve(['default']))!;
      expect(again.attempts).toBe(2);
      expect(await driver.fail(again)).toBe(true);
      expect(await driver.size('default')).toBe(0);
    });
  });

  it('writes the time a released job can be claimed again into its record, when asked to', async () => {
    await withQueue(kind, async ({ driver, clock }) => {
      clock.freeze();
      await driver.push('default', JSON.stringify({ v: 1, job: 'a', availableAt: 1 }), 0);
      const job = (await driver.reserve(['default']))!;
      const at = clock.now() + 10_000;
      expect(await driver.release(job, 10, { availableAt: at })).toBe(true);
      clock.travel({ seconds: 10 });
      const again = (await driver.reserve(['default']))!;
      expect(JSON.parse(again.payload)).toEqual({ v: 1, job: 'a', availableAt: at });
      // A payload that is no JSON object stays as it is.
      expect(await driver.fail(again)).toBe(true);
      await driver.push('default', 'plain', 0);
      const plain = (await driver.reserve(['default']))!;
      expect(await driver.release(plain, 0, { availableAt: at })).toBe(true);
      expect((await driver.reserve(['default']))!.payload).toBe('plain');
    });
  });

  it('releases a job back with its attempt given back (refund) — the next claim is the same attempt', async () => {
    await withQueue(kind, async ({ driver, clock }) => {
      clock.freeze();
      await driver.push('default', 'a', 0);
      const job = (await driver.reserve(['default']))!;
      expect(await driver.release(job, 5, { refund: true })).toBe(true);
      clock.travel({ seconds: 5 });
      const again = (await driver.reserve(['default']))!;
      expect(again.attempts).toBe(1);
      expect(await driver.ack(again)).toBe(true);
      expect(await driver.size('default')).toBe(0);
    });
  });

  it('hands a claimed job out again after retryAfter (its worker died) — and the old claim can no longer touch it', async () => {
    await withQueue(
      kind,
      async ({ driver, clock }) => {
        clock.freeze();
        await driver.push('default', 'a', 0);
        const lost = (await driver.reserve(['default']))!;
        clock.travel({ seconds: 59 });
        expect(await driver.reserve(['default'])).toBeUndefined();
        clock.travel({ seconds: 1 });
        const taken = (await driver.reserve(['default']))!;
        expect(taken.payload).toBe('a');
        expect(taken.attempts).toBe(2);
        // The first worker comes back late: its ack, release and fail change nothing.
        expect(await driver.release(lost, 0)).toBe(false);
        expect(await driver.ack(lost)).toBe(false);
        expect(await driver.fail(lost)).toBe(false);
        expect(await driver.size('default')).toBe(1);
        expect(await driver.ack(taken)).toBe(true);
      },
      { retryAfter: 60 },
    );
  });

  it('acknowledges and queues the next job of a chain in one step — only while the claim is its own', async () => {
    await withQueue(
      kind,
      async ({ driver, clock }) => {
        clock.freeze();
        await driver.push('default', 'first', 0);
        const lost = (await driver.reserve(['default']))!;
        clock.travel({ seconds: 60 });
        const taken = (await driver.reserve(['default']))!;
        // The late worker's hand-off changes nothing: no second "next".
        expect(await driver.ack(lost, [{ queue: 'default', payload: 'next', delay: 0 }])).toBe(false);
        expect(await driver.size('default')).toBe(1);
        expect(await driver.ack(taken, [{ queue: 'later', payload: 'next', delay: 0 }, { queue: 'later', payload: 'delayed', delay: 30 }])).toBe(true);
        expect(await driver.size('default')).toBe(0);
        expect(await driver.size('later')).toBe(2);
        expect((await driver.reserve(['later']))?.payload).toBe('next');
        expect(await driver.reserve(['later'])).toBeUndefined();
        clock.travel({ seconds: 30 });
        expect((await driver.reserve(['later']))?.payload).toBe('delayed');
      },
      { retryAfter: 60 },
    );
  });

  it('counts waiting, delayed and running jobs, and lists its queues', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('mail', 'a', 0);
      await driver.push('mail', 'b', 60);
      await driver.push('default', 'c', 0);
      await driver.reserve(['mail']);
      expect(await driver.size('mail')).toBe(2);
      expect(await driver.queues()).toEqual(['default', 'mail']);
      // Split up (the devtools' queue view): one running, one delayed — and the default queue's one ready.
      expect(await driver.counts!('mail')).toEqual({ ready: 0, delayed: 1, reserved: 1 });
      expect(await driver.counts!('default')).toEqual({ ready: 1, delayed: 0, reserved: 0 });
      expect(await driver.counts!('nothing')).toEqual({ ready: 0, delayed: 0, reserved: 0 });
    });
  });

  it('reserveAny: takes every queue fairly — a mail job behind a full default queue is not starved', async () => {
    await withQueue(kind, async ({ driver, clock }) => {
      clock.freeze();
      for (const payload of ['a1', 'a2']) await driver.push('default', payload, 0);
      await driver.push('mail', 'mail', 0);
      for (const payload of ['b1', 'b2']) await driver.push('default', payload, 0);
      const order: string[] = [];
      for (let job = await driver.reserveAny!(); job; job = await driver.reserveAny!()) order.push(job.payload);
      // The database (and memory): the job that became due first, whatever its queue. Redis: the queues in turn.
      const expected = kind === 'redis' ? 'a1 mail a2 b1 b2' : 'a1 a2 mail b1 b2';
      expect(order.join(' '), `taken in this order: ${order.join(' ')}`).toBe(expected);
    });
  });

  it('reserveAny: leaves the queues it is told to — the * of --queue=mail,*', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('mail', 'mail', 0);
      await driver.push('default', 'default', 0);
      expect((await driver.reserveAny!(['mail']))?.payload).toBe('default');
      expect(await driver.reserveAny!(['mail'])).toBeUndefined();
      expect((await driver.reserveAny!())?.payload).toBe('mail');
    });
  });

  it('reserveAny: keeps a delayed job back and takes an expired claim (its worker died) again', async () => {
    await withQueue(
      kind,
      async ({ driver, clock }) => {
        clock.freeze();
        await driver.push('default', 'later', 30);
        await driver.push('mail', 'lost', 0);
        expect((await driver.reserveAny!())?.payload).toBe('lost');
        expect(await driver.reserveAny!()).toBeUndefined();
        clock.travel({ seconds: 30 });
        await driver.push('reports', 'fresh', 0);
        clock.travel({ seconds: 30 });
        const taken: string[] = [];
        for (let job = await driver.reserveAny!(); job; job = await driver.reserveAny!()) taken.push(`${job.payload}#${job.attempts}`);
        // The database: an expired claim first, then by when a job became due. Redis: the queues in turn (after mail, whose job it took last).
        expect(taken.join(' ')).toBe(kind === 'redis' ? 'fresh#1 later#1 lost#2' : 'lost#2 later#1 fresh#1');
      },
      { retryAfter: 60 },
    );
  });

  it('reserveAny: takes a queue that appears after the worker started', async () => {
    await withQueue(kind, async ({ driver }) => {
      await driver.push('default', 'first', 0);
      expect((await driver.reserveAny!())?.payload).toBe('first');
      expect(await driver.reserveAny!()).toBeUndefined();
      await driver.push('reports', 'new queue', 0);
      expect((await driver.reserveAny!())?.payload, 'a queue pushed to after the first claim').toBe('new queue');
    });
  });

  it('keeps failed jobs, newest first; prunes, forgets and flushes them', async () => {
    await withQueue(kind, async ({ failed }) => {
      const base = { connection: 'database', queue: 'default', job: 'test.job', payload: '{}', exception: 'Error: boom' };
      await failed.record({ ...base, uuid: 'a', failedAt: 1000 });
      await failed.record({ ...base, uuid: 'b', failedAt: 2000 });
      await failed.record({ ...base, uuid: 'a', failedAt: 3000, exception: 'Error: again' });
      expect((await failed.all()).map((job) => job.uuid)).toEqual(['a', 'b']);
      expect((await failed.find('a'))?.exception).toBe('Error: again');
      expect(await failed.prune(2500)).toBe(1);
      expect(await failed.forget('a')).toBe(true);
      expect(await failed.forget('a')).toBe(false);
      await failed.record({ ...base, uuid: 'c', failedAt: 4000 });
      expect(await failed.flush()).toBe(1);
      expect(await failed.all()).toEqual([]);
    });
  });
});

describe.each(databaseKinds)('the database queue driver on %s, in a transaction', (kind) => {
  it('queues a job dispatched in a transaction only with its commit — and not at all after a rollback', async () => {
    await withQueue(kind, async ({ driver, connections, target }) => {
      const db = connections!.get();
      const database = driver as DatabaseQueueDriver;
      // A second process's view: its own connections.
      const other = databaseConnections(connectionOptions(target as Exclude<typeof target, { kind: 'memory' }>));
      const outside = new DatabaseQueueDriver({ db: other.get(), driver: kind }, { retryAfter: 90 });
      try {
        await db
          .transaction()
          .execute(async (trx) => {
            await database.using(trx).push('default', 'rolled back', 0);
            throw new Error('rollback');
          })
          .catch(() => {});
        expect(await outside.size('default')).toBe(0);

        let seenBeforeCommit = -1;
        await db.transaction().execute(async (trx) => {
          await database.using(trx).push('default', 'committed', 0);
          // SQLite has one writer: the other connection reads the last committed state (WAL).
          seenBeforeCommit = await outside.size('default');
        });
        expect(seenBeforeCommit).toBe(0);
        expect((await outside.reserve(['default']))?.payload).toBe('committed');
      } finally {
        await other.destroy();
      }
    });
  });

  it('hands a chain on in one transaction: when queuing the next job fails, the job stays claimed (and runs again)', async () => {
    await withQueue(kind, async ({ driver, connections }) => {
      const db = connections!.get();
      // The next job cannot be inserted — a failure between the acknowledgement and the hand-off.
      if (kind === 'sqlite') {
        await sql`create trigger refuse before insert on marmeon_jobs when new.payload = 'explode' begin select raise(abort, 'refused'); end`.execute(db);
      } else {
        await sql.raw(`create function refuse() returns trigger language plpgsql as $$ begin if new.payload = 'explode' then raise exception 'refused'; end if; return new; end $$`).execute(db);
        await sql`create trigger refuse before insert on marmeon_jobs for each row execute function refuse()`.execute(db);
      }
      await driver.push('default', 'first', 0);
      const job = (await driver.reserve(['default']))!;
      await expect(driver.ack(job, [{ queue: 'default', payload: 'explode', delay: 0 }])).rejects.toThrow(/refused/);
      // Not acknowledged: still there, still claimed — after retryAfter it runs again and hands on then.
      const { rows } = await sql<{ payload: string; reserved_at: unknown }>`select payload, reserved_at from marmeon_jobs`.execute(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload).toBe('first');
      expect(rows[0]!.reserved_at).not.toBeNull();
    });
  });

  it('reserveAny asks the database once per round, whatever the number of queues', async () => {
    await withQueue(kind, async ({ connections, clock }) => {
      let statements = 0;
      const counting = connections!.get().withPlugin({
        transformQuery: ({ node }) => (statements++, node),
        transformResult: async ({ result }) => result,
      });
      const driver = new DatabaseQueueDriver({ db: counting, driver: kind }, { retryAfter: 90, clock });
      for (const queue of ['default', 'mail', 'reports']) await driver.push(queue, 'later', 60);
      statements = 0;
      expect(await driver.reserveAny()).toBeUndefined();
      expect(statements, 'statements of an idle round of reserveAny').toBe(1);
      statements = 0;
      expect(await driver.reserve(['default', 'mail', 'reports'])).toBeUndefined();
      expect(statements, 'statements of an idle round of reserve — one per queue').toBe(3);
    });
  });

  it('reserveAny claims through the index of the fair claim — no sort, no scan of every due job (EXPLAIN)', async () => {
    await withQueue(kind, async ({ connections }) => {
      const claim = claimAnyStatement(sql, kind, { now: 2_000_000, expired: 1_000_000, except: [] });
      const plan =
        kind === 'sqlite'
          ? (await sql<{ detail: string }>`explain query plan ${claim}`.execute(connections!.get())).rows.map((row) => row.detail).join(' | ')
          : await connections!
              .get()
              .transaction()
              .execute(async (trx) => {
                // An empty table is read whole by Postgres anyway: without sequential scans the plan shows which index it would walk.
                await sql`set local enable_seqscan = off`.execute(trx);
                return (await sql<{ 'QUERY PLAN': string }>`explain ${claim}`.execute(trx)).rows.map((row) => row['QUERY PLAN'].trim()).join(' | ');
              });
      expect(plan.split(FAIR_CLAIM_INDEX).length - 1, `both subqueries walk ${FAIR_CLAIM_INDEX}: ${plan}`).toBe(2);
      expect(plan, `no sort and no full scan: ${plan}`).not.toMatch(/TEMP B-TREE|Sort|SCAN jobs|Seq Scan/);
      // Postgres: each subquery locks the row it found, skipping rows other workers are claiming (FOR UPDATE SKIP LOCKED).
      if (kind === 'pgsql') expect(plan.split('LockRows').length - 1, `both subqueries lock their row: ${plan}`).toBe(2);
    });
  });

  it('stores times as whole milliseconds (node:sqlite binds numbers as REAL)', async () => {
    await withQueue(kind, async ({ driver, connections, clock }) => {
      clock.freeze(1_790_000_000_123);
      await driver.push('default', 'a', 1.5);
      const job = (await driver.reserve(['default'])) as ReservedJob | undefined;
      expect(job).toBeUndefined();
      const { rows } = await sql<{ available_at: unknown; typeof?: string }>`select available_at from marmeon_jobs`.execute(connections!.get());
      expect(String(rows[0]!.available_at)).toBe('1790000001623');
    });
  });
});
