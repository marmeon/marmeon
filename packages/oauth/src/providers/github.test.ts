import { describe, expect, it } from 'vitest';
import { builtinWith, fixture, tokenResponse } from '../test-helpers/builtin.ts';
import { github } from './github.ts';

const USER = 'https://api.github.com/user';
const EMAILS = 'https://api.github.com/user/emails?per_page=100';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';

type Emails = readonly Record<string, unknown>[];

/** A GitHub flow whose profile answers are the given ones; `emails` may also be a status for a refusal. */
async function signIn(user: Record<string, unknown> | number = fixture('github-user'), emails: Emails | number | Record<string, unknown> = fixture<Emails>('github-emails'), token: Record<string, unknown> = {}) {
  const made = builtinWith(github, 'github', { tokenUrl: TOKEN_URL });
  const { query } = await made.begin(() => tokenResponse(token));
  made.http.respond(USER, () => (typeof user === 'number' ? new Response('no', { status: user }) : Response.json(user)));
  made.http.respond(EMAILS, () => (typeof emails === 'number' ? new Response('no', { status: emails }) : Response.json(emails)));
  return { ...made, result: await made.oauth.callback('github', query) };
}

const userOf = (result: Awaited<ReturnType<typeof signIn>>['result']) => {
  if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
  return result.value.user;
};

describe('github', () => {
  it('takes the primary verified address from /user/emails', async () => {
    const { result, http } = await signIn();
    expect(userOf(result)).toMatchObject({ provider: 'github', id: '4815162', email: 'ada@example.com', emailVerified: true, name: 'Ada L.', nickname: 'ada-l', avatar: 'https://avatars.example.com/u/4815162' });
    // The address of /user (public@example.com) is not the primary one: it is not taken. Both calls carry the token and a user agent.
    const profile = http.requests.filter((request) => request.url === USER || request.url === EMAILS);
    expect(profile).toHaveLength(2);
    // The list is asked for in full pages of 100, so the primary address is not cut off.
    for (const request of profile) {
      expect(request.headers.get('authorization')).toBe('Bearer access-secret');
      expect(request.headers.get('user-agent')).toBe('marmeon-oauth');
    }
  });

  it('reports an unverified primary address as unverified', async () => {
    const emails = fixture<Emails>('github-emails').map((entry) => (entry.primary === true ? { ...entry, verified: false } : entry));
    expect(userOf((await signIn(undefined, emails)).result)).toMatchObject({ email: 'ada@example.com', emailVerified: false });
    // Only an exact `true` of the flag counts.
    for (const verified of ['true', 1, undefined]) {
      const odd = fixture<Emails>('github-emails').map((entry) => (entry.primary === true ? { ...entry, verified } : entry));
      expect(userOf((await signIn(undefined, odd)).result).emailVerified, String(verified)).toBe(false);
    }
  });

  it('does not vouch for a verified address that is not the primary one', async () => {
    // A list in which the only verified entry is another address, and the primary is unverified.
    const emails: Emails = [
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'ada@example.com', primary: true, verified: false },
    ];
    expect(userOf((await signIn(undefined, emails)).result)).toMatchObject({ email: 'ada@example.com', emailVerified: false });
  });

  it('falls back to the public email, unverified, when /user/emails is forbidden', async () => {
    for (const status of [403, 404]) {
      expect(userOf((await signIn(undefined, status)).result), String(status)).toMatchObject({ id: '4815162', email: 'public@example.com', emailVerified: false });
    }
    // The public address stays unverified when the list has no primary entry either.
    expect(userOf((await signIn(undefined, [])).result)).toMatchObject({ email: 'public@example.com', emailVerified: false });
  });

  it('does not take another failure of /user/emails for a missing list', async () => {
    const { result } = await signIn(undefined, 500);
    expect(result).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });

  it('takes an answer that is no list for a missing list, and stops at a failure of /user or an expired token', async () => {
    // A 200 with an error object (not an array) is no list: the public address, unverified.
    expect(userOf((await signIn(undefined, { message: 'Not Found' })).result)).toMatchObject({ email: 'public@example.com', emailVerified: false });
    // A 401 on /user/emails is another failure, not a missing scope.
    expect((await signIn(undefined, 401)).result).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    expect((await signIn(401)).result).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    expect((await signIn(500)).result).toEqual({ ok: false, error: { kind: 'unavailable' } });
  });

  it('keeps the numeric id as the provider id, not the login', async () => {
    expect(userOf((await signIn({ ...fixture<Record<string, unknown>>('github-user'), login: 'renamed' })).result)).toMatchObject({ id: '4815162', nickname: 'renamed' });
    // An id that is no whole number is no identity at all.
    for (const id of ['4815162', 4815162.5, 0, -5, null, undefined]) {
      expect((await signIn({ ...fixture<Record<string, unknown>>('github-user'), id })).result, String(id)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    }
  });

  it('refuses a confirmation (reauthentication-unsupported)', async () => {
    const { oauth, http } = builtinWith(github, 'github', { tokenUrl: TOKEN_URL });
    expect(await oauth.redirect('github', { intent: 'confirm', userId: 7, account: '4815162' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
    http.assertNothingSent();
  });

  it('reads the comma-separated scopes of the token response as separate scopes', async () => {
    const { result } = await signIn(undefined, undefined, { scope: 'read:user,user:email' });
    expect(userOf(result).tokens.scopes).toEqual(['read:user', 'user:email']);
  });

  it('asks for the endpoints, scopes and PKCE GitHub documents', async () => {
    const { redirect, flow } = await builtinWith(github, 'github', { tokenUrl: TOKEN_URL }).begin(() => tokenResponse());
    expect(redirect.origin + redirect.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(redirect.searchParams.get('scope')).toBe('read:user user:email');
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.nonce).toBeUndefined();
  });
});
