import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { SessionConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([SessionConfig], env)).get(SessionConfig) as SessionConfig;

describe('SessionConfig: variable names', () => {
  it('keeps the default of the lifetime under its new name', async () => {
    expect(await resolve({})).toMatchObject({ lifetimeMinutes: 120 });
  });

  it('reads the lifetime in minutes by its new name, at least 1', async () => {
    expect(await resolve({ SESSION_LIFETIME_MINUTES: '30' })).toMatchObject({ lifetimeMinutes: 30 });
    await expect(resolve({ SESSION_LIFETIME_MINUTES: '0' })).rejects.toThrow(/SESSION_LIFETIME_MINUTES/);
  });

  it('stops the start when SESSION_LIFETIME is set, naming SESSION_LIFETIME_MINUTES, instead of falling back to 120 minutes', async () => {
    const error = await resolve({ SESSION_LIFETIME: '30' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('SESSION_LIFETIME was renamed SESSION_LIFETIME_MINUTES');
  });
});

describe('SessionConfig: switches', () => {
  it('reads SESSION_SECURE_COOKIE as a boolean — unset or empty follows APP_URL', async () => {
    const https = { APP_URL: 'https://example.com' };
    expect(await resolve(https)).toMatchObject({ secure: true, secureFrom: 'APP_URL' });
    expect(await resolve({ ...https, SESSION_SECURE_COOKIE: '' })).toMatchObject({ secure: true, secureFrom: 'APP_URL' });
    expect(await resolve({ ...https, SESSION_SECURE_COOKIE: '0' })).toMatchObject({ secure: false, secureFrom: 'SESSION_SECURE_COOKIE' });
    expect(await resolve({ APP_URL: 'http://localhost', SESSION_SECURE_COOKIE: 'TRUE' })).toMatchObject({ secure: true, secureFrom: 'SESSION_SECURE_COOKIE' });
    expect(await resolve({ APP_URL: 'http://localhost', SESSION_SECURE_COOKIE: '1' })).toMatchObject({ secure: true });
  });

  it('stops the start for a SESSION_SECURE_COOKIE that is no boolean — a typo never sends cookies without Secure', async () => {
    for (const value of ['no', 'off', 'yes', 'disabled', '2']) {
      await expect(resolve({ APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: value }), value).rejects.toThrow(/SESSION_SECURE_COOKIE/);
    }
  });

  it('reads SESSION_ENCRYPT as a boolean, off by default', async () => {
    expect(await resolve({})).toMatchObject({ encrypt: false });
    expect(await resolve({ SESSION_ENCRYPT: '1' })).toMatchObject({ encrypt: true });
    expect(await resolve({ SESSION_ENCRYPT: 'True' })).toMatchObject({ encrypt: true });
    expect(await resolve({ SESSION_ENCRYPT: '0' })).toMatchObject({ encrypt: false });
    expect(await resolve({ SESSION_ENCRYPT: '' })).toMatchObject({ encrypt: false });
    for (const value of ['yes', 'on', 'no']) await expect(resolve({ SESSION_ENCRYPT: value }), value).rejects.toThrow(/SESSION_ENCRYPT/);
  });
});

describe('SessionConfig: the old name of the lifetime', () => {
  it('throws at a read of lifetime instead of answering undefined', async () => {
    const config = (await resolve({})) as Record<string, unknown>;
    expect(() => config.lifetime).toThrow('was renamed SessionConfig.lifetimeMinutes');
    expect(Object.keys(config)).not.toContain('lifetime');
  });
});
