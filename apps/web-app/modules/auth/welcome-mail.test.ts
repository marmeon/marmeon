import { Registered } from '@bespokecore/auth';
import { EventRegistry } from '@bespokecore/core';
import { Connections, sql } from '@bespokecore/database';
import { Queue, QueueConnections } from '@bespokecore/queue';
import { createTestApp } from '@bespokecore/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import { WelcomeMail } from './mail/WelcomeMail.ts';
import { UserRepository } from './UserRepository.ts';

const register = (app: Awaited<ReturnType<typeof createTestApp>>, language = 'en') =>
  app.post('/register', {
    form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' },
    headers: { 'accept-language': language },
  });

// The web app's first queued job (W6 step 3): the welcome mail after a registration — queued in the request, sent by a worker.
describe('the welcome mail', () => {
  it('is queued by the registration (QueueFake), not sent in the request — and sent when the job runs, in the account language', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await register(app, 'de').assertRedirect('/users/me');
    const user = (await app.make(UserRepository).findForLogin('kj@example.com'))!.user;

    app.queue.assertDispatchedTimes(SendWelcomeMailJob, 1).assertDispatched(SendWelcomeMailJob, (payload, job) => payload.userId === user.id && job.delay === 0);
    app.mail.assertNotSent(WelcomeMail);

    // The welcome mail, the dashboard's member numbers (user-profile, a unique job) and the queued verification listener.
    expect(await app.queue.work()).toMatchObject({ processed: 3, failed: 0 });
    const [sent] = app.mail.sent(WelcomeMail);
    expect(sent!.message).toMatchObject({ to: [{ address: 'kj@example.com', name: 'Katherine Johnson' }], subject: 'Willkommen bei BespokeCore' });
    expect(sent!.message.html).toContain('href="http://localhost/users/me"');
  });

  it('is discarded when the account is gone by the time the job runs — no mail, no failed job', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await register(app).assertRedirect('/users/me');
    const user = (await app.make(UserRepository).findForLogin('kj@example.com'))!.user;
    await app.make(UserRepository).delete(user.id);

    expect(await app.queue.work({ queues: ['default'], maxJobs: 1 })).toMatchObject({ processed: 1, failed: 0 });
    app.mail.assertNotSent(WelcomeMail);
    expect(await app.queue.failed()).toEqual([]);
  });

  it('goes through the jobs table with the real database queue, and a worker sends it', async () => {
    const app = await createTestApp(application, { database: 'refresh', queue: 'real' });
    await register(app).assertRedirect('/users/me');
    await app.assertDatabaseHas('jobs', { queue: 'default', attempts: 0 });
    const db = app.make(Connections).get();
    const { rows } = await sql<{ payload: string }>`select payload from jobs where queue = 'default' order by id`.execute(db);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ job: 'auth.send-welcome-mail', data: { userId: expect.any(Number) }, tries: 5, backoff: [10, 60, 300] });

    const result = await app.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 3, failed: 0 }); // + the verification listener on the `mail` queue
    app.mail.assertSent(WelcomeMail, (_mail, message) => message.subject === 'Welcome to BespokeCore');
    await app.assertDatabaseCount('jobs', 0);
  });

  it('is part of the registration transaction (E107): a failing listener leaves no account, no job, no mail', async () => {
    const app = await createTestApp(application, { database: 'refresh', queue: 'real' });
    // A third listener on Registered, after the two of the auth module, fails.
    app.make(EventRegistry).listen(Registered, () => {
      throw new Error('a listener failed');
    });
    await register(app).assertStatus(500);
    await app.assertDatabaseMissing('users', { email: 'kj@example.com' });
    await app.assertDatabaseCount('jobs', 0);
    app.mail.assertNotSent(VerifyEmailMail);

    // Without the failing listener: the account, its welcome job and — after the commit — the verification mail.
    await app.close();
    const ok = await createTestApp(application, { database: 'refresh', queue: 'real' });
    await register(ok).assertRedirect('/users/me');
    await ok.assertDatabaseHas('users', { email: 'kj@example.com' });
    // The welcome and member-stats jobs and the verification listener — all three in the transaction (E109).
    await ok.assertDatabaseCount('jobs', 3);
    await ok.assertDatabaseHas('jobs', { queue: 'mail' });
    ok.mail.assertNotQueued(VerifyEmailMail); // composed by the worker
    await ok.make(QueueConnections).worker('database', 10).run({ queues: ['mail'], stopWhenEmpty: true });
    ok.mail.assertQueued(VerifyEmailMail);
  });

  it('is sent once per account (job.once, E85): a second job for the same account — or a retry after the mail went out — sends nothing', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await register(app).assertRedirect('/users/me');
    const user = (await app.make(UserRepository).findForLogin('kj@example.com'))!.user;
    await app.make(Queue).dispatch(SendWelcomeMailJob, { userId: user.id });
    await app.queue.work();
    app.mail.assertSentCount(WelcomeMail, 1);
  });
});
