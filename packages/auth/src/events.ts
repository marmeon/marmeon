import { isIP } from 'node:net';
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

/**
 * A user signed in (password, remember-me cookie, registration). Queueable: a queued listener gets
 * `{ userId, remember, via, at, ip, userAgent }` (`EventPayload<typeof Login>`, `at` as an ISO-8601 string) and reads
 * the account as it is when it runs. `ip` and `userAgent` are the request's (`RequestInfo`: the address through
 * `TRUSTED_PROXIES`) — or what the app passed to `attempt()`/`login()`; null outside a request.
 */
export class Login {
  static readonly event = 'auth.login';
  static readonly schema = v.object({
    userId,
    remember: v.boolean(),
    via: v.picklist(['attempt', 'login', 'remember', 'passkey']),
    at: instant,
    ip: v.nullable(v.string()),
    userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
  });
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
 * Too many failed sign-ins from one identifier and address — dispatched by the app's login throttle. The starter kit also dispatches it
 * once per window when an account passes its daily ceiling of password sign-ins; then `ip` is only the request that tipped it over, not
 * the source of the guesses, so a listener that blocks addresses must not act on it.
 */
export class Lockout {
  readonly #event = true;
  readonly identifier: string;
  readonly ip: string | undefined;

  constructor(identifier: string, ip: string | undefined) {
    this.identifier = identifier;
    this.ip = ip;
  }
}

/**
 * A new user registered — the app dispatches it (the verification mail listens to it). Queueable: a queued
 * listener gets `{ userId }` (`EventPayload<typeof Registered>`) and reads the account as it is when it runs.
 */
export class Registered {
  static readonly event = 'auth.registered';
  static readonly schema = v.object({ userId });
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

/**
 * Every session of every account was ended at once (`AccountSessions.endEveryone()`). Queueable: `{ at, accounts, rememberTokens,
 * resetTokens, accessTokens, signIns }` (`at` as an ISO-8601 string) — how many accounts got a new session key, and how many
 * remember-me tokens, password-reset tokens, API tokens (0 unless asked for) and sign-in rows were deleted.
 */
export class EverySessionEnded {
  static readonly event = 'auth.every-session-ended';
  static readonly schema = v.object({ at: instant, accounts: v.number(), rememberTokens: v.number(), resetTokens: v.number(), accessTokens: v.number(), signIns: v.number() });
  readonly #event = true;
  readonly at: Date;
  readonly accounts: number;
  readonly rememberTokens: number;
  readonly resetTokens: number;
  readonly accessTokens: number;
  readonly signIns: number;

  constructor(at: Date, counts: { readonly accounts: number; readonly rememberTokens: number; readonly resetTokens: number; readonly accessTokens: number; readonly signIns: number }) {
    this.at = at;
    this.accounts = counts.accounts;
    this.rememberTokens = counts.rememberTokens;
    this.resetTokens = counts.resetTokens;
    this.accessTokens = counts.accessTokens;
    this.signIns = counts.signIns;
  }
}

/** A second factor was turned on for the account (`TwoFactor.confirm()`). Queueable: `{ userId, factor }`. */
export class TwoFactorEnabled {
  static readonly event = 'auth.two-factor-enabled';
  static readonly schema = v.object({ userId, factor: v.picklist(['totp', 'passkey']) });
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

/** A second factor was turned off: by the user (`TwoFactor.disable()`) or by the operator's reset command. Queueable: `{ userId, via }`. */
export class TwoFactorDisabled {
  static readonly event = 'auth.two-factor-disabled';
  static readonly schema = v.object({ userId, via: v.picklist(['user', 'operator']) });
  readonly #event = true;
  readonly user: AuthUser;
  readonly via: 'user' | 'operator';

  constructor(user: AuthUser, via: 'user' | 'operator' = 'user') {
    this.user = user;
    this.via = via;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** New recovery codes were made (the first factor was turned on, or the user asked for new ones). Queueable: `{ userId }`. */
export class RecoveryCodesGenerated {
  static readonly event = 'auth.recovery-codes-generated';
  static readonly schema = v.object({ userId });
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

/** A recovery code was spent to sign in or to step up; `remaining` are left. Queueable: `{ userId, remaining }`. */
export class RecoveryCodeUsed {
  static readonly event = 'auth.recovery-code-used';
  static readonly schema = v.object({ userId, remaining: v.number() });
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

/**
 * A wrong second factor, after the right password (`during: 'sign-in'`) or from a session that is already signed in (`during: 'step-up'`) or a wrong passkey where sudo mode is confirmed with one (`during: 'confirm'`) —
 * for "was this you?" mails and audit logs. Queueable: `{ userId, at, ip, userAgent, during }` (`at` as an ISO-8601 string).
 */
export class TwoFactorChallengeFailed {
  static readonly event = 'auth.two-factor-challenge-failed';
  static readonly schema = v.object({
    userId,
    at: instant,
    ip: v.nullable(v.string()),
    userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
    during: v.picklist(['sign-in', 'step-up', 'confirm']),
  });
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

/** A passkey was registered for the account. Queueable: `{ userId, name }`. */
export class PasskeyRegistered {
  static readonly event = 'auth.passkey-registered';
  static readonly schema = v.object({ userId, name: v.string() });
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

/**
 * Someone presented a passkey of this account for a passwordless sign-in and failed — a wrong signature, or a user handle that is not the
 * account's. For "was this you?" mails and audit logs; the client learns nothing of it. Queueable: `{ userId, at, ip, userAgent }` (`at` as an
 * ISO-8601 string; a payload queued without it counts as having happened when it is read).
 */
export class PasskeySignInFailed {
  static readonly event = 'auth.passkey-sign-in-failed';
  static readonly schema = v.object({
    userId,
    at: v.optional(instant, () => new Date().toISOString()),
    ip: v.nullable(v.string()),
    userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
  });
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

/** A passkey was removed from the account. Queueable: `{ userId }`. */
export class PasskeyRemoved {
  static readonly event = 'auth.passkey-removed';
  static readonly schema = v.object({ userId });
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }

  get userId(): AuthUserId {
    return idOf(this.user) as AuthUserId;
  }
}

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
  static readonly schema = v.object({
    userId,
    at: instant,
    ip: v.nullable(v.pipe(v.string(), v.ip())),
    userAgent: v.nullable(v.pipe(v.string(), v.maxLength(MAX_USER_AGENT))),
    sessionsEnded: v.boolean(),
  });
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

/** A passkey answered with a sign count that did not move forward: it may have been copied. The sign-in was refused. Queueable: `{ userId, passkeyId }`. */
export class PasskeyCloneSuspected {
  static readonly event = 'auth.passkey-clone-suspected';
  static readonly schema = v.object({ userId, passkeyId: v.number() });
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
