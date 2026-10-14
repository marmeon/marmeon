import { createApplication, defineModule, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider, sessionKey, SessionStore } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { COMPLETE_PENDING, SIGN_IN_VERIFIED } from './auth.ts';
import { Auth, AUTH_SESSION_KEYS, AuthServiceProvider, DatabaseRememberTokens, DatabaseSignIns, Hasher, SIGN_INS_TABLE, SignInStore, TwoFactorState, UserProvider, type AuthUser, type Credentials, type PasswordHash, type SecondFactor } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

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

/** A second factor the test switches on and off. */
class Factors implements TwoFactorState {
  on = false;
  async factors(): Promise<readonly SecondFactor[]> {
    return this.on ? ['totp'] : [];
  }
  async enabledSince(): Promise<Date | undefined> {
    return undefined;
  }
}

/** Deletes every row just before the store continues one: a sign-in ended between the token check and the resume. */
class EndedMeanwhile extends DatabaseSignIns {
  override async resume(...args: Parameters<DatabaseSignIns['resume']>) {
    await this.end(1, (await this.list(1, { idleSeconds: 1e9, maxSeconds: 1e9 }))[0]!.id);
    return super.resume(...args);
  }
}

/** A store that cannot make a row. */
class CannotCreate extends DatabaseSignIns {
  override async create(): Promise<string> {
    throw new Error('store down');
  }
}

class Route extends Controller {
  readonly auth: Auth;
  readonly session: Session;
  constructor(auth: Auth, session: Session) {
    super();
    this.auth = auth;
    this.session = session;
  }
}

class LoginController extends Route {
  async handle(ctx: HttpContext) {
    const result = await this.auth.attempt(ada.email, 'secret', { remember: ctx.request.headers.get('x-remember') === 'yes' });
    return { ok: result.ok };
  }
}
class PendingController extends Route {
  async handle() {
    return { ok: (await this.auth.attempt(ada.email, 'secret')).ok };
  }
}
class CompleteController extends Route {
  async handle() {
    return { ok: (await this.auth[COMPLETE_PENDING](1)).ok };
  }
}
class PasskeyController extends Route {
  async handle() {
    return { ok: (await this.auth[SIGN_IN_VERIFIED](1)).ok };
  }
}
class LogoutController extends Route {
  async handle() {
    await this.auth.logout();
    return { ok: true };
  }
}
class WhoController extends Route {
  async handle() {
    return { id: (await this.auth.user())?.id ?? null, viaRemember: this.auth.viaRemember() };
  }
}
class IslandController extends Route {
  async handle() {
    this.session.lock(() => false); // an island's request: StartSession does this
    return { id: (await this.auth.user())?.id ?? null };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/pending', PendingController);
  Route.post('/complete', CompleteController);
  Route.post('/passkey', PasskeyController);
  Route.post('/logout', LogoutController);
  Route.get('/who', WhoController);
  Route.get('/island', IslandController);
});

async function boot(options: { signIns?: (new (...args: never[]) => SignInStore) | false; env?: Record<string, string> } = {}) {
  const users = new Users();
  const factors = new Factors();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...options.env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'sign-ins-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      container.instance(TwoFactorState, factors);
      if (options.signIns !== false) container.singleton(SignInStore, (options.signIns ?? DatabaseSignIns) as never);
    },
  });
  await application.container.make(Migrator).migrate();
  users.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  const store = application.container.make(SessionStore);
  const db = application.container.make(Connections).get<any>();
  const rows = () => db.selectFrom(SIGN_INS_TABLE).selectAll().execute() as Promise<{ id: string; user_agent: string | null; remember_selector: string | null; last_seen_at: string | Date }[]>;
  const tokens = async () => (await db.selectFrom('remember_tokens').selectAll().execute()).length as number;

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: init.method ?? (path === '/who' || path === '/island' ? 'GET' : 'POST'), headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', ...init.headers } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const who = async () => (await send('/who')).json() as Promise<{ id: number | null; viaRemember: boolean }>;
    const sessionKeyOf = async () => sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
    const stored = async () => JSON.parse((await store.read(await sessionKeyOf()))!.data) as Record<string, unknown>;
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const key = await sessionKeyOf();
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    /** A browser that kept only its remember-me cookie: the session is gone. */
    const reopened = () => browser(new Map([['remember_web', jar.get('remember_web')!]]));
    return { send, who, jar, stored, edit, reopened };
  };
  return { application, browser, rows, tokens, db, factors };
}

const login = (b: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>, remember = false) =>
  b.send('/login', { headers: { 'x-remember': remember ? 'yes' : 'no' } });

describe('sign-ins tracked by Auth', () => {
  it('without a bound store changes nothing: no key in the session, no row', async () => {
    const { browser, rows } = await boot({ signIns: false });
    const b = browser();
    await login(b, true);
    expect(await b.who()).toEqual({ id: 1, viaRemember: false });
    expect(AUTH_SESSION_KEYS.signIn in (await b.stored())).toBe(false);
    expect(await rows()).toEqual([]);
    expect(await b.reopened().who()).toEqual({ id: 1, viaRemember: true });
    expect(await rows()).toEqual([]);
    await b.send('/logout');
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('a password sign-in makes one row, which the session names', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b);
    const [row] = await rows();
    expect(await rows()).toHaveLength(1);
    expect(row).toMatchObject({ user_agent: 'Test Browser', remember_selector: null });
    expect((await b.stored())[AUTH_SESSION_KEYS.signIn]).toBe(row!.id);
    expect(await b.who()).toEqual({ id: 1, viaRemember: false });
  });

  it('a sign-in over a sign-in leaves no orphan row', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b);
    const [first] = await rows();
    await login(b);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).not.toBe(first!.id);
  });

  it('a second factor makes the row when it is proven, not when the password is typed', async () => {
    const { browser, rows, factors } = await boot();
    const b = browser();
    await login(b); // a sign-in already: the password step of a second sign-in must end its row
    factors.on = true;
    await b.send('/pending');
    expect(await rows(), 'a held sign-in has no row, and the old one is gone').toEqual([]);
    expect(await b.who()).toMatchObject({ id: null });
    factors.on = false;
    await b.send('/complete');
    expect(await rows()).toHaveLength(1);
    expect(await b.who()).toMatchObject({ id: 1 });
  });

  it('a password sign-in taken back by a factor that appeared meanwhile leaves no row', async () => {
    const { browser, rows, factors } = await boot();
    let reads = 0;
    const original = factors.factors.bind(factors);
    factors.factors = async () => (++reads >= 2 ? ['totp'] : original());
    const b = browser();
    expect((await login(b, true)).status).toBe(200);
    expect(await rows()).toEqual([]);
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('a passkey sign-in makes a row', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await b.send('/passkey');
    expect(await rows()).toHaveLength(1);
    expect(await b.who()).toMatchObject({ id: 1 });
  });

  it('a remember-me sign-in continues the row of its token: one browser, one entry', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b, true);
    const [row] = await rows();
    expect(row!.remember_selector).toMatch(/^[\w-]{22}$/);
    const back = b.reopened();
    expect(await back.who()).toEqual({ id: 1, viaRemember: true });
    expect((await rows()).map((each) => each.id)).toEqual([row!.id]);
    expect((await back.stored())[AUTH_SESSION_KEYS.signIn]).toBe(row!.id);
  });

  it('a request whose row is gone is a guest — and its remember-me cookie does not sign in again, its token is gone', async () => {
    const { browser, rows, tokens, db } = await boot();
    const b = browser();
    await login(b, true);
    expect(await b.who()).toMatchObject({ id: 1 });
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
    expect(await rows()).toEqual([]);
    expect(await tokens()).toBe(0);
    expect(b.jar.has('remember_web')).toBe(false);
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('a row ended without remember-me ends the session in a driver that cannot list sessions (file)', async () => {
    const files = tempDir('marmeon-sign-ins');
    const { browser, db } = await boot({ env: { SESSION_DRIVER: 'file', SESSION_FILES: files } });
    const b = browser();
    await login(b);
    expect(await b.who()).toMatchObject({ id: 1 });
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    expect(await b.who()).toMatchObject({ id: null });
  });

  it('a remember-me token without a row (made before sign-ins were switched on) signs nobody in and is forgotten', async () => {
    const { browser, db, rows, tokens } = await boot();
    const b = browser();
    await login(b, true);
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    const back = b.reopened();
    expect(await back.who()).toEqual({ id: null, viaRemember: false });
    expect(await tokens()).toBe(0);
    expect(await rows(), 'a refused token creates no row').toEqual([]);
  });

  it('a sign-in ended between the token check and the continuation is refused', async () => {
    const { browser, rows, tokens } = await boot({ signIns: EndedMeanwhile });
    const b = browser();
    await login(b, true);
    expect(await b.reopened().who()).toEqual({ id: null, viaRemember: false });
    expect(await rows()).toEqual([]);
    expect(await tokens()).toBe(0);
  });

  it('a session from before sign-ins were switched on gets its row at the next request', async () => {
    const { browser, rows, db } = await boot();
    const b = browser();
    await login(b);
    await b.edit((data) => delete data[AUTH_SESSION_KEYS.signIn]);
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    expect(await b.who()).toMatchObject({ id: 1 });
    expect((await b.stored())[AUTH_SESSION_KEYS.signIn]).toBe((await rows()).at(-1)!.id);
  });

  it('a session whose key is there but whose row was never made is not given a new one', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b);
    await b.edit((data) => (data[AUTH_SESSION_KEYS.signIn] = 'A'.repeat(22)));
    expect(await b.who()).toMatchObject({ id: null });
    expect(await rows(), 'the old row stays, nothing new is made').toHaveLength(1);
  });

  it('an island (read-only request) makes no row and touches none, but a gone row makes it a guest', async () => {
    const { browser, rows, db } = await boot();
    const b = browser();
    await login(b);
    await b.edit((data) => delete data[AUTH_SESSION_KEYS.signIn]);
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    expect(await (await b.send('/island')).json()).toEqual({ id: 1 }); // from before the switch: let it be
    expect(await rows()).toEqual([]);

    const old = browser();
    await login(old);
    const stale = new Date(Date.now() - 3_600_000);
    await db.updateTable(SIGN_INS_TABLE).set({ last_seen_at: stale }).execute();
    expect(await (await old.send('/island')).json()).toEqual({ id: 1 });
    expect(new Date((await rows())[0]!.last_seen_at).getTime(), 'an island does not touch the row').toBe(stale.getTime());

    const c = browser();
    await login(c);
    await db.deleteFrom(SIGN_INS_TABLE).execute();
    expect(await (await c.send('/island')).json()).toEqual({ id: null });
    expect(await rows()).toEqual([]);
  });

  it('a store that cannot make the row leaves nobody signed in, and no remember-me token', async () => {
    const { browser, tokens } = await boot({ signIns: CannotCreate });
    const b = browser();
    expect((await login(b, true)).status).toBe(500);
    expect(await b.who()).toEqual({ id: null, viaRemember: false });
    expect(await tokens()).toBe(0);
    expect(b.jar.has('remember_web')).toBe(false);
  });

  it('a password sign-in drops the remember-me token a guest carries, so two rows never stay alive', async () => {
    const { browser, tokens } = await boot();
    const first = browser();
    await login(first, true);
    const guest = first.reopened();
    await login(guest, false);
    expect(await tokens()).toBe(0);
    expect(guest.jar.has('remember_web')).toBe(false);
  });

  it('logout signs out although the store cannot end the row', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b);
    const original = DatabaseSignIns.prototype.end;
    DatabaseSignIns.prototype.end = async () => {
      throw new Error('store down');
    };
    try {
      expect((await b.send('/logout')).status).toBe(200);
    } finally {
      DatabaseSignIns.prototype.end = original;
    }
    expect(await b.who()).toMatchObject({ id: null });
    expect(await rows()).toHaveLength(1); // left for prune
  });

  it('logout whose token cannot be removed still signs out for good: the row is gone, so the cookie signs nobody in', async () => {
    const { browser, rows } = await boot();
    const b = browser();
    await login(b, true);
    const original = DatabaseRememberTokens.prototype.forget;
    DatabaseRememberTokens.prototype.forget = async () => {
      throw new Error('store down');
    };
    try {
      await b.send('/logout');
    } finally {
      DatabaseRememberTokens.prototype.forget = original;
    }
    expect(await rows()).toEqual([]);
    expect(await b.who()).toMatchObject({ id: null });
    expect(await b.reopened().who()).toMatchObject({ id: null });
  });

  it('logout ends the row, and the remember-me token with it', async () => {
    const { browser, rows, tokens } = await boot();
    const b = browser();
    await login(b, true);
    await login(browser(), false); // another browser stays
    expect(await rows()).toHaveLength(2);
    await b.send('/logout');
    expect(await rows()).toHaveLength(1);
    expect(await tokens()).toBe(0);
    expect(await b.who()).toMatchObject({ id: null });
  });
});
