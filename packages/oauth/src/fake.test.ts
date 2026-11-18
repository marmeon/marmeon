import { createHash } from 'node:crypto';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { errorCodeOf, defineModule, type ServiceProviderClass } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { FetchServiceProvider } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import { Controller, defineRoutes, everyone, HttpServiceProvider, type HttpContext } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { createTestApp, type TestApp, type TestAppOptions } from '@marmeon/testing';
import { describe, expect, it } from 'vitest';
import { oauthCredentials } from './credentials.ts';
import { defineOAuthProvider, type OAuthProviderDefinition } from './definition.ts';
import { fakeOAuth, type OAuthFake } from './fake.ts';
import { OAuth } from './oauth.ts';
import { oidc } from './oidc.ts';
import { OAuthServiceProvider } from './provider.ts';
import { OAuthProviders } from './registry.ts';
import { definition, oauthApp, providerBringing } from './test-helpers/app.ts';
import { fakeSession, sessionsFrom } from './test-helpers/flow.ts';

/** An app with the built-in providers, one of its own (`idp`, plain OAuth 2.0) and one session; `extra` adds providers, `env` variables. */
const appWith = (env: Readonly<Record<string, string>> = {}, extra: readonly ServiceProviderClass[] = [], options: TestAppOptions = {}): Promise<TestApp> =>
  oauthApp([providerBringing('Mine', { idp: defineOAuthProvider(definition()) }), ...extra, sessionsFrom([fakeSession()])], { APP_URL: 'https://app.example.com', ...env }, options);

/** The `OAuth` of the one request scope; taken after `fakeOAuth()`, which replaces the registry that a request scope reads. */
const oauthOf = (app: TestApp): OAuth => app.application.container.createScope().make(OAuth);

const open = async (oauth: OAuth, name: string, options?: Parameters<OAuth['redirect']>[1]): Promise<URL> => {
  const result = await oauth.redirect(name, options as never);
  if (!result.ok) throw new Error(`expected a flow, got ${result.error.kind}`);
  return result.value;
};

const queryOf = (url: string): URLSearchParams => new URL(url, 'https://app.example.com').searchParams;

/** Signs a guest in at `name` after `prepare` told the fake what to answer. */
async function signIn(name: string, prepare: (fake: OAuthFake) => void, env: Readonly<Record<string, string>> = {}) {
  const app = await appWith(env);
  const fake = fakeOAuth(app);
  prepare(fake);
  const oauth = oauthOf(app);
  return oauth.callback(name, queryOf(fake.callbackUrl(await open(oauth, name))));
}

const userOf = async (name: string, prepare: (fake: OAuthFake) => void, env?: Readonly<Record<string, string>>) => {
  const result = await signIn(name, prepare, env);
  if (!result.ok) throw new Error(`${name}: ${result.error.kind}`);
  return result.value.user;
};

/** The tenant the fake gives a Microsoft-style provider that has none configured. */
const FIXED_TENANT = '11111111-2222-3333-4444-555555555555';

const thrown = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('fakeOAuth()', () => {
  it('runs a sign-in flow end to end through the real state and PKCE checks', async () => {
    for (const name of ['github', 'google', 'idp']) {
      const app = await appWith();
      const fake = fakeOAuth(app).user(name, { id: '42', email: 'ada@example.com', emailVerified: true, name: 'Ada' });
      const oauth = oauthOf(app);
      const authorization = await open(oauth, name);
      expect(authorization.origin + authorization.pathname).toBe(`https://oauth.fake.invalid/${name}/authorize`);
      const url = fake.callbackUrl(authorization.href);
      expect(url.startsWith(`/auth/${name}/callback?`)).toBe(true);
      expect(queryOf(url).get('code')).toMatch(/^fake-/);
      const result = await oauth.callback(name, queryOf(url));
      if (!result.ok) throw new Error(`${name}: ${result.error.kind}`);
      expect(result.value.user).toMatchObject({ provider: name, email: 'ada@example.com', name: 'Ada', nickname: null });
      expect(result.value.user.id).toContain('42');
      expect(fake.authorizations).toHaveLength(1);
      expect(fake.authorizations[0]!.get('code_challenge_method')).toBe('S256');
      // The code works once: the flow is spent, so a replay finds none.
      expect(await oauth.callback(name, queryOf(url))).toEqual({ ok: false, error: { kind: 'no-flow' } });
    }
  });

  it('refuses a callbackUrl with a foreign state like a real provider would', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('github', { id: '42' });
    const oauth = oauthOf(app);
    const redirect = new Response(null, { status: 303, headers: { location: (await open(oauth, 'github')).href } });
    const url = fake.callbackUrl(redirect, { state: 'foreign' });
    expect(queryOf(url).get('state')).toBe('foreign');
    expect(await oauth.callback('github', queryOf(url))).toEqual({ ok: false, error: { kind: 'invalid' } });
  });

  it('answers cancelled after deny()', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).deny('github');
    const oauth = oauthOf(app);
    const url = fake.callbackUrl(await open(oauth, 'github').then((u) => ({ headers: new Headers({ location: u.href }) })));
    expect(queryOf(url).get('error')).toBe('access_denied');
    expect(queryOf(url).has('code')).toBe(false);
    expect(await oauth.callback('github', queryOf(url))).toEqual({ ok: false, error: { kind: 'cancelled' } });
  });

  it('fails the token request when the verifier does not match the challenge', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('github', { id: '42' });
    const oauth = oauthOf(app);
    // The second flow replaces the first in the session, so the code of the first authorization meets the verifier of the second.
    const first = await open(oauth, 'github');
    const second = await open(oauth, 'github');
    const url = fake.callbackUrl(first, { state: second.searchParams.get('state')! });
    expect(await oauth.callback('github', queryOf(url))).toEqual({ ok: false, error: { kind: 'rejected' } });
  });

  it('keeps a plain OAuth2 provider unable to confirm', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app);
    const oauth = oauthOf(app);
    for (const name of ['github', 'idp', 'google', 'gitlab', 'discord']) {
      expect(await oauth.redirect(name, { intent: 'confirm', userId: 7, account: '42' }), name).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
      // No auth_time exists at a provider that cannot prove a fresh sign-in in production, and none can be asked of the fake.
      expect(() => fake.reauthenticated(name), name).toThrow(/cannot confirm anybody, as in production/);
      expect(() => fake.staleAuthentication(name, 60), name).toThrow(/cannot confirm anybody, as in production/);
    }
  });

  it('confirms through an OIDC provider after reauthenticated() and not without it', async () => {
    const confirm = async (prepare: (fake: OAuthFake) => void) => {
      const app = await appWith();
      const fake = fakeOAuth(app).user('microsoft', { id: '42' });
      prepare(fake);
      const oauth = oauthOf(app);
      // The provider's own mapping puts the tenant in front of the sub, and the confirmation is for that account.
      const account = `${FIXED_TENANT}|42`;
      const url = fake.callbackUrl(await open(oauth, 'microsoft', { intent: 'confirm', userId: 7, account }));
      return oauth.callback('microsoft', queryOf(url), { userId: 7 });
    };
    const confirmed = await confirm((fake) => fake.reauthenticated('microsoft'));
    expect(confirmed.ok && confirmed.value.intent).toBe('confirm');
    expect(await confirm(() => undefined)).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
    expect(await confirm((fake) => fake.staleAuthentication('microsoft', 3600))).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
  });

  it('throws a clear message when no profile is queued', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app);
    const oauth = oauthOf(app);
    const authorization = await open(oauth, 'github');
    expect(() => fake.callbackUrl(authorization.href)).toThrow(/no profile is queued for "github"/);
    expect(() => fake.user('nobody', { id: '1' })).toThrow(/made no provider "nobody" active/);
  });

  it('makes only the providers in only active', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app, { only: ['github'] });
    const oauth = oauthOf(app);
    expect(oauth.providers().map((provider) => provider.name)).toEqual(['github']);
    expect(await oauth.redirect('google')).toEqual({ ok: false, error: { kind: 'unknown-provider' } });
    expect(() => fake.user('google', { id: '1' })).toThrow(/made no provider/);
    expect(() => fakeOAuth(app, { only: ['nowhere'] })).toThrow(/not registered/);
  });

  it('never lets a spread of an oidc() definition confirm, whatever marker it carries', async () => {
    // A spread copies the marker `oidc()` sets, but not that `oidc()` built the object, so its own profile() is not an ID token check.
    const spread = defineOAuthProvider((context) => ({ ...oidc({ issuer: 'https://idp.example.com' })(context), profile: async () => ({ sub: '42', auth_time: 1 }) }));
    const app = await appWith({}, [providerBringing('Spread', { spread })]);
    const fake = fakeOAuth(app);
    const oauth = oauthOf(app);
    expect(await oauth.redirect('spread', { intent: 'confirm', userId: 7, account: '42' })).toEqual({ ok: false, error: { kind: 'reauthentication-unsupported' } });
    expect(() => fake.reauthenticated('spread')).toThrow(/cannot confirm anybody/);
  });

  it('refuses a provider the start would refuse, with the same code', async () => {
    const good = definition();
    const faulty: Record<string, OAuthProviderDefinition> = {
      'an http endpoint': definition({ endpoints: { authorizeUrl: 'http://id.example.com/authorize', tokenUrl: 'https://id.example.com/token' } }),
      'a reserved authorizeParam': definition({ authorizeParams: { state: 'forged' } }),
      'a field that is not part of a definition': { ...good, extra: 1 } as OAuthProviderDefinition,
      'no mapUser': { ...good, mapUser: undefined } as unknown as OAuthProviderDefinition,
      'a scope with a space': definition({ scopes: ['a b'] }),
    };
    for (const [what, broken] of Object.entries(faulty)) {
      const app = await oauthApp([providerBringing('Broken', { broken: defineOAuthProvider(broken) }), sessionsFrom([fakeSession()])], { APP_URL: 'https://app.example.com' });
      const error = thrown(() => fakeOAuth(app));
      expect(error, what).toBeInstanceOf(Error);
      expect(errorCodeOf(error), what).toBe('A11');
    }
  });

  it('vouches for nothing the provider would not vouch for', async () => {
    const ada = { id: '42', email: 'ada@example.org', emailVerified: true };
    // Microsoft never reports an address as verified.
    expect((await userOf('microsoft', (fake) => fake.user('microsoft', ada))).emailVerified).toBe(false);
    // Google vouches for a gmail.com address, or any address of a Workspace domain (`hd`), and for no other.
    expect((await userOf('google', (fake) => fake.user('google', ada))).emailVerified).toBe(false);
    expect((await userOf('google', (fake) => fake.user('google', { ...ada, claims: { hd: 'example.org' } }))).emailVerified).toBe(true);
    expect((await userOf('google', (fake) => fake.user('google', { ...ada, email: 'ada@gmail.com' }))).emailVerified).toBe(true);
    // GitLab trusts the flag of gitlab.com only, not of a server of its own.
    expect((await userOf('gitlab', (fake) => fake.user('gitlab', ada))).emailVerified).toBe(true);
    expect((await userOf('gitlab', (fake) => fake.user('gitlab', ada), { OAUTH_GITLAB_ISSUER: 'https://gitlab.example.com' })).emailVerified).toBe(false);
  });

  it('keeps an address unverified unless the test says it is verified, and an absent one null', async () => {
    for (const name of ['github', 'google']) {
      const unverified = await userOf(name, (fake) => fake.user(name, { id: '1', email: 'ada@gmail.com' }));
      expect(unverified, name).toMatchObject({ email: 'ada@gmail.com', emailVerified: false });
      expect((await userOf(name, (fake) => fake.user(name, { id: '1' }))).email, name).toBeNull();
    }
  });

  it('uses up what user() prepared, and starts afresh with every user()', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app);
    const oauth = oauthOf(app);
    // A preparation that waits without a profile (the others came first) makes user() throw, and names the order.
    fake.deny('github');
    expect(() => fake.user('github', { id: '2' })).toThrow(/Call user\('github', …\) first/);
    fake.callbackUrl(await open(oauth, 'github'));
    fake.user('github', { id: '2' });
    const url = fake.callbackUrl(await open(oauth, 'github'));
    expect(queryOf(url).has('error')).toBe(false);
    expect(queryOf(url).has('code')).toBe(true);
    // A reauthentication left over does not survive it either, and a replaced profile is the one that signs in.
    fake.user('microsoft', { id: '1' }).reauthenticated('microsoft').user('microsoft', { id: '3' });
    const account = `${FIXED_TENANT}|3`;
    const confirm = fake.callbackUrl(await open(oauth, 'microsoft', { intent: 'confirm', userId: 7, account }));
    expect(await oauth.callback('microsoft', queryOf(confirm), { userId: 7 })).toEqual({ ok: false, error: { kind: 'not-reauthenticated' } });
  });

  it('refuses user() after a staleAuthentication() that waited for no profile', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).staleAuthentication('microsoft', 5);
    expect(() => fake.user('microsoft', { id: '1' })).toThrow(/waiting without a profile/);
  });

  it('refuses an oidc() definition that is changed after it was built, as an own profile() would be', async () => {
    // The definition is frozen when `oidc()` has built it, so no member of the set gets an own profile() afterwards.
    const assigned = defineOAuthProvider((context) => Object.assign(oidc({ issuer: 'https://idp.example.com' })(context), { profile: async () => ({ sub: '42' }) }));
    const app = await appWith({}, [providerBringing('Assigned', { assigned })]);
    expect(thrown(() => fakeOAuth(app))).toBeInstanceOf(TypeError);
  });

  it('hands out copies of the authorizations', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('github', { id: '1' });
    fake.callbackUrl(await open(oauthOf(app), 'github'));
    fake.authorizations[0]!.set('tampered', 'yes');
    expect(fake.authorizations[0]!.has('tampered')).toBe(false);
    expect(fake.authorizations[0]!.has('state')).toBe(true);
  });

  it('keeps what a plain provider asks of the flow: no PKCE, a nonce, its scope separator and its own parameters', async () => {
    const shaped = defineOAuthProvider(definition({ pkce: false, nonce: true, scopeSeparator: ',', scopes: ['a', 'b'], authorizeParams: { access_type: 'offline' } }));
    const app = await appWith({}, [providerBringing('Shaped', { shaped })]);
    const fake = fakeOAuth(app).user('shaped', { id: '9' });
    const oauth = oauthOf(app);
    const authorization = await open(oauth, 'shaped');
    expect(authorization.searchParams.has('code_challenge')).toBe(false);
    expect(authorization.searchParams.has('nonce')).toBe(true);
    expect(authorization.searchParams.get('scope')).toBe('a,b');
    expect(authorization.searchParams.get('access_type')).toBe('offline');
    const result = await oauth.callback('shaped', queryOf(fake.callbackUrl(authorization)));
    expect(result.ok && result.value.user.id).toBe('9');
    // The answer names the scopes with spaces, as every provider but GitHub does: the separator of the request is not the one of the answer.
    expect(result.ok && result.value.user.tokens.scopes).toEqual(['a', 'b']);
  });

  it('gives a Microsoft-style provider the tenant of its configuration', async () => {
    const tenant = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    expect((await userOf('microsoft', (fake) => fake.user('microsoft', { id: '42' }), { OAUTH_MICROSOFT_TENANT: tenant })).id).toBe(`${tenant.toLowerCase()}|42`);
    expect((await userOf('microsoft', (fake) => fake.user('microsoft', { id: '42' }), { OAUTH_MICROSOFT_TENANT: 'consumers' })).id).toBe('9188040d-6c67-4c5b-b112-36a304b66dad|42');
  });

  it('ignores the claims the checks own, and a claim of the test passes on', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('google', { id: '1', claims: { nbf: 9_999_999_999, azp: 'other', aud: 'other', iss: 'https://evil.example', locale: 'de' } });
    const oauth = oauthOf(app);
    const result = await oauth.callback('google', queryOf(fake.callbackUrl(await open(oauth, 'google'))));
    expect(result.ok && (result.value.user.raw as Record<string, unknown>).locale).toBe('de');
  });

  it('refuses a fake over a client that is not the one of the app, and leaves the registry as it was', async () => {
    const app = await appWith({}, [], { http: 'real' });
    const before = app.container.make(OAuthProviders);
    const error = thrown(() => fakeOAuth(app));
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/HttpClientFake|HttpClient/);
    expect(app.container.make(OAuthProviders)).toBe(before);
    // A fake client that is not the one the app sends with would never be reached by the flow.
    const stranger = await appWith();
    const other = thrown(() => fakeOAuth({ container: stranger.container, http: new HttpClientFake() }));
    expect(other).toBeInstanceOf(TypeError);
    expect((other as Error).message).toMatch(/HttpClient of the app/);
  });

  it('refuses a profile without an id, claims for a plain provider and an option that does not exist', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app);
    for (const id of ['', 5, undefined, null]) expect(() => fake.user('github', { id } as never), String(id)).toThrow(/non-empty string/);
    expect(() => fake.user('github', { id: '1', claims: { hd: 'example.org' } })).toThrow(/no oidc\(\) provider/);
    expect(() => fakeOAuth(app, { onlyy: ['github'] } as never)).toThrow(/does not take "onlyy"/);
    expect(() => fakeOAuth(app, { only: 'github' } as never)).toThrow(/list of provider names/);
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5' as never]) expect(() => fake.staleAuthentication('microsoft', seconds), String(seconds)).toThrow(/finite number of 0 or more/);
  });

  it('refuses a second callbackUrl() for one user(), and one after deny()', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('github', { id: '1' });
    const oauth = oauthOf(app);
    const authorization = await open(oauth, 'github');
    fake.callbackUrl(authorization);
    expect(() => fake.callbackUrl(authorization)).toThrow(/no profile is queued/);
    fake.deny('github');
    fake.callbackUrl(authorization);
    expect(() => fake.callbackUrl(authorization)).toThrow(/no profile is queued/);
  });

  it('names what is wrong with an address callbackUrl() cannot use', async () => {
    const app = await appWith();
    const fake = fakeOAuth(app).user('github', { id: '1' });
    expect(() => fake.callbackUrl(new Response(null))).toThrow(/no Location header/);
    expect(() => fake.callbackUrl('/github/authorize?state=a&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb')).toThrow(/starts with/);
    expect(() => fake.callbackUrl('/auth/github?state=a')).toThrow(/"\/auth\/github\?state=a"/);
    expect(() => fake.callbackUrl('https://evil.example/github/authorize?state=a&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb')).toThrow(/evil\.example/);
    expect(() => fake.callbackUrl('https://oauth.fake.invalid/nowhere/authorize?state=a&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb')).toThrow(/starts with/);
    expect(() => fake.callbackUrl('https://oauth.fake.invalid/github/authorize?redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb')).toThrow(/no state/);
    expect(() => fake.callbackUrl('https://oauth.fake.invalid/github/authorize?state=a')).toThrow(/no state or no redirect_uri/);
  });

  it('builds with the credentials the environment gives: a redirect address, scopes, and an issuer where one is required', async () => {
    const keycloak: ServiceProviderClass = class Keycloak {
      static config = [oauthCredentials('keycloak', { issuer: 'required' })];
      static oauthProviders = { keycloak: oidc({ label: 'Keycloak' }) };
    };
    const app = await appWith({ OAUTH_GITHUB_REDIRECT_URL: 'https://app.example.com/back?x=1', OAUTH_GITHUB_SCOPES: 'read:user,repo' }, [keycloak]);
    const fake = fakeOAuth(app).user('github', { id: '1' }).user('keycloak', { id: 'k-1', email: 'ada@example.com' });
    const oauth = oauthOf(app);
    const authorization = await open(oauth, 'github');
    expect(authorization.searchParams.get('redirect_uri')).toBe('https://app.example.com/back?x=1');
    expect(authorization.searchParams.get('scope')).toBe('read:user repo');
    const url = fake.callbackUrl(authorization);
    expect(url.startsWith('/back?x=1&state=')).toBe(true);
    expect((await oauth.callback('github', queryOf(url))).ok).toBe(true);
    const through = await oauth.callback('keycloak', queryOf(fake.callbackUrl(await open(oauth, 'keycloak'))));
    expect(through.ok && through.value.user.id).toContain('k-1');
  });

  describe('the token and userinfo endpoints', () => {
    const TOKEN = 'https://oauth.fake.invalid/github/token';
    /** An authorization the app opened, and a function that trades a code for it with the given form. */
    async function granted(change: (authorization: URL) => void = () => undefined) {
      const app = await appWith();
      const fake = fakeOAuth(app);
      const oauth = oauthOf(app);
      const authorization = await open(oauth, 'github');
      change(authorization);
      const code = (): string => queryOf(fake.user('github', { id: '42' }).callbackUrl(authorization)).get('code')!;
      const form = (authorization: URL, extra: Record<string, string> = {}, code_ = code()): URLSearchParams =>
        new URLSearchParams({
          grant_type: 'authorization_code',
          code: code_,
          client_id: authorization.searchParams.get('client_id')!,
          client_secret: 'fake-secret',
          redirect_uri: authorization.searchParams.get('redirect_uri')!,
          code_verifier: 'whatever',
          ...extra,
        });
      const post = (body: URLSearchParams, headers: Record<string, string> = {}): Promise<Response> => app.http.fetch(TOKEN, { method: 'POST', body, headers });
      return { app, authorization, code, form, post };
    }

    it('answers with the scopes asked for, separated by commas as GitHub does (another provider answers with spaces, see the shaped provider above)', async () => {
      const github = await granted((url) => url.searchParams.delete('code_challenge'));
      expect(await (await github.post(github.form(github.authorization))).json()).toMatchObject({ scope: 'read:user,user:email' });
    });

    it('trades a code once, also when a check fails, and only for the client secret of the app', async () => {
      const { authorization, code, form, post } = await granted((url) => url.searchParams.delete('code_challenge'));
      expect((await post(form(authorization, { client_secret: 'wrong' }))).status).toBe(401);
      const spent = code();
      expect((await post(form(authorization, { client_secret: 'wrong' }, spent))).status).toBe(401);
      expect((await post(form(authorization, {}, spent))).status).toBe(400);
      const good = code();
      expect((await post(form(authorization, {}, good))).status).toBe(200);
      expect((await post(form(authorization, {}, good))).status).toBe(400);
    });

    it('holds the request to the client, the redirect address, the provider and the method of the challenge', async () => {
      const bare = await granted((url) => url.searchParams.delete('code_challenge'));
      // The same request that is refused below is good with nothing changed.
      expect((await bare.post(bare.form(bare.authorization))).status).toBe(200);
      expect((await bare.post(bare.form(bare.authorization, { grant_type: 'password' }))).status).toBe(400);
      expect((await bare.post(bare.form(bare.authorization, { client_id: 'other' }))).status).toBe(400);
      expect((await bare.post(bare.form(bare.authorization, { redirect_uri: 'https://app.example.com/elsewhere' }))).status).toBe(400);
      // A code of one provider is no code of another.
      expect((await bare.app.http.fetch('https://oauth.fake.invalid/discord/token', { method: 'POST', body: bare.form(bare.authorization) })).status).toBe(400);
      // Only S256 is accepted: the verifier hashes to the challenge, but the authorization named another method.
      const plain = await granted((url) => {
        url.searchParams.set('code_challenge_method', 'plain');
        url.searchParams.set('code_challenge', createHash('sha256').update('the-verifier').digest('base64url'));
      });
      expect((await plain.post(plain.form(plain.authorization, { code_verifier: 'the-verifier' }))).status).toBe(400);
      const s256 = await granted((url) => url.searchParams.set('code_challenge', createHash('sha256').update('the-verifier').digest('base64url')));
      expect((await s256.post(s256.form(s256.authorization, { code_verifier: 'the-verifier' }))).status).toBe(200);
      expect((await s256.post(s256.form(s256.authorization, { code_verifier: 'another' }))).status).toBe(400);
    });

    it('takes the secret in a Basic header, and refuses a wrong one', async () => {
      const { authorization, form, post } = await granted((url) => url.searchParams.delete('code_challenge'));
      const basic = (secret: string) => ({ authorization: `Basic ${Buffer.from(`fake-client:${secret}`).toString('base64')}` });
      const without = (code?: string) => {
        const body = form(authorization, {}, code);
        body.delete('client_secret');
        return body;
      };
      expect((await post(without(), basic('fake-secret'))).status).toBe(200);
      expect((await post(without(), basic('wrong'))).status).toBe(401);
    });

    it('answers the userinfo request for the access token it issued only', async () => {
      const { app, authorization, form, post } = await granted((url) => url.searchParams.delete('code_challenge'));
      const issued = (await (await post(form(authorization))).json()) as { access_token: string };
      const userinfo = (bearer: string) => app.http.fetch('https://oauth.fake.invalid/github/userinfo', { headers: { authorization: `Bearer ${bearer}` } });
      expect(await (await userinfo(issued.access_token)).json()).toMatchObject({ id: '42' });
      const refused = await userinfo('fake-access-nobody');
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({ error: 'invalid_token' });
    });
  });

  it('signs in with a provider that wants its secret in a Basic header', async () => {
    const basic = defineOAuthProvider(definition({ clientAuth: 'client_secret_basic' }));
    const app = await appWith({}, [providerBringing('Basic', { basic })]);
    const fake = fakeOAuth(app).user('basic', { id: '7' });
    const oauth = oauthOf(app);
    const result = await oauth.callback('basic', queryOf(fake.callbackUrl(await open(oauth, 'basic'))));
    expect(result.ok && result.value.user.id).toBe('7');
    const token = app.http.requests.find((request) => request.url.endsWith('/basic/token'))!;
    expect(token.headers.get('authorization')).toMatch(/^Basic /);
  });
});


describe('fakeOAuth() in an app with routes', () => {
  class StartController extends Controller {
    readonly #oauth: OAuth;
    constructor(oauth: OAuth) {
      super();
      this.#oauth = oauth;
    }
    async handle(ctx: HttpContext<{}, { provider: string }>) {
      const result = await this.#oauth.redirect(ctx.params.provider);
      if (!result.ok) return this.back('/login');
      return this.redirect(result.value.href).status(303);
    }
  }

  class CallbackController extends Controller {
    readonly #oauth: OAuth;
    constructor(oauth: OAuth) {
      super();
      this.#oauth = oauth;
    }
    async handle(ctx: HttpContext<{}, { provider: string }>) {
      const result = await this.#oauth.callback(ctx.params.provider, new URL(ctx.request.url).searchParams);
      if (!result.ok) return { error: result.error.kind };
      return { id: result.value.user.id, email: result.value.user.email, intent: result.value.intent };
    }
  }

  const routes = defineRoutes((Route) => {
    Route.authorize(everyone).post('/auth/:provider/start', StartController);
    Route.authorize(everyone).get('/auth/:provider/callback', CallbackController);
  });

  const boot = (): Promise<TestApp> =>
    createTestApp(
      { root: tempDir('marmeon-oauth-'), discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, FetchServiceProvider, OAuthServiceProvider], modules: [defineModule({ name: 'social', routes })] },
      { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', APP_URL: 'https://app.example.com', LOG_LEVEL: 'silent' } },
    );

  it('signs a person in through a browser that keeps its cookies, from the start route to the callback route', async () => {
    const app = await boot();
    const fake = fakeOAuth(app).user('github', { id: '42', email: 'ada@example.com', emailVerified: true });
    const browser = app.keepingCookies();
    const start = await browser.post('/auth/github/start').assertStatus(303);
    await browser.get(fake.callbackUrl(start)).assertJson({ id: '42', email: 'ada@example.com', intent: 'sign-in' });
    // Another browser has no flow: the state belongs to the session that started it.
    fake.user('github', { id: '42' });
    const other = app.keepingCookies();
    const started = await browser.post('/auth/github/start');
    await other.get(fake.callbackUrl(started)).assertJson({ error: 'no-flow' });
  });
});
