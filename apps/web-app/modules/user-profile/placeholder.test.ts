import { createTestApp, startSsrServer, type SsrServer, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

// The placeholder of an instant visit — what a link puts on screen before the page's answer — rendered on the server, in its layouts.
let server: SsrServer;
beforeAll(async () => {
  server = await startSsrServer(application);
});
afterAll(() => server?.close());

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { ssr: true, ssrServer: server });
});

describe('app.placeholder(): what an instant visit shows first', () => {
  it('renders the profile’s placeholder with what the link passes, inside the app layout', async () => {
    const markup = await app.placeholder('user-profile.show', { name: 'Ada <Lovelace>' });
    markup.assertSee('Loading the profile…').assertSee('Ada &lt;Lovelace&gt;').assertSee('Marmeon').assertDontSee('<Lovelace>');
    expect(markup.html).toContain('data-placeholder');
  });

  it('renders a placeholder that takes nothing: `true` or no value', async () => {
    (await app.placeholder('dashboard.show', true)).assertSee('Loading…');
    (await app.placeholder('dashboard.show')).assertSee('<h1>Dashboard</h1>');
  });

  it('says why a route has no placeholder to render', async () => {
    await expect(app.placeholder('auth.login' as never, {} as never)).rejects.toThrow(/app\.placeholder\('auth\.login'\): \[auth\/Login\] has no placeholder/);
  });
});
