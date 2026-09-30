import { defineMiddleware } from '@bespokecore/core';
import { findUser, type User } from './users.ts';

/** Context that `authenticate` adds for everything downstream. */
export interface AuthState {
  user: User;
}

/** Demo authentication via `x-user-id` header — replaced by sessions once they exist. */
export const authenticate = defineMiddleware<AuthState>('auth', (ctx, next) => {
  const user = findUser(ctx.request.headers.get('x-user-id') ?? '');
  return user ? next({ user }) : Response.json({ message: 'Unauthenticated.' }, { status: 401 });
});
