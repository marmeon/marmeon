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
  it('logs in via form post, sets the session cookie and redirects', async () => {
    const response = await app.post('/login', { form: { user_id: '3' } }).assertRedirect('/users/me');
    await app.withCookie(SESSION_COOKIE, response.cookie(SESSION_COOKIE)!).get('/users/me').assertRedirect('/users/3');
  });

  it('rejects unknown users', async () => {
    const response = await app.post('/login', { form: { user_id: '99' } }).assertRedirect('/login');
    if (response.cookie(SESSION_COOKIE) !== undefined) throw new Error('no session cookie expected');
  });

  it('clears the cookie on logout', async () => {
    const response = await app.post('/logout').assertRedirect('/login');
    if (response.cookie(SESSION_COOKIE) !== '') throw new Error('expected the session cookie to be cleared');
  });

  it('injects the validated app config (from .env.test under Vitest)', async () => {
    await app.navigating().get('/login').assertPage<ShowLoginController>('auth/Login', { appName: 'BespokeCore (test)' });
  });
});
