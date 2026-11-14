import { Clock, EventDispatcher, Logger, Redactor, token, type Concrete, type Container, type Resolver, type Token } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { Connections } from '@marmeon/database';
import { RateLimiter } from '@marmeon/cache';
import { EncryptionConfig } from '@marmeon/encryption';
import { SessionConfig, SessionEndings, type UserSessions } from '@marmeon/session';
import type { Result } from '@marmeon/core';
import { AccountSessions } from './account-sessions.ts';
import { Auth, type AttemptError, type SignInOptions } from './auth.ts';
import { AuthConfig } from './config.ts';
import type { EmailChangeStore } from './email-changes.ts';
import { SessionFingerprints } from './fingerprint.ts';
import { buildForGuard, GuardContext } from './guard-context.ts';
import { guardNames, isGuardName, type GuardNames } from './guard-names.ts';
import { NewPassword } from './new-password.ts';
import { DatabasePasswordResetTokens, PasswordBroker, type PasswordResetTokenStore } from './password-reset.ts';
import { DatabaseSignIns, type SignInStore } from './sign-ins.ts';
import { SignInThrottle } from './sign-in-throttle.ts';
import type { AccessTokenStore } from './tokens.ts';
import { NoSecondFactorPasskeys, NoTwoFactorState, type SecondFactorPasskeys, type TwoFactorState } from './two-factor/state.ts';
import type { TwoFactorStore } from './two-factor/store.ts';
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
}

/** What `defineGuard()` takes: where the guard's users come from, which tables it owns, and what it sets for itself. */
export interface GuardOptions<U> {
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
} as const satisfies Record<keyof GuardSettings, readonly [number, number]>;

const refuse = (message: string): never => {
  throw new TypeError(withCode('A8', message));
};

/** A guard's settings as `settings` (the app's) with the guard's own over them, each checked against its limits. */
function overlay(name: string, base: AuthConfig, given: unknown): AuthConfig {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) refuse(`defineGuard('${name}'): settings must be an object of ${Object.keys(LIMITS).join(', ')}.`);
  const settings = given as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(LIMITS, key)) refuse(`defineGuard('${name}'): settings.${key} is not a setting of a guard (${Object.keys(LIMITS).join(', ')}).`);
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
}

/** The tables of a guard: its prefix and the name of each store's table. */
export interface GuardTables {
  readonly signIns: string;
  readonly passwordResets: string;
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
  readonly #users: Concrete<UserProvider>;
  readonly #settings: unknown;

  constructor(name: string, options: GuardOptions<unknown>) {
    if (!isGuardName(name)) refuse(`defineGuard() takes a name of lower case letters, digits and single hyphens, starting with a letter, at most 32 characters and none of web, api, app, auth, marmeon; got ${JSON.stringify(name)}.`);
    const { users, tablePrefix, settings } = options ?? ({} as GuardOptions<unknown>);
    if (typeof tablePrefix !== 'string' || tablePrefix.length > 32 || !PREFIX.test(tablePrefix)) {
      refuse(`defineGuard('${name}'): tablePrefix is lower case letters, digits and underscores, starts with a letter, ends with an underscore (office_) and has at most 32 characters.`);
    }
    // The container builds a class and calls anything else as a factory, so a factory here would build a provider of no table of the package's.
    if (typeof users !== 'function' || !/^class[\s{]/.test(Function.prototype.toString.call(users))) {
      refuse(`defineGuard('${name}'): users is a class that implements UserProvider, not an instance or a function.`);
    }
    if (settings !== undefined && typeof settings !== 'function') overlay(name, {} as AuthConfig, settings);
    this.name = name;
    this.tablePrefix = tablePrefix;
    this.names = guardNames(name);
    this.tables = { signIns: `${tablePrefix}sign_ins`, passwordResets: `${tablePrefix}password_reset_tokens` };
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
    };
    this.Auth = key('Auth');
    this.AccountSessions = key('AccountSessions');
    this.PasswordBroker = key('PasswordBroker');
  }

  register(container: Container): void {
    const registry = guardRegistry(container);
    if (registry.all().includes(this)) return;
    registry.add(this);
    const { tokens } = this;
    const context = (resolver: Resolver) => new PackageGuardContext(this, resolver, container);
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
export function defineGuard<U extends { readonly id: string | number }>(name: string, options: GuardOptions<U>): GuardDefinition<U> {
  return new Guard(name, options as GuardOptions<unknown>) as unknown as GuardDefinition<U>;
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

  factors(): TwoFactorState {
    return this.#factors;
  }

  totp(): TwoFactorStore | undefined {
    return undefined;
  }

  passkeyStore(): object | undefined {
    return undefined;
  }

  secondFactorPasskeys(): SecondFactorPasskeys {
    return this.#passkeys;
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
  if (!container.has(Connections)) return;
  const { SchemaRequirements } = await import('@marmeon/database');
  const requirements = container.make(SchemaRequirements);
  for (const { guard } of settings) requireStoreTables(requirements, { connection: 'default', tables: guard.tables });
}
