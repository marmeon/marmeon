import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { Container, createApplication, defineModule, EventRegistry, Logger, Redactor, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { Encrypter, EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { GLOBAL, Router, RouteAccessError, type RouteDefinitions } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionConfig, SessionServiceProvider, SessionStore, sessionKey } from '@marmeon/session';
import { ensuresOf } from '@marmeon/router/internal';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineGuard, guardRegistry, type GuardAuth, type GuardTwoFactor } from './define-guard.ts';
import { bootGuardSlots, defineGuardSlot, isGuardSlot, slotBindings } from './guard-slot.ts';
import { GuardSlotError, SlotBindings } from './slot-bindings.ts';
import * as appEvents from './events.ts';
import { ResetTwoFactorCommand } from './reset-two-factor.ts';
import { policyGuard } from './policy-guard.ts';
import { AccessTokenStore, Auth, AuthServiceProvider, authenticate, can, Gate, Hasher, TwoFactorState, TwoFactorStore, UserProvider, type AuthUser } from './index.ts';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { guardNames } from './guard-names.ts';
import { twoFactorCode } from './testing.ts';
import { RequestGuard, routeGuardOf, stampRoutes } from './request-guard.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';
import { accessTokenStore } from './test-helpers/stores.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
import { MemoryUsers } from './test-helpers/users.ts';

/** What the package knows of its users: the least it needs. */
interface EditorUser {
  readonly id: number;
  readonly name: string;
}
interface OfficeUser extends EditorUser {
  readonly email: string;
}
interface Page {
  readonly editor_id: number;
}

// The same id 1 in both tables: only the binding tells the app's user and the office's apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 100 } });
// Never registered by any provider.
const GhostGuard = defineGuard('ghost', { users: OfficeUsers, tablePrefix: 'ghost_', twoFactor: TwoFactor });
/** Registered by a provider listed after the auth provider, in its register(). */
const LateGuard = defineGuard('late', { users: OfficeUsers, tablePrefix: 'late_', twoFactor: TwoFactor });
/** Registered in the boot() of a provider that boots before the auth provider, or after it (an error). */
const BootGuard = defineGuard('booted', { users: OfficeUsers, tablePrefix: 'booted_', twoFactor: TwoFactor });
const EditorSlot = defineGuardSlot<EditorUser>('editor', { twoFactor: true });
/** A second slot of the package, for a test that binds two slots to one target. */
const SecondSlot = defineGuardSlot<EditorUser>('second');
const EDITOR = { loginRoute: 'editor.login', homeRoute: 'editor.home', confirmRoute: 'editor.confirm' } as const;
const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const FACTOR = { setup: 'editor.setup', verify: 'editor.verify' } as const;
const PAGE: Page = { editor_id: 1 };

/** What the package binds its slot to in this test; `none` is a package that forgot. */
let mode: 'office' | 'web' | 'none' | 'ghost' | 'boot' | 'late-ghost' | 'late-registered' | 'early-boot' | 'late-boot' | 'twice' | 'late-office' | 'two-slots' = 'office';

/** A provider that boots before the auth provider's boot. */
class EarlyProvider implements ServiceProvider {
  boot(application: { container: Container }): void {
    if (mode === 'early-boot') BootGuard.register(application.container);
  }
}

/** A provider that registers and boots after the auth provider. */
class LateProvider implements ServiceProvider {
  register(container: Container): void {
    if (mode === 'late-registered') LateGuard.register(container);
    if (mode === 'twice') BootGuard.register(container);
  }

  boot(application: { container: Container }): void {
    if (mode === 'late-ghost') EditorSlot.bind(application.container, GhostGuard);
    if (mode === 'late-office') EditorSlot.bind(application.container, OfficeGuard);
    if (mode === 'late-registered') EditorSlot.bind(application.container, LateGuard);
    if (mode === 'late-boot' || mode === 'twice') BootGuard.register(application.container);
  }
}

class PackageProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
    if (mode === 'office') EditorSlot.bind(container, OfficeGuard);
    if (mode === 'web') EditorSlot.bind(container, 'web');
    if (mode === 'ghost') EditorSlot.bind(container, GhostGuard);
    if (mode === 'two-slots') {
      EditorSlot.bind(container, OfficeGuard);
      SecondSlot.bind(container, OfficeGuard);
    }
  }

  boot(application: { container: Container }): void {
    if (mode === 'boot') EditorSlot.bind(application.container, OfficeGuard);
  }
}

/** Which users each policy saw; fresh classes per test (one warning per class). */
function policies() {
  const seen = { page: [] as EditorUser[], built: 0 };
  class PagePolicy {
    static readonly guard = EditorSlot;
    constructor() {
      seen.built++;
    }
    edit(user: EditorUser, page: Page) {
      seen.page.push(user);
      return page.editor_id === user.id;
    }
  }
  return { seen, PagePolicy };
}
type Policies = ReturnType<typeof policies>;
let current: Policies;

/** The guard of the route as the first middleware saw it, by path. */
const stamps: Record<string, string | undefined> = {};

class ProbeStamp {
  static readonly inject = [RequestGuard] as const;
  readonly #request: RequestGuard;
  constructor(request: RequestGuard) {
    this.#request = request;
  }
  handle(ctx: HttpContext, next: () => Promise<Response>) {
    stamps[new URL(ctx.request.url).pathname] = this.#request.name;
    return next();
  }
}

class ProbeProvider implements ServiceProvider {
  boot(application: { container: Container }): void {
    application.container.make(Router).middleware.append(GLOBAL, ProbeStamp as never);
  }
}

class Ask extends Controller {
  static readonly inject = [Gate] as const;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }
  async handle(ctx: HttpContext) {
    const how = ctx.request.headers.get('x-how') ?? 'allows';
    const Class = current.PagePolicy as never;
    try {
      if (how === 'allows') return { allowed: await this.#gate.allows(Class, 'edit' as never, PAGE as never) };
      if (how === 'authorize') {
        await this.#gate.authorize(Class, 'edit' as never, PAGE as never);
        return { allowed: true };
      }
      if (how === 'abilities') return { can: await this.#gate.abilities(PAGE as never, Class, ['edit'] as never) };
      return { rows: await this.#gate.withAbilities([PAGE] as never, Class, ['edit'] as never) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

/** The signed-in user of the slot, as a controller of the package sees it. */
class Who extends Controller {
  static readonly inject = [EditorSlot.Auth] as const;
  readonly #auth: GuardAuth<EditorUser>;
  constructor(auth: GuardAuth<EditorUser>) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { name: (await this.#auth.user())?.name };
  }
}

/** Signs in or confirms the password of the guard named in `x-act` (`app-login`, `office-as`, `office-confirm`, …). */
class Act extends Controller {
  static readonly inject = [Auth, OfficeGuard.Auth, TwoFactor, OfficeGuard.TwoFactor] as const;
  readonly #app: Auth;
  readonly #office: GuardAuth<OfficeUser>;
  readonly #appFactor: TwoFactor;
  readonly #officeFactor: GuardTwoFactor<OfficeUser>;
  constructor(auth: Auth, officeAuth: GuardAuth<OfficeUser>, appFactor: TwoFactor, officeFactor: GuardTwoFactor<OfficeUser>) {
    super();
    this.#app = auth;
    this.#office = officeAuth;
    this.#appFactor = appFactor;
    this.#officeFactor = officeFactor;
  }
  async handle(ctx: HttpContext) {
    const [who, what] = (ctx.request.headers.get('x-act') ?? '').split('-') as ['app' | 'office', string];
    const auth = who === 'office' ? this.#office : this.#app;
    const factor = (who === 'office' ? this.#officeFactor : this.#appFactor) as unknown as GuardTwoFactor<{ readonly id: number }>;
    const body = (await ctx.input()) as Record<string, any>;
    if (what === 'login') {
      const done = await auth.attempt('ada@example.com', 'secret');
      return done.ok ? { ok: true } : { ok: false, kind: done.error.kind };
    }
    if (what === 'begin') return { secret: (await factor.begin()).secret };
    if (what === 'code') return { ok: (await factor.confirm(body.code, 'secret')).ok };
    if (what === 'challenge') return { ok: (await factor.challenge(body as never)).ok };
    if (what === 'confirm') return { ok: (await auth.checkPassword('secret')).ok };
    // A sign-in without a password: the window of a password confirmation stays closed.
    if (what === 'as') return { ok: (await (who === 'office' ? this.#office.signIn(office.rows.get(1)!.user) : this.#app.signIn(app.rows.get(1)!.user))) === 'signed-in' };
    return { unknown: true };
  }
}

const pages = (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => {
  Route.post('/act', Act);
  for (const [name, path] of [['auth.login', '/login'], ['editor.login', '/editor-login'], ['editor.home', '/editor-home'], ['editor.confirm', '/editor-confirm'], ['editor.setup', '/editor-setup'], ['editor.verify', '/editor-verify'], ['office.login', '/office-login'], ['office.home', '/office-home'], ['office.confirm', '/office-confirm']] as const) {
    Route.get(path, () => name).name(name);
  }
};

function routeList(p: Policies, extra: (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => void = () => {}): RouteDefinitions {
  return openRoutes((Route) => {
    pages(Route);
    Route.get('/public', Ask);
    const inSlot = Route.middleware(EditorSlot.authenticate(EDITOR));
    inSlot.get('/s/ask', Ask);
    inSlot.get('/s/who', Who);
    inSlot.authorize(can(p.PagePolicy, 'edit', () => PAGE)).get('/s/page', () => 'page');
    inSlot.middleware(EditorSlot.confirmedPassword(EDITOR)).get('/s/sudo', () => 'sudo');
    Route.middleware(EditorSlot.guest(EDITOR)).get('/s/guest', () => 'guest');
    inSlot.middleware(EditorSlot.twoFactor(FACTOR)).get('/s/two', () => 'two');
    inSlot.middleware(EditorSlot.confirmedSecondFactor({ verify: 'editor.verify' })).get('/s/two-confirmed', () => 'two confirmed');
    Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/o/ask', Ask);
    Route.middleware(authenticate()).get('/a/ask', Ask);
    Route.middleware(authenticate('api')).get('/api/ask', Ask);
    extra(Route);
  });
}

async function running(options: { routes?: RouteDefinitions } = {}) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error: (message: string) => void errors.push(message), child: () => logger } as unknown as Logger;
  app.rows.clear();
  office.rows.clear();
  for (const key of Object.keys(stamps)) delete stamps[key];
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-guard-slot-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, PackageProvider, EarlyProvider, AuthServiceProvider, ProbeProvider, LateProvider],
      modules: [
        defineModule({ name: 'guard-slot-test', routes: options.routes ?? routeList(current), apiRoutes: openRoutes((Route) => void Route.middleware(authenticate('api')).get('/ask', Ask)), migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
        container.bind(TwoFactorState, TwoFactorStore);
        container.scoped(TwoFactor);
        // The bearer token `tok` belongs to the app's user 1.
        container.instance(
          AccessTokenStore,
          accessTokenStore({ find: async (plainText) => (plainText === 'tok' ? { id: 1, userId: 1, name: 'test', abilities: ['*'], lastUsedAt: null, expiresAt: null, createdAt: '' } : undefined) }),
        );
      },
    },
  );
  onTestFinished(() => application.shutdown());
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  await application.container.make(Migrator).migrate();
  // Made on first use: a test of the start check makes it by hand and expects it to throw.
  let made: ReturnType<typeof createHttpKernel> | undefined;
  const start = () => (made ??= createHttpKernel(application));
  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (path: string, headers: Record<string, string> = {}, body?: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await start().request(path, { method: headers['x-act'] ? 'POST' : 'GET', headers: { cookie, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'Test Browser', ...headers }, redirect: 'manual', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const act = async (what: string, body: unknown = {}) => (await (await call('/act', { 'x-act': what }, body)).json()) as Record<string, any>;
    /** Changes what the session stores, as a request of another time would have left it. */
    const edit = async (change: (data: Record<string, unknown>) => void) => {
      const store = application.container.make(SessionStore);
      const key = sessionKey(await application.container.make(Encrypter).decrypt(decodeURIComponent(jar.get('marmeon_session')!), 'cookie:marmeon_session'));
      const read = (await store.read(key))!;
      const data = JSON.parse(read.data) as Record<string, unknown>;
      change(data);
      await store.write(key, JSON.stringify(data), { expectedVersion: read.version, lifetimeSeconds: 7200 });
    };
    return { call, act, edit };
  };
  /** Signs `who`'s user 1 in and turns its authenticator on; returns the secret. */
  const enroll = async (who: 'app' | 'office') => {
    const b = browser();
    expect(await b.act(`${who}-login`)).toEqual({ ok: true });
    const begun = await b.act(`${who}-begin`);
    const { secret } = begun;
    expect(await b.act(`${who}-code`, { code: twoFactorCode(secret) })).toEqual({ ok: true });
    return secret as string;
  };
  /** A fresh browser signed in to `who` with its factor, proven with the code of the next step. */
  const provenIn = async (b: ReturnType<typeof browser>, who: 'app' | 'office', secret: string) => {
    expect(await b.act(`${who}-login`)).toEqual({ ok: false, kind: 'two-factor-required' });
    expect(await b.act(`${who}-challenge`, { code: twoFactorCode(secret, new Date(Date.now() + 30_000)) })).toEqual({ ok: true });
  };
  /** A browser that did each act in turn (`app-login`, `office-as`, …). */
  const did = async (...acts: string[]) => {
    const b = browser();
    for (const act of acts) expect(((await (await b.call('/act', { 'x-act': act })).json()) as { ok: boolean }).ok, act).toBe(true);
    return b;
  };
  return { application, errors, warnings, did, start, browser, enroll, provenIn };
}

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

afterEach(() => {
  mode = 'office';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a slot bound to a guard of the package', () => {
  it('lets a policy of the slot see the guard\'s user only: on its route, on a public page, never the app\'s user of the same id', async () => {
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { did, warnings } = await running();
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/s/ask'))).toEqual({ allowed: true });
    expect(current.seen.page.map((user) => user.name)).toEqual(['Office Ada']);
    // The app's user 1 owns the page too: asked about them, the policy would say yes.
    const appOnly = await did('app-login');
    expect(await json(await appOnly.call('/public')), 'a guest of the slot').toEqual({ allowed: false });
    expect(current.seen.page, 'the policy was not built for the app\'s user').toHaveLength(1);
    expect(current.seen.built).toBe(1);
    // A route of the app's guard: a policy of another guard says no, and a development warning says why.
    expect(await json(await both.call('/a/ask'))).toEqual({ allowed: false });
    expect((await both.call('/a/ask')).status).toBe(200);
    expect(current.seen.page, 'still the one user').toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/A9.*'office'.*'web'/s);
  });

  it('answers a route of the slot as the guard\'s: only a sign-in to the guard opens it, and the slot\'s Auth is the guard\'s', async () => {
    current = policies();
    const { did } = await running();
    const appOnly = await did('app-login');
    expect((await appOnly.call('/s/who')).status, 'the app\'s sign-in is none here').toBe(401);
    expect((await appOnly.call('/s/page')).status).toBe(401);
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/s/who'))).toEqual({ name: 'Office Ada' });
    expect((await both.call('/s/page')).status).toBe(200);
    for (const how of ['authorize', 'abilities', 'rows']) {
      expect(await json(await both.call('/s/ask', { 'x-how': how })), how).toEqual({ authorize: { allowed: true }, abilities: { can: { edit: true } }, rows: { rows: [{ editor_id: 1, can: { edit: true } }] } }[how]);
    }
  });

  it('stamps the guard of the target before the first middleware runs', async () => {
    current = policies();
    const { did } = await running();
    const both = await did('app-login', 'office-login');
    await both.call('/s/ask');
    await both.call('/s/guest');
    expect(stamps['/s/ask']).toBe('office');
    expect(stamps['/s/guest']).toBe('office');
  });

  it('asks the target\'s password window, after the target\'s authenticate()', async () => {
    current = policies();
    const { did } = await running();
    // The app's window is open, the office's is not: a sign-in without a password.
    const browser = await did('app-login', 'office-as');
    expect((await browser.call('/s/sudo')).status).toBe(423);
    await browser.call('/act', { 'x-act': 'app-confirm' });
    expect((await browser.call('/s/sudo')).status, 'the app\'s confirmation opens nothing here').toBe(423);
    await browser.call('/act', { 'x-act': 'office-confirm' });
    expect((await browser.call('/s/sudo')).status).toBe(200);
  });

  it('refuses the guard\'s confirmedPassword() before its authenticate() with A9', async () => {
    current = policies();
    const routes = routeList(current, (Route) => void Route.middleware(EditorSlot.guest(EDITOR)).middleware(EditorSlot.confirmedPassword(EDITOR) as never).get('/s/no-authenticate', () => 'x'));
    const { did, errors } = await running({ routes });
    // Not signed in, so `guest()` lets the request on to the confirmation.
    const browser = await did();
    expect((await browser.call('/s/no-authenticate')).status).toBe(500);
    expect(errors.join('\n')).toMatch(/A9.*office.*authenticate\(\)/s);
  });
});

describe('the same code with the slot bound to the app', () => {
  it('lets a policy of the slot see the app\'s user only: on its route, on a public page, never the office\'s user of the same id', async () => {
    mode = 'web';
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { did, warnings } = await running();
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/s/ask'))).toEqual({ allowed: true });
    expect(current.seen.page.map((user) => user.name)).toEqual(['App Ada']);
    const officeOnly = await did('office-login');
    expect(await json(await officeOnly.call('/public')), 'a guest of the app').toEqual({ allowed: false });
    expect(current.seen.page, 'the policy was not built for the office\'s user').toHaveLength(1);
    // A route behind the office guard: the policy of the app's users says no.
    expect(await json(await both.call('/o/ask'))).toEqual({ allowed: false });
    expect(current.seen.page).toHaveLength(1);
    expect(warnings.join('\n')).toMatch(/A9.*'web'.*'office'/s);
  });

  it('answers a route of the slot with the app\'s sign-in, and the slot\'s Auth is the app\'s', async () => {
    mode = 'web';
    current = policies();
    const { did } = await running();
    const officeOnly = await did('office-login');
    expect((await officeOnly.call('/s/who')).status, 'the office\'s sign-in is none here').toBe(401);
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/s/who'))).toEqual({ name: 'App Ada' });
    expect(await json(await both.call('/s/ask', { 'x-how': 'abilities' }))).toEqual({ can: { edit: true } });
    expect(await json(await both.call('/s/ask', { 'x-how': 'rows' }))).toEqual({ rows: [{ editor_id: 1, can: { edit: true } }] });
    expect(stamps['/s/who']).toBe('web');
  });

  it('asks the app\'s password window', async () => {
    mode = 'web';
    current = policies();
    const { did } = await running();
    const browser = await did('office-login', 'app-as');
    expect((await browser.call('/s/sudo')).status).toBe(423);
    await browser.call('/act', { 'x-act': 'office-confirm' });
    expect((await browser.call('/s/sudo')).status, 'the office\'s confirmation opens nothing here').toBe(423);
    await browser.call('/act', { 'x-act': 'app-confirm' });
    expect((await browser.call('/s/sudo')).status).toBe(200);
  });

  it('keeps the app\'s own rule where its prerequisites stand without authenticate(): the window fails, not an A9', async () => {
    mode = 'web';
    current = policies();
    const routes = routeList(current, (Route) => void Route.middleware(EditorSlot.guest(EDITOR)).middleware(EditorSlot.confirmedPassword(EDITOR) as never).get('/s/no-authenticate', () => 'x'));
    const { did, errors } = await running({ routes });
    const browser = await did();
    expect((await browser.call('/s/no-authenticate')).status, 'no sign-in time to count from').toBe(423);
    expect(errors).toEqual([]);
  });

  it('asks the token\'s user on a route behind the token guard', async () => {
    mode = 'web';
    current = policies();
    const { did } = await running();
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/api/ask', { authorization: 'Bearer tok' }))).toEqual({ allowed: true });
    expect(current.seen.page.map((user) => user.name)).toEqual(['App Ada']);
  });

  it('stamps web before the first middleware runs', async () => {
    mode = 'web';
    current = policies();
    const { did } = await running();
    const both = await did('app-login');
    await both.call('/s/ask');
    expect(stamps['/s/ask']).toBe('web');
  });
});

describe('a slot nobody bound', () => {
  it('answers the gate, the slot\'s Auth and a request that uses it with A8, never with the app\'s user', async () => {
    mode = 'none';
    current = policies();
    const routes = openRoutes((Route) => {
      pages(Route);
      Route.get('/public', Ask);
      // No naming middleware: the route has no stamp, so the middleware itself must refuse.
    });
    const { did, application } = await running({ routes });
    const browser = await did('app-login');
    const asked = await json(await browser.call('/public'));
    expect(asked.error).toMatch(/A8.*editor/s);
    expect(current.seen.built, 'the policy was never built').toBe(0);
    expect(() => application.container.make(EditorSlot.Auth)).toThrow(/A8.*editor/s);
    expect(() => application.container.createScope().make(EditorSlot.Auth)).toThrow(/A8.*editor/s);
  });

  it('stops the start with A8 and the path when a route uses it', async () => {
    mode = 'none';
    current = policies();
    const { start } = await running({ routes: openRoutes((Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/page', () => 'x')) });
    expect(start).toThrow(RouteAccessError);
    expect(start).toThrow(/\[marmeon:A8\].*GET \/s\/page: The guard slot 'editor' is not bound/s);
  });

  it('is refused by the start check once the boot is over, and by the first request; a later binding is not shadowed by an old answer', async () => {
    mode = 'none';
    current = policies();
    const router = new Router().load(openRoutes((Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/page', () => 'x')));
    const container = new Container();
    stampRoutes(router, (Class) => container.make(Class as never));
    slotBindings(container).seal();
    expect(router.pipelineProblems()).toEqual([expect.objectContaining({ code: 'A8', message: expect.stringContaining("The guard slot 'editor' is not bound") })]);
    const route = router.routes[0]!;
    const scope = container.createScope();
    // No `AuthServiceProvider` here: the slot's scope is made by the binding only.
    await expect(router.dispatch(route, { request: new Request('http://app.test/s/page'), params: {} }, { resolve: (Class) => scope.make(Class as never) })).rejects.toThrow(/A8/);
    EditorSlot.bind(container, 'web');
    expect(router.pipelineProblems(), 'once bound, the same routes are fine').toEqual([]);
    expect(routeGuardOf(router.middlewareFor(route), (Class) => container.make(Class as never))).toEqual({ guard: 'web' });
  });

  it('is not judged by a check that registers the app and never boots it, where a provider may still bind it', async () => {
    mode = 'none';
    current = policies();
    const application = await createApplication(
      { root: workspaceTempDir('marmeon-guard-slot-'), discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, PackageProvider, AuthServiceProvider], modules: [defineModule({ name: 'guard-slot-test', routes: openRoutes((Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/page', () => 'x')) })] },
      { phase: 'build', env: { NODE_ENV: 'test', APP_KEY: generateKey() } },
    );
    onTestFinished(() => application.shutdown());
    expect(application.container.make(Router).pipelineProblems(), 'nothing is bound yet: the start says so after the boot').toEqual([]);
  });

  it.each([
    ['before', (slot: unknown, office: unknown, app: unknown) => [slot, office, app]],
    ['between', (slot: unknown, office: unknown, app: unknown) => [office, slot, app]],
    ['after', (slot: unknown, office: unknown, app: unknown) => [office, app, slot]],
  ] as const)('still reports a certain A9 between two other middleware while the slot is unbound, wherever the slot sits (%s)', (_where, order) => {
    const router = new Router().load(
      openRoutes((Route) => {
        const [first, second, third] = order(EditorSlot.guest(EDITOR), OfficeGuard.authenticate(OFFICE), authenticate()) as never[];
        Route.middleware(first!).middleware(second!).middleware(third!).get('/mixed', () => 'x');
        Route.middleware(EditorSlot.guest(EDITOR)).get('/alone', () => 'x');
      }),
    );
    const container = new Container();
    stampRoutes(router, (Class) => container.make(Class as never));
    const problems = router.pipelineProblems();
    expect(problems.map(({ route, code }) => [route.path, code])).toEqual([['/mixed', 'A9']]);
    expect(problems[0]!.message).toMatch(/'office'.*'web'|'web'.*'office'/s);
  });

  it('judges a slot a provider binds in boot() like one bound in register(): the start passes and the routes answer', async () => {
    mode = 'boot';
    current = policies();
    const { did, start, application } = await running();
    expect(start).not.toThrow();
    expect(application.container.make(Router).pipelineProblems()).toEqual([]);
    const both = await did('app-login', 'office-login');
    expect(await json(await both.call('/s/who'))).toEqual({ name: 'Office Ada' });
  });

  it('is A8 for a guard no provider registered, found by the start check and by a policy, before the boot is over', () => {
    const container = new Container();
    EditorSlot.bind(container, GhostGuard);
    const router = new Router().load(openRoutes((Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/page', () => 'x')));
    stampRoutes(router, (Class) => container.make(Class as never));
    slotBindings(container).seal();
    expect(router.pipelineProblems()).toEqual([expect.objectContaining({ code: 'A8', message: expect.stringMatching(/'editor'.*'ghost'/s) })]);
    class Policy {
      static readonly guard = EditorSlot;
    }
    expect(() => policyGuard(Policy, (Class) => container.make(Class as never))).toThrow(/A8.*'editor'.*'ghost'/s);
    expect(() => bootGuardSlots(container)).toThrow(/A8.*'editor'.*'ghost'/s);
  });
});

describe('a slot and the guards of a route', () => {
  const mixed = (Route: Parameters<Parameters<typeof openRoutes>[0]>[0]) => void Route.middleware(EditorSlot.authenticate(EDITOR)).middleware(OfficeGuard.guest(OFFICE)).get('/mixed', () => 'x');

  it('is A9 at the start when the slot is bound to the app and the route also names the office guard', async () => {
    mode = 'web';
    current = policies();
    const { start } = await running({ routes: openRoutes((Route) => (pages(Route), mixed(Route))) });
    expect(start).toThrow(RouteAccessError);
    expect(start).toThrow(/\[marmeon:A9\].*GET \/mixed: .*a route belongs to one guard/s);
  });

  it('is no conflict when the slot is bound to that guard', async () => {
    mode = 'office';
    current = policies();
    const { application, start } = await running({ routes: openRoutes((Route) => (pages(Route), mixed(Route))) });
    expect(start).not.toThrow();
    expect(application.container.make(Router).pipelineProblems()).toEqual([]);
  });
});

describe('binding a slot', () => {
  it('refuses a second binding, a name no guard may have, a target that is neither and a guard without twoFactor for a slot with two-factor middleware', () => {
    const slot = defineGuardSlot<EditorUser>('twice');
    const container = new Container();
    slot.bind(container, 'web');
    expect(() => slot.bind(container, 'web')).toThrow(/A8.*bound twice/s);
    expect(() => defineGuardSlot<EditorUser>('web')).toThrow(/A8/);
    expect(() => defineGuardSlot<EditorUser>('Not A Name')).toThrow(GuardSlotError);
    expect(() => defineGuardSlot<EditorUser>('other').bind(container, 'office' as never)).toThrow(/A8.*'web' or to a guard/s);
    expect(() => defineGuardSlot<EditorUser>('other', { twoFactor: false } as never)).toThrow(/A8.*twoFactor: true/s);
    const withoutFactor = defineGuard('plain', { users: OfficeUsers, tablePrefix: 'plain_' });
    expect(() => EditorSlot.bind(new Container(), withoutFactor as never)).toThrow(/A8.*'editor'.*'plain'.*twoFactor/s);
    expect(() => defineGuardSlot<EditorUser>('plain-slot').bind(new Container(), withoutFactor)).not.toThrow();
    // Another container has its own binding: a slot is module-wide, its target is not.
    expect(() => slot.bind(new Container(), 'web')).not.toThrow();
  });

  it('refuses a binding made in a request\'s scope: the target would be the app\'s, the Auth the scope\'s only', () => {
    const slot = defineGuardSlot<EditorUser>('scoped');
    const scope = new Container().createScope();
    expect(() => slot.bind(scope, 'web')).toThrow(/A8.*'scoped'.*never in a request's scope/s);
    expect(scope.has(SlotBindings)).toBe(false);
  });

  it('lets two unrelated slots share a name: the binding is by the slot, not by its name', () => {
    const first = defineGuardSlot<EditorUser>('admin');
    const second = defineGuardSlot<EditorUser>('admin');
    const container = new Container();
    first.bind(container, 'web');
    second.bind(container, OfficeGuard);
    const bindings = container.make(SlotBindings);
    expect(bindings.target(first)).toBe('web');
    expect(bindings.target(second)).toBe(OfficeGuard);
  });

  it('stops the boot when the target is a guard no provider registered', async () => {
    mode = 'ghost';
    current = policies();
    await expect(running()).rejects.toThrow(/A8.*'editor'.*'ghost'/s);
  });

  it('serves the guard\'s user when a provider listed after the auth provider registers the guard in register() and binds the slot in boot()', async () => {
    mode = 'late-registered';
    current = policies();
    const { start, application } = await running({ routes: openRoutes((Route) => (pages(Route), void Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/who', Who))) });
    expect(start).not.toThrow();
    expect(application.container.make(SlotBindings).target(EditorSlot)).toBe(LateGuard);
    // Outside a request the guard's `Auth` cannot be built (it needs the request's cookies), but the chain shows the slot resolved to the guard: no A8.
    expect(() => application.container.createScope().make(EditorSlot.Auth)).toThrow(/GuardSlot:editor\.Auth → late\.Auth/);
  });

  it('stops the boot with A8 when a provider registers a guard in a boot() that runs after the auth provider\'s', async () => {
    mode = 'late-boot';
    current = policies();
    await expect(running()).rejects.toThrow("[marmeon:A8] The guard 'booted' is registered after the auth provider has booted (for instance in a later provider's boot()), so it would miss the boot checks (its settings, tables, sign-in finder, remember-me cookie and route limits): call register() in the package provider's register().");
  });

  it('boots a guard registered in a boot() that runs before the auth provider\'s, with its remember-me cookie redacted', async () => {
    mode = 'early-boot';
    current = policies();
    const { application } = await running();
    const container = application.container;
    const guard = guardRegistry(container).all().find((one) => one.name === 'booted')!;
    const cookie = guard.names.rememberCookie(container.make(guard.tokens.settings), container.make(SessionConfig));
    expect(container.make(Redactor).isAddedKey(cookie)).toBe(true);
    expect(container.make(RateLimiter).limiter('auth.booted.login')).toBeDefined();
  });

  it('boots a guard registered in register() and registered again from a late boot()', async () => {
    mode = 'twice';
    current = policies();
    await expect(running()).resolves.toBeDefined();
  });

  it('boots when a late provider binds a guard nobody registered and no route uses the slot, and refuses at use with A8', async () => {
    mode = 'late-ghost';
    current = policies();
    const { application, did } = await running({ routes: openRoutes((Route) => (pages(Route), void Route.get('/public', Ask))) });
    expect(() => application.container.createScope().make(EditorSlot.Auth)).toThrow(/A8.*'editor'.*'ghost'/s);
    const browser = await did('app-login');
    expect((await json(await browser.call('/public'))).error).toMatch(/A8.*'editor'.*'ghost'/s);
  });

  it('resolves the slot\'s Auth through the binding every time: a guard nobody registered is A8, not a missing binding', () => {
    const container = new Container();
    EditorSlot.bind(container, GhostGuard);
    expect(() => container.createScope().make(EditorSlot.Auth)).toThrow(/A8.*'editor'.*'ghost'/s);
  });

  it('recognises a slot by what defineGuardSlot() made, not by its shape', () => {
    expect(isGuardSlot(EditorSlot)).toBe(true);
    expect(isGuardSlot({ ...EditorSlot })).toBe(false);
    expect(new SlotBindings().target(EditorSlot)).toBeUndefined();
  });

  it('asks every middleware for its route options at definition time', () => {
    expect(() => EditorSlot.authenticate({} as never)).toThrow(/loginRoute/);
    expect(() => EditorSlot.guest(undefined as never)).toThrow(/homeRoute/);
    expect(() => EditorSlot.confirmedPassword({ confirmRoute: '' } as never)).toThrow(/confirmRoute/);
    expect(() => EditorSlot.twoFactor({ setup: 'a' } as never)).toThrow(/verify/);
    expect(() => EditorSlot.confirmedSecondFactor({} as never)).toThrow(/verify/);
  });

  it('refuses at definition what the guards\' own middleware refuses, and keeps the options as they were given', () => {
    expect(() => EditorSlot.confirmedPassword({ confirmRoute: 'editor.confirm', seconds: 5 } as never)).toThrow(/seconds.*maxAge/);
    expect(() => EditorSlot.confirmedPassword({ confirmRoute: 'editor.confirm', maxAge: 0 } as never)).toThrow(/maxAge.*above zero/);
    expect(() => EditorSlot.twoFactor({ ...FACTOR, maxAge: { seconds: 0 } } as never)).toThrow(/maxAge.*above zero/);
    expect(() => EditorSlot.confirmedPassword({ confirmRoute: 'editor.confirm', maxAge: { minutes: 5 } })).not.toThrow();
  });
});

describe('the options of a slot\'s middleware', () => {
  it('are copied at definition: what the caller does to its object afterwards changes nothing, and a function among them is no matter', async () => {
    current = policies();
    const options = { ...EDITOR, extra: () => 'not an option' };
    const Guest = EditorSlot.guest(options);
    options.homeRoute = 'nope' as never;
    const { did } = await running({ routes: routeList(current, (Route) => void Route.middleware(Guest).get('/s/guest-copy', () => 'guest')) });
    const signedIn = await did('office-login');
    const response = await signedIn.call('/s/guest-copy');
    expect(response.status).toBe(302);
    expect(response.headers.get('location'), 'the page it was defined with').toBe('/editor-home');
  });

  it('take a Temporal.Duration as the guards\' own middleware do', async () => {
    current = policies();
    const maxAge = Temporal.Duration.from({ minutes: 5 });
    expect(() => OfficeGuard.confirmedPassword({ ...OFFICE, maxAge })).not.toThrow();
    const Sudo = EditorSlot.confirmedPassword({ ...EDITOR, maxAge });
    expect(() => EditorSlot.twoFactor({ ...FACTOR, maxAge })).not.toThrow();
    const { did } = await running({ routes: routeList(current, (Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).middleware(Sudo).get('/s/sudo-temporal', () => 'sudo')) });
    const signedIn = await did('office-login');
    expect((await signedIn.call('/s/sudo-temporal')).status, 'the password was typed a moment ago').toBe(200);
  });
});

describe('what the target\'s middleware refuses', () => {
  it('stops the start with A8 and the path, not every request with a 500', async () => {
    current = policies();
    vi.spyOn(OfficeGuard, 'confirmedPassword').mockImplementation(() => {
      throw new TypeError('the guard refuses these options');
    });
    const { start } = await running({ routes: openRoutes((Route) => (pages(Route), void Route.middleware(EditorSlot.confirmedPassword(EDITOR) as never).get('/s/page', () => 'x'))) });
    expect(start).toThrow(/\[marmeon:A8\].*GET \/s\/page: The guard slot 'editor' cannot offer confirmedPassword\(\) on the guard 'office': the guard refuses these options/s);
  });
});

describe('the second-factor middleware of a slot', () => {
  const HTML = { accept: 'text/html' };

  // The clock stands still, five seconds into a 30-second code step: a code made now and one made 30 s later are neighbouring steps.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: Math.floor(Date.now() / 30_000) * 30_000 + 5_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['office', 'app'],
    ['web', 'office'],
  ] as const)('sends a user without a factor of the bound mode to setup when only the other mode has one (%s)', async (bound, other) => {
    mode = bound;
    current = policies();
    const { enroll, provenIn, browser, did } = await running();
    const secret = await enroll(other);
    const b = browser();
    await provenIn(b, other, secret);
    // The user of the bound mode signs in without a factor.
    const own = bound === 'web' ? 'app' : 'office';
    expect(await b.act(`${own}-login`)).toEqual({ ok: true });
    const response = await b.call('/s/two', HTML);
    expect(response.status).toBe(302);
    expect(response.headers.get('location'), 'the other mode\'s factor satisfies nothing here').toBe('/editor-setup');
    expect(await (await b.call('/s/two')).json()).toEqual({ error: 'two_factor_required' });
    // An account without a factor has nothing to confirm.
    expect((await b.call('/s/two-confirmed')).status).toBe(200);
    expect((await (await did()).call('/s/two')).status, 'a guest').toBe(401);
  });

  it.each([
    ['office', 'app', guardNames('office').session.twoFactorAt, AUTH_SESSION_KEYS.twoFactorAt],
    ['web', 'office', AUTH_SESSION_KEYS.twoFactorAt, guardNames('office').session.twoFactorAt],
  ] as const)('lets a user through who proved the bound mode\'s factor, and sends one who proved only the other mode\'s to verify (%s)', async (bound, other, ownProof, otherProof) => {
    mode = bound;
    current = policies();
    const { enroll, provenIn, browser } = await running();
    const own = bound === 'web' ? 'app' : 'office';
    const secrets = { app: await enroll('app'), office: await enroll('office') };
    const both = async () => {
      const b = browser();
      await provenIn(b, own, secrets[own]);
      await provenIn(b, other, secrets[other]);
      // Later steps: a code counts once.
      vi.setSystemTime(Date.now() + 60_000);
      return b;
    };
    const kept = await both();
    expect((await kept.call('/s/two')).status).toBe(200);
    expect((await kept.call('/s/two-confirmed')).status).toBe(200);
    // The other mode's proof ends, this mode's stands: nothing changes here.
    await kept.edit((data) => delete data[otherProof]);
    expect((await kept.call('/s/two')).status).toBe(200);
    expect((await kept.call('/s/two-confirmed')).status).toBe(200);
    // This mode's proof ends while the other's stands: the other proves nothing here.
    const lost = await both();
    await lost.edit((data) => delete data[ownProof]);
    const html = await lost.call('/s/two', HTML);
    expect(html.status).toBe(302);
    expect(html.headers.get('location')).toBe('/editor-verify');
    expect(await (await lost.call('/s/two')).json()).toEqual({ error: 'two_factor_unverified' });
    expect((await lost.call('/s/two-confirmed', HTML)).headers.get('location')).toBe('/editor-verify');
  });

  it('keeps the guest out as authenticate() does: only the bound guard\'s sign-in counts', async () => {
    current = policies();
    const { did } = await running();
    const appOnly = await did('app-login');
    expect((await appOnly.call('/s/two')).status).toBe(401);
  });
});

describe('the guest middleware of a slot', () => {
  it.each([
    ['office', 'office-login', 'app-login'],
    ['web', 'app-login', 'office-login'],
  ] as const)('sends the bound guard\'s signed-in users home and lets a guest and the other mode\'s users in (%s)', async (bound, own, other) => {
    mode = bound;
    current = policies();
    const { did } = await running();
    const signedIn = await did(own);
    const response = await signedIn.call('/s/guest');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/editor-home');
    for (const browser of [await did(), await did(other)]) {
      const answer = await browser.call('/s/guest');
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('guest');
    }
  });
});

describe('what the slot\'s middleware promises the router', () => {
  it('declares the user it adds and that only authenticated requests pass, so check and the context see it', () => {
    const middleware = EditorSlot.authenticate(EDITOR) as unknown as { adds: readonly string[] };
    expect(ensuresOf(EditorSlot.authenticate(EDITOR))).toEqual(['authenticated']);
    expect(middleware.adds).toEqual(['user']);
    expect(ensuresOf(EditorSlot.guest(EDITOR))).toEqual([]);
  });

  it('is a conflict with the app\'s authenticate() on one route, as two middleware that both add `user`', () => {
    const router = new Router().load(openRoutes((Route) => void Route.middleware(EditorSlot.authenticate(EDITOR)).middleware(authenticate() as never).get('/twice', () => 'x')));
    expect(router.middlewareProblems().map((problem) => problem.key)).toEqual(['user']);
  });
});

describe('the events of a slot', () => {
  /** What each listener of the app, of the office guard and of the slot heard, in order; the slot's with the mode its event names. */
  async function listening(routes = openRoutes((Route) => void pages(Route))) {
    const booted = await running({ routes });
    const log: string[] = [];
    const registry = booted.application.container.make(EventRegistry);
    const on = (Class: unknown, label: string) => registry.listen(Class as never, ((event: { guard?: string; userId?: unknown; user?: { id: unknown } }) => void log.push(`${label}${event.guard === undefined ? '' : ` ${event.guard}`} ${String(event.userId ?? event.user?.id)}`)) as never);
    on(appEvents.SignedIn, 'app SignedIn');
    on(OfficeGuard.events.SignedIn, 'office SignedIn');
    on(EditorSlot.events.SignedIn, 'slot SignedIn');
    return { ...booted, log, registry, on };
  }

  it('relays the office guard\'s sign-in after its own event, with the mode, and never an app sign-in of the same id', async () => {
    mode = 'office';
    const { did, log } = await listening();
    await did('office-login');
    expect(log).toEqual(['office SignedIn 1', 'slot SignedIn office 1']);
    log.length = 0;
    await did('app-login');
    expect(log).toEqual(['app SignedIn 1']);
  });

  it('relays the app\'s sign-in of a slot bound to web, and never the office guard\'s of the same id', async () => {
    mode = 'web';
    const { did, log } = await listening();
    await did('app-login');
    expect(log).toEqual(['app SignedIn 1', 'slot SignedIn web 1']);
    log.length = 0;
    await did('office-login');
    expect(log).toEqual(['office SignedIn 1']);
  });

  it('dispatches nothing for an unbound slot, and never falls back to the app: both sign-ins succeed', async () => {
    mode = 'none';
    const { did, log } = await listening();
    await did('app-login');
    await did('office-login');
    expect(log).toEqual(['app SignedIn 1', 'office SignedIn 1']);
  });

  it('relays after a binding made in the boot() of a provider that boots after the auth provider', async () => {
    mode = 'late-office';
    const { did, log } = await listening();
    await did('office-login');
    expect(log).toEqual(['office SignedIn 1', 'slot SignedIn office 1']);
  });

  it('gives each slot bound to the target its event, in the order the slots were bound', async () => {
    mode = 'two-slots';
    const { did, log, on } = await listening();
    on(SecondSlot.events.SignedIn, 'second SignedIn');
    await did('office-login');
    expect(log).toEqual(['office SignedIn 1', 'slot SignedIn office 1', 'second SignedIn office 1']);
  });

  it('stops at a listener of the target that throws: no slot event, and the error reaches the caller', async () => {
    mode = 'office';
    const { application, log, on, registry } = await listening();
    on(OfficeGuard.events.PasswordReset, 'office PasswordReset');
    on(EditorSlot.events.PasswordReset, 'slot PasswordReset');
    registry.listen(OfficeGuard.events.PasswordReset as never, (() => {
      throw new Error('listener failed');
    }) as never);
    const broker = application.container.make(OfficeGuard.PasswordBroker);
    const created = await broker.createToken('ada@example.com');
    await expect(broker.reset('ada@example.com', created.ok ? created.value.token : '', 'new password')).rejects.toThrow('listener failed');
    expect(log).toEqual(['office PasswordReset 1']);
  });

  it('relays a password reset, a two-factor enable and an operator reset of the guard, each once and after the guard\'s own', async () => {
    mode = 'office';
    const { application, log, on, enroll } = await listening();
    for (const name of ['PasswordReset', 'TwoFactorEnabled', 'TwoFactorDisabled'] as const) {
      on(OfficeGuard.events[name], `office ${name}`);
      on(EditorSlot.events[name], `slot ${name}`);
    }
    await enroll('office');
    expect(log.filter((line) => line.includes('TwoFactorEnabled'))).toEqual(['office TwoFactorEnabled 1', 'slot TwoFactorEnabled office 1']);

    log.length = 0;
    const output = { line() {}, success() {}, error() {} };
    const command = application.container.createScope().make(ResetTwoFactorCommand as never) as { handle(input: never): Promise<number> };
    expect(await command.handle({ args: ['ada@example.com'], options: { force: true, guard: 'office' }, output, root: '/', spawn: async () => 0 } as never)).toBe(0);
    expect(log).toEqual(['office TwoFactorDisabled 1', 'slot TwoFactorDisabled office 1']);

    log.length = 0;
    const broker = application.container.make(OfficeGuard.PasswordBroker);
    const created = await broker.createToken('ada@example.com');
    expect((await broker.reset('ada@example.com', created.ok ? created.value.token : '', 'new password')).ok).toBe(true);
    expect(log).toEqual(['office PasswordReset 1', 'slot PasswordReset office 1']);
  });

  it('relays a two-factor enable of the app to a slot bound to web, and nothing of the office guard\'s', async () => {
    mode = 'web';
    const { log, on, enroll } = await listening();
    on(appEvents.TwoFactorEnabled, 'app TwoFactorEnabled');
    on(OfficeGuard.events.TwoFactorEnabled, 'office TwoFactorEnabled');
    on(EditorSlot.events.TwoFactorEnabled, 'slot TwoFactorEnabled');
    await enroll('app');
    expect(log.filter((line) => line.includes('TwoFactorEnabled'))).toEqual(['app TwoFactorEnabled 1', 'slot TwoFactorEnabled web 1']);
    log.length = 0;
    await enroll('office');
    expect(log.filter((line) => line.includes('TwoFactorEnabled'))).toEqual(['office TwoFactorEnabled 1']);
  });
});
