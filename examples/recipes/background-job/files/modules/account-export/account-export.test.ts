import { UserFactory, UserRepository } from '#modules/auth';
import { Connections, sql } from '@marmeon/database';
import { QueueConnections } from '@marmeon/queue';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendAccountExportJob } from './jobs/SendAccountExportJob.ts';
import { AccountExportMail } from './mail/AccountExportMail.ts';

// What a request for the mail queues, what the job sends, and what happens when it runs twice or fails.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

describe('the account export', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page and queues nothing', async () => {
    await app.get('/account/export').assertRedirect('/login');
    await app.post('/account/export').assertRedirect('/login');
    app.queue.assertNothingDispatched();
  });

  it('queues nothing for an account whose address nobody has confirmed', async () => {
    // Anyone can register with another person's address; the mail must not reach it before its owner confirmed it.
    const mallory = await app.factory(UserFactory).state('unverified').create();
    await app.actingAs(mallory).post('/account/export').assertRedirect('/email/verify');
    app.queue.assertNothingDispatched();
  });

  it('queues a job with the id of the signed-in user and nothing else in its payload', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/account/export').assertPage('account-export/ShowAccountExport', {});
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');

    app.queue.assertDispatchedTimes(SendAccountExportJob, 1);
    const [dispatched] = app.queue.dispatched(SendAccountExportJob);
    expect(dispatched!.payload).toEqual({ userId: ada.id });
    // The payload is stored with the job: no address, no name.
    expect(JSON.stringify(dispatched!.payload)).not.toContain(ada.email);
    expect(JSON.stringify(dispatched!.payload)).not.toContain(ada.name);
  });

  it('queues no second job while the first one waits', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    app.queue.assertDispatchedTimes(SendAccountExportJob, 1);

    // Another account has a key of its own.
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(bob).post('/account/export').assertRedirect('/account/export');
    app.queue.assertDispatchedTimes(SendAccountExportJob, 2);
  });

  it('mails the user once, with name, address and the day the account was made', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    app.mail.assertNotSent(AccountExportMail);

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0 });
    app.mail.assertSentCount(AccountExportMail, 1);
    const [sent] = app.mail.sent(AccountExportMail);
    expect(sent!.message.to).toEqual([{ address: ada.email, name: ada.name }]);
    expect(sent!.message.text).toContain(ada.email);
    expect(sent!.message.text).toContain(new Date(ada.created_at).toISOString().slice(0, 10));
  });

  it('answers the fourth request of an hour from one user with 429, and leaves other users alone', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    for (let attempt = 1; attempt <= 3; attempt++) await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.actingAs(ada).post('/account/export').assertStatus(429);
    await app.actingAs(bob).post('/account/export').assertRedirect('/account/export');
    // The next hour opens a new window.
    app.travel({ seconds: 3601 });
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
  });

  it('sends nothing more when the same job comes back after the mail went out', async () => {
    await app.close(); // one database app per test
    const real = await createTestApp(application, { database: 'refresh', queue: 'real' });
    const ada = await real.factory(UserFactory).create();
    await real.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    const db = real.make(Connections).get();
    const { rows } = await sql<{ queue: string; payload: string; available_at: number; created_at: number }>`select queue, payload, available_at, created_at from jobs`.execute(db);
    const work = () => real.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });

    expect(await work()).toMatchObject({ processed: 1, failed: 0 });
    real.mail.assertSentCount(AccountExportMail, 1);
    // A worker that died after the mail and before it marked the job done leaves the record in the table: the same record,
    // with the same job id, is back.
    const [job] = rows;
    await sql`insert into jobs (queue, payload, attempts, available_at, created_at) values (${job!.queue}, ${job!.payload}, 0, ${job!.available_at}, ${job!.created_at})`.execute(db);
    expect(await work()).toMatchObject({ processed: 1, failed: 0 });
    real.mail.assertSentCount(AccountExportMail, 1);
    await real.close();
  });

  it('sends no mail when the address stopped being confirmed after the request', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    // A new address is unconfirmed until its owner confirms it.
    await sql`update users set email_verified_at = null where id = ${ada.id}`.execute(app.make(Connections).get());

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0, released: 0 });
    app.mail.assertNothingSent();
    expect(await app.queue.failed()).toEqual([]);
    expect(app.queue.pending()).toEqual([]);
  });

  it('ends without a mail, a failure or a retry when the account is gone by the time the job runs', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/account/export').assertRedirect('/account/export');
    await app.make(UserRepository).delete(ada.id);

    expect(await app.queue.work()).toMatchObject({ processed: 1, failed: 0, released: 0 });
    app.mail.assertNothingSent();
    expect(await app.queue.failed()).toEqual([]);
    // A job that threw would wait here for its next attempt.
    expect(app.queue.pending()).toEqual([]);
  });

  it('stores five tries and the waits between them with the job', async () => {
    await app.close(); // one database app per test
    const real = await createTestApp(application, { database: 'refresh', queue: 'real' });
    const ada = await real.factory(UserFactory).create();
    await real.actingAs(ada).post('/account/export').assertRedirect('/account/export');

    await real.assertDatabaseHas('jobs', { queue: 'default', attempts: 0 });
    const { rows } = await sql<{ payload: string }>`select payload from jobs`.execute(real.make(Connections).get());
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({ job: 'account-export.send-account-export', data: { userId: ada.id }, tries: 5, backoff: [10, 60, 300] });
    await real.close();
  });
});
