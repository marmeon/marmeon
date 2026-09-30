import type { HttpContext, Next } from '@bespokecore/http';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';

/** Context that `Authenticate` adds for everything downstream. */
export interface AuthState {
  user: User;
}

export const SESSION_COOKIE = 'demo_user';

/**
 * Demo authentication — an unsigned cookie (browser) or `x-user-id` header (tests).
 * Replaced by real sessions in Wave 4; never trust either in production.
 *
 * A middleware class: built per request from the container, so the repository is injected.
 */
export class Authenticate {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    this.#users = users;
  }

  handle(ctx: HttpContext, next: Next<AuthState>) {
    const user = this.#users.find(ctx.request.headers.get('x-user-id') ?? ctx.cookies.get(SESSION_COOKIE) ?? '');
    if (user) return next({ user });

    // API/JSON clients get a 401, browsers are sent to the login page.
    return ctx.expectsJson()
      ? Response.json({ message: 'Unauthenticated.' }, { status: 401 })
      : new Response(null, { status: 302, headers: { location: '/login' } });
  }
}
