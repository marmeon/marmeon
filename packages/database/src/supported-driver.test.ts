import { describe, expect, it } from 'vitest';
import { requireDriver, UnsupportedDriverError } from './supported-driver.ts';

const SUPPORTED = ['sqlite', 'pgsql'] as const;
const FEATURE = { what: 'QUEUE_DRIVER=database', instead: 'use QUEUE_DRIVER=redis or sync' };

describe('requireDriver', () => {
  it.each(SUPPORTED)('returns the listed driver %s', (driver) => {
    expect(requireDriver(driver, SUPPORTED, FEATURE)).toBe(driver);
  });

  it.each(['mysql', 'pgsql ', 'PGSQL', ''])('refuses the unlisted driver %j with D29 and the feature text', (driver) => {
    let thrown: unknown;
    try {
      requireDriver(driver, SUPPORTED, FEATURE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedDriverError);
    const { message } = thrown as Error;
    expect(message).toContain('D29');
    expect(message).toContain(`QUEUE_DRIVER=database needs a sqlite or pgsql connection, not ${JSON.stringify(driver)}; use QUEUE_DRIVER=redis or sync.`);
  });

  it('names the drivers it runs on even when there is no alternative to name, and builds the list from the one it is given', () => {
    expect(() => requireDriver('mysql', SUPPORTED, { what: 'The cache store' })).toThrow('[marmeon:D29] The cache store needs a sqlite or pgsql connection, not "mysql".');
    expect(() => requireDriver('sqlite', ['pgsql'], { what: 'A feature' })).toThrow('A feature needs a pgsql connection, not "sqlite".');
  });
});
