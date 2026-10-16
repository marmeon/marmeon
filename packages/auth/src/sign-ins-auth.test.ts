import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionEndings, SessionServiceProvider, sessionKey, SessionStore } from '@marmeon/session';
import { accountScope } from '@marmeon/session/internal';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { COMPLETE_PENDING, SIGN_IN_VERIFIED, AUTH_SESSION_KEYS } from './auth.ts';
import { NewPassword } from './new-password.ts';
import { AccountSessions, Auth, PasswordChanged, AuthServiceProvider, RememberTokenStore, DatabaseRememberTokens, DatabaseSignIns, Hasher, SignInStore, TwoFactorState, UserProvider, type AuthUser, type Credentials, type PasswordHash, type SecondFactor } from './index.ts';
import { SIGN_INS_TABLE } from './sign-ins.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const bob: AuthUser = { id: 2, name: 'Bob', email: 'bob@example.com' };

class Users implements UserProvider {
  hash: PasswordHash | null = null;
  readonly keys = new Map<number, string | null>();
  async findById(id: number): Promise<Credentials | undefined> {
    const user = id === 2 ? bob : id === 1 ? ada : undefined;
    return user && { user, passwordHash: this.hash, sessionKey: this.keys.get(id) ?? null };
  }
  async findForLogin(email: string): Promise<Credentials | undefined> {
    return this.findById(email === bob.email ? 2 : 1);
  }
  async updatePasswordHash(_id: unknown, hash: PasswordHash): Promise<void> {
    this.hash = hash;
  }
  async updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    if (expected !== undefined && (this.keys.get(id) ?? null) !== expected) return false;
    this.keys.set(id, key);
    return true;
  }
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
  async removeAll(): Promise<void> {}
}

/** Deletes every row just before the store continues one: a sign-in ended between the token check and the resume. */
class EndedMeanwhile extends DatabaseSignIns {
  override async resume(...args: Parameters<DatabaseSignIns['resume']>) {
    await this.end(1, (await this.list(1, { idleSeconds: 1e9, maxSeconds: 1e9 }))[0]!.id);
    return super.resume(...args);
  }
}

class RecordPasswordChanged {
  static count = 0;
  handle() {
    RecordPasswordChanged.count++;
  }
}

/** A store that cannot end the rows of the other devices. */
class CannotEndAll extends DatabaseSignIns {
  override async endAll(): Promise<number> {
    throw new Error('store down');
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
    const result = await this.auth.attempt(ctx.request.headers.get('x-user') ?? ada.email, 'secret', { remember: ctx.request.headers.get('x-remember') === 'yes' });
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
class ListController extends Route {
  async handle() {
    return (await this.auth.signIns()).map((signIn) => ({ ...signIn, signedInAt: undefined, lastSeenAt: undefined, createdAt: undefined }));
  }
}
/** Thrown to roll a transaction back after the action ran in it. */
class RolledBack {
  readonly answer: Record<string, unknown>;
  constructor(answer: Record<string, unknown>) {
    this.answer = answer;
  }
}
let connectionsOfTest: Connections;

/** Runs one `Auth` method named by the path and reports what it answered, or what it threw — in a transaction that rolls back, with `x-rollback`. */
class ActController extends Route {
  async handle(ctx: HttpContext) {
    if (ctx.request.headers.get('x-rollback') !== 'yes') return this.#act(ctx);
    try {
      return await connectionsOfTest.transaction(async () => {
        throw new RolledBack(await this.#act(ctx));
      });
    } catch (error) {
      if (error instanceof RolledBack) return error.answer;
      throw error;
    }
  }

  async #act(ctx: HttpContext): Promise<Record<string, unknown>> {
    const [action, id] = [ctx.request.headers.get('x-action'), ctx.request.headers.get('x-id') ?? ''];
    try {
      switch (action) {
        case 'end': {
          const result = await this.auth.endSignIn(id);
          return result.ok ? { ok: true } : { error: result.error.kind };
        }
        case 'confirm':
          return { ok: await this.auth.confirmPassword('secret') };
        case 'password':
          await this.auth.updatePassword('new password');
          return { ok: true };
        case 'others':
          return { ok: await this.auth.logoutOtherDevices('secret') };
        case 'key':
          return { ok: await this.auth.updateSessionKey() };
        default:
          return { error: 'unknown' };
      }
    } catch (error) {
      return { threw: (error as Error).message };
    }
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
  Route.get('/list', ListController);
  Route.post('/act', ActController);
});

async function boot(options: { signIns?: (new (...args: never[]) => SignInStore) | false; env?: Record<string, string> } = {}) {
  const users = new Users();
  const factors = new Factors();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...options.env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'sign-ins-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url), listeners: [listen(PasswordChanged, RecordPasswordChanged)] })],
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
  connectionsOfTest = application.container.make(Connections);
  const db = application.container.make(Connections).get<any>();
  const rows = () => db.selectFrom(SIGN_INS_TABLE).selectAll().execute() as Promise<{ id: string; user_agent: string | null; remember_selector: string | null; last_seen_at: string | Date }[]>;
  const tokens = async () => (await db.selectFrom('remember_tokens').selectAll().execute()).length as number;

  const browser = (jar: Map<string, string> = new Map()) => {
    const send = async (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: init.method ?? (path === '/who' || path === '/island' || path === '/list' ? 'GET' : 'POST'), headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', ...init.headers } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const act = async (action: string, id = '', rollback = false) => (await send('/act', { headers: { 'x-action': action, 'x-id': id, ...(rollback ? { 'x-rollback': 'yes' } : {}) } })).json() as Promise<Record<string, unknown>>;
    const list = async () => (await send('/list')).json() as Promise<{ id: string; current: boolean; remembered: boolean; userAgent: string | undefined; device: { browser: string | undefined; system: string | undefined } }[]>;
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
    return { send, who, act, list, jar, stored, edit, reopened };
  };
  return { application, browser, rows, tokens, db, factors, users };
}

const login = (b: ReturnType<Awaited<ReturnType<typeof boot>>['browser']>, remember = false, user: string = ada.email) =>
  b.send('/login', { headers: { 'x-remember': remember ? 'yes' : 'no', 'x-user': user } });

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

  describe('the live streams of the account are told', () => {
    async function twoBrowsers() {
      const booted = await boot();
      const heard = vi.fn();
      booted.application.container.make(SessionEndings).listenAccounts(heard);
      const laptop = booted.browser();
      const phone = booted.browser();
      await login(laptop);
      await login(phone);
      await laptop.act('confirm');
      return { ...booted, heard, laptop, phone };
    }

    it('after the commit — an ended sign-in, a new password, signing out the other devices, a new session key — once each', async () => {
      const { heard, laptop, phone } = await twoBrowsers();
      const [other] = (await laptop.list()).filter((entry) => !entry.current);
      await laptop.act('end', other!.id);
      expect(heard.mock.calls).toEqual([[accountScope(1)]]);
      await laptop.act('others');
      await laptop.act('key');
      await laptop.act('password');
      expect(heard).toHaveBeenCalledTimes(4);
      expect(await phone.who()).toMatchObject({ id: null });
    });

    it('not when the transaction around the change rolls back — the change never happened', async () => {
      const { heard, laptop, users } = await twoBrowsers();
      const [other] = (await laptop.list()).filter((entry) => !entry.current);
      const hash = users.hash;
      for (const [action, id] of [['end', other!.id], ['password', ''], ['others', ''], ['key', '']] as const) {
        users.hash = hash;
        await laptop.act(action, id, true);
      }
      expect(heard).not.toHaveBeenCalled();
    });
  });

  describe('listing and ending sign-ins', () => {
    it('lists every browser of the user, the asking one first and marked, with what the user agent says', async () => {
      const { browser } = await boot();
      const laptop = browser();
      const phone = browser();
      await login(laptop);
      await login(phone, true);
      const seenByLaptop = await laptop.list();
      expect(seenByLaptop).toHaveLength(2);
      expect(seenByLaptop.map((signIn) => signIn.current)).toEqual([true, false]);
      expect(seenByLaptop[1]!.remembered).toBe(true);
      expect(seenByLaptop[0]).toMatchObject({ remembered: false, userAgent: 'Test Browser', device: {} }); // undefined parts are left out of the JSON
      const seenByPhone = await phone.list();
      expect(seenByPhone.map((signIn) => signIn.current)).toEqual([true, false]);
      expect(seenByPhone[0]!.id).toBe(seenByLaptop[1]!.id);
    });

    it('signs a browser out when its sign-in is ended — its remember-me cookie included', async () => {
      const { browser, tokens } = await boot();
      const laptop = browser();
      const phone = browser();
      await login(laptop);
      await login(phone, true);
      await laptop.act('confirm');
      const other = (await laptop.list()).find((signIn) => !signIn.current)!;
      expect(await laptop.act('end', other.id)).toEqual({ ok: true });
      expect(await phone.who()).toMatchObject({ id: null });
      expect(await phone.reopened().who(), 'the cookie signs nobody in').toMatchObject({ id: null });
      expect(await tokens()).toBe(0);
      expect(await laptop.who()).toMatchObject({ id: 1 });
      expect(await laptop.list()).toHaveLength(1);
    });

    it("cannot end another user's sign-in: it answers missing, and that session lives on", async () => {
      const { browser, rows } = await boot();
      const ada1 = browser();
      const bob1 = browser();
      await login(ada1);
      await login(bob1, false, bob.email);
      await ada1.act('confirm');
      const adasId = (await ada1.list())[0]!.id;
      const bobsRow = (await rows()).find((row) => row.id !== adasId)!;
      expect(await ada1.act('end', bobsRow.id)).toEqual({ error: 'missing' });
      expect(await ada1.act('end', 'A'.repeat(22)), 'unknown looks the same').toEqual({ error: 'missing' });
      expect(await bob1.who()).toMatchObject({ id: 2 });
      expect(await rows()).toHaveLength(2);
    });

    it('needs a recently typed password, and ends nothing without it', async () => {
      const { browser, rows } = await boot();
      const laptop = browser();
      const phone = browser();
      await login(laptop);
      await login(phone);
      await laptop.edit((data) => delete data[AUTH_SESSION_KEYS.confirmedAt]);
      const other = (await laptop.list()).find((signIn) => !signIn.current)!;
      expect(await laptop.act('end', other.id)).toEqual({ threw: expect.stringContaining('recent confirmation') });
      expect(await rows()).toHaveLength(2);
      expect(await phone.who()).toMatchObject({ id: 1 });
    });

    it('refuses to end its own sign-in (that is logout) and a malformed id', async () => {
      const { browser, rows } = await boot();
      const b = browser();
      await login(b);
      const [own] = await b.list();
      expect(await b.act('end', own!.id)).toEqual({ error: 'current' });
      expect(await b.act('end', '../x')).toEqual({ error: 'missing' });
      expect(await rows()).toHaveLength(1);
    });

    it('throws, naming the remedy, without a bound store', async () => {
      const { browser } = await boot({ signIns: false });
      const b = browser();
      await login(b);
      expect(await (await b.send('/act', { headers: { 'x-action': 'end', 'x-id': 'A'.repeat(22) } })).json()).toEqual({ threw: expect.stringContaining('SignInStore') });
    });

    it('leaves out sign-ins older than the absolute lifetime, unless a remember-me cookie keeps them', async () => {
      const { browser, db } = await boot();
      const laptop = browser();
      const old = browser();
      const kept = browser();
      await login(laptop);
      await login(old);
      await login(kept, true);
      const longAgo = new Date(Date.now() - 48 * 3_600_000);
      await db.updateTable(SIGN_INS_TABLE).set({ signed_in_at: longAgo }).where('remember_selector', 'is', null).where('user_agent', 'is not', null).execute();
      const listed = await laptop.list();
      expect(listed.map((signIn) => signIn.remembered), 'the old rows are gone from the list, the remembered one stays').toEqual([true]);
    });

    it('takes every other row off the list after a new password, signing out the others, or a new session key', async () => {
      for (const action of ['password', 'others', 'key']) {
        const { browser, rows } = await boot();
        const laptop = browser();
        await login(laptop, true);
        await login(browser());
        await login(browser(), true);
        expect(await rows()).toHaveLength(3);
        await laptop.act('confirm');
        expect(await laptop.act(action)).toMatchObject({ ok: true });
        const left = await rows();
        expect(left, action).toHaveLength(1);
        expect(left[0]!.id).toBe((await laptop.list())[0]!.id);
        expect(await laptop.who(), action).toMatchObject({ id: 1 });
      }
    });

    it('a store that cannot end the other rows does not fail a password change that was stored: the event still fires', async () => {
      const { browser, users } = await boot({ signIns: CannotEndAll });
      const b = browser();
      await login(b);
      const before = RecordPasswordChanged.count;
      expect(await b.act('password')).toEqual({ ok: true });
      expect(RecordPasswordChanged.count).toBe(before + 1);
      expect(users.hash).not.toBeNull();
      expect(await b.act('key')).toEqual({ ok: true });
    });

    it('a refused remember-me token takes its row off the list, not only its token', async () => {
      const { browser, rows, db } = await boot();
      const b = browser();
      await login(b, true);
      // Past AUTH_REMEMBER_DAYS from its creation: refused, though the row still says "remembered".
      await db.updateTable('remember_tokens').set({ created_at: new Date(Date.now() - 400 * 86_400_000) }).execute();
      expect(await b.reopened().who()).toMatchObject({ id: null });
      expect(await rows()).toEqual([]);
    });

    it('keeps no row for this device after a password change took its remember-me token', async () => {
      const { browser, rows } = await boot();
      const laptop = browser();
      await login(laptop, true);
      await laptop.act('confirm');
      await laptop.act('password');
      expect((await rows())[0]!.remember_selector).toBeNull();
      expect((await laptop.list())[0]!.remembered).toBe(false);
    });

    it('AccountSessions.end() takes every row of the account, and only its rows', async () => {
      const { browser, rows, application } = await boot();
      await login(browser());
      await login(browser(), true);
      const other = browser();
      await login(other, false, bob.email);
      expect((await application.container.make(AccountSessions).end(1 as never)).ok).toBe(true);
      expect(await rows()).toHaveLength(1);
      expect(await other.who()).toMatchObject({ id: 2 });
    });

    it('a password reset takes every row of the account', async () => {
      const { browser, rows, application, users } = await boot();
      await login(browser());
      await login(browser(), true);
      await login(browser(), false, bob.email);
      const container = application.container;
      await container.make(NewPassword).store(users, container.make(RememberTokenStore), 1, 'x' as never, 'reset');
      expect((await rows()).map((row) => row.id)).toHaveLength(1);
    });

    it('a password sign-in with remember-me replaces the old row of the device: the old one leaves the list', async () => {
      const { browser, rows } = await boot();
      const first = browser();
      await login(first, true);
      const guest = first.reopened();
      expect((await rows())).toHaveLength(1);
      await login(guest, true);
      const after = await rows();
      expect(after).toHaveLength(1);
      expect((await guest.list())).toHaveLength(1);
    });
  });
});
