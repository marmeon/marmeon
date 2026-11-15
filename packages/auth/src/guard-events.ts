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
      readonly schema: StandardSchemaV1<Swapped<I, U>, Omit<Swapped<O, U>, 'guard'> & { readonly guard: string }>;
    }
  : unknown;

/**
 * An event class of a guard: the public fields and getters of the app's class `C` with the guard's user type `U` for the user and its id, but another class,
 * which the app's class's listeners never see and which no `instanceof` of the app's class holds for.
 */
export type GuardEventClass<C extends EventConstructor, U> = (new (...parameters: GuardParameters<ConstructorParameters<C>, U>) => Swapped<InstanceType<C>, U> & { readonly [guardEvent]: true }) &
  GuardStatics<C, U>;

/**
 * The events of a package guard: the fields and payload of the classes of `@marmeon/auth`, each class of the guard's own. A queueable one is named after the guard
 * (`office.auth.signed-in`) and its payload says `guard`. `listen(OfficeGuard.events.SignedIn, …)` hears the guard's sign-ins and `listen(SignedIn, …)` hears
 * the app's only. See `docs/authentication.md#events-of-a-guard`.
 */
export interface GuardEvents<U = AuthUser> {
  readonly SignedIn: GuardEventClass<typeof SignedIn, U>;
  readonly SignedOut: GuardEventClass<typeof SignedOut, U>;
  readonly SignInFailed: GuardEventClass<typeof SignInFailed, U>;
  readonly SignInLockedOut: GuardEventClass<typeof SignInLockedOut, U>;
  readonly PasswordChanged: GuardEventClass<typeof PasswordChanged, U>;
  readonly PasswordReset: GuardEventClass<typeof PasswordReset, U>;
  readonly RememberTokenReused: GuardEventClass<typeof RememberTokenReused, U>;
  readonly TwoFactorEnabled: GuardEventClass<typeof TwoFactorEnabled, U>;
  readonly TwoFactorDisabled: GuardEventClass<typeof TwoFactorDisabled, U>;
  readonly RecoveryCodesGenerated: GuardEventClass<typeof RecoveryCodesGenerated, U>;
  readonly RecoveryCodeUsed: GuardEventClass<typeof RecoveryCodeUsed, U>;
  readonly TwoFactorChallengeFailed: GuardEventClass<typeof TwoFactorChallengeFailed, U>;
  readonly PasskeyRegistered: GuardEventClass<typeof PasskeyRegistered, U>;
  readonly PasskeyRemoved: GuardEventClass<typeof PasskeyRemoved, U>;
  readonly PasskeyCloneSuspected: GuardEventClass<typeof PasskeyCloneSuspected, U>;
  readonly PasskeySignInFailed: GuardEventClass<typeof PasskeySignInFailed, U>;
}

/**
 * The auth events a guard's services dispatch. Not here: `Registered` (the app's own code raises it), `EmailChanged` (a guard has no change of address)
 * and `EverySessionEnded` (no guard ends every session of every account).
 */
const BASES: { readonly [K in keyof GuardEvents]: EventConstructor } = {
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

/**
 * One class per event, made once per guard. A derived class does not extend the app's: the dispatcher also runs the listeners of every class
 * an event extends, so a subclass would still reach the app's listeners of the same user id. The class is named with the guard
 * (`office:SignedIn`), so a log line, the devtools or a test failure never reports it as the app's.
 */
export function guardEvents(guard: string): GuardEventSet {
  const derived = new Map<unknown, new (...parameters: never[]) => object>();
  const events: Record<string, unknown> = {};
  for (const [key, Base] of Object.entries(BASES)) {
    const named = Base as unknown as { readonly event?: string; readonly schema?: StandardSchemaV1; readonly name: string; readonly prototype: object };
    const Own = class {
      constructor(...parameters: never[]) {
        Object.assign(this, new (Base as unknown as new (...parameters: never[]) => object)(...parameters));
      }
    };
    for (const [property, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(named.prototype))) {
      if (property !== 'constructor') Object.defineProperty(Own.prototype, property, descriptor);
    }
    Object.defineProperty(Own, 'name', { value: `${guard}:${named.name}` });
    if (named.event !== undefined) Object.defineProperty(Own, 'event', { value: `${guard}.${named.event}`, enumerable: true });
    if (named.schema !== undefined) Object.defineProperty(Own, 'schema', { value: withGuard(named.schema, guard), enumerable: true });
    // Frozen: an assignment to `events.SignedIn` would detach every listener registered for the class.
    Object.freeze(Own.prototype);
    Object.freeze(Own);
    derived.set(Base, Own);
    events[key] = Own;
  }
  Object.freeze(events);
  return {
    events: events as unknown as GuardEvents,
    map(event) {
      // The exact class, not `instanceof`: an event that is not one of the listed classes is dropped.
      const Own = derived.get((event as { constructor?: unknown }).constructor);
      return Own === undefined ? undefined : Object.assign(Object.create(Own.prototype) as object, event);
    },
  };
}
