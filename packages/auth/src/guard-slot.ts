import { durationToSeconds, token, type Container, type Key, type Resolver, type Token } from '@marmeon/core';
import { withCode, withoutCode } from '@marmeon/core/internal';
import type { ClassResolver, HttpContext, MiddlewareClass, Next, RouteNameInput } from '@marmeon/router';
import { Auth } from './auth.ts';
import {
  Guard,
  guardRegistry,
  GuardRegistry,
  type GuardAuth,
  type GuardAuthenticateOptions,
  type GuardConfirmedPasswordOptions,
  type GuardConfirmedSecondFactorOptions,
  type GuardDefinition,
  type GuardGuestOptions,
  type GuardTwoFactorDefinition,
  type GuardTwoFactorOptions,
} from './define-guard.ts';
import { isGuardName } from './guard-names.ts';
import { authenticate, confirmedPassword, guest } from './middleware.ts';
import { markNamingMiddleware } from './request-guard.ts';
import { confirmedSecondFactor } from './two-factor/confirmed.ts';
import { twoFactor } from './two-factor/middleware.ts';

/**
 * What every guard slot has: the places a package that serves users of its own, or the app's, asks for "the users of this package". Its
 * policies, `Auth` and route middleware follow the binding the package makes at boot. Made by {@link defineGuardSlot}.
 */
export interface GuardSlotBase<U extends { readonly id: string | number }> {
  /** The slot's name, for messages only: it names no session key, cookie or table. */
  readonly name: string;
  /** Who is signed in as one of the bound guard's users, per request. Resolving it before `bind()` is error A8. */
  readonly Auth: Token<GuardAuth<U>>;
  /** `authenticate()` of the bound guard: the app's `authenticate()` when bound to `'web'`. `loginRoute` is the page of the mode the package runs in. */
  authenticate<const N extends RouteNameInput>(options: GuardAuthenticateOptions<N>): MiddlewareClass<{}, { readonly user: U }>;
  /** `guest()` of the bound guard: the app's `guest()` when bound to `'web'`. */
  guest<const N extends RouteNameInput>(options: GuardGuestOptions<N>): MiddlewareClass<{}, {}>;
  /** `confirmedPassword()` of the bound guard: the app's when bound to `'web'`. */
  confirmedPassword<const N extends RouteNameInput>(options: GuardConfirmedPasswordOptions<N>): MiddlewareClass<{ readonly user: U }, {}>;
}

/** A guard slot made by `defineGuardSlot(name)`. See `docs/authentication.md#using-the-apps-users-instead`. */
export interface GuardSlot<U extends { readonly id: string | number }> extends GuardSlotBase<U> {
  /**
   * Binds the slot, once, in the `register()` or `boot()` of the package's provider: to `'web'`, the app's own users, or to a guard the
   * package defined and registers. A guard that no provider registered stops the boot with error A8.
   */
  bind<V extends U>(container: Container, target: 'web' | GuardDefinition<V>): void;
}

/** A guard slot made by `defineGuardSlot(name, { twoFactor: true })`: it also offers the two-factor middleware, so only a guard defined with `twoFactor` can be bound to it. */
export interface TwoFactorGuardSlot<U extends { readonly id: string | number }> extends GuardSlotBase<U> {
  /** Binds the slot like {@link GuardSlot.bind} (in `register()` or `boot()`), to `'web'` or to a guard defined with `twoFactor` (anything else is error A8). */
  bind<V extends U>(container: Container, target: 'web' | (GuardDefinition<V> & GuardTwoFactorDefinition<V>)): void;
  /** `twoFactor()` of the bound guard: the app's when bound to `'web'`. */
  twoFactor<const S extends RouteNameInput, const V extends RouteNameInput>(options: GuardTwoFactorOptions<S, V>): MiddlewareClass<{ readonly user: U }, {}>;
  /** `confirmedSecondFactor()` of the bound guard: the app's when bound to `'web'`. */
  confirmedSecondFactor<const V extends RouteNameInput>(options: GuardConfirmedSecondFactorOptions<V>): MiddlewareClass<{ readonly user: U }, {}>;
}

/** What a slot's own code refuses: error A8, told apart by class so the start check can report it exactly. @internal */
export class GuardSlotError extends TypeError {
  /** The message without its code, for a finding that carries the code beside it. */
  readonly detail: string;

  constructor(detail: string) {
    super(withCode('A8', detail));
    this.detail = detail;
  }
}

/** Every object `defineGuardSlot()` made, by identity: nothing that merely looks like a slot is one. */
const SLOTS = new WeakMap<object, string>();

/** Whether `value` is a slot made by {@link defineGuardSlot}. @internal */
export function isGuardSlot(value: unknown): value is GuardSlotBase<never> {
  return typeof value === 'object' && value !== null && SLOTS.has(value);
}

/**
 * The slots bound in a container and the target of each, by the slot object (two slots may share a name). A slot nobody bound has no
 * entry, and every use of it is error A8: there is no default, least of all the app's users.
 *
 * @internal
 */
export class SlotBindings {
  readonly #targets = new Map<object, 'web' | Guard>();
  #sealed = false;

  bind(slot: object, name: string, target: 'web' | Guard): void {
    if (this.#targets.has(slot)) throw new GuardSlotError(`The guard slot '${name}' is bound twice: a package binds its slot once, in its provider.`);
    this.#targets.set(slot, target);
  }

  target(slot: object): 'web' | Guard | undefined {
    return this.#targets.get(slot);
  }

  entries(): readonly (readonly [object, 'web' | Guard])[] {
    return [...this.#targets];
  }

  /**
   * Whether the auth provider has booted: a start is judging the routes, not a check that only registers the app. It does not stop a
   * later `bind()`; it says that an unbound slot found now is a mistake of the package, where before it may still be bound.
   */
  get sealed(): boolean {
    return this.#sealed;
  }

  /** Called when the auth provider boots. */
  seal(): void {
    this.#sealed = true;
  }
}

/** The request's scope, for a slot's middleware to build the middleware of the bound guard in. */
const SLOT_SCOPE = token<Resolver>('auth.slotScope');

/** The slots of `container`, made when there are none, with what their middleware needs. @internal */
export function slotBindings(container: Container): SlotBindings {
  if (container.has(SlotBindings)) return container.make(SlotBindings);
  const bindings = new SlotBindings();
  container.instance(SlotBindings, bindings);
  container.scoped(SLOT_SCOPE, (scope) => scope);
  return bindings;
}

/**
 * The guard `slot` is bound to, `'web'` for the app's. The one place a slot is resolved: the gate, the route's stamp and the slot's
 * middleware all ask here. A slot nobody bound, or bound to a guard no provider registered, is error A8 and never the app's users.
 *
 * @internal
 */
export function slotTarget(slot: object, resolve: ClassResolver): 'web' | Guard {
  const name = SLOTS.get(slot) ?? 'unknown';
  const target = resolve(SlotBindings).target(slot);
  if (target === undefined) throw new GuardSlotError(`The guard slot '${name}' is not bound: the package that defines it binds it in its provider's register(), with the slot's bind() to the guard of its own or to 'web'.`);
  if (target !== 'web' && !resolve(GuardRegistry).all().includes(target)) {
    throw new GuardSlotError(`The guard slot '${name}' is bound to the guard '${target.name}', but no provider registered that guard: call the guard's register() in the package's provider.`);
  }
  return target;
}

/** Marks the bindings final and stops the boot for a slot bound to a guard nobody registered. @internal */
export function bootGuardSlots(container: Container): void {
  const bindings = slotBindings(container);
  bindings.seal();
  const registered = guardRegistry(container).all();
  for (const [slot, target] of bindings.entries()) {
    if (target !== 'web' && !registered.includes(target)) {
      throw new GuardSlotError(`The guard slot '${SLOTS.get(slot) ?? 'unknown'}' is bound to the guard '${target.name}', but no provider registered that guard: call the guard's register() in the package's provider.`);
    }
  }
}

/** Whether the slots of the container `resolve` reads are final (see {@link SlotBindings.sealed}). @internal */
export function slotsSealed(resolve: ClassResolver): boolean {
  return resolve(SlotBindings).sealed;
}

type Kind = 'authenticate' | 'guest' | 'confirmedPassword' | 'twoFactor' | 'confirmedSecondFactor';

/** The route options each kind of middleware needs: the app's defaults are the app's pages, so the package names its own. */
const ROUTES: Record<Kind, readonly string[]> = {
  authenticate: ['loginRoute'],
  guest: ['homeRoute'],
  confirmedPassword: ['confirmRoute'],
  twoFactor: ['setup', 'verify'],
  confirmedSecondFactor: ['verify'],
};

type Delegate = { handle(ctx: HttpContext, next: Next<{}>): Promise<Response> | Response };
type DelegateClass = new (...args: any[]) => Delegate;

/** The middleware of `target`: the app's function for `'web'`, the guard's method otherwise. */
function delegateOf(kind: Kind, options: unknown, target: 'web' | Guard): DelegateClass {
  if (target === 'web') {
    const app = { authenticate, guest, confirmedPassword, twoFactor, confirmedSecondFactor }[kind] as (options: unknown) => unknown;
    return app(options) as DelegateClass;
  }
  return (target[kind] as (options: unknown) => unknown).call(target, options) as DelegateClass;
}

/** What each slot middleware class asks of the bound target at the start: the same build a request does, so a refusal comes before any request. */
const SLOT_CHECKS = new WeakMap<object, (resolve: ClassResolver) => void>();

/**
 * What the slot middleware of `pipeline` refuses once the target is known (unbound, an unregistered guard, options its middleware does
 * not take): the text of the first, or `undefined`. Before the boot is over nothing is judged: a slot may still be bound.
 *
 * @internal
 */
export function slotProblem(pipeline: readonly object[], resolve: ClassResolver): string | undefined {
  const checks = pipeline.flatMap((middleware) => SLOT_CHECKS.get(middleware) ?? []);
  if (checks.length === 0 || !slotsSealed(resolve)) return undefined;
  for (const check of checks) {
    try {
      check(resolve);
    } catch (error) {
      if (error instanceof GuardSlotError) return error.detail;
      throw error;
    }
  }
  return undefined;
}

/** The options each kind of middleware reads besides its routes: the window a confirmation or a proof counts for. */
const WINDOWS: Partial<Record<Kind, string>> = { confirmedPassword: 'maxAge', twoFactor: 'maxAge' };

/**
 * The options of a slot's middleware, copied: only the keys the kind reads, frozen, so that what the caller does with its object
 * afterwards (or what else it holds, a function say) changes nothing. Refuses what the guards' own middleware refuses without needing a
 * target. A `Temporal.Duration` or a plain duration object is kept as it is, the plain one copied.
 */
function ownOptions(name: string, kind: Kind, given: unknown): Readonly<Record<string, unknown>> {
  if (typeof given !== 'object' || given === null) throw new TypeError(`Guard slot '${name}'.${kind}() takes its options: ${ROUTES[kind].join(', ')}.`);
  const options: Record<string, unknown> = {};
  for (const key of ROUTES[kind]) {
    const route = (given as Record<string, unknown>)[key];
    if (typeof route !== 'string' || route === '') throw new TypeError(`Guard slot '${name}'.${kind}() needs \`${key}\`, the named route of the package's own page.`);
    options[key] = route;
  }
  // An untyped caller passing `seconds` would silently get the default window.
  if (kind === 'confirmedPassword' && Object.hasOwn(given, 'seconds')) throw new TypeError(`Guard slot '${name}'.confirmedPassword(): \`seconds\` was renamed \`maxAge\`, a Duration where a number is seconds.`);
  const window = WINDOWS[kind];
  const maxAge = window === undefined ? undefined : (given as Record<string, unknown>)[window];
  if (maxAge !== undefined) {
    const seconds = durationToSeconds(maxAge as never);
    if (!(Number.isFinite(seconds) && seconds > 0)) throw new TypeError(`Guard slot '${name}'.${kind}({ maxAge }) takes a Duration above zero.`);
    options.maxAge = typeof maxAge === 'object' && maxAge !== null && Object.getPrototypeOf(maxAge) === Object.prototype ? Object.freeze({ ...maxAge }) : maxAge;
  }
  return Object.freeze(options);
}

/**
 * The middleware of a slot: built when a request arrives, for the guard the slot is bound to by then, and handing the request to that
 * guard's own middleware, so the stamp, the session and the checks are the target's. `authenticate` and `guest` name the route's guard
 * before its first middleware runs, as the guards' own do. The options are copied here and checked as the guards' factories check them,
 * and the start builds the target's middleware once, so a refusal of either is a start error, not a 500 per request.
 */
function slotMiddleware(slot: object, name: string, kind: Kind, given: unknown): MiddlewareClass {
  const options = ownOptions(name, kind, given);
  const delegates = new Map<'web' | Guard, DelegateClass>();
  /** The target's middleware class, made once; whatever its factory refuses is error A8 of the slot. */
  const delegateFor = (target: 'web' | Guard): DelegateClass => {
    let Delegate = delegates.get(target);
    if (Delegate === undefined) {
      try {
        Delegate = delegateOf(kind, options, target);
      } catch (error) {
        if (error instanceof GuardSlotError) throw error;
        throw new GuardSlotError(`The guard slot '${name}' cannot offer ${kind}() on ${target === 'web' ? "'web'" : `the guard '${target.name}'`}: ${withoutCode((error as Error).message)}`);
      }
      delegates.set(target, Delegate);
    }
    return Delegate;
  };
  const SlotMiddleware = class {
    static readonly inject = [SLOT_SCOPE] as const;

    readonly #scope: Resolver;

    constructor(scope: Resolver) {
      this.#scope = scope;
    }

    async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
      const scope = this.#scope;
      // A8 for a slot nobody bound: nothing here falls back to the app's guard.
      const target = slotTarget(slot, (key) => scope.make(key as Key) as never);
      return await scope.make(delegateFor(target)).handle(ctx, next);
    }
  };
  Object.defineProperty(SlotMiddleware, 'name', { value: `${kind}:slot:${name}` });
  if (kind === 'authenticate') {
    Object.defineProperty(SlotMiddleware, 'ensures', { value: ['authenticated'] as const });
    Object.defineProperty(SlotMiddleware, 'adds', { value: ['user'] as const });
  }
  if (kind === 'authenticate' || kind === 'guest') {
    markNamingMiddleware(SlotMiddleware, (resolve) => {
      const target = slotTarget(slot, resolve);
      return target === 'web' ? 'web' : target.name;
    });
  }
  SLOT_CHECKS.set(SlotMiddleware, (resolve) => void delegateFor(slotTarget(slot, resolve)));
  return SlotMiddleware as unknown as MiddlewareClass;
}

/**
 * Defines a guard slot: the place where a package that serves users of its own, or the app's, asks for "the users of this package".
 * Policies name it (`static guard = EditorSlot`), controllers inject `EditorSlot.Auth` and routes use `EditorSlot.authenticate()`;
 * the package binds it at boot, to a guard of its own or to `'web'`. `{ twoFactor: true }` adds `twoFactor()` and
 * `confirmedSecondFactor()` and limits the slot to guards defined with `twoFactor`. Throws error A8 for a name a guard may not have.
 * See `docs/authentication.md#using-the-apps-users-instead`.
 *
 * ```ts
 * export const EditorSlot = defineGuardSlot<EditorUser>('editor');
 * // in the package's provider: EditorSlot.bind(container, config.ownUsers ? OfficeGuard : 'web');
 * ```
 */
export function defineGuardSlot<U extends { readonly id: string | number }>(name: string): GuardSlot<U>;
export function defineGuardSlot<U extends { readonly id: string | number }>(name: string, options: { readonly twoFactor: true }): TwoFactorGuardSlot<U>;
export function defineGuardSlot<U extends { readonly id: string | number }>(name: string, options?: { readonly twoFactor?: true }): GuardSlot<U> | TwoFactorGuardSlot<U> {
  if (!isGuardName(name)) {
    throw new GuardSlotError(`defineGuardSlot() takes a name of lower case letters, digits and single hyphens, starting with a letter, at most 32 characters and none of web, api, app, auth, marmeon; got ${JSON.stringify(name)}.`);
  }
  if (options !== undefined && (typeof options !== 'object' || options === null || Object.keys(options).some((key) => key !== 'twoFactor') || (options.twoFactor !== undefined && options.twoFactor !== true))) {
    throw new GuardSlotError(`defineGuardSlot('${name}') takes no option but \`twoFactor: true\`.`);
  }
  const twoFactor = options?.twoFactor === true;
  // A class nobody bound is built by the container on `make`: until the slot is bound, making its `Auth` is error A8, not a missing binding.
  const Unbound = class {
    constructor() {
      throw new GuardSlotError(`The guard slot '${name}' is not bound: the package that defines it binds it in its provider's register(), with the slot's bind() to the guard of its own or to 'web'.`);
    }
  };
  Object.defineProperty(Unbound, 'name', { value: `GuardSlot:${name}.Auth` });
  const slot = {
    name,
    Auth: Unbound as unknown as Token<GuardAuth<U>>,
    bind(container: Container, target: unknown) {
      // The binding is the container's, app-wide, while `Auth` would be bound on the scope only: a request could not bind it.
      if (container.isScope) throw new GuardSlotError(`The guard slot '${name}' is bound in the app's container, in the provider's register() or boot(), never in a request's scope.`);
      if (target !== 'web' && !(target instanceof Guard)) {
        throw new GuardSlotError(`The guard slot '${name}' is bound to 'web' or to a guard made by defineGuard(); got ${typeof target === 'string' ? JSON.stringify(target) : 'something else'}.`);
      }
      if (twoFactor && target instanceof Guard && target.tables.twoFactor === undefined) {
        throw new GuardSlotError(`The guard slot '${name}' offers two-factor middleware, but the guard '${target.name}' is defined without \`twoFactor\`: bind it to a guard with \`twoFactor: TwoFactor\` or to 'web'.`);
      }
      slotBindings(container).bind(slot, name, target);
      container.scoped(slot.Auth as unknown as Token<unknown>, (scope) => scope.make(target === 'web' ? Auth : (target as Guard).Auth));
    },
    authenticate: (given: unknown) => slotMiddleware(slot, name, 'authenticate', given),
    guest: (given: unknown) => slotMiddleware(slot, name, 'guest', given),
    confirmedPassword: (given: unknown) => slotMiddleware(slot, name, 'confirmedPassword', given),
    ...(twoFactor
      ? {
          twoFactor: (given: unknown) => slotMiddleware(slot, name, 'twoFactor', given),
          confirmedSecondFactor: (given: unknown) => slotMiddleware(slot, name, 'confirmedSecondFactor', given),
        }
      : {}),
  };
  SLOTS.set(slot, name);
  return slot as never;
}
