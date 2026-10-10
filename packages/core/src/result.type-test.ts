// Type guarantees of Result — checked by `tsc` (pnpm build / typecheck), never run. The messages, as the compiler shows them,
// are quoted in the comments.
import { expectTypeOf } from 'vitest';
import { commitAnyway, err, ok, type Err, type Ok, type Result } from './index.ts';

type Missing = { kind: 'missing' };
type Taken = { kind: 'taken'; email: string };

declare const result: Result<{ id: number }, Missing | Taken>;

export function resultTypes(): void {
  // ok and err infer their payload; err keeps the literal kind.
  const found: Ok<{ id: number }> = ok({ id: 1 });
  const done: Ok<void> = ok();
  const taken: Err<{ readonly kind: 'taken'; readonly email: string }> = err({ kind: 'taken', email: String('ada@example.com') });
  const both: Result<{ id: number }, Missing | Taken> = Math.random() > 0.5 ? found : taken;
  void [done, both];

  // Only the kind is a literal: the payload keeps its own types — an array stays a mutable array, also when the err is made before it
  // meets the declared type.
  const invalid = err({ kind: 'invalid', fields: ['email'], first: 'email' });
  const declared: Err<{ kind: 'invalid'; fields: string[]; first: string }> = invalid;
  void declared;
  expectTypeOf(invalid).toEqualTypeOf<Err<{ kind: 'invalid'; fields: string[]; first: string }>>();
  // Type 'Err<{ kind: string; }>' is not assignable to type 'Err<Missing>'.
  // @ts-expect-error — a kind that is any string is not the kind 'missing'
  const widened: Err<Missing> = err({ kind: String('missing') });
  void widened;

  // Narrowed by `ok`: the value only on an Ok, the error only on an Err.
  if (result.ok) {
    const id: number = result.value.id;
    void id;
    // Property 'error' does not exist on type 'Ok<{ id: number; }>'.
    // @ts-expect-error — an Ok has no error
    void result.error;
  } else {
    // Property 'value' does not exist on type 'Err<Missing | Taken>'.
    // @ts-expect-error — an Err has no value
    void result.value;
  }
}

// A switch over the kind is exhaustive: a kind without its case leaves the end of the function reachable.
// Function lacks ending return statement and return type does not include 'undefined'.
// @ts-expect-error — the 'taken' case is missing
export function message(failed: Err<Missing | Taken>): string {
  switch (failed.error.kind) {
    case 'missing':
      return 'Not found.';
  }
}

// Without a declared return type, a `never` check in `default` does it — and names the missing kind:
// Type 'Taken' does not satisfy the expected type 'never'.
export function messageChecked(failed: Err<Missing | Taken>) {
  switch (failed.error.kind) {
    case 'missing':
      return 'Not found.';
    default:
      // @ts-expect-error — the 'taken' case is missing
      return failed.error satisfies never;
  }
}

export function commitAnywayTypes(): void {
  // commitAnyway keeps the error's type: the caller sees a plain Err.
  const kept: Err<{ readonly kind: 'taken'; readonly email: string }> = commitAnyway(err({ kind: 'taken', email: String('ada@example.com') }));
  void kept;

  // Property 'error' is missing in type 'Ok<number>' but required in type 'Err<unknown>'.
  // @ts-expect-error — only an err commits anyway
  commitAnyway(ok(1));

  // Argument of type 'Result<{ id: number; }, Missing | Taken>' is not assignable to parameter of type 'Err<Missing | Taken>'.
  //   Property 'error' is missing in type 'Ok<{ id: number; }>' but required in type 'Err<Missing | Taken>'.
  // @ts-expect-error — a Result might be an Ok: narrow it first
  commitAnyway(result);
}
