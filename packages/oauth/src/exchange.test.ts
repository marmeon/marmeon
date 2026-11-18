import { describe, expect, it } from 'vitest';
import type { OAuthHttp } from './definition.ts';
import { exchangeCode, type ExchangeInput } from './exchange.ts';
import { OAuthHttpError } from './http.ts';

const input = (answer: unknown | Error, sent: unknown[] = []): ExchangeInput => ({
  http: {
    json: async (url, init) => {
      sent.push({ url, init });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } satisfies OAuthHttp,
  tokenUrl: 'https://id.example.com/token',
  clientId: 'client',
  clientSecret: 'secret',
  clientAuth: 'client_secret_post',
  redirectUri: 'https://app.example.com/auth/idp/callback',
  code: 'code',
  verifier: 'verifier',
  asked: ['profile'],
  now: 1_000_000,
});

describe('exchanging the code', () => {
  it('asks for 256 KiB at most, with a POST form', async () => {
    const sent: unknown[] = [];
    await exchangeCode(input({ access_token: 'a', token_type: 'bearer' }, sent));
    expect(sent[0]).toMatchObject({ init: { method: 'POST', maxBytes: 262144 } });
  });

  it('reads an expiry given as a number or a number in a text, and no other', async () => {
    const expiry = async (expires_in: unknown) => {
      const result = await exchangeCode(input({ access_token: 'a', token_type: 'Bearer', expires_in }));
      return result.ok ? result.value.expiresAt : 'error';
    };
    expect(await expiry(60)).toBe(1_060_000);
    expect(await expiry('60')).toBe(1_060_000);
    for (const bad of [0, -5, 'soon', Number.NaN, 1e12, null, {}]) expect(await expiry(bad), String(bad)).toBeUndefined();
  });

  it('reads the scopes the provider names, split at spaces and commas, and an empty answer as none', async () => {
    const scopes = async (scope: unknown) => {
      const result = await exchangeCode(input({ access_token: 'a', token_type: 'bearer', scope }));
      return result.ok ? result.value.scopes : 'error';
    };
    expect(await scopes('a  b')).toEqual(['a', 'b']);
    expect(await scopes('a,b c')).toEqual(['a', 'b', 'c']);
    expect(await scopes('')).toEqual([]);
    // Not a text: the scopes that were asked for.
    expect(await scopes(7)).toEqual(['profile']);
  });

  it('keeps tokens that are strings and drops the others', async () => {
    const result = await exchangeCode(input({ access_token: 'a', token_type: 'bearer', refresh_token: 7, id_token: '' }));
    expect(result).toEqual({ ok: true, value: { accessToken: 'a', scopes: ['profile'] } });
  });

  it('maps a failed request: 5xx and no connection are unavailable, a client error is rejected, no JSON is invalid', async () => {
    expect(await exchangeCode(input(new OAuthHttpError(500)))).toEqual({ ok: false, error: { kind: 'unavailable' } });
    expect(await exchangeCode(input(new OAuthHttpError(403)))).toEqual({ ok: false, error: { kind: 'rejected' } });
    expect(await exchangeCode(input(new OAuthHttpError(0)))).toEqual({ ok: false, error: { kind: 'invalid-response' } });
  });
});
