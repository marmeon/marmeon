import * as v from 'valibot';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { confirmed, MAX_PASSWORD_BYTES, password } from './index.ts';

const issues = (schema: v.GenericSchema, value: unknown) => {
  const result = v.safeParse(schema, value);
  return result.success ? [] : result.issues.map((issue) => ({ path: v.getDotPath(issue), message: issue.message }));
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
    expect(v.parse(password(), '  spaced  ')).toBe('  spaced  ');
    expect(issues(password(), 'aaaaaaaa')).toEqual([]); // no "needs a digit" — NIST advises against it
  });

  it('refuses what the hasher would refuse: too long, lone surrogates', () => {
    expect(issues(password(), 'x'.repeat(MAX_PASSWORD_BYTES + 1))).toEqual([{ path: null, message: 'The password is too long.' }]);
    expect(issues(password(), 'password\ud800')).toEqual([{ path: null, message: 'Enter a password.' }]);
    expect(issues(password(), 42)).toEqual([{ path: null, message: 'Enter a password.' }]);
  });
});

describe('confirmed()', () => {
  const schema = confirmed(v.object({ password: password(), password_confirmation: v.string() }));

  it('reports a mismatch on the confirmation field', () => {
    expect(issues(schema, { password: 'correct horse', password_confirmation: 'correct horse' })).toEqual([]);
    expect(issues(schema, { password: 'correct horse', password_confirmation: 'correct house' })).toEqual([
      { path: 'password_confirmation', message: 'The passwords do not match.' },
    ]);
  });

  it('compares after normalization, like the hasher (é composed vs decomposed)', () => {
    expect(issues(schema, { password: 'Café au lait', password_confirmation: 'Café au lait' })).toEqual([]);
  });

  it('keeps the schema type, so ctx.body stays typed', () => {
    expectTypeOf<v.InferOutput<typeof schema>>().toEqualTypeOf<{ password: string; password_confirmation: string }>();
    const custom = confirmed(v.object({ new_password: v.string(), repeat: v.string() }), { field: 'new_password', confirmation: 'repeat' });
    expect(issues(custom, { new_password: 'a', repeat: 'b' })).toEqual([{ path: 'repeat', message: 'The passwords do not match.' }]);
  });
});
