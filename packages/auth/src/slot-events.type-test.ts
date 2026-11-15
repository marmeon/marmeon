// Type guarantees of a guard slot's event classes — checked by `tsc` (typecheck), never run.
import { listen, type EventPayload } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import { defineGuard } from './define-guard.ts';
import { SignedIn as AppSignedIn } from './events.ts';
import type { GuardSlot, TwoFactorGuardSlot } from './guard-slot.ts';
import type { UserProvider, Credentials } from './user.ts';

// The same shape: only the brands and the payload keys keep the three kinds of listener apart.
interface OfficeUser {
  readonly id: number;
  readonly email: string;
}
interface EditorUser {
  readonly id: number;
  readonly email: string;
}

declare class OfficeUsers implements UserProvider<OfficeUser> {
  findById(id: number): Promise<Credentials<OfficeUser> | undefined>;
  findForSignIn(identifier: string): Promise<Credentials<OfficeUser> | undefined>;
  updatePasswordHash(id: number, hash: never, options?: { readonly expected?: never; readonly sessionKey?: string; readonly expectedSessionKey?: string | null }): Promise<boolean>;
  updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean>;
  updateEverySessionKey(key: string): Promise<{ readonly accounts: number; readonly sampleId: number | undefined }>;
}

declare const OfficeGuard: ReturnType<typeof defineGuard<OfficeUser>>;
declare const EditorSlot: GuardSlot<EditorUser>;
declare const TwoFactorEditorSlot: TwoFactorGuardSlot<EditorUser>;
const SlotSignedIn = EditorSlot.events.SignedIn;
const OfficeSignedIn = OfficeGuard.events.SignedIn;

// The events exist on a slot with two-factor middleware too, and they are that slot's: the same class types.
expectTypeOf(TwoFactorEditorSlot.events.SignedIn).toEqualTypeOf<typeof EditorSlot.events.SignedIn>();
void TwoFactorEditorSlot.events.PasskeyRegistered;

// A sync listener of the slot reads the slot's user and the mode.
listen(SlotSignedIn, (event) => {
  expectTypeOf(event.user).toEqualTypeOf<EditorUser>();
  expectTypeOf(event.guard).toEqualTypeOf<string>();
  expectTypeOf(event.userId).toEqualTypeOf<number>();
});

// One listener per direction, written for one kind and registered on another.
const appListener = (_event: InstanceType<typeof AppSignedIn>): void => {};
const slotListener = (_event: InstanceType<typeof SlotSignedIn>): void => {};
const officeListener = (_event: InstanceType<typeof OfficeSignedIn>): void => {};
listen(SlotSignedIn, slotListener);
listen(OfficeSignedIn, officeListener);
listen(AppSignedIn, appListener);
// @ts-expect-error the slot's listener on the app's class
listen(AppSignedIn, slotListener);
// @ts-expect-error the app's listener on the slot's class
listen(SlotSignedIn, appListener);
// @ts-expect-error the slot's listener on the guard's class
listen(OfficeSignedIn, slotListener);
// @ts-expect-error the guard's listener on the slot's class
listen(SlotSignedIn, officeListener);

// Queued: the payloads differ by `guard?: never` (app), `slot?: never` (guard) and `guard`/`slot` (slot), whatever the users look like.
class SlotQueued {
  static readonly queue = {};
  static readonly listener = 'test.slot-queued';
  handle(_payload: EventPayload<typeof SlotSignedIn>): void {}
}
class GuardQueued {
  static readonly queue = {};
  static readonly listener = 'test.guard-queued';
  handle(_payload: EventPayload<typeof OfficeSignedIn>): void {}
}
class AppQueued {
  static readonly queue = {};
  static readonly listener = 'test.app-queued';
  handle(_payload: EventPayload<typeof AppSignedIn>): void {}
}
listen(SlotSignedIn, SlotQueued);
listen(OfficeSignedIn, GuardQueued);
listen(AppSignedIn, AppQueued);
// @ts-expect-error the guard's payload handler on the slot's class (`slot?: never` against `slot: string`)
listen(SlotSignedIn, GuardQueued);
// @ts-expect-error the slot's payload handler on the guard's class
listen(OfficeSignedIn, SlotQueued);
// @ts-expect-error the app's payload handler on the slot's class
listen(SlotSignedIn, AppQueued);
// @ts-expect-error the slot's payload handler on the app's class
listen(AppSignedIn, SlotQueued);

// The payload says the mode, the slot and the id.
expectTypeOf<EventPayload<typeof SlotSignedIn>['guard']>().toEqualTypeOf<string>();
expectTypeOf<EventPayload<typeof SlotSignedIn>['slot']>().toEqualTypeOf<string>();
expectTypeOf<EventPayload<typeof SlotSignedIn>['userId']>().toEqualTypeOf<number>();
expectTypeOf<EventPayload<typeof OfficeSignedIn>['slot']>().toEqualTypeOf<undefined>();

// The queue name is the slot's own.
expectTypeOf(SlotSignedIn.event).toEqualTypeOf<`slot.${string}.auth.signed-in`>();

// The constructor takes the mode first, then what the app's class takes with the slot's user.
declare const editor: EditorUser;
new EditorSlot.events.SignedOut('web', editor);
new EditorSlot.events.SignInFailed('office', 'ada', editor);
// @ts-expect-error the mode comes first
new EditorSlot.events.SignedOut(editor);
// @ts-expect-error the mode is a string
new EditorSlot.events.SignedOut(1, editor);

// Events no guard raises have no class.
// @ts-expect-error
EditorSlot.events.EverySessionEnded;
// @ts-expect-error
EditorSlot.events.Registered;
// @ts-expect-error
EditorSlot.events.EmailChanged;
