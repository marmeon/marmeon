import type { InferOutput, StandardResult, StandardSchemaV1 } from '@marmeon/core';
import { rules as r } from '@marmeon/validation';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { MAX_PASSWORD_BYTES, password } from './index.ts';

const issues = (schema: StandardSchemaV1, value: unknown) => {
  const result = schema['~standard'].validate(value) as StandardResult<unknown>;
  return result.issues ? result.issues.map((issue) => ({ path: issue.path?.map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.') ?? null, message: issue.message })) : [];
};

describe('password()', () => {
  it('needs at least 8 characters by default — counted as people see them, after NFKC', () => {
    expect(issues(password(), 'short')).toEqual([{ path: null, message: 'The password needs at least 8 characters.' }]);
    expect(issues(password(), '12345678')).toEqual([]);
    expect(issues(password(), '🔑🔑🔑🔑🔑🔑🔑🔑')).toEqual([]); // 8 code points (16 UTF-16 units)
    expect(issues(password(), '🔑🔑🔑🔑')).toHaveLength(1); // 4, not 8
    expect(issues(password({ min: 15 }), 'twelve chars')).toEqual([{ path: null, message: 'The password needs at least 15 characters.' }]);
  });

  it('never trims and adds no composition rules', () => {
    expect((password()['~standard'].validate('  spaced  ') as { value: string }).value).toBe('  spaced  ');
    expect(issues(password(), 'aaaaaaaa')).toEqual([]); // no "needs a digit" — NIST advises against it
  });

  it('refuses what the hasher would refuse: too long, lone surrogates — and says "Enter a password" for nothing at all', () => {
    expect(issues(password(), 'x'.repeat(MAX_PASSWORD_BYTES + 1))).toEqual([{ path: null, message: 'The password is too long.' }]);
    expect(issues(password(), 'password\ud800')).toEqual([{ path: null, message: 'Enter a password.' }]);
    expect(issues(password(), 42)).toEqual([{ path: null, message: 'Enter a password.' }]);
    // A form without the field: its own message, not the object's "required".
    expect(issues(r.object({ password: password() }), {})).toEqual([{ path: 'password', message: 'Enter a password.' }]);
  });

  it('is a rule: an object of rules takes it, its confirmation is the object\'s confirmed() — ctx.body stays typed', () => {
    const schema = r.object({ password: password(), password_confirmation: r.string() }).confirmed('password');
    expect(issues(schema, { password: 'correct horse', password_confirmation: 'correct horse' })).toEqual([]);
    expect(issues(schema, { password: 'correct horse', password_confirmation: 'correct house' })).toEqual([
      { path: 'password_confirmation', message: 'The password confirmation does not match.' },
    ]);
    expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<{ password: string; password_confirmation: string }>();
  });

  it('takes messages of the app: keys, texts', () => {
    expect(issues(password({ messages: { min: 'Longer, please.' } }), 'short')).toEqual([{ path: null, message: 'Longer, please.' }]);
  });
});
