import { Auth, EmailChange, TwoFactorState } from '@marmeon/auth';
import { err, ok } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { UrlSigner } from '@marmeon/http';
import type { Mailable } from '@marmeon/mail';
import { Session as SessionService } from '@marmeon/session';
import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, type PendingTestResponse, type RequestOptions, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import auth from './index.ts';
import { SendEmailChangeMailJob } from './jobs/SendEmailChangeMailJob.ts';
import { ConfirmNewEmailMail } from './mail/ConfirmNewEmailMail.ts';
import { EmailChangedMail } from './mail/EmailChangedMail.ts';
import { EmailInUseMail } from './mail/EmailInUseMail.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

// Cold starts in a hook with its own time, not in the first test's 5 s (the worker's database, the queues, mjml, the mails).
beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
beforeEach(async () => {
  // No pause between two requests of an account: most tests ask more than once (the pause has a test of its own).
  app = await createTestApp(application, { database: 'refresh', env: { AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '0' } });
  ({ session: SESSION } = cookieNames(app));
});

// The change of address with private registration (the default): pending until the link sent to the new address
// is clicked; a free and a taken address get the same answer in the same time; the owner of a taken one gets a note. With
// AUTH_PRIVATE_REGISTRATION=false it changes at once and says "taken". The security decisions (the factor, the password's throttle, the single
// use of the link) are @marmeon/auth's `EmailChange`, tested there; these tests show that this module is wired to it.

/** A browser: it sends the session cookie the server set last — `checkPassword()` hands out a new session id — as a real one does. */
class Session {
  readonly #box: { cookie: string };
  readonly #view: (app: TestApp) => TestApp;
  constructor(cookie: string, box: { cookie: string } = { cookie }, view: (app: TestApp) => TestApp = (view) => view) {
    this.#box = box;
    this.#view = view;
  }
  navigating = () => new Session(this.#box.cookie, this.#box, (app) => this.#view(app).navigating());
  expectingJson = () => new Session(this.#box.cookie, this.#box, (app) => this.#view(app).expectingJson());
  get = (path: string, options?: RequestOptions) => this.#send('get', path, options);
  post = (path: string, options?: RequestOptions) => this.#send('post', path, options);
  put = (path: string, options?: RequestOptions) => this.#send('put', path, options);
  #send(verb: 'get' | 'post' | 'put', path: string, options?: RequestOptions): PendingTestResponse {
    const pending = this.#view(app.withCookie(SESSION, this.#box.cookie))[verb](path, options);
    pending.then(
      (response) => {
        this.#box.cookie = response.cookie(SESSION) ?? this.#box.cookie;
      },
      () => {},
    );
    return pending;
  }
}
/** Signed in with the password — which also confirms it: the security settings' sudo mode. */
const signIn = async (user: User): Promise<Session> => {
  const login = await app.post('/login', { form: { email: user.email, password: 'password' } }).assertRedirect('/users/me');
  return new Session(login.cookie(SESSION)!);
};
const change = (session: Session, email: string) => session.put('/settings/email', { form: { current_password: 'password', email }, headers: { referer: 'http://localhost/settings/security' } });
const reload = (user: User) => app.make(UserRepository).find(user.id) as Promise<User>;
/** The link in the last queued mail of a class (to `address`) — path and query. */
const linkIn = <M extends Mailable>(Mail: abstract new (...args: any[]) => M, address?: string) => {
  const sent = app.mail.queued(Mail, (_mail, message) => address === undefined || message.to[0]!.address === address).at(-1)!;
  const url = new URL(/https?:\/\/\S+\/email\/change\/\S+(?=\))/.exec(sent.message.text)![0]);
  return url.pathname + url.search;
};
/** What a response says, without what differs per request anyway: the time, its id, the requests left — and cookie values. */
const answer = (response: { status: number; headers: Headers; body: string }) => ({
  status: response.status,
  headers: [...response.headers]
    .filter(([name]) => !['date', 'x-request-id', 'x-ratelimit-remaining'].includes(name))
    .map(([name, value]) => [name, name === 'set-cookie' ? value.replace(/=[^;]*/, '=…') : value]),
  body: response.body,
});
/** The change waiting for `user`: the row of `email_changes` — `users` holds none. */
const waiting = async (user: User) => app.make(Connections).get<any>().selectFrom('email_changes').select(['email', 'expires_at']).where('user_id', '=', user.id).executeTakeFirst();
const pendingOn = async (session: Session) => ((await session.navigating().get('/settings/security').assertPage('auth/Security')).page()!.props as { pendingEmail: string | null }).pendingEmail;

describe('changing the address (private registration)', () => {
  it('keeps the account at its address until the link is clicked — then the new one is confirmed, the old one told', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, ' Katherine@NASA.example ')
      .assertRedirect('/settings/security')
      .assertFlashed('toast', { message: 'We sent a link to the new address. Your address changes once you click it there — within 60 minutes, signed in.' });
    app.queue.assertDispatched(SendEmailChangeMailJob, { user: kj.id, email: 'katherine@nasa.example' });
    app.mail.assertNothingQueued(); // composed by a worker, never in the request (the time would show it)
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com', email_verified_at: kj.email_verified_at });
    expect(await waiting(kj)).toMatchObject({ email: 'katherine@nasa.example' });
    expect(await pendingOn(session)).toBe('katherine@nasa.example');

    await app.queue.work();
    app.mail.assertQueued(ConfirmNewEmailMail, (_mail, message, options) => message.to[0]!.address === 'katherine@nasa.example' && options.queue === 'mail');
    app.mail.assertNotQueued(EmailChangedMail);
    expect((await reload(kj)).email).toBe('kj@example.com');

    app.travel({ minutes: 30 });
    await session.get(linkIn(ConfirmNewEmailMail)).assertRedirect('/users/me').assertFlashed('toast', { message: 'Your e-mail address is now katherine@nasa.example.' });
    const changed = await reload(kj);
    expect(changed).toMatchObject({ email: 'katherine@nasa.example' });
    expect(await waiting(kj)).toBeUndefined();
    expect(Math.abs(new Date(changed.email_verified_at!).getTime() - app.clock.now())).toBeLessThan(1000);
    app.mail.assertQueued(EmailChangedMail, (_mail, message) => message.to[0]!.address === 'kj@example.com' && message.text.includes('katherine@nasa.example'));
    await session.post('/logout');
    await app.post('/login', { form: { email: 'katherine@nasa.example', password: 'password' } }).assertRedirect('/users/me');
  });

  it('answers a free address and a taken one byte for byte alike — the answer, and the page it leads to', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    /**
     * The answer to a change, and the security page after it (its toast, its errors) — with the typed address (shown as pending) and
     * the flash message's id (random for every message) and what belongs to the session (every change gives it a new id) put aside.
     */
    const outcome = async (client: Session, email: string) => {
      const response = answer(await client.put('/settings/email', { form: { current_password: 'password', email }, headers: { referer: 'http://localhost/settings/security' } }));
      const page = answer(await session.navigating().get('/settings/security'));
      return { response, page: { ...page, body: page.body.replaceAll(email, '<typed>').replace(/"id":"[0-9a-f-]{36}","key"/g, '"id":"…","key"').replace(/"(onceScope|csrf|epoch|token)":"[^"]*"/g, '"$1":"…"') } };
    };
    // Free addresses as long as the taken one: a page that shows what was typed is then as long for both.
    for (const [client, free] of [[session, 'bob@example.com'], [session.navigating(), 'eve@example.com'], [session.expectingJson(), 'joe@example.com']] as const) {
      const freeOutcome = await outcome(client, free);
      expect(await outcome(client, 'ada@example.com'), 'a taken address is answered differently from a free one').toEqual(freeOutcome);
      expect(freeOutcome.page.body).toContain('<typed>'); // the page shows the pending address — what was typed, either way
    }
  });

  // The time of the two requests is measured in `email-change.timing.test.ts`. The same work for both addresses shows the same thing
  // without a clock: the request never asks whether the address has an account, and the worker decides which
  // mail goes out.
  it('does the same work for a taken address as for a free one — the same jobs, the same mails, the same row', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const mo = await app.factory(UserFactory).create({ email: 'mo@example.com' });
    app.freeze(); // the expiry of the stored change is then equal, too
    // What the request left behind, with the typed address put aside: the jobs in the queue, then (once a worker ran) the mails, then the row.
    const mails = () => app.mail.queued(ConfirmNewEmailMail).length + app.mail.queued(EmailInUseMail).length;
    const work = async (user: User, email: string) => {
      const before = mails();
      const response = await change(await signIn(user), email).assertRedirect('/settings/security');
      const queues = app.queue.pending().map((job) => job.queue);
      const dispatched = app.queue.dispatched(SendEmailChangeMailJob, { user: user.id }).map((entry) => Object.keys(entry.payload as object).toSorted());
      const row = await app.make(Connections).get<any>().selectFrom('email_changes').selectAll().where('user_id', '=', user.id).execute();
      const inTheRequest = mails() - before; // a mail composed in the request, for one kind of address only, would show here
      await app.queue.work();
      const toEmail = (_mail: unknown, message: { to: readonly { address: string }[] }) => message.to[0]!.address === email;
      const toNewAddress = app.mail.queued(ConfirmNewEmailMail, toEmail).length + app.mail.queued(EmailInUseMail, toEmail).length;
      return {
        status: response.status,
        jobs: queues.length,
        queues,
        dispatched,
        inTheRequest,
        mailsToTheNewAddress: toNewAddress,
        rows: row.map((entry) => ({ columns: Object.keys(entry).toSorted(), email: entry.email === email ? '<typed>' : entry.email, expiresAt: String(entry.expires_at), hasToken: typeof entry.token_hash === 'string' && entry.token_hash.length > 0 })),
      };
    };
    const taken = await work(kj, 'ada@example.com');
    const free = await work(mo, 'bob@example.com');
    expect(taken.jobs).toBeGreaterThan(0);
    expect(taken.rows).toHaveLength(1);
    expect(taken.mailsToTheNewAddress).toBe(1);
    expect(taken).toEqual(free);
  });

  it('notes to the owner of a taken address that someone wanted it — nothing changes for anybody', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com', name: 'Ada Lovelace', locale: 'de' });
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'ADA@example.com').assertRedirect('/settings/security');
    await app.queue.work();
    app.mail.assertQueued(EmailInUseMail, (_mail, message) => message.to[0]!.address === 'ada@example.com' && message.subject === 'Jemand wollte deine E-Mail-Adresse verwenden');
    app.mail.assertNotQueued(ConfirmNewEmailMail);
    expect((await reload(kj)).email).toBe('kj@example.com');
    expect((await reload(ada)).email).toBe('ada@example.com');
  });

  it('a link works for the signed-in account it was made for — not for another, not tampered with, not for a guest', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const dv = await app.factory(UserFactory).create({ email: 'dv@example.com' });
    const asKj = await signIn(kj);
    await change(asKj, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail, 'new@example.com');
    // Whoever has the inbox of the new address, signed in as somebody else: nothing changes for either account.
    const asDv = await signIn(dv);
    await asDv.expectingJson().get(link).assertForbidden();
    const tampered = new URL(link, 'http://localhost');
    tampered.pathname = tampered.pathname.replace(`/${kj.id}/`, `/${dv.id}/`);
    await asDv.expectingJson().get(tampered.pathname + tampered.search).assertForbidden();
    await app.get(link, { headers: { accept: 'text/html' } }).assertRedirect('/login');
    expect(await reload(dv)).toMatchObject({ email: 'dv@example.com' });
    expect(await waiting(dv)).toBeUndefined();
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com' });
    expect(await waiting(kj)).toMatchObject({ email: 'new@example.com' });
    await asKj.get(link).assertRedirect('/users/me');
    expect((await reload(kj)).email).toBe('new@example.com');
  });

  it('tells whoever opens a link signed in as another account which account it is for', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'new@example.com');
    await app.queue.work();
    const asDv = await signIn(await app.factory(UserFactory).create({ email: 'dv@example.com' }));
    await asDv.expectingJson().get(linkIn(ConfirmNewEmailMail)).assertForbidden().assertExactJson({ message: 'This link is for another account. Sign in with that one, then open the link again.' });
  });

  it('a link works once — and only for the latest request', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'first@example.com');
    await app.queue.work();
    const first = linkIn(ConfirmNewEmailMail, 'first@example.com');
    await change(session, 'second@example.com');
    await app.queue.work();
    const second = linkIn(ConfirmNewEmailMail, 'second@example.com');
    const refused = { message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.' };
    await session.expectingJson().get(first).assertForbidden().assertExactJson(refused);
    await session.get(second).assertRedirect('/users/me');
    await session.expectingJson().get(second).assertForbidden().assertExactJson(refused);
    expect((await reload(kj)).email).toBe('second@example.com');
    app.mail.assertQueuedCount(EmailChangedMail, 1);
  });

  it('a link past its own time is refused — even while the request would still wait (the signature)', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    app.travel({ minutes: 61 });
    await app.make(Connections).get<any>().updateTable('email_changes').set({ expires_at: new Date(app.clock.now() + 3_600_000) }).where('user_id', '=', kj.id).execute();
    await session.expectingJson().get(link).assertForbidden().assertExactJson({ message: 'Invalid signature.' });
    expect((await reload(kj)).email).toBe('kj@example.com');
  });

  it('a request past its time is refused — even while its link would still work (the row)', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    await app.make(Connections).get<any>().updateTable('email_changes').set({ expires_at: new Date(app.clock.now() - 1000) }).where('user_id', '=', kj.id).execute();
    await session.expectingJson().get(linkIn(ConfirmNewEmailMail)).assertForbidden().assertExactJson({
      message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.',
    });
    expect((await reload(kj)).email).toBe('kj@example.com');
    expect(await pendingOn(session)).toBeNull(); // an expired request is not shown as waiting either
  });

  it('refuses the click when another account took the address in the meantime — the unique index decides', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'grace@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    await app.factory(UserFactory).create({ email: 'grace@example.com' }); // registered after the link went out
    await session.expectingJson().get(link).assertStatus(409).assertExactJson({ message: 'Another account uses this address by now. Your address stays as it was.' });
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com' });
    expect(await waiting(kj)).toBeUndefined();
    app.mail.assertNotQueued(EmailChangedMail);
  });

  it('drops the request for good when the address was taken — its link stays refused once the address is free again', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'grace@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    const grace = await app.factory(UserFactory).create({ email: 'grace@example.com' });
    await session.expectingJson().get(link).assertStatus(409);
    await app.make(Connections).get<any>().deleteFrom('users').where('id', '=', grace.id).execute();
    await session.expectingJson().get(link).assertForbidden().assertExactJson({
      message: 'This link no longer works — it was used, a newer one replaced it, or it expired. Change your address again on the security page.',
    });
    expect(await reload(kj)).toMatchObject({ email: 'kj@example.com' });
    expect(await waiting(kj)).toBeUndefined();
    expect(await pendingOn(session)).toBeNull();
  });

  it('a pending address signs nobody in — and gets no reset link', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'new@example.com');
    await app.post('/login', { form: { email: 'new@example.com', password: 'password' }, headers: { referer: 'http://localhost/login' } }).assertRedirect('/login').assertInvalid(['email']).assertGuest();
    await app.post('/forgot-password', { form: { email: 'new@example.com' } });
    await app.queue.work();
    app.mail.assertNotQueued(ResetPasswordMail);
  });

  it('the account’s own address again drops a pending change', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'new@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    await change(session, 'KJ@example.com').assertRedirect('/settings/security');
    expect(await pendingOn(session)).toBeNull();
    await session.expectingJson().get(link).assertForbidden();
  });

  it('keeps no pending address in users — no other module reads one, and the token hash is a secret column', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    await change(await signIn(kj), 'new@example.com');
    expect(JSON.stringify(await reload(kj))).not.toContain('new@example.com');
    expect(JSON.stringify(await app.make(Connections).get<any>().selectFrom('users').selectAll().execute())).not.toContain('new@example.com');
    expect(auth.exposes, 'other modules read users, never email_changes').toEqual(['users']);
    expect(Object.keys((await app.make(Connections).get<any>().selectFrom('email_changes').selectAll().executeTakeFirstOrThrow()) as object)).not.toContain('token_hash');
  });

  it('sends two mails an hour to an address for an account and three to it in all — a stranger cannot shut its owner out, nor fill its inbox', async () => {
    const accounts = await Promise.all(['a', 'b', 'c', 'd'].map((name) => app.factory(UserFactory).create({ email: `${name}@example.com` })));
    const toTarget = () => app.mail.queued(ConfirmNewEmailMail, (_mail, message) => message.to[0]!.address === 'target@example.com');
    const [a, b, c, d] = accounts as [User, User, User, User];
    const asA = await signIn(a);
    // X, Y, X again: the first link of X is replaced, so the second must arrive.
    for (const address of ['target@example.com', 'elsewhere@example.com', 'target@example.com']) {
      await change(asA, address);
      await app.queue.work();
    }
    expect(toTarget(), 'the second link of X arrives').toHaveLength(2);
    for (const address of ['elsewhere@example.com', 'target@example.com']) {
      await change(asA, address);
      await app.queue.work();
    }
    expect(toTarget(), 'two an hour for an account').toHaveLength(2);
    // Other accounts: each gets its own mail, up to three to the address in all.
    for (const other of [b, c]) {
      await change(await signIn(other), 'target@example.com');
      await app.queue.work();
    }
    expect(toTarget(), 'three an hour to an address').toHaveLength(3);
    app.travel({ minutes: 61 });
    await change(await signIn(d), 'target@example.com');
    await app.queue.work();
    expect(toTarget(), 'an hour later the next one goes out').toHaveLength(4);
  });

  it('keeps the link when the same address is asked for again: one mail, and the first link still works', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'target@example.com');
    await app.queue.work();
    const link = linkIn(ConfirmNewEmailMail);
    await change(session, 'target@example.com').assertRedirect('/settings/security');
    await app.queue.work();
    expect(app.mail.queued(ConfirmNewEmailMail)).toHaveLength(1);
    await session.get(link).assertRedirect();
    expect((await reload(kj)).email).toBe('target@example.com');
  });

  it('waits a minute after a request that sent a link — a second one inside the pause is answered alike and does nothing', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh' });
    ({ session: SESSION } = cookieNames(app));
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'first@example.com').assertRedirect('/settings/security');
    await change(session, 'second@example.com').assertRedirect('/settings/security');
    await app.queue.work();
    expect(await waiting(kj)).toMatchObject({ email: 'first@example.com' });
    app.mail.assertNotQueued(ConfirmNewEmailMail, (_mail, message) => message.to[0]!.address === 'second@example.com');
    app.travel({ seconds: 61 });
    await change(session, 'second@example.com').assertRedirect('/settings/security');
    expect(await waiting(kj)).toMatchObject({ email: 'second@example.com' });
  });

  it('throttles changes: the seventh a minute from one account gets 429', async () => {
    const session = await signIn(await app.factory(UserFactory).create({ email: 'kj@example.com' }));
    for (let i = 1; i <= 6; i++) await change(session, `new${i}@example.com`).assertRedirect('/settings/security');
    await change(session, 'new7@example.com').assertStatus(429);
  });

  it('does not use up the pause when the same address is asked for again — another address right after goes through', async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh' });
    ({ session: SESSION } = cookieNames(app));
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'first@example.com');
    app.travel({ seconds: 61 });
    await change(session, 'first@example.com'); // still waiting: nothing is sent, and the pause stays free
    await change(session, 'second@example.com');
    expect(await waiting(kj)).toMatchObject({ email: 'second@example.com' });
  });

  it('the nightly prune clears the changes nobody confirmed in time — waiting ones stay', async () => {
    app.freeze(Date.parse('2026-10-05T20:00:00Z'));
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const dv = await app.factory(UserFactory).create({ email: 'dv@example.com' });
    await change(await signIn(kj), 'old-request@example.com');
    app.travelTo(Date.parse('2026-10-06T00:40:00Z'));
    await change(await signIn(dv), 'fresh-request@example.com');
    expect(app.schedule.due('2026-10-06T03:10:00+02:00')).toContain('auth:prune-tokens');
    const results = await app.schedule.run('2026-10-06T03:10:00+02:00');
    expect(results.find((result) => result.task === 'auth:prune-tokens')?.outcome).toBe('ran');
    expect(await waiting(kj)).toBeUndefined();
    expect(await waiting(dv)).toMatchObject({ email: 'fresh-request@example.com' });
  });
});

describe('changing the address with AUTH_PRIVATE_REGISTRATION=false', () => {
  beforeEach(async () => {
    await app.close();
    app = await createTestApp(application, { database: 'refresh', env: { AUTH_PRIVATE_REGISTRATION: 'false', AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '0' } });
    ({ session: SESSION } = cookieNames(app));
  });

  it('changes it at once, unconfirmed — a link to the new address, a note to the old one; the settings stay open to fix a typo', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'katherine@nasa.example').assertRedirect('/settings/security').assertFlashed('toast', { message: 'E-mail address changed. Please confirm the new one — we sent you a link.' });
    expect(await reload(kj)).toMatchObject({ email: 'katherine@nasa.example', email_verified_at: null });
    expect(await waiting(kj)).toBeUndefined();
    app.queue.assertNotDispatched(SendEmailChangeMailJob);
    app.mail.assertQueued(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'katherine@nasa.example');
    app.mail.assertQueued(EmailChangedMail, (_mail, message) => message.to[0]!.address === 'kj@example.com');
    expect(await pendingOn(session)).toBeNull();
    await change(session, 'katherine@nasa.example.com').assertRedirect('/settings/security');
    expect((await reload(kj)).email).toBe('katherine@nasa.example.com');
  });

  it('mails an address a confirmation link and the old address a note only once an hour — swapping between two addresses fills no inbox', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    for (const address of ['one@example.com', 'two@example.com', 'one@example.com', 'two@example.com']) await change(session, address).assertRedirect('/settings/security');
    const to = (address: string, Mail: abstract new (...args: any[]) => Mailable) => app.mail.queued(Mail, (_mail, message) => message.to[0]!.address === address);
    expect(to('one@example.com', VerifyEmailMail), 'one confirmation mail an hour to an address').toHaveLength(1);
    expect(to('two@example.com', VerifyEmailMail)).toHaveLength(1);
    expect(to('one@example.com', EmailChangedMail), 'one note an hour to an address').toHaveLength(1);
    expect(to('two@example.com', EmailChangedMail)).toHaveLength(1);
    expect((await reload(kj)).email, 'the address is changed all the same').toBe('two@example.com');
  });

  it('says that an address is taken — and has no change links', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const session = await signIn(kj);
    await change(session, 'ada@example.com').assertInvalid({ email: 'This e-mail address is already registered.' });
    expect((await reload(kj)).email).toBe('kj@example.com');
    const link = new URL(app.make(UrlSigner).temporarySignedRoute('auth.email.confirm', { id: kj.id, token: 'token' }, 600), 'http://localhost');
    await session.expectingJson().get(link.pathname + link.search).assertNotFound();
  });
});

describe('the change of address asks for a recent factor itself', () => {
  /** `EmailChange` built from the container for an account with an authenticator and a session that proved no factor: no route, no middleware in front of it. */
  const serviceWithoutProof = (user: User) => {
    const scope = app.container.createScope();
    scope.instance(Auth, { user: async () => user, checkPassword: async (password: string) => (password === 'password' ? ok() : err({ kind: 'invalid-password' })) } as unknown as Auth);
    scope.instance(SessionService, { started: false } as unknown as SessionService);
    scope.instance(TwoFactorState, { factors: async () => ['totp'] } as unknown as TwoFactorState);
    return scope.make(EmailChange);
  };

  it('throws before anything is stored when the session has no recent factor — even on a route without confirmedSecondFactor()', async () => {
    const kj = await app.factory(UserFactory).create({ email: 'kj@example.com' });
    const handlers = { deliver: async () => {}, apply: (id: number, email: string, at: Date | null) => app.make(UserRepository).applyEmailChange(id, email, at) };
    await expect(serviceWithoutProof(kj).request('katherine@nasa.example', 'password', handlers)).rejects.toThrow('second factor proven within 15 minutes');
    expect(await waiting(kj)).toBeUndefined();
    app.queue.assertNothingDispatched();
  });
});
