import { translatable } from '@marmeon/router';
import { rules as r, type Rule, type RuleMessage } from '@marmeon/validation';
import { MAX_PASSWORD_BYTES } from './hashing.ts';

export interface PasswordRuleOptions {
  /** At least this many characters (default 8). Counted after NFKC normalization, in code points — an emoji is one. */
  readonly min?: number;
  /**
   * Own messages — translation keys, texts, or `translatable()`'s. Default: the framework's (`marmeon.validation.password.*`, in the
   * request's language).
   */
  readonly messages?: { readonly required?: RuleMessage; readonly min?: RuleMessage; readonly max?: RuleMessage };
}

const length = (value: string) => [...value.normalize('NFKC')].length;
const bytes = (value: string) => Buffer.byteLength(value.normalize('NFKC'), 'utf8');

/**
 * A new password — a rule of @marmeon/validation: long enough, short enough to hash (4 KiB, the hasher's limit — why it lives
 * here), well-formed, and nothing else. No composition rules (digits, symbols): NIST SP 800-63B advises against them. Never
 * trimmed. Its confirmation is Laravel's `confirmed` of the object:
 *
 * ```ts
 * schema: r.object({ password: password(), password_confirmation: r.string() }).confirmed('password')
 * ```
 */
export function password({ min = 8, messages = {} }: PasswordRuleOptions = {}): Rule<string, string> {
  // Framework texts by key, in the request's language (English without @marmeon/i18n).
  const required = messages.required ?? translatable('marmeon.validation.password.required', {}, 'Enter a password.');
  const short = messages.min ?? translatable('marmeon.validation.password.min', { min }, 'The password needs at least {min} characters.');
  const long = messages.max ?? translatable('marmeon.validation.password.max', {}, 'The password is too long.');
  // Missing, not a string or not well-formed (a lone surrogate the hasher would refuse): "Enter a password".
  return r
    .value<string>((value) => (typeof value === 'string' && value.isWellFormed() ? undefined : required))
    .custom((value) => length(value) >= min, short)
    .custom((value) => bytes(value) <= MAX_PASSWORD_BYTES, long);
}
