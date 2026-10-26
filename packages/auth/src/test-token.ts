import type { Container } from '@marmeon/core';
import { AccessTokenStore } from './tokens.ts';
import { idOf, type AuthUser } from './user.ts';

/** A real API token for `user` with `abilities` — what `actingAs(user, { guard: 'api' })` sends as `Authorization: Bearer …`. */
export async function authenticatedToken(container: Container, user: AuthUser, abilities: readonly string[] = ['*']): Promise<string> {
  const { plainText } = await container.createScope().make(AccessTokenStore).create(idOf(user), 'test', { abilities, expiresIn: null });
  return plainText;
}
