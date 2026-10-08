import { createApplication, Logger, type Application, type Container, type LogContext } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AuthConfig, AuthServiceProvider, PRIVATE_REGISTRATION_OFF_WARNING } from './index.ts';

/** Boots auth with `env` and returns the app and what was logged as a warning about private registration. */
async function boot(env: Record<string, string>): Promise<{ app: Application; warnings: string[] }> {
  const warnings: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (message: string, _context?: LogContext) => void warnings.push(message),
    error() {},
    child: () => logger,
  };
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY: '1024', HASH_ARGON_TIME: '1', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    override: (container: Container) => container.instance(Logger, logger),
  });
  // Only these switches': a protected boot warns about other things too (cookies without Secure over http://).
  return { app, warnings: warnings.filter((warning) => warning.startsWith('AUTH_PRIVATE_REGISTRATION') || warning.startsWith('AUTH_UNVERIFIED_DAYS')) };
}

describe('AUTH_PRIVATE_REGISTRATION (E146, E193)', () => {
  it('is on unless set to false — and only "true" or "false" boot', async () => {
    expect((await boot({ NODE_ENV: 'test' })).app.container.make(AuthConfig).privateRegistration, 'unset, private registration must be on').toBe(true);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'true' })).app.container.make(AuthConfig).privateRegistration).toBe(true);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'false' })).app.container.make(AuthConfig).privateRegistration).toBe(false);
    // Fail-closed: a typo never turns it off quietly — the boot names the variable.
    for (const value of ['no', '0', 'FALSE', 'off', '']) {
      await expect(boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: value })).rejects.toThrow(/auth: AUTH_PRIVATE_REGISTRATION/);
    }
  });

  it('turned off outside development and tests, the boot warns once: registration tells whether an address has an account', async () => {
    expect((await boot({ NODE_ENV: 'production', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'production: the boot must warn once').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    expect(PRIVATE_REGISTRATION_OFF_WARNING).toContain('tell whether an address has an account');
    // Fail-closed (E139): staging and a missing NODE_ENV are protected like production.
    expect((await boot({ NODE_ENV: 'staging', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'staging (protected, E139): the boot must warn').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    expect((await boot({ NODE_ENV: '', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'no NODE_ENV (protected, E139): the boot must warn').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    // Quiet when it is on, and in development and tests.
    expect((await boot({ NODE_ENV: 'production' })).warnings).toEqual([]);
    expect((await boot({ NODE_ENV: 'development', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings).toEqual([]);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings).toEqual([]);
  });
});

describe('AUTH_UNVERIFIED_DAYS (E203)', () => {
  it('is 7 unless set — only whole numbers of days boot, 0 (the command deletes none)', async () => {
    const days = async (value?: string) => (await boot({ NODE_ENV: 'test', ...(value === undefined ? {} : { AUTH_UNVERIFIED_DAYS: value }) })).app.container.make(AuthConfig).unverifiedDays;
    expect(await days(), 'unset, unconfirmed accounts must go after 7 days').toBe(7);
    expect(await days('30')).toBe(30);
    expect(await days('0')).toBe(0);
    // Fail-closed: a typo never turns the prune off (or makes it delete at once) quietly — the boot names the variable.
    for (const value of ['-1', '1.5', '7d', 'seven', '', ' 7', '1e3', '0x10']) {
      await expect(boot({ NODE_ENV: 'test', AUTH_UNVERIFIED_DAYS: value }), value).rejects.toThrow(/auth: AUTH_UNVERIFIED_DAYS/);
    }
  });

  it('0 is no boot warning (E209): whether unconfirmed accounts go is the schedule of the app, not a default to warn about', async () => {
    for (const NODE_ENV of ['production', 'staging', 'development', 'test']) {
      expect((await boot({ NODE_ENV, AUTH_UNVERIFIED_DAYS: '0' })).warnings, NODE_ENV).toEqual([]);
    }
  });
});
