import { AsyncLocalStorage } from 'node:async_hooks';
import { subscribe as subscribeRaw, unsubscribe as unsubscribeRaw } from 'node:diagnostics_channel';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { createApplication, type Application } from './application.ts';
import { channels, messageBase, publishEnded, trace, type ChannelMessage, type DbQueryMessage, type HttpRequestMessage, type LogMessage } from './diagnostics.ts';
import { Logger } from './logger.ts';
import { runWithJob, runWithRequest } from './request-context.ts';

const boot = () => createApplication({ root: import.meta.dirname, discover: false, env: {} });

/** A query message as the database would publish it — for the app given. */
function query(app: Application, sql = 'select 1'): DbQueryMessage {
  return { ...messageBase(app), connection: 'default', driver: 'sqlite', sql, parameters: [], secret: false, durationMs: 1.5 };
}

describe('channels.subscribe (E118)', () => {
  it('passes on only its own app\'s messages — two apps in one process never see each other\'s', async () => {
    const one = await boot();
    const two = await boot();
    const seen: string[] = [];
    const off = channels.subscribe(one, 'db.query', { end: (message) => void seen.push(message.sql) });
    try {
      publishEnded(channels.tracing('db.query'), query(one, 'select one'));
      publishEnded(channels.tracing('db.query'), query(two, 'select two'));
    } finally {
      off();
    }
    expect(seen).toEqual(['select one']);
  });

  it('returns off(): afterwards the channel has no subscriber again (and off twice is harmless)', async () => {
    const app = await boot();
    const tracing = channels.tracing('queue.job');
    expect(tracing.hasSubscribers).toBe(false);
    const off = channels.subscribe(app, 'queue.job', { start: () => {}, end: () => {}, error: () => {} });
    expect(tracing.hasSubscribers).toBe(true);
    off();
    off();
    expect(tracing.hasSubscribers).toBe(false);
  });

  it('start, end and error map onto the TracingChannel — end once, after it ended, with durationMs', async () => {
    const app = await boot();
    const events: string[] = [];
    const off = channels.subscribe(app, 'live.refresh', {
      start: (message) => void events.push(`start ${message.channel} ${message.durationMs === undefined}`),
      end: (message) => void events.push(`end ${message.channel} ${typeof message.durationMs} ${message.error === undefined ? 'ok' : 'failed'}`),
      error: (message) => void events.push(`error ${message.channel} ${(message.error as Error).message}`),
    });
    try {
      const tracing = channels.tracing('live.refresh');
      expect(await trace(tracing, { ...messageBase(app), channel: 'users.1', only: null }, async () => 'sent')).toBe('sent');
      await expect(trace(tracing, { ...messageBase(app), channel: 'users.2', only: null }, async () => Promise.reject(new Error('redis is down')))).rejects.toThrow('redis is down');
    } finally {
      off();
    }
    expect(events).toEqual(['start users.1 true', 'end users.1 number ok', 'start users.2 true', 'error users.2 redis is down', 'end users.2 number failed']);
  });

  it('a subscriber that throws is a process warning — the operation goes on', async () => {
    const app = await boot();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => void warnings.push(warning.message);
    process.on('warning', onWarning);
    const off = channels.subscribe(app, 'render.ssr', {
      start: () => {
        throw new Error('the recorder is full');
      },
    });
    try {
      const result = await trace(channels.tracing('render.ssr'), { ...messageBase(app), component: 'Home', complete: false }, async () => 'html');
      expect(result).toBe('html');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      off();
      process.off('warning', onWarning);
    }
    expect(warnings.some((warning) => warning.startsWith('A subscriber of bespoke:render.ssr failed: Error: the recorder is full'))).toBe(true);
  });

  it('plain channels take one handler; unknown names and the wrong handler shape are errors', async () => {
    const app = await boot();
    const entries: LogMessage[] = [];
    const off = channels.subscribe(app, 'log', (entry) => void entries.push(entry));
    app.container.make(Logger).child({ channel: 'http' }).warn('slow', { ms: 900 });
    off();
    app.container.make(Logger).warn('after off');
    expect(entries.map(({ level, message, context }) => ({ level, message, context }))).toEqual([{ level: 'warn', message: 'slow', context: { channel: 'http', ms: 900 } }]);
    expect(() => channels.subscribe(app, 'db.querry' as never, {} as never)).toThrow('There is no channel "db.querry". Channels: http.request, db.query,');
    expect(() => channels.subscribe(app, 'log', {} as never)).toThrow("channels.subscribe(app, 'log', handler): give a function — log is a plain channel.");
    expect(() => channels.subscribe(app, 'db.query', (() => {}) as never)).toThrow("channels.subscribe(app, 'db.query', handlers): give { start?, end?, error? }.");
  });

  it('the messages are typed per channel', () => {
    expectTypeOf<ChannelMessage<'db.query'>>().toEqualTypeOf<DbQueryMessage>();
    expectTypeOf<ChannelMessage<'http.request'>>().toEqualTypeOf<HttpRequestMessage>();
    expectTypeOf<ChannelMessage<'log'>>().toEqualTypeOf<LogMessage>();
    // Checked by the compiler only — never run.
    const typeOnly = () => {
      // @ts-expect-error — a query message has no route.
      channels.subscribe({} as Application, 'db.query', { end: (message) => message.route });
      // @ts-expect-error — no such channel.
      channels.subscribe({} as Application, 'db.querry', {});
      // @ts-expect-error — a plain channel takes one handler.
      channels.subscribe({} as Application, 'log', { end: () => {} });
    };
    expect(typeOnly).toBeTypeOf('function');
  });
});

describe('messages', () => {
  it('say where they happen: the request, the job (by the context, E3)', async () => {
    const app = await boot();
    const inRequest = runWithRequest({ requestId: 'req-7' }, () => messageBase(app));
    const inJob = runWithJob({ job: 'stats', jobId: 'job-9', attempt: 1 }, () => messageBase(app));
    expect(inRequest).toMatchObject({ app, requestId: 'req-7' });
    expect(inRequest).not.toHaveProperty('jobId');
    expect(inJob).toMatchObject({ app, jobId: 'job-9' });
    expect(inJob).not.toHaveProperty('requestId');
    expect(Math.abs(inJob.startedAt - Date.now())).toBeLessThan(1000);
  });

  it('are counted per app — the proof that nothing is built while nobody listens', async () => {
    const app = await boot();
    const logger = app.container.make(Logger);
    logger.info('nobody listens');
    expect(channels.built(app)).toBe(0);
    const off = channels.subscribe(app, 'log', () => {});
    logger.info('somebody listens');
    off();
    expect(channels.built(app)).toBe(1);
  });

  it('the raw TracingChannel: every app\'s messages', async () => {
    const one = await boot();
    const two = await boot();
    const seen: Application[] = [];
    const raw = (message: unknown) => void seen.push((message as { app: Application }).app);
    subscribeRaw('tracing:bespoke:db.query:asyncEnd', raw);
    try {
      publishEnded(channels.tracing('db.query'), query(one));
      publishEnded(channels.tracing('db.query'), query(two));
    } finally {
      unsubscribeRaw('tracing:bespoke:db.query:asyncEnd', raw);
    }
    expect(seen).toEqual([one, two]);
  });
});

describe('channels.around: an operation\'s work in a context of the subscriber\'s (E120)', () => {
  it('runs the work inside the wrapper — what happens there sees the wrapper\'s context; other apps\' operations do not', async () => {
    const one = await boot();
    const two = await boot();
    const store = new AsyncLocalStorage<string>();
    const seen: (string | undefined)[] = [];
    const work = async () => {
      // oxlint-disable-next-line unicorn/no-unnecessary-await -- yields once, so the store must survive a microtask
      await null;
      seen.push(store.getStore());
      return 'sent';
    };
    // A wrapper only runs while the channel has a subscriber (the operation is traced only then).
    const offs = [
      channels.subscribe(one, 'live.refresh', {}),
      channels.around(one, 'live.refresh', (message, run) => store.run(`span of ${message.channel}`, run)),
    ];
    try {
      const tracing = channels.tracing('live.refresh');
      expect(await trace(tracing, { ...messageBase(one), channel: 'users.1', only: null }, work)).toBe('sent');
      expect(await trace(tracing, { ...messageBase(two), channel: 'users.2', only: null }, work)).toBe('sent');
    } finally {
      offs.forEach((off) => off());
    }
    expect(await trace(channels.tracing('live.refresh'), { ...messageBase(one), channel: 'users.3', only: null }, work)).toBe('sent');
    expect(seen).toEqual(['span of users.1', undefined, undefined]);
  });

  it('the work runs exactly once — also when a wrapper throws before it, or never calls run (a process warning each)', async () => {
    const app = await boot();
    const warnings: string[] = [];
    const onWarning = (warning: Error) => void warnings.push(warning.message);
    process.on('warning', onWarning);
    let runs = 0;
    const work = async () => {
      runs++;
      return runs;
    };
    const offs = [channels.subscribe(app, 'mail.send', {})];
    try {
      const tracing = channels.tracing('mail.send');
      const message = () => ({ ...messageBase(app), mailable: 'WelcomeMail', mode: 'send' as const });
      offs.push(
        channels.around(app, 'mail.send', () => {
          throw new Error('the tracer is broken');
        }),
      );
      expect(await trace(tracing, message(), work)).toBe(1);
      offs.pop()!();
      offs.push(channels.around(app, 'mail.send', () => {}));
      expect(await trace(tracing, message(), work)).toBe(2);
      offs.pop()!();
      // Called twice: the work still runs once.
      offs.push(
        channels.around(app, 'mail.send', (_message, run) => {
          run();
          run();
        }),
      );
      expect(await trace(tracing, message(), work)).toBe(3);
      // The operation's own failure stays its own.
      offs.push(channels.around(app, 'mail.send', (_message, run) => void run()));
      await expect(trace(tracing, message(), async () => Promise.reject(new Error('smtp is down')))).rejects.toThrow('smtp is down');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      offs.forEach((off) => off());
      process.off('warning', onWarning);
    }
    expect(runs).toBe(3);
    expect(warnings.filter((warning) => warning.startsWith('A wrapper of bespoke:mail.send failed: Error: the tracer is broken'))).toHaveLength(1);
    expect(warnings.filter((warning) => warning === 'A wrapper of bespoke:mail.send did not run the operation; it ran without it.')).toHaveLength(2);
  });

  it('is typed per channel; db.query has none (it is published after the statement ran)', () => {
    const typeOnly = () => {
      channels.around({} as Application, 'http.request', (request, run) => (request.method === 'GET' ? run() : run()));
      // @ts-expect-error — a request message has no sql.
      channels.around({} as Application, 'http.request', (request) => request.sql);
      // @ts-expect-error — a plain channel is never wrapped.
      channels.around({} as Application, 'log', () => {});
    };
    expect(typeOnly).toBeTypeOf('function');
  });
});
