import { translatable } from '@marmeon/router';
import * as v from 'valibot';
import { MAX_PASSWORD_BYTES } from './hashing.ts';

export interface PasswordRuleOptions {
  /** At least this many characters (default 8). Counted after NFKC normalization, in code points — an emoji is one. */
  readonly min?: number;
  /** Own messages — texts, or translation keys (`trans('auth.password.short')` of @marmeon/i18n). Default: the framework's (`marmeon.validation.password.*`). */
  readonly messages?: { readonly required?: Message; readonly min?: Message; readonly max?: Message };
}

/** A validation message: a text (or a key the request's translator knows), or a message function like `translatable()`'s. */
type Message = string | ((issue: object) => string);

const length = (value: string) => [...value.normalize('NFKC')].length;
const bytes = (value: string) => Buffer.byteLength(value.normalize('NFKC'), 'utf8');

/**
 * A new password, for request schemas (Valibot, the default per E5): long enough, short enough to hash
 * (4 KiB), well-formed — and nothing else. No composition rules (digits, symbols): NIST SP 800-63B
 * advises against them. Never trimmed.
 *
 * ```ts
 * v.object({ password: password(), password_confirmation: v.string() })
 * ```
 */
export function password({ min = 8, messages = {} }: PasswordRuleOptions = {}) {
  // Framework texts by key, in the request's language (English without @marmeon/i18n).
  const required = messages.required ?? translatable('marmeon.validation.password.required', {}, 'Enter a password.');
  return v.pipe(
    v.string(required),
    v.check((value) => value.isWellFormed(), required),
    v.check((value) => length(value) >= min, messages.min ?? translatable('marmeon.validation.password.min', { min }, 'The password needs at least {min} characters.')),
    v.check((value) => bytes(value) <= MAX_PASSWORD_BYTES, messages.max ?? translatable('marmeon.validation.password.max', {}, 'The password is too long.')),
  );
}

/** What {@link confirmed} takes besides the schema. */
export interface ConfirmedOptions {
  readonly field?: string;
  readonly confirmation?: string;
  readonly message?: Message;
}

/**
 * `schema`, plus a check that `confirmation` repeats `field` (after the same normalization the hasher
 * applies), reported on the confirmation field:
 *
 * ```ts
 * schema: confirmed(v.object({ password: password(), password_confirmation: v.string() }))
 * schema: (resolve) => confirmed(v.objectAsync({ email: v.pipeAsync(…, v.checkAsync(…)), password: password(), … }))   // async rules too
 * ```
 *
 * It runs once the whole body is valid (a check over the object) — a live validation (E62) never sees it: password fields are
 * not sent for one, and the check is reported only on submit.
 */
export function confirmed<S extends v.GenericSchema<unknown, Record<string, unknown>>>(
  schema: S,
  options?: ConfirmedOptions,
): v.SchemaWithPipe<readonly [S, v.BaseValidation<v.InferOutput<S>, v.InferOutput<S>, v.BaseIssue<unknown>>]>;
export function confirmed<S extends v.GenericSchemaAsync<unknown, Record<string, unknown>>>(
  schema: S,
  options?: ConfirmedOptions,
): v.SchemaWithPipeAsync<readonly [S, v.BaseValidation<v.InferOutput<S>, v.InferOutput<S>, v.BaseIssue<unknown>>]>;
export function confirmed(
  schema: v.GenericSchema<unknown, Record<string, unknown>> | v.GenericSchemaAsync<unknown, Record<string, unknown>>,
  {
    field = 'password',
    confirmation = `${field}_confirmation`,
    message = translatable('marmeon.validation.confirmed', {}, 'The passwords do not match.'),
  }: ConfirmedOptions = {},
): unknown {
  const same = (input: Record<string, unknown>) =>
    typeof input[field] === 'string' && typeof input[confirmation] === 'string' && input[field].normalize('NFKC') === input[confirmation].normalize('NFKC');
  // Typed by hand: Valibot's inference through forward() loses the object type (the body would become unknown).
  const check = v.forward(v.check((input: Record<string, unknown>) => same(input), message), [confirmation] as never);
  return schema.async ? v.pipeAsync(schema, check) : v.pipe(schema as v.GenericSchema<unknown, Record<string, unknown>>, check);
}
