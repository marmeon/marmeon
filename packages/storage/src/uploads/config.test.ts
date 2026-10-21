import { ConfigError, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { UploadsConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([UploadsConfig], env)).get(UploadsConfig) as UploadsConfig;

describe('UploadsConfig: variable names', () => {
  it('keeps the defaults of the durations under their new names', async () => {
    expect(await resolve({})).toMatchObject({ lifetime: 120, sendWithin: 15 });
  });

  it('reads the durations in minutes by their new names, with their bounds', async () => {
    expect(await resolve({ UPLOADS_LIFETIME_MINUTES: '30', UPLOADS_SEND_WITHIN_MINUTES: '5' })).toMatchObject({ lifetime: 30, sendWithin: 5 });
    await expect(resolve({ UPLOADS_LIFETIME_MINUTES: '1441' })).rejects.toThrow(/UPLOADS_LIFETIME_MINUTES/);
    await expect(resolve({ UPLOADS_LIFETIME_MINUTES: '0' })).rejects.toThrow(/UPLOADS_LIFETIME_MINUTES/);
    await expect(resolve({ UPLOADS_SEND_WITHIN_MINUTES: '0' })).rejects.toThrow(/UPLOADS_SEND_WITHIN_MINUTES/);
  });

  it.each([
    ['UPLOADS_LIFETIME', 'UPLOADS_LIFETIME_MINUTES', '30'],
    ['UPLOADS_SEND_WITHIN', 'UPLOADS_SEND_WITHIN_MINUTES', '5'],
  ])('stops the start when %s is set, naming %s, instead of falling back to the default', async (from, to, value) => {
    const error = await resolve({ [from]: value }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).message).toContain(`${from} was renamed ${to}`);
  });
});
