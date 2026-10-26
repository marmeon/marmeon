/**
 * Which form fields hold something that must not outlive the page that took it: the session's flashed input (`old()`), a
 * form's remembered input and a live validation's request all leave these out. Browser-safe — the server and the client import the same rules (the client loads them on first use), and the
 * compile-time check of `useRemember()` keys and `include` lists is built from the same terms.
 * See docs/forms.md#remembering-input and docs/responses.md#flash-data-and-flash-messages.
 *
 * The terms mirror the log redactor in `@marmeon/core` (which browser code cannot import): a change to one list is a change to
 * the other.
 */

// The terms are strings split by `|`, so one list builds the regular expressions and the types below.
type Split<S extends string> = S extends `${infer Head}|${infer Rest}` ? Head | Split<Rest> : S;

/** Terms that mark a credential or a payment detail when they appear anywhere in a name (any case). */
const NAME_TERMS = 'password|passcode|passphrase|secret|token|credential|signature|jwt|recovery|cvv|cvc|card|iban|dsn';
/** The separator of `api_key`, `appKey`, `privateKey`, `session-id` is optional. */
const KEY_PREFIXES = 'api|app|private|encryption';
/** What a one-time code is called when it comes after one of these (`smsCode`, `backup_codes`; `recovery` is a term of its own). */
const CODE_PREFIXES = 'verification|sms|mfa|2fa|two_factor|auth|backup|security';
/** Terms of a password: never kept, whatever a form asks for (`include`). */
const PASSWORD_TERMS = 'password|passcode|passphrase';

const PASSWORD_NAME = new RegExp(`${PASSWORD_TERMS}|^pass$`, 'i');
// One segment of a name: a term; a code after a prefix (`recovery_code`, `smsCode` — the separator is optional, so camel case is
// the same branch); `otp` or `totp` only as a word (`otp`, `user_totp`, `otpCode` — not `footprint` or `rootPath`) or at a camel-case
// boundary (`userOtp`, `userOTP`, see `CAMEL_OTP`); `code` or `pass` as the whole name (any other `…_code` is a place, a currency or a
// discount: `zip_code`, `promoCode`).
const SENSITIVE_SEGMENT = new RegExp(`${NAME_TERMS}|(?:${KEY_PREFIXES})[-_]?key|session[-_]?id|(?:${CODE_PREFIXES})[-_]?code|(?:^|[-_])t?otp|^(?:codes?|pass|auth)$`, 'i');
// The camel-case boundary is told by its capital, so it is the one pattern that ignores no case.
const CAMEL_OTP = /[a-z](?:Otp|Totp|OTP|TOTP)/;

/** Whether a field — a name, or a path through nested data — is one whose value is kept in neither flashed nor remembered input. */
export function isSensitiveField(field: string): boolean {
  return field.split(/[.[\]]+/).some((segment) => segment !== '' && (SENSITIVE_SEGMENT.test(segment) || CAMEL_OTP.test(segment)));
}

/** Whether a field is never kept, not even when a form names it (`include`): a password. */
export function isPasswordField(field: string): boolean {
  return PASSWORD_NAME.test(field);
}

type Lower = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm' | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Boundary = `${string}${'_' | '-' | '.'}`;
type SensitivePattern =
  | `${string}${Split<typeof NAME_TERMS>}${string}`
  | `${string}${Split<typeof KEY_PREFIXES>}${'' | '_' | '-'}key${string}`
  | `${string}session${'' | '_' | '-'}id${string}`
  | `${string}${Split<typeof CODE_PREFIXES>}${'' | '_' | '-'}code${string}`
  | `${'' | `${string}.`}${'code' | 'codes' | 'pass' | 'auth'}`
  | `${'' | Boundary}${'otp' | 'totp'}${string}`;

/**
 * The compile-time twin of {@link isSensitiveField} for a name: `true` when the name looks like a credential or a payment
 * detail. Built from the same terms; a template type cannot test a boundary as exactly as a regular expression, so it may be
 * stricter at the seams of a path. The acronym in capitals counts only after a lower-case letter, as at run time.
 */
export type LooksSensitive<K extends string> = Lowercase<K> extends SensitivePattern ? true : K extends `${string}${Lower}${'Otp' | 'Totp' | 'OTP' | 'TOTP'}${string}` ? true : false;

/** The compile-time twin of {@link isPasswordField}. */
export type LooksLikePassword<K extends string> = Lowercase<K> extends `${string}${Split<typeof PASSWORD_TERMS>}${string}` | 'pass' ? true : false;
