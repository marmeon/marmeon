import * as v from 'valibot';
import { MAX_PASSWORD_BYTES } from './hashing.ts';

export interface PasswordRuleOptions {
  /** At least this many characters (default 8). Counted after NFKC normalization, in code points — an emoji is one. */
  readonly min?: number;
  readonly messages?: { readonly required?: string; readonly min?: string; readonly max?: string };
}

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
  return v.pipe(
    v.string(messages.required ?? 'Enter a password.'),
    v.check((value) => value.isWellFormed(), messages.required ?? 'Enter a password.'),
    v.check((value) => length(value) >= min, messages.min ?? `The password needs at least ${min} characters.`),
    v.check((value) => bytes(value) <= MAX_PASSWORD_BYTES, messages.max ?? 'The password is too long.'),
  );
}

/**
 * `schema`, plus a check that `confirmation` repeats `field` (after the same normalization the hasher
 * applies), reported on the confirmation field:
 *
 * ```ts
 * schema: confirmed(v.object({ password: password(), password_confirmation: v.string() }))
 * ```
 */
export function confirmed<S extends v.GenericSchema<unknown, Record<string, unknown>>>(
  schema: S,
  { field = 'password', confirmation = `${field}_confirmation`, message = 'The passwords do not match.' }: { field?: string; confirmation?: string; message?: string } = {},
): v.SchemaWithPipe<readonly [S, v.BaseValidation<v.InferOutput<S>, v.InferOutput<S>, v.BaseIssue<unknown>>]> {
  const same = (input: Record<string, unknown>) =>
    typeof input[field] === 'string' && typeof input[confirmation] === 'string' && input[field].normalize('NFKC') === input[confirmation].normalize('NFKC');
  // Typed by hand: Valibot's inference through forward() loses the object type (the body would become unknown).
  return v.pipe(schema, v.forward(v.check((input: Record<string, unknown>) => same(input), message), [confirmation] as never)) as never;
}
