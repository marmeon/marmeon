import { createApplication, Logger, type Application, type Container, type LogContext } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AuthConfig, AuthServiceProvider } from './index.ts';
import { PRIVATE_REGISTRATION_OFF_WARNING } from './config.ts';

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
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
  }, { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', ...env }, override: (container: Container) => container.instance(Logger, logger) });
  // Only these switches': a protected boot warns about other things too (cookies without Secure over http://).
  return { app, warnings: warnings.filter((warning) => warning.startsWith('AUTH_PRIVATE_REGISTRATION') || warning.startsWith('AUTH_UNVERIFIED_DAYS')) };
}

describe('AUTH_PRIVATE_REGISTRATION', () => {
  it('is on unless switched off — and only a boolean boots', async () => {
    expect((await boot({ NODE_ENV: 'test' })).app.container.make(AuthConfig).privateRegistration, 'unset, private registration must be on').toBe(true);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'true' })).app.container.make(AuthConfig).privateRegistration).toBe(true);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'false' })).app.container.make(AuthConfig).privateRegistration).toBe(false);
    // An empty variable is a missing one: on.
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: '' })).app.container.make(AuthConfig).privateRegistration, 'empty, private registration must be on').toBe(true);
    // Any spelling of a boolean counts: 0 and FALSE switch it off, 1 and TRUE on.
    for (const value of ['0', 'FALSE', 'False']) {
      expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: value })).app.container.make(AuthConfig).privateRegistration, value).toBe(false);
    }
    for (const value of ['1', 'TRUE']) {
      expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: value })).app.container.make(AuthConfig).privateRegistration, value).toBe(true);
    }
    // Fail-closed: a typo never turns it off quietly — the boot names the variable.
    for (const value of ['no', 'off', 'yes', 'disabled', '2']) {
      await expect(boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: value })).rejects.toThrow(/auth: AUTH_PRIVATE_REGISTRATION/);
    }
  });

  it('turned off outside development and tests, the boot warns once: registration tells whether an address has an account', async () => {
    expect((await boot({ NODE_ENV: 'production', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'production: the boot must warn once').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    expect(PRIVATE_REGISTRATION_OFF_WARNING).toContain('tell whether an address has an account');
    expect((await boot({ NODE_ENV: 'production', AUTH_PRIVATE_REGISTRATION: '0' })).warnings, '0 is off: the boot must warn').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    // A misspelt value stops the boot instead of leaving registration open or warning too late.
    await expect(boot({ NODE_ENV: 'production', AUTH_PRIVATE_REGISTRATION: 'off' })).rejects.toThrow(/auth: AUTH_PRIVATE_REGISTRATION/);
    // Fail-closed: a missing NODE_ENV is protected like production — and APP_ENV changes nothing.
    expect((await boot({ NODE_ENV: 'production', APP_ENV: 'local', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'APP_ENV=local on production (protected): the boot must warn').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    expect((await boot({ NODE_ENV: '', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings, 'no NODE_ENV (protected): the boot must warn').toEqual([PRIVATE_REGISTRATION_OFF_WARNING]);
    // Quiet when it is on, and in development and tests.
    expect((await boot({ NODE_ENV: 'production' })).warnings).toEqual([]);
    expect((await boot({ NODE_ENV: 'development', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings).toEqual([]);
    expect((await boot({ NODE_ENV: 'test', AUTH_PRIVATE_REGISTRATION: 'false' })).warnings).toEqual([]);
  });
});

describe('AUTH_UNVERIFIED_DAYS', () => {
  it('is 7 unless set — only whole numbers of days boot, 0 (the command deletes none)', async () => {
    const days = async (value?: string) => (await boot({ NODE_ENV: 'test', ...(value === undefined ? {} : { AUTH_UNVERIFIED_DAYS: value }) })).app.container.make(AuthConfig).unverifiedDays;
    expect(await days(), 'unset, unconfirmed accounts must go after 7 days').toBe(7);
    expect(await days('30')).toBe(30);
    expect(await days('0')).toBe(0);
    expect(await days(''), 'empty is unset: 7 days').toBe(7);
    // Fail-closed: a typo never turns the prune off (or makes it delete at once) quietly — the boot names the variable.
    for (const value of ['-1', '1.5', '7d', 'seven', ' 7', '1e3', '0x10']) {
      await expect(boot({ NODE_ENV: 'test', AUTH_UNVERIFIED_DAYS: value }), value).rejects.toThrow(/auth: AUTH_UNVERIFIED_DAYS/);
    }
  });

  it('0 is no boot warning: whether unconfirmed accounts go is the schedule of the app, not a default to warn about', async () => {
    for (const NODE_ENV of ['production', '', 'development', 'test']) {
      expect((await boot({ NODE_ENV, AUTH_UNVERIFIED_DAYS: '0' })).warnings, NODE_ENV).toEqual([]);
    }
  });
});

describe('AUTH_EMAIL_CHANGE_MINUTES and AUTH_EMAIL_CHANGE_THROTTLE_SECONDS', () => {
  const config = async (env: Record<string, string>) => (await boot({ NODE_ENV: 'test', ...env })).app.container.make(AuthConfig);

  it('keep the link between 5 and 1440 minutes, 60 unless set; a value outside stops the boot', async () => {
    expect((await config({})).emailChangeMinutes).toBe(60);
    expect((await config({ AUTH_EMAIL_CHANGE_MINUTES: '5' })).emailChangeMinutes).toBe(5);
    expect((await config({ AUTH_EMAIL_CHANGE_MINUTES: '1440' })).emailChangeMinutes).toBe(1440);
    for (const value of ['4', '1441', '1.5', 'hour']) {
      await expect(boot({ NODE_ENV: 'test', AUTH_EMAIL_CHANGE_MINUTES: value }), value).rejects.toThrow(/K6[\s\S]*auth: AUTH_EMAIL_CHANGE_MINUTES/);
    }
  });

  it('pauses between two links of an account for 60 seconds unless set, 0 turns the pause off', async () => {
    expect((await config({})).emailChangeThrottleSeconds).toBe(60);
    expect((await config({ AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '0' })).emailChangeThrottleSeconds).toBe(0);
    await expect(boot({ NODE_ENV: 'test', AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '-1' })).rejects.toThrow(/auth: AUTH_EMAIL_CHANGE_THROTTLE_SECONDS/);
  });
});
