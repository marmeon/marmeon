import { Clock, createApplication, defineModule, type Container } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AUTH_SESSION_KEYS, AuthServiceProvider, authenticate, Hasher, TwoFactorState, UserProvider, type AuthUser, type Credentials, type PasswordHash } from './index.ts';
import { confirmedSecondFactor } from './two-factor/confirmed.ts';
import { twoFactor } from './two-factor/middleware.ts';
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

class LoginController extends Controller {
  readonly #auth: Auth;
  protected remember = true;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.login(ada, { remember: this.remember });
    return { ok: true };
  }
}

class LoginOnceController extends LoginController {
  protected override remember = false;
}

class ConfirmController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { confirmed: await this.#auth.confirmPassword('secret') };
  }
}

class StateController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { id: (await this.#auth.user())?.id ?? null, confirmed: this.#auth.passwordRecentlyConfirmed(900) };
  }
}

/** Notes a proven factor the way `TwoFactor` does, on the app's clock. */
class ProveController extends Controller {
  readonly #session: Session;
  readonly #clock: Clock;
  constructor(session: Session, clock: Clock) {
    super();
    this.#session = session;
    this.#clock = clock;
  }
  async handle() {
    this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, Math.floor(this.#clock.now() / 1000));
    return { ok: true };
  }
}

/** Dates the sign-in's proofs relative to the app's clock, in seconds; what a node with another clock would have written. */
const stamps: { confirmedAt?: number; twoFactorAt?: number } = {};

class StampController extends Controller {
  readonly #session: Session;
  readonly #clock: Clock;
  constructor(session: Session, clock: Clock) {
    super();
    this.#session = session;
    this.#clock = clock;
  }
  async handle() {
    const now = Math.floor(this.#clock.now() / 1000);
    if (stamps.confirmedAt !== undefined) this.#session.put(AUTH_SESSION_KEYS.confirmedAt, now + stamps.confirmedAt);
    if (stamps.twoFactorAt !== undefined) this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, now + stamps.twoFactorAt);
    return { ok: true };
  }
}

class Page extends Controller {
  async handle() {
    return { page: true };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/login-once', LoginOnceController);
  Route.post('/confirm', ConfirmController);
  Route.post('/prove', ProveController);
  Route.post('/stamp', StampController);
  Route.get('/state', StateController);
  Route.get('/setup', Page).name('test.setup');
  Route.get('/verify', Page).name('test.verify');
  Route.middleware(authenticate()).middleware(twoFactor({ setup: 'test.setup', verify: 'test.verify', maxAge: 600 })).get('/area', Page);
  Route.middleware(authenticate()).middleware(confirmedSecondFactor({ verify: 'test.verify' })).get('/factors', Page);
});

async function boot(env: Record<string, string> = {}) {
  const users = new Users();
  const clock = new TestClock();
  // Switched on after the sign-in: the sign-in itself must not stop at a second factor.
  const hasFactor = { on: false };
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'auth-clock-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(Clock, clock);
      container.instance(UserProvider, users as UserProvider);
      container.instance(TwoFactorState, { factors: async () => (hasFactor.on ? [{ kind: 'totp' }] : []), enabledSince: async () => undefined } as never);
    },
  });
  await application.container.make(Migrator).migrate();
  users.hash = await application.container.make(Hasher).make('secret');
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  const send = async (path: string, method = 'GET') => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { method, headers: { cookie, accept: 'application/json' }, redirect: 'manual' });
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      if (value === '' || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  return { application, clock, send, jar, hasFactor };
}

describe('Auth on the app clock', () => {
  it('ages a password confirmation with the test clock', async () => {
    const { clock, send } = await boot();
    await send('/login', 'POST');
    await send('/confirm', 'POST');
    expect(await (await send('/state')).json()).toEqual({ id: 1, confirmed: true });
    clock.travel({ minutes: 14 });
    expect(await (await send('/state')).json()).toEqual({ id: 1, confirmed: true });
    clock.travel({ minutes: 2 });
    expect(await (await send('/state')).json()).toEqual({ id: 1, confirmed: false });
  });

  it('ages the proof of a second factor behind twoFactor()', async () => {
    const { clock, send, hasFactor } = await boot();
    await send('/login', 'POST');
    hasFactor.on = true;
    expect((await send('/area')).status, 'no proof yet').toBe(403);
    await send('/prove', 'POST');
    expect((await send('/area')).status).toBe(200);
    clock.travel({ minutes: 11 });
    expect((await send('/area')).status, 'past maxAge').toBe(403);
  });

  it('ages the proof that confirmedSecondFactor() asks for', async () => {
    const { clock, send, hasFactor } = await boot();
    await send('/login', 'POST');
    hasFactor.on = true;
    await send('/prove', 'POST');
    expect((await send('/factors')).status).toBe(200);
    clock.travel({ minutes: 14 });
    expect((await send('/factors')).status).toBe(200);
    clock.travel({ minutes: 2 });
    expect((await send('/factors')).status).toBe(403);
  });

  it('ends a sign-in past AUTH_SESSION_MAX_HOURS', async () => {
    const { clock, send } = await boot({ AUTH_SESSION_MAX_HOURS: '2' });
    await send('/login-once', 'POST');
    clock.travel({ hours: 1 });
    expect(await (await send('/state')).json()).toMatchObject({ id: 1 });
    clock.travel({ hours: 1, minutes: 5 });
    expect(await (await send('/state')).json()).toMatchObject({ id: null });
  });

  it('refuses a remember-me token past AUTH_REMEMBER_DAYS from its creation', async () => {
    const { application, clock, send, jar } = await boot({ AUTH_REMEMBER_DAYS: '5' });
    await send('/login', 'POST');
    expect(jar.get('remember_web')).toBeDefined();
    // The token itself outlives the cap (as if issued under a longer setting), so only the cap in `Auth` can refuse it.
    await application.container.make(Connections).get<any>().updateTable('remember_tokens').set({ expires_at: new Date(clock.now() + 30 * 86_400_000) }).execute();
    clock.travel({ days: 4 });
    jar.delete('marmeon_session');
    expect(await (await send('/state')).json(), 'inside the cap').toMatchObject({ id: 1 });
    clock.travel({ days: 2 });
    jar.delete('marmeon_session');
    expect(await (await send('/state')).json(), 'past the cap').toMatchObject({ id: null });
  });

  describe('clock skew', () => {
    const confirmed = async (send: (path: string, method?: string) => Promise<Response>) => ((await (await send('/state')).json()) as { confirmed: boolean }).confirmed;

    it('accepts a confirmation up to a minute ahead and refuses one beyond', async () => {
      for (const [offset, accepted] of [[30, true], [59, true], [61, false], [3600, false]] as const) {
        const { send } = await boot();
        await send('/login', 'POST');
        stamps.confirmedAt = offset;
        await send('/stamp', 'POST');
        expect(await confirmed(send), `${offset} s ahead`).toBe(accepted);
      }
      delete stamps.confirmedAt;
    });

    it('does not stretch the window of a confirmation that lies in the past', async () => {
      const { clock, send } = await boot();
      await send('/login', 'POST');
      await send('/confirm', 'POST');
      clock.travel({ seconds: 899 });
      expect(await confirmed(send), 'last second of the window').toBe(true);
      clock.travel({ seconds: 2 });
      expect(await confirmed(send), 'window over').toBe(false);
    });

    it('accepts a confirmation dated up to a minute before the sign-in and refuses one from 5 minutes before', async () => {
      for (const [offset, accepted] of [[-30, true], [-59, true], [-61, false], [-300, false]] as const) {
        const { send } = await boot();
        await send('/login', 'POST');
        stamps.confirmedAt = offset;
        await send('/stamp', 'POST');
        expect(await confirmed(send), `${offset} s`).toBe(accepted);
      }
      delete stamps.confirmedAt;
    });

    it('accepts the proof of a second factor up to a minute ahead and refuses one beyond', async () => {
      for (const [offset, accepted] of [[30, true], [59, true], [61, false], [3600, false]] as const) {
        const { send, hasFactor } = await boot();
        await send('/login', 'POST');
        hasFactor.on = true;
        stamps.twoFactorAt = offset;
        await send('/stamp', 'POST');
        expect((await send('/factors')).status, `${offset} s ahead`).toBe(accepted ? 200 : 403);
      }
      delete stamps.twoFactorAt;
    });
  });
});
