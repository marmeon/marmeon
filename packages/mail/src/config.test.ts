import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { MailConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([MailConfig], env)).get(MailConfig) as MailConfig;

describe('MailConfig: variable names', () => {
  it('selects the mailer by MAIL_DRIVER', async () => {
    expect((await resolve({ MAIL_DRIVER: 'smtp' })).mailer).toBe('smtp');
  });

  it('stops the start when MAIL_MAILER is set, instead of falling back to the log', async () => {
    const error = await resolve({ MAIL_MAILER: 'smtp' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain('MAIL_MAILER was renamed MAIL_DRIVER');
  });
});

describe('MailConfig: switches', () => {
  it('reads MAIL_SECURE and MAIL_REQUIRE_TLS as booleans, with their defaults', async () => {
    expect((await resolve({})).smtp).toMatchObject({ secure: false, requireTls: true });
    expect((await resolve({ MAIL_SECURE: '1', MAIL_REQUIRE_TLS: '0' })).smtp).toMatchObject({ secure: true, requireTls: false });
    expect((await resolve({ MAIL_SECURE: 'TRUE', MAIL_REQUIRE_TLS: 'False' })).smtp).toMatchObject({ secure: true, requireTls: false });
  });

  it('refuses a spelling that is no boolean', async () => {
    await expect(resolve({ MAIL_SECURE: 'yes' })).rejects.toThrow(/MAIL_SECURE/);
    await expect(resolve({ MAIL_REQUIRE_TLS: 'no' })).rejects.toThrow(/MAIL_REQUIRE_TLS/);
  });
});
