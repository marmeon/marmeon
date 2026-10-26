import { CacheServiceProvider } from '@marmeon/cache';
import { createApplication, defineModule, type Container } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AuthServiceProvider, Hasher, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users implements UserProvider {
  hash: PasswordHash | null = null;
  key: string | null = null;
  async findById(id: number): Promise<Credentials | undefined> {
    return id === 1 ? { user: ada, passwordHash: this.hash, sessionKey: this.key } : undefined;
  }
  async findForSignIn(): Promise<Credentials | undefined> {
    return this.findById(1);
  }
  async updatePasswordHash(_id: number, hash: PasswordHash, options: { readonly expected?: PasswordHash; readonly sessionKey?: string } = {}): Promise<boolean> {
    if (options.expected !== undefined && this.hash !== options.expected) return false;
    this.hash = hash;
    if (options.sessionKey !== undefined) this.key = options.sessionKey;
    return true;
  }
  async updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number }> {
    this.key = key;
    return { accounts: 1, sampleId: 1 };
  }
  async updateSessionKey(_id: number, key: string): Promise<boolean> {
    this.key = key;
    return true;
  }
}

class Act extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext<{}, { action: string }>) {
    try {
      switch (ctx.params.action) {
        // A session the app signed in without a password: a cookie somebody else holds, say.
        case 'as':
          await this.#auth.signIn(ada);
          return { ok: true };
        case 'confirm':
          return { ok: (await this.#auth.checkPassword('secret')).ok };
        case 'confirm-wrong':
          return { ok: (await this.#auth.checkPassword('not the password')).ok };
        case 'password':
          await this.#auth.updatePassword('a new password');
          return { ok: true };
        case 'who':
          return { id: (await this.#auth.user())?.id ?? null };
        default:
          return { unknown: true };
      }
    } catch (error) {
      return { threw: (error as Error).message };
    }
  }
}

const routes = openRoutes((Route) => {
  Route.post('/act/:action', Act);
});

async function boot() {
  const users = new Users();
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'password-confirmation-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
    },
  });
  await application.container.make(Migrator).migrate();
  users.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  const browser = (jar: Map<string, string> = new Map()) => {
    const act = async (action: string): Promise<Record<string, unknown>> => {
      const response = await kernel.request(`/act/${action}`, { method: 'POST', headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'application/json' } });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
        else jar.set(name, value);
      }
      return (await response.json()) as Record<string, unknown>;
    };
    return { act, jar };
  };
  return { browser, users };
}

describe('Auth: a new password needs a fresh proof', () => {
  it('a session that only authenticated cannot change the password', async () => {
    const { browser, users } = await boot();
    const stolen = browser();
    await stolen.act('as');
    const before = users.hash;
    expect(await stolen.act('password')).toEqual({ threw: expect.stringMatching(/updatePassword\(\) needs a recent confirmation.*confirmedPassword\(\)/s) });
    expect(users.hash).toBe(before);
    expect(users.key).toBeNull();
  });

  it('changes it after the password was confirmed', async () => {
    const { browser, users } = await boot();
    const owner = browser();
    await owner.act('as');
    expect(await owner.act('confirm')).toEqual({ ok: true });
    const before = users.hash;
    expect(await owner.act('password')).toEqual({ ok: true });
    expect(users.hash).not.toBe(before);
    expect(await owner.act('who')).toEqual({ id: 1 });
  });
});

describe('Auth: checkPassword() starts a new session', () => {
  it('the id the session had before the check signs nobody in', async () => {
    const { browser } = await boot();
    const owner = browser();
    await owner.act('as');
    const before = new Map(owner.jar);
    expect(await owner.act('who')).toEqual({ id: 1 });
    expect(await owner.act('confirm')).toEqual({ ok: true });
    expect(owner.jar.get('marmeon_session'), 'a new session cookie').not.toBe(before.get('marmeon_session'));
    expect(await owner.act('who')).toEqual({ id: 1 });
    expect(await browser(before).act('who')).toEqual({ id: null });
  });

  it('a wrong password keeps the session as it was', async () => {
    const { browser } = await boot();
    const owner = browser();
    await owner.act('as');
    const before = new Map(owner.jar);
    expect(await owner.act('confirm-wrong')).toEqual({ ok: false });
    expect(await browser(before).act('who')).toEqual({ id: 1 });
    expect(await owner.act('who')).toEqual({ id: 1 });
  });
});
