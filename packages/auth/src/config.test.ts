import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { AuthConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([AuthConfig], env)).get(AuthConfig) as AuthConfig;

describe('AuthConfig: variable names', () => {
  it('keeps the defaults of the durations under their new names', async () => {
    expect(await resolve({})).toMatchObject({ passwordTimeoutSeconds: 900, resetMinutes: 60, resetThrottleSeconds: 60, emailChangeThrottleSeconds: 60 });
  });

  it('reads the durations by their new names, in the unit the name says', async () => {
    const config = await resolve({
      AUTH_PASSWORD_TIMEOUT_SECONDS: '300',
      AUTH_RESET_MINUTES: '30',
      AUTH_RESET_THROTTLE_SECONDS: '10',
      AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '0',
    });
    expect(config).toMatchObject({ passwordTimeoutSeconds: 300, resetMinutes: 30, resetThrottleSeconds: 10, emailChangeThrottleSeconds: 0 });
  });

  it('refuses a read of a key by its old name, at the read', async () => {
    const config = (await resolve({})) as Record<string, unknown>;
    for (const [old, now] of [['passwordTimeout', 'passwordTimeoutSeconds'], ['resetExpire', 'resetMinutes'], ['resetThrottle', 'resetThrottleSeconds'], ['emailChangeThrottle', 'emailChangeThrottleSeconds']]) {
      expect(() => config[old!], old).toThrow(`was renamed AuthConfig.${now}`);
    }
    expect(Object.keys(config)).not.toContain('resetExpire');
  });

  it('keeps the bounds of the durations', async () => {
    await expect(resolve({ AUTH_PASSWORD_TIMEOUT_SECONDS: '0' })).rejects.toThrow(/AUTH_PASSWORD_TIMEOUT_SECONDS/);
    await expect(resolve({ AUTH_RESET_MINUTES: '0' })).rejects.toThrow(/AUTH_RESET_MINUTES/);
    await expect(resolve({ AUTH_RESET_THROTTLE_SECONDS: '-1' })).rejects.toThrow(/AUTH_RESET_THROTTLE_SECONDS/);
    await expect(resolve({ AUTH_EMAIL_CHANGE_THROTTLE_SECONDS: '-1' })).rejects.toThrow(/AUTH_EMAIL_CHANGE_THROTTLE_SECONDS/);
  });

  it('stops the start for a reset link that lives longer than a day, or no time at all', async () => {
    expect((await resolve({ AUTH_RESET_MINUTES: '1440' })).resetMinutes).toBe(1440);
    for (const value of ['0', '1441', '525600']) await expect(resolve({ AUTH_RESET_MINUTES: value })).rejects.toThrow(/AUTH_RESET_MINUTES/);
  });

  it.each([
    ['AUTH_PASSWORD_TIMEOUT', 'AUTH_PASSWORD_TIMEOUT_SECONDS', '300'],
    ['AUTH_RESET_EXPIRE', 'AUTH_RESET_MINUTES', '30'],
    ['AUTH_RESET_THROTTLE', 'AUTH_RESET_THROTTLE_SECONDS', '10'],
    ['AUTH_EMAIL_CHANGE_THROTTLE', 'AUTH_EMAIL_CHANGE_THROTTLE_SECONDS', '0'],
  ])('stops the start when %s is set, naming %s, instead of falling back to the default', async (from, to, value) => {
    const error = await resolve({ [from]: value }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});

describe('AuthConfig: switches', () => {
  it('reads AUTH_PRIVATE_REGISTRATION and AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE as booleans with their defaults', async () => {
    expect(await resolve({})).toMatchObject({ privateRegistration: true, revokeTokensOnPasswordChange: false });
    expect(await resolve({ AUTH_PRIVATE_REGISTRATION: '0', AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: '1' })).toMatchObject({ privateRegistration: false, revokeTokensOnPasswordChange: true });
    expect(await resolve({ AUTH_PRIVATE_REGISTRATION: 'FALSE', AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: 'True' })).toMatchObject({ privateRegistration: false, revokeTokensOnPasswordChange: true });
  });

  it('gives an empty switch its default — private registration on, revoking off', async () => {
    expect(await resolve({ AUTH_PRIVATE_REGISTRATION: '', AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: '' })).toMatchObject({ privateRegistration: true, revokeTokensOnPasswordChange: false });
  });

  it('stops the start for a spelling that is no boolean, never falling to the unsafe side', async () => {
    for (const value of ['off', 'no', 'yes', 'disabled', '2']) {
      await expect(resolve({ AUTH_PRIVATE_REGISTRATION: value }), value).rejects.toThrow(/AUTH_PRIVATE_REGISTRATION/);
      await expect(resolve({ AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE: value }), value).rejects.toThrow(/AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE/);
    }
  });
});
