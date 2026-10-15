import { describe, expect, it } from 'vitest';
import { accountScope, sessionScope } from './ended.ts';

describe('scopes', () => {
  it('an account scope is never a session scope of the same value, and is stable per account', () => {
    expect(accountScope('7')).not.toBe(sessionScope('7'));
    expect(accountScope('7')).toBe(accountScope(7));
    expect(accountScope('7')).not.toBe(accountScope('8'));
    expect(accountScope('7')).toMatch(/^[\w-]{22}$/);
  });
});
