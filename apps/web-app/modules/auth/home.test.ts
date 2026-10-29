import { cookieNames } from '@marmeon/auth/testing';
import { Router } from '@marmeon/router';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { HOME } from './home.ts';
import { WARM_UP_TIMEOUT, warmUp } from './warm-up.ts';

beforeAll(warmUp, WARM_UP_TIMEOUT);

let app: TestApp;
let SESSION: string;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
  ({ session: SESSION } = cookieNames(app));
});

const home = () => app.make(Router).url(HOME);

describe('home.ts', () => {
  it('sends a sign-in to HOME, in a new session', async () => {
    const ada = await app.factory(UserFactory).create();
    const planted = await app.post('/login', { form: { email: ada.email, password: 'wrong' } });
    const login = await app.withCookie(SESSION, planted.cookie(SESSION)!).post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect(home()).assertAuthenticated(ada);
    expect(login.cookie(SESSION)).not.toBe(planted.cookie(SESSION));
  });

  it('sends a signed-in person who opens a guest page to HOME', async () => {
    const ada = await app.factory(UserFactory).create();
    for (const path of ['/login', '/register', '/forgot-password']) await app.actingAs(ada).get(path).assertRedirect(home());
  });

  it('sends a sign-in to the page that asked for it, and HOME when none did', async () => {
    const ada = await app.factory(UserFactory).create();
    const asked = await app.get('/settings/security').assertRedirect('/login');
    await app.withCookie(SESSION, asked.cookie(SESSION)!).post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect('/settings/security');
    await app.post('/login', { form: { email: ada.email, password: 'password' } }).assertRedirect(home());
  });
});

describe('home.ts with open registration', () => {
  it('sends a sign-up that signs in to HOME', async () => {
    await app.close(); // the hook's app: this one has registration open
    app = await createTestApp(application, { database: 'refresh', env: { AUTH_PRIVATE_REGISTRATION: 'false' } });
    await app.post('/register', { form: { name: 'Grace Hopper', email: 'grace@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' } }).assertRedirect(home());
  });
});
