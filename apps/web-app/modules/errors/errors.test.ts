import { UserRepository, type User } from '#modules/auth';
import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let server: SsrServer;
let app: TestApp;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true, ssr: true, ssrServer: server });
});

const page = { headers: { accept: 'text/html' } };

describe('the page per status', () => {
  it('shows modules/errors/views/404.tsx for a 404, on the server and in the browser, which hydrates it', async () => {
    await app
      .get('/no/such/page', page)
      .assertNotFound()
      .assertPage('errors/Error') // on the wire it stays the one name
      .assertServerRendered()
      .assertSee('<h1>This page does not exist</h1>')
      .assertHydrates();
  });

  it('leaves the other statuses to errors/Error', async () => {
    const users: User[] = await app.make(UserRepository).query().selectAll().orderBy('id').execute();
    const [ada, alan] = users as [User, User];
    await app.actingAs(ada).get(`/users/${alan.public_id}/edit`, page).assertForbidden().assertPage('errors/Error').assertServerRendered().assertDontSee('This page does not exist');
  });
});
