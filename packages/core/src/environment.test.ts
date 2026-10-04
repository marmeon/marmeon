import { describe, expect, it } from 'vitest';
import { environment } from './environment.ts';

describe('environment (E115, E139)', () => {
  const cases = [
    { NODE_ENV: 'development', development: true, protected: false, describe: 'development' },
    { NODE_ENV: 'test', development: false, protected: false, describe: 'test' },
    { NODE_ENV: 'production', development: false, protected: true, describe: 'production (protected)' },
    { NODE_ENV: 'staging', development: false, protected: true, describe: 'staging (protected)' },
    { NODE_ENV: 'Development', development: false, protected: true, describe: 'Development (protected)' },
    { NODE_ENV: undefined, development: false, protected: true, describe: 'unset NODE_ENV (protected, like production)' },
    { NODE_ENV: '', development: false, protected: true, describe: 'unset NODE_ENV (protected, like production)' },
  ];

  it.each(cases)('NODE_ENV=$NODE_ENV: development tools only in development, protections everywhere but development and test', (entry) => {
    const env = { NODE_ENV: entry.NODE_ENV };
    expect(environment.isDevelopment(env)).toBe(entry.development);
    expect(environment.isProtected(env)).toBe(entry.protected);
    expect(environment.describe(env)).toBe(entry.describe);
    expect(environment.isTest(env)).toBe(entry.NODE_ENV === 'test');
  });

  it('reads process.env when given nothing', () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'staging';
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBe('staging');
      delete process.env.NODE_ENV;
      expect(environment.isProtected()).toBe(true);
      expect(environment.name()).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });
});
