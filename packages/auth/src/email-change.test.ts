import { Clock, createApplication, listen, defineModule, err, ok, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { createHttpKernel, ServerServiceProvider } from '@marmeon/server';
import { CsrfProtection, Session, SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { Auth, AUTH_SESSION_KEYS } from './auth.ts';
import { AuthServiceProvider, DatabaseEmailChanges, EmailChanged, EMAIL_CHANGES_TABLE, EmailChange, EmailChangeStore, Hasher, UserProvider, type AuthUser, type PendingEmailChange } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { twoFactorState } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { TwoFactorState } from './two-factor/state.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };
const grace: AuthUser = { id: 2, name: 'Grace', email: 'grace@example.com' };

/** What the app's side of the service does in a test: the mails it would send, the writes it would make, the addresses other accounts hold. */
const world = { delivered: [] as PendingEmailChange[], applied: [] as { id: unknown; email: string; verifiedAt: Date | null }[], taken: new Set<string>(), failDeliver: false, gone: false, factors: false, onFactors: undefined as (() => Promise<void>) | undefined };

function reset(): void {
  world.delivered = [];
  world.applied = [];
  world.taken = new Set();
  world.failDeliver = false;
  world.factors = false;
  world.onFactors = undefined;
  world.gone = false;
  seen.length = 0;
}

const apply = async (id: unknown, email: string, verifiedAt: Date | null) => {
  world.applied.push({ id, email, verifiedAt });
  if (world.gone) return err({ kind: 'missing' } as const);
  if (world.taken.has(email)) return err({ kind: 'duplicate' } as const);
  return ok({ email, verifiedAt });
};

class LoginController extends Controller {
  readonly #auth: Auth;
  constructor(auth: Auth) {
    super();
    this.#auth = auth;
  }
  async handle(ctx: HttpContext) {
    const { id } = (await ctx.input()) as { id: number };
    await this.#auth.login(id === 1 ? ada : grace);
    return { ok: true };
  }
}

class ActController extends Controller {
  readonly #emailChange: EmailChange;
  readonly #session: Session;
  constructor(emailChange: EmailChange, session: Session) {
    super();
    this.#emailChange = emailChange;
    this.#session = session;
  }
  async handle(ctx: HttpContext) {
    const body = (await ctx.input()) as { action: string; email?: string; password?: string; user?: string; token?: string };
    try {
      switch (body.action) {
        case 'prove':
          this.#session.put(AUTH_SESSION_KEYS.twoFactorAt, Math.floor(Date.now() / 1000));
          return { done: true };
        case 'request':
          return {
            result: await this.#emailChange.request(body.email!, body.password!, {
              deliver: async (change) => {
                if (world.failDeliver) throw new Error('the queue is down');
                world.delivered.push(change);
              },
              apply,
            }),
          };
        case 'confirm':
          return { result: await this.#emailChange.confirm(body.user!, body.token!, apply) };
        case 'waiting':
          return { result: (await this.#emailChange.waiting())?.email ?? null };
        case 'cancel':
          await this.#emailChange.cancel();
          return { done: true };
        default:
          throw new Error('unknown action');
      }
    } catch (error) {
      return { threw: (error as Error).message };
    }
  }
}

const seen: object[] = [];
class RecordEvent {
  handle(event: object) {
    seen.push({ ...event });
  }
}

const routes = openRoutes((Route) => {
  Route.post('/login', LoginController);
  Route.post('/act', ActController);
});

interface Options {
  readonly privateRegistration?: boolean;
  readonly factors?: boolean;
  readonly store?: boolean;
  /** The session key both accounts hold (`null`: none). */
  readonly key?: string | null;
  /** `AUTH_EMAIL_CHANGE_THROTTLE`; 0 unless a test is about the pause. */
  readonly throttle?: number;
}

async function boot(options: Options = {}) {
  reset();
  const users = new MemoryUsers<AuthUser>();
  const key = options.key ?? null;
  users.add(ada, null, key);
  users.add(grace, null, key);
  const clock = new TestClock();
  clock.freeze(Date.now());
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'auth-email-change-test', routes, migrations: new URL('./__fixtures__/migrations/', import.meta.url), listeners: [listen(EmailChanged, RecordEvent)] })],
  }, {
    env: {
      APP_KEY: generateKey(), SESSION_DRIVER: 'memory', SESSION_LOTTERY: '0/1', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', CACHE_DRIVER: 'memory',
      AUTH_PRIVATE_REGISTRATION: options.privateRegistration === false ? 'false' : 'true',
      AUTH_EMAIL_CHANGE_THROTTLE: String(options.throttle ?? 0),
    },
    override: (container: Container) => {
      container.make(CsrfProtection).disable();
      container.instance(Clock, clock);
      container.instance(UserProvider, users as UserProvider);
      if (options.store !== false) container.singleton(EmailChangeStore, DatabaseEmailChanges);
      if (options.factors) container.instance(TwoFactorState, twoFactorState({
        factors: async () => {
          await world.onFactors?.();
          return world.factors ? ['totp'] : [];
        },
      }));
    },
  });
  await application.container.make(Migrator).migrate();
  const hash = await application.container.make(Hasher).make('secret');
  for (const row of users.rows.values()) row.hash = hash;
  const db = application.container.make(Connections).get<any>();
  await db.insertInto('users').values([{ id: 1, session_key: key }, { id: 2, session_key: key }]).execute();
  const kernel = createHttpKernel(application);
  const rows = () => db.selectFrom(EMAIL_CHANGES_TABLE).select(['user_id', 'email']).execute() as Promise<{ user_id: number; email: string }[]>;
  /** A browser with its own cookies, signed in as account `id` (`0`: not signed in). */
  const browser = async (id: number) => {
    const jar = new Map<string, string>();
    const send = async (path: string, body: unknown) => {
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await kernel.request(path, { method: 'POST', headers: { cookie, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'manual' });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, value] = pair!.split('=') as [string, string];
        jar.set(name, value);
      }
      return response;
    };
    if (id !== 0) await send('/login', { id });
    const act = async (body: Record<string, unknown>) => (await (await send('/act', body)).json()) as { result?: any; threw?: string };
    return {
      act,
      send,
      prove: () => act({ action: 'prove' }),
      request: (email: string, password = 'secret') => act({ action: 'request', email, password }),
      confirm: (user: string, token: string) => act({ action: 'confirm', user, token }),
    };
  };
  /** Replaces the session key of account 1 the way a new password or the end of its sessions does. */
  const rotate = async (to: string) => {
    users.rows.get(1)!.key = to;
    await db.updateTable('users').set({ session_key: to }).where('id', '=', 1).execute();
  };
  return { browser, rows, clock, rotate, application };
}

describe('EmailChange.request()', () => {
  it('stores one change and hands the mail its link, for the right password', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true, value: { pending: true } });
    expect(await rows()).toEqual([{ user_id: 1, email: 'new@example.com' }]);
    expect(world.delivered).toHaveLength(1);
    expect(world.delivered[0]).toMatchObject({ userId: 1, email: 'new@example.com' });
    expect(world.delivered[0]!.token).toMatch(/^[\w-]{43}$/);
    expect(world.applied, 'the app writes nothing until the link is used').toEqual([]);
  });

  it('lets the link last AUTH_EMAIL_CHANGE_MINUTES', async () => {
    const { browser, clock } = await boot();
    await (await browser(1)).request('new@example.com');
    expect(world.delivered[0]!.expiresAt.getTime() - clock.now()).toBe(60 * 60_000);
  });

  it('throws without a second factor proven lately on an account that has one, and stores nothing', async () => {
    const { browser, rows } = await boot({ factors: true });
    const first = await browser(1);
    world.factors = true; // after the sign-in: an account with a factor does not get past the login helper
    expect((await first.request('new@example.com')).threw).toMatch(/second factor/);
    expect(await rows()).toEqual([]);
    expect(world.delivered).toEqual([]);
    await first.prove();
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true });
    expect(await rows()).toHaveLength(1);
  });

  it('answers invalid-password for a wrong password, storing and mailing nothing; the sixth try is throttled', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    for (let i = 0; i < 5; i++) expect((await first.request('new@example.com', 'wrong')).result).toMatchObject({ ok: false, error: { kind: 'invalid-password' } });
    expect(await rows()).toEqual([]);
    expect(world.delivered).toEqual([]);
    expect((await first.request('new@example.com', 'secret')).result).toMatchObject({ ok: false, error: { kind: 'throttled' } });
    expect(await rows()).toEqual([]);
  });

  it('stores nothing when the mail cannot be handed over', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    world.failDeliver = true;
    expect((await first.request('new@example.com')).threw).toBe('the queue is down');
    expect(await rows()).toEqual([]);
  });

  it('does the same for a free address and one another account has', async () => {
    const { browser, rows } = await boot();
    world.taken.add('grace@example.com');
    const first = await browser(1);
    const free = await first.request('free@example.com');
    const taken = await first.request('grace@example.com');
    expect(taken).toEqual(free);
    expect(world.applied, 'the service never asks whether an address is taken').toEqual([]);
    expect(world.delivered.map((change) => change.email)).toEqual(['free@example.com', 'grace@example.com']);
    expect(await rows()).toEqual([{ user_id: 1, email: 'grace@example.com' }]);
  });

  it('replaces the older change of the account, and its link dies', async () => {
    const { browser } = await boot();
    const first = await browser(1);
    await first.request('first@example.com');
    await first.request('second@example.com');
    const [older, newer] = world.delivered;
    expect((await first.confirm('1', older!.token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect((await first.confirm('1', newer!.token)).result).toMatchObject({ ok: true });
  });

  it('writes the address at once, unverified, without private registration; a taken one is an err', async () => {
    const { browser, rows } = await boot({ privateRegistration: false });
    const first = await browser(1);
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true, value: { pending: false, value: { email: 'new@example.com', verifiedAt: null } } });
    expect(world.applied).toEqual([{ id: 1, email: 'new@example.com', verifiedAt: null }]);
    expect(world.delivered).toEqual([]);
    expect(await rows()).toEqual([]);
    world.taken.add('grace@example.com');
    expect((await first.request('grace@example.com')).result).toMatchObject({ ok: false, error: { kind: 'duplicate' } });
  });

  it('throws when the account is gone', async () => {
    const { browser } = await boot({ privateRegistration: false });
    const first = await browser(1);
    world.gone = true;
    expect((await first.request('new@example.com')).threw).toMatch(/is gone/);
  });

  it('throws without a signed-in user', async () => {
    const { browser, rows } = await boot();
    const nobody = await browser(0);
    expect((await nobody.request('new@example.com')).threw).toMatch(/needs a signed-in user/);
    expect((await nobody.confirm('1', 'x'.repeat(43))).threw).toMatch(/needs a signed-in user/);
    expect(await rows()).toEqual([]);
  });

  it('stores a change for an account that has a session key, bound to that key', async () => {
    const { browser, rows } = await boot({ key: 'k-old' });
    const first = await browser(1);
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true, value: { pending: true } });
    expect(await rows()).toEqual([{ user_id: 1, email: 'new@example.com' }]);
  });

  it('ends the session and stores nothing when the key changes before the change is stored', async () => {
    const { browser, rows, rotate } = await boot({ key: 'k-old', factors: true });
    const first = await browser(1);
    await first.prove();
    world.factors = true;
    world.onFactors = async () => {
      world.onFactors = undefined;
      await rotate('k-new'); // a new password or the end of the sessions, after the user was resolved
    };
    expect((await first.request('new@example.com')).threw).toMatch(/ended/);
    expect(await rows()).toEqual([]);
    expect(world.delivered).toEqual([]);
    expect((await first.request('new@example.com')).threw).toMatch(/needs a signed-in user/);
  });

  it('ends the session and writes nothing without private registration when the key changed', async () => {
    const { browser, rotate } = await boot({ key: 'k-old', privateRegistration: false, factors: true });
    const first = await browser(1);
    await first.prove();
    world.factors = true;
    world.onFactors = async () => {
      world.onFactors = undefined;
      await rotate('k-new');
    };
    expect((await first.request('new@example.com')).threw).toMatch(/ended/);
    expect(world.applied).toEqual([]);
    expect((await first.request('new@example.com')).threw).toMatch(/needs a signed-in user/);
  });

  it('answers a second request inside the pause like the first, and sends and stores nothing', async () => {
    const { browser, rows } = await boot({ throttle: 60 });
    const first = await browser(1);
    const answer = await first.request('one@example.com');
    expect(await first.request('two@example.com')).toEqual(answer);
    expect(world.delivered.map((change) => change.email)).toEqual(['one@example.com']);
    expect(await rows()).toEqual([{ user_id: 1, email: 'one@example.com' }]);
    const other = await browser(2);
    await other.request('three@example.com');
    expect(world.delivered).toHaveLength(2);
  });

  it('gives the pause back when the mail cannot be handed over, so that the retry sends it', async () => {
    const { browser, rows } = await boot({ throttle: 60 });
    const first = await browser(1);
    world.failDeliver = true;
    expect((await first.request('new@example.com')).threw).toBe('the queue is down');
    world.failDeliver = false;
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true, value: { pending: true } });
    expect(world.delivered.map((change) => change.email)).toEqual(['new@example.com']);
    expect(await rows()).toHaveLength(1);
  });

  it('tells the previous address with EmailChanged once the address is written, at confirm and without private registration', async () => {
    const { browser } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    expect(seen).toEqual([]);
    await first.confirm('1', world.delivered[0]!.token);
    expect(seen).toEqual([{ userId: 1, previousEmail: 'ada@example.com', email: 'new@example.com' }]);
    world.taken.add('x@example.com');
    await first.request('x@example.com');
    await first.confirm('1', world.delivered[1]!.token);
    expect(seen, 'a taken address changes nothing').toHaveLength(1);
    const direct = await boot({ privateRegistration: false });
    await (await direct.browser(1)).request('direct@example.com');
    expect(seen).toEqual([{ userId: 1, previousEmail: 'ada@example.com', email: 'direct@example.com' }]);
  });

  it('cannot be made while no store is bound', async () => {
    const { browser, application } = await boot({ store: false });
    expect(() => application.container.make(EmailChangeStore)).toThrow(/\[marmeon:K1\] EmailChangeStore is abstract/);
    expect((await (await browser(1)).send('/act', { action: 'cancel' })).status).toBe(500);
  });

  it('is cancelled by the account, and only its own', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    const second = await browser(2);
    await first.request('one@example.com');
    await second.request('two@example.com');
    await first.act({ action: 'cancel' });
    expect(await rows()).toEqual([{ user_id: 2, email: 'two@example.com' }]);
  });
});

describe('EmailChange.confirm()', () => {
  it('applies the address, verified now, once; a second click is invalid', async () => {
    const { browser, rows, clock } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    const { token } = world.delivered[0]!;
    expect((await first.confirm('1', token)).result).toMatchObject({ ok: true, value: { email: 'new@example.com' } });
    expect(world.applied).toEqual([{ id: 1, email: 'new@example.com', verifiedAt: new Date(clock.now()) }]);
    expect(await rows()).toEqual([]);
    expect((await first.confirm('1', token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(world.applied).toHaveLength(1);
  });

  it('refuses the link for another account and keeps it for the right one', async () => {
    const { browser, rows } = await boot();
    const owner = await browser(1);
    const other = await browser(2);
    await owner.request('new@example.com');
    const { token } = world.delivered[0]!;
    expect((await other.confirm('1', token)).result).toMatchObject({ ok: false, error: { kind: 'wrong-account' } });
    expect((await other.confirm('2', token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await rows()).toHaveLength(1);
    expect(world.applied).toEqual([]);
    expect((await owner.confirm('1', token)).result).toMatchObject({ ok: true });
  });

  it('refuses an expired link', async () => {
    const { browser, clock } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    clock.travel({ minutes: 60, milliseconds: 1 });
    expect((await first.confirm('1', world.delivered[0]!.token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(world.applied).toEqual([]);
  });

  it('answers taken when another account took the address meanwhile, and the link is used up', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    world.taken.add('new@example.com');
    const { token } = world.delivered[0]!;
    expect((await first.confirm('1', token)).result).toMatchObject({ ok: false, error: { kind: 'taken', email: 'new@example.com' } });
    expect(await rows()).toEqual([]);
    expect((await first.confirm('1', token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });

  it('keeps the link when the account is gone for the app', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    world.gone = true;
    expect((await first.confirm('1', world.delivered[0]!.token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await rows()).toHaveLength(1);
  });

  it('knows no links without private registration', async () => {
    const { browser } = await boot({ privateRegistration: false });
    expect((await (await browser(1)).confirm('1', 'x'.repeat(43))).result).toMatchObject({ ok: false, error: { kind: 'not-found' } });
  });

  it('refuses a malformed token', async () => {
    const { browser } = await boot();
    expect((await (await browser(1)).confirm('1', 'nope')).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });
});

describe('EmailChange.waiting() and a repeated request', () => {
  it('names the address that waits for the signed-in user, and needs a signed-in user', async () => {
    const { browser, rotate } = await boot();
    const first = await browser(1);
    expect((await first.act({ action: 'waiting' })).result).toBeNull();
    await first.request('new@example.com');
    expect((await first.act({ action: 'waiting' })).result).toBe('new@example.com');
    await rotate('another-key');
    expect((await first.act({ action: 'waiting' })).threw, 'a new session key ends the session itself').toContain('signed-in user');
  });

  it('leaves the change and its link alone when the same address is asked for again: no second mail, the first link still works', async () => {
    const { browser, rows } = await boot();
    const first = await browser(1);
    await first.request('new@example.com');
    const { token } = world.delivered[0]!;
    expect((await first.request('new@example.com')).result).toMatchObject({ ok: true, value: { pending: true } });
    expect(world.delivered, 'deliver is not called again').toHaveLength(1);
    expect(await rows()).toEqual([{ user_id: 1, email: 'new@example.com' }]);
    expect((await first.confirm('1', token)).result, 'the first link is not dead').toMatchObject({ ok: true });
  });

  it('replaces the change when another address is asked for', async () => {
    const { browser } = await boot();
    const first = await browser(1);
    await first.request('one@example.com');
    const { token } = world.delivered[0]!;
    await first.request('two@example.com');
    expect(world.delivered).toHaveLength(2);
    expect((await first.confirm('1', token)).result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
  });
});
