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
    const user = this.#users.find(userIdFrom(ctx.request) ?? '');
    if (user) return next({ user });

    // Browsers are sent to the login page, API/JSON clients get a 401.
    const wantsHtml = ctx.request.headers.get('accept')?.includes('text/html');
    return wantsHtml
      ? new Response(null, { status: 302, headers: { location: '/login' } })
      : Response.json({ message: 'Unauthenticated.' }, { status: 401 });
  }
}

function userIdFrom(request: Request): string | undefined {
  const header = request.headers.get('x-user-id');
  if (header) return header;
  const cookie = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return cookie?.[1];
}
