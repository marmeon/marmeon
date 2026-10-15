import { softAuthenticator, twoFactorCode } from '@marmeon/auth';
import { Connections } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { NewSignInNotification } from './notifications/NewSignInNotification.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { NotifyAboutNewSignIn } from './listeners/NotifyAboutNewSignIn.ts';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const SESSION = 'marmeon_session';
// The tests' APP_URL is http://localhost: that is the relying party.
const device = () => softAuthenticator({ origin: 'http://localhost', rpId: 'localhost' });
const credentialsOf = (user: User) => ({ form: { email: user.email, password: 'password' } });

/** A signed-in browser that adds `authenticator` as its first passkey, as the settings page does. */
async function enrol(user: User, authenticator = device()) {
  const login = await app.post('/login', credentialsOf(user)).assertRedirect('/users/me');
  const cookie = login.cookie(SESSION)!;
  const options = await app.withCookie(SESSION, cookie).post('/settings/passkeys/options', { json: {} }).assertOk();
  const registered = await app
    .withCookie(SESSION, cookie)
    .post('/settings/passkeys', { json: { response: authenticator.register(options.json() as never), name: 'Laptop', password: 'password' } })
    .assertOk();
  return { cookie, authenticator, recoveryCodes: (registered.json() as { recoveryCodes: string[] }).recoveryCodes };
}

describe('passkeys', () => {
  it('adds a passkey, signs out, and signs in without a password', async () => {
    const ada = await app.factory(UserFactory).create();
    const { authenticator, recoveryCodes } = await enrol(ada);
    expect(recoveryCodes).toHaveLength(10);
    await app.assertDatabaseCount('passkeys', 1);

    const options = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    const guest = options.cookie(SESSION)!;
    expect(options.json()).toMatchObject({ userVerification: 'required' });
    const signedIn = await app
      .withCookie(SESSION, guest)
      .post('/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } })
      .assertRedirect('/users/me');
    await app.withCookie(SESSION, signedIn.cookie(SESSION) ?? guest).get('/users/me').assertAuthenticated(ada);
  });

  it('a session that got in with a passkey alone still types the password to change the address, make a token or remove a passkey', async () => {
    const ada = await app.factory(UserFactory).create();
    const { authenticator } = await enrol(ada);
    const options = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    const guest = options.cookie(SESSION)!;
    const signedIn = await app.withCookie(SESSION, guest).post('/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/users/me');
    const as = () => app.withCookie(SESSION, signedIn.cookie(SESSION) ?? guest).expectingJson();
    const token = { name: 'CI', abilities: ['users:read'] };

    // Sudo mode is open (the passkey confirmed it), and the form still asks for the password.
    await as().put('/settings/email', { json: { email: 'new@example.com' } }).assertStatus(422);
    await as().put('/settings/email', { json: { email: 'new@example.com', current_password: 'wrong' } }).assertStatus(422);
    await as().post('/settings/tokens', { json: token }).assertStatus(422);
    await as().post('/settings/passkeys/1/remove', { json: {} }).assertStatus(422);
    await app.assertDatabaseCount('passkeys', 1);
    await app.assertDatabaseCount('personal_access_tokens', 0);

    await as().put('/settings/email', { json: { email: 'new@example.com', current_password: 'password' } }).assertStatus(303);
    await as().post('/settings/tokens', { json: { ...token, current_password: 'password' } }).assertOk();
    await as().post('/settings/passkeys/1/remove', { json: { password: 'password' } }).assertOk();
    await app.assertDatabaseCount('passkeys', 0);
  });

  it('after the password, a passkey finishes the sign-in', async () => {
    const ada = await app.factory(UserFactory).create();
    const { authenticator } = await enrol(ada);
    const login = await app.post('/login', credentialsOf(ada)).assertRedirect('/two-factor-challenge').assertGuest();
    const cookie = login.cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).navigating().get('/two-factor-challenge').assertPage('auth/TwoFactorChallenge', { passkey: true, totp: false });
    const options = await app.withCookie(SESSION, cookie).post('/two-factor-challenge/passkey/options', { json: {} }).assertOk();
    const done = await app
      .withCookie(SESSION, cookie)
      .post('/two-factor-challenge/passkey', { json: { response: authenticator.authenticate(options.json() as never) } })
      .assertRedirect('/users/me');
    await app.withCookie(SESSION, done.cookie(SESSION) ?? cookie).get('/users/me').assertAuthenticated(ada);
  });

  describe('as a step-up', () => {
    /** The page that asks for the factor again, in the session of an account with only a passkey: the proof is older than the page's 15 minutes. */
    async function stale(user: User) {
      const { cookie, authenticator } = await enrol(user);
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 901_000 });
      return { cookie, authenticator };
    }
    afterEach(() => vi.useRealTimers());

    it('lets an account with only a passkey into a page that asks for the factor again', async () => {
      const ada = await app.factory(UserFactory).create();
      const { cookie, authenticator } = await stale(ada); // the registration proved the factor, 15 minutes ago
      const as = () => app.withCookie(SESSION, cookie);
      await as().get('/settings/sensitive').assertRedirect('/settings/two-factor/verify');
      await as().navigating().get('/settings/two-factor/verify').assertPage('auth/TwoFactorVerify', { passkey: true, totp: false });
      const options = await as().post('/settings/two-factor/verify/passkey/options', { json: {} }).assertOk();
      expect(options.json()).toMatchObject({ userVerification: 'required' });
      const done = await as().post('/settings/two-factor/verify/passkey', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/settings/sensitive');
      await app.withCookie(SESSION, done.cookie(SESSION) ?? cookie).navigating().get('/settings/sensitive').assertPage('auth/Sensitive');
    });

    it('says nothing about why a response did not count, and leaves the session signed in', async () => {
      const ada = await app.factory(UserFactory).create();
      const { cookie, authenticator } = await stale(ada);
      const as = () => app.withCookie(SESSION, cookie);
      const options = await as().post('/settings/two-factor/verify/passkey/options', { json: {} }).assertOk();
      const refused = await as()
        .post('/settings/two-factor/verify/passkey', { json: { response: authenticator.authenticate(options.json() as never, { origin: 'https://evil.example' }) } })
        .assertStatus(422);
      expect(refused.json()).toEqual({ error: 'That passkey did not work.' });
      await as().get('/settings/sensitive').assertRedirect('/settings/two-factor/verify');
      await as().get('/users/me').assertAuthenticated(ada);
    });

    it('limits the options per user, and keeps guests out', async () => {
      const ada = await app.factory(UserFactory).create();
      const { cookie } = await enrol(ada);
      for (let i = 0; i < 10; i++) await app.withCookie(SESSION, cookie).post('/settings/two-factor/verify/passkey/options', { json: {} }).assertOk();
      await app.withCookie(SESSION, cookie).post('/settings/two-factor/verify/passkey/options', { json: {} }).assertStatus(429);
      for (const path of ['/settings/two-factor/verify/passkey/options', '/settings/two-factor/verify/passkey']) {
        await app.post(path, { json: {} }).assertRedirect('/login');
      }
    });

    it('offers nothing to an account without a passkey', async () => {
      const ada = await app.factory(UserFactory).create();
      const cookie = (await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me')).cookie(SESSION)!;
      await app.withCookie(SESSION, cookie).post('/settings/two-factor/verify/passkey/options', { json: {} }).assertStatus(422);
    });
  });

  it('refuses a response from another origin, and says nothing about why', async () => {
    const ada = await app.factory(UserFactory).create();
    const { authenticator } = await enrol(ada);
    const options = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    const guest = options.cookie(SESSION)!;
    const refused = await app
      .withCookie(SESSION, guest)
      .post('/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never, { origin: 'https://evil.example' }) } })
      .assertStatus(422);
    expect(refused.json()).toEqual({ error: 'That passkey did not work.' });
  });

  it('refuses to change the passkeys of a session whose factor is older than 15 minutes, even with the password typed again', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 1800_000 });
    try {
      const as = () => app.withCookie(SESSION, cookie);
      await as().post('/confirm-password', { form: { password: 'password' } });
      const json = { accept: 'application/json' };
      await as().get('/settings/passkeys').assertRedirect('/settings/two-factor/verify');
      await as().post('/settings/passkeys/options', { json: {}, headers: json }).assertForbidden().assertJson({ error: 'two_factor_unverified' });
      await as().post('/settings/passkeys', { json: { response: {}, name: 'x', password: 'password' }, headers: json }).assertForbidden();
      await as().post('/settings/passkeys/1/remove', { json: { password: 'password' }, headers: json }).assertForbidden();
      await as().post('/settings/passkeys/1/release', { json: { password: 'password' }, headers: json }).assertForbidden();
      await app.assertDatabaseCount('passkeys', 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for the password with every passkey', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    const options = await app.withCookie(SESSION, cookie).post('/settings/passkeys/options', { json: {} }).assertOk();
    const response = device().register(options.json() as never);
    const refused = await app.withCookie(SESSION, cookie).post('/settings/passkeys', { json: { response, name: 'Phone', password: 'wrong' } }).assertStatus(422);
    expect(refused.json()).toMatchObject({ field: 'password' });
    await app.assertDatabaseCount('passkeys', 1);
  });

  it('removing the last factor needs the password and takes the recovery codes along', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    await app.assertDatabaseCount('two_factor_recovery_codes', 10);
    // Not id 1: Postgres keeps counting across the test database's refreshes.
    const [{ id }] = (await app.make(Connections).get<any>().selectFrom('passkeys').select('id').execute()) as [{ id: number }];
    await app.withCookie(SESSION, cookie).post(`/settings/passkeys/${id}/remove`, { json: {} }).assertStatus(422);
    await app.assertDatabaseCount('passkeys', 1);
    await app.withCookie(SESSION, cookie).post(`/settings/passkeys/${id}/remove`, { json: { password: 'password' } }).assertOk();
    await app.assertDatabaseCount('passkeys', 0);
    await app.assertDatabaseCount('two_factor_recovery_codes', 0);
  });

  it('shows the list on the settings page, but only within the password confirmation', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    await app.withCookie(SESSION, cookie).navigating().get('/settings/passkeys').assertPage('auth/Passkeys', { lastFactor: true, passkeys: [{ name: 'Laptop', suspended: false }] });
    // A session that did not type the password recently is sent to confirm it.
    await app.actingAs(ada).get('/settings/passkeys').assertRedirect('/confirm-password');
  });

  it('answers 423 to the JSON calls of a session without a fresh password', async () => {
    const ada = await app.factory(UserFactory).create();
    const json = { accept: 'application/json' };
    await app.actingAs(ada).post('/settings/passkeys/options', { json: {}, headers: json }).assertStatus(423);
    await app.actingAs(ada).post('/settings/passkeys', { json: { response: {}, name: 'x', password: 'password' }, headers: json }).assertStatus(423);
    await app.assertDatabaseCount('passkeys', 0);
  });

  it('keeps a signed-in session out of the guest routes', async () => {
    const ada = await app.factory(UserFactory).create();
    for (const path of ['/passkeys/sign-in/options', '/passkeys/sign-in', '/two-factor-challenge/passkey/options', '/two-factor-challenge/passkey']) {
      await app.actingAs(ada).post(path, { json: {} }).assertRedirect('/users/me');
    }
  });

  it('shows the recovery codes in an answer nothing stores', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me');
    const cookie = login.cookie(SESSION)!;
    const options = await app.withCookie(SESSION, cookie).post('/settings/passkeys/options', { json: {} }).assertOk();
    await app
      .withCookie(SESSION, cookie)
      .post('/settings/passkeys', { json: { response: device().register(options.json() as never), name: 'Laptop', password: 'password' } })
      .assertOk()
      .assertHeader('cache-control', 'no-store, private');
  });

  it('shows an account with only passkeys its recovery codes, and makes new ones', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    const as = () => app.withCookie(SESSION, cookie);
    await as().navigating().get('/settings/two-factor').assertPage('auth/TwoFactor', { enabled: false, secured: true, recoveryCodesLeft: 10 });
    const made = await as().layering().post('/settings/two-factor/recovery-codes').assertLayer('auth/RecoveryCodes');
    expect(made.page()!.props.codes).toHaveLength(10);
  });

  it('removing the authenticator app of an account with a passkey leaves the passkeys, and the page says so', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enrol(ada);
    const as = () => app.withCookie(SESSION, cookie);
    await as().post('/settings/two-factor/setup');
    const setup = (await as().navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    await as().layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } });
    await as().navigating().get('/settings/two-factor').assertPage('auth/TwoFactor', { enabled: true, passkey: true });
    const done = await as().post('/settings/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/settings/two-factor');
    expect(done.flashed().map((message) => JSON.stringify(message.data))).toEqual([expect.stringContaining('Your passkeys still protect the account')]);
    await as().navigating().get('/settings/two-factor').assertPage('auth/TwoFactor', { enabled: false, secured: true, passkey: true });
  });

  it('releases a suspended passkey only with the right password', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie, authenticator } = await enrol(ada);
    // A counter that does not move forward suspends the passkey.
    const first = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    await app.withCookie(SESSION, first.cookie(SESSION)!).post('/passkeys/sign-in', { json: { response: authenticator.authenticate(first.json() as never) } }).assertRedirect('/users/me');
    const second = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    await app.withCookie(SESSION, second.cookie(SESSION)!).post('/passkeys/sign-in', { json: { response: authenticator.authenticate(second.json() as never, { signCount: 1 }) } }).assertStatus(422);
    const [{ id }] = (await app.make(Connections).get<any>().selectFrom('passkeys').select('id').execute()) as [{ id: number }];
    const page = () => app.withCookie(SESSION, cookie).navigating().get('/settings/passkeys');
    await page().assertPage('auth/Passkeys', { passkeys: [{ suspended: true }] });

    const release = (json: Record<string, unknown>) => app.withCookie(SESSION, cookie).post(`/settings/passkeys/${id}/release`, { json, headers: { accept: 'application/json' } });
    await release({}).assertStatus(422);
    expect((await release({ password: 'wrong' }).assertStatus(422)).json()).toMatchObject({ field: 'password' });
    await release({ password: 'password' }).assertOk();
    await page().assertPage('auth/Passkeys', { passkeys: [{ suspended: false }] });
  });

  it('a passkey sign-in tells the user, like a sign-in with a password', async () => {
    const ada = await app.factory(UserFactory).create();
    const { authenticator } = await enrol(ada);
    const options = await app.post('/passkeys/sign-in/options', { json: {} }).assertOk();
    await app.withCookie(SESSION, options.cookie(SESSION)!).post('/passkeys/sign-in', { json: { response: authenticator.authenticate(options.json() as never) } }).assertRedirect('/users/me');
    app.queue.assertListenerQueued(NotifyAboutNewSignIn, (payload) => payload.userId === ada.id && payload.via === 'passkey');
    await app.queue.work();
    app.notifications.assertSent({ type: 'user', id: ada.id }, NewSignInNotification);
  });
});

describe('a session that ends while a passkey is added', () => {
  it('stores no passkey and answers 401, so the page can send the user to the sign-in', async () => {
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me');
    const cookie = login.cookie(SESSION)!;
    const options = await app.withCookie(SESSION, cookie).post('/settings/passkeys/options', { json: {} }).assertOk();
    const response = device().register(options.json() as never);
    // The moment after the other devices are signed out, an operator ends the account's sessions.
    const write = UserRepository.prototype.updatePasswordHash;
    const spy = vi.spyOn(UserRepository.prototype, 'updatePasswordHash').mockImplementation(async function (this: UserRepository, id, hash) {
      await write.call(this, id, hash);
      await this.updateSessionKey(id, 'e'.repeat(40), undefined);
    });
    try {
      await app.withCookie(SESSION, cookie).post('/settings/passkeys', { json: { response, name: 'Laptop', password: 'password' } }).assertStatus(401);
    } finally {
      spy.mockRestore();
    }
    await app.assertDatabaseCount('passkeys', 0);
  });

  it('adds a passkey on an account with a real session_key and keeps the key', async () => {
    const ada = await app.factory(UserFactory).create();
    const key = 'k'.repeat(43);
    await app.make(UserRepository).updateSessionKey(ada.id, key, null);
    await enrol(ada);
    await app.assertDatabaseCount('passkeys', 1);
    expect((await app.make(UserRepository).findById(ada.id))?.sessionKey).toBe(key);
  });
});
