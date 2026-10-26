import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import type { PageRenderer } from '@marmeon/server/internal';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp, startSsrServer } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// The rendering itself needs the app's Vite setup (the web app's tests run it for real); here only what the shared server
// does around it: who starts it, who closes it, and what stays per app.
const vites = vi.hoisted(() => ({ started: 0, closed: 0 }));
vi.mock('@marmeon/server/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marmeon/server/internal')>()),
  createViteDevRenderer: async () => {
    vites.started++;
    const renderer = {
      render: async (page: { component: string }) => `<html>rendered ${page.component}</html>`,
      shell: async (page: { component: string }) => `<html>shell ${page.component}</html>`,
    } as unknown as PageRenderer;
    return {
      vite: {
        close: async () => {
          vites.closed++;
        },
      },
      renderer,
    };
  },
}));

class HelloController extends Controller {
  handle() {
    return this.view('pages/Hello', {});
  }
}

const env = { APP_KEY: generateKey() };

function appAt(root: string): ApplicationDefinition {
  return {
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [defineModule({ name: 'pages', routes: openRoutes((Route) => {
      Route.get('/hello', HelloController);
      Route.get('/cookie', (ctx) => new Response(ctx.request.headers.get('cookie') ?? ''));
    }) })],
  };
}

const page = { headers: { accept: 'text/html' } };

describe('startSsrServer', () => {
  it('serves several test apps from one Vite server, and closing an app leaves it running', async () => {
    const application = appAt(tempDir('marmeon-ssr-server-'));
    const started = vites.started;
    const closed = vites.closed;
    const server = await startSsrServer(application);
    const first = await createTestApp(application, { env, ssr: true, ssrServer: server });
    const second = await createTestApp(application, { env, ssr: 'stream', ssrServer: server });
    expect(vites.started).toBe(started + 1);

    await first.get('/hello', page).assertOk().assertSee('rendered pages/Hello');
    await first.close();
    await second.get('/hello', page).assertOk();

    await second.close();
    expect(vites.closed).toBe(closed);
    await server.close();
    await server.close();
    expect(vites.closed).toBe(closed + 1);
  });

  it('keeps what one test app has apart from the next', async () => {
    const application = appAt(tempDir('marmeon-ssr-server-'));
    const server = await startSsrServer(application);
    const first = await createTestApp(application, { env, ssr: true, ssrServer: server });
    const second = await createTestApp(application, { env, ssr: true, ssrServer: server });
    await Promise.all([first.get('/hello', page).assertSee('rendered'), second.get('/hello', page).assertSee('rendered')]);
    expect((await first.withCookie('mine', '1').get('/cookie')).body).toMatch(/^mine=/);
    expect((await second.get('/cookie')).body).toBe('');
    await first.close();
    await second.close();
    await server.close();
  });

  it('refuses a server for another app, a missing ssr option and a closed server', async () => {
    const application = appAt(tempDir('marmeon-ssr-server-'));
    const server = await startSsrServer(application);
    const other = appAt(tempDir('marmeon-ssr-server-'));
    await expect(createTestApp(other, { env, ssr: true, ssrServer: server })).rejects.toThrow(`started for ${application.root}, the app's root is ${other.root}`);
    await expect(createTestApp(application, { env, ssrServer: server })).rejects.toThrow('needs ssr: true');
    await server.close();
    await expect(createTestApp(application, { env, ssr: true, ssrServer: server })).rejects.toThrow(
      'The SSR server was closed — start it in beforeAll and close it in afterAll',
    );
  });
});

// Never called: only the types matter.
export async function typeLevelTests(application: ApplicationDefinition): Promise<void> {
  const server = await startSsrServer(application);
  await createTestApp(application, { env, ssr: true, ssrServer: server });
  // @ts-expect-error — the Vite server is a `startSsrServer()` result, not a path.
  await createTestApp(application, { env, ssr: true, ssrServer: application.root });
  // @ts-expect-error — the renderer behind a server is not part of its type.
  server.renderer;
}
