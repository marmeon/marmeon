import { Login, Registered } from '@marmeon/auth';
import { EventDispatcher } from '@marmeon/core';
import { Connections, sql } from '@marmeon/database';
import { MailTransport, type MailMessage } from '@marmeon/mail';
import { QueueConnections, QueueRetryCommand } from '@marmeon/queue';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { SendEmailVerification } from './listeners/SendEmailVerification.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

// Slow under load: five rounds of a worker on the real database queue — 5–6 s on a fully loaded machine even after the warm-up.
const heavyTimeout = 15_000;

// The auth mails leave the request — a queued listener (verification), queued mails (verification, address
// change, reset), composed in the recipient's language, encrypted in the queue, sent by a worker.

/** An SMTP server: down (it throws) or slow — the request must not care. */
class TestTransport implements MailTransport {
  readonly sent: MailMessage[] = [];
  down = false;
  /** A mail server that never answers: `send` is called (`called` settles) and never returns. */
  hung = false;
  readonly #called = Promise.withResolvers<void>();
  readonly called = this.#called.promise;
  async send(message: MailMessage): Promise<void> {
    this.#called.resolve();
    if (this.hung) await new Promise(() => {});
    if (this.down) throw new Error('connect ECONNREFUSED 127.0.0.1:587');
    this.sent.push(message);
  }
}

const form = (email = 'kj@example.com') => ({ name: 'Katherine Johnson', email, password: 'orbital mechanics', password_confirmation: 'orbital mechanics' });

/** A real database queue and the real mailer, its transport replaced. */
async function realApp(transport: TestTransport): Promise<TestApp> {
  return createTestApp(application, { database: 'refresh', queue: 'real', mail: 'real', override: (c) => c.instance(MailTransport, transport) });
}

const work = (app: TestApp) => app.make(QueueConnections).worker('database', 10).run({ queues: ['*'], stopWhenEmpty: true });

/** Every payload the queue keeps, in `jobs` and `failed_jobs`. */
async function queuePayloads(app: TestApp): Promise<string> {
  const db = app.make(Connections).get();
  const jobs = await sql<{ payload: string }>`select payload from jobs`.execute(db);
  const failed = await sql<{ payload: string; exception: string }>`select payload, exception from failed_jobs`.execute(db);
  return [...jobs.rows.map((row) => row.payload), ...failed.rows.flatMap((row) => [row.payload, row.exception])].join('\n');
}

describe('the verification mail through the queue', () => {
  it('a mail server that is down never fails the registration: 303 and the account exists, the mail retries, waits in failed_jobs after its tries, and queue:retry sends it', async () => {
    const transport = new TestTransport();
    transport.down = true;
    const app = await realApp(transport);
    await app.post('/register', { form: form() }).assertRedirect('/register/sent');
    expect(await app.make(UserRepository).findForLogin('kj@example.com')).toBeDefined();

    // The listener composes the mail (marmeon.listener), the mail job hands it to the transport (marmeon.mail): 5 tries.
    await work(app);
    for (const seconds of [10, 60, 300, 300]) {
      app.travel({ seconds });
      await work(app);
    }
    expect(transport.sent).toEqual([]);
    // The verification mail — and the welcome mail (a job that sends itself) — wait in the failed jobs.
    const failed = await sql<{ job: string; queue: string }>`select job, queue from failed_jobs order by job`.execute(app.make(Connections).get());
    expect(failed.rows.map((row) => [row.job, row.queue])).toEqual([
      ['auth.send-welcome-mail', 'default'],
      ['marmeon.mail', 'mail'],
    ]);
    expect(await queuePayloads(app)).not.toContain('/email/verify/'); // the signed link: encrypted, also in failed_jobs

    transport.down = false;
    const output = { success: () => {}, error: () => {}, line: () => {}, info: () => {}, warn: () => {}, table: () => {} };
    expect(await app.make(QueueRetryCommand).handle({ args: ['all'], options: {}, output, root: '', spawn: async () => 0 } as never)).toBe(0);
    await work(app);
    expect(transport.sent.map((message) => message.subject).sort()).toEqual(['Confirm your e-mail address', 'Welcome to Marmeon']);
    await app.assertDatabaseCount('failed_jobs', 0);
  }, heavyTimeout);

  // No clock ("under 1 000 ms" broke on a loaded machine): the mail server never answers — a request that waited for it
  // would never return; one that reached it at all fails at once.
  it('the registration answers without waiting for the mail server (one that never answers)', async () => {
    const transport = new TestTransport();
    transport.hung = true;
    const app = await realApp(transport);
    const reached = transport.called.then(() => 'the request called the mail transport');
    const answered = app.post('/register', { form: form() }).then(async (response) => (await response.assertRedirect('/register/sent'), 'answered'));
    expect(await Promise.race([answered, reached])).toBe('answered');
    expect(transport.sent).toEqual([]);
  });

  it('is never queued for a registration that is rolled back (part of the transaction) — and a rolled-back dispatch leaves no job', async () => {
    const app = await realApp(new TestTransport());
    const kj = await app.factory(UserFactory).state('unverified').create();
    await expect(
      app.make(Connections).transaction(async () => {
        await app.make(EventDispatcher).dispatch(new Registered(kj));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    await app.assertDatabaseCount('jobs', 0);
    await app.make(EventDispatcher).dispatch(new Registered(kj));
    await app.assertDatabaseHas('jobs', { queue: 'mail' });
  });

  it('is in the recipient’s language, not the request’s: a German account, an English request', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    const grace = await app.factory(UserFactory).state('unverified').create({ name: 'Grace', locale: 'de' });
    // The session's language choice (English) wins for the page — the mail is the account's.
    await app.actingAs(grace).withSession({ locale: 'en' }).post('/email/verification-notification').assertFlashed('toast', { message: 'A new verification link is on its way.' });
    const [queued] = app.mail.queued(VerifyEmailMail);
    expect(queued!.message.subject).toBe('Bestätige deine E-Mail-Adresse');
    expect(queued!.options).toEqual({ queue: 'mail' });

    // From the queued listener — a worker, no request at all, its Translator speaks APP_LOCALE (en) — the account's language.
    await app.withHeaders({ 'accept-language': 'de' }).post('/register', { form: form('ada@example.com') });
    app.queue.assertListenerQueued(SendEmailVerification, (payload) => typeof payload.userId === 'number');
    await app.queue.work();
    expect(app.mail.queued(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'ada@example.com')[0]!.message.subject).toBe('Bestätige deine E-Mail-Adresse');
  });

  it('records the event — Registered dispatched, the queued listener listening', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await app.post('/register', { form: form() }).assertRedirect('/register/sent');
    app.events.assertDispatched(Registered, (event) => (event.user as User).email === 'kj@example.com').assertListening(Registered, SendEmailVerification);
    app.queue.assertListenerQueued(SendEmailVerification);
  });

  it('a faked event (EventFake) is recorded, its listeners neither run nor are queued', async () => {
    // Login is faked too: its queued listener (the "new sign-in" notice) would be queued by the sign-in after registering.
    const app = await createTestApp(application, { database: 'refresh', events: [Registered, Login] });
    await app.post('/register', { form: form() }).assertRedirect('/register/sent');
    app.events.assertDispatchedTimes(Registered, 1);
    app.queue.assertNothingDispatched(); // no verification listener, no welcome mail, no member stats
  });
});

describe('the reset link through the queue', () => {
  it('keeps the plaintext token out of jobs and failed_jobs — it is only in the mail', async () => {
    const transport = new TestTransport();
    transport.down = true;
    const app = await realApp(transport);
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.post('/forgot-password', { form: { email: 'ada@example.com' } }).assertRedirect();
    const seen: string[] = [await queuePayloads(app)];
    await work(app); // the job makes the token and queues the mail; the mail fails
    seen.push(await queuePayloads(app));
    for (const seconds of [10, 60, 300, 300]) {
      app.travel({ seconds });
      await work(app);
      seen.push(await queuePayloads(app));
    }
    await app.assertDatabaseCount('failed_jobs', 1);
    expect(seen.join('\n')).not.toContain('ada@example.com'); // the address: encrypted too

    transport.down = false;
    const output = { success: () => {}, error: () => {}, line: () => {} };
    await app.make(QueueRetryCommand).handle({ args: ['all'], options: {}, output, root: '', spawn: async () => 0 } as never);
    await work(app);
    const token = new URL(/https?:\/\/\S+\/reset-password\?\S+(?=\))/.exec(transport.sent[0]!.text)![0]).searchParams.get('token')!;
    expect(token).toMatch(/^\S{20,}$/);
    expect(seen.join('\n')).not.toContain(token);
  });
});

describe('registration is throttled', () => {
  it('the 11th registration a minute from one address gets 429 — live validation does not count, the next minute registers again', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    for (let i = 1; i <= 10; i++) {
      await app.post('/register', { form: form(`user${i}@example.com`) }).assertRedirect('/register/sent');
    }
    await app.post('/register', { form: form('user11@example.com') }).assertStatus(429);
    await app.assertDatabaseMissing('users', { email: 'user11@example.com' });
    // Live validation of the form is no attempt.
    await app.validating('email').post('/register', { json: form('user11@example.com') }).assertStatus(429);
    app.travel({ seconds: 61 });
    await app.post('/register', { form: form('user11@example.com') }).assertRedirect('/register/sent');
  });
});

describe('mails without a request', () => {
  it('take their links from APP_URL only — the app does not start without it (no link ever from a Host header)', async () => {
    await expect(createTestApp(application, { env: { APP_URL: undefined } })).rejects.toThrow(/APP_URL/);
  });

  it('show in the development preview: /_marmeon/mail lists them, a preview renders sample data in a language', async () => {
    // Development only: a test app (NODE_ENV=test) has no previews unless it runs as development.
    await (await createTestApp(application)).get('/_marmeon/mail').assertNotFound();
    const app = await createTestApp(application, { database: 'refresh', env: { NODE_ENV: 'development' } });
    const index = await app.get('/_marmeon/mail').assertOk();
    for (const name of ['auth/EmailChangedMail', 'auth/ResetPasswordMail', 'auth/VerifyEmailMail', 'auth/WelcomeMail', 'auth/ConfirmNewEmailMail', 'auth/EmailInUseMail']) {
      expect(index.body).toContain(`/_marmeon/mail/${name}`);
    }
    // The change of address (private registration): the link to the new address, the note to the owner of a taken one.
    expect((await app.get('/_marmeon/mail/auth/ConfirmNewEmailMail?locale=de').assertOk()).body).toContain('<th>Subject</th><td>Bestätige deine neue E-Mail-Adresse</td>');
    expect((await app.get('/_marmeon/mail/auth/EmailInUseMail').assertOk()).body).toContain('<th>Subject</th><td>Someone wanted to use your e-mail address</td>');
    const preview = await app.get('/_marmeon/mail/auth/VerifyEmailMail?locale=de').assertOk();
    expect(preview.body).toContain('<th>Subject</th><td>Bestätige deine E-Mail-Adresse</td>');
    expect(preview.body).toContain('Ada Lovelace');
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(preview.headers.get('set-cookie')).toBeNull(); // no session, no cookies
    await app.assertDatabaseCount('users', 0); // sample data is made, never stored
  });

  it('answer only localhost and the host of APP_URL (DNS rebinding) — any other Host gets 403, without Vite in front', async () => {
    const app = await createTestApp(application, { database: 'refresh', env: { NODE_ENV: 'development', APP_URL: 'http://shop.test:3960' } });
    const paths = ['/_marmeon/mail', '/_marmeon/mail/auth/VerifyEmailMail'];
    for (const path of paths) {
      for (const host of ['evil.example', 'evil.example:3960', 'localhost.evil.example', 'shop.test.evil.example']) {
        const refused = await app.get(path, { headers: { host } });
        expect(refused.status, `${host} ${path}`).toBe(403);
        expect(refused.body).not.toContain('<th>Subject</th>');
        expect(refused.headers.get('cache-control')).toBe('no-store');
      }
      for (const host of ['localhost:3960', '127.0.0.1', '[::1]:3960', 'shop.test:3960']) {
        const answer = await app.get(path, { headers: { host } }).assertOk();
        expect(answer.headers.get('cross-origin-resource-policy'), `${host} ${path}`).toBe('same-origin');
      }
    }
  });
});
