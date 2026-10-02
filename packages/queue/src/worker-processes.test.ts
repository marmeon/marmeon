import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Connections } from '@bespokecore/database';
import { describe, expect, it } from 'vitest';
import { connectionOptions, databaseConnections, databaseKinds, freshTarget, kill, PGSQL_URL, startWorker, type QueueTarget, type WorkerProcess } from './__fixtures__/targets.ts';
import { DatabaseQueueDriver } from './drivers/database.ts';

type DatabaseTarget = Exclude<QueueTarget, { kind: 'memory' }>;

/** A job record as the queue stores it, for the fixture app's jobs. */
function record(job: string, data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid: crypto.randomUUID(), job, data, tries: 3, backoff: [], dispatchedAt: Date.now(), ...extra });
}

interface Fixture {
  readonly target: DatabaseTarget;
  readonly connections: Connections;
  readonly driver: DatabaseQueueDriver;
  readonly workers: WorkerProcess[];
  handled(event?: string): Promise<{ uuid: string; n: number; attempt: number; pid: number; event: string }[]>;
  jobs(): Promise<{ id: number; attempts: number; reserved_at: number | null }[]>;
  failed(): Promise<{ uuid: string; job: string; exception: string }[]>;
  until<T>(check: () => Promise<T | undefined | false>, ms?: number): Promise<T>;
  worker(args: readonly string[], env?: Record<string, string>): WorkerProcess;
}

async function withFixture(kind: DatabaseTarget['kind'], test: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { target, drop } = await freshTarget(kind);
  const connections = databaseConnections(connectionOptions(target as DatabaseTarget));
  const db = connections.get();
  const workers: WorkerProcess[] = [];
  const fixture: Fixture = {
    target: target as DatabaseTarget,
    connections,
    driver: new DatabaseQueueDriver({ db, driver: kind }, { retryAfter: 90 }),
    workers,
    handled: async (event) =>
      (await sql<any>`select * from handled ${event ? sql`where event = ${event}` : sql``} order by n, attempt`.execute(db)).rows.map((row) => ({
        ...row,
        n: Number(row.n),
        attempt: Number(row.attempt),
        pid: Number(row.pid),
      })),
    jobs: async () => (await sql<any>`select id, attempts, reserved_at from jobs order by id`.execute(db)).rows,
    failed: async () => (await sql<any>`select uuid, job, exception from failed_jobs`.execute(db)).rows,
    until: async (check, ms = 20_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const value = await check();
        if (value !== undefined && value !== false) return value as never;
        if (Date.now() > deadline) throw new Error(`Timed out after ${ms} ms. Worker output:\n${workers.map((worker) => worker.lines.join('\n')).join('\n---\n')}`);
        await sleep(50);
      }
    },
    worker: (args, env) => {
      const worker = startWorker(target as DatabaseTarget, args, env);
      workers.push(worker);
      return worker;
    },
  };
  try {
    await test(fixture);
  } finally {
    for (const worker of workers) kill(worker);
    await Promise.all(workers.map((worker) => worker.exited(5000).catch(() => {})));
    await connections.destroy();
    await drop();
  }
}

// The Gegenproben of the queue core (W6 step 3) with real `bespoke queue:work` processes on a shared database.
describe.each(databaseKinds)('queue:work processes on %s', (kind) => {
  it(
    'runs each of 200 jobs exactly once with two workers taking from one queue',
    { timeout: 90_000 },
    async () => {
      await withFixture(kind, async (fixture) => {
        const a = fixture.worker(['--sleep=0.01']);
        const b = fixture.worker(['--sleep=0.01']);
        await Promise.all([a.waitFor(/^Processing jobs of the database connection/), b.waitFor(/^Processing jobs of the database connection/)]);
        // All 200 appear at once, with the commit — both workers race for them from the first.
        await fixture.connections.get().transaction().execute(async (trx) => {
          const driver = fixture.driver.using(trx);
          for (let n = 0; n < 200; n++) await driver.push('default', record('fixture.record', { n }), 0);
        });
        await fixture.until(async () => (await fixture.jobs()).length === 0 && (await fixture.handled()).length >= 200, 60_000);
        await sleep(200); // a duplicate still in flight would land now
        a.child.kill('SIGTERM');
        b.child.kill('SIGTERM');
        expect(await a.exited()).toBe(0);
        expect(await b.exited()).toBe(0);

        const handled = await fixture.handled();
        const runs = new Map<number, number>();
        for (const row of handled) runs.set(row.n, (runs.get(row.n) ?? 0) + 1);
        const twice = [...runs].filter(([, count]) => count > 1).map(([n]) => n);
        expect(twice, `jobs that ran more than once: ${twice.join(', ')}`).toEqual([]);
        expect(runs.size).toBe(200);
        // Both took part (otherwise the race proved nothing).
        expect(new Set(handled.map((row) => row.pid)).size).toBe(2);
      });
    },
  );

  it('runs a job again after retryAfter when its worker was killed mid-job (SIGKILL) — attempt 2, same id', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      await fixture.driver.push('default', record('fixture.stubborn', { n: 1 }), 0);
      const env = { DB_QUEUE_RETRY_AFTER: '3' };
      const a = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
      const [started] = await fixture.until(async () => {
        const rows = await fixture.handled('started');
        return rows.length > 0 && rows;
      });
      a.child.kill('SIGKILL');
      expect(await a.exited()).toBe('SIGKILL');
      expect(await fixture.jobs()).toMatchObject([{ attempts: 1 }]);

      const b = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
      const [done] = await fixture.until(async () => {
        const rows = await fixture.handled('done');
        return rows.length > 0 && rows;
      }, 12_000);
      expect(done).toMatchObject({ uuid: started!.uuid, attempt: 2 });
      await fixture.until(async () => (await fixture.jobs()).length === 0);
      b.child.kill('SIGTERM');
      expect(await b.exited()).toBe(0);
    });
  });

  it('ends a worker whose job ignores its timeout (after the grace period), and a second worker takes the job over after retryAfter', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      await fixture.driver.push('default', record('fixture.stubborn', { n: 1 }), 0);
      const env = { DB_QUEUE_RETRY_AFTER: '3' };
      const a = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
      // Timeout 1 s, grace 1 s: the worker must give up on its own, with the exit code supervisors see.
      expect(await a.exited(8000)).toBe(70);
      expect(a.lines.join('\n')).toMatch(/fixture\.stubborn ignored its timeout of 1s/);

      const b = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
      const [done] = await fixture.until(async () => {
        const rows = await fixture.handled('done');
        return rows.length > 0 && rows;
      }, 12_000);
      expect(done!.attempt).toBe(2);
      b.child.kill('SIGTERM');
      await b.exited();
    });
  });

  it('on SIGTERM finishes and acknowledges the running job, claims no other, and exits with 0', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      await fixture.driver.push('default', record('fixture.slow', { n: 1, ms: 600 }), 0);
      await fixture.driver.push('default', record('fixture.record', { n: 2 }), 0);
      const worker = fixture.worker(['--stop-timeout=3', '--sleep=0.05']);
      await fixture.until(async () => (await fixture.handled('started')).length > 0);
      worker.child.kill('SIGTERM');
      expect(await worker.exited()).toBe(0);
      expect((await fixture.handled()).map((row) => `${row.n}:${row.event}`)).toEqual(['1:started', '1:done']);
      // The slow job is acknowledged (gone); the other was never claimed.
      expect(await fixture.jobs()).toMatchObject([{ attempts: 0, reserved_at: null }]);
      expect(await fixture.failed()).toEqual([]);
    });
  });

  it('on SIGTERM releases a job that does not finish within the stop timeout, and exits with 0', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      // A minute of work that ignores its signal (and keeps the process busy): the worker still ends, with 0, in seconds.
      await fixture.driver.push('default', record('fixture.slow', { n: 1, ms: 60_000 }), 0);
      const worker = fixture.worker(['--stop-timeout=0.3', '--sleep=0.05'], { DB_QUEUE_RETRY_AFTER: '30' });
      await fixture.until(async () => (await fixture.handled('started')).length > 0);
      worker.child.kill('SIGTERM');
      expect(await worker.exited(8000)).toBe(0);
      // Back in the queue for the next worker, the attempt counted.
      expect(await fixture.jobs()).toMatchObject([{ attempts: 1, reserved_at: null }]);
      expect(worker.lines.join('\n')).toMatch(/Released fixture\.slow: the worker is stopping/);
    });
  });

  it('refuses to start when retryAfter is not longer than a job timeout plus the stop timeout', { timeout: 30_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const worker = fixture.worker(['--stop-timeout=1'], { DB_QUEUE_RETRY_AFTER: '2' });
      expect(await worker.exited()).toBe(1);
      expect(worker.lines.join('\n')).toMatch(/gives a claimed job 2s \(retryAfter\).*fixture\.record \(timeout 1s\)/);
    });
  });

  it('fails a job whose payload no longer matches its schema after ONE attempt (written straight into the table)', { timeout: 30_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const uuid = crypto.randomUUID();
      const payload = JSON.stringify({ uuid, job: 'fixture.user', data: { userId: 'x' }, tries: 5, backoff: [0], dispatchedAt: 0 });
      await sql`insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at) values ('default', ${payload}, 0, null, 0, 0)`.execute(fixture.connections.get());
      const worker = fixture.worker(['--stop-when-empty']);
      expect(await worker.exited()).toBe(0);
      expect(await fixture.jobs()).toEqual([]);
      expect(await fixture.handled()).toEqual([]);
      const [failed] = await fixture.failed();
      expect(failed).toMatchObject({ uuid, job: 'fixture.user' });
      expect(failed!.exception).toMatch(/The payload no longer matches the schema of fixture\.user: userId: Invalid type: Expected number but received "x"/);
      const output = worker.lines.join('\n');
      expect(output).not.toMatch(/again in/);
      expect(output).toMatch(/Failed fixture\.user at once \(it cannot run\).*"attempt":1/);
    });
  });
});

if (!PGSQL_URL) describe.skip('queue:work processes on pgsql (set BESPOKE_TEST_PGSQL_URL: pnpm test:pgsql)', () => it('runs', () => {}));
