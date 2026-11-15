import { Clock, EventDispatcher, Logger, Redactor, token, type Concrete, type Container, type Duration, type Resolver, type Token } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections } from '@marmeon/database';
import { RateLimiter, throttle } from '@marmeon/cache';
import { EncryptionConfig } from '@marmeon/encryption';
import type { CheckRouteName, MiddlewareClass, RouteNameInput } from '@marmeon/router';
import { SessionConfig, SessionEndings, type UserSessions } from '@marmeon/session';
import type { Result } from '@marmeon/core';
import { AccountSessions } from './account-sessions.ts';
import { Auth, type AttemptError, type SignInOptions } from './auth.ts';
import { AuthConfig } from './config.ts';
import type { EmailChangeStore } from './email-changes.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { buildForGuard, GUARD_FEATURE, GUARD_PASSKEYS, GuardContext, type GuardPasskeyKit } from './guard-context.ts';
import { authenticateFor, confirmedPasswordFor, guestFor, type MiddlewareGuard } from './middleware.ts';
import { bindRequestGuard } from './request-guard.ts';
import { guardLimiterName, isGuardRouteLimit, type GuardRouteLimit } from './route-limits.ts';
import { guardNames, isGuardName, type GuardNames } from './guard-names.ts';
import { NewPassword } from './new-password.ts';
import { DatabasePasswordResetTokens, PasswordBroker, type PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseSignIns, type SignInStore } from './sign-ins.ts';
import { SignInThrottle } from './sign-in-throttle.ts';
import type { AccessTokenStore } from './tokens.ts';
import { combineFactors, NoSecondFactorPasskeys, NoTwoFactorState, type SecondFactorPasskeys, type TwoFactorState } from './two-factor/state.ts';
import { confirmedSecondFactorFor } from './two-factor/confirmed.ts';
import { twoFactorFor } from './two-factor/middleware.ts';
import { TwoFactorStore } from './two-factor/store.ts';
import type { ChallengeError, SecondFactorInput, TwoFactor } from './two-factor/two-factor.ts';
import { requireStoreTables } from './upgrades.ts';
import { assertSignInFinder, type IdOf, type UserProvider } from './user.ts';

/**
 * The settings a package guard may set for itself, each within the limits of the `AUTH_*` variable it replaces. What a guard leaves out
 * is what the app configured. See `docs/authentication.md#guards-of-a-package`.
 */
export interface GuardSettings {
  /** Days "Keep me signed in" lasts, 0 (off) to 30 (`AUTH_REMEMBER_DAYS`). */
  readonly rememberDays?: number;
  /** The longest a sign-in lasts, in hours, 1 to 720 (`AUTH_SESSION_MAX_HOURS`). */
  readonly sessionMaxHours?: number;
  /** Seconds a password confirmation counts, 1 or more (`AUTH_PASSWORD_TIMEOUT_SECONDS`). */
  readonly passwordTimeoutSeconds?: number;
  /** Password sign-ins a minute for one identifier from one client, 1 to 60 (`AUTH_LOGIN_ATTEMPTS_PER_MINUTE`). */
  readonly loginAttemptsPerMinute?: number;
  /** Password sign-ins a day for one account, 10 to 100000 (`AUTH_ACCOUNT_SIGN_INS_PER_DAY`). */
  readonly accountSignInsPerDay?: number;
  /** Days the device cookie lasts, 0 (off) to 365 (`AUTH_DEVICE_COOKIE_DAYS`). */
  readonly deviceCookieDays?: number;
  /** Minutes a password reset link works, 1 to 1440 (`AUTH_RESET_MINUTES`). */
  readonly resetMinutes?: number;
  /** Seconds before another reset link goes to the same address, 0 or more (`AUTH_RESET_THROTTLE_SECONDS`). */
  readonly resetThrottleSeconds?: number;
  /** What an authenticator app shows as the guard's name, 1 to 64 characters; the app's `APP_NAME` where left out. Without a different one an authenticator app lists the guard's account and the app's account of the same address as two entries of the same name. */
  readonly twoFactorIssuer?: string;
}

interface GuardBaseOptions<U> {
  /**
   * A class implementing `UserProvider` on a table of the package's own. The container builds it; a package guard never reads the
   * app's `UserProvider`. Whether it reads a table of its own cannot be checked: see `docs/authentication.md#guards-of-a-package`.
   */
  readonly users: Concrete<UserProvider<U>>;
  /** The prefix of the guard's tables (`office_` gives `office_sign_ins` and `office_password_reset_tokens`): lower case, digits and underscores, ending in `_`, at most 32 characters. */
  readonly tablePrefix: string;
  /** Settings of the guard, or a function that reads them (from the config, say) when the guard is first used and at boot. */
  readonly settings?: GuardSettings | ((resolver: Resolver) => GuardSettings);
}

/**
 * The `Passkeys` class of the package's `passkeys` export, described by what a guard needs of it and not imported: the main entry stays clear of the
 * passkeys folder, even for a type. What makes a class `Passkeys` is its brand, which `defineGuard()` checks when it runs.
 */
type GuardPasskeysClass = abstract new (...parameters: never[]) => { signIn(...parameters: never[]): Promise<Result<unknown>> };

/**
 * What `defineGuard()` takes: where the guard's users come from, which tables it owns, and what it sets for itself. With `TF` the `TwoFactor`
 * class, `twoFactor` is required, and with `PK` the `Passkeys` class, `passkeys` is, so the type never promises a guard that has none.
 */
export type GuardOptions<U, TF extends typeof TwoFactor | undefined = undefined, PK extends GuardPasskeysClass | undefined = undefined> = GuardBaseOptions<U> &
  (TF extends typeof TwoFactor ? GuardTwoFactorOption<TF> : { readonly twoFactor?: undefined }) &
  (PK extends GuardPasskeysClass ? (TF extends typeof TwoFactor ? GuardPasskeysOption<PK> : { readonly passkeys?: undefined }) : { readonly passkeys?: undefined });

/** The `passkeys` option of {@link GuardOptions}. */
interface GuardPasskeysOption<PK> {
  /** The `Passkeys` class, which needs `twoFactor` as well: a passkey on tables of the guard's own, with the app's relying party. See `docs/passkeys.md#for-a-guard-of-a-package`. */
  readonly passkeys: PK;
}

/** The `twoFactor` option of {@link GuardOptions}. */
interface GuardTwoFactorOption<TF> {
  /**
   * `TwoFactor` (from `@marmeon/auth/two-factor`) gives the guard an authenticator app and recovery codes on tables of its own
   * (`office_two_factor_authentications`, `office_two_factor_recovery_codes`), the challenge after the password and the middleware
   * `twoFactor()` and `confirmedSecondFactor()`. Passed as the class so that a guard without it does not carry it. See `docs/two-factor-authentication.md#for-a-guard-of-a-package`.
   */
  readonly twoFactor: TF;
}

/** What the type `Auth` has, for the users of a guard: `U` instead of the app's user. */
export type GuardAuth<U> = Omit<Auth, 'attempt' | 'signIn' | 'user' | 'id'> & {
  attempt(identifier: string, password: string, options?: SignInOptions): Promise<Result<U, AttemptError>>;
  signIn(user: U, options?: SignInOptions): Promise<'signed-in' | 'two-factor-required'>;
  user(): Promise<U | undefined>;
  id(): Promise<IdOf<U> | undefined>;
};

/** What the type `AccountSessions` has, for the users of a guard. */
export type GuardAccountSessions<U> = Omit<AccountSessions, 'end' | 'endEveryone'> & {
  end(userId: IdOf<U>, options?: { readonly accessTokens?: boolean }): ReturnType<AccountSessions['end']>;
};

/** What the type `PasswordBroker` has, for the users of a guard. */
export type GuardPasswordBroker<U> = Omit<PasswordBroker, 'createToken' | 'deviceCookie' | 'reset'> & {
  createToken(email: string): Promise<Result<{ user: U; token: string }, { readonly kind: 'unavailable' }>>;
  deviceCookie(user: U): ReturnType<PasswordBroker['deviceCookie']>;
  reset(email: string, value: string, password: string): Promise<Result<U, { readonly kind: 'invalid-token' }>>;
};

export interface GuardAuthenticateOptions<N extends string = string> {
  /** Named route of the guard's login page, where browsers are sent. Required: the app's `auth.login` is the app's page. */
  readonly loginRoute: CheckRouteName<N>;
}

export interface GuardGuestOptions<N extends string = string> {
  /** Named route the guard's signed-in users are sent to, resolved when the request arrives. Required: the app's home is the app's page. */
  readonly homeRoute: CheckRouteName<N>;
}

export interface GuardConfirmedPasswordOptions<N extends string = string> {
  /** Named route of the guard's confirmation page. Required: `auth.password.confirm` is the app's page. */
  readonly confirmRoute: CheckRouteName<N>;
  /** How long a confirmation counts, a {@link Duration} above zero (default: the guard's `passwordTimeoutSeconds`). */
  readonly maxAge?: Duration;
}

export interface GuardTwoFactorOptions<S extends string = string, V extends string = string, L extends string = string> {
  /** Named route of the page where a user without a second factor sets one up. */
  readonly setup: CheckRouteName<S>;
  /** Named route of the page that asks this session for its second factor. */
  readonly verify: CheckRouteName<V>;
  /** Named route of the guard's login page, for a request without a user. Required: the app's `auth.login` is the app's page. */
  readonly loginRoute: CheckRouteName<L>;
  /** How long a proven second factor counts, a {@link Duration} above zero (a number is seconds). Default: 24 hours. */
  readonly maxAge?: Duration;
}

export interface GuardConfirmedSecondFactorOptions<V extends string = string, L extends string = string> {
  /** Named route of the page that asks this session for its second factor. */
  readonly verify: CheckRouteName<V>;
  /** Named route of the guard's login page, for a request without a user. Required: the app's `auth.login` is the app's page. */
  readonly loginRoute: CheckRouteName<L>;
}

/** What the type `TwoFactor` has, for the users of a guard: `U` instead of the app's user. */
export type GuardTwoFactor<U> = Omit<TwoFactor, 'challenge'> & {
  challenge(input: SecondFactorInput): Promise<Result<U, ChallengeError>>;
};

/** What the type `Passkeys` has, for the users of a guard: `U` instead of the app's user. `P` is the `Passkeys` class's instance type. */
export type GuardPasskeys<U, P extends { signIn(...parameters: never[]): Promise<Result<unknown>> }> = Omit<P, 'signIn'> & {
  signIn(...parameters: Parameters<P['signIn']>): Promise<Result<U, FailureOf<Awaited<ReturnType<P['signIn']>>>>>;
};

type FailureOf<R> = R extends { readonly ok: false; readonly error: infer E extends { readonly kind: string } } ? E : never;

/** What a guard defined with `passkeys` has besides {@link GuardDefinition}. */
export interface GuardPasskeysDefinition<U, P extends { signIn(...parameters: never[]): Promise<Result<unknown>> }> {
  /** The guard's `Passkeys`, per request: its sign-in, registration, step-up, confirmation and management, on the guard's tables, counters and challenge. */
  readonly Passkeys: Token<GuardPasskeys<U, P>>;
}

/** What a guard defined with `twoFactor` has besides {@link GuardDefinition}. */
export interface GuardTwoFactorDefinition<U> {
  /** The guard's `TwoFactor`, per request: its challenge, setup, recovery codes and step-up, on the guard's tables, counters and encryption context. */
  readonly TwoFactor: Token<GuardTwoFactor<U>>;
  /**
   * Only for the guard's users with a second factor proven within `maxAge` (24 hours): one without a factor goes to `setup`, one that has not
   * proven it to `verify`. Needs the guard's `authenticate()` before it; the app's `twoFactor()` is refused on the guard's routes (error A9).
   */
  twoFactor<const S extends RouteNameInput, const V extends RouteNameInput, const L extends RouteNameInput>(options: GuardTwoFactorOptions<S, V, L>): MiddlewareClass<{ readonly user: U }, {}>;
  /** For the routes that change the guard's factors: a session that has not proven its second factor lately goes to `verify`; an account without a factor passes. */
  confirmedSecondFactor<const V extends RouteNameInput, const L extends RouteNameInput>(options: GuardConfirmedSecondFactorOptions<V, L>): MiddlewareClass<{ readonly user: U }, {}>;
}

/**
 * A guard on the users of a package: its own users, tables, session keys, cookies and counters. Made by {@link defineGuard}; the
 * package registers it in its provider (`OfficeGuard.register(container)`) and injects the services through the tokens.
 */
export interface GuardDefinition<U> {
  readonly name: string;
  readonly tablePrefix: string;
  /** Who is signed in as one of the guard's users: the guard's `Auth`, per request. */
  readonly Auth: Token<GuardAuth<U>>;
  /** Ends every session of one of the guard's users. */
  readonly AccountSessions: Token<GuardAccountSessions<U>>;
  /** Reset links for the guard's users, on the guard's own table. */
  readonly PasswordBroker: Token<GuardPasswordBroker<U>>;
  /**
   * Only for the guard's signed-in users: `Route.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' }))`, then `ctx.user` is
   * the guard's user. Names the guard as the route's: the app's middleware refuses such a route (error A9) and the `Gate` answers no for a policy of another guard.
   */
  authenticate<const N extends RouteNameInput>(options: GuardAuthenticateOptions<N>): MiddlewareClass<{}, { readonly user: U }>;
  /** Only for guests of the guard: its signed-in users are sent to `homeRoute`; the app's users are guests here. */
  guest<const N extends RouteNameInput>(options: GuardGuestOptions<N>): MiddlewareClass<{}, {}>;
  /** "Sudo mode" for the guard: asks its users for their password again; the app's confirmation opens nothing here (error A9 without the guard's `authenticate()` before it). */
  confirmedPassword<const N extends RouteNameInput>(options: GuardConfirmedPasswordOptions<N>): MiddlewareClass<{ readonly user: U }, {}>;
  /** `throttle()` of the guard's own copy of an auth route's limit, counted apart from the app's (`throttle('auth.office.login')` for `'login'`). */
  throttle(name: GuardRouteLimit): MiddlewareClass<{}, {}>;
  /** Binds the guard's services in `container`. Call it in the `register()` of the package's provider; a guard registered twice is a no-op. */
  register(container: Container): void;
}

const PREFIX = /^[a-z][a-z0-9_]*_$/;

const LIMITS = {
  rememberDays: [0, 30],
  sessionMaxHours: [1, 720],
  passwordTimeoutSeconds: [1, Number.MAX_SAFE_INTEGER],
  loginAttemptsPerMinute: [1, 60],
  accountSignInsPerDay: [10, 100_000],
  deviceCookieDays: [0, 365],
  resetMinutes: [1, 1440],
  resetThrottleSeconds: [0, Number.MAX_SAFE_INTEGER],
} as const satisfies Record<Exclude<keyof GuardSettings, 'twoFactorIssuer'>, readonly [number, number]>;

const ISSUER_MAX = 64;

const refuse = (message: string): never => {
  throw new TypeError(withCode('A8', message));
};

/** A guard's settings as `settings` (the app's) with the guard's own over them, each checked against its limits. */
function overlay(name: string, base: AuthConfig, given: unknown): AuthConfig {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) refuse(`defineGuard('${name}'): settings must be an object of ${Object.keys(LIMITS).join(', ')}.`);
  const settings = given as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(LIMITS, key) && key !== 'twoFactorIssuer') refuse(`defineGuard('${name}'): settings.${key} is not a setting of a guard (${[...Object.keys(LIMITS), 'twoFactorIssuer'].join(', ')}); twoFactorIssuer is the only one without an AUTH_ variable.`);
  }
  const issuer = settings.twoFactorIssuer;
  if (issuer !== undefined && (typeof issuer !== 'string' || issuer.trim() === '' || issuer.length > ISSUER_MAX)) {
    refuse(`defineGuard('${name}'): settings.twoFactorIssuer must be a text of 1 to ${ISSUER_MAX} characters.`);
  }
  const checked: Partial<Record<keyof GuardSettings, number>> = {};
  for (const [key, [min, max]] of Object.entries(LIMITS) as [keyof GuardSettings, readonly [number, number]][]) {
    const value = settings[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
      refuse(`defineGuard('${name}'): settings.${key} must be a whole number from ${min} to ${max === Number.MAX_SAFE_INTEGER ? 'any larger' : max}.`);
    }
    checked[key] = value as number;
  }
  const out: { -readonly [K in keyof AuthConfig]: AuthConfig[K] } = { ...base };
  if (checked.rememberDays !== undefined) {
    out.rememberDays = checked.rememberDays;
    out.remember = checked.rememberDays > 0;
  }
  // Its own field: `appName` stays the app's, which other services (a passkey's relying-party name) read.
  if (issuer !== undefined) out.twoFactorIssuer = issuer as string;
  if (checked.sessionMaxHours !== undefined) out.sessionMaxSeconds = checked.sessionMaxHours * 3600;
  for (const key of ['passwordTimeoutSeconds', 'loginAttemptsPerMinute', 'accountSignInsPerDay', 'deviceCookieDays', 'resetMinutes', 'resetThrottleSeconds'] as const) {
    if (checked[key] !== undefined) out[key] = checked[key];
  }
  return out;
}

/** The services of one guard, under keys of their own: a guard's stores and settings are never found under a key of the app's. */
interface GuardTokens {
  readonly settings: Token<AuthConfig>;
  readonly users: Token<UserProvider>;
  readonly signIns: Token<SignInStore>;
  readonly passwordResets: Token<PasswordResetTokenStore>;
  readonly fingerprints: Token<SessionFingerprints>;
  readonly signInThrottle: Token<SignInThrottle>;
  readonly newPassword: Token<NewPassword>;
  readonly context: Token<GuardContext>;
  /** The authenticator and recovery code store; bound for a guard with `twoFactor` only. */
  readonly totp: Token<TwoFactorStore>;
  /** The guard's passkey store; bound for a guard with `passkeys` only. */
  readonly passkeyStore: Token<TwoFactorState>;
  /** The authenticator and the passkeys as one source of factors; bound for a guard with `passkeys` only. */
  readonly factors: Token<TwoFactorState>;
}

/** The tables of a guard: its prefix and the name of each store's table. */
export interface GuardTables {
  readonly signIns: string;
  readonly passwordResets: string;
  /** The authenticator and its recovery codes, for a guard with `twoFactor`. */
  readonly twoFactor?: { readonly factor: string; readonly recoveryCodes: string };
  /** The passkeys, for a guard with `passkeys`. */
  readonly passkeys?: string;
}

/**
 * The guards a container knows. Made by the first provider that needs it, whichever order the providers register in.
 *
 * @internal
 */
export class GuardRegistry {
  readonly #guards = new Map<string, Guard>();

  /** Adds `guard`: a no-op for the one registered already, A8 for another guard with its name or its table prefix. */
  add(guard: Guard): void {
    const known = this.#guards.get(guard.name);
    if (known === guard) return;
    if (known !== undefined) refuse(`Two guards are named '${guard.name}': a guard's name is unique, as it keeps the session keys and counters apart.`);
    for (const other of this.#guards.values()) {
      if (other.tablePrefix === guard.tablePrefix) refuse(`The guards '${other.name}' and '${guard.name}' both keep their tables under the prefix '${guard.tablePrefix}'.`);
    }
    this.#guards.set(guard.name, guard);
  }

  all(): readonly Guard[] {
    return [...this.#guards.values()];
  }
}

/** The registry of `container`, made when there is none. @internal */
export function guardRegistry(container: Container): GuardRegistry {
  if (container.has(GuardRegistry)) return container.make(GuardRegistry);
  const registry = new GuardRegistry();
  container.instance(GuardRegistry, registry);
  return registry;
}

/** Whether a package guard is registered in `container`. @internal */
export function hasPackageGuards(container: Container): boolean {
  return container.has(GuardRegistry) && container.make(GuardRegistry).all().length > 0;
}

/** @internal */
export class Guard {
  readonly name: string;
  readonly tablePrefix: string;
  readonly names: GuardNames;
  readonly tables: GuardTables;
  readonly tokens: GuardTokens;
  readonly Auth: Token<Auth>;
  readonly AccountSessions: Token<AccountSessions>;
  readonly PasswordBroker: Token<PasswordBroker>;
  readonly TwoFactor: Token<TwoFactor>;
  readonly Passkeys: Token<SecondFactorPasskeys>;
  /** What the `Passkeys` class gave the guard to work with, or `undefined` for a guard without passkeys. */
  readonly passkeys: GuardPasskeyKit | undefined;
  readonly #users: Concrete<UserProvider>;
  readonly #twoFactor: typeof TwoFactor | undefined;
  readonly #passkeyClass: GuardPasskeysClass | undefined;
  readonly #settings: unknown;

  constructor(name: string, options: GuardOptions<unknown, typeof TwoFactor | undefined, GuardPasskeysClass | undefined>) {
    if (!isGuardName(name)) refuse(`defineGuard() takes a name of lower case letters, digits and single hyphens, starting with a letter, at most 32 characters and none of web, api, app, auth, marmeon; got ${JSON.stringify(name)}.`);
    const { users, tablePrefix, settings, twoFactor, passkeys } = options ?? ({} as GuardOptions<unknown, typeof TwoFactor | undefined, GuardPasskeysClass | undefined>);
    if (typeof tablePrefix !== 'string' || tablePrefix.length > 32 || !PREFIX.test(tablePrefix)) {
      refuse(`defineGuard('${name}'): tablePrefix is lower case letters, digits and underscores, starts with a letter, ends with an underscore (office_) and has at most 32 characters.`);
    }
    // The container builds a class and calls anything else as a factory, so a factory here would build a provider of no table of the package's.
    if (typeof users !== 'function' || !/^class[\s{]/.test(Function.prototype.toString.call(users))) {
      refuse(`defineGuard('${name}'): users is a class that implements UserProvider, not an instance or a function.`);
    }
    // The class is built for the guard (`buildForGuard`), so anything else is refused here, not at the first request.
    if (twoFactor !== undefined && (typeof twoFactor !== 'function' || (twoFactor as { [GUARD_FEATURE]?: unknown })[GUARD_FEATURE] !== 'two-factor')) refuse(`defineGuard('${name}'): twoFactor is the TwoFactor class of @marmeon/auth/two-factor.`);
    // The brand and the kit it carries, both: a class that only claims the brand would fail at the first request, not here.
    const kit = typeof passkeys === 'function' ? (passkeys as { [GUARD_PASSKEYS]?: Partial<GuardPasskeyKit> })[GUARD_PASSKEYS] : undefined;
    if (passkeys !== undefined && (typeof passkeys !== 'function' || (passkeys as { [GUARD_FEATURE]?: unknown })[GUARD_FEATURE] !== 'passkeys' || typeof kit?.store !== 'function' || typeof kit.isStore !== 'function' || !Array.isArray(kit.columns) || kit.config === undefined)) {
      refuse(`defineGuard('${name}'): passkeys is the Passkeys class from the passkeys subpath of @marmeon/auth.`);
    }
    // A passkey is a second factor: the codes, the recovery codes and the challenge after the password are `TwoFactor`'s, and a guard with passkeys alone would lock its users out.
    if (passkeys !== undefined && twoFactor === undefined) refuse(`defineGuard('${name}'): passkeys needs twoFactor: TwoFactor as well, because a passkey is a second factor and the challenge after the password belongs to TwoFactor.`);
    if (settings !== undefined && typeof settings !== 'function') overlay(name, {} as AuthConfig, settings);
    this.name = name;
    this.tablePrefix = tablePrefix;
    this.names = guardNames(name);
    this.tables = {
      signIns: `${tablePrefix}sign_ins`,
      passwordResets: `${tablePrefix}password_reset_tokens`,
      ...(twoFactor === undefined ? {} : { twoFactor: { factor: `${tablePrefix}two_factor_authentications`, recoveryCodes: `${tablePrefix}two_factor_recovery_codes` } }),
      ...(passkeys === undefined ? {} : { passkeys: `${tablePrefix}passkeys` }),
    };
    this.passkeys = passkeys === undefined ? undefined : (kit as GuardPasskeyKit);
    this.#twoFactor = twoFactor;
    this.#passkeyClass = passkeys;
    this.#users = users as Concrete<UserProvider>;
    this.#settings = settings;
    const key = <T>(what: string) => token<T>(`${name}.${what}`);
    this.tokens = {
      settings: key('settings'),
      users: key('users'),
      signIns: key('signIns'),
      passwordResets: key('passwordResets'),
      fingerprints: key('fingerprints'),
      signInThrottle: key('signInThrottle'),
      newPassword: key('newPassword'),
      context: key('context'),
      totp: key('totp'),
      passkeyStore: key('passkeyStore'),
      factors: key('factors'),
    };
    this.Auth = key('Auth');
    this.AccountSessions = key('AccountSessions');
    this.PasswordBroker = key('PasswordBroker');
    this.TwoFactor = key('TwoFactor');
    this.Passkeys = key('Passkeys');
  }

  register(container: Container): void {
    const registry = guardRegistry(container);
    if (registry.all().includes(this)) return;
    registry.add(this);
    bindRequestGuard(container);
    const { tokens } = this;
    const context = (resolver: Resolver) => new PackageGuardContext(this, resolver, container);
    // For the middleware of the guard, which the router makes in the request's scope.
    container.bind(tokens.context, (c) => context(c));
    container.singleton(tokens.settings, (c) => this.settings(c));
    container.bind(tokens.users, this.#users as never);
    // Each store on the guard's own table: the same id in the app's table is another account.
    container.singleton(tokens.signIns, (c) => new DatabaseSignIns(c.make(Connections), c.make(Clock), { table: this.tables.signIns }));
    container.singleton(tokens.passwordResets, (c) => new DatabasePasswordResetTokens(c.make(Connections), c.make(Clock), { table: this.tables.passwordResets }));
    container.singleton(tokens.fingerprints, (c) => new SessionFingerprints(c.make(EncryptionConfig), this.names));
    container.singleton(tokens.signInThrottle, (c) => new SignInThrottle(c.make(RateLimiter), c.make(EncryptionConfig), c.make(tokens.settings), c.make(SessionConfig), c.make(Clock), c.make(Logger), this.names));
    // A singleton and a command use these without a request: the context reads from the container that makes them, never from a scope.
    container.singleton(tokens.newPassword, (c) => buildForGuard(NewPassword, c, context(c)));
    container.bind(this.AccountSessions, (c) => buildForGuard(AccountSessions, c, context(c)));
    container.bind(this.PasswordBroker, (c) => buildForGuard(PasswordBroker, c, context(c)));
    container.scoped(this.Auth, (c) => buildForGuard(Auth, c, context(c)));
    const twoFactor = this.#twoFactor;
    if (twoFactor !== undefined) {
      // The guard's own tables: the same id in the app's `two_factor_*` tables is another account. The store is the guard's source of factors.
      container.singleton(tokens.totp, (c) => new TwoFactorStore(c.make(Connections), c.make(Clock), { tables: { twoFactor: this.tables.twoFactor!.factor, recoveryCodes: this.tables.twoFactor!.recoveryCodes } }));
      container.scoped(this.TwoFactor, (c) => buildForGuard(twoFactor, c, context(c)));
    }
    const passkeys = this.#passkeyClass;
    const kit = this.passkeys;
    if (passkeys !== undefined && kit !== undefined) {
      // The guard's own tables again, the recovery codes and the authenticator ones included: removing the last factor reaches those, never the app's.
      container.singleton(tokens.passkeyStore, (c) => {
        const store = kit.store(c.make(Connections), c.make(Clock), { passkeys: this.tables.passkeys!, twoFactor: this.tables.twoFactor!.factor, recoveryCodes: this.tables.twoFactor!.recoveryCodes });
        // The store is also the guard's source of the passkey factor: anything else would let a user with passkeys sign in without being asked for one.
        if (!kit.isStore(store)) refuse(`Guard '${this.name}': the passkey store its Passkeys class made is not a PasskeyStore.`);
        return store;
      });
      container.singleton(tokens.factors, (c) => combineFactors(c.make(tokens.totp), c.make(tokens.passkeyStore)));
      container.scoped(this.Passkeys, (c) => buildForGuard(passkeys as never, c, context(c)) as SecondFactorPasskeys);
    }
  }

  /** What a middleware of this guard is injected with, and the name it stamps on the request. */
  get #acting(): MiddlewareGuard {
    return { context: this.tokens.context, name: this.name };
  }

  authenticate(options: GuardAuthenticateOptions): MiddlewareClass<{}, { readonly user: unknown }> {
    return authenticateFor(this.#acting, this.#route('authenticate', 'loginRoute', options?.loginRoute)) as never;
  }

  guest(options: GuardGuestOptions): MiddlewareClass<{}, {}> {
    return guestFor(this.#acting, this.#route('guest', 'homeRoute', options?.homeRoute), false);
  }

  confirmedPassword(options: GuardConfirmedPasswordOptions): MiddlewareClass<{ readonly user: unknown }, {}> {
    return confirmedPasswordFor(this.#acting, this.#route('confirmedPassword', 'confirmRoute', options?.confirmRoute), options) as never;
  }

  throttle(name: GuardRouteLimit): MiddlewareClass<{}, {}> {
    if (!isGuardRouteLimit(name)) throw new TypeError(`Guard '${this.name}'.throttle() takes the name of an auth route's limit (login, password-reset, …); got ${JSON.stringify(name)}.`);
    return throttle(guardLimiterName(this.name, name));
  }

  twoFactor(options: GuardTwoFactorOptions): MiddlewareClass<{ readonly user: unknown }, {}> {
    this.#requireTwoFactor('twoFactor');
    return twoFactorFor(this.#acting, this.#route('twoFactor', 'loginRoute', options?.loginRoute), options) as never;
  }

  confirmedSecondFactor(options: GuardConfirmedSecondFactorOptions): MiddlewareClass<{ readonly user: unknown }, {}> {
    this.#requireTwoFactor('confirmedSecondFactor');
    return confirmedSecondFactorFor(this.#acting, this.#route('confirmedSecondFactor', 'loginRoute', options?.loginRoute), options) as never;
  }

  /** Without `twoFactor` the guard has no factors, and a middleware that asked for one would send everybody to a setup page that cannot work. */
  #requireTwoFactor(method: string): void {
    if (this.#twoFactor === undefined) refuse(`Guard '${this.name}'.${method}() needs the guard to be defined with \`twoFactor: TwoFactor\`.`);
  }

  /** The route a guard's middleware sends to: the app's defaults are the app's pages, so a guard names its own. */
  #route(method: string, option: string, route: unknown): string {
    if (typeof route !== 'string' || route === '') throw new TypeError(`Guard '${this.name}'.${method}() needs \`${option}\`, the named route of the guard's own page: the app's default page belongs to the app.`);
    return route;
  }

  /** The app's `AuthConfig` with the guard's settings over it; A8 for a setting outside its limits. */
  settings(resolver: Resolver): AuthConfig {
    const given = typeof this.#settings === 'function' ? (this.#settings as (resolver: Resolver) => unknown)(resolver) : (this.#settings ?? {});
    return overlay(this.name, resolver.make(AuthConfig), given);
  }
}

/**
 * Defines a guard on the users of a package: sign-in, sign-out, sudo, the list of sign-ins, password reset and "end every session",
 * for a table of users that is not the app's. Nothing is shared with the app's guard but the session cookie, the CSRF token, the hasher
 * and the key: its session keys, cookies, counters, tables and live scope all carry its name, so the same id in two tables is two accounts.
 * Throws error A8 for a name, a prefix or `users` that is invalid. See `docs/authentication.md#guards-of-a-package`.
 *
 * ```ts
 * export const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_' });
 * export type OfficeAuth = GuardAuth<OfficeUser>;
 * export const OfficeAuth = OfficeGuard.Auth; // a controller takes `auth: OfficeAuth`
 * ```
 */
export function defineGuard<U extends { readonly id: string | number }, TF extends typeof TwoFactor | undefined = undefined, PK extends GuardPasskeysClass | undefined = undefined>(
  name: string,
  // `TF` and `PK` are read from the options; the last part only makes `twoFactor` and `passkeys` required once they are the classes.
  options: GuardBaseOptions<U> & { readonly twoFactor?: TF; readonly passkeys?: PK } & GuardOptions<U, NoInfer<TF>, NoInfer<PK>>,
): GuardDefinition<U> & (TF extends undefined ? unknown : GuardTwoFactorDefinition<U>) & (PK extends GuardPasskeysClass ? GuardPasskeysDefinition<U, InstanceType<PK>> : unknown) {
  return new Guard(name, options as GuardOptions<unknown, typeof TwoFactor | undefined, GuardPasskeysClass | undefined>) as never;
}

/** Everything a package guard owns, as the services of the guard see it: its own stores, names and settings, and what it shares with the app. */
class PackageGuardContext extends GuardContext {
  readonly names: GuardNames;
  readonly #guard: Guard;
  readonly #resolver: Resolver;
  readonly #container: Pick<Container, 'has'>;
  #users: UserProvider | undefined;
  readonly #factors = new NoTwoFactorState();
  readonly #passkeys = new NoSecondFactorPasskeys();

  constructor(guard: Guard, resolver: Resolver, container: Pick<Container, 'has'>) {
    super();
    this.#guard = guard;
    this.names = guard.names;
    this.#resolver = resolver;
    this.#container = container;
  }

  get settings(): AuthConfig {
    return this.#resolver.make(this.#guard.tokens.settings);
  }

  get fingerprints(): SessionFingerprints {
    return this.#resolver.make(this.#guard.tokens.fingerprints);
  }

  get signInThrottle(): SignInThrottle {
    return this.#resolver.make(this.#guard.tokens.signInThrottle);
  }

  users(): UserProvider {
    return (this.#users ??= this.#resolver.make(this.#guard.tokens.users));
  }

  signIns(): SignInStore {
    return this.#resolver.make(this.#guard.tokens.signIns);
  }

  passwordResets(): PasswordResetTokenStore {
    return this.#resolver.make(this.#guard.tokens.passwordResets);
  }

  // A package guard has none of the three, and `undefined` makes a service skip the part: the app's tables are never reached through it.
  accessTokens(): AccessTokenStore | undefined {
    return undefined;
  }

  emailChanges(): EmailChangeStore | undefined {
    return undefined;
  }

  userSessions(): UserSessions | undefined {
    return undefined;
  }

  // The guard's own store where it has two-factor authentication, nobody's factors where not: never the app's.
  factors(): TwoFactorState {
    const { tables, tokens } = this.#guard;
    if (tables.twoFactor === undefined) return this.#factors;
    return this.#resolver.make(tables.passkeys === undefined ? tokens.totp : tokens.factors);
  }

  totp(): TwoFactorStore | undefined {
    return this.#guard.tables.twoFactor === undefined ? undefined : this.#resolver.make(this.#guard.tokens.totp);
  }

  // The guard's own store where it has passkeys, none where not: never the app's.
  passkeyStore(): object | undefined {
    return this.#guard.tables.passkeys === undefined ? undefined : this.#resolver.make(this.#guard.tokens.passkeyStore);
  }

  secondFactorPasskeys(): SecondFactorPasskeys {
    return this.#guard.tables.passkeys === undefined ? this.#passkeys : this.#resolver.make(this.#guard.Passkeys);
  }

  newPassword(): NewPassword {
    return this.#resolver.make(this.#guard.tokens.newPassword);
  }

  accountSessions(): AccountSessions {
    return this.#resolver.make(this.#guard.AccountSessions);
  }

  auth(): Auth {
    return this.#resolver.make(this.#guard.Auth);
  }

  connections(): Connections {
    return this.#resolver.make(Connections);
  }

  events(): EventDispatcher {
    return this.#resolver.make(EventDispatcher);
  }

  clock(): Clock {
    return this.#resolver.make(Clock);
  }

  logger(): Logger {
    return this.#resolver.make(Logger);
  }

  endings(): SessionEndings | undefined {
    return this.#container.has(SessionEndings) ? this.#resolver.make(SessionEndings) : undefined;
  }

  // No event of the app's classes: the app's listeners mail the user of the same id in the app's table.
  event(): undefined {
    return undefined;
  }
}

/**
 * What a boot checks of the registered guards: the settings, the sign-in finder of each provider, the tables (`/up/ready` stays red until
 * they have their columns), and the guard's remember-me cookie in the log redactor. Package-internal.
 */
export async function bootGuards(container: Container): Promise<void> {
  if (!container.has(GuardRegistry)) return;
  const guards = container.make(GuardRegistry).all();
  if (guards.length === 0) return;
  const settings = guards.map((guard) => ({ guard, settings: container.make(guard.tokens.settings) }));
  if (container.has(Redactor) && container.has(SessionConfig)) {
    const redactor = container.make(Redactor);
    for (const { guard, settings: own } of settings) redactor.addKeys(guard.names.rememberCookie(own, container.make(SessionConfig)));
  }
  for (const { guard } of settings) {
    let users: UserProvider;
    try {
      users = container.make(guard.tokens.users);
    } catch {
      continue; // a provider that cannot be built here depends on something scoped: no concern of this check
    }
    assertSignInFinder(users);
  }
  // At boot, after every provider registered and `override` ran, so a binding made anywhere counts; a build never boots.
  for (const guard of guards) {
    if (guard.passkeys !== undefined && !container.has(guard.passkeys.config)) {
      refuse(`Guard '${guard.name}' has passkeys, but no provider carries PasskeyConfig: add \`static config = [PasskeyConfig]\` (from the passkeys subpath of @marmeon/auth) to the provider that registers the guard.`);
    }
  }
  if (!container.has(Connections)) return;
  const { SchemaRequirements } = await import('@marmeon/database');
  const requirements = container.make(SchemaRequirements);
  for (const { guard } of settings) {
    requireStoreTables(requirements, { connection: 'default', tables: guard.tables });
    if (guard.tables.passkeys !== undefined && guard.passkeys !== undefined) requirements.require({ connection: 'default', table: guard.tables.passkeys, columns: guard.passkeys.columns, secrets: [] });
  }
}
