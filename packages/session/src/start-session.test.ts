import { CacheServiceProvider } from '@marmeon/cache';
import { CliServiceProvider } from 'marmeon';
import { createApplication, defineModule, Logger, type Container, type ModuleDefinition, type ServiceProviderClass } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { abort, Controller, HttpServiceProvider } from '@marmeon/http';
import { defineSchedule, SchedulerServiceProvider } from '@marmeon/scheduler';
import { createHttpKernel } from '@marmeon/server';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { CsrfProtection } from './csrf.ts';
import { sessionCookieName } from './config.ts';
import { SessionServiceProvider } from './provider.ts';
import { SessionStore } from './store.ts';
import { Session } from './session.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

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

/** Reads the counter, takes its time, writes it back + 1 — a read-modify-write that concurrent requests break. */
class SlowCountController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  async handle() {
    const visits = Number(this.#session.get('visits') ?? 0);
    await sleep(15);
    this.#session.put('visits', visits + 1);
    return { visits: visits + 1 };
  }
}

// Module routes join the `web` group, where the session provider put StartSession.
const routes = openRoutes((Route) => {
  Route.get('/count', CountVisitsController);
  Route.post('/slow', SlowCountController);
  Route.post('/slow/blocked', SlowCountController).block(2, 2);
  Route.post('/slow/impatient', SlowCountController).block(2, 0.01);
  Route.post('/save', SaveController);
  Route.post('/fail', FailingController);
});
const apiRoutes = openRoutes((Route) => {
  Route.post('/no-session', () => new SaveController().handle());
});

const sessionCookie = (response: Response) => response.headers.getSetCookie().find((header) => header.startsWith('marmeon_session='));

async function boot(env: Record<string, string> = {}, kernelOptions: { version?: string } = {}, extra: { providers?: ServiceProviderClass[]; schedule?: ModuleDefinition['schedule'] } = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, ...(extra.providers ?? [])],
    modules: [defineModule({ name: 'visits', routes, apiRoutes, ...(extra.schedule ? { schedule: extra.schedule } : {}) })], // CSRF has its own tests
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', CACHE_DRIVER: 'memory', ...env }, override: (container) => container.make(CsrfProtection).disable() });
  const kernel = createHttpKernel(application, kernelOptions);
  Object.assign(application, { kernel });
  // A tiny browser: remembers the session cookie between requests.
  let cookie = '';
  const send = async (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
    const response = await kernel.request(path, { ...init, headers: { cookie, accept: 'application/json', ...init.headers } });
    const set = response.headers.getSetCookie().find((header) => header.startsWith('marmeon_session='));
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
    expect(sessionCookie(first)).toMatch(/^marmeon_session=[\w-]{60,}; Path=\/; HttpOnly; SameSite=Lax$/);
    expect(await (await send('/count')).json()).toEqual({ visits: 2, status: null });
  });

  it('ends a session on the server after SESSION_LIFETIME_MINUTES although its cookie carries no expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { send } = await boot({ SESSION_LIFETIME_MINUTES: '30' });
      const first = await send('/count');
      expect(sessionCookie(first)).not.toMatch(/Max-Age|Expires/i);
      expect(await (await send('/count')).json()).toMatchObject({ visits: 2 });
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const later = await send('/count');
      expect(await later.json()).toMatchObject({ visits: 1 });
      expect(sessionCookie(later)!.split(';')[0]).not.toBe(sessionCookie(first)!.split(';')[0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SESSION_LIFETIME_MINUTES=1 keeps a session at 59 seconds of silence and ends it at 61', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const alive = await boot({ SESSION_LIFETIME_MINUTES: '1' });
      await alive.send('/count');
      vi.setSystemTime(Date.now() + 59_000);
      expect(await (await alive.send('/count')).json()).toMatchObject({ visits: 2 });

      const gone = await boot({ SESSION_LIFETIME_MINUTES: '1' });
      await gone.send('/count');
      vi.setSystemTime(Date.now() + 61_000);
      expect(await (await gone.send('/count')).json()).toMatchObject({ visits: 1 });
    } finally {
      vi.useRealTimers();
    }
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
    expect(sessionCookie(failed)).toMatch(/^marmeon_session=/);
  });

  it('fails loudly (500) for redirect().with() on a route without a session', async () => {
    const { send } = await boot({ LOG_LEVEL: 'silent' });
    const response = await send('/api/no-session', { method: 'POST' });
    expect(response.status).toBe(500);
  });

  it('cleans up expired sessions after the response, by lottery (SESSION_LOTTERY)', async () => {
    const { send, application } = await boot({ SESSION_LOTTERY: '1/1' });
    const store = application.container.make(SessionStore);
    await store.write('e'.repeat(64), '{}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    await send('/count');
    await application.kernel.settle();
    expect(await store.gc(0)).toBe(0); // the expired session was already collected by terminate()
  });

  it('asks the store to collect what is idle for SESSION_LIFETIME_MINUTES, in seconds', async () => {
    const { send, application } = await boot({ SESSION_LOTTERY: '1/1', SESSION_LIFETIME_MINUTES: '7' });
    const store = application.container.make(SessionStore);
    const asked: number[] = [];
    store.gc = (lifetimeSeconds) => (asked.push(lifetimeSeconds), Promise.resolve(0));
    await send('/count');
    await application.kernel.settle();
    expect(asked).toEqual([420]);
  });

  it("logs a failed clean-up masked by the app's Redactor — this package's cookie an error quotes stays out of the log", async () => {
    const logged: string[] = [];
    const capture: Logger = { debug() {}, info() {}, warn: (message, context) => logged.push(`${message}: ${String(context?.exception)}`), error() {}, child: () => capture };
    const { send, application } = await boot({ SESSION_LOTTERY: '1/1' }, {}, { providers: [class { register = (container: Container) => container.instance(Logger, capture); }] });
    const store = application.container.make(SessionStore);
    store.gc = () => Promise.reject(new Error('the store refused Cookie: a=1; marmeon_session=s3ss10nvalue'));
    await send('/count');
    await application.kernel.settle();
    expect(JSON.stringify(logged), JSON.stringify(logged)).not.toContain('s3ss10nvalue');
    expect(logged).toContain('Session garbage collection failed: Error: the store refused Cookie: [redacted]; marmeon_session=[redacted]');
  });

  it('draws no lottery when the scheduler runs session:prune — then that is the one sweeper', async () => {
    const providers = [CliServiceProvider, CacheServiceProvider, SchedulerServiceProvider];
    const scheduled = await boot({ SESSION_LOTTERY: '1/1' }, {}, { providers, schedule: defineSchedule((s) => void s.command('session:prune').everyFifteenMinutes()) });
    const store = scheduled.application.container.make(SessionStore);
    await store.write('e'.repeat(64), '{}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    await scheduled.send('/count');
    await scheduled.application.kernel.settle();
    expect(await store.gc(0)).toBe(1); // still there for session:prune
    // A schedule without it: the lottery as configured.
    const other = await boot({ SESSION_LOTTERY: '1/1' }, {}, { providers, schedule: defineSchedule((s) => void s.command('cache:prune').hourly()) });
    const otherStore = other.application.container.make(SessionStore);
    await otherStore.write('e'.repeat(64), '{}', { expectedVersion: undefined, lifetimeSeconds: -1 });
    await other.send('/count');
    await other.application.kernel.settle();
    expect(await otherStore.gc(0)).toBe(0);
  });

  it('keeps flash data through an asset-version reload (409)', async () => {
    const { send } = await boot({ SERVER_ASSET_VERSION: 'v2' }, { version: 'v2' });
    await send('/save', { method: 'POST' });
    const stale = await send('/count', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-version': 'v1' } });
    expect(stale.status).toBe(409);
    expect(await (await send('/count')).json()).toMatchObject({ status: 'Saved.' }); // still there after the reload
  });

  it('block(): requests of one session run one at a time — a read-modify-write keeps every increment', async () => {
    const { send } = await boot({}, {}, { providers: [CacheServiceProvider] });
    await send('/count'); // the session exists: visits 1
    const responses = await Promise.all(Array.from({ length: 5 }, () => send('/slow/blocked', { method: 'POST' })));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await (await send('/count')).json()).toMatchObject({ visits: 7 }); // 1 + 5 + this one
  });

  it('without block(): concurrent read-modify-writes of one key — the last write wins (the compare-and-set merges, it cannot add)', async () => {
    const { send } = await boot({}, {}, { providers: [CacheServiceProvider] });
    await send('/count');
    await Promise.all(Array.from({ length: 5 }, () => send('/slow', { method: 'POST' })));
    expect(((await (await send('/count')).json()) as { visits: number }).visits).toBeLessThan(7);
  });

  it('block(): busy longer than the route waits → 423 Locked; no cache → says what to install', async () => {
    const { send } = await boot({ LOG_LEVEL: 'silent' }, {}, { providers: [CacheServiceProvider] });
    await send('/count');
    const [held, refused] = await Promise.all([send('/slow/blocked', { method: 'POST' }), sleep(2).then(() => send('/slow/impatient', { method: 'POST' }))]);
    expect(held.status).toBe(200);
    expect(refused.status).toBe(423);
    expect(refused.headers.get('retry-after')).toBe('2');
    // A page request gets the error page — the session readable, never written.
    const [, page] = await Promise.all([send('/slow/blocked', { method: 'POST' }), sleep(2).then(() => send('/slow/impatient', { method: 'POST', headers: { accept: 'text/html' } }))]);
    expect(page.status).toBe(423);
    expect(page.headers.getSetCookie().filter((header) => header.startsWith('marmeon_session='))).toEqual([]);
    // Without a session cookie there is nothing to lock: a new session is nobody else's.
    const fresh = await boot({ LOG_LEVEL: 'silent' });
    expect((await fresh.send('/slow/blocked', { method: 'POST' })).status).toBe(200);
    const uncached = await boot({ LOG_LEVEL: 'silent' });
    await uncached.send('/count');
    const failed = await uncached.send('/slow/blocked', { method: 'POST' });
    expect(failed.status).toBe(500);
  });

  it('reads the cookie settings from the config', async () => {
    const { send } = await boot({ SESSION_COOKIE: 'shop_session', SESSION_LIFETIME_MINUTES: '30', SESSION_SECURE_COOKIE: 'true', SESSION_SAME_SITE: 'strict' });
    const cookie = (await send('/count')).headers.getSetCookie().find((header) => header.startsWith('__Host-shop_session='));
    expect(cookie).toMatch(/^__Host-shop_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
  });

  it('names the cookie with __Host- when Secure — Path=/, no Domain — and reads that name only', async () => {
    const { send } = await boot({ SESSION_SECURE_COOKIE: 'true' });
    const cookies = (await send('/count')).headers.getSetCookie();
    expect(cookies.find((header) => header.startsWith('marmeon_session='))).toBeUndefined();
    const cookie = cookies.find((header) => header.startsWith('__Host-marmeon_session='));
    expect(cookie).toMatch(/^__Host-marmeon_session=[\w-]+; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    expect(cookie).not.toMatch(/Domain/i);
    expect(sessionCookieName({ cookie: 'marmeon_session', secure: true })).toBe('__Host-marmeon_session');
    expect(sessionCookieName({ cookie: 'marmeon_session', secure: false })).toBe('marmeon_session');
  });

  it('sets no __Host- name without Secure (plain HTTP)', async () => {
    const { send } = await boot({ SESSION_SECURE_COOKIE: 'false' });
    const cookies = (await send('/count')).headers.getSetCookie();
    expect(cookies.some((header) => header.startsWith('marmeon_session='))).toBe(true);
    expect(cookies.some((header) => header.startsWith('__Host-'))).toBe(false);
  });

  describe('a stored session of another format', () => {
    const NEW = { expectedVersion: undefined, lifetimeSeconds: 600 };
    /** A browser with a session, and the store key it is kept under (the last key a write used). */
    async function withSession() {
      const app = await boot();
      const store = app.application.container.make(SessionStore);
      const keys: string[] = [];
      const write = store.write.bind(store);
      store.write = (key, data, options) => (keys.push(key), write(key, data, options));
      await app.send('/count');
      const key = keys.at(-1)!;
      const replace = async (data: object) => {
        await store.destroy(key);
        await store.write(key, JSON.stringify(data), NEW);
        return (await store.read(key))!;
      };
      return { ...app, store, key, replace };
    }

    it("of a newer format is a guest's request: the entry is not written, destroyed or replaced, and no cookie is sent", async () => {
      const { send, store, key, replace } = await withSession();
      const before = await replace({ visits: 40, status: 'kept', _v: 3 });
      const read = await send('/count');
      expect(await read.json()).toEqual({ visits: 1, status: null });
      expect(sessionCookie(read)).toBeUndefined();
      const flashed = await send('/save', { method: 'POST' });
      expect(flashed.status).toBe(303);
      expect(sessionCookie(flashed)).toBeUndefined();
      const failed = await send('/fail', { method: 'POST' });
      expect(failed.status).toBe(422);
      expect(sessionCookie(failed)).toBeUndefined();
      expect(await store.read(key)).toEqual(before); // byte-equal, same version
    });

    it('without a mark is dropped: a new session starts under a new cookie — the old entry is only left to expire', async () => {
      const { send, store, key, replace, cookieHeader } = await withSession();
      const before = await replace({ visits: 40, _auth_id: 1, _auth_password: 'x' });
      const oldCookie = cookieHeader();
      const response = await send('/count');
      expect(await response.json()).toEqual({ visits: 1, status: null });
      expect(sessionCookie(response)).toBeDefined();
      expect(cookieHeader()).not.toBe(oldCookie);
      expect(await store.read(key)).toEqual(before);
    });
  });
});
