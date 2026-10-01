import type { Container } from '@bespokecore/core';
import { AUTH_SESSION_KEYS, passwordFingerprint } from './auth.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/**
 * Session data that signs `user` in, exactly as a login would leave it — what `actingAs(user)` of
 * @bespokecore/testing starts a request with.
 */
export async function authenticatedSession(container: Container, user: AuthUser): Promise<Record<string, unknown>> {
  const id = idOf(user);
  const credentials = await container.createScope().make(UserProvider).findById(id as never);
  if (!credentials) throw new Error(`actingAs(): there is no user ${id} — create it first (e.g. with a factory).`);
  return { [AUTH_SESSION_KEYS.id]: id, [AUTH_SESSION_KEYS.password]: passwordFingerprint(credentials.passwordHash) };
}
