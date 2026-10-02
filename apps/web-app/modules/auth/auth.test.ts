import { Hasher, PasswordHasher, type PasswordHash } from '@bespokecore/auth';
import { ConsoleLogger, Logger, type LogContext } from '@bespokecore/core';
import { Connections } from '@bespokecore/database';
import { Database, secret } from '@bespokecore/database';
import { MailFake, Mailer, type Mailable, type MailMessage } from '@bespokecore/mail';
import { createHttpKernel } from '@bespokecore/server';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { UserFactory } from './factories/UserFactory.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import type { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import type { LoginController } from './controllers/LoginController.ts';
import type { RegisterController } from './controllers/RegisterController.ts';
import type { ResetPasswordController } from './controllers/ResetPasswordController.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';
import { EmailChangedMail } from './mail/EmailChangedMail.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';
import type { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';
import type { ShowLoginController } from './controllers/ShowLoginController.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('auth module', () => {
  const credentials = (user: User, password = 'password') => ({ form: { email: user.email, password } });

  it('signs in with e-mail and password in a regenerated session (303 to the profile)', async () => {
    const grace = await app.factory(UserFactory).create({ name: 'Grace Hopper' });
    const planted = await app.get('/login'); // a session id handed out before login …
    const response = await app
      .withCookie('bespoke_session', planted.cookie('bespoke_session')!)
      .post('/login', credentials(grace))
      .assertStatus(303)
      .assertRedirect('/users/me')
      .assertValid()
      .assertAuthenticated(grace);

    // … does not survive it: the planted cookie is a guest's, the new one is signed in.
    expect(response.cookie('bespoke_session')).not.toBe(planted.cookie('bespoke_session'));
    await app.withCookie('bespoke_session', planted.cookie('bespoke_session')!).get('/users/me').assertRedirect('/login');
    await app.withCookie('bespoke_session', response.cookie('bespoke_session')!).get('/users/me').assertRedirect(`/users/${grace.id}`);
  });

  it('normalizes the e-mail in the request — never the password', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.post('/login', { form: { email: '  ADA@Example.COM ', password: 'password' } }).assertRedirect('/users/me').assertAuthenticated(ada);
    await app.post('/login', { form: { email: 'ada@example.com', password: ' password ' } }).assertInvalid<LoginController>(['email']).assertGuest();
  });

  it('validates the login (LoginRequest) next to the fields', async () => {
    await app.post('/login', { form: { email: 'nope', password: '' } }).assertRedirect('/').assertInvalid<LoginController>({
      email: 'Enter a valid e-mail address.',
      password: 'Enter your password.',
    });
    await app.expectingJson().post('/login', { json: {} }).assertUnprocessable().assertInvalid<LoginController>(['email', 'password']);
  });

  it('counter-check (enumeration): an unknown e-mail is answered exactly like a wrong password', async () => {
    const ada = await app.factory(UserFactory).create();
    const answer = async (email: string) => {
      const response = await app.post('/login', { form: { email, password: 'wrong' }, headers: { referer: 'http://localhost/login' } });
      return { status: response.status, location: response.headers.get('location'), errors: response.session().errors };
    };
    const wrongPassword = await answer(ada.email);
    expect(wrongPassword).toEqual({ status: 303, location: '/login', errors: { email: ['These credentials do not match our records.'] } });
    expect(await answer('nobody@example.com')).toEqual(wrongPassword);
    await app.expectingJson().post('/login', { json: { email: 'nobody@example.com', password: 'x' } }).assertUnprocessable().assertExactJson({
      message: 'These credentials do not match our records.',
      errors: { email: ['These credentials do not match our records.'] },
    });
  });

  it('counter-check: the password is never flashed — the form comes back with the e-mail only', async () => {
    const response = await app
      .post('/login', { form: { email: 'nobody@example.com', password: 'hunter2' }, headers: { referer: 'http://localhost/login' } })
      .assertSessionHas('_old_input', { email: 'nobody@example.com' });
    expect(JSON.stringify(response.session())).not.toContain('hunter2');
    await app
      .withCookie('bespoke_session', response.cookie('bespoke_session')!)
      .navigating()
      .get('/login')
      .assertPage<ShowLoginController>('auth/Login', { old: { email: 'nobody@example.com' }, errors: { email: ['These credentials do not match our records.'] } });
  });

  it('signs out: a guest again, a new session, and a message on the login page', async () => {
    const ada = await app.factory(UserFactory).create();
    // The redirect delivers no message (E60): it waits in the new session for the page that is shown.
    const response = await app.actingAs(ada).post('/logout').assertRedirect('/login').assertGuest().assertNoFlash();
    await app
      .withCookie('bespoke_session', response.cookie('bespoke_session')!)
      .navigating()
      .get('/login')
      .assertPage<ShowLoginController>('auth/Login', { auth: { user: null } })
      .assertFlash('toast', { kind: 'success', message: 'You have been signed out.' });
    await app.post('/logout').assertRedirect('/login'); // guests cannot sign out
  });

  it('keeps signed-in people away from the login page, and brings guests back where they wanted to go', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).get('/login').assertRedirect('/users/me');
    await app.actingAs(ada).post('/login', credentials(ada)).assertRedirect('/users/me');

    const away = await app.get(`/users/${ada.id}/edit`, { headers: { accept: 'text/html' } }).assertRedirect('/login');
    await app
      .withCookie('bespoke_session', away.cookie('bespoke_session')!)
      .post('/login', credentials(ada))
      .assertRedirect(`/users/${ada.id}/edit`);
  });

  it('counter-check: a password changed elsewhere ends the other sessions', async () => {
    const ada = await app.factory(UserFactory).create();
    const signedIn = await app.post('/login', credentials(ada)).assertAuthenticated(ada);
    const laptop = app.withCookie('bespoke_session', signedIn.cookie('bespoke_session')!).expectingJson();
    await laptop.get('/users/me').assertRedirect(`/users/${ada.id}`);
    await app.make(UserRepository).updatePasswordHash(ada.id, await app.make(Hasher).make('changed on the phone'));
    await laptop.get('/users/me').assertUnauthorized();
  });

  it('rehashes a password made with other costs at the next login', async () => {
    const legacy = await new PasswordHasher({ driver: 'scrypt', argon2: { memory: 1024, time: 1, parallelism: 1 }, scrypt: { cost: 10, blockSize: 8, parallelism: 1 } }).make('password');
    const ada = await app.factory(UserFactory).create({ password: legacy });
    await app.post('/login', credentials(ada)).assertAuthenticated(ada);
    expect(await storedHash(ada.id)).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
  });

  it('refuses a login without CSRF token (419) and accepts the one from the login page', async () => {
    await app.close(); // one database app per test
    const protectedApp = await createTestApp(application, { csrf: true, database: 'refresh' });
    const ada = await protectedApp.factory(UserFactory).create();
    await protectedApp.post('/login', credentials(ada)).assertStatus(419);

    const page = await protectedApp.navigating().get('/login');
    const { csrfToken } = page.page()!.props as { csrfToken: string };
    const response = await protectedApp
      .withCookie('bespoke_session', page.cookie('bespoke_session')!)
      .post('/login', { form: { ...credentials(ada).form, _token: csrfToken } })
      .assertRedirect('/users/me');
    // The token rotates with the login: the one from the login page is worthless afterwards.
    await protectedApp
      .withCookie('bespoke_session', response.cookie('bespoke_session')!)
      .post('/logout', { form: { _token: csrfToken } })
      .assertStatus(419);
  });

  it('throttles failed logins per e-mail and address — five a minute, keyed on the validated e-mail', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await app.post('/login', credentials(ada, 'wrong')).assertInvalid<LoginController>({ email: 'These credentials do not match our records.' });
    }
    // Counter-check: writing the e-mail differently does not open a new budget (the key is the normalized e-mail) …
    await app.post('/login', { form: { email: ' ADA@example.com', password: 'password' } }).assertInvalid<LoginController>({ email: /^Too many login attempts\. Please try again in \d+ seconds\.$/ }).assertGuest();
    // … and even the right password waits.
    await app.post('/login', credentials(ada)).assertInvalid<LoginController>({ email: /^Too many login attempts/ });
    // Another person's budget is their own; a success clears it.
    const alan = await app.factory(UserFactory).create();
    await app.post('/login', credentials(alan, 'wrong')).assertInvalid<LoginController>(['email']);
    await app.post('/login', credentials(alan)).assertAuthenticated(alan);
    for (let attempt = 1; attempt <= 5; attempt++) await app.post('/login', credentials(alan, 'wrong'));
    await app.post('/login', credentials(alan, 'wrong')).assertInvalid<LoginController>({ email: /^Too many login attempts/ });
  });

  it('ignores forged session cookies', async () => {
    await app.withUnencryptedCookie('bespoke_session', 'x'.repeat(40)).expectingJson().get('/users/me').assertUnauthorized();
  });

  it('injects the validated app config (from .env.test under Vitest)', async () => {
    await app.navigating().get('/login').assertPage<ShowLoginController>('auth/Login', { appName: 'BespokeCore (test)' });
  });
});

describe('registration', () => {
  const register = (form: Record<string, string>) =>
    app.post('/register', { form: { name: 'Ada Lovelace', email: 'ada@example.com', password: 'correct horse', password_confirmation: 'correct horse', ...form }, headers: { referer: 'http://localhost/register' } });

  it('creates the user with a hashed password and signs them in', async () => {
    const response = await register({ email: '  Ada@Example.COM ' }).assertRedirect('/users/me');
    await app.assertDatabaseHas('users', { name: 'Ada Lovelace', email: 'ada@example.com' });
    const ada = await app.make(Database).selectFrom('users').select('id').where('email', '=', 'ada@example.com').executeTakeFirstOrThrow();
    response.assertAuthenticated({ id: ada.id } as User);
    expect(await app.make(Hasher).verify('correct horse', await storedHash(ada.id))).toBe(true);
    await app.post('/login', { form: { email: 'ada@example.com', password: 'correct horse' } }).assertRedirect('/users/me');
  });

  it('counter-check: an e-mail that exists — in any case — is a field error, not a 500', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await register({ email: 'ADA@example.com' }).assertRedirect('/register').assertInvalid<RegisterController>({ email: 'This e-mail address is already registered.' }).assertGuest();
    await app.assertDatabaseCount('users', 1);
  });

  it('checks the password: length, confirmation — and never flashes it', async () => {
    const short = await register({ password: 'short', password_confirmation: 'short' }).assertInvalid<RegisterController>({ password: 'The password needs at least 8 characters.' });
    expect(JSON.stringify(short.session())).not.toContain('short"');
    await register({ password_confirmation: 'correct house' }).assertInvalid<RegisterController>({ password_confirmation: 'The passwords do not match.' });
    await register({ name: 'A' }).assertInvalid<RegisterController>(['name']);
  });

  it('is for guests only', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).get('/register').assertRedirect('/users/me');
  });

  it('counter-check (E65): a password in the query string of the POST is never taken — 422 at the field, no account', async () => {
    // A link (or a log line, a Referer) carrying the password must not be able to fill in the form's fields.
    const url = '/register?password=geheim123&password_confirmation=geheim123';
    await app
      .post(url, { form: { name: 'Ada Lovelace', email: 'ada@example.com' }, headers: { referer: 'http://localhost/register' } })
      .assertRedirect('/register')
      .assertInvalid<RegisterController>(['password'])
      .assertGuest();
    await app.expectingJson().post(url, { json: { name: 'Ada Lovelace', email: 'ada@example.com' } }).assertUnprocessable().assertInvalid<RegisterController>(['password']);
    await app.assertDatabaseCount('users', 0);
  });
});

describe('remember me', () => {
  const rememberLogin = (user: User) => app.post('/login', { form: { email: user.email, password: 'password', remember: 'on' } });

  it('signs in by the cookie after the session is gone, and rotates it', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await rememberLogin(ada).assertAuthenticated(ada);
    const cookie = login.cookie('remember_web')!;
    expect(cookie).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    await app.assertDatabaseCount('remember_tokens', 1);

    const later = await app.withCookie('remember_web', cookie).get('/users/me').assertRedirect(`/users/${ada.id}`).assertAuthenticated(ada);
    expect(later.cookie('remember_web')).not.toBe(cookie);
    expect(later.cookie('remember_web')!.split('.')[0]).toBe(cookie.split('.')[0]);
  });

  it('does nothing without the checkbox', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(ada));
    expect(login.cookie('remember_web')).toBeUndefined();
    await app.assertDatabaseCount('remember_tokens', 0);
  });

  it('counter-check: a copied cookie used by someone else first ends every remember-me sign-in of the user', async () => {
    const ada = await app.factory(UserFactory).create();
    const copied = (await rememberLogin(ada)).cookie('remember_web')!;
    const otherDevice = (await rememberLogin(ada)).cookie('remember_web')!;
    await app.withCookie('remember_web', copied).get('/users/me').assertAuthenticated(ada); // the thief, first
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    try {
      await app.withCookie('remember_web', copied).expectingJson().get('/users/me').assertUnauthorized(); // the owner, later
      await app.withCookie('remember_web', otherDevice).expectingJson().get('/users/me').assertUnauthorized();
    } finally {
      vi.useRealTimers();
    }
    await app.assertDatabaseCount('remember_tokens', 0);
  });

  it('signing out forgets this device only', async () => {
    const ada = await app.factory(UserFactory).create();
    const laptop = await rememberLogin(ada);
    const phone = await rememberLogin(ada);
    await app.withCookie('bespoke_session', laptop.cookie('bespoke_session')!).withCookie('remember_web', laptop.cookie('remember_web')!).post('/logout').assertGuest();
    await app.assertDatabaseCount('remember_tokens', 1);
    await app.withCookie('remember_web', phone.cookie('remember_web')!).get('/users/me').assertAuthenticated(ada);
  });
});

describe('security settings', () => {
  it('asks for the password first ("sudo mode") and comes back to the page', async () => {
    const ada = await app.factory(UserFactory).create();
    const away = await app.actingAs(ada).get('/settings/security', { headers: { accept: 'text/html' } }).assertRedirect('/confirm-password');
    const session = app.withCookie('bespoke_session', away.cookie('bespoke_session')!);
    const wrong = await session.post('/confirm-password', { form: { password: 'wrong' }, headers: { referer: 'http://localhost/confirm-password' } });
    wrong.assertInvalid<ConfirmPasswordController>({ password: 'The password is incorrect.' });
    const right = await app.withCookie('bespoke_session', wrong.cookie('bespoke_session')!).post('/confirm-password', { form: { password: 'password' } });
    right.assertRedirect('/settings/security');
    await app.withCookie('bespoke_session', right.cookie('bespoke_session')!).navigating().get('/settings/security').assertPage('auth/Security', { viaRemember: false });
  });

  it('a fresh sign-in counts as confirmation', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(ada));
    await app.withCookie('bespoke_session', login.cookie('bespoke_session')!).navigating().get('/settings/security').assertOk();
  });

  it('counter-check: a new password signs out the other sessions and every remember-me device — the old password is dead', async () => {
    const ada = await app.factory(UserFactory).create();
    const phone = await app.post('/login', { form: { ...credentialsOf(ada).form, remember: 'on' } });
    const laptop = await app.post('/login', credentialsOf(ada));
    const here = app.withCookie('bespoke_session', laptop.cookie('bespoke_session')!);

    await here.put('/settings/password', { form: { current_password: 'wrong', password: 'a new password', password_confirmation: 'a new password' } }).assertInvalid<UpdatePasswordController>({
      current_password: 'The password is incorrect.',
    });
    const changed = await here.put('/settings/password', { form: { current_password: 'password', password: 'a new password', password_confirmation: 'a new password' } });
    changed.assertRedirect().assertFlashed('toast', { message: 'Password changed. You were signed out everywhere else.' }).assertAuthenticated(ada);

    await app.withCookie('bespoke_session', phone.cookie('bespoke_session')!).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('remember_web', phone.cookie('remember_web')!).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('bespoke_session', changed.cookie('bespoke_session')!).get('/users/me').assertRedirect(`/users/${ada.id}`);
    await app.post('/login', credentialsOf(ada)).assertGuest();
    await app.post('/login', { form: { email: ada.email, password: 'a new password' } }).assertAuthenticated(ada);
  });

  it('signs out the other devices with the password', async () => {
    const ada = await app.factory(UserFactory).create();
    const phone = await app.post('/login', { form: { ...credentialsOf(ada).form, remember: 'on' } });
    const laptop = await app.post('/login', credentialsOf(ada));
    const done = await app.withCookie('bespoke_session', laptop.cookie('bespoke_session')!).post('/settings/devices/logout', { form: { password: 'password' } });
    done.assertFlashed('toast', { message: 'Signed out on all other devices.' });
    await app.withCookie('bespoke_session', done.cookie('bespoke_session')!).get('/users/me').assertRedirect(`/users/${ada.id}`);
    await app.withCookie('bespoke_session', phone.cookie('bespoke_session')!).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('remember_web', phone.cookie('remember_web')!).expectingJson().get('/users/me').assertUnauthorized();
  });

  it('throttles password checks of a signed-in user — a stolen session is no guessing oracle', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(ada));
    const session = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    for (let attempt = 1; attempt <= 5; attempt++) await session.post('/confirm-password', { form: { password: `guess ${attempt}` } });
    await session.post('/confirm-password', { form: { password: 'password' } }).assertInvalid<ConfirmPasswordController>({ password: /^Too many attempts/ });
  });
});

describe('password reset', () => {
  const SENT = 'If an account exists for that address, we sent a link to reset its password.';
  const INVALID = 'This password reset link is invalid or has expired. Ask for a new one.';
  const ask = (email: string) => app.post('/forgot-password', { form: { email }, headers: { referer: 'http://localhost/forgot-password' } });
  /** The link from the last reset mail — path and query, as a browser would open it. */
  const linkInMail = () => {
    const [sent] = app.mail.sent(ResetPasswordMail).slice(-1);
    const url = new URL(/https?:\/\/\S+\/reset-password\?\S+(?=\))/.exec(sent!.message.text)![0]);
    return { path: url.pathname + url.search, token: url.searchParams.get('token')! };
  };
  const open = async () => (await app.get(linkInMail().path).assertRedirect('/reset-password')).cookie('password_reset')!;
  const resetWith = (cookie: string, password = 'brand new password') =>
    app.withCookie('password_reset', cookie).post('/reset-password', { form: { password, password_confirmation: password }, headers: { referer: 'http://localhost/reset-password' } });

  it('mails a link, takes the token out of the URL, sets the new password — once', async () => {
    const ada = await app.factory(UserFactory).create({ name: 'Ada', email: 'ada@example.com' });
    await ask(' ADA@example.com ').assertRedirect('/forgot-password').assertFlashed('toast', { message: SENT });
    app.mail.assertSentCount(ResetPasswordMail, 1).assertSent(ResetPasswordMail, (_mail, message) => message.to[0]!.address === 'ada@example.com');
    const [mail] = app.mail.sent(ResetPasswordMail);
    expect(mail!.message.html).toContain('<!--[if mso'); // MJML: built for mail clients
    expect(mail!.message.text).toContain('Hello Ada,');

    const cookie = await open();
    // The page knows the address, not the token: it is in neither the URL nor the props.
    const page = await app.withCookie('password_reset', cookie).navigating().get('/reset-password').assertPage('auth/ResetPassword', { email: 'ada@example.com' });
    expect(page.body).not.toContain(linkInMail().token);

    await resetWith(cookie).assertRedirect('/login').assertFlashed('toast', { message: 'Your password has been reset. Sign in with the new one.' }).assertCookieExpired('password_reset');
    await app.post('/login', credentialsOf(ada)).assertGuest();
    await app.post('/login', { form: { email: ada.email, password: 'brand new password' } }).assertAuthenticated(ada);
    // Counter-check: the same link a second time
    await resetWith(cookie, 'yet another password').assertInvalid<ResetPasswordController>({ password: INVALID });
  });

  it('counter-check (enumeration): an unknown address gets the same answer — and no mail', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const known = await ask('ada@example.com');
    const unknown = await ask('nobody@example.com');
    expect([unknown.status, unknown.headers.get('location'), unknown.session().status]).toEqual([known.status, known.headers.get('location'), known.session().status]);
    app.mail.assertSentCount(ResetPasswordMail, 1);
  });

  it('counter-check (enumeration by timing): the mail goes out after the response', async () => {
    await app.close(); // one database app per test
    let mailed = 0;
    class SlowMailer extends MailFake {
      override async send(mailable: Mailable): Promise<MailMessage> {
        await new Promise((resolve) => setTimeout(resolve, 150)); // a slow SMTP server
        mailed++;
        return super.send(mailable);
      }
    }
    app = await createTestApp(application, { database: 'refresh', mail: 'real', override: (c) => c.instance(Mailer, new SlowMailer()) });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const kernel = createHttpKernel(app.application); // its own kernel: TestApp waits for deferred work, a browser does not
    const time = async (email: string) => {
      const started = performance.now();
      const response = await kernel.request('/forgot-password', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${email}` });
      const ms = performance.now() - started;
      expect(response.status).toBe(303);
      return ms;
    };
    expect(await time('ada@example.com')).toBeLessThan(100);
    expect(await time('nobody@example.com')).toBeLessThan(100);
    await kernel.settle();
    expect(mailed).toBe(1);
  });

  it('counter-check: an expired link, another address’s token, no cookie — one answer', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await app.factory(UserFactory).create({ email: 'alan@example.com' });
    await ask('ada@example.com');
    const cookie = await open();
    const forAlan = JSON.stringify({ ...JSON.parse(cookie), email: 'alan@example.com' });
    await resetWith(forAlan).assertInvalid<ResetPasswordController>({ password: INVALID });
    await app.post('/reset-password', { form: { password: 'brand new password', password_confirmation: 'brand new password' } }).assertInvalid<ResetPasswordController>({ password: INVALID });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    try {
      await resetWith(cookie).assertInvalid<ResetPasswordController>({ password: INVALID });
    } finally {
      vi.useRealTimers();
    }
    await app.navigating().get('/reset-password').assertPage('auth/ResetPassword', { email: null });
  });

  it('counter-check: the token is only in the mail — not in the database, not in the request log', async () => {
    await app.close();
    const lines: string[] = [];
    class Capture extends ConsoleLogger {
      override info(message: string, context?: LogContext) {
        lines.push(`${message} ${JSON.stringify(context ?? {})}`);
      }
      override debug(message: string, context?: LogContext) {
        lines.push(`${message} ${JSON.stringify(context ?? {})}`);
      }
      override child(): Logger {
        return this;
      }
    }
    app = await createTestApp(application, { database: 'refresh', override: (c) => c.instance(Logger, new Capture()) });
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await ask('ada@example.com');
    const { token } = linkInMail();
    await open();
    const rows = await app.make(Database).selectFrom('password_reset_tokens').select(['email', (eb) => secret(eb, 'token_hash')]).execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(lines.some((line) => line.includes('GET /reset-password'))).toBe(true); // the request was logged …
    expect(lines.join('\n')).not.toContain(token); // … without its query
  });

  it('ends every session and remember-me device of the user', async () => {
    const ada = await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const phone = await app.post('/login', { form: { ...credentialsOf(ada).form, remember: 'on' } });
    await ask('ada@example.com');
    await resetWith(await open()).assertRedirect('/login');
    await app.withCookie('bespoke_session', phone.cookie('bespoke_session')!).expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie('remember_web', phone.cookie('remember_web')!).expectingJson().get('/users/me').assertUnauthorized();
  });

  it('throttles: one link per address a minute, five requests a minute per IP', async () => {
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    await ask('ada@example.com');
    await ask('ada@example.com');
    app.mail.assertSentCount(ResetPasswordMail, 1);
    for (let i = 0; i < 3; i++) await ask(`someone${i}@example.com`);
    await ask('ada@example.com').assertStatus(429);
  });
});

describe('e-mail verification', () => {
  /** The link of the last verification mail (to `address`) — path and query. */
  const verificationLink = (address?: string) => {
    const sent = app.mail.sent(VerifyEmailMail, (_mail, message) => address === undefined || message.to[0]!.address === address).at(-1);
    const url = new URL(/https?:\/\/\S+\/email\/verify\/\S+(?=\))/.exec(sent!.message.text)![0]);
    return url.pathname + url.search;
  };
  const register = (email = 'kj@example.com') =>
    app.post('/register', { form: { name: 'Katherine Johnson', email, password: 'orbital mechanics', password_confirmation: 'orbital mechanics' } });
  const userBy = (email: string) => app.make(UserRepository).query().selectAll().where('email', '=', email).executeTakeFirstOrThrow() as Promise<User>;

  it('mails a signed link after registration; the link verifies — then links may be published', async () => {
    const registered = await register().assertRedirect('/users/me');
    app.mail.assertSent(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'kj@example.com');
    const kj = await userBy('kj@example.com');
    expect(kj.email_verified_at).toBeNull();
    const session = app.withCookie('bespoke_session', registered.cookie('bespoke_session')!);

    await session.post(`/users/${kj.id}/links`, { form: { label: 'Blog', url: 'https://kj.example' } }).assertRedirect('/email/verify');
    await session.expectingJson().post(`/users/${kj.id}/links`, { json: { label: 'Blog', url: 'https://kj.example' } }).assertForbidden();
    const verifiedResponse = await session.get(verificationLink()).assertRedirect('/users/me').assertFlashed('toast', { message: 'Your e-mail address is verified.' });
    // The message waits through the hop via /users/me (a redirect takes none, E60) and shows on the profile.
    const hop = await app.withCookie('bespoke_session', verifiedResponse.cookie('bespoke_session')!).get('/users/me').assertRedirect(`/users/${kj.id}`).assertNoFlash();
    await app
      .withCookie('bespoke_session', hop.cookie('bespoke_session')!)
      .navigating()
      .get(`/users/${kj.id}`)
      .assertPage('user-profile/Show')
      .assertFlash('toast', { message: 'Your e-mail address is verified.' });
    expect((await userBy('kj@example.com')).email_verified_at).toMatch(/Z$/);
    await session.post(`/users/${kj.id}/links`, { form: { label: 'Blog', url: 'https://kj.example' } }).assertRedirect(`/users/${kj.id}`);
  });

  it('counter-checks: a changed parameter, a changed expiry, another user’s link, an expired link — 403', async () => {
    await register('kj@example.com');
    await register('dv@example.com');
    const kj = await userBy('kj@example.com');
    const dv = await userBy('dv@example.com');
    const link = new URL(verificationLink('kj@example.com'), 'http://localhost');
    const asKj = app.actingAs(kj).expectingJson();
    const tampered = (change: (url: URL) => void) => {
      const copy = new URL(link);
      change(copy);
      return asKj.get(copy.pathname + copy.search);
    };
    await tampered((url) => (url.pathname = url.pathname.replace(`/${kj.id}/`, `/${dv.id}/`))).assertForbidden(); // id changed
    await tampered((url) => url.searchParams.set('expires', String(Number(url.searchParams.get('expires')) + 86_400))).assertForbidden();
    // Dorothy's own, validly signed link — opened while signed in as Katherine:
    await asKj.get(verificationLink('dv@example.com')).assertForbidden().assertExactJson({ message: 'This verification link is not for your account.' });
    // Katherine's signature on Dorothy's path:
    const dvPath = new URL(verificationLink('dv@example.com'), 'http://localhost').pathname;
    await app.actingAs(dv).expectingJson().get(`${dvPath}${link.search}`).assertForbidden();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    try {
      await asKj.get(link.pathname + link.search).assertForbidden();
    } finally {
      vi.useRealTimers();
    }
    expect((await userBy('kj@example.com')).email_verified_at).toBeNull();
  });

  it('a guest opening the link signs in first and comes back to it', async () => {
    await register();
    const kj = await userBy('kj@example.com');
    const away = await app.get(verificationLink(), { headers: { accept: 'text/html' } }).assertRedirect('/login');
    const login = await app.withCookie('bespoke_session', away.cookie('bespoke_session')!).post('/login', { form: { email: kj.email, password: 'orbital mechanics' } });
    const back = new URL(login.headers.get('location')!, 'http://localhost');
    expect(back.pathname).toBe(new URL(verificationLink(), 'http://localhost').pathname);
    await app.withCookie('bespoke_session', login.cookie('bespoke_session')!).get(back.pathname + back.search).assertRedirect('/users/me');
    expect((await userBy('kj@example.com')).email_verified_at).not.toBeNull();
  });

  it('sends the link again on request — three times a minute', async () => {
    const kj = await app.factory(UserFactory).state('unverified').create();
    for (let i = 0; i < 3; i++) await app.actingAs(kj).post('/email/verification-notification').assertRedirect();
    app.mail.assertSentCount(VerifyEmailMail, 3);
    await app.actingAs(kj).post('/email/verification-notification').assertStatus(429);
  });

  it('changing the address needs the password again, unverifies it, mails both addresses — the old link dies', async () => {
    await register('kj@example.com');
    const kj = await userBy('kj@example.com');
    const oldLink = verificationLink('kj@example.com');
    await app.actingAs(kj).expectingJson().put('/settings/email', { json: { email: 'katherine@nasa.example' } }).assertStatus(423); // no recent confirmation
    const login = await app.post('/login', { form: { email: kj.email, password: 'orbital mechanics' } });
    const session = app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
    await session.put('/settings/email', { form: { email: ' Katherine@NASA.example ' } }).assertFlashed('toast', { message: 'E-mail address changed. Please confirm the new one — we sent you a link.' });
    expect(await userBy('katherine@nasa.example')).toMatchObject({ id: kj.id, email_verified_at: null });
    app.mail.assertSent(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'katherine@nasa.example');
    app.mail.assertSent(EmailChangedMail, (_mail, message) => message.to[0]!.address === 'kj@example.com');
    await session.expectingJson().get(oldLink).assertForbidden(); // the link for the old address
    await session.get(verificationLink('katherine@nasa.example')).assertRedirect('/users/me');
  });

  it('refuses an address another account has — a field error, not a 500', async () => {
    await app.factory(UserFactory).create({ email: 'taken@example.com' });
    const kj = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(kj));
    await app
      .withCookie('bespoke_session', login.cookie('bespoke_session')!)
      .put('/settings/email', { form: { email: 'TAKEN@example.com' }, headers: { referer: 'http://localhost/settings/security' } })
      .assertInvalid(['email']);
  });
});

describe('API tokens', () => {
  const sudo = async (user: User) => {
    const login = await app.post('/login', credentialsOf(user));
    return app.withCookie('bespoke_session', login.cookie('bespoke_session')!);
  };
  const createToken = async (user: User, abilities: string[] = ['users:read']) => {
    const page = await (await sudo(user)).navigating().post('/settings/tokens', { json: { name: 'CLI', abilities } }).assertOk();
    return (page.page()!.props as { plainText: string }).plainText;
  };
  const api = (token?: string) => app.withHeaders(token === undefined ? {} : { authorization: `Bearer ${token}` }).expectingJson();

  it('creates a token in a layer over the list — its plain text is that answer only, a layer shown once (E53) — and the API takes it', async () => {
    const ada = await app.factory(UserFactory).create();
    const session = await sudo(ada);
    // The form: a layer over the list, its base the list (for a deep link).
    await session.layer('auth.tokens.create').assertOk().assertLayer('auth/CreateAccessToken');
    // Its answer, sent as the layer's request: the same layer key (it replaces the form), shown once — a POST answered it.
    const created = await session.layering().post('/settings/tokens', { json: { name: 'Backup script', abilities: ['users:read'] } }).assertOk().assertLayer('auth/NewAccessToken');
    expect(created.page()!.layer).toEqual({ key: 'tokens.create', base: '/settings/tokens', once: true });
    const plainText = (created.page()!.props as { plainText: string }).plainText;
    expect(plainText).toMatch(/^bc_\d+\|[A-Za-z0-9]{40}[0-9a-f]{8}$/);
    expect(JSON.stringify(created.session())).not.toContain(plainText); // not flashed
    expect(created.headers.get('cache-control')).toContain('no-store');
    await session.navigating().get('/settings/tokens').assertPage('auth/AccessTokens', (props) => {
      expect(JSON.stringify(props)).not.toContain(plainText.slice(-48));
      expect((props as { tokens: { name: string }[] }).tokens.map((token) => token.name)).toEqual(['Backup script']);
    });
    await api(plainText).get('/api/users').assertOk();
  });

  it('a failed token form stays in its layer: back to the form, with the errors', async () => {
    const ada = await app.factory(UserFactory).create();
    const session = await sudo(ada);
    await session
      .layering()
      .post('/settings/tokens', { json: { name: '', abilities: [] }, headers: { referer: 'http://localhost/settings/tokens/create' } })
      .assertRedirect('/settings/tokens/create');
  });

  it('counter-checks: no token, a revoked one, a missing ability, a session cookie — 401 / 403', async () => {
    const ada = await app.factory(UserFactory).create();
    const plainText = await createToken(ada);
    await api().get('/api/users').assertUnauthorized().assertHeader('www-authenticate', 'Bearer');
    const noAbility = await createToken(ada, []).catch(() => undefined); // abilities are required by the form …
    expect(noAbility).toBeUndefined();
    await app.actingAs(ada, { guard: 'api', abilities: ['something:else'] }).expectingJson().get('/api/users').assertForbidden().assertExactJson({ message: 'This token may not: users:read.' });
    // A signed-in browser is no API client: the api group has no session.
    const login = await app.post('/login', credentialsOf(ada));
    await app.withCookie('bespoke_session', login.cookie('bespoke_session')!).expectingJson().get('/api/users').assertUnauthorized();
    // Revoked: dead at once.
    const id = Number(/^bc_(\d+)\|/.exec(plainText)![1]);
    // An action (E59): JSON back, never cached.
    await (await sudo(ada)).acting().delete(`/settings/tokens/${id}`).assertOk().assertExactJson({ revoked: id }).assertHeader('cache-control', 'no-store');
    await api(plainText).get('/api/users').assertUnauthorized();
  });

  it('counter-check: another user’s token id with a wrong secret is a 401 — and a broken checksum costs no query', async () => {
    const alan = await app.factory(UserFactory).create();
    const alansToken = await createToken(alan);
    const id = /^bc_(\d+)\|/.exec(alansToken)![1]!;
    const { crc32 } = await import('node:zlib');
    const forgedBody = `bc_${id}|${'x'.repeat(40)}`;
    await api(`${forgedBody}${crc32(forgedBody).toString(16).padStart(8, '0')}`).get('/api/users').assertUnauthorized();

    const queries: string[] = [];
    const stop = app.make(Connections).onQuery((query) => queries.push(query.sql));
    const typo = alansToken.slice(0, -9) + (alansToken.at(-9) === 'a' ? 'b' : 'a') + alansToken.slice(-8);
    await api(typo).get('/api/users').assertUnauthorized();
    stop();
    expect(queries).toEqual([]);
  });

  it('revokes only your own tokens — someone else’s id is a 404', async () => {
    const ada = await app.factory(UserFactory).create();
    const alan = await app.factory(UserFactory).create();
    const alansToken = await createToken(alan);
    const id = /^bc_(\d+)\|/.exec(alansToken)![1];
    await (await sudo(ada)).expectingJson().delete(`/settings/tokens/${id}`).assertNotFound();
    await api(alansToken).get('/api/users').assertOk();
  });

  it('the token page is sudo mode', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).get('/settings/tokens', { headers: { accept: 'text/html' } }).assertRedirect('/confirm-password');
  });
});

const credentialsOf = (user: User) => ({ form: { email: user.email, password: 'password' } });

/** The stored hash — read the one deliberate way. */
const storedHash = async (id: number) =>
  (await app.make(Database).selectFrom('users').select((eb) => secret(eb, 'password')).where('id', '=', id).executeTakeFirstOrThrow()).password as PasswordHash;

describe('passwords', () => {
  it('factory users have the password `password`, hashed at the test costs (no rehash needed)', async () => {
    const user = await app.factory(UserFactory).create();
    expect(user).not.toHaveProperty('password'); // create() returns the row — without its secret
    const hasher = app.make(Hasher);
    expect(await hasher.verify('password', await storedHash(user.id))).toBe(true);
    expect(hasher.needsRehash(await storedHash(user.id))).toBe(false);
  });

  it('seeds the demo people with `password`, hashed by the configured Hasher', async () => {
    await app.close(); // one database app per test
    app = await createTestApp(application, { database: 'refresh', seed: true });
    const ada = await app.make(Database).selectFrom('users').select('id').where('email', '=', 'ada@example.com').executeTakeFirstOrThrow();
    const hash = await storedHash(ada.id);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/); // .env.test
    expect(await app.make(Hasher).verify('password', hash)).toBe(true);
  });
});

// --- Type guarantees (never called) -----------------------------------------------------------

declare const user: User;

export function userTypes() {
  // @ts-expect-error — the hash is not part of a user (E24): it travels separately, read with secret()
  user.password;
  // @ts-expect-error — actingAs() takes the app's user type (AuthTypes), not any object with an id
  app.actingAs({ id: 1 });
}
