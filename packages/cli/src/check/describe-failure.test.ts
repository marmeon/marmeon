import { Redactor } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { describeFailure } from './app.ts';

describe('describeFailure', () => {
  it('masks a password with @ or / in a connection URL, in the error and in its causes', () => {
    const error = new Error('Could not connect to postgres://app:p@ss/w0rd@db/shop', { cause: new Error('redis://:q/r%40s@cache:6379 refused') });
    const text = describeFailure(error, new Redactor(), '/srv/app');
    expect(text).not.toMatch(/p@ss|w0rd|q\/r/);
    expect(text).toContain('postgres://app:***@db/shop');
    expect(text).toContain('redis://:***@cache:6379 refused');
  });

  it('leaves a URL without a password as it is', () => {
    expect(describeFailure(new Error('postgres://db:5432/shop is down'), new Redactor(), '/srv/app')).toBe('postgres://db:5432/shop is down');
  });
});
