import type { Container } from '@marmeon/core';
import { AUTH_SESSION_KEYS, sessionFingerprint } from './auth.ts';
import { AccessTokenStore } from './tokens.ts';
import { TwoFactorState } from './two-factor/state.ts';
import { hotp, base32Decode, totpStep } from './two-factor/totp.ts';
import { idOf, UserProvider, type AuthUser } from './user.ts';

/**
 * Session data that signs `user` in, exactly as a login would leave it — what `actingAs(user)` of
 * @marmeon/testing starts a request with. It skips two-factor authentication on purpose: a test that acts as a user
 * gets a signed-in session whether or not the account has a second factor (test the challenge by signing in for real). An account
 * that has a factor counts as having proven it, so the `twoFactor()` middleware lets it through; one without a factor is still sent to set one up.
 */
export async function authenticatedSession(container: Container, user: AuthUser): Promise<Record<string, unknown>> {
  const id = idOf(user);
  const scope = container.createScope();
  const credentials = await scope.make(UserProvider).findById(id as never);
  if (!credentials) throw new Error(`actingAs(): there is no user ${id} — create it first (e.g. with a factory).`);
  const proven = (await scope.make(TwoFactorState).factors(id)).length > 0 ? { [AUTH_SESSION_KEYS.twoFactorAt]: Math.floor(Date.now() / 1000) } : {};
  return { [AUTH_SESSION_KEYS.id]: id, [AUTH_SESSION_KEYS.password]: sessionFingerprint(credentials), ...proven };
}

/** A real API token for `user` with `abilities` — what `actingAs(user, { guard: 'api' })` sends as `Authorization: Bearer …`. */
export async function authenticatedToken(container: Container, user: AuthUser, abilities: readonly string[] = ['*']): Promise<string> {
  const { plainText } = await container.createScope().make(AccessTokenStore).create(idOf(user), 'test', { abilities });
  return plainText;
}

/** The code an authenticator app shows for `secret` (the key `TwoFactor.begin()` hands out) at `at` — for tests that sign in with a second factor. */
export function twoFactorCode(secret: string, at: Date = new Date()): string {
  const key = base32Decode(secret);
  if (key === undefined || key.length === 0) throw new Error('twoFactorCode() needs the Base32 key TwoFactor.begin() returned (the "secret" field).');
  return hotp(key, totpStep(at));
}
