import { resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { AuthConfig } from '../config.ts';
import { PasskeyConfig, PasskeySetupError, relyingPartyFrom, type PasskeyConfigValue } from './config.ts';

const from = (appUrl: string | undefined, extra: { rpId?: string; origins?: string } = {}) => relyingPartyFrom({ appUrl, ...extra });

describe('the relying party from APP_URL', () => {
  it('is the host and the origin of an https URL', () => {
    expect(from('https://app.example.com')).toEqual({ rpId: 'app.example.com', origins: ['https://app.example.com'] });
    expect(from('https://app.example.com/some/path?x=1')).toEqual({ rpId: 'app.example.com', origins: ['https://app.example.com'] });
  });

  it('accepts a parent domain as the RP ID', () => {
    expect(from('https://app.example.com', { rpId: 'example.com' })).toEqual({ rpId: 'example.com', origins: ['https://app.example.com'] });
  });

  it('refuses an RP ID that is not a parent domain on a label boundary', () => {
    expect(() => from('https://app.example.com', { rpId: 'ample.com' })).toThrow(/not the host of https:\/\/app\.example\.com or a parent domain/);
    expect(() => from('https://app.example.com', { rpId: 'other.com' })).toThrow(PasskeySetupError);
    expect(() => from('https://app.example.com', { rpId: 'other.com' })).toThrow('[marmeon:A1] Passkeys cannot be used: ');
  });

  it('refuses plain http, except on localhost', () => {
    expect(() => from('http://example.com')).toThrow(/not secure/);
    expect(from('http://localhost:3000')).toEqual({ rpId: 'localhost', origins: ['http://localhost:3000'] });
  });

  it('refuses an IP address and names localhost for loopback', () => {
    expect(() => from('http://127.0.0.1:3000')).toThrow(/http:\/\/localhost:3000/);
    expect(() => from('http://[::1]:3000')).toThrow(/IP address/);
    expect(() => from('https://203.0.113.7')).toThrow(/IP address/);
    expect(() => from('https://app.example.com', { rpId: '203.0.113.7' })).toThrow(/IP address/);
  });

  it('refuses a missing or broken APP_URL', () => {
    expect(() => from(undefined)).toThrow(/APP_URL is not set/);
    expect(() => from('not a url')).toThrow(/not a URL/);
  });

  it('takes the allowed origins from AUTH_PASSKEY_ORIGINS, exact, and checks each against the RP ID', () => {
    expect(from('https://app.example.com', { rpId: 'example.com', origins: 'https://app.example.com, https://admin.example.com' })).toEqual({
      rpId: 'example.com',
      origins: ['https://app.example.com', 'https://admin.example.com'],
    });
    expect(() => from('https://app.example.com', { origins: 'https://app.example.com,https://evil.test' })).toThrow(/not the host of https:\/\/evil\.test/);
    expect(() => from('https://app.example.com', { origins: 'https://app.example.com/' })).toThrow(/write it exactly as https:\/\/app\.example\.com/);
    expect(() => from('https://app.example.com', { origins: 'nonsense' })).toThrow(/not an origin/);
    expect(() => from('https://app.example.com', { origins: 'http://app.example.com' })).toThrow(/not secure/);
  });

  it('refuses an RP ID that is not a bare domain name', () => {
    expect(() => from('https://app.example.com', { rpId: 'https://example.com' })).toThrow(/bare domain/);
    expect(() => from('https://app.example.com', { rpId: 'example.com:443' })).toThrow(/bare domain/);
    expect(() => from('https://com', { rpId: 'com' })).toThrow(/single label/);
  });
});

describe('PasskeyConfig', () => {
  it('never fails the boot, whatever the passkey variables say — the first use does', async () => {
    const env = { APP_URL: 'http://127.0.0.1:3000', AUTH_PASSKEY_ORIGINS: 'nonsense' };
    // An app without a passkey binding resolves only AuthConfig: the variables are not read at all.
    await expect(resolveConfig([AuthConfig], env)).resolves.toBeDefined();
    const resolved = await resolveConfig([PasskeyConfig], env);
    const config = resolved.get(PasskeyConfig) as PasskeyConfigValue;
    expect(() => config.relyingParty()).toThrow(PasskeySetupError);
    expect(() => config.relyingParty()).toThrow(PasskeySetupError); // a failure is not cached as a value
  });

  it('resolves the relying party from the environment once, and keeps it', async () => {
    const resolved = await resolveConfig([PasskeyConfig], { APP_URL: 'https://app.example.com' });
    const config = resolved.get(PasskeyConfig) as PasskeyConfigValue;
    expect(config.relyingParty()).toEqual({ rpId: 'app.example.com', origins: ['https://app.example.com'] });
    expect(config.relyingParty()).toBe(config.relyingParty());
  });
});
