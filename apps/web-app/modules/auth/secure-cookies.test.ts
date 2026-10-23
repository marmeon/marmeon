import { Redactor } from '@marmeon/core';
import { AuthConfig, rememberCookieName } from '@marmeon/auth';
import { sessionCookieName, SessionConfig } from '@marmeon/session';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from './warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// Cookies follow APP_URL — `https://` sends every cookie of the app with `Secure` (the session's, the XSRF token, the
// remember-me token, the reset link's), `http://` without; SESSION_SECURE_COOKIE=true/false decides itself.
let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Every `Set-Cookie` of a response, by cookie name. */
function setCookies(response: { headers: Headers }): Record<string, string> {
  return Object.fromEntries(response.headers.getSetCookie().map((header) => [header.slice(0, header.indexOf('=')), header]));
}

/** The names this app's cookies go by — with the `__Host-` prefix when they are Secure. */
function names(): { session: string; remember: string } {
  const session = app!.container.make(SessionConfig);
  return { session: sessionCookieName(session), remember: rememberCookieName(app!.container.make(AuthConfig), session) };
}

async function signInRemembered(env: Record<string, string>) {
  app = await createTestApp(application, { database: 'refresh', env });
  const ada = await app.factory(UserFactory).create();
  const page = setCookies(await app.get('/login').assertOk());
  const login = setCookies(await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } }).assertAuthenticated(ada));
  return { ...page, ...login };
}

describe('Secure cookies', () => {
  it('APP_URL=https://… — the session, XSRF and remember-me cookies are Secure', async () => {
    const cookies = await signInRemembered({ APP_URL: 'https://example.com' });
    for (const name of [names().session, 'XSRF-TOKEN', names().remember]) {
      expect(cookies[name], name).toBeDefined();
      expect(cookies[name], name).toMatch(/; Secure(;|$)/);
    }
  });

  it('APP_URL=http://… — without Secure; SESSION_SECURE_COOKIE decides itself either way', async () => {
    for (const name of Object.values(await signInRemembered({ APP_URL: 'http://localhost' }))) expect(name).not.toContain('Secure');
    await app!.close();
    for (const name of Object.values(await signInRemembered({ APP_URL: 'http://localhost', SESSION_SECURE_COOKIE: 'true' }))) expect(name).toContain('; Secure');
    await app!.close();
    for (const name of Object.values(await signInRemembered({ APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: 'false' }))) expect(name).not.toContain('Secure');
  });

  it('a cookie the session does not set itself follows too: the reset link\'s', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { APP_URL: 'https://example.com' } });
    const reset = setCookies(await app.get('/reset-password?token=abc&email=ada%40example.com').assertRedirect());
    expect(reset.password_reset).toMatch(/; Path=\/reset-password; .*Secure/);
  });

  it('APP_URL=https://… — the session and remember-me cookies carry __Host-: Secure, Path=/, no Domain', async () => {
    const cookies = await signInRemembered({ APP_URL: 'https://example.com' });
    expect(Object.keys(cookies)).toEqual(expect.arrayContaining(['__Host-marmeon_session', '__Host-marmeon_remember']));
    expect(names()).toEqual({ session: '__Host-marmeon_session', remember: '__Host-marmeon_remember' });
    for (const name of [names().session, names().remember]) {
      expect(cookies[name], name).toMatch(/; Path=\/; /);
      expect(cookies[name], name).toMatch(/; Secure(;|$)/);
      expect(cookies[name], name).not.toMatch(/Domain/i);
    }
    expect(cookies.marmeon_session).toBeUndefined();
    expect(cookies.marmeon_remember).toBeUndefined();
  });

  it('without Secure no cookie carries __Host- — over plain HTTP (development) the names are the bare ones', async () => {
    for (const env of [{ APP_URL: 'http://localhost' } as Record<string, string>, { APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: 'false' }]) {
      const cookies = await signInRemembered(env);
      expect(Object.keys(cookies).filter((name) => name.startsWith('__Host-'))).toEqual([]);
      expect(cookies).toHaveProperty('marmeon_session');
      expect(cookies).toHaveProperty('marmeon_remember');
      await app!.close();
    }
  });

  it('reads only the prefixed session cookie when Secure — the same session under the bare name is a guest', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { APP_URL: 'https://example.com' } });
    const ada = await app.factory(UserFactory).create();
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertAuthenticated(ada);
    const id = login.cookie(names().session)!;
    await app.withCookie(names().session, id).get('/users/me').assertAuthenticated(ada);
    await app.withCookie('marmeon_session', id).get('/users/me').assertRedirect('/login');
  });

  it('reads only the prefixed remember-me cookie when Secure — a planted bare one signs nobody in, not even beside a valid session', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { APP_URL: 'https://example.com' } });
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const remembered = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } }).assertAuthenticated(ada);
    const adas = remembered.cookie(names().remember)!;
    expect(adas).toBeDefined();
    await app.withCookie(names().remember, adas).get('/users/me').assertAuthenticated(ada); // the genuine one still works
    for (const planted of ['marmeon_remember', 'remember_web']) {
      await app.withCookie(planted, adas).get('/users/me').assertRedirect('/login');
    }
    const bobs = await app.post('/login', { form: { email: bob.email, password: 'password' } }).assertAuthenticated(bob);
    await app.withCookie(names().session, bobs.cookie(names().session)!).withCookie('marmeon_remember', adas).get('/users/me').assertAuthenticated(bob);
  });

  it('refuses a cookie name that brings its own __Host- or __Secure- prefix, in any case', async () => {
    for (const env of [{ SESSION_COOKIE: '__Host-mine' }, { SESSION_COOKIE: '__secure-mine' }, { AUTH_REMEMBER_COOKIE: '__HOST-mine' }, { AUTH_REMEMBER_COOKIE: '__Secure-mine' }]) {
      await expect(createTestApp(application, { database: 'refresh', env: { APP_URL: 'https://example.com', ...env } })).rejects.toThrow(/__Host-/);
    }
  });

  it('masks the names of both cookies in the log, also a remember-me name of the app\'s own', async () => {
    app = await createTestApp(application, { database: 'refresh', env: { APP_URL: 'https://example.com', AUTH_REMEMBER_COOKIE: 'keep_me' } });
    const redactor = app.container.make(Redactor);
    expect(names()).toEqual({ session: '__Host-marmeon_session', remember: '__Host-keep_me' });
    expect(redactor.isSensitive(names().session)).toBe(true);
    expect(redactor.isSensitive(names().remember)).toBe(true);
  });

  it('never reads the old remember-me cookie name, Secure or not', async () => {
    app = await createTestApp(application, { database: 'refresh' });
    const ada = await app.factory(UserFactory).create();
    const remembered = await app.post('/login', { form: { email: ada.email, password: 'password', remember: 'on' } }).assertAuthenticated(ada);
    await app.withCookie('remember_web', remembered.cookie(names().remember)!).get('/users/me').assertRedirect('/login');
  });
});
