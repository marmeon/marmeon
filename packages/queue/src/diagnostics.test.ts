import { createApplication, Logger, runWithRequest, type Application } from '@bespokecore/core';
import { channels, type QueueDispatchMessage, type QueueJobMessage } from '@bespokecore/core/diagnostics';
import { Connections, DatabaseServiceProvider } from '@bespokecore/database';
import { EncryptionServiceProvider } from '@bespokecore/encryption';
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { migrate, silent } from './__fixtures__/targets.ts';
import { QueueConnections } from './connections.ts';
import { Queue, QueueServiceProvider, type JobContext } from './index.ts';
import { parseRecord } from './runner.ts';

const KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';

class StatsJob {
  static readonly job = 'test.stats';
  static readonly schema = v.object({ userId: v.number() });
  handle(payload: { userId: number }, job: JobContext) {
    if (payload.userId === 0) job.discard('no user');
  }
}

class BrokenJob {
  static readonly job = 'test.broken';
  static readonly schema = v.object({});
  handle() {
    throw new Error('the report service is down');
  }
}

async function boot(): Promise<Application> {
  const application = await createApplication({
    root: '/tmp',
    discover: false,
    env: { DB_CONNECTION: 'sqlite', DB_DATABASE: ':memory:', APP_KEY: KEY },
    providers: [DatabaseServiceProvider, EncryptionServiceProvider, QueueServiceProvider],
    modules: [{ name: 'test', jobs: [StatsJob, BrokenJob] }],
    override: (container) => container.instance(Logger, silent),
  });
  await migrate(application.container.make(Connections));
  return application;
}

const work = (application: Application) => application.container.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });

describe('job metadata (E131)', () => {
  it('a job dispatched in a request carries the request\'s id — always, also without a subscriber', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    await runWithRequest({ requestId: 'req-5' }, () => queue.dispatch(StatsJob, { userId: 5 }));
    await queue.dispatch(StatsJob, { userId: 6 });
    const rows = await application.container.make(Connections).get().selectFrom('jobs' as never).select('payload' as never).orderBy('id' as never).execute();
    const records = (rows as { payload: string }[]).map((row) => parseRecord(row.payload)!);
    expect(records.map((record) => record.requestId)).toEqual(['req-5', undefined]);
    expect(records.every((record) => record.traceparent === undefined)).toBe(true);
    expect(channels.built(application)).toBe(0);
  });
});

describe('the queue.dispatch and queue.job channels (E118)', () => {
  it('a tracer\'s traceparent travels with the job — set in its dispatch start, read in the worker\'s attempt', async () => {
    await using application = await boot();
    const queue = application.container.make(Queue);
    const dispatched: QueueDispatchMessage[] = [];
    const attempts: QueueJobMessage[] = [];
    const offs = [
      channels.subscribe(application, 'queue.dispatch', {
        // What @bespokecore/otel will do: put the current trace context on the message.
        start: (message) => void (message.traceparent = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`),
        end: (message) => void dispatched.push(message),
      }),
      channels.subscribe(application, 'queue.job', { end: (message) => void attempts.push(message) }),
    ];
    try {
      const id = await runWithRequest({ requestId: 'req-9' }, () => queue.dispatch(StatsJob, { userId: 9 }, { delay: 0 }));
      await queue.bulk([[StatsJob, { userId: 0 }], [BrokenJob, {}]]);
      await work(application);
      expect(dispatched.map(({ kind, jobs, jobIds, queue: name, connection, requestId }) => ({ kind, jobs, ids: jobIds.length, name, connection, requestId }))).toEqual([
        { kind: 'dispatch', jobs: ['test.stats'], ids: 1, name: 'default', connection: 'database', requestId: 'req-9' },
        { kind: 'bulk', jobs: ['test.stats', 'test.broken'], ids: 2, name: 'default', connection: 'database', requestId: undefined },
      ]);
      expect(dispatched[0]!.jobIds).toEqual([id]);
      expect(attempts.map(({ job, outcome, originRequestId, traceparent, attempt }) => ({ job, outcome, originRequestId, traceparent: traceparent?.slice(0, 8), attempt }))).toEqual([
        { job: 'test.stats', outcome: 'done', originRequestId: 'req-9', traceparent: '00-aaaaa', attempt: 1 },
        { job: 'test.stats', outcome: 'discarded', originRequestId: undefined, traceparent: '00-aaaaa', attempt: 1 },
        { job: 'test.broken', outcome: undefined, originRequestId: undefined, traceparent: '00-aaaaa', attempt: 1 },
      ]);
      expect((attempts[2]!.error as Error).message).toBe('the report service is down');
      expect(attempts.every((attempt) => typeof attempt.durationMs === 'number' && attempt.connection === 'database' && attempt.queue === 'default')).toBe(true);
    } finally {
      for (const off of offs) off();
    }
  });
});
