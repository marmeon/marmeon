import { RateLimiter } from '@marmeon/cache';
import { ValidationError } from '@marmeon/http';
import type { Translator } from '@marmeon/i18n';

/** Password checks per user: five a minute and twenty an hour; a right password clears the minute only. */
const WINDOWS = [
  { attempts: 5, seconds: 60, key: 'password-check' },
  { attempts: 20, seconds: 3600, key: 'password-check-hour' },
] as const;

/**
 * Password checks of a signed-in user (confirmation, password change, other devices, a new address or token): five wrong
 * tries a minute and twenty an hour per user — a stolen session must not become a password-guessing oracle.
 */
export async function throttlePasswordChecks(limiter: RateLimiter, translator: Translator, userId: number, field: string, check: () => Promise<boolean>): Promise<void> {
  // Counted before the check, atomically — parallel guesses cannot all slip under the limit; a right password clears the minute.
  const waits: number[] = [];
  for (const window of WINDOWS) {
    const key = `${window.key}:${userId}`;
    if (!(await limiter.attempt(key, window.attempts, window.seconds))) waits.push(await limiter.availableIn(key));
  }
  if (waits.length > 0) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.throttled', { seconds: Math.max(1, ...waits) })] });
  }
  if (!(await check())) {
    throw new ValidationError({ [field]: [translator.get('auth.validation.password_incorrect')] });
  }
  await limiter.clear(`password-check:${userId}`);
}
