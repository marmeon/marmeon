import { twoFactorCode, TwoFactorStore } from '@marmeon/auth';
import { Encrypter } from '@marmeon/encryption';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

const SESSION = 'marmeon_session';
const credentialsOf = (user: User, extra: Record<string, string> = {}) => ({ form: { email: user.email, password: 'password', ...extra } });
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** A signed-in browser that turns the authenticator on, as the settings page does. */
async function enable(user: User) {
  const login = await app.post('/login', credentialsOf(user)).assertRedirect('/users/me');
  const cookie = login.cookie(SESSION)!;
  await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
  const page = await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor').assertPage('auth/TwoFactor');
  const setup = page.page()!.props.setup as { secret: string; qr: { size: number; path: string } };
  const confirmed = await app.withCookie(SESSION, cookie).layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } }).assertLayer('auth/RecoveryCodes');
  return { cookie, secret: setup.secret, recoveryCodes: confirmed.page()!.props.codes as string[], qr: setup.qr };
}

/** The cookie of a session that typed the password and now waits for the code. */
async function waiting(user: User, extra: Record<string, string> = {}) {
  const login = await app.post('/login', credentialsOf(user, extra)).assertRedirect('/two-factor-challenge').assertGuest();
  return login.cookie(SESSION)!;
}

describe('two-factor authentication', () => {
  it('sets up an authenticator app: a key, a QR code as one SVG path, ten recovery codes shown once', async () => {
    const ada = await app.factory(UserFactory).create();
    const { secret, recoveryCodes, qr, cookie } = await enable(ada);
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(qr).toMatchObject({ size: expect.any(Number), path: expect.stringMatching(/^M\d/) });
    expect(recoveryCodes).toHaveLength(10);
    // The page beneath only counts the codes, and holds neither the key nor the QR code any more.
    const page = await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor').assertPage('auth/TwoFactor', { enabled: true, recoveryCodesLeft: 10, setup: null });
    expect(JSON.stringify(page.page()!.props)).not.toContain(secret);
    expect(JSON.stringify(page.page()!.props)).not.toContain(recoveryCodes[0]!);
    await app.assertDatabaseCount('two_factor_recovery_codes', 10);
    // Forward asks the layer's URL with a GET: the answer is the settings page, never the codes.
    await app.withCookie(SESSION, cookie).get('/settings/two-factor/confirm').assertRedirect('/settings/two-factor');
  });

  it('turning it on signs out the other devices, says so, and lists the API tokens without revoking them', async () => {
    const ada = await app.factory(UserFactory).create();
    const other = (await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me')).cookie(SESSION)!;
    await app.withCookie(SESSION, other).get('/users/me').assertAuthenticated(ada);
    const cookie = (await app.post('/login', credentialsOf(ada))).cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/tokens', { form: { name: 'CI', abilities: 'users:read' } });
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup');
    const setup = (await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    const done = await app.withCookie(SESSION, cookie).layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } }).assertLayer('auth/RecoveryCodes');
    expect(done.page()!.props.tokens).toEqual([expect.objectContaining({ name: 'CI' })]);
    await app.withCookie(SESSION, other).get('/users/me').assertRedirect('/login'); // the other device is signed out
    await app.withCookie(SESSION, done.cookie(SESSION) ?? cookie).get('/users/me').assertRedirect(`/users/${ada.public_id}`); // this one is not
    await app.assertDatabaseCount('personal_access_tokens', 1);
  });

  it('a wrong password with the right code turns nothing on', async () => {
    const ada = await app.factory(UserFactory).create();
    const cookie = (await app.post('/login', credentialsOf(ada))).cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup');
    const setup = (await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    await app
      .withCookie(SESSION, cookie)
      .post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'wrong' }, headers: { referer: 'http://localhost/settings/two-factor' } })
      .assertInvalid({ password: 'The password is incorrect.' });
    await app.assertDatabaseCount('two_factor_recovery_codes', 0);
    await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me'); // still no second factor
  });

  it('signs in with the password and then a code — wrong first, then right', async () => {
    const ada = await app.factory(UserFactory).create();
    const { secret } = await enable(ada);
    const cookie = await waiting(ada);
    await app.withCookie(SESSION, cookie).navigating().get('/two-factor-challenge').assertPage('auth/TwoFactorChallenge');
    await app.withCookie(SESSION, cookie).get('/users/me').assertRedirect('/login'); // not signed in yet
    await app.withCookie(SESSION, cookie).post('/two-factor-challenge', { form: { code: '000000' }, headers: { referer: 'http://localhost/two-factor-challenge' } }).assertRedirect('/two-factor-challenge').assertInvalid({ code: 'That code did not work.' }).assertGuest();
    const done = await app.withCookie(SESSION, cookie).post('/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertRedirect('/users/me').assertAuthenticated(ada);
    expect(done.cookie(SESSION)).not.toBe(cookie); // a new session once the factor is proven
  });

  it('a code works once', async () => {
    const ada = await app.factory(UserFactory).create();
    const { secret } = await enable(ada);
    const code = twoFactorCode(secret, inSeconds(30));
    await app.withCookie(SESSION, await waiting(ada)).post('/two-factor-challenge', { form: { code } }).assertAuthenticated(ada);
    await app.withCookie(SESSION, await waiting(ada)).post('/two-factor-challenge', { form: { code }, headers: { referer: 'http://localhost/two-factor-challenge' } }).assertInvalid({ code: 'That code did not work.' }).assertGuest();
  });

  it('a recovery code signs in once', async () => {
    const ada = await app.factory(UserFactory).create();
    const { recoveryCodes } = await enable(ada);
    await app.withCookie(SESSION, await waiting(ada)).post('/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]!.toLowerCase() } }).assertRedirect('/users/me').assertAuthenticated(ada);
    await app
      .withCookie(SESSION, await waiting(ada))
      .post('/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: 'http://localhost/two-factor-challenge' } })
      .assertInvalid({ recovery_code: 'That recovery code did not work.' })
      .assertGuest();
  });

  it('has nothing to ask without a password typed first', async () => {
    await app.get('/two-factor-challenge').assertRedirect('/login');
    await app.post('/two-factor-challenge', { form: { code: '123456' } }).assertRedirect('/login');
  });

  it('remembers the device only after the code: the cookie is made when the factor is proven', async () => {
    const ada = await app.factory(UserFactory).create();
    const { secret } = await enable(ada);
    const login = await app.post('/login', credentialsOf(ada, { remember: 'on' })).assertRedirect('/two-factor-challenge');
    expect(login.cookie('remember_web')).toBeUndefined();
    await app.assertDatabaseCount('remember_tokens', 0);
    const done = await app.withCookie(SESSION, login.cookie(SESSION)!).post('/two-factor-challenge', { form: { code: twoFactorCode(secret, inSeconds(30)) } }).assertAuthenticated(ada);
    expect(done.cookie('remember_web')).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    await app.assertDatabaseCount('remember_tokens', 1);
  });

  it('turns it off with the password: a wrong one changes nothing, the right one ends the factor and the codes', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie } = await enable(ada);
    const as = () => app.withCookie(SESSION, cookie);
    await as().post('/settings/two-factor/disable', { form: { password: 'wrong' }, headers: { referer: 'http://localhost/settings/two-factor' } }).assertInvalid({ password: 'The password is incorrect.' });
    await app.assertDatabaseCount('two_factor_authentications', 1);
    await as().post('/settings/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/settings/two-factor');
    await app.assertDatabaseCount('two_factor_authentications', 0);
    await app.assertDatabaseCount('two_factor_recovery_codes', 0);
    await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me').assertAuthenticated(ada);
  });

  it('makes new recovery codes in place of the old ones', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie, recoveryCodes } = await enable(ada);
    const again = await app.withCookie(SESSION, cookie).layering().post('/settings/two-factor/recovery-codes').assertLayer('auth/RecoveryCodes');
    const fresh = again.page()!.props.codes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[0]);
    await app
      .withCookie(SESSION, await waiting(ada))
      .post('/two-factor-challenge', { form: { recovery_code: recoveryCodes[0]! }, headers: { referer: 'http://localhost/two-factor-challenge' } })
      .assertInvalid({ recovery_code: 'That recovery code did not work.' });
  });

  it('makes no recovery codes for an account without a factor', async () => {
    const ada = await app.factory(UserFactory).create();
    const cookie = (await app.post('/login', credentialsOf(ada))).cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/recovery-codes').assertRedirect('/settings/two-factor');
    await app.assertDatabaseCount('two_factor_recovery_codes', 0);
  });

  it('confirms after sudo mode ran out: the code of a slow scan is not lost', async () => {
    const ada = await app.factory(UserFactory).create();
    const cookie = (await app.post('/login', credentialsOf(ada))).cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    const setup = (await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor')).page()!.props.setup as { secret: string };
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 901_000 });
    try {
      await app.withCookie(SESSION, cookie).get('/settings/two-factor').assertRedirect('/confirm-password'); // sudo mode is over for the page …
      await app.withCookie(SESSION, cookie).layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(setup.secret), password: 'password' } }).assertLayer('auth/RecoveryCodes'); // … but not for the code
    } finally {
      vi.useRealTimers();
    }
    await app.assertDatabaseCount('two_factor_recovery_codes', 10);
  });

  it('five wrong codes end the wait: back to the login with a hint, the tries left said when they run low', async () => {
    const ada = await app.factory(UserFactory).create();
    await enable(ada);
    const cookie = await waiting(ada);
    const wrong = () => app.withCookie(SESSION, cookie).post('/two-factor-challenge', { form: { code: '000000' }, headers: { referer: 'http://localhost/two-factor-challenge' } });
    await wrong().assertInvalid({ code: 'That code did not work.' }); // 4 left
    await wrong().assertInvalid({ code: 'That code did not work.' }); // 3 left
    await wrong().assertInvalid({ code: 'That code did not work. 2 tries left.' });
    await wrong().assertInvalid({ code: 'That code did not work. 1 try left.' });
    const last = await wrong().assertRedirect('/login').assertFlashed('toast', { message: 'Too many wrong codes. Please sign in again.' });
    await app.withCookie(SESSION, last.cookie(SESSION) ?? cookie).navigating().get('/login').assertPage('auth/Login');
    await app.withCookie(SESSION, cookie).get('/two-factor-challenge').assertRedirect('/login');
  });

  it('is a page behind sudo mode and the signed-in area', async () => {
    await app.get('/settings/two-factor').assertRedirect('/login');
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).get('/settings/two-factor').assertRedirect('/confirm-password');
  });

  describe('changing the factors of an account that has one', () => {
    const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const asJson = { accept: 'application/json' };

    /** A session that signed in before the account had a factor, and typed the password just now: all that a stolen session plus a phished password has. */
    async function passwordOnly() {
      const ada = await app.factory(UserFactory).create();
      const cookie = (await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me')).cookie(SESSION)!;
      const encrypted = await app.make(Encrypter).encrypt(KEY, `marmeon-auth:two-factor:${ada.id}`);
      const store = app.make(TwoFactorStore);
      await store.startSetup(ada.id, encrypted);
      expect(await store.confirm(ada.id, 0, encrypted, null)).toBe(true);
      await app.withCookie(SESSION, cookie).post('/confirm-password', { form: { password: 'password' } });
      return { ada, as: () => app.withCookie(SESSION, cookie), cookie };
    }

    it('sends such a session to the verify page, for the page and for every change, and changes nothing', async () => {
      const { as } = await passwordOnly();
      await as().get('/settings/two-factor').assertRedirect('/settings/two-factor/verify');
      await as().post('/settings/two-factor/setup').assertRedirect('/settings/two-factor/verify');
      await as().post('/settings/two-factor/recovery-codes').assertRedirect('/settings/two-factor/verify');
      await as().post('/settings/two-factor/disable', { form: { password: 'password' } }).assertRedirect('/settings/two-factor/verify');
      await as().withHeaders(asJson).post('/settings/two-factor/disable', { form: { password: 'password' } }).assertForbidden().assertJson({ error: 'two_factor_unverified' });
      await app.assertDatabaseCount('two_factor_authentications', 1);
      await app.assertDatabaseCount('two_factor_recovery_codes', 0);
    });

    it('keeps the address and the API tokens out of reach of such a session, too', async () => {
      const { ada, as } = await passwordOnly();
      await as().put('/settings/email', { form: { email: 'thief@example.com' } }).assertRedirect('/settings/two-factor/verify');
      await as().withHeaders(asJson).post('/settings/tokens', { form: { name: 'CI', abilities: 'users:read' } }).assertForbidden().assertJson({ error: 'two_factor_unverified' });
      await app.assertDatabaseCount('personal_access_tokens', 0);
      await app.assertDatabaseMissing('users', { id: ada.id, email: 'thief@example.com' });
    });

    it('lets the same session in once it proved the factor, and confirming a setup stays reachable', async () => {
      const { as } = await passwordOnly();
      const done = await as().post('/settings/two-factor/verify', { form: { code: twoFactorCode(KEY) } }).assertRedirect();
      await app.withCookie(SESSION, done.cookie(SESSION)!).navigating().get('/settings/two-factor').assertPage('auth/TwoFactor');
      await as().post('/settings/two-factor/confirm', { form: { code: '123456', password: 'password' } }).assertRedirect();
    });
  });

  describe('a page behind the twoFactor() middleware', () => {
    const KEY = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const asJson = { accept: 'application/json' };

    /** A factor added behind the back of the open sessions: they hold it without having proven it. */
    async function addFactorQuietly(user: User) {
      const encrypted = await app.make(Encrypter).encrypt(KEY, `marmeon-auth:two-factor:${user.id}`);
      const store = app.make(TwoFactorStore);
      await store.startSetup(user.id, encrypted);
      expect(await store.confirm(user.id, 0, encrypted, null)).toBe(true);
    }

    it('sends a user without a factor to the setup page', async () => {
      const ada = await app.factory(UserFactory).create();
      await app.actingAs(ada).get('/settings/sensitive').assertRedirect('/settings/two-factor');
      await app.actingAs(ada).withHeaders(asJson).get('/settings/sensitive').assertForbidden().assertJson({ error: 'two_factor_required' });
    });

    it('opens for the session that turned the factor on, and for acting as a user that has one', async () => {
      const ada = await app.factory(UserFactory).create();
      const { cookie } = await enable(ada);
      await app.withCookie(SESSION, cookie).navigating().get('/settings/sensitive').assertPage('auth/Sensitive');
      await app.actingAs(ada).navigating().get('/settings/sensitive').assertPage('auth/Sensitive');
    });

    it('sends a session that did not prove the factor to the verify page, which opens it with a code and comes back', async () => {
      const ada = await app.factory(UserFactory).create();
      const cookie = (await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me')).cookie(SESSION)!;
      await addFactorQuietly(ada);
      const as = () => app.withCookie(SESSION, cookie);
      await as().withHeaders(asJson).get('/settings/sensitive').assertForbidden().assertJson({ error: 'two_factor_unverified' });
      await as().get('/settings/sensitive').assertRedirect('/settings/two-factor/verify');
      await as().navigating().get('/settings/two-factor/verify').assertPage('auth/TwoFactorVerify');
      await as().post('/settings/two-factor/verify', { form: { code: '000000' }, headers: { referer: 'http://localhost/settings/two-factor/verify' } }).assertInvalid({ code: 'That code did not work.' });
      await as().get('/settings/sensitive').assertRedirect('/settings/two-factor/verify'); // a wrong code proves nothing
      const done = await as().post('/settings/two-factor/verify', { form: { code: twoFactorCode(KEY) } }).assertRedirect('/settings/sensitive');
      await app.withCookie(SESSION, done.cookie(SESSION) ?? cookie).navigating().get('/settings/sensitive').assertPage('auth/Sensitive');
    });

    it('is not opened by a password typed again, nor by a sign-in that waits for the code', async () => {
      const ada = await app.factory(UserFactory).create();
      const cookie = (await app.post('/login', credentialsOf(ada)).assertRedirect('/users/me')).cookie(SESSION)!;
      await addFactorQuietly(ada);
      await app.withCookie(SESSION, cookie).post('/confirm-password', { form: { password: 'password' } });
      await app.withCookie(SESSION, cookie).get('/settings/sensitive').assertRedirect('/settings/two-factor/verify');
      await app.withCookie(SESSION, await waiting(ada)).get('/settings/sensitive').assertRedirect('/login');
    });

    it('needs a signed-in user for the verify page', async () => {
      await app.get('/settings/two-factor/verify').assertRedirect('/login');
      await app.post('/settings/two-factor/verify', { form: { code: '123456' } }).assertRedirect('/login');
    });
  });
});

describe('a session that ends while the authenticator is set up', () => {
  /** The moment after the other devices are signed out, an operator ends the account's sessions. */
  function endSessionsAfterSignOut() {
    const write = UserRepository.prototype.updatePasswordHash;
    return vi.spyOn(UserRepository.prototype, 'updatePasswordHash').mockImplementation(async function (this: UserRepository, id, hash) {
      await write.call(this, id, hash);
      await this.updateSessionKey(id, 'e'.repeat(40), undefined);
    });
  }

  async function begin(user: User) {
    const login = await app.post('/login', credentialsOf(user)).assertRedirect('/users/me');
    const cookie = login.cookie(SESSION)!;
    await app.withCookie(SESSION, cookie).post('/settings/two-factor/setup').assertRedirect('/settings/two-factor');
    const page = await app.withCookie(SESSION, cookie).navigating().get('/settings/two-factor').assertPage('auth/TwoFactor');
    return { cookie, secret: (page.page()!.props.setup as { secret: string }).secret };
  }

  it('stores no factor and sends the user to the sign-in', async () => {
    const ada = await app.factory(UserFactory).create();
    const { cookie, secret } = await begin(ada);
    const spy = endSessionsAfterSignOut();
    try {
      await app.withCookie(SESSION, cookie).post('/settings/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' } }).assertRedirect('/login');
    } finally {
      spy.mockRestore();
    }
    await app.assertDatabaseCount('two_factor_recovery_codes', 0);
    expect(await app.make(TwoFactorStore).factors(ada.id)).toEqual([]);
  });

  it('holds the account\'s row on a real session_key and keeps the key', async () => {
    const ada = await app.factory(UserFactory).create();
    const key = 'k'.repeat(43);
    await app.make(UserRepository).updateSessionKey(ada.id, key, null);
    const { cookie, secret } = await begin(ada);
    await app.withCookie(SESSION, cookie).layering().post('/settings/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' } }).assertLayer('auth/RecoveryCodes');
    expect(await app.make(TwoFactorStore).factors(ada.id)).toEqual(['totp']);
    expect((await app.make(UserRepository).findById(ada.id))?.sessionKey).toBe(key);
  });

  it('stops at the lock when a real session_key was replaced meanwhile', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.make(UserRepository).updateSessionKey(ada.id, 'k'.repeat(43), null);
    const { cookie, secret } = await begin(ada);
    const spy = endSessionsAfterSignOut();
    try {
      await app.withCookie(SESSION, cookie).post('/settings/two-factor/confirm', { form: { code: twoFactorCode(secret), password: 'password' } }).assertRedirect('/login');
    } finally {
      spy.mockRestore();
    }
    expect(await app.make(TwoFactorStore).factors(ada.id)).toEqual([]);
  });
});
