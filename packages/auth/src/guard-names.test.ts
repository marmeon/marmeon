import { accountScope } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { rememberCookieName } from './config.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { APP_GUARD_NAMES, guardNames, isGuardName } from './guard-names.ts';
import { clearGuardPasswordCheck, clearPasswordCheck, takeGuardPasswordCheck, takePasswordCheck } from './password-throttle.ts';
import { AUTH_SESSION_KEYS, readAuth, writeAuth } from './session-keys.ts';
import type { Session } from '@marmeon/session';
import type { RateLimiter } from '@marmeon/cache';

/** A limiter that counts, as far as these tests need one. */
function counting() {
  const counts = new Map<string, number>();
  const limiter = {
    attempt: async (key: string, { maxAttempts }: { maxAttempts: number }) => {
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return used <= maxAttempts;
    },
    availableInSeconds: async () => 30,
    clear: async (key: string) => void counts.delete(key),
  } as unknown as RateLimiter;
  return { counts, limiter };
}

describe('APP_GUARD_NAMES', () => {
  it('holds every name the app guard has always used: another one would sign everybody out and reset every running count', () => {
    expect(APP_GUARD_NAMES.session).toEqual({
      id: '_auth_id',
      password: '_auth_password',
      confirmedAt: '_auth_confirmed_at',
      viaRemember: '_auth_via_remember',
      signedInAt: '_auth_signed_in_at',
      rememberUntil: '_auth_remember_until',
      pending: '_auth_pending',
      twoFactorAt: '_auth_two_factor_at',
      signIn: '_auth_sign_in',
      throttleKey: '_auth_throttle_key',
      typedPassword: '_auth_typed_password',
      webauthn: '_auth_webauthn',
    });
    expect(APP_GUARD_NAMES.session).toMatchObject(AUTH_SESSION_KEYS);
    expect(APP_GUARD_NAMES.fingerprintContext).toBe('marmeon:auth-session');
    expect(APP_GUARD_NAMES.loginThrottleContext).toBe('marmeon:auth-login-throttle');
    expect(APP_GUARD_NAMES.deviceContext).toBe('marmeon:auth-device');
    const config = { rememberCookie: 'marmeon_remember' };
    expect(APP_GUARD_NAMES.rememberCookie(config, { secure: false })).toBe('marmeon_remember');
    expect(APP_GUARD_NAMES.rememberCookie(config, { secure: true })).toBe('__Host-marmeon_remember');
    expect(rememberCookieName(config, { secure: true })).toBe('__Host-marmeon_remember');
    expect(APP_GUARD_NAMES.deviceCookie(false)).toBe('marmeon_device');
    expect(APP_GUARD_NAMES.deviceCookie(true)).toBe('__Host-marmeon_device');
    expect(APP_GUARD_NAMES.limiterKey('password-check-hour:account:1')).toBe('password-check-hour:account:1');
    expect(APP_GUARD_NAMES.routeLimit('auth.login')).toBe('auth.login');
    expect(APP_GUARD_NAMES.accountScope(7)).toBe(accountScope(7));
  });
});

describe('guardNames()', () => {
  const office = guardNames('office');
  const other = guardNames('shop');
  const config = { rememberCookie: 'marmeon_remember' };

  it('shares no name with the app guard, nor with another package guard', () => {
    const all = (names: typeof office) => [
      ...Object.values(names.session),
      names.fingerprintContext,
      names.loginThrottleContext,
      names.deviceContext,
      names.rememberCookie(config, { secure: false }),
      names.rememberCookie(config, { secure: true }),
      names.deviceCookie(false),
      names.deviceCookie(true),
      names.limiterKey('password-check-hour:account:1'),
      names.routeLimit('auth.login'),
      names.accountScope(1),
    ];
    const app = new Set(all(APP_GUARD_NAMES));
    const second = new Set(all(other));
    const mine = all(office);
    expect(mine).toHaveLength(app.size);
    for (const name of mine) {
      expect(app.has(name), name).toBe(false);
      expect(second.has(name), name).toBe(false);
    }
  });

  it('names its session keys after itself, in the form `_auth:<guard>:<field>`', () => {
    expect(office.session).toEqual({
      id: '_auth:office:id',
      password: '_auth:office:password',
      confirmedAt: '_auth:office:confirmed_at',
      viaRemember: '_auth:office:via_remember',
      signedInAt: '_auth:office:signed_in_at',
      rememberUntil: '_auth:office:remember_until',
      pending: '_auth:office:pending',
      twoFactorAt: '_auth:office:two_factor_at',
      signIn: '_auth:office:sign_in',
      throttleKey: '_auth:office:throttle_key',
      typedPassword: '_auth:office:typed_password',
      webauthn: '_auth:office:webauthn',
    });
  });

  it('names contexts, cookies, limiter keys and the account scope after the guard', () => {
    expect(office.fingerprintContext).toBe('marmeon:auth-session:office');
    expect(office.loginThrottleContext).toBe('marmeon:auth-login-throttle:office');
    expect(office.deviceContext).toBe('marmeon:auth-device:office');
    expect(office.rememberCookie(config, { secure: false })).toBe('marmeon_remember.office');
    expect(office.rememberCookie(config, { secure: true })).toBe('__Host-marmeon_remember.office');
    expect(office.deviceCookie(false)).toBe('marmeon_device.office.device');
    expect(office.deviceCookie(true)).toBe('__Host-marmeon_device.office.device');
    expect(office.limiterKey('passkey-confirm:1')).toBe('guard:office|passkey-confirm:1');
    expect(office.routeLimit('auth.login')).toBe('auth.office.login');
    expect(office.accountScope(1)).not.toBe(accountScope(1));
    // An app user may have the string id `office:1`.
    expect(office.accountScope(1)).not.toBe(accountScope('office:1'));
    expect(office.accountScope('1')).not.toBe(accountScope('office:1'));
  });

  it.each(['marmeon_device-office', 'marmeon_device', 'marmeon_remember-office', 'marmeon_device-office-device', 'marmeon_remember'])('keeps the guard’s cookies apart from each other and from the app’s under AUTH_REMEMBER_COOKIE=%s', (rememberCookie) => {
    for (const secure of [false, true]) {
      const app = [APP_GUARD_NAMES.rememberCookie({ rememberCookie }, { secure }), APP_GUARD_NAMES.deviceCookie(secure)];
      const own = [office.rememberCookie({ rememberCookie }, { secure }), office.deviceCookie(secure)];
      for (const name of own) expect(app, name).not.toContain(name);
      expect(own[0]).not.toBe(own[1]);
    }
  });

  it('names a guard’s cookies with RFC 6265 token characters only, which the cookie parser and serializer take', () => {
    for (const secure of [false, true]) {
      for (const name of [office.rememberCookie(config, { secure }), office.deviceCookie(secure)]) expect(name).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
    }
  });

  it('keeps a guard’s remember cookie apart from an app that names its own like it, and from the default', () => {
    expect(office.rememberCookie(config, { secure: false })).not.toBe(APP_GUARD_NAMES.rememberCookie({ rememberCookie: 'marmeon_remember-office' }, { secure: false }));
  });

  it.each(['', 'web', 'api', 'app', 'auth', 'marmeon', 'Office', 'a b', 'x:y', '1office', 'office-', 'of--fice', 'a'.repeat(33)])('refuses the name %j', (name) => {
    expect(isGuardName(name)).toBe(false);
    expect(() => guardNames(name)).toThrow(TypeError);
  });

  it.each(['office', 'back-office', 'a', 'a1', 'a'.repeat(32)])('accepts the name %j', (name) => {
    expect(isGuardName(name)).toBe(true);
    expect(() => guardNames(name)).not.toThrow();
  });

  it('keeps the guards of one name pair apart even when a name contains the other', () => {
    expect(guardNames('office').session.id).not.toBe(guardNames('office-two').session.id);
    expect(guardNames('remember').session.id).not.toBe(guardNames('remember').session.rememberUntil);
    expect(guardNames('remember').session.id).not.toBe(AUTH_SESSION_KEYS.rememberUntil);
  });
});

describe('what a guard keeps apart', () => {
  const credentials = { user: { id: 1, name: 'Ada', email: 'ada@example.com' }, passwordHash: null, sessionKey: null };
  const secret = { key: new Uint8Array(32).fill(3), previousKeys: [] };

  it('does not accept a fingerprint of the same id and session key under another guard', () => {
    const app = new SessionFingerprints(secret);
    const office = new SessionFingerprints(secret, guardNames('office'));
    expect(office.of(credentials)).not.toBe(app.of(credentials));
    expect(office.matches(app.of(credentials), credentials)).toBe(false);
    expect(app.matches(office.of(credentials), credentials)).toBe(false);
    expect(office.matches(office.of(credentials), credentials)).toBe(true);
    expect(app.matches(app.of(credentials), credentials)).toBe(true);
  });

  it('counts the checks of a signed-in password per guard: the same account id in two guards shares no counter', async () => {
    const { limiter } = counting();
    const office = guardNames('office');
    const typed = { session: 'sign-in', typed: false };
    // The account's hour (20 for a sign-in without a typed password) of guard `office` 1 is used up …
    for (let i = 0; i < 20; i++) expect(await takeGuardPasswordCheck(limiter, { session: `s${i}`, typed: false }, 1, office)).toBeUndefined();
    expect(await takeGuardPasswordCheck(limiter, { session: 's20', typed: false }, 1, office)).toMatchObject({ kind: 'throttled', account: true });
    // … and the app's account 1 still has all of its own.
    expect(await takePasswordCheck(limiter, typed, 1)).toBeUndefined();
  });

  it('clears the minute of one guard’s sign-in only: the same sign-in scope in the app and in a guard are two counters', async () => {
    const { counts, limiter } = counting();
    const office = guardNames('office');
    const scope = { session: 'sign-in', typed: false };
    const appMinute = 'password-check-minute:session:sign-in';
    const officeMinute = `guard:office|${appMinute}`;
    await takePasswordCheck(limiter, scope, 1);
    await takeGuardPasswordCheck(limiter, scope, 1, office);
    expect([...counts.keys()]).toEqual(expect.arrayContaining([appMinute, officeMinute]));

    await clearPasswordCheck(limiter, scope);
    expect(counts.has(appMinute), 'the app’s counter is gone').toBe(false);
    expect(counts.has(officeMinute), 'the guard’s counter stays').toBe(true);

    await takePasswordCheck(limiter, scope, 1);
    await clearGuardPasswordCheck(limiter, scope, office);
    expect(counts.has(officeMinute), 'the guard’s counter is gone').toBe(false);
    expect(counts.has(appMinute), 'the app’s counter stays').toBe(true);
  });
});

describe('readAuth() and writeAuth()', () => {
  const fake = () => {
    const data = new Map<string, unknown>();
    return { data, session: { get: (key: string) => data.get(key), put: (key: string, value: unknown) => data.set(key, value) } as unknown as Session };
  };

  it('keep a guard’s sign-in under its own keys: the app guard never reads another guard’s id', () => {
    const { data, session } = fake();
    writeAuth(session, 'id', 1, guardNames('office'));
    expect([...data.keys()]).toEqual(['_auth:office:id']);
    expect(readAuth(session, 'id')).toBeUndefined();
    expect(readAuth(session, 'id', guardNames('shop'))).toBeUndefined();
    expect(readAuth(session, 'id', guardNames('office'))).toBe(1);
    writeAuth(session, 'id', 2);
    expect([...data.keys()]).toEqual(['_auth:office:id', '_auth_id']);
  });
});
