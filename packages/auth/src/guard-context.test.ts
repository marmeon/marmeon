import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Container, type EventDispatcher, type Key } from '@marmeon/core';
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
import { EverySessionEnded, SignedIn } from './events.ts';
import { buildForGuard, dispatchForGuard, GuardContext } from './guard-context.ts';
import { APP_GUARD_NAMES, guardNames } from './guard-names.ts';
import { SignInAudience } from './live-audience.ts';
import { defineGuard, type Guard } from './define-guard.ts';
import { authenticate, confirmedPassword, guest } from './middleware.ts';
import { NewPassword } from './new-password.ts';
import { RequestGuard } from './request-guard.ts';
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

describe('the middleware of a package guard', () => {
  const OfficeGuard = defineGuard('office', { users: MemoryUsers as never, tablePrefix: 'office_', twoFactor: TwoFactor });
  const context = (OfficeGuard as unknown as Guard).tokens.context;
  const middleware: Record<string, Injectable> = {
    'authenticate()': OfficeGuard.authenticate({ loginRoute: 'a' as never }) as Injectable,
    'guest()': OfficeGuard.guest({ homeRoute: 'a' as never }) as Injectable,
    'confirmedPassword()': OfficeGuard.confirmedPassword({ confirmRoute: 'a' as never }) as Injectable,
    'twoFactor()': OfficeGuard.twoFactor({ setup: 'a', verify: 'b' } as never) as Injectable,
    'confirmedSecondFactor()': OfficeGuard.confirmedSecondFactor({ verify: 'b' } as never) as Injectable,
  };

  it.each(Object.entries(middleware))('%s is injected with its own guard\'s context, never the app\'s, and nothing a guard owns besides', (_name, Class) => {
    expect(Class.inject?.[0]).toBe(context);
    expect(Class.inject?.[0]).not.toBe(GuardContext);
    expect(Class.inject!.slice(1).filter((key) => OWNED_BY_A_GUARD.includes(key))).toEqual([]);
  });

  it.each(Object.entries(middleware))('%s asks the request for the route\'s guard', (_name, Class) => {
    expect(Class.inject).toContain(RequestGuard);
  });

  it('is the app\'s own context for the app\'s middleware, and each takes the request\'s guard as well', () => {
    for (const Class of [authenticate(), guest(), confirmedPassword(), twoFactor({ setup: 'a', verify: 'b' } as never), confirmedSecondFactor({ verify: 'b' } as never)] as Injectable[]) {
      expect(Class.inject?.[0]).toBe(GuardContext);
      expect(Class.inject).toContain(RequestGuard);
    }
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

describe('the events of the guard services', () => {
  type Node = { type: string; start: number; end: number; [key: string]: any };

  const sourceDirectory = fileURLToPath(new URL('.', import.meta.url));
  /** Every non-test source file of the package, as a path relative to `src/`. */
  const files = readdirSync(sourceDirectory, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.test-d.ts') && !file.split('/').includes('test-helpers'))
    .map((file) => `./${file}`)
    .toSorted();

  const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';

  /** Calls `visit` for `node` and everything below it. */
  function walk(node: unknown, parent: Node | undefined, visit: (node: Node, parent: Node | undefined) => void): void {
    if (Array.isArray(node)) return node.forEach((child) => walk(child, parent, visit));
    if (!isNode(node)) return;
    visit(node, parent);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || typeof value !== 'object') continue;
      walk(value, node, visit);
    }
  }

  /** Every use of a `dispatch` property in `file` (a call, a reference, a destructured name, in any spelling of the name), as nodes. */
  function dispatchNodesIn(source: string, path: string): Node[] {
    const nodes: Node[] = [];
    const named = (property: Node | undefined) =>
      property !== undefined &&
      ((property.type === 'Identifier' && property.name === 'dispatch') ||
        (property.type === 'Literal' && property.value === 'dispatch') ||
        (property.type === 'TemplateLiteral' && property.expressions.length === 0 && property.quasis[0]?.value?.cooked === 'dispatch'));
    const isBare = (node: Node) => node.computed !== true || node.property?.type !== 'Identifier';
    walk(parseSync(path, source).program, undefined, (node) => {
      if (node.type === 'MemberExpression' && named(node.property) && isBare(node)) nodes.push(node);
      else if (node.type === 'Property' && named(node.key) && (node.computed !== true || node.key?.type !== 'Identifier')) nodes.push(node);
    });
    return nodes;
  }

  function dispatchNodes(file: string): { source: string; nodes: Node[] } {
    const path = new URL(file, import.meta.url);
    const source = readFileSync(path, 'utf8');
    return { source, nodes: dispatchNodesIn(source, path.pathname) };
  }

  it.each([
    'x.dispatch(e)',
    'x?.dispatch(e)',
    "x['dispatch'](e)",
    'x[`dispatch`](e)',
    'const { dispatch } = x',
    'const { dispatch: d } = x',
    "const { 'dispatch': d } = x",
  ])('the detector finds %s', (code) => {
    expect(dispatchNodesIn(code, 'probe.ts')).toHaveLength(1);
  });

  it.each(['x.dispatched(e)', 'x[name](e)', 'const { dispatched } = x'])('the detector leaves %s alone', (code) => {
    expect(dispatchNodesIn(code, 'probe.ts')).toEqual([]);
  });

  const dispatchUses = (file: string): string[] => {
    const { source, nodes } = dispatchNodes(file);
    return nodes.map((node) => `${file}: ${source.slice(node.start, node.start + 60)}`);
  };

  // A package guard maps the app's events to none until it has its own: a service that dispatches straight to the app's listeners would
  // let one guard's account events (a mail to the account's owner) reach listeners that read the id as the app's user. So no source file
  // of the package dispatches, bar the helper and the app-only `EmailChanged`, which is not a guard event.
  const ALLOWED: Record<string, number> = { './guard-context.ts': 1, './email-change.ts': 2 };

  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('./auth.ts');
    expect(files).toContain('./passkeys/passkeys.ts');
  });

  it.each(files)('%s dispatches only through dispatchForGuard()', (file) => {
    if (file in ALLOWED) return;
    expect(dispatchUses(file)).toEqual([]);
  });

  it('allows the dispatches of the helper and of EmailChanged, and no more', () => {
    for (const [file, count] of Object.entries(ALLOWED)) expect(dispatchUses(file), file).toHaveLength(count);
  });

  it('has the one dispatch of guard-context.ts inside dispatchForGuard()', () => {
    const { source, nodes } = dispatchNodes('./guard-context.ts');
    expect(nodes).toHaveLength(1);
    const program = parseSync(fileURLToPath(new URL('./guard-context.ts', import.meta.url)), source).program;
    let helper: Node | undefined;
    walk(program, undefined, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id?.name === 'dispatchForGuard') helper = node;
    });
    expect(helper).toBeDefined();
    expect(helper!.start <= nodes[0]!.start && nodes[0]!.end <= helper!.end).toBe(true);
  });
});

describe('dispatchForGuard()', () => {
  const recording = () => {
    const seen: object[] = [];
    return { seen, events: { dispatch: async (event: object) => void seen.push(event) } as unknown as EventDispatcher };
  };

  it('dispatches what the guard answers, in order, and never the event it was given', async () => {
    const raised = {};
    const [a, b] = [{ a: 1 }, { b: 2 }];
    const guard = { dispatched: (event: object) => (event === raised ? [a, b] : []) } as unknown as GuardContext;
    const { seen, events } = recording();
    await dispatchForGuard(guard, events, raised);
    expect(seen).toEqual([a, b]);
    expect(seen[0]).toBe(a);
    expect(seen[1]).toBe(b);
  });

  it('dispatches nothing when the guard answers none', async () => {
    const guard = { dispatched: () => [] } as unknown as GuardContext;
    const { seen, events } = recording();
    await dispatchForGuard(guard, events, {});
    expect(seen).toEqual([]);
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

  it('has the names of the app guard, and dispatches every event as it is', () => {
    const context = contextOf(new Container());
    const event = new Date();
    expect(context.names).toBe(APP_GUARD_NAMES);
    expect(context.dispatched(event)).toEqual([event]);
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

describe('PackageGuardContext', () => {
  it('dispatches the guard\'s own event for what a service raised, and nothing for what the guard has none of', () => {
    const Office = defineGuard('office', { users: MemoryUsers as never, tablePrefix: 'office_', twoFactor: TwoFactor });
    const container = new Container();
    (Office as unknown as Guard).register(container);
    const context = container.make((Office as unknown as Guard).tokens.context) as GuardContext;
    const ada = { id: 1, name: 'Ada', email: 'ada@example.com' } as AuthUser;
    const dispatched = context.dispatched(new SignedIn(ada));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toBeInstanceOf(Office.events.SignedIn);
    expect(dispatched[0]).not.toBeInstanceOf(SignedIn);
    expect(context.dispatched(new EverySessionEnded({ accounts: 0, resetTokens: 0, accessTokens: 0, signIns: 0 }, new Date()))).toEqual([]);
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
