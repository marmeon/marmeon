import { describe, expect, it } from 'vitest';
import { lockNamePairs } from './job-lock-names.ts';

describe('lockNamePairs', () => {
  it('pairs a name with every name that starts with it and a colon, sorted by short then long', () => {
    expect(lockNamePairs(['a:b:c', 'a', 'a:b'])).toEqual([
      ['a', 'a:b'],
      ['a', 'a:b:c'],
      ['a:b', 'a:b:c'],
    ]);
  });

  it('pairs no names that merely share a prefix, and lists a duplicated name once', () => {
    expect(lockNamePairs(['reports', 'reports-daily', 'reportsdaily', 'report'])).toEqual([]);
    expect(lockNamePairs(['reports', 'reports:daily', 'reports', 'reports:daily'])).toEqual([['reports', 'reports:daily']]);
  });
});
