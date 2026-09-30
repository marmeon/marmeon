import { defineMiddleware } from '@bespokecore/core';
import { findUser, type User } from './users.ts';

/** Context that `authenticate` adds for everything downstream. */
export interface AuthState {
  user: User;
}

export const SESSION_COOKIE = 'demo_user';

/**
 * Demo authentication — an unsigned cookie (browser) or `x-user-id` header (tests).
 * Replaced by real sessions once they exist; never trust either in production.
 */
function userIdFrom(request: Request): string | undefined {
  const header = request.headers.get('x-user-id');
  if (header) return header;
  const cookie = request.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return cookie?.[1];
}

export const authenticate = defineMiddleware<AuthState>('auth', (ctx, next) => {
  const user = findUser(userIdFrom(ctx.request) ?? '');
  if (user) return next({ user });

  // Browsers are sent to the login page, API/JSON clients get a 401.
  const wantsHtml = ctx.request.headers.get('accept')?.includes('text/html');
  return wantsHtml
    ? new Response(null, { status: 302, headers: { location: '/login' } })
    : Response.json({ message: 'Unauthenticated.' }, { status: 401 });
});
