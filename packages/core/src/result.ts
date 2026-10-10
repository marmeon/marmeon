/** An expected outcome that went right: plain data `{ ok: true, value }`. See docs/errors.md#results. */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

/** An expected outcome that went wrong: plain data `{ ok: false, error }`, the error a `{ kind, …payload }`. See docs/errors.md#results. */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * The outcome of work that can fail in an expected way — narrowed by `ok`, and `switch (result.error.kind)` is exhaustive.
 * Returned from `transaction()`'s callback, an `err` rolls the transaction back. See docs/errors.md#results.
 */
export type Result<T, E extends { readonly kind: string } = { readonly kind: string }> = Ok<T> | Err<E>;

// The marks are not enumerable: JSON, spreading and Object.keys never show them, and a look-alike `{ ok: false }` that
// a payload happens to contain (or a copy of a real err) is data, not a result — it never rolls a transaction back.
const RESULT = Symbol.for('marmeon.result');
const COMMIT = Symbol.for('marmeon.result.commitAnyway');

function mark<R extends object>(result: R, as: 'ok' | 'err'): R {
  return Object.defineProperty(result, RESULT, { value: as });
}

/** An {@link Ok} — `ok()` without a value for work that only succeeds. See docs/errors.md#results. */
export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return mark({ ok: true, value }, 'ok');
}

/**
 * An {@link Err}; the kind stays a literal, the payload keeps its types (`string[]`, not a readonly tuple): `err({ kind: 'taken', email })`.
 * See docs/errors.md#results.
 */
export function err<K extends string, E extends { readonly kind: K }>(error: E): Err<E> {
  return mark({ ok: false, error }, 'err');
}

/**
 * Returned from a `transaction()` callback, commits the transaction although the callback failed — for an error that is
 * itself a change to keep (a dropped request, a failed-attempt counter). The caller gets a plain `err`. See
 * docs/transactions.md#returning-an-err.
 */
export function commitAnyway<E>(result: Err<E>): Err<E> {
  if (resultMark(result) !== 'err' && resultMark(result) !== 'commit') {
    throw new TypeError('commitAnyway() takes an err(…): it commits a transaction although the callback failed.');
  }
  return Object.defineProperty(withoutCommit(result), COMMIT, { value: true });
}

/** @internal — the same error as a plain `err`, without {@link commitAnyway}'s mark. */
export function withoutCommit<E>(result: Err<E>): Err<E> {
  return mark({ ok: false, error: result.error }, 'err');
}

/** @internal — what `value` is: a result of {@link ok}/{@link err}, an err to commit anyway, or none of them. */
export function resultMark(value: unknown): 'ok' | 'err' | 'commit' | undefined {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, RESULT)) return undefined;
  if (Object.hasOwn(value, COMMIT)) return 'commit';
  return (value as { [RESULT]: 'ok' | 'err' })[RESULT];
}
