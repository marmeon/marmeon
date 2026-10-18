import type { PasswordCheckError } from '@marmeon/auth';
import type { Translator } from '@marmeon/i18n';

/**
 * The text for a password that `Auth.checkPassword()` did not accept. When the account's cap holds the check up, signing in again
 * with the password is the way out (the cap does not apply to a sign-in that began with it): that is shown, not a wait.
 */
export function passwordCheckMessage(translator: Translator, error: PasswordCheckError): string {
  if (error.kind === 'invalid-password') return translator.get('auth.validation.password_incorrect');
  return error.account ? translator.get('auth.validation.throttled_account') : translator.get('auth.validation.throttled', { seconds: error.retryAfter });
}
