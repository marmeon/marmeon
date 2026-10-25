import { createHash } from 'node:crypto';
import { createApplication, defineModule, listen, type Container } from '@marmeon/core';
import { CacheServiceProvider, type RateLimiter } from '@marmeon/cache';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AuthConfig, AuthServiceProvider, authenticate, Hasher, SignInLockedOut, TwoFactorState, UserProvider, type AuthUser, type PasswordHash } from './index.ts';
import { SignInThrottle } from './sign-in-throttle.ts';
import type { Clock, Logger } from '@marmeon/core';
import { openRoutes } from './test-helpers/open-routes.ts';
import { twoFactorState } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const CEILING = 10; // the lowest AUTH_ACCOUNT_SIGN_INS_PER_DAY allows

const lockouts: SignInLockedOut[] = [];
class RecordLockout {
  handle(event: SignInLockedOut) {
    lockouts.push(event);
  }
}

class SpyUsers extends MemoryUsers<AuthUser> {
  lookups = 0;
  override async findForSignIn(identifier: string) {
    this.lookups++;
    return super.findForSignIn(identifier);
  }
}

class AttemptController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { email, password, ip, remember } = (await ctx.input()) as { email: string; password: string; ip: string; remember?: boolean };
    const result = await this.#auth.attempt(email, password, { ip, remember });
    if (!result.ok) return { ok: false, error: result.error };
    // As the starter kit does: the package names the cookie, the controller sets it.
    const device = await this.#auth.deviceCookie();
    if (device) ctx.cookies.set(device.name, device.value, device.options);
    return { ok: true };
  }
}

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle() {
    await this.#auth.signIn(ada); // not a typed password: a sign-in by other means (a passkey takes the same path)
    return { ok: true };
  }
}

const routes = openRoutes((Route) => {
  Route.post('/attempt', AttemptController);
  Route.post('/login', LoginController);
  Route.middleware(authenticate()).get('/me', () => ({ me: true }));
});

async function boot(env: Record<string, string> = {}, options: { factors?: boolean; floor?: number } = {}) {
  lockouts.length = 0;
  const users = new SpyUsers();
  const verified: string[] = [];
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'sign-in-throttle-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url), listeners: [listen(SignInLockedOut, RecordLockout)] })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory', ...env },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(UserProvider, users as UserProvider);
      if (options.factors) container.instance(TwoFactorState, twoFactorState({ factors: async () => ['totp'] }));
      // Counts the hash checks: a refused attempt must not make one.
      const hasher = container.make(Hasher);
      container.instance(Hasher, {
        make: hasher.make.bind(hasher),
        needsRehash: hasher.needsRehash.bind(hasher),
        dummyVerify: hasher.dummyVerify.bind(hasher),
        failureFloorMs: () => options.floor ?? 0,
        verify: (password: string, hash: PasswordHash) => {
          verified.push(password);
          return hasher.verify(password, hash);
        },
      } as Hasher);
    },
  });
  await application.container.make(Migrator).migrate();
  users.add(ada, await application.container.make(Hasher).make('secret'));
  const kernel = createHttpKernel(application);
  const post = async (path: string, body: unknown, cookie = '') => {
    const response = await kernel.request(path, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const cookies: Record<string, string> = {};
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, value] = pair!.split('=') as [string, string];
      if (value !== '') cookies[name] = value;
    }
    return { json: (await response.json()) as { ok: boolean; error?: { kind: string; retryAfterSeconds?: number; account?: true } }, response, cookies };
  };
  const header = (cookies: Record<string, string>) => Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; ');
  /** One attempt from the client `n` (every client its own address), with the cookies of a browser. */
  const signIn = (email: string, password: string, n = 1, cookies: Record<string, string> = {}, extra: object = {}) =>
    post('/attempt', { email, password, ip: `10.0.${Math.floor(n / 256)}.${n % 256}`, ...extra }, header(cookies));
  const attempt = (email: string, password: string, n = 1) => signIn(email, password, n).then((answer) => answer.json);
  /** `count` wrong passwords, each from a client of its own: no per-client limit is reached. */
  const spread = async (email: string, count: number, from = 100) => {
    for (let i = 0; i < count; i++) await attempt(email, 'wrong', from + i);
  };
  return { application, kernel, users, verified, attempt, signIn, spread, post, header, hash: () => application.container.make(Hasher).make('secret') };
}

describe('the limit per client and identifier', () => {
  it('holds up the sixth attempt of a minute before it reads the account or hashes anything, also with the right password', async () => {
    const { attempt, users, verified } = await boot();
    for (let i = 0; i < 5; i++) expect(await attempt(ada.email, 'wrong')).toEqual({ ok: false, error: { kind: 'invalid-credentials' } });
    expect(users.lookups).toBe(5);
    const held = await attempt(ada.email, 'secret');
    expect(held).toMatchObject({ ok: false, error: { kind: 'throttled' } });
    expect(held.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(held.error).not.toHaveProperty('account');
    expect(users.lookups, 'no lookup for the held-up attempt').toBe(5);
    expect(verified, 'no hash for the held-up attempt').toHaveLength(5);
    expect(lockouts.map((event) => [event.scope, event.identifier, event.ip])).toEqual([['client', ada.email, '10.0.0.1']]);
  });

  it('leaves another identifier and another client alone', async () => {
    const { attempt } = await boot();
    for (let i = 0; i < 5; i++) await attempt(ada.email, 'wrong');
    expect(await attempt('nobody@example.com', 'wrong')).toEqual({ ok: false, error: { kind: 'invalid-credentials' } });
    expect(await attempt(ada.email, 'secret', 2)).toEqual({ ok: true });
  });

  it('shares one count between spellings of an address', async () => {
    const { attempt } = await boot();
    for (const spelling of ['ADA@example.com', ' ada@example.com', 'Ada@Example.com ', 'ada@EXAMPLE.com', 'ada@example.com']) await attempt(spelling, 'wrong');
    expect(await attempt('aDa@example.com', 'wrong')).toMatchObject({ error: { kind: 'throttled' } });
  });

  it('starts the minute over after a right password', async () => {
    const { attempt } = await boot();
    for (let i = 0; i < 4; i++) await attempt(ada.email, 'wrong');
    expect(await attempt(ada.email, 'secret')).toEqual({ ok: true });
    for (let i = 0; i < 4; i++) await attempt(ada.email, 'wrong');
    expect(await attempt(ada.email, 'secret')).toEqual({ ok: true });
  });
});

describe('the ceiling per account', () => {
  const env = { AUTH_ACCOUNT_SIGN_INS_PER_DAY: String(CEILING) };

  it('refuses the attempt after the ceiling from any client, the right password included, without hashing', async () => {
    const { attempt, spread, users, verified } = await boot(env);
    await spread(ada.email, CEILING);
    expect(verified).toHaveLength(CEILING);
    const lookups = users.lookups;
    const held = await attempt(ada.email, 'secret', 200);
    expect(held).toMatchObject({ ok: false, error: { kind: 'throttled', account: true } });
    expect(held.error?.retryAfterSeconds).toBeGreaterThan(0);
    expect(users.lookups, 'one query, as for any attempt').toBe(lookups + 1);
    expect(verified, 'no hash for the refused attempt').toHaveLength(CEILING);
  });

  it('takes the default of a hundred', async () => {
    const { application } = await boot();
    expect(application.container.make(AuthConfig)).toMatchObject({ loginAttemptsPerMinute: 5, accountSignInsPerDay: 100 });
  });

  it('answers an identifier without an account exactly like one with an account', async () => {
    const { attempt, spread, users } = await boot(env);
    await spread(ada.email, CEILING);
    await spread('nobody@example.com', CEILING, 300);
    const known = await attempt(ada.email, 'secret', 500);
    const before = users.lookups;
    const unknown = await attempt('nobody@example.com', 'secret', 501);
    expect(unknown).toEqual({ ...known, error: { ...known.error, retryAfterSeconds: unknown.error?.retryAfterSeconds } });
    expect(users.lookups).toBe(before + 1);
    expect(lockouts.map((event) => [event.scope, event.identifier])).toEqual([['account', ada.email], ['account', 'nobody@example.com']]);
  });

  it('dispatches SignInLockedOut once per window, however many attempts are refused', async () => {
    const { attempt, spread } = await boot(env);
    await spread(ada.email, CEILING);
    for (let i = 0; i < 4; i++) await attempt(ada.email, 'wrong', 200 + i);
    expect(lockouts.filter((event) => event.scope === 'account')).toHaveLength(1);
  });

  it('starts over after a password sign-in of the owner', async () => {
    const { attempt, spread } = await boot(env);
    await spread(ada.email, CEILING - 1);
    expect(await attempt(ada.email, 'secret', 200)).toEqual({ ok: true });
    await spread(ada.email, CEILING, 300);
    expect(await attempt(ada.email, 'wrong', 500)).toMatchObject({ error: { kind: 'throttled', account: true } });
  });

  it('starts over after a sign-in by other means (signIn(), as a passkey does)', async () => {
    const { attempt, spread, post } = await boot(env);
    await spread(ada.email, CEILING);
    expect(await attempt(ada.email, 'secret', 200)).toMatchObject({ error: { kind: 'throttled', account: true } });
    await post('/login', {});
    expect(await attempt(ada.email, 'secret', 201)).toEqual({ ok: true });
  });

  it('starts over when the right password leads to a second factor', async () => {
    const { attempt, spread } = await boot(env, { factors: true });
    await spread(ada.email, CEILING - 1);
    expect(await attempt(ada.email, 'secret', 200)).toMatchObject({ error: { kind: 'two-factor-required' } });
    // Had the count not started over, these would take it past the ceiling and the right password would be refused.
    await spread(ada.email, CEILING - 1, 300);
    expect(await attempt(ada.email, 'secret', 500)).toMatchObject({ error: { kind: 'two-factor-required' } });
  });
});

describe('the device cookie of the owner\'s browser', () => {
  const env = { AUTH_ACCOUNT_SIGN_INS_PER_DAY: String(CEILING) };
  const DEVICE = 'marmeon_device';

  it('lets the browser that signed in with the password through a full ceiling, which stops everybody else', async () => {
    const { signIn, spread, users } = await boot(env);
    const owner = await signIn(ada.email, 'secret', 1);
    expect(owner.json).toEqual({ ok: true });
    expect(owner.cookies[DEVICE], 'a password sign-in hands out the cookie').toBeTruthy();
    await spread(ada.email, CEILING);
    expect((await signIn(ada.email, 'secret', 200)).json).toMatchObject({ error: { kind: 'throttled', account: true } });
    const lookups = users.lookups;
    expect((await signIn(ada.email, 'secret', 201, { [DEVICE]: owner.cookies[DEVICE]! })).json).toEqual({ ok: true });
    expect(users.lookups).toBe(lookups + 1);
  });

  it('counts the attempts of the cookie on a limit of its own, ten an hour, and then treats it as none', async () => {
    const { signIn, spread } = await boot(env);
    const owner = await signIn(ada.email, 'secret', 1);
    const cookies = { [DEVICE]: owner.cookies[DEVICE]! };
    await spread(ada.email, CEILING);
    for (let i = 0; i < 10; i++) expect((await signIn(ada.email, 'wrong', 300 + i, cookies)).json).toEqual({ ok: false, error: { kind: 'invalid-credentials' } });
    expect((await signIn(ada.email, 'secret', 400, cookies)).json).toMatchObject({ error: { kind: 'throttled', account: true } });
  });

  it('keeps the client limit for the browser with a cookie too', async () => {
    const { signIn } = await boot(env);
    const owner = await signIn(ada.email, 'secret', 1);
    const cookies = { [DEVICE]: owner.cookies[DEVICE]! };
    for (let i = 0; i < 5; i++) await signIn(ada.email, 'wrong', 7, cookies);
    expect((await signIn(ada.email, 'secret', 7, cookies)).json).toMatchObject({ error: { kind: 'throttled' } });
  });

  it('answers a forged, a foreign and a stale cookie like no cookie', async () => {
    const { signIn, spread, users, hash } = await boot(env);
    const alan: AuthUser = { id: 2, name: 'Alan', email: 'alan@example.com' };
    users.add(alan, await hash());
    const owner = await signIn(ada.email, 'secret', 1);
    const others = await signIn(alan.email, 'secret', 2);
    await spread(ada.email, CEILING);
    const good = owner.cookies[DEVICE]!;
    const forged = `${good.slice(0, -2)}${good.at(-2) === 'A' ? 'B' : 'A'}${good.slice(-1)}`;
    const none = (await signIn(ada.email, 'secret', 500)).json;
    expect(none).toMatchObject({ error: { kind: 'throttled', account: true } });
    for (const [name, value] of [['forged', forged], ['of another account', others.cookies[DEVICE]!], ['garbage', 'nonsense']] as const) {
      const answer = (await signIn(ada.email, 'secret', 501, { [DEVICE]: value })).json;
      expect(answer, name).toMatchObject({ ok: false, error: { kind: 'throttled', account: true } });
      expect(Object.keys(answer.error!).sort(), name).toEqual(Object.keys(none.error!).sort());
    }
    // A new session key (a new password, an ending of every session) makes the owner's cookie stale.
    users.rows.get(1)!.key = 'a-new-session-key-0123456789abcdef';
    expect((await signIn(ada.email, 'secret', 502, { [DEVICE]: good })).json).toMatchObject({ error: { kind: 'throttled', account: true } });
  });

  it('is not handed out when the setting is 0, and counts for nothing then', async () => {
    const { signIn } = await boot({ ...env, AUTH_DEVICE_COOKIE_DAYS: '0' });
    expect((await signIn(ada.email, 'secret', 1)).cookies[DEVICE]).toBeUndefined();
  });

  it('does not let a "keep me signed in" sign-in reset the count of a full ceiling', async () => {
    const { signIn, spread, kernel, header } = await boot(env);
    const owner = await signIn(ada.email, 'secret', 1, {}, { remember: true });
    expect(owner.cookies.marmeon_remember, 'the remember cookie came').toBeTruthy();
    await spread(ada.email, CEILING);
    const browser = { marmeon_remember: owner.cookies.marmeon_remember! };
    // The cookie signs in anew …
    const me = await kernel.request('/me', { headers: { cookie: header(browser), accept: 'application/json' } });
    expect(me.status).toBe(200);
    // … and the next password attempt is still held up.
    expect((await signIn(ada.email, 'secret', 600)).json).toMatchObject({ error: { kind: 'throttled', account: true } });
  });
});

describe('a refusal of the account', () => {
  it('waits as long as a wrong password does', async () => {
    const { attempt, spread } = await boot({ AUTH_ACCOUNT_SIGN_INS_PER_DAY: String(CEILING) }, { floor: 300 });
    await spread(ada.email, CEILING);
    const started = performance.now();
    expect(await attempt(ada.email, 'secret', 200)).toMatchObject({ error: { kind: 'throttled', account: true } });
    expect(performance.now() - started).toBeGreaterThanOrEqual(290);
  });
});

describe('SignInThrottle', () => {
  const fake = (clear: (key: string) => Promise<void> = async () => {}) => {
    const keys: string[] = [];
    const limiter = {
      attempt: async (key: string) => (keys.push(key), true),
      availableIn: async () => 1,
      clear: async (key: string) => {
        keys.push(key);
        await clear(key);
      },
    } as unknown as RateLimiter;
    return { keys, limiter };
  };
  const config = { loginAttemptsPerMinute: 5, accountSignInsPerDay: 100, deviceCookieDays: 90 };
  const session = { secure: false, sameSite: 'lax' } as never;
  let now = Date.UTC(2030, 0, 1);
  const clock = { now: () => now } as Clock;
  const logged: string[] = [];
  const logger = { error: (message: string) => void logged.push(message) } as unknown as Logger;
  const make = (limiter: RateLimiter, fill = 7, previousKeys: Uint8Array<ArrayBuffer>[] = [], settings = config) =>
    new SignInThrottle(limiter, { key: new Uint8Array(32).fill(fill), previousKeys }, settings, session, clock, logger);
  const credentials = (id: number, sessionKey: string | null = 'key-one') => ({ user: { id, name: 'U', email: 'u@example.com' }, passwordHash: null, sessionKey });

  it('writes the counter keys it always wrote: a changed label or prefix would reset every running count at a deploy', async () => {
    const { keys, limiter } = fake();
    const throttle = make(limiter);
    await throttle.takeClient('ada@example.com', '203.0.113.1');
    await throttle.takeAccount('ada@example.com', undefined);
    await throttle.takeAccount('ada@example.com', 42);
    await throttle.takeDevice('a-nonce');
    expect(keys).toEqual([
      'login:MoiMJMhU5cKKaHsl9IxfPA5dmAVPJOMySTXNsyE2LOA|_NCt-INtfZI7AGaRJ3L8KIqshcj0pHfPAL-LHprZ8P0',
      'login-account:identifier:MoiMJMhU5cKKaHsl9IxfPA5dmAVPJOMySTXNsyE2LOA',
      'login-account:id:42',
      'login-device:JtEqR0GFyCrfbb0WVuOziocpooBegGjDzUC1LFYXFJo',
    ]);
  });

  it('keeps neither the address, the client address nor a plain hash of them in a cache key, only an HMAC under a key derived from APP_KEY', async () => {
    const { keys, limiter } = fake();
    const throttle = make(limiter);
    await throttle.takeClient(' Ada@Example.com ', '203.0.113.1');
    await throttle.takeAccount(' Ada@Example.com ', undefined);
    await throttle.takeDevice('a-nonce');
    await throttle.clearClient('ada@example.com', '203.0.113.1');
    const plain = ['ada@example.com', '203.0.113.1', 'a-nonce', createHash('sha256').update('ada@example.com').digest('hex'), createHash('sha256').update('ada@example.com').digest('base64url')];
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('ada');
      for (const value of plain) expect(key).not.toContain(value);
    }
    // Another APP_KEY makes other keys: nobody can compute them from an address list alone.
    const other = fake();
    await make(other.limiter, 8).takeClient('ada@example.com', '203.0.113.1');
    expect(other.keys[0]).not.toBe(keys[0]);
    expect(keys[0]).toBe(keys[3]); // spellings and clears meet the same key
  });

  it('keeps the account to its id when it exists, and does not collide with the keys of the password checks', async () => {
    const { keys, limiter } = fake();
    const throttle = make(limiter);
    await throttle.takeAccount('ada@example.com', 42);
    await throttle.clearAccount(42);
    await throttle.takeDevice('n');
    expect(keys[0]).toBe(keys[1]);
    expect(keys.every((key) => (key.startsWith('login-account:') || key.startsWith('login-device:')) && !key.startsWith('password-check-'))).toBe(true);
  });

  it('does not fail a sign-in or a reset when the cache cannot clear a count, and says so', async () => {
    const { limiter } = fake(async () => {
      throw new Error('cache is down');
    });
    const throttle = make(limiter);
    await expect(throttle.clearAccount(1)).resolves.toBeUndefined();
    await expect(throttle.clearClient('ada@example.com', '203.0.113.1')).resolves.toBeUndefined();
    expect(logged.length).toBeGreaterThanOrEqual(2);
  });

  describe('device cookies', () => {
    const issue = (throttle: SignInThrottle, id = 1, sessionKey: string | null = 'key-one') => throttle.issueDevice(credentials(id, sessionKey))!;

    it('are accepted for exactly the account and session key they were issued for', () => {
      const throttle = make(fake().limiter);
      const cookie = issue(throttle);
      expect(cookie.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/', maxAge: 90 * 86_400 });
      const nonce = throttle.deviceNonce(cookie.value, credentials(1));
      expect(nonce).toMatch(/^[\w-]{22}$/);
      expect(throttle.deviceNonce(cookie.value, credentials(2)), 'another account').toBeUndefined();
      expect(throttle.deviceNonce(cookie.value, credentials(1, 'key-two')), 'a new session key').toBeUndefined();
      expect(throttle.deviceNonce(cookie.value, credentials(1, null)), 'a session key removed').toBeUndefined();
      expect(issue(throttle, 1)).not.toEqual(cookie); // a nonce each time
    });

    it('are refused when forged, cut, dotted or not text', () => {
      const throttle = make(fake().limiter);
      const { value } = issue(throttle);
      const [payload, mac] = value.split('.') as [string, string];
      for (const bad of [`${payload}.${mac.slice(1)}x`, `${payload}x.${mac}`, payload, `${payload}.${mac}.more`, '', '.', undefined, 42]) expect(throttle.deviceNonce(bad, credentials(1))).toBeUndefined();
    });

    it('run out after their days, and are not accepted from the future', () => {
      const throttle = make(fake().limiter);
      const { value } = issue(throttle);
      now += 89 * 86_400_000;
      expect(throttle.deviceNonce(value, credentials(1))).toBeDefined();
      now += 2 * 86_400_000;
      expect(throttle.deviceNonce(value, credentials(1))).toBeUndefined();
      now -= 91 * 86_400_000;
      const early = make(fake().limiter);
      const old = issue(early);
      now -= 3600_000;
      expect(early.deviceNonce(old.value, credentials(1)), 'issued an hour ahead of this clock').toBeUndefined();
      now += 3600_000;
    });

    it('are accepted under a previous APP_KEY but made under the current one', () => {
      const old = make(fake().limiter, 5);
      const cookie = issue(old);
      const renewed = make(fake().limiter, 6, [new Uint8Array(32).fill(5)]);
      expect(renewed.deviceNonce(cookie.value, credentials(1))).toBeDefined();
      expect(make(fake().limiter, 6).deviceNonce(cookie.value, credentials(1))).toBeUndefined();
    });

    it('are off at 0 days', () => {
      const throttle = make(fake().limiter, 7, [], { ...config, deviceCookieDays: 0 });
      expect(throttle.issueDevice(credentials(1))).toBeUndefined();
      expect(throttle.deviceNonce(issue(make(fake().limiter)).value, credentials(1))).toBeUndefined();
    });
  });
});
