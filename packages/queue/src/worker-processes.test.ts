import { setTimeout as sleep } from 'node:timers/promises';
import { sql, type Connections } from '@bespokecore/database';
import { describe, expect, it } from 'vitest';
import {
  connectionOptions,
  databaseConnections,
  freshTarget,
  kill,
  openDriver,
  PGSQL_URL,
  processKinds,
  redisConnections,
  REDIS_URL,
  startDispatcher,
  startWorker,
  type SharedTarget,
  type WorkerProcess,
} from './__fixtures__/targets.ts';
import type { QueueDriver } from './driver.ts';

/** A job record as the queue stores it, for the fixture app's jobs. */
function record(job: string, data: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ uuid: crypto.randomUUID(), job, data, tries: 3, backoff: [], dispatchedAt: Date.now(), ...extra });
}

interface Fixture {
  readonly target: SharedTarget;
  readonly connections: Connections;
  /** The target's queue, as this (the test's) process sees it. */
  readonly driver: QueueDriver;
  readonly workers: WorkerProcess[];
  handled(event?: string): Promise<{ uuid: string; n: number; attempt: number; pid: number; event: string; at: number }[]>;
  /** The jobs of the default queue, oldest first: their attempts, and whether a worker holds them. */
  jobs(): Promise<{ attempts: number; reserved: boolean }[]>;
  failed(): Promise<{ uuid: string; job: string; exception: string }[]>;
  until<T>(check: () => Promise<T | undefined | false>, ms?: number): Promise<T>;
  worker(args: readonly string[], env?: Record<string, string>): WorkerProcess;
  /** `bespoke fixture:dispatch …` — started, ready, waiting for "go". */
  dispatcher(args: readonly string[]): Promise<WorkerProcess>;
  /** The env name of the target's retryAfter. */
  retryAfter(seconds: number): Record<string, string>;
}

async function withFixture(kind: SharedTarget['kind'], test: (fixture: Fixture) => Promise<void>): Promise<void> {
  const { target: fresh, drop } = await freshTarget(kind);
  const target = fresh as SharedTarget;
  const connections = databaseConnections(connectionOptions(target));
  const db = connections.get();
  const queue = openDriver(target, connections);
  const workers: WorkerProcess[] = [];
  const fixture: Fixture = {
    target,
    connections,
    driver: queue.driver,
    workers,
    handled: async (event) =>
      (await sql<any>`select * from handled ${event ? sql`where event = ${event}` : sql``} order by n, attempt`.execute(db)).rows.map((row) => ({
        ...row,
        n: Number(row.n),
        attempt: Number(row.attempt),
        pid: Number(row.pid),
        at: Number(row.at),
      })),
    jobs: async () => {
      if (target.kind !== 'redis') {
        const { rows } = await sql<any>`select attempts, reserved_at from jobs order by id`.execute(db);
        return rows.map((row) => ({ attempts: Number(row.attempts), reserved: row.reserved_at !== null }));
      }
      const redis = redisConnections(target.url, target.prefix);
      try {
        const key = redis.get().key('queues:default');
        const attempts = (member: string) => Number(member.split(':')[1]);
        const waiting = await redis.get().command<string[]>(['LRANGE', key, 0, -1]);
        const delayed = await redis.get().command<string[]>(['ZRANGE', `${key}:delayed`, 0, -1]);
        const reserved = await redis.get().command<string[]>(['ZRANGE', `${key}:reserved`, 0, -1]);
        return [...reserved.map((member) => ({ attempts: attempts(member), reserved: true })), ...[...waiting, ...delayed].map((member) => ({ attempts: attempts(member), reserved: false }))];
      } finally {
        await redis.close();
      }
    },
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
      const worker = startWorker(target, args, env);
      workers.push(worker);
      return worker;
    },
    dispatcher: async (args) => {
      const dispatcher = startDispatcher(target, args);
      workers.push(dispatcher);
      await dispatcher.waitFor(/^ready$/);
      return dispatcher;
    },
    retryAfter: (seconds) => ({ [target.kind === 'redis' ? 'REDIS_QUEUE_RETRY_AFTER' : 'DB_QUEUE_RETRY_AFTER']: String(seconds) }),
  };
  try {
    await test(fixture);
  } finally {
    for (const worker of workers) kill(worker);
    await Promise.all(workers.map((worker) => worker.exited(5000).catch(() => {})));
    await queue.close();
    await connections.destroy();
    await drop();
  }
}

// The Gegenproben of the queue core (W6 step 3) with real `bespoke queue:work` processes on a shared database.
describe.each(processKinds)('queue:work processes on %s', (kind) => {
  it(
    'runs each of 200 jobs exactly once with two workers taking from one queue',
    { timeout: 90_000 },
    async () => {
      await withFixture(kind, async (fixture) => {
        const a = fixture.worker(['--sleep=0.01']);
        const b = fixture.worker(['--sleep=0.01']);
        await Promise.all([a.waitFor(/^Processing jobs of the /), b.waitFor(/^Processing jobs of the /)]);
        // Started is not taking jobs yet: under load one worker took its first job only after the other had taken all 200
        // (W6.11). So both first hold a gate job at the same time — a gate one worker took after the other is offered again,
        // as long as it takes — and the race starts when both are taking jobs, not after a guessed time.
        let gates = 0;
        const gate = () => fixture.driver.push('default', record('fixture.gate', { n: -++gates }), 0);
        await gate();
        await gate();
        const gateWorkers = await fixture.until(async () => {
          const workers = new Set((await fixture.handled('started')).filter((row) => row.n < 0).map((row) => row.pid));
          if (workers.size === 2) return workers;
          if ((await fixture.jobs()).length === 0) await gate(); // one worker took every gate so far: one more for the other
          return undefined;
        });
        // All 200 appear at once (with the commit; on Redis as fast as they are pushed) — then both gates open.
        const payloads = Array.from({ length: 200 }, (_, n) => record('fixture.record', { n }));
        if (fixture.driver.using) {
          await fixture.connections.get().transaction().execute(async (trx) => {
            const driver = fixture.driver.using!(trx);
            for (const payload of payloads) await driver.push('default', payload, 0);
          });
        } else {
          await Promise.all(payloads.map((payload) => fixture.driver.push('default', payload, 0)));
        }
        await sql`insert into handled (uuid, n, attempt, pid, event) values ('go', ${-1000}, ${0}, ${0}, 'go')`.execute(fixture.connections.get());
        const raced = async () => (await fixture.handled()).filter((row) => row.n >= 0);
        await fixture.until(async () => (await fixture.jobs()).length === 0 && (await raced()).length >= 200, 60_000);
        await sleep(200); // a duplicate still in flight would land now
        a.child.kill('SIGTERM');
        b.child.kill('SIGTERM');
        expect(await a.exited()).toBe(0);
        expect(await b.exited()).toBe(0);

        const handled = await raced();
        const runs = new Map<number, number>();
        for (const row of handled) runs.set(row.n, (runs.get(row.n) ?? 0) + 1);
        const twice = [...runs].filter(([, count]) => count > 1).map(([n]) => n);
        expect(twice, `jobs that ran more than once: ${twice.join(', ')}`).toEqual([]);
        expect(runs.size).toBe(200);
        // Both took part in the race (otherwise it proved nothing): both held a gate at once and were released together. How
        // many of the 200 each wins is up to the machine — a starved worker may win none, which is no duplicate risk.
        expect(gateWorkers).toEqual(new Set([a.child.pid, b.child.pid]));
      });
    },
  );

  it('runs a job again after retryAfter when its worker was killed mid-job (SIGKILL) — attempt 2, same id', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      await fixture.driver.push('default', record('fixture.stubborn', { n: 1 }), 0);
      const env = fixture.retryAfter(3);
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
      const env = fixture.retryAfter(3);
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
      expect(await fixture.jobs()).toEqual([{ attempts: 0, reserved: false }]);
      expect(await fixture.failed()).toEqual([]);
    });
  });

  it('on SIGTERM releases a job that does not finish within the stop timeout, and exits with 0', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      // A minute of work that ignores its signal (and keeps the process busy): the worker still ends, with 0, in seconds.
      await fixture.driver.push('default', record('fixture.slow', { n: 1, ms: 60_000 }), 0);
      const worker = fixture.worker(['--stop-timeout=0.3', '--sleep=0.05'], fixture.retryAfter(30));
      await fixture.until(async () => (await fixture.handled('started')).length > 0);
      worker.child.kill('SIGTERM');
      expect(await worker.exited(8000)).toBe(0);
      // Back in the queue for the next worker, the attempt counted.
      expect(await fixture.jobs()).toEqual([{ attempts: 1, reserved: false }]);
      expect(worker.lines.join('\n')).toMatch(/Released fixture\.slow: the worker is stopping/);
    });
  });

  it('refuses to start when retryAfter is not longer than a job timeout plus the stop timeout', { timeout: 30_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const worker = fixture.worker(['--stop-timeout=1'], fixture.retryAfter(2));
      expect(await worker.exited()).toBe(1);
      expect(worker.lines.join('\n')).toMatch(/gives a claimed job 2s \(retryAfter\).*fixture\.record \(timeout 1s\)/);
    });
  });

  it('fails a job whose payload no longer matches its schema after ONE attempt (written straight into the table)', { timeout: 30_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const uuid = crypto.randomUUID();
      const payload = JSON.stringify({ uuid, job: 'fixture.user', data: { userId: 'x' }, tries: 5, backoff: [0], dispatchedAt: 0 });
      await fixture.driver.push('default', payload, 0);
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

  // W6 step 4: unique jobs, withoutOverlapping and job.once across processes — each with its control (the same without the measure).
  it('queues ONE job when two processes dispatch the same unique job at once (and 40 without unique)', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const race = async (args: string[]) => {
        const [a, b] = await Promise.all([fixture.dispatcher(args), fixture.dispatcher(args)]);
        a.child.stdin!.end('go\n');
        b.child.stdin!.end('go\n');
        const counts = await Promise.all([a, b].map(async (process) => Number((await process.waitFor(/^queued \d+$/)).split(' ')[1])));
        expect(await a.exited()).toBe(0);
        expect(await b.exited()).toBe(0);
        return counts[0]! + counts[1]!;
      };
      expect(await race(['--count=20', '--unique=report', '--n=1'])).toBe(1);
      expect(await fixture.jobs()).toHaveLength(1);
      // The control: the same race without a unique key queues every dispatch.
      expect(await race(['--count=20', '--n=2'])).toBe(40);
      expect(await fixture.jobs()).toHaveLength(41);
    });
  });

  it('never runs two jobs with one withoutOverlapping key at once on two workers (the control without it overlaps)', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const a = fixture.worker(['--sleep=0.02']);
      const b = fixture.worker(['--sleep=0.02']);
      await Promise.all([a.waitFor(/^Processing jobs of/), b.waitFor(/^Processing jobs of/)]);
      const overlaps = async (job: string, first: number) => {
        for (let n = first; n < first + 6; n++) await fixture.driver.push('default', record(job, { n, key: 'report', ms: 150 }, { tries: 50 }), 0);
        await fixture.until(async () => (await fixture.handled('end')).filter((row) => row.n >= first && row.n < first + 6).length === 6, 30_000);
        const rows = (await fixture.handled()).filter((row) => row.n >= first && row.n < first + 6);
        const runs = rows
          .filter((row) => row.event === 'start')
          .map((start) => ({ start: start.at, end: rows.find((row) => row.event === 'end' && row.uuid === start.uuid && row.attempt === start.attempt)!.at, pid: start.pid }));
        expect(runs).toHaveLength(6);
        let count = 0;
        for (const run of runs) for (const other of runs) if (run !== other && run.start < other.end && other.start < run.end) count++;
        return { count };
      };
      const guarded = await overlaps('fixture.guarded', 0);
      expect(guarded.count, 'runs with the same key overlapped').toBe(0);
      // Both workers went for the key — the lock, not luck, kept them apart: one of them was turned away at least once.
      expect([...a.lines, ...b.lines].some((line) => /Released fixture\.guarded \(by the job\)/.test(line))).toBe(true);
      const unguarded = await overlaps('fixture.unguarded', 100);
      expect(unguarded.count).toBeGreaterThan(0);
      a.child.kill('SIGTERM');
      b.child.kill('SIGTERM');
      expect(await a.exited()).toBe(0);
      expect(await b.exited()).toBe(0);
    });
  });

  it('sends a job.once mail once when the worker dies after the mail and before the acknowledgement (twice without the marker)', { timeout: 60_000 }, async () => {
    await withFixture(kind, async (fixture) => {
      const env = fixture.retryAfter(3);
      const run = async (n: number, once: boolean) => {
        await fixture.driver.push('default', record('fixture.mail-once', { n, once }), 0);
        const first = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
        await fixture.until(async () => (await fixture.handled('hang')).some((row) => row.n === n));
        first.child.kill('SIGKILL'); // after the mail, before the ack
        expect(await first.exited()).toBe('SIGKILL');
        const second = fixture.worker(['--stop-timeout=1', '--sleep=0.05'], env);
        await fixture.until(async () => (await fixture.jobs()).length === 0, 15_000);
        second.child.kill('SIGTERM');
        expect(await second.exited()).toBe(0);
        return (await fixture.handled('mail')).filter((row) => row.n === n).length;
      };
      expect(await run(1, true)).toBe(1);
      // The control: the same crash without job.once sends the mail again.
      expect(await run(2, false)).toBe(2);
    });
  });
});

if (!PGSQL_URL) describe.skip('queue:work processes on pgsql (set BESPOKE_TEST_PGSQL_URL: pnpm test:pgsql)', () => it('runs', () => {}));
if (!REDIS_URL) describe.skip('queue:work processes on redis (set BESPOKE_TEST_REDIS_URL: pnpm test:redis)', () => it('runs', () => {}));
