import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import type { LoginController } from './controllers/LoginController.ts';
import type { ShowLoginController } from './controllers/ShowLoginController.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application);
});

describe('auth module', () => {
  it('logs in via form post: the user goes into a regenerated session (303 after a POST)', async () => {
    const planted = await app.get('/login'); // a session id handed out before login …
    const response = await app
      .withCookie('bespoke_session', planted.cookie('bespoke_session')!)
      .post('/login', { form: { user_id: '3' } })
      .assertStatus(303)
      .assertRedirect('/users/me')
      .assertValid()
      .assertSessionHas('user_id', '3');

    expect(response.cookie('bespoke_session')).not.toBe(planted.cookie('bespoke_session')); // … does not survive it
    await app.withCookie('bespoke_session', response.cookie('bespoke_session')!).get('/users/me').assertRedirect('/users/3');
  });

  it('validates the login (LoginRequest) and reports unknown users next to the field, once', async () => {
    await app.post('/login', { form: { user_id: 'abc' } }).assertRedirect('/').assertInvalid<LoginController>({ user_id: 'Pick a user.' });
    await app.expectingJson().post('/login', { json: {} }).assertUnprocessable().assertInvalid<LoginController>(['user_id']);

    const response = await app
      .post('/login', { form: { user_id: '99' }, headers: { referer: 'http://localhost/login' } })
      .assertRedirect('/login')
      .assertSessionMissing('user_id')
      .assertInvalid<LoginController>({ user_id: 'Unknown user.' });

    const next = app.withCookie('bespoke_session', response.cookie('bespoke_session')!).navigating();
    await next.get('/login').assertPage<ShowLoginController>('auth/Login', { errors: { user_id: ['Unknown user.'] } });
    await next.get('/login').assertPage<ShowLoginController>('auth/Login', (props) => expect(props.errors).toEqual({}));
  });

  it('ends the session on logout and says so on the login page', async () => {
    const response = await app
      .withSession({ user_id: '1' })
      .post('/logout')
      .assertRedirect('/login')
      .assertSessionMissing('user_id')
      .assertSessionHas('status', 'You have been signed out.');

    await app
      .withCookie('bespoke_session', response.cookie('bespoke_session')!)
      .navigating()
      .get('/login')
      .assertPage<ShowLoginController>('auth/Login', { status: 'You have been signed out.' });
  });

  it('refuses a login without CSRF token (419) and accepts the one from the login page', async () => {
    const protectedApp = await createTestApp(application, { csrf: true });
    await protectedApp.post('/login', { form: { user_id: '1' } }).assertStatus(419);

    const page = await protectedApp.navigating().get('/login');
    const { csrfToken } = page.page()!.props as { csrfToken: string };
    await protectedApp
      .withCookie('bespoke_session', page.cookie('bespoke_session')!)
      .post('/login', { form: { user_id: '1', _token: csrfToken } })
      .assertRedirect('/users/me');
  });

  it('ignores forged session cookies', async () => {
    await app.withUnencryptedCookie('bespoke_session', 'x'.repeat(40)).expectingJson().get('/users/me').assertUnauthorized();
  });

  it('injects the validated app config (from .env.test under Vitest)', async () => {
    await app.navigating().get('/login').assertPage<ShowLoginController>('auth/Login', { appName: 'BespokeCore (test)' });
  });
});
