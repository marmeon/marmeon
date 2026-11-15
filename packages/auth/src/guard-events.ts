import type { StandardResult, StandardSchemaV1 } from '@marmeon/core';
import {
  PasskeyCloneSuspected,
  PasskeyRegistered,
  PasskeyRemoved,
  PasskeySignInFailed,
  PasswordChanged,
  PasswordReset,
  RecoveryCodesGenerated,
  RecoveryCodeUsed,
  RememberTokenReused,
  SignedIn,
  SignedOut,
  SignInFailed,
  SignInLockedOut,
  TwoFactorChallengeFailed,
  TwoFactorDisabled,
  TwoFactorEnabled,
} from './events.ts';
import type { AuthUser, IdOf } from './user.ts';

/** Marks the instance of a guard's event class: the app's classes have no such member, so neither class's instance stands in for the other's. */
declare const guardEvent: unique symbol;

/** Marks the instance of a guard slot's event class: neither the app's classes nor a guard's have such a member. */
declare const slotEvent: unique symbol;

type EventConstructor = abstract new (...parameters: any[]) => object;

/** What a guard's user is where the app's event has the app's: `user` and `userId` take the guard's user type `U` and its id type. */
type Swapped<T, U> = {
  readonly [K in keyof T]: K extends 'user' ? (undefined extends T[K] ? U | undefined : U) : K extends 'userId' ? IdOf<U> : T[K];
};

/** The constructor parameters of the app's class, with the app's user type replaced by the guard's. */
type GuardParameters<P extends readonly unknown[], U> = {
  [I in keyof P]: [P[I]] extends [AuthUser] ? U : [P[I]] extends [AuthUser | undefined] ? ([P[I]] extends [undefined] ? P[I] : U | undefined) : P[I];
};

/** The queueable side of a guard's class: the name behind the guard's own (`office.auth.signed-in`) and a schema whose output also says which guard, with the guard's id type. */
type GuardStatics<C, U> = C extends { readonly event: infer E extends string; readonly schema: StandardSchemaV1<infer I, infer O> }
  ? {
      readonly event: `${string}.${E}`;
      // `slot?: never` keeps a slot's payload apart from a guard's: a listener written for one does not compile on the other, even for users of one shape.
      readonly schema: StandardSchemaV1<Swapped<I, U>, Omit<Swapped<O, U>, 'guard'> & { readonly guard: string } & { readonly slot?: never }>;
    }
  : unknown;

/**
 * An event class of a guard: the public fields and getters of the app's class `C` with the guard's user type `U` for the user and its id, but another class,
 * which the app's class's listeners never see and which no `instanceof` of the app's class holds for.
 */
export type GuardEventClass<C extends EventConstructor, U> = (new (...parameters: GuardParameters<ConstructorParameters<C>, U>) => Swapped<InstanceType<C>, U> & { readonly [guardEvent]: true }) &
  GuardStatics<C, U>;

/**
 * The classes of `@marmeon/auth` that a guard's services dispatch, by key: the keys of {@link GuardEvents} and of a slot's events.
 */
interface GuardEventBases {
  readonly SignedIn: typeof SignedIn;
  readonly SignedOut: typeof SignedOut;
  readonly SignInFailed: typeof SignInFailed;
  readonly SignInLockedOut: typeof SignInLockedOut;
  readonly PasswordChanged: typeof PasswordChanged;
  readonly PasswordReset: typeof PasswordReset;
  readonly RememberTokenReused: typeof RememberTokenReused;
  readonly TwoFactorEnabled: typeof TwoFactorEnabled;
  readonly TwoFactorDisabled: typeof TwoFactorDisabled;
  readonly RecoveryCodesGenerated: typeof RecoveryCodesGenerated;
  readonly RecoveryCodeUsed: typeof RecoveryCodeUsed;
  readonly TwoFactorChallengeFailed: typeof TwoFactorChallengeFailed;
  readonly PasskeyRegistered: typeof PasskeyRegistered;
  readonly PasskeyRemoved: typeof PasskeyRemoved;
  readonly PasskeyCloneSuspected: typeof PasskeyCloneSuspected;
  readonly PasskeySignInFailed: typeof PasskeySignInFailed;
}

/**
 * The events of a package guard: the fields and payload of the classes of `@marmeon/auth`, each class of the guard's own. A queueable one is named after the guard
 * (`office.auth.signed-in`) and its payload says `guard`. `listen(OfficeGuard.events.SignedIn, …)` hears the guard's sign-ins and `listen(SignedIn, …)` hears
 * the app's only. See `docs/authentication.md#events-of-a-guard`.
 */
export type GuardEvents<U = AuthUser> = { readonly [K in keyof GuardEventBases]: GuardEventClass<GuardEventBases[K], U> };

/** The queueable side of a slot's class: a name of its own (`slot.editor.auth.signed-in`) and a schema whose output says which mode (`guard`) and which slot. */
type SlotStatics<C, U> = C extends { readonly event: infer E extends string; readonly schema: StandardSchemaV1<infer I, infer O> }
  ? {
      readonly event: `slot.${string}.${E}`;
      readonly schema: StandardSchemaV1<Omit<Swapped<I, U>, 'guard'> & { readonly guard: string }, Omit<Swapped<O, U>, 'guard'> & { readonly guard: string; readonly slot: string }>;
    }
  : unknown;

/**
 * An event class of a guard slot: the public fields and getters of the app's class `C` with the slot's user type `U` for the user and its id, and `guard`, the mode
 * the event happened in (`'web'` or the bound guard's name). Another class than the app's and than any guard's, so no listener of those hears it and none of
 * their types takes it. The constructor takes the mode first and throws a `TypeError` for anything but `'web'` or a guard's name. See `docs/authentication.md#events-of-a-guard-slot`.
 */
export type SlotEventClass<C extends EventConstructor, U> = (new (guard: string, ...parameters: GuardParameters<ConstructorParameters<C>, U>) => Swapped<InstanceType<C>, U> & {
  readonly guard: string;
  readonly [slotEvent]: true;
}) &
  SlotStatics<C, U>;

/**
 * The events of a guard slot: the classes of {@link GuardEvents}, each of the slot's own. `listen(EditorSlot.events.SignedIn, …)` hears the sign-ins of whichever mode the package
 * bound the slot to, after the bound target's own event, with the mode in `guard`. See `docs/authentication.md#events-of-a-guard-slot`.
 */
export type SlotEvents<U> = { readonly [K in keyof GuardEventBases]: SlotEventClass<GuardEventBases[K], U> };

/**
 * The auth events a guard's services dispatch. Not here: `Registered` (the app's own code raises it), `EmailChanged` (a guard has no change of address)
 * and `EverySessionEnded` (no guard ends every session of every account).
 */
const BASES: GuardEventBases = {
  SignedIn,
  SignedOut,
  SignInFailed,
  SignInLockedOut,
  PasswordChanged,
  PasswordReset,
  RememberTokenReused,
  TwoFactorEnabled,
  TwoFactorDisabled,
  RecoveryCodesGenerated,
  RecoveryCodeUsed,
  TwoFactorChallengeFailed,
  PasskeyRegistered,
  PasskeyRemoved,
  PasskeyCloneSuspected,
  PasskeySignInFailed,
};

/** The guard's event classes and what turns an event of the app's classes into the guard's. @internal */
export interface GuardEventSet {
  readonly events: GuardEvents;
  /** The guard's event for a service's event, or `undefined` for a class the guard has none of: nothing is dispatched then. */
  map(event: object): object | undefined;
}

/**
 * The schema of the app's event with `guard` in its output. Its input is the event as well as the payload that was queued (which carries `guard` already, and
 * the app's schema leaves it out): the name is the guard's, whatever the value says.
 */
function withGuard(base: StandardSchemaV1, guard: string): StandardSchemaV1 {
  const inner = base['~standard'];
  const add = (result: StandardResult<unknown>): StandardResult<unknown> => (result.issues === undefined ? { ...result, value: { ...(result.value as object), guard } } : result);
  return {
    '~standard': {
      version: 1,
      vendor: inner.vendor,
      validate: (value, options) => {
        const result = inner.validate(value, options);
        return result instanceof Promise ? result.then(add) : add(result);
      },
    },
  };
}

/** How a set of derived event classes differs from the app's: the names, the schema and what the constructor takes. @internal */
export interface DeriveOptions {
  /** The class name for the app's class named `base`. */
  className(base: string): string;
  /** The queue name for the app's `event`. */
  eventName(event: string): string;
  /** The schema of the derived class, from the app's. */
  schema(base: StandardSchemaV1): StandardSchemaV1;
  /** Fills `own` from the constructor's `parameters`; the app's event built from them by default. */
  construct?(Base: new (...parameters: never[]) => object, parameters: never[], own: object): void;
}

/**
 * One class per event of {@link BASES}, which does not extend the app's class: the dispatcher also runs the listeners of every class an event
 * extends, so a subclass would still reach the app's listeners. The prototype's getters are copied and every class and the result are frozen
 * (an assignment to `events.SignedIn` would detach every listener registered for the class).
 *
 * @internal
 */
export function deriveEvents(options: DeriveOptions): { readonly events: Record<string, new (...parameters: never[]) => object>; readonly derived: Map<unknown, new (...parameters: never[]) => object> } {
  const derived = new Map<unknown, new (...parameters: never[]) => object>();
  const events: Record<string, new (...parameters: never[]) => object> = {};
  for (const [key, Base] of Object.entries(BASES)) {
    const named = Base as unknown as { readonly event?: string; readonly schema?: StandardSchemaV1; readonly name: string; readonly prototype: object };
    const Own = class {
      constructor(...parameters: never[]) {
        if (options.construct === undefined) Object.assign(this, new (Base as unknown as new (...parameters: never[]) => object)(...parameters));
        else options.construct(Base as unknown as new (...parameters: never[]) => object, parameters, this);
      }
    };
    for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(named.prototype))) {
      if (property !== 'constructor') Object.defineProperty(Own.prototype, property, descriptor);
    }
    Object.defineProperty(Own, 'name', { value: options.className(named.name) });
    if (named.event !== undefined) Object.defineProperty(Own, 'event', { value: options.eventName(named.event), enumerable: true });
    if (named.schema !== undefined) Object.defineProperty(Own, 'schema', { value: options.schema(named.schema), enumerable: true });
    Object.freeze(Own.prototype);
    Object.freeze(Own);
    derived.set(Base, Own);
    events[key] = Own;
  }
  Object.freeze(events);
  return { events, derived };
}

/**
 * One class per event, made once per guard. The class is named with the guard (`office:SignedIn`), so a log line, the devtools or a test
 * failure never reports it as the app's.
 */
export function guardEvents(guard: string): GuardEventSet {
  const { events, derived } = deriveEvents({ className: (base) => `${guard}:${base}`, eventName: (event) => `${guard}.${event}`, schema: (base) => withGuard(base, guard) });
  return {
    events: events as unknown as GuardEvents,
    map(event) {
      // The exact class, not `instanceof`: an event that is not one of the listed classes is dropped.
      const Own = derived.get((event as { constructor?: unknown }).constructor);
      return Own === undefined ? undefined : Object.assign(Object.create(Own.prototype) as object, event);
    },
  };
}
