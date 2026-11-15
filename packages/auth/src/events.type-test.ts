// Type guarantees of the auth events' queued payloads — checked by `tsc` (typecheck), never run.
import type { EventPayload } from '@marmeon/core';
import * as v from 'valibot';
import type {
  EverySessionEnded,
  SignedIn,
  PasskeyCloneSuspected,
  PasskeyRegistered,
  PasskeyRemoved,
  PasskeySignInFailed,
  RecoveryCodeUsed,
  RecoveryCodesGenerated,
  Registered,
  RememberTokenReused,
  TwoFactorChallengeFailed,
  TwoFactorDisabled,
  TwoFactorEnabled,
  signedInSchema,
  registeredSchema,
  everySessionEndedSchema,
  twoFactorEnabledSchema,
  twoFactorDisabledSchema,
  recoveryCodesGeneratedSchema,
  recoveryCodeUsedSchema,
  twoFactorChallengeFailedSchema,
  passkeyRegisteredSchema,
  passkeySignInFailedSchema,
  passkeyRemovedSchema,
  rememberTokenReusedSchema,
  passkeyCloneSuspectedSchema,
  SignedInPayload,
  RegisteredPayload,
  EverySessionEndedPayload,
  TwoFactorEnabledPayload,
  TwoFactorDisabledPayload,
  RecoveryCodesGeneratedPayload,
  RecoveryCodeUsedPayload,
  TwoFactorChallengeFailedPayload,
  PasskeyRegisteredPayload,
  PasskeySignInFailedPayload,
  PasskeyRemovedPayload,
  RememberTokenReusedPayload,
  PasskeyCloneSuspectedPayload,
  SignedInInput,
  EverySessionEndedInput,
  TwoFactorChallengeFailedInput,
  PasskeySignInFailedInput,
  PasskeyRemovedInput,
  RememberTokenReusedInput,
} from './events.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
// Each way assignable: the payloads also carry `guard?: never` (which keeps a queued listener of a guard's event off the app's class), which the schema's own type does not name.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The annotation on `static schema` must not lie: the schema behind it infers exactly the named payload.
export type LoginOutput = Expect<Same<v.InferOutput<typeof signedInSchema>, SignedInPayload>>;
export type RegisteredOutput = Expect<Same<v.InferOutput<typeof registeredSchema>, RegisteredPayload>>;
export type EverySessionEndedOutput = Expect<Same<v.InferOutput<typeof everySessionEndedSchema>, EverySessionEndedPayload>>;
export type TwoFactorEnabledOutput = Expect<Same<v.InferOutput<typeof twoFactorEnabledSchema>, TwoFactorEnabledPayload>>;
export type TwoFactorDisabledOutput = Expect<Same<v.InferOutput<typeof twoFactorDisabledSchema>, TwoFactorDisabledPayload>>;
export type RecoveryCodesGeneratedOutput = Expect<Same<v.InferOutput<typeof recoveryCodesGeneratedSchema>, RecoveryCodesGeneratedPayload>>;
export type RecoveryCodeUsedOutput = Expect<Same<v.InferOutput<typeof recoveryCodeUsedSchema>, RecoveryCodeUsedPayload>>;
export type TwoFactorChallengeFailedOutput = Expect<Same<v.InferOutput<typeof twoFactorChallengeFailedSchema>, TwoFactorChallengeFailedPayload>>;
export type PasskeyRegisteredOutput = Expect<Same<v.InferOutput<typeof passkeyRegisteredSchema>, PasskeyRegisteredPayload>>;
export type PasskeySignInFailedOutput = Expect<Same<v.InferOutput<typeof passkeySignInFailedSchema>, PasskeySignInFailedPayload>>;
export type PasskeyRemovedOutput = Expect<Same<v.InferOutput<typeof passkeyRemovedSchema>, PasskeyRemovedPayload>>;
export type RememberTokenReusedOutput = Expect<Same<v.InferOutput<typeof rememberTokenReusedSchema>, RememberTokenReusedPayload>>;
export type PasskeyCloneSuspectedOutput = Expect<Same<v.InferOutput<typeof passkeyCloneSuspectedSchema>, PasskeyCloneSuspectedPayload>>;

// The app's payload names `guard` as never: a guard's payload has it as a string.
export type NoGuardInAppPayload = Expect<Equal<SignedInPayload['guard'], undefined>>;

// And `EventPayload` of the class is that payload.
export type SignedInEvent = Expect<Equal<EventPayload<typeof SignedIn>, SignedInPayload>>;
export type RegisteredEvent = Expect<Equal<EventPayload<typeof Registered>, RegisteredPayload>>;
export type EverySessionEndedEvent = Expect<Equal<EventPayload<typeof EverySessionEnded>, EverySessionEndedPayload>>;
export type TwoFactorEnabledEvent = Expect<Equal<EventPayload<typeof TwoFactorEnabled>, TwoFactorEnabledPayload>>;
export type TwoFactorDisabledEvent = Expect<Equal<EventPayload<typeof TwoFactorDisabled>, TwoFactorDisabledPayload>>;
export type RecoveryCodesGeneratedEvent = Expect<Equal<EventPayload<typeof RecoveryCodesGenerated>, RecoveryCodesGeneratedPayload>>;
export type RecoveryCodeUsedEvent = Expect<Equal<EventPayload<typeof RecoveryCodeUsed>, RecoveryCodeUsedPayload>>;
export type TwoFactorChallengeFailedEvent = Expect<Equal<EventPayload<typeof TwoFactorChallengeFailed>, TwoFactorChallengeFailedPayload>>;
export type PasskeyRegisteredEvent = Expect<Equal<EventPayload<typeof PasskeyRegistered>, PasskeyRegisteredPayload>>;
export type PasskeySignInFailedEvent = Expect<Equal<EventPayload<typeof PasskeySignInFailed>, PasskeySignInFailedPayload>>;
export type PasskeyRemovedEvent = Expect<Equal<EventPayload<typeof PasskeyRemoved>, PasskeyRemovedPayload>>;
export type RememberTokenReusedEvent = Expect<Equal<EventPayload<typeof RememberTokenReused>, RememberTokenReusedPayload>>;
export type PasskeyCloneSuspectedEvent = Expect<Equal<EventPayload<typeof PasskeyCloneSuspected>, PasskeyCloneSuspectedPayload>>;

// What the schema accepts is the named input where it differs from the payload.
export type LoginAccepts = Expect<Same<v.InferInput<typeof signedInSchema>, SignedInInput>>;
export type EverySessionEndedAccepts = Expect<Same<v.InferInput<typeof everySessionEndedSchema>, EverySessionEndedInput>>;
export type TwoFactorChallengeFailedAccepts = Expect<Same<v.InferInput<typeof twoFactorChallengeFailedSchema>, TwoFactorChallengeFailedInput>>;
export type PasskeySignInFailedAccepts = Expect<Same<v.InferInput<typeof passkeySignInFailedSchema>, PasskeySignInFailedInput>>;
export type PasskeyRemovedAccepts = Expect<Same<v.InferInput<typeof passkeyRemovedSchema>, PasskeyRemovedInput>>;
export type RememberTokenReusedAccepts = Expect<Same<v.InferInput<typeof rememberTokenReusedSchema>, RememberTokenReusedInput>>;

// Without a separate input type, what the schema accepts is the payload.
export type RegisteredAccepts = Expect<Same<v.InferInput<typeof registeredSchema>, RegisteredPayload>>;
export type TwoFactorEnabledAccepts = Expect<Same<v.InferInput<typeof twoFactorEnabledSchema>, TwoFactorEnabledPayload>>;
export type TwoFactorDisabledAccepts = Expect<Same<v.InferInput<typeof twoFactorDisabledSchema>, TwoFactorDisabledPayload>>;
export type RecoveryCodesGeneratedAccepts = Expect<Same<v.InferInput<typeof recoveryCodesGeneratedSchema>, RecoveryCodesGeneratedPayload>>;
export type RecoveryCodeUsedAccepts = Expect<Same<v.InferInput<typeof recoveryCodeUsedSchema>, RecoveryCodeUsedPayload>>;
export type PasskeyRegisteredAccepts = Expect<Same<v.InferInput<typeof passkeyRegisteredSchema>, PasskeyRegisteredPayload>>;
export type PasskeyCloneSuspectedAccepts = Expect<Same<v.InferInput<typeof passkeyCloneSuspectedSchema>, PasskeyCloneSuspectedPayload>>;
