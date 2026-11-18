import { errorCodeOf } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { flowKey } from './flow.ts';
import { OAuthSetupError } from './config.ts';
import { oauthCredentials } from './credentials.ts';
import type { IdTokenClaims } from './id-token.ts';
import type { SocialProfile } from './definition.ts';
import { ISSUER_PARAM, OIDC, oidc, type OidcDefinition } from './oidc.ts';
import { OAuthProviders } from './registry.ts';
import { tokenResponse } from './test-helpers/callback.ts';
import { activeEnv, definition as plainDefinition, oauthApp, providerBringing } from './test-helpers/app.ts';
import { expectA11, failure } from './test-helpers/start.ts';
import { ISSUER, NOW, TOKEN_URL, USERINFO_URL, contextOf, discoveryDocument, idToken, oidcWith } from './test-helpers/oidc.ts';
import { oauthWith, recordingLogger } from './test-helpers/flow.ts';
import { vi } from 'vitest';

// oxlint-disable-next-line unicorn/no-thenable -- the test needs an object whose `then` throws, which acceptedIssuers must survive
const throwingThenable = (): object => ({ then: () => { throw new Error('bad thenable'); } });
const tenantMapUser = (claims: IdTokenClaims): SocialProfile => ({ id: `${claims.iss}|${claims.sub}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null });
const form = async (request: Request): Promise<URLSearchParams> => new URLSearchParams(await request.clone().text());

describe('oidc()', () => {
  it('signs in through discovery, the token endpoint and the id token', async () => {
    const { oauth, http, begin } = oidcWith();
    const { flow, redirect, query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, email: 'Ada@Example.com', email_verified: true, name: 'Ada', preferred_username: 'ada', picture: 'https://idp.example.com/ada.png' }) }));
    expect(redirect.origin + redirect.pathname).toBe(`${ISSUER}/authorize`);
    const result = await oauth.callback('idp', query);
    if (!result.ok) throw new Error(`expected a user, got ${result.error.kind}`);
    expect(result.value.user).toMatchObject({ provider: 'idp', id: 'user-1', email: 'ada@example.com', emailVerified: true, name: 'Ada', nickname: 'ada', avatar: 'https://idp.example.com/ada.png' });
    // One discovery for the redirect and the callback together, one token request, with the verifier and the secret.
    http.assertSentCount(2);
    expect(http.requests[0]!.method).toBe('GET');
    const token = http.requests.find((request) => request.url === TOKEN_URL)!;
    expect(Object.fromEntries(await form(token))).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', code_verifier: expect.any(String), client_id: 'client', client_secret: 'secret' });
    expect(flow.nonce).toBeDefined();
  });

  it('says emailVerified only for an exact true of email_verified, next to an address', async () => {
    for (const [email_verified, expected] of [[true, true], ['true', false], [1, false], [undefined, false]] as const) {
      const { oauth, begin } = oidcWith();
      const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, email: 'a@example.com', email_verified }) }));
      const result = await oauth.callback('idp', query);
      expect(result.ok && result.value.user.emailVerified, String(email_verified)).toBe(expected);
    }
  });

  it('sends a nonce and always the openid scope', async () => {
    const { flow, redirect } = await oidcWith().begin();
    expect(redirect.searchParams.get('nonce')).toBe(flow.nonce);
    expect(flow.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redirect.searchParams.get('scope')).toBe('openid profile email');
    expect(redirect.searchParams.get('code_challenge_method')).toBe('S256');
    // A list of scopes that leaves it out, the configured one included, still asks for it.
    for (const parts of [{}, { scopes: ['profile'] }]) {
      const made = oidcWith({ scopes: ['email'] }, parts);
      const sent = (await made.begin()).redirect.searchParams.get('scope')!.split(' ');
      expect(sent[0]).toBe('openid');
      expect(sent).toContain(parts.scopes?.[0] ?? 'email');
    }
  });

  it('builds a definition with a nonce, PKCE and openid first among its scopes', async () => {
    const { definition } = oidcWith({ scopes: ['email', 'openid'] });
    expect(definition.nonce).toBe(true);
    expect(definition.pkce).toBe(true);
    expect(definition.scopes).toEqual(['openid', 'email']);
  });

  it('refuses to check an id token when the flow has no nonce, whatever the token says', async () => {
    const { definition } = oidcWith();
    const input = { http: { json: async () => ({}) }, tokens: { accessToken: 'a', scopes: [], idToken: idToken({ nonce: undefined }) }, nonce: undefined, clientId: 'client', now: NOW };
    await expect(definition.profile(input)).rejects.toThrow('has no nonce');
  });

  it('answers invalid-response when the token response has no id_token', async () => {
    const { oauth, begin } = oidcWith();
    const { query } = await begin(() => tokenResponse());
    expect(await oauth.callback('idp', query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
  });

  it('answers invalid-response for an id token that fails a check, and says nothing of the token in the log', async () => {
    const logger = recordingLogger();
    const bad = [(n: string | undefined) => idToken({ nonce: n, iss: `${ISSUER}/` }), () => idToken({ nonce: 'forged' }), (n: string | undefined) => idToken({ nonce: n, aud: 'other' }), () => 'not-a-token'];
    for (const make of bad) {
      const { oauth, begin } = oidcWith({}, { logger });
      let secret = '';
      const { query } = await begin((f) => {
        secret = make(f.nonce);
        return tokenResponse({ id_token: secret });
      });
      expect(await oauth.callback('idp', query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
      expect(logger.entries).toContain('warn An OAuth callback was refused. {"provider":"idp","reason":"profile"}');
      expect(logger.entries.join('\n')).not.toContain(secret);
      if (secret.includes('.')) expect(logger.entries.join('\n')).not.toContain(secret.split('.')[1]!);
    }
  });

  it('uses the issuers acceptedIssuers lists, and no other', async () => {
    const accepted = oidcWith({ acceptedIssuers: () => [ISSUER, 'idp.example.com'], mapUser: tenantMapUser });
    const { query } = await accepted.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, iss: 'idp.example.com' }) }));
    expect((await accepted.oauth.callback('idp', query)).ok).toBe(true);
    const strict = oidcWith({ acceptedIssuers: () => [ISSUER], mapUser: tenantMapUser });
    const second = await strict.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, iss: 'idp.example.com' }) }));
    expect(await strict.oauth.callback('idp', second.query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
  });

  it('refuses a userinfo whose sub differs from the id token', async () => {
    const { oauth, http, begin } = oidcWith({ userinfo: true });
    const { query } = await begin();
    http.respond(USERINFO_URL, () => Response.json({ sub: 'someone-else', email: 'victim@example.com', email_verified: true }));
    expect(await oauth.callback('idp', query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
  });

  it('merges the userinfo claims, but sub, iss, aud and auth_time come from the id token only', async () => {
    const { oauth, http, begin } = oidcWith({ userinfo: true });
    const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, auth_time: 1_699_999_000, name: 'From token' }) }));
    http.respond(USERINFO_URL, (request) => {
      expect(request.headers.get('authorization')).toBe('Bearer access-secret');
      return Response.json({ sub: 'user-1', iss: 'https://evil.example', aud: 'other', auth_time: 1, email: 'ada@example.com', email_verified: true, name: 'From userinfo' });
    });
    const result = await oauth.callback('idp', query);
    if (!result.ok) throw new Error(result.error.kind);
    const raw = result.value.user.raw as Record<string, unknown>;
    expect(raw).toMatchObject({ sub: 'user-1', iss: ISSUER, aud: 'client', auth_time: 1_699_999_000, email: 'ada@example.com', name: 'From userinfo' });
    expect(result.value.user.email).toBe('ada@example.com');
  });

  it('answers invalid-response for a userinfo answer that is no object, and unavailable for one that fails', async () => {
    for (const [reply, kind] of [[() => Response.json([]), 'invalid-response'], [() => new Response('{}', { status: 503 }), 'unavailable']] as const) {
      const { oauth, http, begin } = oidcWith({ userinfo: true });
      const { query } = await begin();
      http.respond(USERINFO_URL, reply);
      expect(await oauth.callback('idp', query)).toEqual({ ok: false, error: { kind } });
    }
  });

  it('maps the claims with mapUser when it is given, and hands it the checked claims', async () => {
    const { oauth, begin } = oidcWith({ mapUser: (claims) => ({ id: `idp:${claims.sub}`, email: null, emailVerified: false, name: String(claims.tid), nickname: null, avatar: null }) });
    const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, tid: 'tenant-1' }) }));
    const result = await oauth.callback('idp', query);
    expect(result.ok && result.value.user).toMatchObject({ id: 'idp:user-1', name: 'tenant-1' });
  });

  it('keeps the id token claims of a checked callback readable through the marker, and only for an answer oidc() made', async () => {
    const { oauth, http, definition, begin } = oidcWith({ userinfo: true });
    const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, auth_time: 5, name: 'From token' }) }));
    http.respond(USERINFO_URL, () => Response.json({ sub: 'user-1', name: 'From userinfo' }));
    const result = await oauth.callback('idp', query);
    if (!result.ok) throw new Error(result.error.kind);
    const claimsOf = (definition as OidcDefinition)[OIDC];
    expect(claimsOf(result.value.user.raw)).toMatchObject({ sub: 'user-1', auth_time: 5, name: 'From token' });
    // A copy, a look-alike or nothing is no checked answer.
    expect(claimsOf({ ...(result.value.user.raw as object) })).toBeUndefined();
    expect(claimsOf({ sub: 'user-1', iss: ISSUER, auth_time: Date.now() })).toBeUndefined();
    expect(claimsOf(undefined)).toBeUndefined();
  });

  it('is told apart from any other provider by the marker, and the registry keeps it', async () => {
    class Keycloak {
      static config = [oauthCredentials('keycloak', { issuer: 'required' })];
      static oauthProviders = { keycloak: oidc({ label: 'Keycloak' }) };
    }
    const app = await oauthApp([Keycloak], { ...activeEnv('keycloak'), OAUTH_KEYCLOAK_ISSUER: 'https://keycloak.example.com/realms/main' });
    const provider = app.application.container.make(OAuthProviders).get('keycloak')!;
    expect(provider.label).toBe('Keycloak');
    expect(typeof (provider.definition as unknown as OidcDefinition)[OIDC]).toBe('function');
    expect(provider.definition.nonce).toBe(true);
    expect(ISSUER_PARAM in provider.definition).toBe(false);
    // The rule for the issuer parameter comes along when acceptedIssuers is given.
    class Tenants {
      static config = [oauthCredentials('tenants')];
      static oauthProviders = { tenants: oidc({ issuer: ISSUER, acceptedIssuers: () => ['https://t1.example.com'], mapUser: tenantMapUser }) };
    }
    const tenants = (await oauthApp([Tenants], activeEnv('tenants'))).application.container.make(OAuthProviders).get('tenants')!;
    expect((tenants.definition as unknown as OidcDefinition)[ISSUER_PARAM]).toBe(true);
  });

  it('stops the start (A11) when there is no issuer, or the issuer is no https address', async () => {
    for (const [options, issuer] of [[{}, undefined], [{}, ''], [{ issuer: 'http://idp.example.com' }, undefined]] as const) {
      const run = () => oidc({ ...options })(contextOf(() => ({ now: () => 0 }), 'idp', issuer));
      // `local` is true in a test, so http to a loopback host would pass but not this address.
      if (options.issuer === undefined && issuer === undefined) {
        const error = (() => { try { run(); } catch (e) { return e; } })();
        expect(error).toBeInstanceOf(OAuthSetupError);
        expect(errorCodeOf(error)).toBe('A11');
        expect((error as Error).message).toContain('OAUTH_IDP_ISSUER');
      } else {
        expect(run, String(options.issuer ?? issuer)).toThrow(OAuthSetupError);
      }
    }
  });

  it('takes the issuer from the credentials and builds the discovery address from it, without a trailing slash', async () => {
    const urls: string[] = [];
    const definition = oidc()(contextOf(() => ({ now: () => 0 }), 'idp', 'https://idp.example.com/realms/main/'));
    await (definition.endpoints as (http: unknown) => Promise<unknown>)({ json: async (url: string) => (urls.push(url), { issuer: 'https://idp.example.com/realms/main/', authorization_endpoint: 'https://a', token_endpoint: 'https://t' }) });
    expect(urls).toEqual(['https://idp.example.com/realms/main/.well-known/openid-configuration']);
  });

  it('refuses a misspelt option and options of the wrong form (a TypeError)', () => {
    expect(() => oidc({ issuer: ISSUER, userInfo: true } as never)).toThrow(/does not take "userInfo"/);
    expect(() => oidc({ acceptedIssuers: [] } as never)).toThrow(TypeError);
    expect(() => oidc(null as never)).toThrow(TypeError);
  });
  it('refuses acceptedIssuers without a mapUser, since a sub is unique only within its issuer, and says what to put into the id', () => {
    expect(() => oidc({ acceptedIssuers: () => [ISSUER] } as never)).toThrow(/needs a mapUser that puts the issuer or the tenant into the id/);
    expect(() => oidc({ acceptedIssuers: () => [ISSUER] } as never)).toThrow(TypeError);
    expect(() => oidc({ acceptedIssuers: () => [ISSUER], mapUser: tenantMapUser })).not.toThrow();
  });

  it('keeps people of two issuers apart through the id mapUser builds', async () => {
    const ids: string[] = [];
    for (const iss of [ISSUER, 'https://other.example.com']) {
      const made = oidcWith({ acceptedIssuers: () => [ISSUER, 'https://other.example.com'], mapUser: tenantMapUser });
      const { query } = await made.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, iss }) }));
      const result = await made.oauth.callback('idp', query);
      if (result.ok) ids.push(result.value.user.id);
    }
    expect(ids).toEqual([`${ISSUER}|user-1`, 'https://other.example.com|user-1']);
  });

  it('takes email_verified from the userinfo answer alone when it gives the email, and never mixes the pair of the two answers', async () => {
    const run = async (token: Record<string, unknown>, info: Record<string, unknown>) => {
      const made = oidcWith({ userinfo: true });
      const { query } = await made.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, ...token }) }));
      made.http.respond(USERINFO_URL, () => Response.json({ sub: 'user-1', ...info }));
      const result = await made.oauth.callback('idp', query);
      if (!result.ok) throw new Error(result.error.kind);
      return { user: result.value.user, raw: result.value.user.raw as Record<string, unknown> };
    };
    // The attacker's address is verified in the ID token; the victim's comes from userinfo without a flag.
    const mixed = await run({ email: 'attacker@example.com', email_verified: true }, { email: 'victim@example.com' });
    expect(mixed.user).toMatchObject({ email: 'victim@example.com', emailVerified: false });
    expect('email_verified' in mixed.raw).toBe(false);
    // The flag of the answer that gives the address counts, both ways.
    expect((await run({ email: 'a@example.com', email_verified: false }, { email: 'b@example.com', email_verified: true })).user.emailVerified).toBe(true);
    expect((await run({ email: 'a@example.com', email_verified: true }, { email: 'b@example.com', email_verified: false })).user.emailVerified).toBe(false);
    // Userinfo without an address leaves the ID token's pair as it is.
    expect((await run({ email: 'a@example.com', email_verified: true }, { name: 'Ada' })).user).toMatchObject({ email: 'a@example.com', emailVerified: true });
    // The phone number is a pair of its own.
    const phone = await run({ phone_number: '+1', phone_number_verified: true }, { phone_number: '+2' });
    expect(phone.raw).toMatchObject({ phone_number: '+2' });
    expect('phone_number_verified' in phone.raw).toBe(false);
  });

  it('says emailVerified false for email_verified without an email, and takes nickname when there is no preferred_username', async () => {
    const { oauth, begin } = oidcWith();
    const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, email_verified: true, nickname: 'ada-n' }) }));
    const result = await oauth.callback('idp', query);
    expect(result.ok && result.value.user).toMatchObject({ email: null, emailVerified: false, nickname: 'ada-n' });
  });

  it('lets userinfo set no claim only the id token sets, whatever it sends for each', async () => {
    const claims = { azp: 'client', nbf: NOW / 1000 - 10, auth_time: 1_699_999_000, acr: 'urn:high', amr: ['pwd'] };
    const { oauth, http, begin } = oidcWith({ userinfo: true });
    const { flow, query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, ...claims }) }));
    http.respond(USERINFO_URL, () => Response.json({ sub: 'user-1', iss: 'x', aud: 'x', azp: 'x', exp: 1, iat: 1, nbf: 1, nonce: 'x', auth_time: 1, acr: 'x', amr: ['x'] }));
    const result = await oauth.callback('idp', query);
    if (!result.ok) throw new Error(result.error.kind);
    const raw = result.value.user.raw as Record<string, unknown>;
    const token = JSON.parse(Buffer.from(idToken({ ...claims }).split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    for (const claim of ['iss', 'aud', 'azp', 'exp', 'iat', 'nbf', 'auth_time', 'acr', 'amr']) expect(raw[claim], claim).toEqual(token[claim]);
    expect(raw.nonce).toBe(flow.nonce);
  });

  it('refuses options of the wrong type (a TypeError)', () => {
    for (const options of [{ issuer: 1 }, { discoveryUrl: 1 }, { discoveryIssuer: 1 }, { userinfo: 'yes' }]) {
      expect(() => oidc(options as never), JSON.stringify(options)).toThrow(TypeError);
    }
  });

  it('stops the start (A11) when the issuer is set in oidc() and in the variable, and when discoveryUrl is no usable address', () => {
    const clock = () => ({ now: () => 0 });
    const run = (options: Parameters<typeof oidc>[0], issuer?: string) => () => oidc(options)(contextOf(clock, 'idp', issuer));
    const both = (() => { try { run({ issuer: ISSUER }, 'https://other.example.com')(); } catch (e) { return e; } })();
    expect(errorCodeOf(both)).toBe('A11');
    expect((both as Error).message).toContain('set the issuer in one place');
    for (const discoveryUrl of ['http://idp.example.com/discovery', 'not a url', 'https://user:pw@idp.example.com/d', 'https://idp.example.com/d#x']) {
      const error = (() => { try { run({ issuer: ISSUER, discoveryUrl })(); } catch (e) { return e; } })();
      expect(error, discoveryUrl).toBeInstanceOf(OAuthSetupError);
      expect(errorCodeOf(error), discoveryUrl).toBe('A11');
    }
    expect(run({ issuer: ISSUER, discoveryUrl: 'http://127.0.0.1:9/d' })).not.toThrow();
  });

  it('stops the app start (A11) for an oidc() provider with no issuer anywhere', async () => {
    class NoIssuer {
      static config = [oauthCredentials('idp', { issuer: 'optional' })];
      static oauthProviders = { idp: oidc() };
    }
    const message = expectA11(await failure(oauthApp([NoIssuer], activeEnv('idp'))));
    expect(message).toContain('needs an issuer');
    // The same with both given.
    class Twice {
      static config = [oauthCredentials('idp', { issuer: 'optional' })];
      static oauthProviders = { idp: oidc({ issuer: ISSUER }) };
    }
    expect(expectA11(await failure(oauthApp([Twice], { ...activeEnv('idp'), OAUTH_IDP_ISSUER: ISSUER })))).toContain('one place');
  });

  it('throws A10 from redirect() for a discovery document of another issuer, and does not answer unavailable', async () => {
    const made = oidcWith({}, {}, discoveryDocument({ issuer: `${ISSUER}/` }));
    const error = await made.oauth.redirect('idp').then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(OAuthSetupError);
    expect(errorCodeOf(error)).toBe('A10');
    expect((error as Error).message).toContain(`${ISSUER}/`);
  });

  it('holds the iss parameter to the issuer of the token when acceptedIssuers is given, and to the issuer of the document otherwise', async () => {
    const template = 'https://idp.example.com/{tenant}/v2';
    const t1 = 'https://idp.example.com/t1/v2';
    const t2 = 'https://idp.example.com/t2/v2';
    const options = { discoveryIssuer: template, acceptedIssuers: () => [t1, t2], mapUser: tenantMapUser };
    // Parameter and token must name one issuer, the one the token passed every check with.
    for (const [param, tokenIssuer, expected] of [[t1, t1, true], [t2, t2, true], [t1, t2, false], [t2, t1, false], [template, t1, false], [`${t1}/`, t1, false], [undefined, t1, true]] as const) {
      const run = oidcWith(options, {}, discoveryDocument({ issuer: template }));
      const { query } = await run.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, iss: tokenIssuer }) }));
      if (param !== undefined) query.set('iss', param);
      expect((await run.oauth.callback('idp', query)).ok, `${String(param)} / ${tokenIssuer}`).toBe(expected);
    }
    // A list built from a claim of the token (a tenant id) accepts what the token says, and the parameter has to agree.
    const byTenant = { discoveryIssuer: template, acceptedIssuers: (claims: Readonly<Record<string, unknown>>) => [`https://idp.example.com/${String(claims.tid)}/v2`], mapUser: tenantMapUser };
    for (const [param, expected] of [[t1, true], [t2, false]] as const) {
      const run = oidcWith(byTenant, {}, discoveryDocument({ issuer: template }));
      const { query } = await run.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, iss: t1, tid: 't1' }) }));
      query.set('iss', param);
      expect((await run.oauth.callback('idp', query)).ok, param).toBe(expected);
    }
    // Without acceptedIssuers the issuer of the document is the one, before the code is traded.
    const plain = oidcWith({ discoveryIssuer: template }, {}, discoveryDocument({ issuer: template }));
    const first = await plain.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce }) }));
    first.query.set('iss', t1);
    expect(await plain.oauth.callback('idp', first.query)).toEqual({ ok: false, error: { kind: 'invalid' } });
    plain.http.assertSentCount(1);
    const second = await plain.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce }) }));
    second.query.set('iss', template);
    expect((await plain.oauth.callback('idp', second.query)).ok).toBe(true);
  });

  it('refuses a list of issuers that is no list, a string included', async () => {
    for (const listed of [ISSUER, { includes: () => true }, null, 7]) {
      const made = oidcWith({ acceptedIssuers: (() => listed) as never, mapUser: tenantMapUser });
      const { query } = await made.begin();
      expect(await made.oauth.callback('idp', query), String(listed)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
    }
  });

  it('gives the flag of the id token when userinfo gives a flag without the value', async () => {
    const run = async (token: Record<string, unknown>, info: Record<string, unknown>) => {
      const made = oidcWith({ userinfo: true });
      const { query } = await made.begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, ...token }) }));
      made.http.respond(USERINFO_URL, () => Response.json({ sub: 'user-1', ...info }));
      const result = await made.oauth.callback('idp', query);
      if (!result.ok) throw new Error(result.error.kind);
      return { user: result.value.user, raw: result.value.user.raw as Record<string, unknown> };
    };
    // The address is the token's, and so is the flag: a flag of userinfo alone vouches for nothing.
    const flagOnly = await run({ email: 'u@example.com', email_verified: false }, { email_verified: true });
    expect(flagOnly.user).toMatchObject({ email: 'u@example.com', emailVerified: false });
    expect(flagOnly.raw.email_verified).toBe(false);
    // No flag in the token: none after the merge, whatever userinfo sends.
    const noFlag = await run({ email: 'u@example.com' }, { email_verified: true });
    expect(noFlag.user.emailVerified).toBe(false);
    expect('email_verified' in noFlag.raw).toBe(false);
    const phone = await run({ phone_number: '+1', phone_number_verified: false }, { phone_number_verified: true });
    expect(phone.raw.phone_number_verified).toBe(false);
    expect('phone_number_verified' in (await run({ phone_number: '+1' }, { phone_number_verified: true })).raw).toBe(false);
  });

  it('throws A10 from callback() for a document of another issuer, with or without an iss parameter', async () => {
    // Another process of the app holds the session's flow but has fetched nothing yet: its first discovery finds another issuer.
    const first = oidcWith();
    const { flow, query } = await first.begin();
    for (const withIss of [true, false]) {
      const other = oidcWith({}, { session: first.session }, discoveryDocument({ issuer: `${ISSUER}/` }));
      // The first callback took the flow out of the session; put it back for the second.
      first.session.data.set(flowKey('idp'), flow);
      const params = new URLSearchParams(query);
      if (withIss) params.set('iss', ISSUER);
      const error = await other.oauth.callback('idp', params).then(() => undefined, (e: unknown) => e);
      expect(error, String(withIss)).toBeInstanceOf(OAuthSetupError);
      expect(errorCodeOf(error)).toBe('A10');
    }
  });

  it('hands the app a raw answer that cannot change what the reader answers: a deeply frozen copy of its own', async () => {
    const { oauth, definition, begin } = oidcWith();
    const { query } = await begin((f) => tokenResponse({ id_token: idToken({ nonce: f.nonce, amr: ['pwd'] }) }));
    const result = await oauth.callback('idp', query);
    if (!result.ok) throw new Error(result.error.kind);
    const raw = result.value.user.raw as Record<string, unknown>;
    const claims = (definition as OidcDefinition)[OIDC](raw)!;
    expect(claims).not.toBe(raw);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(Object.isFrozen(claims.amr)).toBe(true);
    expect(() => ((claims.amr as string[])[0] = 'none')).toThrow(TypeError);
    expect(() => ((claims as Record<string, unknown>).sub = 'x')).toThrow(TypeError);
    // The array the raw answer holds is a separate one.
    expect(raw.amr).not.toBe(claims.amr);
  });

  it('refuses an async acceptedIssuers without an unhandled rejection, and refuses one that throws', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      for (const accepted of [async () => [ISSUER], () => Promise.reject(new Error('quoted-token')), () => { throw new Error('boom'); }, throwingThenable]) {
        const made = oidcWith({ acceptedIssuers: accepted as never, mapUser: tenantMapUser });
        const { query } = await made.begin();
        query.set('iss', ISSUER);
        expect(await made.oauth.callback('idp', query)).toEqual({ ok: false, error: { kind: 'invalid-response' } });
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('fetches the discovery document at discoveryUrl', async () => {
    const url = 'https://login.example.com/custom/discovery.json';
    const made = oidcWith({ discoveryUrl: url });
    made.http.respond(url, () => Response.json(discoveryDocument()));
    expect((await made.oauth.redirect('idp')).ok).toBe(true);
    made.http.assertSent(url).assertSentCount(1);
  });

  it('sends the secret in a Basic header and not in the form with clientAuth client_secret_basic', async () => {
    const { oauth, http, begin } = oidcWith({ clientAuth: 'client_secret_basic' });
    const { query } = await begin();
    expect((await oauth.callback('idp', query)).ok).toBe(true);
    const token = http.requests.find((request) => request.url === TOKEN_URL)!;
    expect(token.headers.get('authorization')).toBe(`Basic ${Buffer.from('client:secret').toString('base64')}`);
    expect((await form(token)).has('client_secret')).toBe(false);
  });

  it('puts authorizeParams into the authorization address, and the flow keeps its own parameters', async () => {
    const { redirect, flow } = await oidcWith({ authorizeParams: { hd: 'example.com', state: 'forged' } }).begin();
    expect(redirect.searchParams.get('hd')).toBe('example.com');
    expect(redirect.searchParams.get('state')).toBe(flow.state);
  });

  it('hands allowAddresses to the client for the discovery', async () => {
    const made = oidcWith({ allowAddresses: ['10.20.0.0/16'] });
    const allowing = vi.spyOn(made.http, 'allowing');
    expect((await made.oauth.redirect('idp')).ok).toBe(true);
    expect(allowing).toHaveBeenCalledWith(['10.20.0.0/16']);
    expect(made.definition.allowAddresses).toEqual(['10.20.0.0/16']);
  });

  it('gives a provider that is no oidc() one no marker and no openid scope', async () => {
    const app = await oauthApp([providerBringing('Plain', { idp: () => plainDefinition() })], activeEnv('idp'));
    const provider = app.application.container.make(OAuthProviders).get('idp')!;
    expect(OIDC in provider.definition).toBe(false);
    expect(ISSUER_PARAM in provider.definition).toBe(false);
    const { oauth } = oauthWith({ scopes: ['profile'] });
    const result = await oauth.redirect('idp');
    expect(result.ok && result.value.searchParams.get('scope')).toBe('profile');
  });
});
