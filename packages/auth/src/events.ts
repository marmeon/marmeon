import * as v from 'valibot';
import { idOf, type AuthUser, type AuthUserId } from './user.ts';

/** How a user signed in: with a password (`auth.attempt`), by the app (`auth.login`, e.g. after registering), by the remember-me cookie. */
export type LoginVia = 'attempt' | 'login' | 'remember';

/** A point in time: the event's `Date`, queued as an ISO-8601 string (and read back as one). */
const instant = v.pipe(
  v.union([v.date(), v.pipe(v.string(), v.isoTimestamp())]),
  v.transform((value) => (typeof value === 'string' ? value : value.toISOString())),
);

/** A user id as JSON: a string or a number, typed as the app's (`AuthTypes`). */
const userId = v.custom<AuthUserId>((value) => typeof value === 'string' || typeof value === 'number', 'Expected a user id (a string or a number)');

/** The longest user agent an event keeps — the header has no limit, a queued payload should. */
const MAX_USER_AGENT = 512;

/**
 * A user signed in (password, remember-me cookie, registration). Queueable (E86): a queued listener gets
 * `{ userId, remember, via, at, ip, userAgent }` (`EventPayload<typeof Login>`, `at` as an ISO-8601 string) and reads
 * the account as it is when it runs. `ip` and `userAgent` are what the app passed to `attempt()`/`login()` — null
 * otherwise (a remember-me sign-in, a test).
 */
export class Login {
  static readonly event = 'auth.login';
  static readonly schema = v.object({
    userId,
    remember: v.boolean(),
    via: v.picklist(['attempt', 'login', 'remember']),
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
  /** The client's address, if the app passed it (`ctx.ip`). */
  readonly ip: string | null;
  /** The browser's `User-Agent`, if the app passed it — cut to 512 characters. */
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

/** Too many failed sign-ins from one identifier and address — dispatched by the app's login throttle. */
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
 * A new user registered — the app dispatches it (the verification mail listens to it). Queueable (E86): a queued
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

/** A user's password changed (themselves, or by a reset) — every other session and remember-me token ended. */
export class PasswordChanged {
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }
}

/** A password was reset by e-mail link — every session and remember-me token of the user ended. */
export class PasswordReset {
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
  }
}
