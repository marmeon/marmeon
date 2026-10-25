import type { RateLimiter } from '@marmeon/cache';

/**
 * Whose password check this is: the sign-in's own random key (it survives `regenerate()` within a sign-in, a new sign-in has a new one),
 * and whether that sign-in began with a typed password (`attempt()`), as opposed to a passkey or `signIn()`.
 */
export interface PasswordCheckScope {
  readonly session: string;
  readonly typed: boolean;
}

/** Per sign-in: five a minute and twenty an hour. */
const SESSION_WINDOWS = [
  { name: 'minute', attempts: 5, seconds: 60 },
  { name: 'hour', attempts: 20, seconds: 3600 },
] as const;

/** Per account, for sign-ins that did not begin with a typed password: twenty an hour across all of them. */
const ACCOUNT_WINDOW = { attempts: 20, seconds: 3600 } as const;

/** Per account, for every sign-in, typed or not: stolen sessions cannot add their own limits up past it. */
const ACCOUNT_DAY_WINDOW = { attempts: 100, seconds: 86_400 } as const;

const sessionKey = (window: string, scope: PasswordCheckScope) => `password-check-${window}:session:${scope.session}`;
const accountKey = (userId: number | string) => `password-check-hour:account:${userId}`;
const accountDayKey = (userId: number | string) => `password-check-day:account:${userId}`;

/** A password check that is held up: the seconds to wait, and `account: true` when it is the account's cap and not the sign-in's own windows. */
export interface PasswordThrottled {
  readonly kind: 'throttled';
  readonly retryAfterSeconds: number;
  readonly account?: true;
}

/** Why a signed-in user's password was not accepted: it is wrong, or the checks are held up (`Auth.checkPassword()`). */
export type PasswordCheckError = { readonly kind: 'invalid-password' } | PasswordThrottled;

/**
 * Counts one check of a signed-in user's password, before it is made (atomically: parallel guesses cannot all slip under the limit).
 * Returns the wait when a window is used up, else `undefined`. Every sign-in has its own windows, so one cannot use up
 * another's; the account's cap is shared by the sign-ins that did not begin with a typed password — a stolen passkey-only session
 * cannot lock the owner (who typed the password to sign in) out of the check, but cannot guess across sessions either.
 * One generous cap of a day holds for the account across all its sign-ins, typed or not.
 * `account: true` says the account's cap held the check up: the way out is to sign in again with the password (`attempt()`), which the
 * cap does not apply to — show that, not a wait.
 * For a password, `Auth.checkPassword()` is the way: it counts, checks and clears. This is for the app's own secrets of a signed-in user.
 */
export async function takePasswordCheck(limiter: RateLimiter, scope: PasswordCheckScope, userId: number | string): Promise<PasswordThrottled | undefined> {
  const waits: number[] = [];
  let account = false;
  for (const window of SESSION_WINDOWS) {
    const key = sessionKey(window.name, scope);
    if (!(await limiter.attempt(key, window.attempts, window.seconds))) waits.push(await limiter.availableIn(key));
  }
  // Only a check the sign-in itself allows counts against the account: one that is held up has guessed nothing.
  if (waits.length === 0 && !scope.typed) {
    const key = accountKey(userId);
    if (!(await limiter.attempt(key, ACCOUNT_WINDOW.attempts, ACCOUNT_WINDOW.seconds))) {
      waits.push(await limiter.availableIn(key));
      account = true;
    }
  }
  if (waits.length === 0) {
    const key = accountDayKey(userId);
    if (!(await limiter.attempt(key, ACCOUNT_DAY_WINDOW.attempts, ACCOUNT_DAY_WINDOW.seconds))) {
      waits.push(await limiter.availableIn(key));
      account = true;
    }
  }
  if (waits.length === 0) return undefined;
  return { kind: 'throttled', retryAfterSeconds: Math.max(1, ...waits), ...(account ? { account: true as const } : {}) };
}

/** A right password clears the sign-in's minute (the hours stay: a slow guesser is still counted). */
export async function clearPasswordCheck(limiter: RateLimiter, scope: PasswordCheckScope): Promise<void> {
  await limiter.clear(sessionKey('minute', scope));
}
