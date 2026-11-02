import { cookieNames } from '@marmeon/auth/testing';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

// The header's "Settings" link is current on every page of the settings layout — the server-rendered markup says so.
let server: SsrServer;
let app: TestApp;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', ssr: true, ssrServer: server });
}, 30_000);

const page = { headers: { accept: 'text/html' } };
const current = '<a href="/settings/security" aria-current="page"';

describe('the header’s Settings link', { timeout: 30_000 }, () => {
  it.each(['/settings/security', '/settings/two-factor', '/settings/passkeys', '/settings/tokens'])('is marked current on %s', async (path) => {
    const ada = await app.factory(UserFactory).create();
    // A fresh sign-in counts as the password confirmation the settings pages ask for.
    const login = await app.post('/login', { form: { email: ada.email, password: 'password' } });
    await app.withCookie(cookieNames(app).session, login.cookie(cookieNames(app).session)!).get(path, page).assertOk().assertServerRendered().assertSee(current);
  });
});
