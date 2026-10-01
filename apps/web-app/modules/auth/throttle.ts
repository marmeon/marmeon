import { RateLimiter } from '@bespokecore/cache';
import { ValidationError } from '@bespokecore/http';
import type { Translator } from '@bespokecore/i18n';

/**
 * Password checks of a signed-in user (confirmation, password change, other devices): five wrong
 * tries a minute per user — a stolen session must not become a password-guessing oracle.
 */
export async function throttlePasswordChecks(limiter: RateLimiter, translator: Translator, userId: number, field: string, check: () => Promise<boolean>): Promise<void> {
  const key = `password-check:${userId}`;
  if (await limiter.tooManyAttempts(key, 5)) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.throttled', { seconds: await limiter.availableIn(key) })] });
  }
  if (!(await check())) {
    await limiter.hit(key, 60);
    throw new ValidationError({ [field]: [translator.get('auth.validation.password_incorrect')] });
  }
  await limiter.clear(key);
}
