import type { AuthUser } from './user.ts';

/** A user signed in (password, remember-me cookie, registration). */
export class Login {
  readonly #event = true;
  readonly user: AuthUser;
  /** Signed in with "remember me" — or by the remember-me cookie. */
  readonly remember: boolean;
  readonly at: Date;

  constructor(user: AuthUser, remember = false, at = new Date()) {
    this.user = user;
    this.remember = remember;
    this.at = at;
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

/** A new user registered — the app dispatches it (verification mails listen to it, step 6). */
export class Registered {
  readonly #event = true;
  readonly user: AuthUser;

  constructor(user: AuthUser) {
    this.user = user;
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
