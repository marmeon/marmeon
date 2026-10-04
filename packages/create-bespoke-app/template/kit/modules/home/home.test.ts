import { createTestApp, type TestApp } from '@bespokecore/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { AppConfig } from '../../config/app.ts';
import { UserFactory } from '../auth/index.ts';

// The home page's tests — written by create-bespoke-app's starter kit. `pnpm test` runs them with the auth module's.

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

describe('the home page', () => {
  it('shows guests the way in — without starting a session', async () => {
    const home = await app.navigating().get('/');
    home.assertPage('home/Home', { appName: app.make(AppConfig).name });
    expect(home.page()!.props.auth).toEqual({ user: null });
    expect(home.headers.getSetCookie()).toEqual([]);
  });

  it('shows a signed-in user the way to the dashboard', async () => {
    const ada = await app.factory(UserFactory).create();
    const home = await app.actingAs(ada).navigating().get('/');
    home.assertPage('home/Home');
    expect(home.page()!.props.auth).toEqual({ user: { id: ada.id, name: ada.name, verified: true } });
  });

  it('is a document with its own Content-Security-Policy nonce', async () => {
    const page = await app.get('/', { headers: { accept: 'text/html' } });
    page.assertOk();
    expect(page.headers.get('content-security-policy')).toMatch(/'nonce-[^']+'/);
  });
});
