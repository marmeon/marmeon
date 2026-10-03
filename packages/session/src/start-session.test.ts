import { CacheServiceProvider } from '@bespokecore/cache';
import { CliServiceProvider } from '@bespokecore/cli';
import { createApplication, defineModule, type ModuleDefinition, type ServiceProviderClass } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { abort, Controller, defineRoutes, HttpServiceProvider } from '@bespokecore/http';
import { defineSchedule, SchedulerServiceProvider } from '@bespokecore/scheduler';
import { createHttpKernel } from '@bespokecore/server';
import { describe, expect, it } from 'vitest';
import { CsrfProtection } from './csrf.ts';
import { SessionServiceProvider } from './provider.ts';
import { SessionStore } from './store.ts';
import { Session } from './session.ts';

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

// Module routes join the `web` group, where the session provider put StartSession.
const routes = defineRoutes((Route) => {
  Route.get('/count', CountVisitsController);
  Route.post('/save', SaveController);
  Route.post('/fail', FailingController);
});
const apiRoutes = defineRoutes((Route) => {
  Route.post('/no-session', () => new SaveController().handle());
});

const sessionCookie = (response: Response) => response.headers.getSetCookie().find((header) => header.startsWith('bespoke_session='));

async function boot(env: Record<string, string> = {}, kernelOptions: { version?: string } = {}, extra: { providers?: ServiceProviderClass[]; schedule?: ModuleDefinition['schedule'] } = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', CACHE_DRIVER: 'memory', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ...(extra.providers ?? [])],
    modules: [defineModule({ name: 'visits', routes, apiRoutes, ...(extra.schedule ? { schedule: extra.schedule } : {}) })],
    override: (container) => container.make(CsrfProtection).disable(), // CSRF has its own tests
  });
  const kernel = createHttpKernel(application, kernelOptions);
  Object.assign(application, { kernel });
  // A tiny browser: remembers the session cookie between requests.
  let cookie = '';
  const send = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await kernel.request(path, { ...init, headers: { cookie, accept: 'application/json', ...init.headers } });
    const set = response.headers.getSetCookie().find((header) => header.startsWith('bespoke_session='));
    if (set) cookie = set.split(';')[0]!;
    return response;
  };
  return { send, cookieHeader: () => cookie, application: application as typeof application & { kernel: typeof kernel } };
}

describe('StartSession', () => {
  it('keeps state across requests through an encrypted, HttpOnly session cookie', async () => {
    const { send } = await boot();
    const first = await send('/count');
    expect(await first.json()).toEqual({ visits: 1, status: null });
    expect(sessionCookie(first)).toMatch(/^bespoke_session=[\w-]{60,}; Path=\/; Max-Age=7200; HttpOnly; SameSite=Lax$/);
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
    expect(sessionCookie(failed)).toMatch(/^bespoke_session=/);
  });

  it('fails loudly (500) for redirect().with() on a route without a session', async () => {
    const { send } = await boot({ LOG_LEVEL: 'silent' });
    const response = await send('/api/no-session', { method: 'POST' });
    expect(response.status).toBe(500);
  });

  it('cleans up expired sessions after the response, by lottery (SESSION_LOTTERY)', async () => {
    const { send, application } = await boot({ SESSION_LOTTERY: '1/1' });
    const store = application.container.make(SessionStore);
    await store.write('e'.repeat(40), {}, -1);
    await send('/count');
    await application.kernel.settle();
    expect(await store.gc(0)).toBe(0); // the expired session was already collected by terminate()
  });

  it('draws no lottery when the scheduler runs session:prune — then that is the one sweeper', async () => {
    const providers = [CliServiceProvider, CacheServiceProvider, SchedulerServiceProvider];
    const scheduled = await boot({ SESSION_LOTTERY: '1/1' }, {}, { providers, schedule: defineSchedule((s) => void s.command('session:prune').everyFifteenMinutes()) });
    const store = scheduled.application.container.make(SessionStore);
    await store.write('e'.repeat(40), {}, -1);
    await scheduled.send('/count');
    await scheduled.application.kernel.settle();
    expect(await store.gc(0)).toBe(1); // still there for session:prune
    // A schedule without it: the lottery as configured.
    const other = await boot({ SESSION_LOTTERY: '1/1' }, {}, { providers, schedule: defineSchedule((s) => void s.command('cache:prune').hourly()) });
    const otherStore = other.application.container.make(SessionStore);
    await otherStore.write('e'.repeat(40), {}, -1);
    await other.send('/count');
    await other.application.kernel.settle();
    expect(await otherStore.gc(0)).toBe(0);
  });

  it('keeps flash data through an asset-version reload (409)', async () => {
    const { send } = await boot({ ASSET_VERSION: 'v2' }, { version: 'v2' });
    await send('/save', { method: 'POST' });
    const stale = await send('/count', { headers: { 'x-bespoke': 'true', 'x-bespoke-version': 'v1' } });
    expect(stale.status).toBe(409);
    expect(await (await send('/count')).json()).toMatchObject({ status: 'Saved.' }); // still there after the reload
  });

  it('reads the cookie settings from the config', async () => {
    const { send } = await boot({ SESSION_COOKIE: 'shop_session', SESSION_LIFETIME: '30', SESSION_SECURE_COOKIE: 'true', SESSION_SAME_SITE: 'strict' });
    const cookie = (await send('/count')).headers.getSetCookie().find((header) => header.startsWith('shop_session='));
    expect(cookie).toMatch(/^shop_session=[\w-]+; Path=\/; Max-Age=1800; HttpOnly; Secure; SameSite=Strict$/);
  });
});
