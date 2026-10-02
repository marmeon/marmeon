import { sql } from '@bespokecore/database';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, queueKinds, queueUnderTest, type QueueUnderTest } from '../__fixtures__/targets.ts';
import type { ReservedJob } from '../driver.ts';
import { DatabaseQueueDriver } from './database.ts';

async function withQueue(kind: (typeof queueKinds)[number], test: (queue: QueueUnderTest) => Promise<void>, options: { retryAfter?: number } = {}): Promise<void> {
  const queue = await queueUnderTest(kind, options);
  try {
    await test(queue);
  } finally {
    await queue.close();
  }
}

// One suite, every driver (E83): the contract a worker relies on.
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

describe.each(databaseKinds)('the database queue driver on %s, in a transaction (E85)', (kind) => {
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

  it('stores times as whole milliseconds (node:sqlite binds numbers as REAL)', async () => {
    await withQueue(kind, async ({ driver, connections, clock }) => {
      clock.freeze(1_790_000_000_123);
      await driver.push('default', 'a', 1.5);
      const job = (await driver.reserve(['default'])) as ReservedJob | undefined;
      expect(job).toBeUndefined();
      const { rows } = await sql<{ available_at: unknown; typeof?: string }>`select available_at from jobs`.execute(connections!.get());
      expect(String(rows[0]!.available_at)).toBe('1790000001623');
    });
  });
});
