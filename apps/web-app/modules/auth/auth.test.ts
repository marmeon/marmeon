import { Hasher, PasswordHasher, type PasswordHash } from '@bespokecore/auth';
import { Database, secret } from '@bespokecore/database';
import { createTestApp, type TestApp } from '@bespokecore/testing';
import { UserFactory } from './factories/UserFactory.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { User } from './users.ts';
import { UserRepository } from './UserRepository.ts';
import type { LoginController } from './controllers/LoginController.ts';
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
