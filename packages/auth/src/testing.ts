import type { Container } from '@marmeon/core';
import { AUTH_SESSION_KEYS, sessionFingerprint } from './auth.ts';
import { AccessTokenStore } from './tokens.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/**
 * Session data that signs `user` in, exactly as a login would leave it — what `actingAs(user)` of
 * @marmeon/testing starts a request with. It skips two-factor authentication on purpose: a test that acts as a user
 * gets a signed-in session whether or not the account has a second factor (test the challenge by signing in for real).
 */
export async function authenticatedSession(container: Container, user: AuthUser): Promise<Record<string, unknown>> {
  const id = idOf(user);
  const credentials = await container.createScope().make(UserProvider).findById(id as never);
  if (!credentials) throw new Error(`actingAs(): there is no user ${id} — create it first (e.g. with a factory).`);
  return { [AUTH_SESSION_KEYS.id]: id, [AUTH_SESSION_KEYS.password]: sessionFingerprint(credentials) };
}

/** A real API token for `user` with `abilities` — what `actingAs(user, { guard: 'api' })` sends as `Authorization: Bearer …`. */
export async function authenticatedToken(container: Container, user: AuthUser, abilities: readonly string[] = ['*']): Promise<string> {
  const { plainText } = await container.createScope().make(AccessTokenStore).create(idOf(user), 'test', { abilities });
  return plainText;
}
