import { describe, expect, it } from 'vitest';
import { OAuthSetupError } from '../config.ts';
import { oidcWith } from '../oidc.ts';
import { builtinContext, builtinWith, tokenResponse } from '../test-helpers/builtin.ts';
import { idToken } from '../test-helpers/oidc.ts';
import { gitlab } from './gitlab.ts';

const documentOf = (issuer: string) => ({
  url: `${issuer}/.well-known/openid-configuration`,
  body: { issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` },
});

/** A GitLab sign-in at `issuer` (gitlab.com when `undefined`) with an ID token of `claims`. */
async function signIn(issuer: string | undefined, claims: Record<string, unknown> = {}) {
  const at = issuer || 'https://gitlab.com';
  const made = builtinWith(gitlab, 'gitlab', { issuer, tokenUrl: `${at}/oauth/token`, document: documentOf(at) });
  const { redirect, query } = await made.begin((flow) => tokenResponse({ id_token: idToken({ iss: at, nonce: flow.nonce, ...claims }) }));
  return { ...made, redirect, result: await made.oauth.callback('gitlab', query) };
}

describe('gitlab', () => {
  it('uses gitlab.com without a variable and trusts its email_verified', async () => {
    const { redirect, result } = await signIn(undefined, { email: 'ada@example.com', email_verified: true });
    expect(redirect.origin + redirect.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(result.ok && result.value.user).toMatchObject({ provider: 'gitlab', email: 'ada@example.com', emailVerified: true });
    const unverified = await signIn(undefined, { email: 'ada@example.com', email_verified: 'true' });
    expect(unverified.result.ok && unverified.result.value.user.emailVerified).toBe(false);
  });

  it('uses OAUTH_GITLAB_ISSUER for a self-hosted GitLab', async () => {
    const issuer = 'https://git.example.com';
    const { redirect, result } = await signIn(issuer);
    expect(redirect.origin + redirect.pathname).toBe(`${issuer}/oauth/authorize`);
    expect(result.ok).toBe(true);
    // A token of gitlab.com does not sign in at a self-hosted server.
    const made = builtinWith(gitlab, 'gitlab', { issuer, tokenUrl: `${issuer}/oauth/token`, document: documentOf(issuer) });
    const second = await made.begin((flow) => tokenResponse({ id_token: idToken({ iss: 'https://gitlab.com', nonce: flow.nonce }) }));
    expect(await made.oauth.callback('gitlab', second.query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
  });

  it('trusts the flag when the configured issuer is exactly gitlab.com, and shows nickname and avatar', async () => {
    const claims = { email: 'ada@example.com', email_verified: true, preferred_username: 'ada', picture: 'https://gitlab.com/uploads/ada.png' };
    const set = await signIn('https://gitlab.com', claims);
    expect(set.result.ok && set.result.value.user).toMatchObject({ emailVerified: true, nickname: 'ada', avatar: 'https://gitlab.com/uploads/ada.png' });
    const other = await signIn('https://git.gitlab.com', claims);
    expect(other.result.ok && other.result.value.user.emailVerified).toBe(false);
    const nick = await signIn(undefined, { nickname: 'lovelace' });
    expect(nick.result.ok && nick.result.value.user.nickname).toBe('lovelace');
  });

  it('never verifies an address at a self-hosted GitLab', async () => {
    const { result } = await signIn('https://git.example.com', { email: 'ada@example.com', email_verified: true });
    expect(result.ok && result.value.user).toMatchObject({ email: 'ada@example.com', emailVerified: false });
  });

  it('puts the issuer into the id, so another issuer matches no account', async () => {
    const com = await signIn(undefined, { sub: '42' });
    const own = await signIn('https://git.example.com', { sub: '42' });
    expect(com.result.ok && com.result.value.user.id).toBe('https://gitlab.com|42');
    expect(own.result.ok && own.result.value.user.id).toBe('https://git.example.com|42');
  });

  it('treats an empty OAUTH_GITLAB_ISSUER as not set, and stops the start for one that is no address', async () => {
    const { redirect } = await signIn('');
    expect(redirect.origin + redirect.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(() => gitlab(builtinContext(() => undefined as never, 'gitlab', { issuer: 'not a url' }))).toThrow(OAuthSetupError);
  });

  it('never confirms: redirect() answers reauthentication-unsupported and sends nothing', async () => {
    const made = builtinWith(gitlab, 'gitlab', { tokenUrl: 'https://gitlab.com/oauth/token', document: documentOf('https://gitlab.com') });
    expect(await made.oauth.redirect('gitlab', { intent: 'confirm', userId: 7, account: 'x|user-1' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
    made.http.assertNothingSent();
  });

  it('refuses a confirmation flow in the callback even when one was opened', async () => {
    const at = 'https://gitlab.com';
    const open = builtinWith(oidcWith({ issuer: at, label: 'GitLab', mapUser: (claims) => ({ id: `${claims.iss}|${claims.sub}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null }) }, {}), 'gitlab', { tokenUrl: `${at}/oauth/token`, document: documentOf(at) });
    const { query } = await open.begin((flow) => tokenResponse({ id_token: idToken({ iss: at, nonce: flow.nonce, auth_time: 1_700_000_000, sub: 'user-1' }) }), 'confirm', `${at}|user-1`);
    const real = builtinWith(gitlab, 'gitlab', { tokenUrl: `${at}/oauth/token`, document: documentOf(at) }, { session: open.session });
    expect(await real.oauth.callback('gitlab', query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'invalid' } });
    real.http.assertNothingSent();
  });
});
