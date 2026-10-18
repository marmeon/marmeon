import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider, RateLimiter } from '@marmeon/cache';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AuthServiceProvider, Hasher, UserProvider, type AuthUser, type PasswordHash } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.login(ada); // not a typed password: the account's cap applies to this sign-in
    return { ok: true };
  }
}

class AttemptController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { ok: (await this.#auth.attempt('ada@example.com', 'secret')).ok }; // a typed password
  }
}

class CheckController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { password } = (await ctx.input()) as { password: string };
    const checked = await this.#auth.checkPassword(password);
    return { checked: checked.ok ? 'ok' : checked.error, confirmed: this.#auth.passwordRecentlyConfirmed(900) };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/attempt', AttemptController);
  Route.post('/check', CheckController);
});

async function boot() {
  const users = new MemoryUsers<AuthUser>();
  users.add(ada);
  const verified: string[] = [];
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'auth-check-password-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      // Counts the hash checks: a held-up check must not make one.
      const hasher = container.make(Hasher);
      container.instance(Hasher, {
        make: hasher.make.bind(hasher),
        needsRehash: hasher.needsRehash.bind(hasher),
        dummyVerify: hasher.dummyVerify.bind(hasher),
        failureFloorMs: hasher.failureFloorMs.bind(hasher),
        verify: (password: string, hash: PasswordHash) => {
          verified.push(password);
          return hasher.verify(password, hash);
        },
      } as Hasher);
    },
  });
  await application.container.make(Migrator).migrate();
  users.rows.get(ada.id)!.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  /** A browser with its own cookies: signed in by `login()` (no typed password), or not at all. */
  const browser = async (signedIn: boolean | 'typed') => {
    const jar = new Map<string, string>();
    const send = async (path: string, body?: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        jar.set(name, value);
      }
      return response;
    };
    if (signedIn === 'typed') await send('/attempt');
    else if (signedIn) await send('/login');
    const check = async (password: string) => (await (await send('/check', { password })).json()) as { checked: unknown; confirmed: boolean };
    return { check, send };
  };
  return { browser, verified, limiter: () => application.container.make(RateLimiter) };
}

describe('Auth.checkPassword()', () => {
  it('accepts the right password and notes the confirmation', async () => {
    const { browser } = await boot();
    const { check } = await browser(true);
    expect(await check('secret')).toEqual({ checked: 'ok', confirmed: true });
  });

  it('answers invalid-password for a wrong one, without a confirmation', async () => {
    const { browser } = await boot();
    const { check } = await browser(true);
    expect(await check('wrong')).toEqual({ checked: { kind: 'invalid-password' }, confirmed: false });
  });

  it('holds up the sixth check of a minute without hashing, also with the right password', async () => {
    const { browser, verified } = await boot();
    const { check } = await browser(true);
    for (let i = 0; i < 5; i++) expect(await check('wrong')).toMatchObject({ checked: { kind: 'invalid-password' } });
    expect(verified).toHaveLength(5);
    const held = await check('secret');
    expect(held).toMatchObject({ checked: { kind: 'throttled' }, confirmed: false });
    expect((held.checked as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    expect(verified, 'nothing was hashed for the held-up check').toHaveLength(5);
  });

  it('clears the sign-in minute with a right password', async () => {
    const { browser } = await boot();
    const { check } = await browser(true);
    for (let i = 0; i < 4; i++) await check('wrong');
    expect(await check('secret')).toMatchObject({ checked: 'ok' });
    for (let i = 0; i < 4; i++) expect(await check('wrong')).toMatchObject({ checked: { kind: 'invalid-password' } });
  });

  it('caps the account across sign-ins that did not begin with a typed password', async () => {
    const { browser } = await boot();
    for (let session = 0; session < 4; session++) {
      const { check } = await browser(true);
      for (let i = 0; i < 5; i++) await check('wrong'); // five a minute for each sign-in: twenty in all
    }
    const { check } = await browser(true);
    expect(await check('secret')).toMatchObject({ checked: { kind: 'throttled', account: true } });
  });

  it('caps the account at a hundred checks a day across all its sign-ins, typed password or not', async () => {
    const { browser, limiter } = await boot();
    for (let i = 0; i < 100; i++) await limiter().hit('password-check-day:account:1', 86_400);
    for (const signedIn of [true, 'typed'] as const) {
      const { check } = await browser(signedIn);
      expect(await check('secret')).toMatchObject({ checked: { kind: 'throttled', account: true } });
    }
  });

  it('counts an empty password as nothing', async () => {
    const { browser, verified } = await boot();
    const { check } = await browser(true);
    for (let i = 0; i < 10; i++) expect(await check('')).toMatchObject({ checked: { kind: 'invalid-password' } });
    expect(await check('secret')).toMatchObject({ checked: 'ok' });
    expect(verified).toEqual(['secret']);
  });

  it('throws on a route without a signed-in user', async () => {
    const { browser } = await boot();
    const { send } = await browser(false);
    expect((await send('/check', { password: 'secret' })).status).toBe(500);
  });
});

describe('Signing in without a rate limiter', () => {
  const bootWithout = (bindUsers: boolean) =>
    createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    }, {
      env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', LOG_LEVEL: 'silent', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => {
        if (bindUsers) container.instance(UserProvider, new MemoryUsers<AuthUser>() as UserProvider);
      },
    });

  it('stops the boot of an app with a UserProvider and names the missing package', async () => {
    await expect(bootWithout(true)).rejects.toThrow(/A7.*@marmeon\/cache/s);
  });

  it('leaves an app without authentication alone', async () => {
    await expect(bootWithout(false)).resolves.toBeDefined();
  });
});
