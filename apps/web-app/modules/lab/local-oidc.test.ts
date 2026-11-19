import { createHash, randomBytes } from 'node:crypto';
import type { EnvironmentConfig } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { HttpError } from '@marmeon/http';
import { OAuthConfig, OAuthProviders, OAuthSetupError, type OAuthProviderContext, type ResolvedOAuthProvider } from '@marmeon/oauth';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { LocalOidc } from './LocalOidc.ts';
import { LocalOidcCodes } from './LocalOidcCodes.ts';
import { LocalOidcServiceProvider } from './LocalOidcServiceProvider.ts';

// The local OpenID Connect provider of the development setup: `/_dev/oidc` and its token endpoint. Each rule of the provider has a test that
// goes red without it.

const CLIENT_ID = 'local-client';
const CLIENT_SECRET = ['local', 'client', 'secret', 'for', 'tests'].join('-');
const ISSUER = 'http://localhost/_dev/oidc';
const CALLBACK = 'http://localhost/auth/local/callback';
const ENV = { OAUTH_LOCAL_CLIENT_ID: CLIENT_ID, OAUTH_LOCAL_CLIENT_SECRET: CLIENT_SECRET, OAUTH_LOCAL_ISSUER: ISSUER, APP_URL: 'http://localhost' };
const HTML = { accept: 'text/html' };
const REFUSAL = 'The OAuth provider "local" is active, but it is for development and test only: unset OAUTH_LOCAL_CLIENT_ID and OAUTH_LOCAL_CLIENT_SECRET, or start with NODE_ENV=development.';
// What production asks for besides the app's address: a key of its own.
const PRODUCTION = { NODE_ENV: 'production', APP_URL: 'https://app.example.com', APP_KEY: `base64:${Buffer.alloc(32, 7).toString('base64')}` };

let app: TestApp;
const boot = async (env: Record<string, string | undefined> = {}, options: { database?: 'refresh' } = {}) => {
  app = await createTestApp(application, { env: { ...ENV, ...env }, ...options });
  return app;
};
afterEach(() => app?.close());

/** A client's PKCE pair and the request it sends: the one this app's own sign-in would send, with what a test overrides. */
function request(overrides: Record<string, string | undefined> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const params = {
    client_id: CLIENT_ID,
    redirect_uri: CALLBACK,
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    nonce: 'nonce-of-the-flow',
    state: 'state-of-the-flow',
    ...overrides,
  };
  return { verifier, params };
}
const ANSWER = { decision: 'approve', name: 'Ada Lovelace', email: 'ada@example.com', verified: 'true' };
const query = (params: Record<string, string>) => `/_dev/oidc/authorize?${new URLSearchParams(params).toString()}`;
const answer = (browser: TestApp, params: Record<string, string>, extra: Record<string, string> = {}) => browser.post('/_dev/oidc/authorize', { form: { ...params, ...ANSWER, ...extra } });
const locationOf = (response: { headers: Headers }) => new URL(response.headers.get('location')!);
const trade = (code: string, verifier: string, overrides: Record<string, string> = {}, client: TestApp = app) =>
  client.post('/api/_dev/oidc/token', { form: { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: verifier, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...overrides } });
const claimsOf = (idToken: string) => JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;

/** A whole round at the provider: the answer, and the code it sent the browser back with. */
async function codeFor(browser: TestApp, flow = request(), extra: Record<string, string> = {}) {
  const back = await answer(browser, flow.params, extra).assertStatus(303);
  return { code: locationOf(back).searchParams.get('code')!, flow, back };
}

describe('the local provider', { timeout: 30_000 }, () => {
  it('describes itself with the configured issuer and the endpoints of this app', async () => {
    await boot();
    (await app.get('/_dev/oidc/.well-known/openid-configuration').assertOk()).assertJson({
      issuer: ISSUER,
      authorization_endpoint: 'http://localhost/_dev/oidc/authorize',
      token_endpoint: 'http://localhost/api/_dev/oidc/token',
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('shows the page for the request this app sends, and sends a code back to the callback with the state', async () => {
    await boot();
    const flow = request();
    await app.get(query(flow.params), { headers: HTML }).assertOk().assertPage('lab/LocalOidcAuthorize');
    const back = locationOf(await answer(app, flow.params).assertStatus(303));
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    expect(back.searchParams.get('state')).toBe('state-of-the-flow');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    // 32 random bytes, in base64url: 43 characters, and never the same twice.
    expect(back.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(back.searchParams.get('code')).not.toBe(locationOf(await answer(app, request().params).assertStatus(303)).searchParams.get('code'));
  });

  it('sends the person back with access_denied when they cancel', async () => {
    await boot();
    const back = locationOf(await answer(app, request().params, { decision: 'deny' }).assertStatus(303));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('state-of-the-flow');
    expect(back.searchParams.has('code')).toBe(false);
  });

  it('refuses a redirect_uri that is not the derived callback', async () => {
    await boot();
    for (const redirect_uri of [
      'http://localhost/auth/local/callback/',
      'http://localhost/auth/local/callback?next=1',
      'http://localhost/auth/local/callback/extra',
      'http://localhost.example.com/auth/local/callback',
      'http://localhost:3000/auth/local/callback',
      'https://localhost/auth/local/callback',
      'http://localhost/auth/github/callback',
      '',
    ]) {
      const { params } = request({ redirect_uri });
      await app.get(query(params), { headers: HTML }).assertStatus(400);
      await answer(app, params).assertStatus(400);
    }
    // The control: the derived callback itself goes through.
    await app.get(query(request().params), { headers: HTML }).assertOk();
  });

  it('refuses another client, another response type and anything but PKCE with S256, each with its own message', async () => {
    await boot();
    const refusals: [Record<string, string>, string][] = [
      [{ client_id: 'another-client' }, 'The client_id is not the one of this app.'],
      [{ response_type: 'token' }, 'Only response_type=code is supported.'],
      [{ response_type: 'code token' }, 'Only response_type=code is supported.'],
      [{ code_challenge_method: 'plain' }, 'PKCE with code_challenge_method=S256 is required.'],
      [{ code_challenge_method: '' }, 'PKCE with code_challenge_method=S256 is required.'],
      [{ code_challenge: 'short' }, 'PKCE with code_challenge_method=S256 is required.'],
      [{ code_challenge: '' }, 'PKCE with code_challenge_method=S256 is required.'],
      [{ nonce: '' }, 'A nonce is required.'],
      [{ nonce: 'n'.repeat(256) }, 'A nonce is required.'],
      [{ state: '' }, 'A state is required.'],
      [{ state: 's'.repeat(256) }, 'A state is required.'],
    ];
    for (const [overrides, message] of refusals) {
      const { params } = request(overrides);
      await app.expectingJson().get(query(params)).assertStatus(400).assertJson({ message });
      await app.expectingJson().post('/_dev/oidc/authorize', { form: { ...params, ...ANSWER } }).assertStatus(400).assertJson({ message });
    }
    // The controls: the longest nonce and state that are allowed go through.
    await app.get(query(request({ nonce: 'n'.repeat(255), state: 's'.repeat(255) }).params), { headers: HTML }).assertOk();
  });

  it('answers a cancellation without the person\'s fields, and shows what an approval lacks', async () => {
    await boot();
    const flow = request();
    // Cancel is a form of its own: no name, no address, no verdict on the address — and the callback still hears access_denied.
    const cancelled = locationOf(await app.post('/_dev/oidc/authorize', { form: { ...flow.params, decision: 'deny' } }).assertStatus(303));
    expect(`${cancelled.origin}${cancelled.pathname}`).toBe(CALLBACK);
    expect(cancelled.searchParams.get('error')).toBe('access_denied');
    expect(cancelled.searchParams.get('state')).toBe('state-of-the-flow');
    // An approval without a name or an address goes back to the page with the errors, and issues no code.
    const browser = app.keepingCookies();
    const page = `http://localhost${query(flow.params)}`;
    await browser.post('/_dev/oidc/authorize', { headers: { referer: page }, form: { ...flow.params, decision: 'approve', name: '', email: '', verified: 'true' } }).assertRedirect(query(flow.params));
    const shown = await browser.get(query(flow.params), { headers: HTML }).assertOk().assertPage('lab/LocalOidcAuthorize');
    expect(shown.page()!.props.errors).toEqual({ name: ['Give a name.'], email: ['Give an e-mail address.'] });
    // An address that is not one is an error of the form too.
    await browser.post('/_dev/oidc/authorize', { headers: { referer: page }, form: { ...flow.params, decision: 'approve', name: 'Ada', email: 'not-an-address', verified: 'true' } }).assertRedirect(query(flow.params));
    const again = await browser.get(query(flow.params), { headers: HTML }).assertOk();
    expect(Object.keys(again.page()!.props.errors as object)).toEqual(['email']);
  });

  it('trades a code for the ID token the package accepts', async () => {
    await boot();
    app.freeze();
    const { code, flow } = await codeFor(app);
    const answered = await trade(code, flow.verifier).assertOk();
    answered.assertJson({ token_type: 'Bearer', expires_in: 300 });
    answered.assertHeader('cache-control', 'no-store');
    const { id_token: idToken } = answered.json<{ id_token: string }>();
    expect(idToken.split('.')).toHaveLength(3);
    const now = Math.floor(app.travel({}) / 1000);
    expect(claimsOf(idToken)).toEqual({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: createHash('sha256').update('ada@example.com').digest('hex'),
      email: 'ada@example.com',
      email_verified: true,
      name: 'Ada Lovelace',
      nonce: 'nonce-of-the-flow',
      iat: now,
      exp: now + 300,
      auth_time: now,
    });
  });

  it('spends a code once', async () => {
    await boot();
    const { code, flow } = await codeFor(app);
    await trade(code, flow.verifier).assertOk();
    await trade(code, flow.verifier).assertStatus(400).assertExactJson({ error: 'invalid_grant' });
  });

  it('refuses a code after 60 seconds, and trades it up to then', async () => {
    await boot();
    const late = await codeFor(app);
    app.travel({ seconds: 61 });
    await trade(late.code, late.flow.verifier).assertStatus(400).assertExactJson({ error: 'invalid_grant' });
    const inTime = await codeFor(app);
    app.travel({ seconds: 59 });
    await trade(inTime.code, inTime.flow.verifier).assertOk();
  });

  it('refuses a verifier that does not match, and the code is gone after it', async () => {
    await boot();
    const { code, flow } = await codeFor(app);
    await trade(code, randomBytes(32).toString('base64url')).assertStatus(400).assertExactJson({ error: 'invalid_grant' });
    await trade(code, flow.verifier).assertStatus(400).assertExactJson({ error: 'invalid_grant' });
    // No verifier at all is a refusal too.
    const again = await codeFor(app);
    await trade(again.code, '').assertStatus(400).assertExactJson({ error: 'invalid_grant' });
  });

  it('refuses a code traded for another redirect_uri or another client', async () => {
    await boot();
    const first = await codeFor(app);
    await trade(first.code, first.flow.verifier, { redirect_uri: 'http://localhost/auth/other/callback' }).assertStatus(400).assertExactJson({ error: 'invalid_grant' });
    const second = await codeFor(app);
    await trade(second.code, second.flow.verifier, { client_id: 'another-client' }).assertStatus(401).assertExactJson({ error: 'invalid_client' });
  });

  it('refuses a wrong client secret, whatever its length, and keeps the code for the caller who has the right one', async () => {
    await boot();
    const { code, flow } = await codeFor(app);
    for (const client_secret of ['', 'x', CLIENT_SECRET.slice(0, -1), `${CLIENT_SECRET}x`, CLIENT_SECRET.toUpperCase(), 'y'.repeat(CLIENT_SECRET.length), 'z'.repeat(2048)]) {
      await trade(code, flow.verifier, { client_secret }).assertStatus(401).assertExactJson({ error: 'invalid_client' });
    }
    // A caller that is not this app burns nothing: the code is still good for the one that is.
    await trade(code, flow.verifier).assertOk();
  });

  it('answers a token request with a field that is too long or not text with invalid_request, not an error page', async () => {
    await boot();
    const { code, flow } = await codeFor(app);
    const fields = { grant_type: 'authorization_code', code, redirect_uri: CALLBACK, code_verifier: flow.verifier, client_id: CLIENT_ID, client_secret: CLIENT_SECRET };
    // Too long, as a form; not text, as JSON (a form field is always text).
    for (const form of [{ client_secret: 'z'.repeat(5000) }, { code_verifier: 'v'.repeat(2049) }]) {
      await app.post('/api/_dev/oidc/token', { form: { ...fields, ...form } }).assertStatus(400).assertExactJson({ error: 'invalid_request' });
    }
    for (const json of [{ code: [code, code] }, { client_id: 5 }, { client_secret: { a: 1 } }]) {
      await app.post('/api/_dev/oidc/token', { json: { ...fields, ...json } }).assertStatus(400).assertExactJson({ error: 'invalid_request' });
    }
    // The code was not spent by them.
    await trade(code, flow.verifier).assertOk();
  });

  it('refuses a grant type other than authorization_code', async () => {
    await boot();
    const { code, flow } = await codeFor(app);
    await trade(code, flow.verifier, { grant_type: 'client_credentials' }).assertStatus(400).assertExactJson({ error: 'unsupported_grant_type' });
  });

  it('asks again on prompt=login and dates auth_time to the answer', async () => {
    await boot();
    app.freeze();
    const browser = app.keepingCookies();
    const first = await codeFor(browser);
    const answeredAt = Math.floor(app.travel({}) / 1000);
    expect(claimsOf((await trade(first.code, first.flow.verifier).assertOk()).json<{ id_token: string }>().id_token).auth_time).toBe(answeredAt);

    app.travel({ seconds: 120 });
    // Without prompt=login the person who answered before is not asked: the code comes at once, and auth_time stays the time of the old answer.
    const quiet = request();
    const reused = locationOf(await browser.get(query(quiet.params)).assertStatus(302));
    expect(`${reused.origin}${reused.pathname}`).toBe(CALLBACK);
    const old = claimsOf((await trade(reused.searchParams.get('code')!, quiet.verifier).assertOk()).json<{ id_token: string }>().id_token);
    expect(old.auth_time).toBe(answeredAt);

    // With prompt=login the page comes every time, and the new answer is dated to the moment it is sent.
    const asked = request({ prompt: 'login' });
    await browser.get(query(asked.params), { headers: HTML }).assertOk().assertPage('lab/LocalOidcAuthorize');
    const fresh = await codeFor(browser, asked);
    const renewed = claimsOf((await trade(fresh.code, asked.verifier).assertOk()).json<{ id_token: string }>().id_token);
    expect(renewed.auth_time).toBe(answeredAt + 120);
  });

  it('asks a person who has not answered yet, with or without prompt=login', async () => {
    await boot();
    for (const overrides of [{}, { prompt: 'login' }]) {
      await app.keepingCookies().get(query(request(overrides).params), { headers: HTML }).assertOk().assertPage('lab/LocalOidcAuthorize');
    }
  });

  it('answers 404 outside development and test', async () => {
    // The gate itself, with the provider active: it is the node environment that decides, nothing else. (An app does not start in production
    // with the provider active, so the routes cannot be asked there with it.)
    const provider = { name: 'local', label: 'Local', credentials: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUrl: undefined, scopes: undefined, issuer: ISSUER, options: {} } } as unknown as ResolvedOAuthProvider;
    const gate = (node: string) => new LocalOidc({ node } as unknown as EnvironmentConfig, new OAuthProviders([provider]), { appUrl: 'https://app.example.com' } as OAuthConfig);
    for (const node of ['production', 'staging', 'Development', 'TEST', '']) {
      expect(() => gate(node).provider(), node).toThrow(expect.objectContaining({ status: 404 }) as HttpError);
    }
    for (const node of ['development', 'test']) expect(gate(node).provider().name, node).toBe('local');
    // And the routes of a production app, which has no local provider: every one of them is a 404.
    await boot({ ...PRODUCTION, OAUTH_LOCAL_CLIENT_ID: undefined, OAUTH_LOCAL_CLIENT_SECRET: undefined, OAUTH_LOCAL_ISSUER: undefined });
    const flow = request();
    await app.get('/_dev/oidc/.well-known/openid-configuration').assertNotFound();
    await app.get(query(flow.params), { headers: HTML }).assertNotFound();
    await app.request('HEAD', query(flow.params), { headers: HTML }).assertNotFound();
    await trade('code', flow.verifier).assertNotFound();
    // A production app checks the CSRF protection first: the form post is refused without the browser's word (419) and from another site (403);
    // with it, the gate answers.
    await answer(app, flow.params).assertStatus(419);
    await answer(app.withHeaders({ 'sec-fetch-site': 'cross-site' }), flow.params).assertForbidden();
    await answer(app.withHeaders({ 'sec-fetch-site': 'same-origin' }), flow.params).assertNotFound();
  });

  it('answers 403 to a host that is not the app\'s own, on every route, and answers the app\'s own', async () => {
    // DNS rebinding: a page at another name that points at this machine reaches the routes with its own `Host`.
    await boot();
    const flow = request();
    const foreign = app.withHeaders({ host: 'evil.example:3000' });
    const sameOrigin = foreign.withHeaders({ 'sec-fetch-site': 'same-origin' });
    await foreign.get('/_dev/oidc/.well-known/openid-configuration').assertForbidden();
    await foreign.get(query(flow.params), { headers: HTML }).assertForbidden();
    await answer(sameOrigin, flow.params).assertForbidden();
    await trade('code', flow.verifier, {}, foreign).assertForbidden();
    // Nothing was issued: the code map is empty, and the headers of a development route are on the refusal.
    const refused = await foreign.get(query(flow.params), { headers: HTML });
    refused.assertHeader('cache-control', 'no-store').assertHeader('cross-origin-resource-policy', 'same-origin');
    // The app's own names pass: localhost with a port, the loopback addresses, and the host of APP_URL.
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'localhost']) {
      await app.withHeaders({ host }).get('/_dev/oidc/.well-known/openid-configuration').assertOk();
    }
    await app.withHeaders({ host: 'localhost' }).get(query(flow.params), { headers: HTML }).assertOk();
  });

  it('answers 404 when the local provider is not active, in test too', async () => {
    await boot({ OAUTH_LOCAL_CLIENT_ID: undefined, OAUTH_LOCAL_CLIENT_SECRET: undefined, OAUTH_LOCAL_ISSUER: undefined });
    const flow = request();
    await app.get('/_dev/oidc/.well-known/openid-configuration').assertNotFound();
    await app.get(query(flow.params), { headers: HTML }).assertNotFound();
    await answer(app, flow.params).assertNotFound();
    await trade('code', flow.verifier).assertNotFound();
  });

  it('refuses to start when the local provider is active in production', async () => {
    const production = { ...PRODUCTION, OAUTH_LOCAL_ISSUER: 'https://app.example.com/_dev/oidc' };
    const refused = await createTestApp(application, { env: { ...ENV, ...production } }).then(
      async (started) => {
        await started.close();
        return undefined;
      },
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(OAuthSetupError);
    expect((refused as Error).message).toBe(REFUSAL);
    // Without its credentials the provider is not active, and production starts.
    await boot({ ...production, OAUTH_LOCAL_CLIENT_ID: undefined, OAUTH_LOCAL_CLIENT_SECRET: undefined });
    // Without the issuer it is not active either: all three variables make it so.
    await app.close();
    await boot({ ...production, OAUTH_LOCAL_ISSUER: undefined });
    // And with them in development and test, it starts.
    for (const NODE_ENV of ['development', 'test']) {
      await app.close();
      await boot({ NODE_ENV });
    }
  });

  it('refuses to start for every NODE_ENV but development and test, and only for those', () => {
    // The factory is what the start runs for an active provider. An app does not boot with a NODE_ENV other than the three, so it is asked directly.
    const factory = LocalOidcServiceProvider.oauthProviders.local;
    const context = (node: string) => ({ name: 'local', container: { make: () => ({ node }) } }) as unknown as OAuthProviderContext;
    const refusal = (node: string): string | undefined => {
      try {
        factory(context(node));
      } catch (error) {
        return error instanceof OAuthSetupError ? error.message : undefined;
      }
      return undefined;
    };
    for (const node of ['production', 'staging', 'Development', 'TEST', '']) expect(refusal(node), node).toBe(REFUSAL);
    // In development and test it goes on to build the provider, which this stand-in context cannot: anything but the refusal.
    for (const node of ['development', 'test']) expect(refusal(node), node).toBeUndefined();
  });

  it('holds at most 1000 codes: the oldest is dropped when the map is full', async () => {
    await boot();
    const codes = app.make(LocalOidcCodes);
    const grant = { clientId: CLIENT_ID, redirectUri: CALLBACK, challenge: 'c', nonce: 'n', name: 'Ada', email: 'ada@example.com', emailVerified: true, authTime: 1 };
    const first = codes.issue(grant);
    for (let i = 0; i < 1000; i++) codes.issue(grant);
    expect(codes.spend(first)).toBeUndefined();
  });
});

/** Answers what the app's own HttpClient asks of the provider (the discovery document and the token endpoint) from this very app. */
function provide(target: TestApp) {
  target.http.respond(/^http:\/\/localhost\/(_dev\/oidc\/\.well-known\/|api\/_dev\/oidc\/token)/, async (outgoing) => {
    const { pathname } = new URL(outgoing.url);
    const form = outgoing.method === 'POST' ? Object.fromEntries(new URLSearchParams(await outgoing.text())) : undefined;
    const inside = await target.request(outgoing.method, pathname, form === undefined ? {} : { form });
    return new Response(inside.body, { status: inside.status, headers: { 'content-type': inside.headers.get('content-type') ?? 'text/plain' } });
  });
}

const db = () => app.make(Connections).get<any>();
const SESSION_FORM = { headers: HTML };

describe('signing in at the local provider', { timeout: 30_000 }, () => {
  it('signs a new person in, links the account, and signs the same person in again', async () => {
    await boot({}, { database: 'refresh' });
    provide(app);
    const browser = app.keepingCookies();
    const start = await browser.post('/auth/local/redirect').assertStatus(303);
    const authorize = new URL(start.headers.get('location')!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe('http://localhost/_dev/oidc/authorize');
    const page = await browser.get(`${authorize.pathname}${authorize.search}`, SESSION_FORM).assertOk().assertPage('lab/LocalOidcAuthorize');
    expect(page.page()!.props.params).toMatchObject({ client_id: CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code', code_challenge_method: 'S256' });
    const params = Object.fromEntries(authorize.searchParams) as Record<string, string>;
    const back = locationOf(await answer(browser, params).assertStatus(303));
    await browser.get(`${back.pathname}${back.search}`).assertRedirect('/users/me').assertAuthenticated();
    const users = await db().selectFrom('users').select(['email']).execute();
    expect(users).toEqual([{ email: 'ada@example.com' }]);
    expect(await db().selectFrom('social_accounts').select(['provider']).execute()).toEqual([{ provider: 'local' }]);
    expect(await db().selectFrom('users').select('id').where('password', 'is', null).execute()).toHaveLength(1);

    // A second round in a fresh browser: the same address is the same person, so nothing new is made.
    const again = app.keepingCookies();
    const second = new URL((await again.post('/auth/local/redirect').assertStatus(303)).headers.get('location')!);
    const returned = locationOf(await answer(again, Object.fromEntries(second.searchParams) as Record<string, string>).assertStatus(303));
    await again.get(`${returned.pathname}${returned.search}`).assertRedirect('/users/me').assertAuthenticated();
    expect(await db().selectFrom('users').select(['email']).execute()).toEqual([{ email: 'ada@example.com' }]);
    expect(await db().selectFrom('social_accounts').select(['provider']).execute()).toEqual([{ provider: 'local' }]);
  });

  it('confirms with the local provider: it asks again, and the answer opens the window', async () => {
    await boot({}, { database: 'refresh' });
    provide(app);
    await app.factory(UserFactory).create({ email: 'ada@example.com' });
    const browser = app.keepingCookies();
    await browser.post('/login', { form: { email: 'ada@example.com', password: 'password' } }).assertRedirect('/users/me');
    // Link: the person answers at the provider as the account's own address.
    const link = new URL((await browser.post('/oauth/accounts/local').assertStatus(303)).headers.get('location')!);
    const linked = locationOf(await answer(browser, Object.fromEntries(link.searchParams) as Record<string, string>).assertStatus(303));
    await browser.get(`${linked.pathname}${linked.search}`).assertRedirect('/users/me');
    expect(await db().selectFrom('social_accounts').select(['provider']).execute()).toEqual([{ provider: 'local' }]);
    // Confirm, once the window of the password has closed: the provider remembers the answer, but the confirmation asks for prompt=login,
    // and the page comes again.
    app.travel({ minutes: 16 });
    const confirm = new URL((await browser.post('/oauth/confirm/local').assertStatus(303)).headers.get('location')!);
    expect(confirm.searchParams.get('prompt')).toBe('login');
    await browser.get(`${confirm.pathname}${confirm.search}`, SESSION_FORM).assertOk().assertPage('lab/LocalOidcAuthorize');
    const confirmed = locationOf(await answer(browser, Object.fromEntries(confirm.searchParams) as Record<string, string>).assertStatus(303));
    const done = await browser.get(`${confirmed.pathname}${confirmed.search}`).assertRedirect('/users/me');
    done.assertFlashed('toast', { kind: 'success', message: 'Confirmed.' });
  });
});
