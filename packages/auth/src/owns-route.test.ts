import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defineGuard, type GuardAuth } from './define-guard.ts';
import { defineGuardSlot } from './guard-slot.ts';
import { AccessTokenStore, Auth, AuthServiceProvider, authenticate, guest, Hasher, UserProvider, type AuthUser } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { accessTokenStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}
class ShopUsers extends MemoryUsers<OfficeUser> {}

const settings = { loginAttemptsPerMinute: 60, accountSignInsPerDay: 100 };
const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings });
const ShopGuard = defineGuard('shop', { users: ShopUsers, tablePrefix: 'shop_', settings });
const EditorSlot = defineGuardSlot<{ readonly id: number; readonly name: string }>('editor');
const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const SHOP = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const EDITOR = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;

/** What the slot is bound to in this test. */
let bound: 'office' | 'web' = 'office';

class GuardProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
    ShopGuard.register(container);
    EditorSlot.bind(container, bound === 'web' ? 'web' : OfficeGuard);
  }
}

class Ask extends Controller {
  static readonly inject = [Auth, OfficeGuard.Auth, ShopGuard.Auth, EditorSlot.Auth] as const;
  readonly #answers: Record<string, { ownsRoute(): boolean }>;
  constructor(auth: Auth, officeAuth: GuardAuth<OfficeUser>, shopAuth: GuardAuth<OfficeUser>, slotAuth: unknown) {
    super();
    this.#answers = { app: auth, office: officeAuth, shop: shopAuth, slot: slotAuth as { ownsRoute(): boolean } };
  }
  handle() {
    return Object.fromEntries(Object.entries(this.#answers).map(([name, auth]) => [name, auth.ownsRoute()]));
  }
}

class Login extends Controller {
  static readonly inject = [Auth, OfficeGuard.Auth] as const;
  readonly #app: Auth;
  readonly #office: GuardAuth<OfficeUser>;
  constructor(auth: Auth, officeAuth: GuardAuth<OfficeUser>) {
    super();
    this.#app = auth;
    this.#office = officeAuth;
  }
  async handle(ctx: HttpContext) {
    const auth = ctx.request.headers.get('x-guard') === 'office' ? this.#office : this.#app;
    return { ok: (await auth.attempt('ada@example.com', 'secret')).ok };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', Login);
  Route.get('/login-page', () => 'login').name('office.login');
  Route.get('/home', () => 'home').name('office.home');
  Route.get('/confirm', () => 'confirm').name('office.confirm');
  Route.get('/public', Ask);
  Route.middleware(authenticate()).get('/a/auth', Ask);
  Route.middleware(guest({ homeRoute: 'office.home' })).get('/a/guest', Ask);
  Route.middleware(OfficeGuard.authenticate(OFFICE)).get('/o/auth', Ask);
  Route.middleware(OfficeGuard.guest(OFFICE)).get('/o/guest', Ask);
  Route.middleware(ShopGuard.guest(SHOP)).get('/shop/guest', Ask);
  Route.middleware(EditorSlot.authenticate(EDITOR)).get('/s/auth', Ask);
  Route.middleware(EditorSlot.guest(EDITOR)).get('/s/guest', Ask);
});

async function running(slot: typeof bound) {
  bound = slot;
  app.rows.clear();
  office.rows.clear();
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger } as unknown as Logger;
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-owns-route-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, GuardProvider, AuthServiceProvider],
      modules: [
        defineModule({ name: 'owns-route-test', routes, apiRoutes: openRoutes((Route) => void Route.middleware(authenticate('api')).get('/ask', Ask)), migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
        container.instance(AccessTokenStore, accessTokenStore({ find: async (plainText) => (plainText === 'tok' ? { id: 1, userId: 1, name: 'test', abilities: ['*'], lastUsedAt: null, expiresAt: null, createdAt: '' } : undefined) }));
      },
    },
  );
  onTestFinished(() => application.shutdown());
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const browser = () => {
    const jar = new Map<string, string>();
    return async (path: string, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: path === '/login' ? 'POST' : 'GET', headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', ...headers }, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '') jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
  };
  /** A browser signed in to the app and to the office. */
  const signedIn = async () => {
    const call = browser();
    for (const guard of ['app', 'office']) {
      const login = await call('/login', { 'x-guard': guard });
      expect(((await login.json()) as { ok: boolean }).ok).toBe(true);
    }
    return call;
  };
  return { signedIn, guest: browser };
}

const NOBODY = { app: false, office: false, shop: false, slot: false };

describe('Auth#ownsRoute', () => {
  it.each([
    ['a public page with no guard', '/public', { ...NOBODY, app: true }],
    ["the app's authenticate()", '/a/auth', { ...NOBODY, app: true }],
    ["the app's guest()", '/a/guest', { ...NOBODY, app: true }],
    ["the token guard's authenticate('api')", '/api/ask', { ...NOBODY, app: true }],
    ["a package guard's authenticate()", '/o/auth', { ...NOBODY, office: true, slot: true }],
    ["a package guard's guest()", '/o/guest', { ...NOBODY, office: true, slot: true }],
    ["another package guard's guest()", '/shop/guest', { ...NOBODY, shop: true }],
    ["a slot bound to a package guard, authenticate()", '/s/auth', { ...NOBODY, office: true, slot: true }],
    ["a slot bound to a package guard, guest()", '/s/guest', { ...NOBODY, office: true, slot: true }],
  ] as const)('answers on %s (slot bound to the office guard)', async (_what, path, expected) => {
    const { signedIn, guest: fresh } = await running('office');
    // guest() routes turn a signed-in browser away: they are asked by one that is not.
    const call = path.endsWith('/guest') ? fresh() : await signedIn();
    const response = await call(path, path === '/api/ask' ? { authorization: 'Bearer tok' } : {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });

  it.each([
    ['a public page with no guard', '/public', { ...NOBODY, app: true, slot: true }],
    ["a slot bound to the app's users, authenticate()", '/s/auth', { ...NOBODY, app: true, slot: true }],
    ["a slot bound to the app's users, guest()", '/s/guest', { ...NOBODY, app: true, slot: true }],
    ["a package guard's authenticate()", '/o/auth', { ...NOBODY, office: true }],
  ] as const)('answers on %s (slot bound to the app)', async (_what, path, expected) => {
    const { signedIn, guest: fresh } = await running('web');
    const call = path.endsWith('/guest') ? fresh() : await signedIn();
    const response = await call(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
  });
});
