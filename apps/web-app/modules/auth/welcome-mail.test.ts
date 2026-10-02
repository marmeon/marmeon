import { Connections, sql } from '@bespokecore/database';
import { QueueConnections } from '@bespokecore/queue';
import { createTestApp } from '@bespokecore/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';
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

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
    const [sent] = app.mail.sent(WelcomeMail);
    expect(sent!.message).toMatchObject({ to: [{ address: 'kj@example.com', name: 'Katherine Johnson' }], subject: 'Willkommen bei BespokeCore' });
    expect(sent!.message.html).toContain('href="http://localhost/users/me"');
  });

  it('is discarded when the account is gone by the time the job runs — no mail, no failed job', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await register(app).assertRedirect('/users/me');
    const user = (await app.make(UserRepository).findForLogin('kj@example.com'))!.user;
    await app.make(UserRepository).delete(user.id);

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
    app.mail.assertNotSent(WelcomeMail);
    expect(await app.queue.failed()).toEqual([]);
  });

  it('goes through the jobs table with the real database queue, and a worker sends it', async () => {
    const app = await createTestApp(application, { database: 'refresh', queue: 'real' });
    await register(app).assertRedirect('/users/me');
    await app.assertDatabaseHas('jobs', { queue: 'default', attempts: 0 });
    const db = app.make(Connections).get();
    const { rows } = await sql<{ payload: string }>`select payload from jobs`.execute(db);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ job: 'auth.send-welcome-mail', data: { userId: expect.any(Number) }, tries: 5, backoff: [10, 60, 300] });

    const result = await app.make(QueueConnections).worker('database', 10).run({ queues: ['default'], stopWhenEmpty: true });
    expect(result).toMatchObject({ processed: 1, failed: 0 });
    app.mail.assertSent(WelcomeMail, (_mail, message) => message.subject === 'Welcome to BespokeCore');
    await app.assertDatabaseCount('jobs', 0);
  });
});
