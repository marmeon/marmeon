import { defineModule, type ApplicationDefinition } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import type { PageRenderer } from '@marmeon/server';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// The markup itself needs the app's Vite setup and its views (the web app's tests render a real placeholder); here only what
// the helper does around it: which view it asks for, what it hands over, and what it says when there is nothing to show.
const asked = vi.hoisted(() => ({ calls: [] as { component: string; props: unknown; placeholder?: Record<string, unknown>; complete?: boolean }[], fail: undefined as Error | undefined }));
vi.mock('@marmeon/server/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marmeon/server/internal')>()),
  createViteDevRenderer: async () => ({
    vite: { close: async () => {} },
    renderer: { render: async () => '<html></html>', shell: async () => '<html></html>' } as unknown as PageRenderer,
    ssr: async () => async (page: { component: string; props: unknown }, options?: { placeholder?: Record<string, unknown>; complete?: boolean; onError?: (error: unknown) => void }) => {
      asked.calls.push({ component: page.component, props: page.props, ...options });
      const instant = options?.placeholder as { title?: string } | undefined;
      if (asked.fail) throw asked.fail;
      return { html: `<body><nav>Layout</nav><main><h1>${instant?.title ?? ''}</h1></main></body>` };
    },
  }),
}));

class ShowNoteController extends Controller {
  handle() {
    return this.view('notes/Show', {});
  }
}

class ComputedController extends Controller {
  handle() {
    const name = 'notes/Index';
    return this.view(name, {});
  }
}

class PlainController extends Controller {
  handle() {
    return this.view('notes/Plain', {});
  }
}

const env = { APP_KEY: generateKey() };

function appAt(root: string): ApplicationDefinition {
  return {
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'notes',
        routes: openRoutes((Route) => {
          Route.get('/notes/:note', ShowNoteController).name('notes.show');
          Route.get('/notes', ComputedController).name('notes.index');
          Route.post('/notes', PlainController).name('notes.store');
        }),
      }),
    ],
  };
}

describe('app.placeholder()', () => {
  it('renders the view the route names, with what the link passes, and lets the markup be asserted', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-placeholder-')), { env, ssr: true });
    const markup = await app.placeholder('notes.show' as never, { title: 'Groceries' } as never);
    markup.assertSee('Groceries').assertSee('<nav>Layout</nav>').assertDontSee('Archive');
    expect(markup.html).toContain('<h1>Groceries</h1>');
    expect(asked.calls.at(-1)).toMatchObject({ component: 'notes/Show', props: {}, placeholder: { title: 'Groceries' }, complete: true });
    await app.placeholder('notes.show' as never, true as never);
    expect(asked.calls.at(-1)).toMatchObject({ props: {}, placeholder: {} });
    await app.close();
  });

  it('fails an assertion with the markup in the message', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-placeholder-')), { env, ssr: true });
    const markup = await app.placeholder('notes.show' as never, { title: 'Groceries' } as never);
    expect(() => markup.assertSee('Archive')).toThrow(/Expected to see "Archive"[\s\S]*Groceries/);
    expect(() => markup.assertDontSee('Groceries')).toThrow('Expected not to see "Groceries"');
    await app.close();
  });

  it('says what to do without server rendering', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-placeholder-')), { env });
    await expect(app.placeholder('notes.show' as never, {} as never)).rejects.toThrow("app.placeholder('notes.show'): it needs server rendering in the test: createTestApp(app, { ssr: true })");
    await app.close();
  });

  it('says why a route has no view to look up, or is not a route the browser knows', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-placeholder-')), { env, ssr: true });
    await expect(app.placeholder('notes.index' as never, {} as never)).rejects.toThrow(/does not name its view once.*this\.view\('notes\/Show', …\)/);
    await expect(app.placeholder('notes.store' as never, {} as never)).rejects.toThrow(/does not name its view once/);
    await expect(app.placeholder('notes.nope' as never, {} as never)).rejects.toThrow("app.placeholder('notes.nope'): no such route");
    await app.close();
  });

  it('says that the view has no placeholder, and fails with the error of one that throws', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-placeholder-')), { env, ssr: true });
    asked.fail = new Error('[notes/Show] has no placeholder: set `Show.placeholder = …` on the view');
    await expect(app.placeholder('notes.show' as never, {} as never)).rejects.toThrow("app.placeholder('notes.show'): [notes/Show] has no placeholder: set `Show.placeholder = …`");
    asked.fail = new Error('boom in the placeholder');
    await expect(app.placeholder('notes.show' as never, {} as never)).rejects.toThrow(/the placeholder did not render: Error: boom in the placeholder/);
    asked.fail = undefined;
    await app.close();
  });
});
