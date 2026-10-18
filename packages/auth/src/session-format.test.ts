import { CacheServiceProvider } from '@marmeon/cache';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createApplication, defineModule, type Container } from '@marmeon/core';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider, SessionStore } from '@marmeon/session';
import { afterAll, describe, expect, it } from 'vitest';
import { Auth, authenticate, AuthServiceProvider, UserProvider, type AuthUser } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const FIXTURES = new URL('../../session/src/__fixtures__/formats/session-payload/', import.meta.url);
/** The fingerprints in the fixtures are HMACs under the key derived from this one — the public test key of the repository (`.env.test`). */
const FIXTURE_KEY = 'base64:J1THMmM0weaSNoc1xHnSWExHWTxE/5A9NwgE4YJajvY=';
const NEW = { expectedVersion: undefined, lifetimeSeconds: 600 };

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

class Users extends MemoryUsers<AuthUser> {
  constructor() {
    super();
    this.add(ada);
  }
}

class SignInController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { result: await this.#auth.login(ada) };
  }
}

class WhoController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    return { check: await this.#auth.check(), id: (await this.#auth.user())?.id ?? null };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/as-ada', SignInController);
  Route.get('/login', () => 'login').name('auth.login');
  Route.get('/who', WhoController);
  Route.middleware(authenticate()).get('/me', (ctx) => ({ id: ctx.user.id }));
  Route.middleware(authenticate()).post('/change', () => ({ changed: true }));
});

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A browser signed in as Ada, and the means to put another payload into the store entry its session lives in. */
async function signedIn(env: Record<string, string> = {}) {
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'session-format-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { NODE_ENV: 'test', APP_KEY: FIXTURE_KEY, ...env, SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:' },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, new Users());
    },
  });
  cleanups.push(async () => void (await application.shutdown?.()));
  await application.container.make(Migrator).migrate();
  const store = application.container.make(SessionStore);
  const keys: string[] = [];
  const write = store.write.bind(store);
  store.write = (key, data, options) => (keys.push(key), write(key, data, options));
  const kernel = createHttpKernel(application);
  const jar = new Map<string, string>();
  const send = async (path: string, method = 'GET') => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await kernel.request(path, { method, headers: { cookie, accept: 'application/json' } });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      jar.set(name, value);
    }
    return response;
  };
  await send('/as-ada', 'POST');
  // Only the session cookie counts here: a remember-me cookie would sign the browser in again by itself.
  const session = [...jar].filter(([name]) => name.includes('session'));
  jar.clear();
  for (const [name, value] of session) jar.set(name, value);
  const key = keys.at(-1)!;
  const replace = async (json: string) => {
    await store.destroy(key);
    await store.write(key, json, NEW);
    return (await store.read(key))!;
  };
  return { send, replace, store, key, jar };
}

describe('a signed-in session by its format', () => {
  it('signs Ada in through the session as the first version stored it, with the fingerprint of the account it holds — every fixture', async () => {
    const { send, replace } = await signedIn();
    expect(await (await send('/who')).json()).toEqual({ check: true, id: 1 });
    const fixtures = readdirSync(FIXTURES).filter((file) => /^v\d+-auth-fingerprint-v2/.test(file));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) {
      await replace(readFileSync(new URL(file, FIXTURES), 'utf8'));
      expect(await (await send('/who')).json(), file).toEqual({ check: true, id: 1 });
      expect((await send('/me')).status, file).toBe(200);
    }
  });

  it('makes Ada a guest under another APP_KEY, signs her in when the key is in APP_PREVIOUS_KEYS, and refuses a fingerprint without the key', async () => {
    const fixture = readFileSync(new URL('v1-auth-fingerprint-v2.json', FIXTURES), 'utf8');
    const other = generateKey();
    const rotated = await signedIn({ APP_KEY: other });
    await rotated.replace(fixture);
    expect(await (await rotated.send('/who')).json(), 'another key').toEqual({ check: false, id: null });
    const kept = await signedIn({ APP_KEY: other, APP_PREVIOUS_KEYS: FIXTURE_KEY });
    await kept.replace(fixture);
    expect(await (await kept.send('/who')).json(), 'the old key in APP_PREVIOUS_KEYS').toEqual({ check: true, id: 1 });
    // The SHA-256 of id and key that anybody can compute from the database: no key of the app, no match.
    const forged = JSON.parse(fixture) as Record<string, unknown>;
    forged._auth_password = createHash('sha256').update('marmeon-auth-session-v2:["1",null]').digest('base64url');
    const app = await signedIn();
    await app.replace(JSON.stringify(forged));
    expect(await (await app.send('/who')).json(), 'a fingerprint made without the key').toEqual({ check: false, id: null });
  });

  it('makes Ada a guest when the session holds the fingerprint of the release before — no transition, every sign-in ends once', async () => {
    const { send, replace } = await signedIn();
    const fixtures = readdirSync(FIXTURES).filter((file) => /^v\d+-auth\.json$/.test(file));
    expect(fixtures.length).toBeGreaterThan(0);
    for (const file of fixtures) {
      await replace(readFileSync(new URL(file, FIXTURES), 'utf8'));
      expect(await (await send('/who')).json(), file).toEqual({ check: false, id: null });
      expect((await send('/me')).status, file).toBe(401);
    }
  });

  it('makes Ada a guest when the session is of a newer format with a valid sign-in in it — and leaves the entry alone', async () => {
    const { send, replace, store, key } = await signedIn();
    const signedInPayload = JSON.parse(readFileSync(new URL('v1-auth-fingerprint-v2.json', FIXTURES), 'utf8')) as Record<string, unknown>;
    const before = await replace(JSON.stringify({ ...signedInPayload, _v: 3, _auth_reauth_only: true }));
    expect(await (await send('/who')).json()).toEqual({ check: false, id: null });
    expect((await send('/me')).status).toBe(401);
    expect((await send('/change', 'POST')).status).toBe(401);
    expect(await store.read(key)).toEqual(before);
  });

  it('makes Ada a guest when the session carries no mark (a session of the release before) with a valid sign-in in it', async () => {
    const { send, replace, store, key } = await signedIn();
    const { _v, ...unmarked } = JSON.parse(readFileSync(new URL('v1-auth-fingerprint-v2.json', FIXTURES), 'utf8')) as Record<string, unknown>;
    void _v;
    const before = await replace(JSON.stringify(unmarked));
    expect(await (await send('/who')).json()).toEqual({ check: false, id: null });
    expect((await send('/me')).status).toBe(401);
    expect(await store.read(key)).toEqual(before);
    // A mark that is not a whole number counts for nothing either.
    await replace(JSON.stringify({ ...unmarked, _v: '1' }));
    expect(await (await send('/who')).json()).toEqual({ check: false, id: null });
  });
});
