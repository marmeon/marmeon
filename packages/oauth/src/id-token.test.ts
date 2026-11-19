import { describe, expect, it } from 'vitest';
import { checkIdToken, type IdTokenExpectations } from './id-token.ts';
import { ISSUER, NOW, idToken } from './test-helpers/oidc.ts';

const expected = (extra: Partial<IdTokenExpectations> = {}): IdTokenExpectations => ({ issuers: () => [ISSUER], clientId: 'client', nonce: 'n', now: NOW, ...extra });
const kindOf = (token: string, extra: Partial<IdTokenExpectations> = {}): string | undefined => {
  const result = checkIdToken(token, expected(extra));
  return result.ok ? undefined : result.error.kind;
};

describe('checkIdToken()', () => {
  it('accepts a token that is right in every respect and hands back its claims, frozen', () => {
    const result = checkIdToken(idToken({ email: 'a@example.com' }), expected());
    if (!result.ok) throw new Error('expected claims');
    expect(result.value).toMatchObject({ sub: 'user-1', iss: ISSUER, email: 'a@example.com' });
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it('refuses an iss with a trailing slash, another case, a missing iss and an iss that is no text', () => {
    for (const iss of [`${ISSUER}/`, 'https://IDP.example.com', 'https://idp.example.com ', 'https://idp.example.org', undefined, 1, ['https://idp.example.com']]) {
      expect(kindOf(idToken({ iss })), String(iss)).toBe('iss');
    }
  });

  it('takes the issuers from acceptedIssuers, compared exactly, and refuses when it throws or answers no list', () => {
    expect(kindOf(idToken({ iss: 'accounts.example.com' }), { issuers: () => [ISSUER, 'accounts.example.com'] })).toBeUndefined();
    expect(kindOf(idToken({ iss: 'accounts.example.com/' }), { issuers: () => [ISSUER, 'accounts.example.com'] })).toBe('iss');
    expect(kindOf(idToken(), { issuers: () => { throw new Error('boom'); } })).toBe('iss');
    expect(kindOf(idToken(), { issuers: () => ISSUER as never })).toBe('iss');
    // It is told the claims, and what it is told cannot be changed under the check.
    let told: Record<string, unknown> | undefined;
    kindOf(idToken({ tid: 'tenant' }), { issuers: (claims) => { told = claims as Record<string, unknown>; return [ISSUER]; } });
    expect(told?.tid).toBe('tenant');
    expect(Object.isFrozen(told)).toBe(true);
  });

  it('refuses an aud without the client id', () => {
    for (const aud of ['other', ['other'], ['other', 'another'], [], undefined, 7, [7, 'client'], 'Client']) {
      expect(kindOf(idToken({ aud, azp: 'client' })), JSON.stringify(aud)).toBe('aud');
    }
    expect(kindOf(idToken({ aud: ['client'] }))).toBeUndefined();
  });

  it('refuses several audiences without azp, and an azp of another client', () => {
    expect(kindOf(idToken({ aud: ['client', 'other'] }))).toBe('azp');
    expect(kindOf(idToken({ aud: ['client', 'other'], azp: 'other' }))).toBe('azp');
    expect(kindOf(idToken({ aud: 'client', azp: 'other' }))).toBe('azp');
    expect(kindOf(idToken({ aud: ['client', 'other'], azp: 'client' }))).toBeUndefined();
    expect(kindOf(idToken({ aud: 'client', azp: 'client' }))).toBeUndefined();
  });

  it('refuses an expired token beyond 60 seconds and accepts one within', () => {
    const now = NOW / 1000;
    expect(kindOf(idToken({ exp: now - 59 }))).toBeUndefined();
    expect(kindOf(idToken({ exp: now - 60 }))).toBe('exp');
    expect(kindOf(idToken({ exp: now - 3600 }))).toBe('exp');
    for (const exp of [undefined, '9999999999', null, Number.NaN]) expect(kindOf(idToken({ exp })), String(exp)).toBe('exp');
  });

  it('refuses an iat from the future beyond 60 seconds, and an nbf of the future', () => {
    const now = NOW / 1000;
    expect(kindOf(idToken({ iat: now + 60 }))).toBeUndefined();
    expect(kindOf(idToken({ iat: now + 61 }))).toBe('iat');
    for (const iat of [undefined, `${now}`]) expect(kindOf(idToken({ iat })), String(iat)).toBe('iat');
    expect(kindOf(idToken({ nbf: now + 60 }))).toBeUndefined();
    expect(kindOf(idToken({ nbf: now + 61 }))).toBe('nbf');
    expect(kindOf(idToken({ nbf: 'soon' }))).toBe('nbf');
  });

  it("refuses a token whose nonce is not this flow's", () => {
    for (const nonce of ['m', 'n ', 'nn', 'N', 1, ['n']]) expect(kindOf(idToken({ nonce })), String(nonce)).toBe('nonce');
    expect(kindOf(idToken({ nonce: 'x'.repeat(5000) }))).toBe('nonce');
  });

  it('refuses a token without nonce', () => {
    expect(kindOf(idToken({ nonce: undefined }))).toBe('nonce');
    expect(kindOf(idToken({ nonce: '' }), { nonce: '' })).toBeUndefined();
  });

  it('refuses a sub that is missing, empty, too long or no text', () => {
    for (const sub of [undefined, '', 'x'.repeat(256), 1, ['a']]) expect(kindOf(idToken({ sub })), String(sub).slice(0, 10)).toBe('sub');
    expect(kindOf(idToken({ sub: 'x'.repeat(255) }))).toBeUndefined();
  });

  it('ignores the alg of the header, also none', () => {
    for (const alg of ['RS256', 'HS256', 'ES256', 'none', 'None', 'bogus', undefined, 7]) {
      expect(kindOf(idToken({}, { alg, typ: 'JWT' })), String(alg)).toBeUndefined();
    }
    // `alg: none` comes with an empty signature.
    expect(kindOf(`${idToken({}, { alg: 'none' }).split('.').slice(0, 2).join('.')}.`)).toBeUndefined();
    // Nor does the signature matter: the token came from the token endpoint.
    expect(kindOf(`${idToken().split('.').slice(0, 2).join('.')}.AAAA`)).toBeUndefined();
  });

  it('refuses a payload that is not a JSON object', () => {
    const header = idToken().split('.')[0]!;
    const part = (value: string): string => Buffer.from(value).toString('base64url');
    for (const payload of ['[]', '"text"', '7', 'null', 'true', '{not json', '']) {
      expect(kindOf(`${header}.${part(payload)}.c2ln`), payload).toBe('payload');
    }
    expect(kindOf(`${header}.${Buffer.from([0xff, 0xfe]).toString('base64url')}.c2ln`)).toBe('payload');
    expect(kindOf(`${header}.e30=.c2ln`)).toBe('payload');
  });

  it('refuses what is no token: the wrong number of parts, characters that are no base64url, a header that is no object', () => {
    const [header, payload, signature] = idToken().split('.') as [string, string, string];
    for (const token of ['', 'a', `${header}.${payload}`, `${header}.${payload}.${signature}.x`, `${header}.${payload}.sig nature`, `${header}.${payload}.${signature}+`]) {
      expect(kindOf(token), token).toBe('form');
    }
    expect(kindOf(`${header}.${payload}+/.${signature}`)).toBe('payload');
    expect(kindOf(`${Buffer.from('[]').toString('base64url')}.${payload}.${signature}`)).toBe('header');
    expect(kindOf(`.${payload}.${signature}`)).toBe('header');
  });

  it('does not let a __proto__ claim reach the prototype', () => {
    const token = idToken().split('.');
    token[1] = Buffer.from(`{"__proto__":{"sub":"evil"},"iss":"${ISSUER}","sub":"user-1","aud":"client","exp":${NOW / 1000 + 300},"iat":${NOW / 1000},"nonce":"n"}`).toString('base64url');
    const result = checkIdToken(token.join('.'), expected());
    if (!result.ok) throw new Error('expected claims');
    expect(result.value.sub).toBe('user-1');
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
  });
});
