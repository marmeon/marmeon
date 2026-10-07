import { UserRepository, type User } from '#modules/auth';
import { EventDispatcher, Logger, type LogContext } from '@marmeon/core';
import { channels, type ChannelName, type DbQueryMessage, type HttpRequestMessage, type LiveRefreshMessage, type MailSendMessage, type NotificationSendMessage, type QueueJobMessage } from '@marmeon/core/diagnostics';
import { Database, sql } from '@marmeon/database';
import { ScheduledTaskFailed } from '@marmeon/scheduler';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

/** Records the `end` of every traced channel named, for one app; `stop()` ends the subscriptions. */
function record(app: TestApp, names: readonly ChannelName[]) {
  const seen: { channel: ChannelName; message: Record<string, unknown> }[] = [];
  const offs = names.map((channel) =>
    channel === 'log' || channel === 'exception'
      ? channels.subscribe(app.application, channel as 'log', (message: object) => void seen.push({ channel, message: message as never }))
      : channels.subscribe(app.application, channel as 'db.query', { end: (message) => void seen.push({ channel, message: message as never }) }),
  );
  return {
    of: <M>(channel: ChannelName) => seen.filter((entry) => entry.channel === channel).map((entry) => entry.message as M),
    stop: () => offs.forEach((off) => off()),
  };
}

const registration = { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse', password_confirmation: 'correct horse' };

describe('the observation hooks in the web app (E118, E131)', () => {
  it('a registration: the request, its queries with its id, the welcome job dispatched from it, the job\'s queries with the job\'s id, its mail', async () => {
    const app = await createTestApp(application, { database: 'refresh', mail: 'real' });
    const recorded = record(app, ['http.request', 'db.query', 'queue.job', 'mail.send']);
    try {
      await app.withHeaders({ 'x-request-id': 'req-register' }).post('/register', { form: registration, headers: { referer: 'http://localhost/register' } }).assertRedirect('/register/sent');
      await app.queue.work();
    } finally {
      recorded.stop();
    }
    const [request] = recorded.of<HttpRequestMessage>('http.request');
    expect(request).toMatchObject({ requestId: 'req-register', method: 'POST', route: 'auth.register.store', routePath: '/register', controller: 'RegisterController', status: 303 });

    const queries = recorded.of<DbQueryMessage>('db.query');
    const inRequest = queries.filter((query) => query.requestId === 'req-register');
    // The account is written in the request — a table with secret columns (the password hash): `secret`, its parameters raw.
    const insert = inRequest.find((query) => query.sql.startsWith('insert into "users"'));
    expect(insert).toMatchObject({ secret: true, connection: 'default' });
    expect(insert!.parameters.some((parameter) => typeof parameter === 'string' && parameter.startsWith('$argon2id$'))).toBe(true);

    // The welcome job knows the request it came from (E131) — its queries carry its own id, not the request's.
    const welcome = recorded.of<QueueJobMessage>('queue.job').find((job) => job.job === 'auth.send-welcome-mail');
    expect(welcome).toMatchObject({ originRequestId: 'req-register', outcome: 'done', attempt: 1, connection: 'fake' });
    const inJob = queries.filter((query) => query.jobId === welcome!.jobId);
    expect(inJob.length).toBeGreaterThan(0);
    expect(inJob.every((query) => query.requestId === undefined)).toBe(true);
    expect(recorded.of<MailSendMessage>('mail.send')).toContainEqual(expect.objectContaining({ mailable: 'WelcomeMail', mode: 'send', to: ['ada@example.com'], jobId: welcome!.jobId }));
  });

  it('a sign-in: the live hint, the notification delivered in the worker (its channels), its mail queued — then sent by the worker', async () => {
    const app = await createTestApp(application, { database: 'refresh', seed: true, notifications: 'real', mail: 'real' });
    const recorded = record(app, ['live.refresh', 'notification.send', 'mail.send']);
    try {
      await app.withHeaders({ 'x-request-id': 'req-login' }).post('/login', { form: { email: 'ada@example.com', password: 'password' } }).assertRedirect('/users/me');
      await app.queue.work(); // the queued listener: delivers the notification here, queues its mail
      await app.queue.work(); // the mail
    } finally {
      recorded.stop();
    }
    expect(recorded.of<LiveRefreshMessage>('live.refresh')).toContainEqual(expect.objectContaining({ channel: 'dashboard.sign-ins', only: null, requestId: 'req-login' }));
    const [notification] = recorded.of<NotificationSendMessage>('notification.send');
    expect(notification).toMatchObject({ notification: 'auth.new-sign-in', queued: false, recipient: { type: 'user' }, channels: ['database', 'live', 'mail'], outcome: 'delivered' });
    expect(notification!.jobId).toBeTypeOf('string');
    expect(recorded.of<MailSendMessage>('mail.send').map(({ mailable, mode, to }) => ({ mailable, mode, to }))).toEqual([
      { mailable: 'NewSignInMail', mode: 'queue', to: ['ada@example.com'] },
      { mailable: 'NewSignInMail', mode: 'worker', to: ['ada@example.com'] },
    ]);
  });

  it('secret: a statement on a table with secret columns — also as raw SQL; never one that touches none', async () => {
    const app = await createTestApp(application, { database: 'refresh', seed: true });
    const recorded = record(app, ['db.query']);
    const db = app.make(Database);
    try {
      await db.selectFrom('profile_links').select('id').execute();
      await db.selectFrom('users').select('id').execute();
      await sql`select count(*) from users`.execute(db);
      await sql`select count(*) from profile_links`.execute(db);
      await db.selectFrom('profile_links').where('user_id', 'in', db.selectFrom('remember_tokens').select('user_id')).select('id').execute();
    } finally {
      recorded.stop();
    }
    expect(recorded.of<DbQueryMessage>('db.query').map((query) => query.secret)).toEqual([false, true, true, false, true]);
  });

  it('two apps in one process: each subscriber hears its own app only', async () => {
    const one = await createTestApp(application, { database: 'refresh' });
    const two = await createTestApp(application);
    const first = record(one, ['http.request']);
    const second = record(two, ['http.request']);
    try {
      await one.withHeaders({ 'x-request-id': 'req-one' }).get('/login').assertOk();
      await two.withHeaders({ 'x-request-id': 'req-two' }).get('/login').assertOk();
    } finally {
      first.stop();
      second.stop();
    }
    expect(first.of<HttpRequestMessage>('http.request').map((request) => request.requestId)).toEqual(['req-one']);
    expect(second.of<HttpRequestMessage>('http.request').map((request) => request.requestId)).toEqual(['req-two']);
    await two.close();
  });
});

describe('Server-Timing in the web app (E129)', () => {
  it('development: the queries of a page — their time and how many', async () => {
    const app = await createTestApp(application, { database: 'refresh', seed: true, env: { NODE_ENV: 'development' } });
    const ada: User = (await app.make(UserRepository).query().selectAll().orderBy('id').executeTakeFirstOrThrow()) as User;
    const header = (await app.actingAs(ada).navigating().get('/people').assertOk()).headers.get('server-timing');
    const [, count] = /db;dur=[\d.]+;desc="(\d+) quer(?:y|ies)"/.exec(header ?? '') ?? [];
    expect(header).toMatch(/^app;dur=[\d.]+;desc="App", db;dur=[\d.]+;desc="\d+ quer(y|ies)"$/);
    expect(Number(count)).toBeGreaterThan(0);
  });

  it('tests (NODE_ENV=test): none', async () => {
    const app = await createTestApp(application, { database: 'refresh', seed: true });
    expect((await app.get('/login').assertOk()).headers.get('server-timing')).toBeNull();
  });
});

describe('a failed scheduled task (E127)', () => {
  it('raises one alert: an error with alert: true, the message redacted', async () => {
    const entries: { message: string; context: LogContext }[] = [];
    const recording: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (message, context = {}) => void entries.push({ message, context }),
      child: () => recording,
    };
    const app = await createTestApp(application, { override: (container) => container.instance(Logger, recording) });
    await app.make(EventDispatcher).dispatch(
      new ScheduledTaskFailed({ task: 'user-profile.prune-data-exports', minute: Date.parse('2026-10-03T12:10:00Z'), reason: 'due', error: new Error('disk full, token=abc123'), ms: 12 }),
    );
    app.events.assertDispatched(ScheduledTaskFailed);
    expect(entries).toEqual([
      {
        message: 'The scheduled task user-profile.prune-data-exports failed: Error: disk full, token=[redacted]',
        context: { alert: true, task: 'user-profile.prune-data-exports', due: '2026-10-03T12:10:00.000Z', ms: 12 },
      },
    ]);
  });
});
