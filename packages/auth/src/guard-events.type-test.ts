// Type guarantees of a guard's event classes — checked by `tsc` (typecheck), never run.
import { listen, type EventPayload } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import { defineGuard } from './define-guard.ts';
import { PasskeyCloneSuspected, SignedIn as SignedInApp, type SignedIn, type SignedOut } from './events.ts';
import type { UserProvider, Credentials } from './user.ts';

interface OfficeUser {
  readonly id: string;
}

declare class OfficeUsers implements UserProvider<OfficeUser> {
  findById(id: string): Promise<Credentials<OfficeUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<OfficeUser> | undefined>;
  updatePasswordHash(id: string, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: string, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: string | undefined }>;
}

declare const OfficeGuard: ReturnType<typeof defineGuard<OfficeUser>>;
const Signed = OfficeGuard.events.SignedIn;

// An app listener class cannot listen to the guard's class, and an app listener function cannot take its events.
class AppListener {
  handle(_event: SignedIn): void {}
}
// @ts-expect-error a listener written for the app's SignedIn
listen(Signed, AppListener);
// @ts-expect-error the same for a function
listen(Signed, (_event: SignedIn) => {});

// The fields are the app's, so a listener reads them as it would there.
listen(Signed, (event) => void event.userId);
listen(Signed, (event) => void event.via);

// The guard's instance is not the app's, and the app's is not the guard's.
declare const own: InstanceType<typeof Signed>;
// @ts-expect-error not a SignedIn
const asApp: SignedIn = own;
declare const app: SignedIn;
// @ts-expect-error not an event of the guard
const asGuard: InstanceType<typeof Signed> = app;
void asApp;
void asGuard;
declare const ownOut: InstanceType<typeof OfficeGuard.events.SignedOut>;
// @ts-expect-error SignedOut of the guard is not the app's SignedOut
const outAsApp: SignedOut = ownOut;
void outAsApp;

// The name is the guard's: not the app's literal.
// @ts-expect-error `office.auth.signed-in` is not 'auth.signed-in'
const appName: 'auth.signed-in' = Signed.event;
void appName;
expectTypeOf(Signed.event).toEqualTypeOf<`${string}.auth.signed-in`>();

// The payload says which guard; the app's does not.
expectTypeOf<EventPayload<typeof Signed>['guard']>().toEqualTypeOf<string>();
// The guard's users have a string id here and the app's a number: the events follow the guard's user, in the payload too.
expectTypeOf<EventPayload<typeof Signed>['userId']>().toEqualTypeOf<string>();
expectTypeOf<EventPayload<typeof import('./events.ts').SignedIn>['userId']>().toEqualTypeOf<number>();

// The constructor takes the guard's user, not the app's.
declare const officeUser: OfficeUser;
new OfficeGuard.events.SignedOut(officeUser);
// @ts-expect-error the app's user is not the guard's
new OfficeGuard.events.SignedOut(app.user);
new OfficeGuard.events.SignInFailed('ada', officeUser);
new OfficeGuard.events.SignInFailed('ada', undefined);
new OfficeGuard.events.SignInLockedOut('ada', undefined, 'client');
new OfficeGuard.events.SignedIn(officeUser, { via: 'attempt' });

// A listener reads the guard's id and user.
listen(Signed, (event) => void event.userId.toUpperCase());
// @ts-expect-error the id is a string
listen(Signed, (event) => void event.userId.toFixed());
listen(Signed, (event) => void event.user.id.toUpperCase());
listen(OfficeGuard.events.SignInFailed, (event) => void event.user?.id.toUpperCase());
// @ts-expect-error the app's id is a number
listen(SignedInApp, (event) => void event.userId.toUpperCase());
// @ts-expect-error a user is required
new OfficeGuard.events.SignedOut();

// Events a guard never raises have no class.
// @ts-expect-error
OfficeGuard.events.EverySessionEnded;
// @ts-expect-error
OfficeGuard.events.Registered;

// A queued listener of the app's payload is not one of the guard's, and the other way round.
class AppQueued {
  static readonly queue = {};
  static readonly listener = 'test.app-queued';
  handle(_payload: EventPayload<typeof PasskeyCloneSuspected>): void {}
}
class GuardQueued {
  static readonly queue = {};
  static readonly listener = 'test.guard-queued';
  handle(_payload: EventPayload<typeof OfficeGuard.events.PasskeyCloneSuspected>): void {}
}
// @ts-expect-error the app's queued listener on the guard's class
listen(OfficeGuard.events.PasskeyCloneSuspected, AppQueued);
// @ts-expect-error the guard's queued listener on the app's class
listen(PasskeyCloneSuspected, GuardQueued);
listen(OfficeGuard.events.PasskeyCloneSuspected, GuardQueued);
listen(PasskeyCloneSuspected, AppQueued);

// The guard's payload has no `slot`, which is what keeps a slot's queued listener off a guard's class; an object literal without it type-checks.
expectTypeOf<EventPayload<typeof Signed>['slot']>().toEqualTypeOf<undefined>();
const payload: EventPayload<typeof Signed> = { userId: '1', remember: false, via: 'attempt', at: '', ip: null, userAgent: null, guard: 'office' };
void payload;
