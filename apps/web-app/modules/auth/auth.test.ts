import { Hasher, PasswordHasher, type PasswordHash } from '@bespokecore/auth';
import { Database, secret } from '@bespokecore/database';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { UserFactory } from './factories/UserFactory.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import type { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import type { LoginController } from './controllers/LoginController.ts';
import type { RegisterController } from './controllers/RegisterController.ts';
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
    const response = await app.actingAs(ada).post('/logout').assertRedirect('/login').assertGuest().assertSessionHas('status', 'You have been signed out.');
    await app
      .withCookie('bespoke_session', response.cookie('bespoke_session')!)
      .navigating()
      .get('/login')
      .assertPage<ShowLoginController>('auth/Login', { flash: { status: 'You have been signed out.' }, auth: { user: null } });
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
    changed.assertRedirect().assertSessionHas('status', 'Password changed. You were signed out everywhere else.').assertAuthenticated(ada);

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
    done.assertSessionHas('status', 'Signed out on all other devices.');
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
