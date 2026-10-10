import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

// Cookies follow APP_URL — `https://` sends every cookie of the app with `Secure` (the session's, the XSRF token, the
// remember-me token, the reset link's, the cookie store's), `http://` without; SESSION_SECURE_COOKIE=true/false decides itself.
let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Every `Set-Cookie` of a response, by cookie name. */
function setCookies(response: { headers: Headers }): Record<string, string> {
  return Object.fromEntries(response.headers.getSetCookie().map((header) => [header.slice(0, header.indexOf('=')), header]));
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
    for (const name of ['marmeon_session', 'XSRF-TOKEN', 'remember_web']) {
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
});
