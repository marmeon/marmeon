import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { cacheControl, Controller, HttpServiceProvider, view } from '@marmeon/http';
import { createHttpKernel } from '@marmeon/server';
import { describe, expect, it } from 'vitest';
import { CsrfProtection } from './csrf.ts';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

class SignIn extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('name', 'Alice');
    return { ok: true };
  }
}

class Profile extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    return view('profile/Show', { name: this.#session.get('name') ?? 'guest' });
  }
}

// Module routes join the `web` group (the session starts there), API routes the `api` group (it does not).
const routes = openRoutes((Route) => {
  Route.get('/sign-in', SignIn);
  Route.get('/profile', Profile).name('profile.show');
});
const apiRoutes = openRoutes((Route) => {
  // A public layer route whose base belongs to the session.
  Route.middleware(cacheControl('public, s-maxage=600')).get('/note', () => view('profile/Note', {}).layer({ base: 'profile.show' }));
});

async function boot() {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    modules: [defineModule({ name: 'shared', routes, apiRoutes })],
  }, { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', CACHE_DRIVER: 'memory' }, override: (container) => container.make(CsrfProtection).disable() });
  return createHttpKernel(application);
}

describe('answers that carry a session and shared caches', () => {
  it('keeps the deep link of a public layer private when its base is rendered with the visitor’s session', async () => {
    const kernel = await boot();
    const signedIn = await kernel.request('/sign-in', { headers: { accept: 'application/json' } });
    const cookie = signedIn.headers.getSetCookie().map((header) => header.split(';')[0]).join('; ');

    const response = await kernel.request('/api/note', { headers: { cookie } });
    const html = await response.text();
    expect(html).toContain('Alice');
    const control = response.headers.get('cache-control') ?? '';
    expect(control).toContain('private');
    expect(control).not.toContain('s-maxage');
  });
});
