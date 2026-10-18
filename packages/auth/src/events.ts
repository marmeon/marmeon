import { isIP } from 'node:net';
import type { StandardSchemaV1 } from '@marmeon/core';
import * as v from 'valibot';
import { idOf, type AuthUser, type AuthUserId } from './user.ts';

/** How a user signed in: with a password (`auth.attempt`), by the app (`auth.login`, e.g. after registering), by the remember-me cookie, with a passkey alone (passwordless). */
export type LoginVia = 'attempt' | 'login' | 'remember' | 'passkey';

/** A point in time: the event's `Date`, queued as an ISO-8601 string (and read back as one). */
const instant = v.pipe(
  v.union([v.date(), v.pipe(v.string(), v.isoTimestamp())]),
  v.transform((value) => (typeof value === 'string' ? value : value.toISOString())),
);

/** A user id as JSON: a string or a number, typed as the app's (`AuthTypes`). */
const userId = v.custom<AuthUserId>((value) => typeof value === 'string' || typeof value === 'number', 'Expected a user id (a string or a number)');

/** The longest user agent an event keeps — the header has no limit, a queued payload should. */
export const MAX_USER_AGENT = 512;

/** What a queued listener of `Login` gets (`EventPayload<typeof Login>`). */
export interface LoginPayload {
  userId: AuthUserId;
  remember: boolean;
  via: LoginVia;
  at: string;
  ip: string | null;
  userAgent: string | null;
}

/** What `Login.schema` accepts: `at` as a `Date` or an ISO-8601 string. */
export interface LoginInput extends Omit<LoginPayload, 'at'> {
  at: Date | string;
}

/** @internal The validation behind `Login.schema`; the type tests compare its output with `LoginPayload`. */
export const loginSchema = v.object({
  userId,
  remember: v.boolean(),
  via: v.picklist(['attempt', 'login', 'remember', 'passkey']),
  at: instant,
  ip: v.nullable(v.string()),
  userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
});

/**
 * A user signed in (password, remember-me cookie, registration). Queueable: a queued listener gets
 * `{ userId, remember, via, at, ip, userAgent }` (`EventPayload<typeof Login>`, `at` as an ISO-8601 string) and reads
 * the account as it is when it runs. `ip` and `userAgent` are the request's (`RequestInfo`: the address through
 * `TRUSTED_PROXIES`) — or what the app passed to `attempt()`/`login()`; null outside a request.
 */
export class Login {
  static readonly event = 'auth.login';
  static readonly schema: StandardSchemaV1<LoginInput, LoginPayload> = loginSchema;
  readonly #event = true;
  readonly user: AuthUser;
  /** Signed in with "remember me" — or by the remember-me cookie. */
  readonly remember: boolean;
  readonly at: Date;
  /** How: a password (`attempt`), the app (`login` — right after registering, say) or the remember-me cookie. */
  readonly via: LoginVia;
  /** The client's address — the request's (`ctx.ip`), or what the app passed. */
  readonly ip: string | null;
  /** The browser's `User-Agent` — the request's, or what the app passed; cut to 512 characters. */
  readonly userAgent: string | null;

  constructor(user: AuthUser, remember = false, at = new Date(), details: { readonly via?: LoginVia; readonly ip?: string | undefined; readonly userAgent?: string | undefined } = {}) {
    this.user = user;
    this.remember = remember;
    this.at = at;
    this.via = details.via ?? 'login';
    this.ip = details.ip ?? null;
    this.userAgent = details.userAgent === undefined ? null : details.userAgent.slice(0, MAX_USER_AGENT);
  }

  /** What a queued listener gets of the event. */
  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** A user signed out. */
export class Logout {
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }
}

/**
 * A sign-in failed. Carries what was typed as identifier (never the password) and the user if
 * the identifier was known — for audit logs; never show it to the client (enumeration).
 */
export class Failed {
  readonly #event = true;
  readonly identifier: string;
  readonly user: AuthUser | undefined;

  constructor(identifier: string, user: AuthUser | undefined) {
    this.identifier = identifier;
    this.user = user;
  }
}

/**
 * Too many password sign-ins, dispatched by `Auth.attempt()`. `scope` says which limit: `client` is one identifier from one address
 * (every refused attempt); `account` is the account's daily ceiling (once per window), and then `ip` is only the request that tipped it
 * over, not the source of the guesses, so a listener that blocks addresses must not act on it. See `docs/authentication.md#events`.
 */
export class Lockout {
  readonly #event = true;
  readonly identifier: string;
  readonly ip: string | undefined;
  readonly scope: 'client' | 'account';

  constructor(identifier: string, ip: string | undefined, scope: 'client' | 'account') {
    this.identifier = identifier;
    this.ip = ip;
    this.scope = scope;
  }
}

/** What a queued listener of `Registered` gets (`EventPayload<typeof Registered>`). */
export interface RegisteredPayload {
  userId: AuthUserId;
}

/** @internal The validation behind `Registered.schema`; the type tests compare its output with `RegisteredPayload`. */
export const registeredSchema = v.object({ userId });

/**
 * A new user registered — the app dispatches it (the verification mail listens to it). Queueable: a queued
 * listener gets `{ userId }` (`EventPayload<typeof Registered>`) and reads the account as it is when it runs.
 */
export class Registered {
  static readonly event = 'auth.registered';
  static readonly schema: StandardSchemaV1<RegisteredPayload> = registeredSchema;
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }

  /** What a queued listener gets of the event. */
  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/**
 * An account's address changed (`EmailChange.confirm()`, or `EmailChange.request()` without private registration): `previousEmail` is
 * the address it had, which the owner should be told about — `null` when the user has none. The new address is `email`.
 */
export class EmailChanged {
  readonly #event = true;
  readonly userId: AuthUserId;
  readonly previousEmail: string | null;
  readonly email: string;

  constructor(userId: AuthUserId, previousEmail: string | null, email: string) {
    this.userId = userId;
    this.previousEmail = previousEmail;
    this.email = email;
  }
}

/**
 * A user changed their password (`Auth.updatePassword()`) — every other session and remember-me token ended, and with
 * `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token (`revokedTokens`: how many).
 */
export class PasswordChanged {
  readonly #event = true;
  readonly user: AuthUser;
  /** The API tokens the new password revoked — 0 unless `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`. */
  readonly revokedTokens: number;

  constructor(user: AuthUser, revokedTokens = 0) {
    this.user = user;
    this.revokedTokens = revokedTokens;
  }
}

/**
 * A password was reset by e-mail link — every session and remember-me token of the user ended, and with
 * `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` every API token (`revokedTokens`: how many).
 */
export class PasswordReset {
  readonly #event = true;
  readonly user: AuthUser;
  /** The API tokens the new password revoked — 0 unless `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`. */
  readonly revokedTokens: number;

  constructor(user: AuthUser, revokedTokens = 0) {
    this.user = user;
    this.revokedTokens = revokedTokens;
  }
}

/** What a queued listener of `EverySessionEnded` gets (`EventPayload<typeof EverySessionEnded>`). */
export interface EverySessionEndedPayload {
  at: string;
  accounts: number;
  resetTokens: number;
  accessTokens: number;
  signIns: number;
}

/** What `EverySessionEnded.schema` accepts: `at` as a `Date` or an ISO-8601 string. */
export interface EverySessionEndedInput extends Omit<EverySessionEndedPayload, 'at'> {
  at: Date | string;
}

/** @internal The validation behind `EverySessionEnded.schema`; the type tests compare its output with `EverySessionEndedPayload`. */
export const everySessionEndedSchema = v.object({ at: instant, accounts: v.number(), resetTokens: v.number(), accessTokens: v.number(), signIns: v.number() });

/**
 * Every session of every account was ended at once (`AccountSessions.endEveryone()`). Queueable: `{ at, accounts, resetTokens,
 * accessTokens, signIns }` (`at` as an ISO-8601 string) — how many accounts got a new session key, and how many password-reset
 * tokens, API tokens (0 unless asked for) and sign-ins (their remember-me tokens with them) were deleted.
 */
export class EverySessionEnded {
  static readonly event = 'auth.every-session-ended';
  static readonly schema: StandardSchemaV1<EverySessionEndedInput, EverySessionEndedPayload> = everySessionEndedSchema;
  readonly #event = true;
  readonly at: Date;
  readonly accounts: number;
  readonly resetTokens: number;
  readonly accessTokens: number;
  readonly signIns: number;

  constructor(at: Date, counts: { readonly accounts: number; readonly resetTokens: number; readonly accessTokens: number; readonly signIns: number }) {
    this.at = at;
    this.accounts = counts.accounts;
    this.resetTokens = counts.resetTokens;
    this.accessTokens = counts.accessTokens;
    this.signIns = counts.signIns;
  }
}

/** What a queued listener of `TwoFactorEnabled` gets (`EventPayload<typeof TwoFactorEnabled>`). */
export interface TwoFactorEnabledPayload {
  userId: AuthUserId;
  factor: 'totp' | 'passkey';
}

/** @internal The validation behind `TwoFactorEnabled.schema`; the type tests compare its output with `TwoFactorEnabledPayload`. */
export const twoFactorEnabledSchema = v.object({ userId, factor: v.picklist(['totp', 'passkey']) });

/** A second factor was turned on for the account (`TwoFactor.confirm()`). Queueable: `{ userId, factor }`. */
export class TwoFactorEnabled {
  static readonly event = 'auth.two-factor-enabled';
  static readonly schema: StandardSchemaV1<TwoFactorEnabledPayload> = twoFactorEnabledSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly factor: 'totp' | 'passkey';

  constructor(user: AuthUser, factor: 'totp' | 'passkey') {
    this.user = user;
    this.factor = factor;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `TwoFactorDisabled` gets (`EventPayload<typeof TwoFactorDisabled>`). */
export interface TwoFactorDisabledPayload {
  userId: AuthUserId;
  via: 'user' | 'operator' | 'reset';
}

/** @internal The validation behind `TwoFactorDisabled.schema`; the type tests compare its output with `TwoFactorDisabledPayload`. */
export const twoFactorDisabledSchema = v.object({ userId, via: v.picklist(['user', 'operator', 'reset']) });

/**
 * A second factor was turned off: by the user (`TwoFactor.disable()`), by the operator's reset command, or by the password reset of an
 * account whose address was never confirmed (`via: 'reset'`). Queueable: `{ userId, via }`.
 */
export class TwoFactorDisabled {
  static readonly event = 'auth.two-factor-disabled';
  static readonly schema: StandardSchemaV1<TwoFactorDisabledPayload> = twoFactorDisabledSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly via: 'user' | 'operator' | 'reset';

  constructor(user: AuthUser, via: 'user' | 'operator' | 'reset' = 'user') {
    this.user = user;
    this.via = via;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `RecoveryCodesGenerated` gets (`EventPayload<typeof RecoveryCodesGenerated>`). */
export interface RecoveryCodesGeneratedPayload {
  userId: AuthUserId;
}

/** @internal The validation behind `RecoveryCodesGenerated.schema`; the type tests compare its output with `RecoveryCodesGeneratedPayload`. */
export const recoveryCodesGeneratedSchema = v.object({ userId });

/** New recovery codes were made (the first factor was turned on, or the user asked for new ones). Queueable: `{ userId }`. */
export class RecoveryCodesGenerated {
  static readonly event = 'auth.recovery-codes-generated';
  static readonly schema: StandardSchemaV1<RecoveryCodesGeneratedPayload> = recoveryCodesGeneratedSchema;
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `RecoveryCodeUsed` gets (`EventPayload<typeof RecoveryCodeUsed>`). */
export interface RecoveryCodeUsedPayload {
  userId: AuthUserId;
  remaining: number;
}

/** @internal The validation behind `RecoveryCodeUsed.schema`; the type tests compare its output with `RecoveryCodeUsedPayload`. */
export const recoveryCodeUsedSchema = v.object({ userId, remaining: v.number() });

/** A recovery code was spent to sign in or to step up; `remaining` are left. Queueable: `{ userId, remaining }`. */
export class RecoveryCodeUsed {
  static readonly event = 'auth.recovery-code-used';
  static readonly schema: StandardSchemaV1<RecoveryCodeUsedPayload> = recoveryCodeUsedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly remaining: number;

  constructor(user: AuthUser, remaining: number) {
    this.user = user;
    this.remaining = remaining;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `TwoFactorChallengeFailed` gets (`EventPayload<typeof TwoFactorChallengeFailed>`). */
export interface TwoFactorChallengeFailedPayload {
  userId: AuthUserId;
  at: string;
  ip: string | null;
  userAgent: string | null;
  during: 'sign-in' | 'step-up' | 'confirm';
}

/** What `TwoFactorChallengeFailed.schema` accepts: `at` as a `Date` or an ISO-8601 string. */
export interface TwoFactorChallengeFailedInput extends Omit<TwoFactorChallengeFailedPayload, 'at'> {
  at: Date | string;
}

/** @internal The validation behind `TwoFactorChallengeFailed.schema`; the type tests compare its output with `TwoFactorChallengeFailedPayload`. */
export const twoFactorChallengeFailedSchema = v.object({
  userId,
  at: instant,
  ip: v.nullable(v.string()),
  userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
  during: v.picklist(['sign-in', 'step-up', 'confirm']),
});

/**
 * A wrong second factor, after the right password (`during: 'sign-in'`) or from a session that is already signed in (`during: 'step-up'`) or a wrong passkey where sudo mode is confirmed with one (`during: 'confirm'`) —
 * for "was this you?" mails and audit logs. Queueable: `{ userId, at, ip, userAgent, during }` (`at` as an ISO-8601 string).
 */
export class TwoFactorChallengeFailed {
  static readonly event = 'auth.two-factor-challenge-failed';
  static readonly schema: StandardSchemaV1<TwoFactorChallengeFailedInput, TwoFactorChallengeFailedPayload> = twoFactorChallengeFailedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly at: Date;
  readonly during: 'sign-in' | 'step-up' | 'confirm';
  readonly ip: string | null;
  readonly userAgent: string | null;

  constructor(user: AuthUser, at = new Date(), details: { readonly ip?: string | undefined; readonly userAgent?: string | undefined; readonly during?: 'sign-in' | 'step-up' | 'confirm' } = {}) {
    this.user = user;
    this.at = at;
    this.during = details.during ?? 'sign-in';
    this.ip = details.ip ?? null;
    this.userAgent = details.userAgent === undefined ? null : details.userAgent.slice(0, MAX_USER_AGENT);
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `PasskeyRegistered` gets (`EventPayload<typeof PasskeyRegistered>`). */
export interface PasskeyRegisteredPayload {
  userId: AuthUserId;
  name: string;
}

/** @internal The validation behind `PasskeyRegistered.schema`; the type tests compare its output with `PasskeyRegisteredPayload`. */
export const passkeyRegisteredSchema = v.object({ userId, name: v.string() });

/** A passkey was registered for the account. Queueable: `{ userId, name }`. */
export class PasskeyRegistered {
  static readonly event = 'auth.passkey-registered';
  static readonly schema: StandardSchemaV1<PasskeyRegisteredPayload> = passkeyRegisteredSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly name: string;

  constructor(user: AuthUser, name: string) {
    this.user = user;
    this.name = name;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `PasskeySignInFailed` gets (`EventPayload<typeof PasskeySignInFailed>`). */
export interface PasskeySignInFailedPayload {
  userId: AuthUserId;
  at: string;
  ip: string | null;
  userAgent: string | null;
}

/** What `PasskeySignInFailed.schema` accepts: `at` as a `Date` or an ISO-8601 string, or left out. */
export interface PasskeySignInFailedInput extends Omit<PasskeySignInFailedPayload, 'at'> {
  at?: Date | string | undefined;
}

/** @internal The validation behind `PasskeySignInFailed.schema`; the type tests compare its output with `PasskeySignInFailedPayload`. */
export const passkeySignInFailedSchema = v.object({
  userId,
  at: v.optional(instant, () => new Date().toISOString()),
  ip: v.nullable(v.string()),
  userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
});

/**
 * Someone presented a passkey of this account for a passwordless sign-in and failed — a wrong signature, or a user handle that is not the
 * account's. For "was this you?" mails and audit logs; the client learns nothing of it. Queueable: `{ userId, at, ip, userAgent }` (`at` as an
 * ISO-8601 string; a payload queued without it counts as having happened when it is read).
 */
export class PasskeySignInFailed {
  static readonly event = 'auth.passkey-sign-in-failed';
  static readonly schema: StandardSchemaV1<PasskeySignInFailedInput, PasskeySignInFailedPayload> = passkeySignInFailedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly at: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;

  constructor(user: AuthUser, details: { readonly ip?: string | undefined; readonly userAgent?: string | undefined } = {}, at = new Date()) {
    this.user = user;
    this.at = at;
    this.ip = details.ip ?? null;
    this.userAgent = details.userAgent === undefined ? null : details.userAgent.slice(0, MAX_USER_AGENT);
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `PasskeyRemoved` gets (`EventPayload<typeof PasskeyRemoved>`). */
export interface PasskeyRemovedPayload {
  userId: AuthUserId;
  via: 'user' | 'reset';
}

/** What `PasskeyRemoved.schema` accepts: `via` may be left out (then `'user'`). */
export interface PasskeyRemovedInput extends Omit<PasskeyRemovedPayload, 'via'> {
  via?: 'user' | 'reset' | undefined;
}

/** @internal The validation behind `PasskeyRemoved.schema`; the type tests compare its output with `PasskeyRemovedPayload`. */
export const passkeyRemovedSchema = v.object({ userId, via: v.optional(v.picklist(['user', 'reset']), 'user') });

/** A passkey was removed from the account: by the user, or by the password reset of an account whose address was never confirmed (`via: 'reset'`). Queueable: `{ userId, via }`. */
export class PasskeyRemoved {
  static readonly event = 'auth.passkey-removed';
  static readonly schema: StandardSchemaV1<PasskeyRemovedInput, PasskeyRemovedPayload> = passkeyRemovedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly via: 'user' | 'reset';

  constructor(user: AuthUser, via: 'user' | 'reset' = 'user') {
    this.user = user;
    this.via = via;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `RememberTokenReused` gets (`EventPayload<typeof RememberTokenReused>`). */
export interface RememberTokenReusedPayload {
  userId: AuthUserId;
  at: string;
  ip: string | null;
  userAgent: string | null;
  sessionsEnded: boolean;
}

/** What `RememberTokenReused.schema` accepts: `at` as a `Date` or an ISO-8601 string. */
export interface RememberTokenReusedInput extends Omit<RememberTokenReusedPayload, 'at'> {
  at: Date | string;
}

/** @internal The validation behind `RememberTokenReused.schema`; the type tests compare its output with `RememberTokenReusedPayload`. */
export const rememberTokenReusedSchema = v.object({
  userId,
  at: instant,
  ip: v.nullable(v.pipe(v.string(), v.ip())),
  userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
  sessionsEnded: v.boolean(),
});

/**
 * A remember-me cookie of a known selector was presented with a validator that is neither the current nor the just-replaced one: an
 * old one (replaced a rotation or many rotations ago) or one never issued. Someone held the cookie, so it was copied. Every
 * remember-me token and session of the account is ended (`sessionsEnded` says whether that worked). Queueable: a queued listener gets
 * `{ userId, at, ip, userAgent, sessionsEnded }` (`at` as an ISO-8601 string) and reads the account as it is when it runs. `ip` and
 * `userAgent` belong to the request that presented the value: whoever holds the copy (possibly the thief) or, more rarely, the owner's
 * browser that missed the response carrying a renewal (a cancelled load, a dropped connection); a mail should say so. Null outside a request. `userAgent` is client-controlled text: show a parsed browser and system
 * (`describeDevice`) in a mail, not the raw header. Carries no cookie value or token.
 */
export class RememberTokenReused {
  static readonly event = 'auth.remember-token-reused';
  static readonly schema: StandardSchemaV1<RememberTokenReusedInput, RememberTokenReusedPayload> = rememberTokenReusedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly at: Date;
  /** The client's address of the request that presented the old cookie. */
  readonly ip: string | null;
  /** That request's `User-Agent` without control characters, cut to 512 characters. */
  readonly userAgent: string | null;
  /** Whether the account's sessions were ended. False when the provider could not (no session key); every remember-me token of the account is gone either way. */
  readonly sessionsEnded: boolean;

  constructor(user: AuthUser, details: { readonly ip?: string | undefined; readonly userAgent?: string | undefined; readonly sessionsEnded: boolean }, at = new Date()) {
    this.user = user;
    this.at = at;
    // Not an address (a pass-through proxy's text, a zone-scoped one): null, so the event always passes its schema when queued.
    this.ip = details.ip !== undefined && isIP(details.ip) ? details.ip : null;
    // oxlint-disable-next-line no-control-regex -- control characters are exactly what it removes
    this.userAgent = details.userAgent === undefined ? null : details.userAgent.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_USER_AGENT);
    this.sessionsEnded = details.sessionsEnded;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** What a queued listener of `PasskeyCloneSuspected` gets (`EventPayload<typeof PasskeyCloneSuspected>`). */
export interface PasskeyCloneSuspectedPayload {
  userId: AuthUserId;
  passkeyId: number;
}

/** @internal The validation behind `PasskeyCloneSuspected.schema`; the type tests compare its output with `PasskeyCloneSuspectedPayload`. */
export const passkeyCloneSuspectedSchema = v.object({ userId, passkeyId: v.number() });

/** A passkey answered with a sign count that did not move forward: it may have been copied. The sign-in was refused, the passkey suspended and every session of the account ended before this event. Queueable: `{ userId, passkeyId }`. */
export class PasskeyCloneSuspected {
  static readonly event = 'auth.passkey-clone-suspected';
  static readonly schema: StandardSchemaV1<PasskeyCloneSuspectedPayload> = passkeyCloneSuspectedSchema;
  readonly #event = true;
  readonly user: AuthUser;
  readonly passkeyId: number;

  constructor(user: AuthUser, passkeyId: number) {
    this.user = user;
    this.passkeyId = passkeyId;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}
