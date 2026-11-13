import { UserRepository, type User } from '#modules/auth';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
let ada: User;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true, ssrServer: server });
  const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
  [ada] = users as [User];
});

describe('a component of a package with a namespace, on the dashboard', () => {
  it('is in the server-rendered page, and the page hydrates without a mismatch', async () => {
    const response = await app.actingAs(ada).get('/dashboard', { headers: { accept: 'text/html' } }).assertOk().assertServerRendered().assertHydrates();
    expect(response.body).toContain('class="status-board"');
    expect(response.body).toMatch(/<span data-badge="" data-state="degraded">degraded<\/span>/);
    // The link of the package's component names a route of the app, and the server resolved it.
    expect(response.body).toMatch(/<a [^>]*href="\/settings\/sensitive"[^>]*>Sensitive actions<\/a>/);
  });
});
