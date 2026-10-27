import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { cacheControl, Controller, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionConfig, sessionCookieName, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AuthServiceProvider, UserProvider, type AuthUser } from './index.ts';
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
    await this.#auth.signIn(ada, { remember: false });
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
    return { id: (await this.#auth.user())?.id ?? null };
  }
}

/** A guest's first session data (a failed form, a cart): the guest's session is kept from now on. */
class RememberController extends Controller {
  readonly #session: Session;
  constructor(session: Session) {
    super();
    this.#session = session;
  }
  handle() {
    this.#session.put('visits' as never, 1 as never);
    return { ok: true };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/remember', RememberController);
  Route.get('/who', WhoController);
  // A page that holds nothing of the user, cached publicly as the docs allow for such pages.
  Route.middleware(cacheControl('public, max-age=300')).get('/pricing', () => ({ plans: ['basic', 'pro'] }));
});

async function boot() {
  const users = new MemoryUsers<AuthUser>();
  users.add(ada);
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'auth-public-cache-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
    },
  });
  await application.container.make(Migrator).migrate();
  const kernel = createHttpKernel(application);
  const cookieName = sessionCookieName(application.container.make(SessionConfig));
  /** A browser: its own cookie jar. */
  const browser = () => {
    const jar = new Map<string, string>();
    const send = async (path: string, method = 'GET', extra: Record<string, string> = {}) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method, headers: { cookie, accept: 'application/json', ...extra }, redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const index = pair!.indexOf('=');
        jar.set(pair!.slice(0, index), pair!.slice(index + 1));
      }
      return response;
    };
    return { send, jar };
  };
  return { browser, cookieName };
}

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split('=')[0]);

describe('cacheControl(public) and the session', () => {
  it('a sessionless guest keeps the public answer, without cookies', async () => {
    const { browser } = await boot();
    const response = await browser().send('/pricing');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('a guest with a kept session gets a private answer', async () => {
    const { browser, cookieName } = await boot();
    const guest = browser();
    await guest.send('/remember', 'POST');
    const first = await guest.send('/pricing');
    const second = await guest.send('/pricing');
    for (const response of [first, second]) {
      expect(response.headers.get('cache-control')).toBe('private, max-age=300');
      expect(cookiesOf(response)).not.toContain(cookieName);
    }
  });

  it('a signed-in user never gets a public answer, and the session cookie goes out only with a new id', async () => {
    const { browser, cookieName } = await boot();
    const user = browser();
    const login = await user.send('/login', 'POST');
    expect(cookiesOf(login)).toContain(cookieName);
    const first = await user.send('/pricing');
    const second = await user.send('/pricing');
    for (const response of [first, second]) {
      expect(response.headers.get('cache-control')).toBe('private, max-age=300');
      expect(response.headers.get('cache-control')).not.toContain('public');
      expect(cookiesOf(response)).not.toContain(cookieName);
      expect(cookiesOf(response)).not.toContain('XSRF-TOKEN');
    }
  });

  it('an answer a shared cache may store carries no session cookie, so replaying it signs nobody in', async () => {
    const { browser, cookieName } = await boot();
    const user = browser();
    await user.send('/login', 'POST');
    const stranger = browser();
    for (const response of [await user.send('/pricing'), await user.send('/pricing'), await user.send('/who')]) {
      const storable = /public|s-maxage/.test(response.headers.get('cache-control') ?? '');
      if (storable) expect(cookiesOf(response)).not.toContain(cookieName);
      for (const header of response.headers.getSetCookie()) {
        if (!header.startsWith(`${cookieName}=`)) continue;
        expect(storable).toBe(false);
      }
    }
    const who = await stranger.send('/who');
    expect(await who.json()).toEqual({ id: null });
  });
});
