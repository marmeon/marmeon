import { describe, expect, it } from 'vitest';
import { flowKey, type OpenFlow } from './flow.ts';
import { TOKEN_URL as PLAIN_TOKEN_URL, tokenResponse } from './test-helpers/callback.ts';
import { DISCOVERY_URL, ISSUER, NOW, TOKEN_URL, discoveryDocument, idToken, oidcWith } from './test-helpers/oidc.ts';
import { OIDC } from './oidc.ts';
import { recordChecked } from './oidc-marker.ts';
import { oauthWith } from './test-helpers/flow.ts';
import { verifiedInfo } from './verified.ts';

const SECONDS = NOW / 1000;
const kindOf = (result: { ok: boolean; error?: { kind: string } }): string | undefined => (result.ok ? undefined : result.error?.kind);

/** An `oidc()` provider with a confirmation flow of user 7 open; `claims` are the claims of the ID token the provider answers with. */
async function confirming(claims: Record<string, unknown> = {}, options: { intent?: string; userId?: number } = {}) {
  const made = oidcWith();
  const intent = options.intent ?? 'confirm';
  const redirect = await made.oauth.redirect('idp', { intent, userId: options.userId ?? 7, ...(intent === 'confirm' ? { account: 'user-1' } : {}) } as never);
  if (!redirect.ok) throw new Error('expected a flow');
  const flow = made.session.data.get(flowKey('idp')) as OpenFlow;
  made.http.respond(TOKEN_URL, () => tokenResponse({ id_token: idToken({ nonce: flow.nonce, ...claims }) }));
  const query = new URLSearchParams({ code: 'the-code', state: flow.state });
  return { ...made, flow, redirect: redirect.value, query };
}

describe('a confirmation with a fresh sign-in at the provider', () => {
  it('refuses a redirect() whose scopes with the forced openid are more than a flow holds', async () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => `s${i}`);
    const { oauth } = oidcWith({ scopes: ['a'] } as never);
    // `openid` and `a` are two of the 64: 62 more fit, 63 do not.
    expect((await oauth.redirect('idp', { scopes: many(62) })).ok).toBe(true);
    await expect(oauth.redirect('idp', { scopes: many(63) })).rejects.toThrow(TypeError);
  });

  it('takes the tokens to cover the scopes the flow asked for, openid and the ones of redirect() included, when the token response names none', async () => {
    const made = oidcWith();
    const redirect = await made.oauth.redirect('idp', { scopes: ['extra'] });
    if (!redirect.ok) throw new Error('expected a flow');
    const flow = made.session.data.get(flowKey('idp')) as OpenFlow;
    made.http.respond(TOKEN_URL, () => tokenResponse({ id_token: idToken({ nonce: flow.nonce }) }));
    const result = await made.oauth.callback('idp', new URLSearchParams({ code: 'the-code', state: flow.state }));
    if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
    expect(result.value.user.tokens.scopes).toEqual(flow.scopes);
    expect(result.value.user.tokens.scopes).toEqual(expect.arrayContaining(['openid', 'extra']));
  });

  it('confirms with an auth_time at the redirect and records it in milliseconds', async () => {
    const { oauth, query } = await confirming({ auth_time: SECONDS });
    const result = await oauth.callback('idp', query, { userId: 7 });
    if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
    expect(result.value.intent).toBe('confirm');
    expect(verifiedInfo(result.value.user)).toMatchObject({ intent: 'confirm', flowUserId: '7', reauthenticatedAt: SECONDS * 1000 });
  });

  it('refuses to start a confirmation with a provider that is no OpenID Connect provider (GitHub-like definition)', async () => {
    for (const overrides of [{}, { label: 'OpenID Connect', nonce: true }]) {
      const { oauth, session, http } = oauthWith({ overrides });
      expect(await oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'user-1' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
      expect(session.data.size).toBe(0);
      http.assertNothingSent();
    }
    // A definition that has lost the marker (an object rebuilt from the visible fields) is no OpenID Connect provider either.
    const made = oidcWith();
    const { definition } = made;
    const rebuilt = { label: definition.label, endpoints: definition.endpoints, scopes: definition.scopes, nonce: true, pkce: true, profile: definition.profile, mapUser: definition.mapUser };
    const copy = oauthWith({ overrides: rebuilt });
    expect(kindOf(await copy.oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'user-1' }))).toBe('reauthentication-unsupported');
    expect(copy.session.data.size).toBe(0);
    copy.http.assertNothingSent();
  });

  it('refuses to start a confirmation without a user id', async () => {
    const { oauth, session, http } = oidcWith();
    // @ts-expect-error a confirmation names its user
    await expect(oauth.redirect('idp', { intent: 'confirm', account: 'user-1' })).rejects.toThrow(TypeError);
    // @ts-expect-error a user that is undefined is no user
    await expect(oauth.redirect('idp', { intent: 'confirm', userId: undefined, account: 'user-1' })).rejects.toThrow(TypeError);
    expect(session.data.size).toBe(0);
    http.assertNothingSent();
  });

  it('refuses to start a confirmation without an account, and an account with any other intent', async () => {
    const { oauth, session, http } = oidcWith();
    // @ts-expect-error a confirmation names the account it is for
    await expect(oauth.redirect('idp', { intent: 'confirm', userId: 7 })).rejects.toThrow(TypeError);
    await expect(oauth.redirect('idp', { intent: 'confirm', userId: 7, account: '' })).rejects.toThrow(TypeError);
    await expect(oauth.redirect('idp', { intent: 'link', userId: 7, account: 'user-1' } as never)).rejects.toThrow(TypeError);
    await expect(oauth.redirect('idp', { userId: 7, account: 'user-1' } as never)).rejects.toThrow(TypeError);
    expect(session.data.size).toBe(0);
    http.assertNothingSent();
  });

  it('asks for prompt=login and max_age=0 on a confirmation only', async () => {
    const confirm = (await confirming()).redirect;
    expect(confirm.searchParams.getAll('prompt')).toEqual(['login']);
    expect(confirm.searchParams.getAll('max_age')).toEqual(['0']);
    // An own prompt cannot soften it.
    const own = await oidcWith().oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'user-1', prompt: 'consent' });
    if (!own.ok) throw new Error('expected a flow');
    expect(own.value.searchParams.getAll('prompt')).toEqual(['login']);
    expect(own.value.searchParams.getAll('max_age')).toEqual(['0']);
    for (const intent of ['sign-in', 'link']) {
      const other = await oidcWith().oauth.redirect('idp', { intent, userId: 7 });
      if (!other.ok) throw new Error('expected a flow');
      expect(other.value.searchParams.has('prompt'), intent).toBe(false);
      expect(other.value.searchParams.has('max_age'), intent).toBe(false);
    }
  });

  it('a token without auth_time confirms nothing', async () => {
    const { oauth, query } = await confirming({});
    expect(await oauth.callback('idp', query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
  });

  it('does not take iat in place of a missing auth_time', async () => {
    const { oauth, query } = await confirming({ iat: SECONDS });
    expect(await oauth.callback('idp', query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
  });

  it('an auth_time that is no finite number confirms nothing', async () => {
    for (const auth_time of [null, String(SECONDS), true, [SECONDS], { v: SECONDS }]) {
      const { oauth, query } = await confirming({ auth_time });
      expect(kindOf(await oauth.callback('idp', query, { userId: 7 })), JSON.stringify(auth_time)).toBe('not-reauthenticated');
    }
  });

  it('an auth_time older than the redirect beyond 10 seconds confirms nothing', async () => {
    const old = await confirming({ auth_time: SECONDS - 11 });
    expect(await old.oauth.callback('idp', old.query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    const days = await confirming({ auth_time: SECONDS - 86_400 });
    expect(kindOf(await days.oauth.callback('idp', days.query, { userId: 7 }))).toBe('not-reauthenticated');
    // The edge is still inside the drift.
    const edge = await confirming({ auth_time: SECONDS - 10 });
    expect((await edge.oauth.callback('idp', edge.query, { userId: 7 })).ok).toBe(true);
  });

  it('an auth_time far in the future confirms nothing', async () => {
    const late = await confirming({ auth_time: SECONDS + 61 });
    expect(await late.oauth.callback('idp', late.query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    const edge = await confirming({ auth_time: SECONDS + 60 });
    expect((await edge.oauth.callback('idp', edge.query, { userId: 7 })).ok).toBe(true);
  });

  it('a reused state confirms nothing: the second callback answers no-flow', async () => {
    const { oauth, query, http } = await confirming({ auth_time: SECONDS });
    expect((await oauth.callback('idp', query, { userId: 7 })).ok).toBe(true);
    const sent = http.requests.length;
    expect(await oauth.callback('idp', query, { userId: 7 })).toEqual({ ok: false, error: { kind: 'no-flow' } });
    expect(http.requests.length).toBe(sent);
  });

  it("a confirmation flow of one user does not complete in another user's session", async () => {
    for (const signedIn of [8, undefined]) {
      const { oauth, query, http } = await confirming({ auth_time: SECONDS });
      const sent = http.requests.length;
      expect(await oauth.callback('idp', query, signedIn === undefined ? {} : { userId: signedIn })).toEqual({ ok: false, error: { kind: 'invalid' } });
      expect(http.requests.length).toBe(sent);
    }
  });

  it('a sign-in or link flow never carries reauthenticatedAt, even with a fresh auth_time', async () => {
    for (const intent of ['sign-in', 'link']) {
      const { oauth, query } = await confirming({ auth_time: SECONDS }, { intent });
      const result = await oauth.callback('idp', query, { userId: 7 });
      if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
      const info = verifiedInfo(result.value.user);
      expect(info?.intent).toBe(intent);
      expect(info).not.toHaveProperty('reauthenticatedAt');
    }
  });

  it('a profile of the app that is not the checked ID token confirms nothing, whatever it says', async () => {
    const made = oidcWith();
    const forged = oauthWith({
      overrides: {
        ...made.definition,
        // The marker only: a profile of the app is no checked token, whatever it says.
        [OIDC]: true,
        profile: async () => ({ sub: 'user-1', iss: ISSUER, auth_time: SECONDS }),
      } as never,
    });
    forged.http.respond(DISCOVERY_URL, () => Response.json(discoveryDocument()));
    forged.http.respond(TOKEN_URL, () => tokenResponse());
    const redirect = await forged.oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'user-1' });
    expect(redirect.ok).toBe(true);
    const flow = forged.session.data.get(flowKey('idp')) as OpenFlow;
    const result = await forged.oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }), { userId: 7 });
    expect(result).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
  });

  it('an auth_time that is NaN or infinite in the checked claims confirms nothing', async () => {
    for (const auth_time of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const made = oidcWith();
      const forged = oauthWith({
        overrides: {
          ...made.definition,
          profile: async () => {
            const raw = Object.freeze({ sub: 'user-1', iss: ISSUER });
            recordChecked(raw, Object.freeze({ sub: 'user-1', iss: ISSUER, auth_time }));
            return raw;
          },
        } as never,
      });
      forged.http.respond(DISCOVERY_URL, () => Response.json(discoveryDocument()));
      forged.http.respond(TOKEN_URL, () => tokenResponse());
      expect((await forged.oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'user-1' })).ok).toBe(true);
      const flow = forged.session.data.get(flowKey('idp')) as OpenFlow;
      const result = await forged.oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }), { userId: 7 });
      expect(result, String(auth_time)).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    }
  });

  it('refuses options that are no object', async () => {
    const { oauth } = oidcWith();
    await expect(oauth.redirect('idp', null as never)).rejects.toThrow(TypeError);
  });

  it('a confirmation flow at a provider without the marker, without a user or without an account completes nothing and sends nothing', async () => {
    const plain = oauthWith();
    plain.http.respond(PLAIN_TOKEN_URL, () => tokenResponse());
    const open = await plain.oauth.redirect('idp', { userId: 7 });
    expect(open.ok).toBe(true);
    const flow = plain.session.data.get(flowKey('idp')) as OpenFlow;
    plain.session.data.set(flowKey('idp'), { ...flow, intent: 'confirm', account: 'user-1' });
    expect(kindOf(await plain.oauth.callback('idp', new URLSearchParams({ code: 'c', state: flow.state }), { userId: 7 }))).toBe('invalid');
    plain.http.assertNothingSent();

    for (const drop of ['userId', 'account'] as const) {
      const { oauth, session, flow: held, query, http } = await confirming({ auth_time: SECONDS });
      const { [drop]: _dropped, ...rest } = held;
      session.data.set(flowKey('idp'), rest);
      const sent = http.requests.length;
      expect(kindOf(await oauth.callback('idp', query, drop === 'userId' ? {} : { userId: 7 })), drop).toBe('invalid');
      expect(http.requests.length, drop).toBe(sent);
    }
  });

  it('refuses a sign-in at another account than the one the confirmation is for', async () => {
    for (const sub of ['user-2', 'USER-1']) {
      const { oauth, query } = await confirming({ auth_time: SECONDS, sub });
      expect(await oauth.callback('idp', query, { userId: 7 }), sub).toEqual({ ok: false, error: { kind: 'invalid' } });
    }
    const { oauth, query } = await confirming({ auth_time: SECONDS, sub: 'user-1' });
    expect((await oauth.callback('idp', query, { userId: 7 })).ok).toBe(true);
  });

  it('never records a reauthenticatedAt later than the callback', async () => {
    const { oauth, query } = await confirming({ auth_time: SECONDS + 40 });
    const result = await oauth.callback('idp', query, { userId: 7 });
    if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
    expect(verifiedInfo(result.value.user)?.reauthenticatedAt).toBe(NOW);
  });

  it('measures the early edge from the redirect and the late edge from the callback when time passes in between', async () => {
    const claims = (auth_time: number) => ({ auth_time, exp: SECONDS + 3600 });
    for (const [auth_time, ok] of [[SECONDS, true], [SECONDS - 10, true], [SECONDS - 11, false], [SECONDS + 360, true], [SECONDS + 361, false]] as const) {
      const { oauth, query, clock } = await confirming(claims(auth_time));
      clock.freeze(NOW + 300_000);
      expect((await oauth.callback('idp', query, { userId: 7 })).ok, String(auth_time - SECONDS)).toBe(ok);
    }
  });
});
