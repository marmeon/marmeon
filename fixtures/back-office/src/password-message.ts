import type { PasswordCheckError } from '@marmeon/auth';
import type { Translator } from '@marmeon/i18n';

/** The text for a password the guard did not accept: the wrong one, or a wait that holds the check up. */
export function passwordMessage(translator: Translator, error: PasswordCheckError): string {
  return error.kind === 'invalid-password' ? translator.get('office.confirm.incorrect') : translator.get('office.confirm.throttled', { seconds: error.retryAfterSeconds });
}
