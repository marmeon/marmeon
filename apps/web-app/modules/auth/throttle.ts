import { RateLimiter } from '@marmeon/cache';
import { ValidationError } from '@marmeon/http';
import type { Translator } from '@marmeon/i18n';

/**
 * Password checks of a signed-in user (confirmation, password change, other devices): five wrong
 * tries a minute per user — a stolen session must not become a password-guessing oracle.
 */
export async function throttlePasswordChecks(limiter: RateLimiter, translator: Translator, userId: number, field: string, check: () => Promise<boolean>): Promise<void> {
  const key = `password-check:${userId}`;
  // Counted before the check, atomically — parallel guesses cannot all slip under the limit; a right password clears it.
  if (!(await limiter.attempt(key, 5, 60))) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.throttled', { seconds: await limiter.availableIn(key) })] });
  }
  if (!(await check())) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.password_incorrect')] });
  }
  await limiter.clear(key);
}
