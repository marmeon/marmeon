import { describe, expect, it } from 'vitest';
import { oidcWith } from '../oidc.ts';
import { idToken } from '../test-helpers/oidc.ts';
import { builtinWith, fixture, tokenResponse } from '../test-helpers/builtin.ts';
import { google } from './google.ts';

const ISSUER = 'https://accounts.google.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const document = {
  url: `${ISSUER}/.well-known/openid-configuration`,
  body: { issuer: ISSUER, authorization_endpoint: `${ISSUER}/o/oauth2/v2/auth`, token_endpoint: TOKEN_URL, userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo' },
};

/** A Google flow whose ID token has `claims`; `iss` is the `iss` parameter of the callback, when it has one. */
async function signIn(claims: Record<string, unknown> = {}, iss?: string) {
  const made = builtinWith(google, 'google', { tokenUrl: TOKEN_URL, document });
  const { query } = await made.begin((flow) => tokenResponse({ id_token: idToken({ iss: ISSUER, nonce: flow.nonce, ...fixture('google-claims'), ...claims }) }));
  if (iss !== undefined) query.set('iss', iss);
  return { ...made, result: await made.oauth.callback('google', query) };
}

const refused = { ok: false, error: { kind: 'invalid-response' } };

describe('google', () => {
  it('accepts a token with either spelling of the issuer and refuses any other', async () => {
    for (const iss of [ISSUER, 'accounts.google.com']) {
      const { result } = await signIn({ iss });
      if (!result.ok) throw new Error(`${iss}: expected a user, got ${result.error.kind}`);
      // One person under both spellings: the id is the sub, so the two do not split an account.
      expect(result.value.user).toMatchObject({ provider: 'google', id: '110169484474386276334', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace', nickname: null, avatar: 'https://lh3.example.com/ada.jpg' });
    }
    for (const iss of [`${ISSUER}/`, 'http://accounts.google.com', 'https://evil.example', 'ACCOUNTS.GOOGLE.COM']) {
      expect((await signIn({ iss })).result, iss).toEqual(refused);
    }
  });

  it('checks the iss parameter against the issuer of the document, with the token in either spelling', async () => {
    for (const tokenIss of [ISSUER, 'accounts.google.com']) expect((await signIn({ iss: tokenIss }, ISSUER)).result.ok, tokenIss).toBe(true);
    // A parameter of another issuer, or of the scheme-less spelling, ends the callback before the code is traded.
    for (const iss of ['https://evil.example', 'accounts.google.com', `${ISSUER}/`]) {
      const { result, http } = await signIn({}, iss);
      expect(result, iss).toEqual({ ok: false, error: { kind: 'invalid' } });
      expect(http.requests.some((request) => request.url === TOKEN_URL), iss).toBe(false);
    }
  });

  it('reads nickname from preferred_username or nickname', async () => {
    expect((await signIn({ preferred_username: 'ada' })).result).toMatchObject({ ok: true, value: { user: { nickname: 'ada' } } });
    expect((await signIn({ nickname: 'lovelace' })).result).toMatchObject({ ok: true, value: { user: { nickname: 'lovelace' } } });
  });

  it('says verified only for an exact true of email_verified', async () => {
    for (const email_verified of [false, 'true', 1, undefined]) {
      const { result } = await signIn({ email_verified });
      expect(result.ok && result.value.user.emailVerified, String(email_verified)).toBe(false);
    }
  });

  it('vouches for an address outside gmail.com only in a Workspace domain', async () => {
    const verified = async (claims: Record<string, unknown>) => {
      const { result } = await signIn(claims);
      return result.ok && result.value.user.emailVerified;
    };
    expect(await verified({ email: 'bob@corp.example', hd: undefined })).toBe(false);
    expect(await verified({ email: 'bob@corp.example', hd: '' })).toBe(false);
    expect(await verified({ email: 'bob@corp.example', hd: 5 })).toBe(false);
    expect(await verified({ email: 'bob@corp.example', hd: 'corp.example' })).toBe(true);
    expect(await verified({ email: 'Bob@Gmail.com', hd: undefined })).toBe(true);
    expect(await verified({ email: 'bob@notgmail.com', hd: undefined })).toBe(false);
    // A Workspace domain does not vouch when Google does not say `email_verified`.
    expect(await verified({ email: 'bob@corp.example', hd: 'corp.example', email_verified: false })).toBe(false);
  });

  it('never confirms: redirect() answers reauthentication-unsupported and sends nothing', async () => {
    const { oauth, http } = builtinWith(google, 'google', { tokenUrl: TOKEN_URL, document });
    expect(await oauth.redirect('google', { intent: 'confirm', userId: 7, account: 'user-1' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
    http.assertNothingSent();
  });

  it('refuses a confirmation flow in the callback even when one was opened', async () => {
    // The flow is opened at a provider with the same endpoints that can confirm, then finished at Google over the same session.
    const open = builtinWith(oidcWith({ issuer: ISSUER, label: 'Google' }, {}), 'google', { tokenUrl: TOKEN_URL, document });
    const { query } = await open.begin((flow) => tokenResponse({ id_token: idToken({ iss: ISSUER, nonce: flow.nonce, auth_time: 1_700_000_000, sub: 'user-1' }) }), 'confirm');
    const real = builtinWith(google, 'google', { tokenUrl: TOKEN_URL, document }, { session: open.session });
    expect(await real.oauth.callback('google', query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'invalid' } });
    real.http.assertNothingSent();
  });

  it('asks for the openid, profile and email scopes with PKCE and a nonce', async () => {
    const { redirect, flow } = await builtinWith(google, 'google', { tokenUrl: TOKEN_URL, document }).begin(() => tokenResponse());
    expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/o/oauth2/v2/auth`);
    expect(redirect.searchParams.get('scope')).toBe('openid profile email');
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.nonce).toBeDefined();
  });
});
