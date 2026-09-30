import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { ShowLoginController } from './controllers/ShowLoginController.ts';
import { SESSION_COOKIE } from './middleware.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
});

describe('auth module', () => {
  it('logs in via form post, sets the session cookie and redirects (303 after a POST)', async () => {
    const response = await app.post('/login', { form: { user_id: '3' } }).assertStatus(303).assertRedirect('/users/me').assertCookie(SESSION_COOKIE, '3');
    await app.withCookie(SESSION_COOKIE, response.cookie(SESSION_COOKIE)!).get('/users/me').assertRedirect('/users/3');
  });

  it('ignores a forged, unencrypted session cookie', async () => {
    await app.withUnencryptedCookie(SESSION_COOKIE, '1').expectingJson().get('/users/me').assertUnauthorized();
    await app.withCookie(SESSION_COOKIE, '1').get('/users/me').assertRedirect('/users/1'); // encrypted by the app's key
  });

  it('sends unknown users back to the page they came from', async () => {
    await app
      .post('/login', { form: { user_id: '99' }, headers: { referer: 'http://localhost/login' } })
      .assertRedirect('/login')
      .assertCookieMissing(SESSION_COOKIE);
  });

  it('expires the cookie on logout', async () => {
    await app.withCookie(SESSION_COOKIE, '1').post('/logout').assertRedirect('/login').assertCookieExpired(SESSION_COOKIE);
  });

  it('injects the validated app config (from .env.test under Vitest)', async () => {
    await app.navigating().get('/login').assertPage<ShowLoginController>('auth/Login', { appName: 'BespokeCore (test)' });
  });
});
