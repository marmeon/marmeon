import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, secret } from '@marmeon/database';
import { DevtoolsStore, FileStore } from '@marmeon/devtools';
import { createTestApp } from '@marmeon/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserRepository } from '../auth/index.ts';
import { ResetPasswordMail } from '../auth/mail/ResetPasswordMail.ts';
import { WARM_UP_TIMEOUT, warmUp } from '../auth/warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

// The devtools: what a registration does — the request, its queries, the jobs it queued, the mails a
// worker sent for it — tied together by the request id, and nothing of the password on record.
describe('the devtools', () => {
  it('record a registration: request, queries, jobs and mails — tied by the request id', async () => {
    const app = await createTestApp(application, { database: 'refresh', devtools: true });
    const password = 'correct horse battery';
    const response = await app
      .post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password, password_confirmation: password }, headers: { referer: 'http://localhost/register' } })
      .assertRedirect('/register/sent');
    const requestId = response.headers.get('x-request-id')!;

    const request = app.devtools.assertRecorded('request', (content) => content.route === 'auth.register.store');
    expect(request.requestId).toBe(requestId);
    expect(request.content).toMatchObject({ method: 'POST', status: 303, controller: 'RegisterController' });
    expect(request.content.input).toMatchObject({ email: 'ada@example.com', password: '[redacted]', password_confirmation: '[redacted]' });

    const batch = app.devtools.batch(request.batch);
    // The insert of the account touches `users.password` (a secret column): no parameter of it is on record.
    const insert = batch.find((entry) => entry.type === 'query' && /insert into "?users"?/.test(entry.content.sql));
    expect(insert?.type === 'query' && insert.content).toMatchObject({ sensitive: true });
    expect(insert?.type === 'query' && insert.content.parameters.every((parameter) => parameter === '[redacted]')).toBe(true);
    // Queued with the registration's commit: the verification mail (a queued listener) and the welcome mail.
    const queued = batch.filter((entry) => entry.type === 'job').map((entry) => (entry.type === 'job' ? `${entry.content.name} ${entry.content.status}` : ''));
    expect(queued).toEqual(expect.arrayContaining(['marmeon.listener queued', 'auth.send-welcome-mail queued']));
    app.devtools.assertRecorded('event', (event) => event.name === 'auth.registered');

    // A worker runs them — in other batches, still tied to the request — and sends the mails.
    await app.queue.work();
    await app.devtools.settled();
    const attempts = app.devtools.entries('job').filter((entry) => entry.content.status === 'done');
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((entry) => entry.requestId === requestId && entry.batch !== request.batch)).toBe(true);
    // The listener's payload is encrypted: only "[encrypted]" is on record.
    expect(attempts.find((entry) => entry.content.name === 'marmeon.listener')?.content.payload).toBe('[encrypted]');
    const mails = app.devtools.entries('mail').filter((entry) => entry.requestId === requestId);
    expect(mails.map((entry) => entry.content.mailable).sort()).toEqual(expect.arrayContaining(['VerifyEmailMail', 'WelcomeMail']));
    // The verification link is signed: its signature is masked in the body.
    const verify = mails.find((entry) => entry.content.mailable === 'VerifyEmailMail')!;
    expect(verify.content.to).toEqual(['ada@example.com']);
    expect(verify.content.html).toMatch(/signature=\[redacted\]/);

    const recorded = JSON.stringify(app.devtools.entries());
    expect(recorded).not.toContain(password);
    expect(recorded).not.toMatch(/\$argon2id\$/);
  });

  // The sessions in the database too: their statements (`sessions.payload` is a secret column) carry the session id.
  // A whole account's life in one test — registration, two sign-ins, sign-out, a password reset through the worker, an API token — and
  // every file the recorder wrote: 0.1 s here, past 5 s on a fully loaded machine; its own time, like the page test below.
  it.each(['memory', 'database'])('keep none of a session’s secrets — registration, login, reset, API token — in what they write (sessions: %s)', { timeout: 20_000 }, async (driver) => {
    const app = await createTestApp(application, { database: 'refresh', devtools: true, env: { SESSION_DRIVER: driver } });
    const email = 'ada@example.com';
    const [password, newPassword] = ['correct horse battery', 'brand new staple 42'];
    const registered = await app.post('/register', { form: { name: 'Ada Lovelace', email, password, password_confirmation: password }, headers: { referer: 'http://localhost/register' } }).assertRedirect('/register/sent');
    expect(registered.headers.getSetCookie()).toEqual([]); // private registration: no session
    // The app opens for a confirmed address only — confirmed here directly; the link's own path is tested in the auth module.
    const users = app.make(UserRepository);
    await users.markEmailVerified((await users.findByEmail(email))!.id);
    const first = await app.post('/login', { form: { email, password } }).assertRedirect('/users/me');
    const sessions = [first.cookie('marmeon_session')!];
    const csrf = decodeURIComponent(first.cookie('XSRF-TOKEN')!);
    await app.withCookie('marmeon_session', sessions[0]!).post('/logout', { form: {} }).assertRedirect();
    sessions.push((await app.post('/login', { form: { email, password } }).assertRedirect('/users/me')).cookie('marmeon_session')!);

    // The reset: the worker makes the token and mails the link; the link moves it into a cookie.
    await app.post('/forgot-password', { form: { email }, headers: { referer: 'http://localhost/forgot-password' } }).assertRedirect('/forgot-password');
    await app.queue.work();
    const link = new URL(/https?:\/\/\S+\/reset-password\?\S+(?=\))/.exec(app.mail.queued(ResetPasswordMail).at(-1)!.message.text)![0]);
    const resetToken = link.searchParams.get('token')!;
    const reset = (await app.get(link.pathname + link.search).assertRedirect('/reset-password')).cookie('password_reset')!;
    await app
      .withCookie('password_reset', reset)
      .post('/reset-password', { form: { password: newPassword, password_confirmation: newPassword }, headers: { referer: 'http://localhost/reset-password' } })
      .assertRedirect('/login');

    // An API token: created (its plain text shown once), then used.
    const login = await app.post('/login', { form: { email, password: newPassword } }).assertRedirect('/users/me');
    sessions.push(login.cookie('marmeon_session')!);
    const created = await app.withCookie('marmeon_session', login.cookie('marmeon_session')!).navigating().post('/settings/tokens', { json: { name: 'CLI', abilities: ['users:read'] } }).assertOk();
    const apiToken = (created.page()!.props as { plainText: string }).plainText;
    await app.withHeaders({ authorization: `Bearer ${apiToken}` }).expectingJson().get('/api/users').assertOk();
    await app.devtools.settled();

    const { password: hash } = await app.make(Database).selectFrom('users').select((eb) => secret(eb, 'password')).where('email', '=', email).executeTakeFirstOrThrow();
    expect(String(hash)).toMatch(/^\$argon2id\$/);
    if (driver === 'database') expect(app.devtools.entries('query').some((query) => query.content.sql.includes('"sessions"') || query.content.sql.includes('sessions'))).toBe(true);
    // What the store writes, as it writes it: NDJSON files.
    const directory = mkdtempSync(join(tmpdir(), 'marmeon-devtools-plain-'));
    try {
      await new FileStore({ directory }).write(app.devtools.entries());
      const written = readdirSync(directory).map((name) => readFileSync(join(directory, name), 'utf8')).join('');
      expect(written.split('\n').length).toBeGreaterThan(50);
      const secrets = { password, newPassword, resetToken, apiToken, apiSecret: apiToken.split('|')[1]!, csrf, hash: String(hash), ...Object.fromEntries(sessions.map((cookie, i) => [`session${i}`, cookie])) };
      const found = Object.entries(secrets).filter(([, value]) => written.includes(value)).map(([name]) => name);
      expect(found).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // The pages: the registration as a visit, its queries, the jobs it queued, then what the worker did for it; the
  // sign-in after it — the protocol's 409 reload across the sign-in boundary, no failure; the scheduler's lock warning.
  // Two password hashes, a worker and seven pages (the first ones render cold): 0.13 s here, 7–8 s on a fully loaded machine.
  it('show a registration in /_marmeon/devtools: the request, its queries, then the jobs and mails a worker ran for it', { timeout: 20_000 }, async () => {
    const app = await createTestApp(application, { database: 'refresh', devtools: true });
    const password = 'correct horse battery';
    const browser = { referer: 'http://localhost/register', 'sec-fetch-site': 'same-origin' };
    const registered = await app.navigating().post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password, password_confirmation: password }, headers: browser });
    expect(registered.status).toBe(303); // private registration: "check your inbox", nobody signed in
    const response = await app.navigating().post('/login', { form: { email: 'ada@example.com', password }, headers: browser });
    expect(response.status).toBe(409);
    await app.queue.work();
    await app.devtools.settled();
    const request = app.devtools.assertRecorded('request', (content) => content.route === 'auth.register.store');
    expect(request.content).toMatchObject({ status: 303, location: '/register/sent' });
    const signIn = app.devtools.assertRecorded('request', (content) => content.route === 'auth.login.store');
    expect(signIn.content).toMatchObject({ status: 409, location: '/users/me', reload: 'history' });
    expect(signIn.tags).toContain('reload');

    // Opened in the browser that is signed in to the app: the pages neither read nor write its session — no cookie comes back.
    const session = response.cookie('marmeon_session')!;
    expect(session).toBeTruthy();
    const list = await app.withCookie('marmeon_session', session).get('/_marmeon/devtools/requests').assertOk();
    expect(list.body).toContain('409 reload (history)');
    expect(list.headers.get('set-cookie')).toBeNull();
    expect((await app.get(`/_marmeon/devtools/requests/${signIn.id}`).assertOk()).body).toContain("409 is the protocol's full reload, not a failure");
    const page = (await app.get(`/_marmeon/devtools/requests/${request.id}`).assertOk()).body;
    expect(page).toContain('RegisterController');
    expect(page).toMatch(/Queries \(\d+,/);
    expect(page).toMatch(/Job marmeon\.listener — attempt 1, done/);
    expect(page).toContain('VerifyEmailMail');
    expect(page).not.toContain(password);

    const mail = app.devtools.assertRecorded('mail', (content) => content.mailable === 'VerifyEmailMail');
    const mailPage = (await app.get(`/_marmeon/devtools/mails/${mail.id}`).assertOk()).body;
    expect(mailPage).toMatch(/<iframe class="mail" sandbox src="\/_marmeon\/devtools\/mails\/[^"]+\/html"/);
    expect((await app.get(`/_marmeon/devtools/mails/${mail.id}/html`).assertOk()).body).toMatch(/signature=\[redacted\]/);

    const overview = (await app.get('/_marmeon/devtools').assertOk()).body;
    expect(overview).toContain('Scheduler: onOneServer()');
    expect(overview).toContain('CACHE_DRIVER=memory');
    expect((await app.get('/_marmeon/devtools/schedule').assertOk()).body).toContain('marmeon schedule:test session:prune');
    await app.get('/_marmeon/devtools/queue').assertOk();
    await app.close();
    // A test without the opt-in has no such pages.
    await (await createTestApp(application)).get('/_marmeon/devtools').assertNotFound();
  });

  it('record nothing in a test that does not opt in — also one running as development (never into storage/framework/devtools)', async () => {
    const app = await createTestApp(application, { database: 'refresh' });
    await app.get('/login').assertOk();
    expect(() => app.devtools).toThrow(/devtools: true/);
    const development = await createTestApp(application, { env: { NODE_ENV: 'development' } });
    await development.get('/login').assertOk();
    expect(development.application.container.has(DevtoolsStore)).toBe(false);
  });
});
