import { RateLimiter } from '@bespokecore/cache';
import { ValidationError } from '@bespokecore/http';

/**
 * Password checks of a signed-in user (confirmation, password change, other devices): five wrong
 * tries a minute per user — a stolen session must not become a password-guessing oracle.
 */
export async function throttlePasswordChecks(limiter: RateLimiter, userId: number, field: string, check: () => Promise<boolean>): Promise<void> {
  const key = `password-check:${userId}`;
  if (await limiter.tooManyAttempts(key, 5)) {
    throw new ValidationError({ [field]: [`Too many attempts. Please try again in ${await limiter.availableIn(key)} seconds.`] });
  }
  if (!(await check())) {
    await limiter.hit(key, 60);
    throw new ValidationError({ [field]: ['The password is incorrect.'] });
  }
  await limiter.clear(key);
}
