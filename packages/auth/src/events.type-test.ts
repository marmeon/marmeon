// Type guarantees of the auth events' queued payloads — checked by `tsc` (typecheck), never run.
import type { EventPayload } from '@marmeon/core';
import * as v from 'valibot';
import type {
  EverySessionEnded,
  Login,
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
  loginSchema,
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
  LoginPayload,
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
  LoginInput,
  EverySessionEndedInput,
  TwoFactorChallengeFailedInput,
  PasskeySignInFailedInput,
  PasskeyRemovedInput,
  RememberTokenReusedInput,
} from './events.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// The annotation on `static schema` must not lie: the schema behind it infers exactly the named payload.
export type LoginOutput = Expect<Equal<v.InferOutput<typeof loginSchema>, LoginPayload>>;
export type RegisteredOutput = Expect<Equal<v.InferOutput<typeof registeredSchema>, RegisteredPayload>>;
export type EverySessionEndedOutput = Expect<Equal<v.InferOutput<typeof everySessionEndedSchema>, EverySessionEndedPayload>>;
export type TwoFactorEnabledOutput = Expect<Equal<v.InferOutput<typeof twoFactorEnabledSchema>, TwoFactorEnabledPayload>>;
export type TwoFactorDisabledOutput = Expect<Equal<v.InferOutput<typeof twoFactorDisabledSchema>, TwoFactorDisabledPayload>>;
export type RecoveryCodesGeneratedOutput = Expect<Equal<v.InferOutput<typeof recoveryCodesGeneratedSchema>, RecoveryCodesGeneratedPayload>>;
export type RecoveryCodeUsedOutput = Expect<Equal<v.InferOutput<typeof recoveryCodeUsedSchema>, RecoveryCodeUsedPayload>>;
export type TwoFactorChallengeFailedOutput = Expect<Equal<v.InferOutput<typeof twoFactorChallengeFailedSchema>, TwoFactorChallengeFailedPayload>>;
export type PasskeyRegisteredOutput = Expect<Equal<v.InferOutput<typeof passkeyRegisteredSchema>, PasskeyRegisteredPayload>>;
export type PasskeySignInFailedOutput = Expect<Equal<v.InferOutput<typeof passkeySignInFailedSchema>, PasskeySignInFailedPayload>>;
export type PasskeyRemovedOutput = Expect<Equal<v.InferOutput<typeof passkeyRemovedSchema>, PasskeyRemovedPayload>>;
export type RememberTokenReusedOutput = Expect<Equal<v.InferOutput<typeof rememberTokenReusedSchema>, RememberTokenReusedPayload>>;
export type PasskeyCloneSuspectedOutput = Expect<Equal<v.InferOutput<typeof passkeyCloneSuspectedSchema>, PasskeyCloneSuspectedPayload>>;

// And `EventPayload` of the class is that payload.
export type LoginEvent = Expect<Equal<EventPayload<typeof Login>, LoginPayload>>;
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
export type LoginAccepts = Expect<Equal<v.InferInput<typeof loginSchema>, LoginInput>>;
export type EverySessionEndedAccepts = Expect<Equal<v.InferInput<typeof everySessionEndedSchema>, EverySessionEndedInput>>;
export type TwoFactorChallengeFailedAccepts = Expect<Equal<v.InferInput<typeof twoFactorChallengeFailedSchema>, TwoFactorChallengeFailedInput>>;
export type PasskeySignInFailedAccepts = Expect<Equal<v.InferInput<typeof passkeySignInFailedSchema>, PasskeySignInFailedInput>>;
export type PasskeyRemovedAccepts = Expect<Equal<v.InferInput<typeof passkeyRemovedSchema>, PasskeyRemovedInput>>;
export type RememberTokenReusedAccepts = Expect<Equal<v.InferInput<typeof rememberTokenReusedSchema>, RememberTokenReusedInput>>;

// Without a separate input type, what the schema accepts is the payload.
export type RegisteredAccepts = Expect<Equal<v.InferInput<typeof registeredSchema>, RegisteredPayload>>;
export type TwoFactorEnabledAccepts = Expect<Equal<v.InferInput<typeof twoFactorEnabledSchema>, TwoFactorEnabledPayload>>;
export type TwoFactorDisabledAccepts = Expect<Equal<v.InferInput<typeof twoFactorDisabledSchema>, TwoFactorDisabledPayload>>;
export type RecoveryCodesGeneratedAccepts = Expect<Equal<v.InferInput<typeof recoveryCodesGeneratedSchema>, RecoveryCodesGeneratedPayload>>;
export type RecoveryCodeUsedAccepts = Expect<Equal<v.InferInput<typeof recoveryCodeUsedSchema>, RecoveryCodeUsedPayload>>;
export type PasskeyRegisteredAccepts = Expect<Equal<v.InferInput<typeof passkeyRegisteredSchema>, PasskeyRegisteredPayload>>;
export type PasskeyCloneSuspectedAccepts = Expect<Equal<v.InferInput<typeof passkeyCloneSuspectedSchema>, PasskeyCloneSuspectedPayload>>;
