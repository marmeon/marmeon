import { type Auth, clearPasswordCheck, takePasswordCheck } from '@marmeon/auth';
import { RateLimiter } from '@marmeon/cache';
import { ValidationError } from '@marmeon/http';
import type { Translator } from '@marmeon/i18n';

/**
 * Password checks of a signed-in user (confirmation, password change, other devices, a new address or token): five tries a minute
 * and twenty an hour for each sign-in, and twenty an hour for the account across the sign-ins that did not begin with a typed
 * password — a stolen session must not become a password-guessing oracle, nor lock the owner out of the check (see `takePasswordCheck()`).
 */
export async function throttlePasswordChecks(limiter: RateLimiter, translator: Translator, auth: Auth, userId: number, field: string, check: () => Promise<boolean>): Promise<void> {
  // Counted before the check, atomically — parallel guesses cannot all slip under the limit; a right password clears the sign-in's minute.
  const scope = auth.passwordCheckScope();
  const wait = await takePasswordCheck(limiter, scope, userId);
  if (wait !== undefined) {
    // The account's cap holds up sessions that did not begin with the password: signing in again with it is the way out.
    throw new ValidationError({ [field]: [wait.account ? translator.get('auth.validation.throttled_account') : translator.get('auth.validation.throttled', { seconds: wait.retryAfter })] });
  }
  if (!(await check())) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.password_incorrect')] });
  }
  await clearPasswordCheck(limiter, scope);
}
