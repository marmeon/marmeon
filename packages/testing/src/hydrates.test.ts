import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { PAGE_SCRIPT_ID } from '@marmeon/http/protocol';
import type { PageRenderer } from '@marmeon/server/internal';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// The rendering itself needs the app's Vite setup (the web app's tests render for real); here a renderer that returns the
// markup each view is given, so that assertHydrates() runs end to end on a response.
const markup = vi.hoisted(() => ({
  'pages/Nested': '<nav><ul><li>Home<li>Guests</li></li></ul></nav>',
  'pages/Valid': '<nav><ul><li>Home<ul><li>Guests</li></ul></li></ul></nav>',
}));
vi.mock('@marmeon/server/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marmeon/server/internal')>()),
  createViteDevRenderer: async () => ({
    vite: { close: async () => {} },
    renderer: {
      render: async (page: { component: keyof typeof markup }) =>
        `<html><body>${markup[page.component]}<script type="application/json" id="${PAGE_SCRIPT_ID}">${JSON.stringify({ ...page, version: '' })}</script></body></html>`,
      shell: async () => '<html></html>',
    } as unknown as PageRenderer,
  }),
}));

class NestedController extends Controller {
  handle() {
    return this.view('pages/Nested', {});
  }
}

class ValidController extends Controller {
  handle() {
    return this.view('pages/Valid', {});
  }
}

const env = { APP_KEY: generateKey() };
const page = { headers: { accept: 'text/html' } };

function appAt(root: string): ApplicationDefinition {
  return {
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/nested', NestedController);
          Route.get('/valid', ValidController);
        }),
      }),
    ],
  };
}

describe('assertHydrates() on a rendered page', () => {
  it('fails for an <li> inside an <li> and passes for a list inside a list item', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-hydrates-')), { env, ssr: true });
    await expect(Promise.resolve(app.get('/nested', page).assertHydrates())).rejects.toThrow(/<li> inside <li>/);
    await app.get('/valid', page).assertHydrates();
    await app.close();
  });
});
