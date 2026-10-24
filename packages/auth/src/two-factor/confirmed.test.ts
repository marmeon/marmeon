import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider } from '@marmeon/session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticate, Auth, AuthServiceProvider, Hasher, TwoFactorState, UserProvider, type PasswordHash } from '../index.ts';
import { openRoutes } from '../test-helpers/open-routes.ts';
import { twoFactorState } from '../test-helpers/stores.ts';
import { MemoryUsers as SharedUsers } from '../test-helpers/users.ts';
import { confirmedSecondFactor } from './confirmed.ts';

interface TestUser {
  id: number;
  name: string;
  email: string;
}

declare module '../user.ts' {
  interface AuthTypes {
    user: TestUser;
  }
}

const ada: TestUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class MemoryUsers extends SharedUsers<TestUser> {
  constructor() {
    super();
    this.add(ada);
  }
  /** The password of the one account. */
  set hash(hash: PasswordHash | null) {
    this.rows.get(ada.id)!.hash = hash;
  }
}

class Page extends Controller {
  handle() {
    return { page: true };
  }
}

class SignIn extends Controller {
  readonly #auth: Auth;
  readonly #session: Session;
  constructor(auth: Auth, session: Session) {
    super();
    this.#auth = auth;
    this.#session = session;
  }
  async handle(ctx: HttpContext) {
    const { proof } = (await ctx.input()) as { proof?: unknown };
    await this.#auth.signIn(ada);
    if (proof !== undefined) this.#session.put('_auth_two_factor_at', proof as never);
    return { signedIn: true };
  }
}

const routes = openRoutes((Route) => {
  Route.get('/login', Page).name('auth.login');
  Route.get('/verify', Page).name('test.verify');
  Route.post('/sign-in', SignIn);
  Route.middleware(authenticate()).middleware(confirmedSecondFactor({ verify: 'test.verify' })).get('/factors', Page);
  Route.middleware(authenticate()).middleware(confirmedSecondFactor({ verify: 'test.verify' })).post('/factors', Page);
  Route.middleware(confirmedSecondFactor({ verify: 'test.verify' }) as never).get('/bare', Page);
});

let factors: ('totp' | 'passkey')[] = [];
const NOW = 1_800_000_000;

async function boot() {
  const users = new MemoryUsers();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'confirmed-test', routes, migrations: new URL('../__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), APP_NAME: 'Acme', SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      container.instance(TwoFactorState, twoFactorState({ factors: async () => factors }));
    },
  });
  await application.container.make(Migrator).migrate();
  users.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  const call = async (path: string, init: { method?: string; json?: boolean; body?: unknown } = {}) => {
    const response = await kernel.request(path, {
      method: init.method ?? 'GET',
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), ...(init.json ? { accept: 'application/json' } : {}), 'content-type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
    return { status: response.status, location: response.headers.get('location'), body: init.json ? ((await response.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined };
  };
  // Signs in while the account has no factor (a sign-in with one waits for it), then gives it one: a session from before the factor.
  const signIn = async (proof?: unknown, after: ('totp' | 'passkey')[] = []) => {
    factors = [];
    const answer = await call('/sign-in', { method: 'POST', body: { proof } });
    factors = after;
    return answer;
  };
  return { call, signIn };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: NOW * 1000 });
  factors = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('confirmedSecondFactor()', () => {
  it('lets an account without a factor through: its first factor needs only the password', async () => {
    const { call, signIn } = await boot();
    await signIn();
    expect((await call('/factors')).status).toBe(200);
  });

  it('lets a session with a factor proven lately through, up to fifteen minutes', async () => {
    const { call, signIn } = await boot();
    await signIn(NOW - 900, ['passkey']);
    expect((await call('/factors')).status).toBe(200);
  });

  it('sends a session with an old, missing or broken proof to verify', async () => {
    for (const proof of [NOW - 901, NOW - 25 * 3600, undefined, 'yesterday', NOW + 61]) {
      const { call, signIn } = await boot();
      await signIn(proof, ['totp']);
      const answer = await call('/factors?tab=1');
      expect(answer, String(proof)).toMatchObject({ status: 302, location: '/verify' });
    }
  });

  it('answers JSON clients with 403 and two_factor_unverified, also for a post', async () => {
    const { call, signIn } = await boot();
    await signIn(NOW - 3600, ['totp']);
    expect(await call('/factors', { json: true })).toMatchObject({ status: 403, body: { error: 'two_factor_unverified' } });
    expect(await call('/factors', { method: 'POST', json: true, body: {} })).toMatchObject({ status: 403, body: { error: 'two_factor_unverified' } });
  });

  it('answers a request without a user with 401 or the login page, never a pass', async () => {
    const { call } = await boot();
    expect(await call('/bare', { json: true })).toMatchObject({ status: 401 });
    expect(await call('/bare')).toMatchObject({ status: 302, location: '/login' });
  });
});
