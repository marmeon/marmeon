import { createApplication, defineModule, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider, sessionKey, SessionStore } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth, AuthConfig, AuthServiceProvider, Hasher, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const HOUR = 3_600_000;

class Users implements UserProvider {
  hash: PasswordHash | null = null;
  async findById(): Promise<Credentials | undefined> {
    return { user: ada, passwordHash: this.hash };
  }
  async findForLogin(): Promise<Credentials | undefined> {
    return { user: ada, passwordHash: this.hash };
  }
  async updatePasswordHash(): Promise<void> {}
}

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    await this.#auth.attempt(ada.email, 'secret', { remember: ctx.request.headers.get('x-remember') !== 'no' });
    return { ok: true };
  }
}

class WhoController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { id: (await this.#auth.user())?.id ?? null, viaRemember: this.#auth.viaRemember() };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.get('/who', WhoController);
});

async function boot(env: Record<string, string> = {}) {
  const users = new Users();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'session-lifetime-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
    },
  });
  await application.container.make(Migrator).migrate();
  users.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  const store = application.container.make(SessionStore);

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: init.method ?? 'GET', headers: { cookie, accept: 'application/json', ...init.headers } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const who = async (headers?: Record<string, string>) => (await send('/who', headers ? { headers } : {})).json() as Promise<{ id: number | null; viaRemember: boolean }>;
    /** The stored session of this browser: read and rewritten by hand, as a store from before an upgrade would hold it. */
    const sessionKeyOf = async () => sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
    const stored = async () => JSON.parse((await store.read(await sessionKeyOf()))!.data) as Record<string, unknown>;
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const key = await sessionKeyOf();
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    return { send, who, jar, stored, edit };
  };
  const setTokenEnd = (inMs: number) =>
    application.container.make(Connections).get<any>().updateTable('remember_tokens').set({ expires_at: new Date(Date.now() + inMs) }).execute();
  return { application, browser, setTokenEnd };
}

const signIn = (b: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>, remember = true) =>
  b.send('/login', { method: 'POST', headers: { 'x-remember': remember ? 'yes' : 'no' } });

describe('the absolute lifetime of a sign-in', () => {
  afterEach(() => vi.useRealTimers());

  it('ends a sign-in 24 hours after it began, though the user was active every hour', async () => {
    const { browser } = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const b = browser();
    await signIn(b, false);
    for (let hour = 1; hour <= 23; hour++) {
      vi.setSystemTime(Date.now() + HOUR);
      expect(await b.who()).toMatchObject({ id: 1 });
    }
    vi.setSystemTime(Date.now() + HOUR + 60_000);
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
  });

  it('follows AUTH_SESSION_MAX_HOURS', async () => {
    const { browser } = await boot({ AUTH_SESSION_MAX_HOURS: '2' });
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const b = browser();
    await signIn(b, false);
    vi.setSystemTime(Date.now() + HOUR);
    expect(await b.who()).toMatchObject({ id: 1 });
    vi.setSystemTime(Date.now() + HOUR + 60_000);
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('signs in again in the same request from a valid remember-me cookie, with a new clock and a rotated cookie', async () => {
    const { browser } = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const b = browser();
    await signIn(b);
    const before = b.jar.get('remember_web');
    const start = Date.now();
    for (let hour = 1; hour <= 23; hour++) {
      vi.setSystemTime(start + hour * HOUR);
      await b.who();
    }
    vi.setSystemTime(start + 24 * HOUR + 60_000);
    expect(await b.who()).toEqual({ id: 1, viaRemember: true });
    expect(b.jar.get('remember_web')).not.toBe(before);
    expect((await b.stored())[AUTH_SESSION_KEYS.signedInAt]).toBe(Math.floor(Date.now() / 1000));
  });

  it('ends a session restored by remember-me no later than its token, however active', async () => {
    const { browser, setTokenEnd } = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const laptop = browser();
    await signIn(laptop);
    await setTokenEnd(2 * HOUR);
    const reopened = browser(new Map([['remember_web', laptop.jar.get('remember_web')!]]));
    expect(await reopened.who()).toEqual({ id: 1, viaRemember: true });
    vi.setSystemTime(Date.now() + HOUR);
    expect(await reopened.who()).toMatchObject({ id: 1 });
    vi.setSystemTime(Date.now() + HOUR + 60_000);
    expect(await reopened.who()).toEqual({ id: null, viaRemember: false });
  });

  it('starts the clock of a session from before the upgrade at its next request', async () => {
    const { browser } = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const b = browser();
    await signIn(b);
    await b.edit((data) => delete data[AUTH_SESSION_KEYS.signedInAt]);
    expect(await b.who()).toMatchObject({ id: 1 });
    expect((await b.stored())[AUTH_SESSION_KEYS.signedInAt]).toBe(Math.floor(Date.now() / 1000));
  });

  it.each([
    ['unreadable', () => 'x'],
    ['not finite', () => null],
    ['in the future', () => Math.floor(Date.now() / 1000) + 3600],
  ])('ends a session whose sign-in time is %s', async (_name, value) => {
    const { browser } = await boot({ AUTH_REMEMBER_DAYS: '0' });
    const b = browser();
    await signIn(b);
    await b.edit((data) => (data[AUTH_SESSION_KEYS.signedInAt] = value()));
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
  });

  it('allows a minute of clock skew between servers, and no more', async () => {
    const { browser } = await boot({ AUTH_REMEMBER_DAYS: '0' });
    const b = browser();
    await signIn(b);
    await b.edit((data) => (data[AUTH_SESSION_KEYS.signedInAt] = Math.floor(Date.now() / 1000) + 30));
    expect(await b.who()).toMatchObject({ id: 1 });
    await b.edit((data) => (data[AUTH_SESSION_KEYS.signedInAt] = Math.floor(Date.now() / 1000) + 120));
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('ends a session of before the update whose remember-me end is over', async () => {
    const { browser } = await boot({ AUTH_REMEMBER_DAYS: '0' });
    const b = browser();
    await signIn(b);
    await b.edit((data) => {
      delete data[AUTH_SESSION_KEYS.signedInAt];
      data[AUTH_SESSION_KEYS.rememberUntil] = Math.floor(Date.now() / 1000) - 5;
    });
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
  });

  it('lets an island see a session of before the update, writes nothing, and the page request sets the clock', async () => {
    const { browser } = await boot({ AUTH_REMEMBER_DAYS: '0' });
    const b = browser();
    await signIn(b);
    await b.edit((data) => delete data[AUTH_SESSION_KEYS.signedInAt]);
    const stored = await b.stored();
    expect(await b.who({ [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' })).toMatchObject({ id: 1 });
    expect(await b.stored()).toEqual(stored);
    expect(await b.who()).toMatchObject({ id: 1 });
    expect((await b.stored())[AUTH_SESSION_KEYS.signedInAt]).toBe(Math.floor(Date.now() / 1000));
  });

  it('ends a session whose remember-me end is unreadable', async () => {
    const { browser } = await boot({ AUTH_REMEMBER_DAYS: '0' });
    const b = browser();
    await signIn(b);
    await b.edit((data) => (data[AUTH_SESSION_KEYS.rememberUntil] = 'x'));
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
  });

  it('leaves a read-only request with an over sign-in a guest: nothing written, the remember-me token not consumed', async () => {
    const { browser } = await boot();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const b = browser();
    await signIn(b);
    const cookie = b.jar.get('remember_web');
    // An island's request: read-only, it sees the session as the page left it.
    const island = { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' };
    expect(await b.who(island)).toEqual({ id: 1, viaRemember: false });
    await b.edit((data) => (data[AUTH_SESSION_KEYS.signedInAt] = Math.floor(Date.now() / 1000) - 25 * 3600));
    const stored = await b.stored();
    expect(await b.who(island)).toEqual({ id: null, viaRemember: false });
    expect(b.jar.get('remember_web')).toBe(cookie);
    expect(await b.stored()).toEqual(stored);
    expect(await b.who()).toEqual({ id: 1, viaRemember: true }); // the page's request signs in, with the token still unused
  });

  it('refuses 721 hours at boot and defaults to 24', async () => {
    await expect(boot({ AUTH_SESSION_MAX_HOURS: '721' })).rejects.toThrow(/AUTH_SESSION_MAX_HOURS/);
    await expect(boot({ AUTH_SESSION_MAX_HOURS: '0' })).rejects.toThrow(/AUTH_SESSION_MAX_HOURS/);
    expect((await boot()).application.container.make(AuthConfig).sessionMaxSeconds).toBe(86_400);
  });
});
