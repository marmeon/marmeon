import type { HttpContext, Next } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';

declare module '@bespokecore/session' {
  interface SessionData {
    /** The signed-in user — set on login, removed on logout. */
    user_id: string;
    /** Flash messages for the login page. */
    status: string;
    error: string;
  }
}

/** Context that `Authenticate` adds for everything downstream. */
export interface AuthState {
  user: User;
}

/**
 * Demo authentication: the signed-in user's id lives in the session. Real guards,
 * passwords and "remember me" follow in Wave 4.
 *
 * A middleware class: built per request from the container, so the repository and
 * the request's session are injected.
 */
export class Authenticate {
  readonly #users: UserRepository;
  readonly #session: Session;

  constructor(users: UserRepository, session: Session) {
    this.#users = users;
    this.#session = session;
  }

  handle(ctx: HttpContext, next: Next<AuthState>) {
    const user = this.#users.find(this.#session.get('user_id') ?? '');
    if (user) return next({ user });

    // API/JSON clients get a 401, browsers are sent to the login page.
    return ctx.expectsJson()
      ? Response.json({ message: 'Unauthenticated.' }, { status: 401 })
      : new Response(null, { status: 302, headers: { location: '/login' } });
  }
}
