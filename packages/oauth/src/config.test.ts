import { resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { OAuthConfig } from './config.ts';

describe('OAuthConfig', () => {
  it('reads APP_URL as appUrl, and its absence as undefined', async () => {
    expect((await resolveConfig([OAuthConfig], { APP_URL: 'https://app.example.com' })).get(OAuthConfig)).toEqual({ appUrl: 'https://app.example.com' });
    expect((await resolveConfig([OAuthConfig], {})).get(OAuthConfig)).toEqual({ appUrl: undefined });
    expect((await resolveConfig([OAuthConfig], { APP_URL: '' })).get(OAuthConfig)).toEqual({ appUrl: undefined });
  });
});
