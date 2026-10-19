import type { PasswordCheckError } from '@marmeon/auth';
import type { Translator } from '@marmeon/i18n';

/**
 * The text for a password that `Auth.checkPassword()` did not accept. When the account's cap holds the check up the text names the
 * wait and the way around the hourly part of it — signing in again with the password — but not around the daily part, which holds for
 * a sign-in that began with the password too: so it is never promised as the way out.
 */
export function passwordCheckMessage(translator: Translator, error: PasswordCheckError): string {
  if (error.kind === 'invalid-password') return translator.get('auth.validation.password_incorrect');
  return translator.get(error.account ? 'auth.validation.throttled_account' : 'auth.validation.throttled', { seconds: error.retryAfter });
}
