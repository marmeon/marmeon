import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication, defineModule, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineGuard, type GuardAuth } from './define-guard.ts';
import { AccessTokenStore, Auth, AuthServiceProvider, authenticate, can, Gate, Hasher, UserProvider, type AuthUser, type PolicyClass } from './index.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { openRoutes } from './test-helpers/open-routes.ts';
import { accessTokenStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}
interface Post {
  readonly user_id: number;
}

// The same id 1 in both tables: only the guard tells the app's user and the editor apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', settings: { loginAttemptsPerMinute: 60, accountSignInsPerDay: 100 } });
// Never registered by any provider: no policy may name it.
const GhostGuard = defineGuard('ghost', { users: OfficeUsers, tablePrefix: 'ghost_' });
const OFFICE = { loginRoute: 'office.login', homeRoute: 'office.home', confirmRoute: 'office.confirm' } as const;
const POST: Post = { user_id: 1 };

class GuardProvider implements ServiceProvider {
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

/** What each policy was asked about: the users it saw, how often it was built and how often `before()` ran. Fresh classes per test (one warning per class). */
function policies() {
  const seen = { app: [] as AuthUser[], page: [] as OfficeUser[], before: [] as OfficeUser[], built: 0 };
  class AppPolicy {
    constructor() {
      seen.built++;
    }
    update(user: AuthUser, post: Post) {
      seen.app.push(user);
      return post.user_id === user.id;
    }
  }
  class PagePolicy {
    static readonly guard = OfficeGuard;
    constructor() {
      seen.built++;
    }
    before(user: OfficeUser): undefined {
      seen.before.push(user);
      return undefined;
    }
    edit(user: OfficeUser, post: Post) {
      seen.page.push(user);
      return post.user_id === user.id;
    }
    create(user: OfficeUser) {
      return user.id === 1;
    }
  }
  /** The policy of a guard, specialised: the static is inherited. */
  class SeniorPagePolicy extends PagePolicy {}
  class NamedByString {
    static readonly guard = 'office';
    constructor() {
      seen.built++;
    }
    edit(_user: OfficeUser) {
      return true;
    }
  }
  class NamedUnregistered {
    static readonly guard = GhostGuard;
    constructor() {
      seen.built++;
    }
    edit(_user: OfficeUser) {
      return true;
    }
  }
  return { seen, AppPolicy, PagePolicy, SeniorPagePolicy, NamedByString, NamedUnregistered };
}
type Policies = ReturnType<typeof policies>;

/** Set by each test: the policies the routes ask. */
let current: Policies;

/** Asks the gate what the header says and answers with the result: one controller for every route of the test. */
class Ask extends Controller {
  static readonly inject = [Gate] as const;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    super();
    this.#gate = gate;
  }
  async handle(ctx: HttpContext) {
    const policy = ctx.request.headers.get('x-policy') ?? 'app';
    const how = ctx.request.headers.get('x-how') ?? 'allows';
    const classes = {
      app: [current.AppPolicy, 'update'],
      page: [current.PagePolicy, 'edit'],
      senior: [current.SeniorPagePolicy, 'edit'],
      string: [current.NamedByString, 'edit'],
      ghost: [current.NamedUnregistered, 'edit'],
    } as unknown as Record<string, [PolicyClass<Record<string, never>>, never]>;
    const [Class, ability] = classes[policy]!;
    try {
      if (how === 'allows') return { allowed: await this.#gate.allows(Class, ability, POST as never) };
      if (how === 'denies') return { denied: await this.#gate.denies(Class, ability, POST as never) };
      if (how === 'inspect') return { allowed: (await this.#gate.inspect(Class, ability, POST as never)).allowed };
      if (how === 'authorize') {
        await this.#gate.authorize(Class, ability, POST as never);
        return { allowed: true };
      }
      if (how === 'abilities') return { can: await this.#gate.abilities(POST as never, Class, [ability] as never) };
      return { rows: await this.#gate.withAbilities([POST] as never, Class, [ability] as never) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
}

/** One global middleware that asks the app's policy at once, as an app does for a flag in shared props. */
class AskEarly {
  static readonly inject = [Gate] as const;
  readonly #gate: Gate;
  constructor(gate: Gate) {
    this.#gate = gate;
  }
  async handle(ctx: HttpContext, next: (extension: object) => Promise<Response>) {
    if (ctx.request.headers.get('x-early') === 'yes') await this.#gate.allows(current.AppPolicy, 'update', POST);
    return next({});
  }
}

class EarlyProvider implements ServiceProvider {
  boot(application: { container: Container }): void {
    application.container.make(Router).middleware.append('web', AskEarly as never);
  }
}

class SignIn extends Controller {
  readonly #app: Auth;
  readonly #office: GuardAuth<OfficeUser>;
  static readonly inject = [Auth, OfficeGuard.Auth] as const;
  constructor(auth: Auth, officeAuth: GuardAuth<OfficeUser>) {
    super();
    this.#app = auth;
    this.#office = officeAuth;
  }
  async handle(ctx: HttpContext) {
    const auth = ctx.request.headers.get('x-guard') === 'office' ? this.#office : this.#app;
    return { ok: (await auth.attempt(ctx.request.headers.get('x-email') ?? 'ada@example.com', 'secret')).ok };
  }
}

function routeList(p: Policies) {
  return openRoutes((Route) => {
    Route.post('/act', SignIn);
    Route.get('/login', () => 'app login').name('auth.login');
    Route.get('/office-login', () => 'office login').name('office.login');
    Route.get('/office-home', () => 'office home').name('office.home');
    Route.get('/office-confirm', () => 'office confirm').name('office.confirm');
    // A public page: no guard names itself.
    Route.get('/public', Ask);
    const inOffice = Route.middleware(OfficeGuard.authenticate(OFFICE));
    inOffice.get('/o/ask', Ask);
    inOffice.authorize(can(p.PagePolicy, 'edit', () => POST)).get('/o/page', () => 'page');
    // Here the two user types are alike in shape, so the types allow it; the gate decides on the guard, not on the shape.
    inOffice.authorize(can(p.AppPolicy, 'update', () => POST)).get('/o/app-policy', () => 'page');
    const inApp = Route.middleware(authenticate());
    inApp.get('/a/ask', Ask);
    inApp.authorize(can(p.PagePolicy, 'edit', () => POST)).get('/a/admin', () => 'admin');
    inApp.authorize(can(p.AppPolicy, 'update', () => POST)).get('/a/post', () => 'post');
  });
}

async function running() {
  const warnings: string[] = [];
  const logger = { debug() {}, info() {}, warn: (message: string) => void warnings.push(message), error() {}, child: () => logger } as unknown as Logger;
  app.rows.clear();
  office.rows.clear();
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-gate-guards-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, GuardProvider, AuthServiceProvider, EarlyProvider],
      modules: [
        defineModule({ name: 'gate-guards-test', routes: routeList(current), apiRoutes: openRoutes((Route) => void Route.middleware(authenticate('api')).get('/ask', Ask)), migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'office-test', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        container.make(CsrfProtection).disable();
        container.instance(Logger, logger);
        container.instance(UserProvider, app as unknown as UserProvider);
        // The bearer token `tok` belongs to the app's user 1.
        container.instance(
          AccessTokenStore,
          accessTokenStore({ find: async (plainText) => (plainText === 'tok' ? { id: 1, userId: 1, name: 'test', abilities: ['*'], lastUsedAt: null, expiresAt: null, createdAt: '' } : undefined) }),
        );
      },
    },
  );
  const hash = await application.container.make(Hasher).make('secret');
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, hash);
  office.add({ id: 2, name: 'Office Bob', email: 'bob@example.com' }, hash);
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const browser = () => {
    const jar = new Map<string, string>();
    const call = async (path: string, headers: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: headers['x-guard'] ? 'POST' : 'GET', headers: { cookie, accept: 'application/json', 'user-agent': 'Test Browser', ...headers }, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return { call };
  };
  /** A browser signed in to the app and/or to the office (as Ada, or as Bob with `bob`). */
  const signedIn = async (...who: ('app' | 'office' | 'bob')[]) => {
    const b = browser();
    for (const guard of who) {
      const login = await b.call('/act', { 'x-guard': guard === 'app' ? 'app' : 'office', 'x-email': guard === 'bob' ? 'bob@example.com' : 'ada@example.com' });
      expect(((await login.json()) as { ok: boolean }).ok, guard).toBe(true);
    }
    return b;
  };
  return { application, warnings, signedIn };
}

/** What each way of asking answers when the gate says no: an error other than the 403's (a throwing policy or projection, A8) matches none of these. */
const denied = (how: string, ability: string): Record<string, unknown> =>
  ({
    allows: { allowed: false },
    inspect: { allowed: false },
    authorize: { error: 'This action is unauthorized.' },
    abilities: { can: { [ability]: false } },
    rows: { rows: [{ user_id: 1, can: { [ability]: false } }] },
  })[how]!;

const json = async (response: Response) => (await response.json()) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a policy of the app on a route of a package guard', () => {
  it('says no to authorize() and to the gate, never yes, and never asks the app\'s user', async () => {
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { signedIn, application, warnings } = await running();
    // The app's user 1 owns the post: asked about them, the policy would say yes.
    const both = await signedIn('app', 'office');
    expect((await both.call('/o/app-policy')).status).toBe(403);
    for (const how of ['allows', 'inspect', 'authorize', 'abilities', 'rows']) {
      const body = await json(await both.call('/o/ask', { 'x-how': how }));
      expect(body, how).toEqual(denied(how, 'update'));
    }
    expect((await json(await both.call('/o/ask', { 'x-how': 'denies' }))).denied).toBe(true);
    expect(current.seen.app, 'the app\'s policy never saw anybody').toEqual([]);
    expect(current.seen.built, 'not built: no before() either').toBe(0);
    expect(warnings.length, 'once per policy and guard').toBe(1);
    expect(warnings[0]).toMatch(/A9.*'web'.*'office'/s);
    await application.shutdown();
  });

  it('is judged on its own guard where no guard names the route: the page of the app\'s user is the user\'s, and the editor is no one', async () => {
    current = policies();
    const { signedIn, application } = await running();
    const editorOnly = await signedIn('office');
    expect(await json(await editorOnly.call('/public')), 'the app\'s policy does not see the editor').toEqual({ allowed: false });
    const both = await signedIn('app', 'office');
    expect(await json(await both.call('/public'))).toEqual({ allowed: true });
    expect(current.seen.app).toHaveLength(1);
    expect(current.seen.app[0]).toMatchObject({ id: 1, name: 'App Ada' });
    await application.shutdown();
  });
});

describe('a route behind the token guard', () => {
  it('asks the policy of the app about the token\'s user, and a policy of a guard says no without loading the editor', async () => {
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { signedIn, application, warnings } = await running();
    // The browser also carries the editor's session: the token still decides which guard the route is.
    const both = await signedIn('app', 'office');
    const loaded = vi.spyOn(office, 'findById');
    const bearer = { authorization: 'Bearer tok' };
    expect(await json(await both.call('/api/ask', { ...bearer, 'x-policy': 'app' }))).toEqual({ allowed: true });
    expect(current.seen.app[0]).toMatchObject({ id: 1, name: 'App Ada' });
    expect(await json(await both.call('/api/ask', { ...bearer, 'x-policy': 'page' }))).toEqual({ allowed: false });
    expect(loaded, 'the editor of the same id was not loaded').not.toHaveBeenCalled();
    expect(current.seen).toMatchObject({ page: [], before: [] });
    expect(warnings.join('\n')).toMatch(/A9.*'office'.*'api'/s);
    await application.shutdown();
  });
});

describe('a policy of a guard', () => {
  it('says no on a route of the app, loads no editor and builds no policy', async () => {
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { signedIn, application, warnings } = await running();
    const both = await signedIn('app', 'office');
    const loaded = vi.spyOn(office, 'findById');
    expect((await both.call('/a/admin')).status).toBe(403);
    for (const how of ['allows', 'inspect', 'authorize', 'abilities', 'rows']) {
      const body = await json(await both.call('/a/ask', { 'x-policy': 'page', 'x-how': how }));
      expect(body, how).toEqual(denied(how, 'edit'));
    }
    expect((await json(await both.call('/a/ask', { 'x-policy': 'page', 'x-how': 'denies' }))).denied).toBe(true);
    expect(loaded, 'the editor of the same id was not loaded').not.toHaveBeenCalled();
    expect(current.seen).toMatchObject({ page: [], before: [], built: 0 });
    expect(warnings.join('\n')).toMatch(/A9.*'office'.*'web'/s);
    await application.shutdown();
  });

  it('judges the editor on a public page, and no one without a sign-in to the guard', async () => {
    current = policies();
    const { signedIn, application } = await running();
    const editor = await signedIn('office');
    expect(await json(await editor.call('/public', { 'x-policy': 'page' }))).toEqual({ allowed: true });
    expect(current.seen.page[0]).toMatchObject({ id: 1, name: 'Office Ada' });
    expect(current.seen.before[0]).toMatchObject({ id: 1, name: 'Office Ada' });
    const appOnly = await signedIn('app');
    expect(await json(await appOnly.call('/public', { 'x-policy': 'page' })), 'the app\'s user 1 is not the editor 1').toEqual({ allowed: false });
    expect(current.seen.page).toHaveLength(1);
    // A subclass of a policy of a guard judges that guard's users.
    expect(await json(await editor.call('/public', { 'x-policy': 'senior' }))).toEqual({ allowed: true });
    await application.shutdown();
  });

  it('judges the editor of its own guard on a route of the guard: allowed for the owner, refused for another editor, next to a global policy middleware', async () => {
    current = policies();
    const { signedIn, application } = await running();
    const ada = await signedIn('app', 'office');
    const bob = await signedIn('bob');
    expect((await ada.call('/o/page', { 'x-early': 'yes' })).status).toBe(200);
    expect((await bob.call('/o/page', { 'x-early': 'yes' })).status).toBe(403);
    expect(await json(await ada.call('/o/ask', { 'x-policy': 'page', 'x-how': 'authorize', 'x-early': 'yes' }))).toEqual({ allowed: true });
    expect(await json(await bob.call('/o/ask', { 'x-policy': 'page', 'x-how': 'inspect' }))).toEqual({ allowed: false });
    expect(current.seen.before.map((user) => user.name)).toEqual(['Office Ada', 'Office Bob', 'Office Ada', 'Office Bob']);
    await application.shutdown();
  });

  it('projects the editor\'s abilities as props of a package page, and false for a policy of the app', async () => {
    current = policies();
    vi.stubEnv('NODE_ENV', 'development');
    const { signedIn, application, warnings } = await running();
    const both = await signedIn('app', 'office');
    expect(await json(await both.call('/o/ask', { 'x-policy': 'page', 'x-how': 'abilities' }))).toEqual({ can: { edit: true } });
    expect(await json(await both.call('/o/ask', { 'x-policy': 'page', 'x-how': 'rows' }))).toEqual({ rows: [{ user_id: 1, can: { edit: true } }] });
    expect(await json(await both.call('/o/ask', { 'x-policy': 'app', 'x-how': 'abilities' })), 'false, not an error').toEqual({ can: { update: false } });
    expect(warnings.join('\n')).toContain('Gate.abilities()');
    await application.shutdown();
  });

  it('keeps a global policy of the app and "edit this page" of the guard apart on a public page', async () => {
    current = policies();
    const { signedIn, application, warnings } = await running();
    vi.stubEnv('NODE_ENV', 'development');
    const both = await signedIn('app', 'office');
    // The global middleware asks the app's policy first; nothing stamps the route, so the controller's policy still asks its own guard.
    const response = await both.call('/public', { 'x-policy': 'page', 'x-early': 'yes' });
    expect(await json(response)).toEqual({ allowed: true });
    expect(current.seen.app[0]).toMatchObject({ name: 'App Ada' });
    expect(current.seen.page[0]).toMatchObject({ name: 'Office Ada' });
    expect(warnings, 'no warning: nothing named the route').toEqual([]);
    await application.shutdown();
  });
});

describe('a static guard that is no registered guard', () => {
  it.each(['string', 'ghost'])('is error A8 at the first use (%s): no policy built, nobody loaded', async (policy) => {
    current = policies();
    const { signedIn, application } = await running();
    const both = await signedIn('app', 'office');
    const loaded = vi.spyOn(office, 'findById');
    for (const how of ['allows', 'inspect', 'authorize', 'abilities', 'rows', 'denies']) {
      const body = await json(await both.call('/public', { 'x-policy': policy, 'x-how': how }));
      expect(body.error, how).toMatch(/A8/);
    }
    // Also on a route that would have answered no: A8 comes before the route's guard.
    expect((await json(await both.call('/a/ask', { 'x-policy': policy }))).error).toMatch(/A8/);
    expect(loaded).not.toHaveBeenCalled();
    expect(current.seen.built).toBe(0);
    await application.shutdown();
  });
});
