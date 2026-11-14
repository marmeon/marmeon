import { readFileSync } from 'node:fs';
import { Container, type Key } from '@marmeon/core';
import { parseSync } from '@marmeon/core/internal';
import { ClientHistory } from '@marmeon/http';
import { Session, UserSessions, type SessionConfig } from '@marmeon/session';
import { MemorySessionStore, plainSessionCodec } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { AccountSessions } from './account-sessions.ts';
import { AppGuardContext } from './app-guard-context.ts';
import { Auth } from './auth.ts';
import { AuthConfig } from './config.ts';
import { EmailChangeStore } from './email-changes.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { buildForGuard, GuardContext } from './guard-context.ts';
import { APP_GUARD_NAMES, guardNames } from './guard-names.ts';
import { SignInAudience } from './live-audience.ts';
import { authenticate, confirmedPassword, guest } from './middleware.ts';
import { NewPassword } from './new-password.ts';
import { Passkeys } from './passkeys/passkeys.ts';
import { PasskeyStore } from './passkeys/store.ts';
import { PasswordBroker, PasswordResetTokenStore } from './password-reset.ts';
import { SignInStore } from './sign-ins.ts';
import { SignInThrottle } from './sign-in-throttle.ts';
import { NO_CLIENT } from './test-helpers/client.ts';
import { guardContext } from './test-helpers/guard-context.ts';
import { NO_LOGIN_LIMITS } from './test-helpers/login-limits.ts';
import { signInStore } from './test-helpers/stores.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { AccessTokenStore } from './tokens.ts';
import { confirmedSecondFactor } from './two-factor/confirmed.ts';
import { twoFactor } from './two-factor/middleware.ts';
import { NoTwoFactorState, SecondFactorPasskeys, TwoFactorState } from './two-factor/state.ts';
import { TwoFactorStore } from './two-factor/store.ts';
import { TwoFactor } from './two-factor/two-factor.ts';
import { UserProvider, type AuthUser } from './user.ts';

type Injectable = { readonly inject?: readonly Key[] };

/** What belongs to a guard: a service that takes one of these next to its `GuardContext` could be handed another guard's. */
const OWNED_BY_A_GUARD: readonly unknown[] = [
  UserProvider,
  SignInStore,
  TwoFactorState,
  SecondFactorPasskeys,
  TwoFactorStore,
  PasswordResetTokenStore,
  AccessTokenStore,
  EmailChangeStore,
  AccountSessions,
  NewPassword,
  SessionFingerprints,
  SignInThrottle,
  UserSessions,
  AuthConfig,
  Auth,
  PasskeyStore,
];

describe('the services that act for a guard', () => {
  const services: Record<string, Injectable> = {
    Auth: Auth as unknown as Injectable,
    AccountSessions: AccountSessions as unknown as Injectable,
    NewPassword: NewPassword as unknown as Injectable,
    PasswordBroker: PasswordBroker as unknown as Injectable,
    SignInAudience: SignInAudience as unknown as Injectable,
    'authenticate()': authenticate() as Injectable,
    'guest()': guest() as Injectable,
    'confirmedPassword()': confirmedPassword() as Injectable,
    TwoFactor: TwoFactor as unknown as Injectable,
    Passkeys: Passkeys as unknown as Injectable,
    'twoFactor()': twoFactor({ setup: 'a', verify: 'b' } as never) as Injectable,
    'confirmedSecondFactor()': confirmedSecondFactor({ verify: 'b' } as never) as Injectable,
  };

  it.each(Object.entries(services))('%s takes the GuardContext first and nothing a guard owns besides', (_name, Class) => {
    expect(Class.inject?.[0]).toBe(GuardContext);
    expect(Class.inject!.slice(1).filter((key) => OWNED_BY_A_GUARD.includes(key))).toEqual([]);
  });
});

describe('the sources of the guard services', () => {
  type Node = { type: string; start: number; end: number; [key: string]: any };

  /** Every constructor whose first parameter is the `GuardContext`, with its parameters. */
  function guardConstructors(file: string): { source: string; params: Node[] }[] {
    const path = new URL(file, import.meta.url);
    const source = readFileSync(path, 'utf8');
    const found: { source: string; params: Node[] }[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== 'object' || node === null) return;
      const current = node as Node;
      if (current.type === 'MethodDefinition' && current.kind === 'constructor') {
        const params: Node[] = current.value.params;
        if (params[0] && source.slice(params[0].start, params[0].end).includes(': GuardContext')) found.push({ source, params });
      }
      for (const value of Object.values(current)) if (typeof value === 'object') visit(value);
    };
    visit(parseSync(path.pathname, source).program);
    return found;
  }

  // `buildForGuard()` cannot see a default value (`Class.length` stops before it, and the injection list does too), so the sources must have none.
  it('have no optional or defaulted constructor parameter', () => {
    const files = ['./auth.ts', './account-sessions.ts', './new-password.ts', './password-reset.ts', './live-audience.ts', './middleware.ts', './two-factor/two-factor.ts', './two-factor/middleware.ts', './two-factor/confirmed.ts', './passkeys/passkeys.ts'];
    const constructors = files.flatMap(guardConstructors);
    // Auth, AccountSessions, NewPassword, PasswordBroker, SignInAudience and the three middleware classes, then TwoFactor, Passkeys and their two middleware classes.
    expect(constructors.length).toBe(12);
    for (const { source, params } of constructors) {
      for (const param of params) {
        expect(param.type === 'AssignmentPattern' || param.optional === true, source.slice(param.start, param.end)).toBe(false);
      }
    }
  });
});

describe('buildForGuard()', () => {
  class Dep {}
  class Service {
    static inject = [GuardContext, Dep];
    readonly guard: GuardContext;
    readonly dep: Dep;
    constructor(guard: GuardContext, dep: Dep) {
      this.guard = guard;
      this.dep = dep;
    }
  }

  it('hands the context in at the first place and makes the rest', () => {
    const container = new Container();
    const context = guardContext();
    const built = buildForGuard(Service, container, context);
    expect(built.guard).toBe(context);
    expect(built.dep).toBeInstanceOf(Dep);
  });

  it('refuses a class that does not take the GuardContext first, has no injection list, or has a parameter the container would leave out', () => {
    class Loose {
      static inject = [Dep, GuardContext];
    }
    class Bare {}
    class Optional {
      static inject = [GuardContext];
      constructor(_guard: GuardContext, _dep?: Dep) {}
    }
    for (const Class of [Loose, Bare, Optional]) {
      expect(() => buildForGuard(Class as never, new Container(), guardContext())).toThrow(TypeError);
    }
  });
});

describe('AppGuardContext', () => {
  const contextOf = (container: Container) => new AppGuardContext(container, container);

  it('has the names of the app guard, and every event goes out as it is', () => {
    const context = contextOf(new Container());
    const event = new Date();
    expect(context.names).toBe(APP_GUARD_NAMES);
    expect(context.event(event)).toBe(event);
  });

  it('reads what the app binds, when the service asks, and keeps one provider', () => {
    const container = new Container();
    const context = contextOf(container);
    const users = new MemoryUsers<AuthUser & { id: number }>() as UserProvider;
    container.instance(UserProvider, users);
    expect(context.users()).toBe(users);
    container.instance(UserProvider, new MemoryUsers() as UserProvider);
    expect(context.users(), 'one provider for as long as the context lives').toBe(users);
  });

  it('keeps one TwoFactorState, like the provider', () => {
    const context = contextOf(new Container().singleton(TwoFactorState, NoTwoFactorState));
    expect(context.factors()).toBe(context.factors());
  });

  it('has no change-of-address store or user sessions until the app binds them', () => {
    const context = contextOf(new Container());
    expect(context.emailChanges()).toBeUndefined();
    expect(context.userSessions()).toBeUndefined();
    expect(context.passkeyStore()).toBeUndefined();
  });
});

describe('Auth for a guard', () => {
  const ada = { id: 1, name: 'Ada', email: 'ada@example.com' } as AuthUser & { id: number; email: string };
  const config = { lifetimeMinutes: 120, secure: false, sameSite: 'lax' } as SessionConfig;
  const fingerprints = new SessionFingerprints({ key: new Uint8Array(32), previousKeys: [] });

  const authFor = (session: Session, names: typeof APP_GUARD_NAMES, users: MemoryUsers<typeof ada>) =>
    new Auth(
      guardContext({ names, users: users as UserProvider, signIns: signInStore({ create: async () => 'S'.repeat(22), seen: async () => true }), fingerprints, signInThrottle: NO_LOGIN_LIMITS }),
      session,
      {} as never,
      { dispatch: async () => {} } as never,
      { get: () => undefined, set() {}, delete() {} } as never,
      config,
      {} as never,
      new ClientHistory(),
      NO_CLIENT,
      { now: () => Date.now() } as never,
      {} as never,
    );

  it('keeps its sign-in under its own keys and the app guard, on the same session and the same id, sees nobody', async () => {
    const session = new Session(new MemorySessionStore(), { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
    await session.start();
    const office = new MemoryUsers<typeof ada>();
    office.add(ada);
    const app = new MemoryUsers<typeof ada>();
    app.add({ ...ada, name: 'Another Ada' });

    expect(await authFor(session, guardNames('office'), office).signIn(ada)).toBe('signed-in');

    expect(session.has('_auth:office:id')).toBe(true);
    expect(session.has('_auth_id'), 'the app guard has no sign-in').toBe(false);
    expect(await authFor(session, guardNames('office'), office).check()).toBe(true);
    expect(await authFor(session, APP_GUARD_NAMES, app).check()).toBe(false);
  });

  it('asks the users of its context, not those of another guard', async () => {
    const session = new Session(new MemorySessionStore(), { lifetimeMinutes: 120 } as SessionConfig, plainSessionCodec);
    await session.start();
    const office = new MemoryUsers<typeof ada>();
    office.add(ada);
    await authFor(session, guardNames('office'), office).signIn(ada);

    expect(await authFor(session, guardNames('office'), office).user()).toMatchObject({ name: 'Ada' });
    // The same sign-in against a table that has no such account: nobody, and the sign-in is dropped, not carried to another table.
    expect(await authFor(session, guardNames('office'), new MemoryUsers<typeof ada>()).user()).toBeUndefined();
  });
});
