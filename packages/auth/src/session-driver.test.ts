import { createApplication, Logger, type Container, type LogContext } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AuthServiceProvider, COOKIE_SESSION_WARNING } from './index.ts';

/** Boots auth with a session driver and returns what was logged as a warning. */
async function warningsWith(driver: string, withAuth = true): Promise<string[]> {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message: string, _context?: LogContext) => void warnings.push(message),
    error() {},
    child: () => logger,
  };
  await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: driver, DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1' },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, ...(withAuth ? [AuthServiceProvider] : [])],
    override: (container: Container) => container.instance(Logger, logger),
  });
  return warnings;
}

describe('the cookie session driver with sign-in', () => {
  it('warns once at boot: a sign-out can be undone by a request still in flight', async () => {
    expect(await warningsWith('cookie')).toEqual([COOKIE_SESSION_WARNING]);
    expect(COOKIE_SESSION_WARNING).toContain('Use SESSION_DRIVER=file');
  });

  it('stays quiet for the server-side drivers — and for cookie sessions without auth', async () => {
    expect(await warningsWith('file')).toEqual([]);
    expect(await warningsWith('memory')).toEqual([]);
    expect(await warningsWith('cookie', false)).toEqual([]);
  });
});
