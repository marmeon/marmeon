import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database, secret } from '@bespokecore/database';
import { DevtoolsStore, FileStore } from '@bespokecore/devtools';
import { createTestApp } from '@bespokecore/testing';
import { describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { ResetPasswordMail } from '../auth/mail/ResetPasswordMail.ts';

// The devtools (W7, E115–E116, E131): what a registration does — the request, its queries, the jobs it queued, the mails a
// worker sent for it — tied together by the request id, and nothing of the password on record (E125).
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
    expect(queued).toEqual(expect.arrayContaining(['bespoke.listener queued', 'auth.send-welcome-mail queued']));
    app.devtools.assertRecorded('event', (event) => event.name === 'auth.registered');

    // A worker runs them — in other batches, still tied to the request (E131) — and sends the mails.
    await app.queue.work();
    await app.devtools.settled();
    const attempts = app.devtools.entries('job').filter((entry) => entry.content.status === 'done');
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((entry) => entry.requestId === requestId && entry.batch !== request.batch)).toBe(true);
    // The listener's payload is encrypted (E105): only "[encrypted]" is on record.
    expect(attempts.find((entry) => entry.content.name === 'bespoke.listener')?.content.payload).toBe('[encrypted]');
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
  it.each(['memory', 'database'])('keep none of a session’s secrets — registration, login, reset, API token — in what they write (E125; sessions: %s)', async (driver) => {
    const app = await createTestApp(application, { database: 'refresh', devtools: true, env: { SESSION_DRIVER: driver } });
    const email = 'ada@example.com';
    const [password, newPassword] = ['correct horse battery', 'brand new staple 42'];
    const csrf = (await app.navigating().get('/register').assertOk()).page()!.csrf!;
    const registered = await app
      .post('/register', { form: { name: 'Ada Lovelace', email, password, password_confirmation: password, _token: csrf }, headers: { referer: 'http://localhost/register', 'x-xsrf-token': csrf } })
      .assertRedirect('/register/sent');
    const sessions = [registered.cookie('bespoke_session')!];
    await app.withCookie('bespoke_session', sessions[0]!).post('/logout', { form: {} }).assertRedirect();
    sessions.push((await app.post('/login', { form: { email, password } }).assertRedirect('/users/me')).cookie('bespoke_session')!);

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
    sessions.push(login.cookie('bespoke_session')!);
    const created = await app.withCookie('bespoke_session', login.cookie('bespoke_session')!).navigating().post('/settings/tokens', { json: { name: 'CLI', abilities: ['users:read'] } }).assertOk();
    const apiToken = (created.page()!.props as { plainText: string }).plainText;
    await app.withHeaders({ authorization: `Bearer ${apiToken}` }).expectingJson().get('/api/users').assertOk();
    await app.devtools.settled();

    const { password: hash } = await app.make(Database).selectFrom('users').select((eb) => secret(eb, 'password')).where('email', '=', email).executeTakeFirstOrThrow();
    expect(String(hash)).toMatch(/^\$argon2id\$/);
    if (driver === 'database') expect(app.devtools.entries('query').some((query) => query.content.sql.includes('"sessions"') || query.content.sql.includes('sessions'))).toBe(true);
    // What the store writes, as it writes it: NDJSON files.
    const directory = mkdtempSync(join(tmpdir(), 'bespoke-devtools-plain-'));
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

  // The pages (W7 step 8): the registration as a visit, its queries, the jobs it queued, then what the worker did for it; the
  // sign-in after it — the protocol's 409 reload across the sign-in boundary, no failure; the scheduler's lock warning (E123).
  it('show a registration in /_bespoke/devtools: the request, its queries, then the jobs and mails a worker ran for it', async () => {
    const app = await createTestApp(application, { database: 'refresh', devtools: true });
    const password = 'correct horse battery';
    const browser = { referer: 'http://localhost/register', 'sec-fetch-site': 'same-origin' };
    const registered = await app.navigating().post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password, password_confirmation: password }, headers: browser });
    expect(registered.status).toBe(303); // private registration (E146): "check your inbox", nobody signed in
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
    const session = response.cookie('bespoke_session')!;
    expect(session).toBeTruthy();
    const list = await app.withCookie('bespoke_session', session).get('/_bespoke/devtools/requests').assertOk();
    expect(list.body).toContain('409 reload (history)');
    expect(list.headers.get('set-cookie')).toBeNull();
    expect((await app.get(`/_bespoke/devtools/requests/${signIn.id}`).assertOk()).body).toContain("409 is the protocol's full reload, not a failure");
    const page = (await app.get(`/_bespoke/devtools/requests/${request.id}`).assertOk()).body;
    expect(page).toContain('RegisterController');
    expect(page).toMatch(/Queries \(\d+,/);
    expect(page).toMatch(/Job bespoke\.listener — attempt 1, done/);
    expect(page).toContain('VerifyEmailMail');
    expect(page).not.toContain(password);

    const mail = app.devtools.assertRecorded('mail', (content) => content.mailable === 'VerifyEmailMail');
    const mailPage = (await app.get(`/_bespoke/devtools/mails/${mail.id}`).assertOk()).body;
    expect(mailPage).toMatch(/<iframe class="mail" sandbox src="\/_bespoke\/devtools\/mails\/[^"]+\/html"/);
    expect((await app.get(`/_bespoke/devtools/mails/${mail.id}/html`).assertOk()).body).toMatch(/signature=\[redacted\]/);

    const overview = (await app.get('/_bespoke/devtools').assertOk()).body;
    expect(overview).toContain('Scheduler (E123): onOneServer()');
    expect(overview).toContain('CACHE_DRIVER=memory');
    expect((await app.get('/_bespoke/devtools/schedule').assertOk()).body).toContain('bespoke schedule:test session:prune');
    await app.get('/_bespoke/devtools/queue').assertOk();
    await app.close();
    // A test without the opt-in has no such pages (E115).
    await (await createTestApp(application)).get('/_bespoke/devtools').assertNotFound();
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
