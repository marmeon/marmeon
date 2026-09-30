import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { abort, Controller, defineRoutes, EncryptCookies, HttpServiceProvider } from '@bespokecore/http';
import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { SessionServiceProvider } from './provider.ts';
import { Session } from './session.ts';
import { StartSession } from './start-session.ts';

class CountVisitsController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    const visits = Number(this.#session.get('visits') ?? 0) + 1;
    this.#session.put('visits', visits);
    return { visits, status: this.#session.get('status') ?? null };
  }
}

class SaveController extends Controller {
  handle() {
    return this.redirect('/count').with('status', 'Saved.');
  }
}

class FailingController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('attempted', true);
    abort(422, 'Nope.');
  }
}

const routes = defineRoutes((Route) => {
  Route.middleware(EncryptCookies)
    .middleware(StartSession)
    .group((Route) => {
      Route.get('/count', CountVisitsController);
      Route.post('/save', SaveController);
      Route.post('/fail', FailingController);
    });
  Route.post('/no-session', () => new SaveController().handle());
});

async function boot(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    modules: [defineModule({ name: 'visits', routes })],
  });
  const kernel = createHttpKernel(application);
  // A tiny browser: remembers the session cookie between requests.
  let cookie = '';
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await kernel.request(path, { ...init, headers: { cookie, accept: 'application/json' } });
    const set = response.headers.getSetCookie().find((header) => header.startsWith('bespoke_session='));
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  return { send, cookieHeader: () => cookie };
}

describe('StartSession', () => {
  it('keeps state across requests through an encrypted, HttpOnly session cookie', async () => {
    const { send } = await boot();
    const first = await send('/count');
    expect(await first.json()).toEqual({ visits: 1, status: null });
    expect(first.headers.getSetCookie()[0]).toMatch(/^bespoke_session=[\w-]{60,}; Path=\/; Max-Age=7200; HttpOnly; SameSite=Lax$/);
    expect(await (await send('/count')).json()).toEqual({ visits: 2, status: null });
  });

  it('flashes redirect().with() data for the next request only', async () => {
    const { send } = await boot();
    const saved = await send('/save', { method: 'POST' });
    expect(saved.status).toBe(303);
    expect(await (await send('/count')).json()).toMatchObject({ status: 'Saved.' });
    expect(await (await send('/count')).json()).toMatchObject({ status: null });
  });

  it('saves the session even when the route throws', async () => {
    const { send } = await boot();
    const failed = await send('/fail', { method: 'POST' });
    expect(failed.status).toBe(422);
    expect(failed.headers.getSetCookie()[0]).toMatch(/^bespoke_session=/);
  });

  it('fails loudly (500) for redirect().with() on a route without a session', async () => {
    const { send } = await boot({ LOG_LEVEL: 'silent' });
    const response = await send('/no-session', { method: 'POST' });
    expect(response.status).toBe(500);
  });

  it('reads the cookie settings from the config', async () => {
    const { send } = await boot({ SESSION_COOKIE: 'shop_session', SESSION_LIFETIME: '30', SESSION_SECURE_COOKIE: 'true', SESSION_SAME_SITE: 'strict' });
    const [cookie] = (await send('/count')).headers.getSetCookie();
    expect(cookie).toMatch(/^shop_session=[\w-]+; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$/);
  });
});
