import { describe, expect, it } from 'vitest';
import { ReadOnly, ReadOnlyError } from './read-only.ts';

describe('ReadOnly', () => {
  it('begins the message of a strict violation with H6', () => {
    const readOnly = new ReadOnly();
    readOnly.engage({ reason: 'an island request', strict: true, report: () => {} });
    expect(() => readOnly.permit('session.put(cart)')).toThrow(ReadOnlyError);
    expect(() => readOnly.permit('session.put(cart)')).toThrow(/^\[marmeon:H6\] session\.put\(cart\) in an island request: /);
  });
});
