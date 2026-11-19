import { createHash, randomBytes } from 'node:crypto';
import { Clock, type Container } from '@marmeon/core';
import { HttpClient } from '@marmeon/fetch';
import { HttpClientFake } from '@marmeon/fetch/testing';
import type { OAuthCredentials } from './credentials.ts';
import type { OAuthProviderDefinition, SocialProfile } from './definition.ts';
import { ACCEPTED_ISSUERS, COMMA_SCOPES, type CommaScopesDefinition, isBuiltByOidc, NO_CONFIRM, type OidcDefinition } from './oidc-marker.ts';
import { oidcWith, type OidcOptions } from './oidc.ts';
import { credentialsFor, OAuthProviders, registeredProviders, resolveProvider, type ResolvedOAuthProvider } from './registry.ts';

/** A person the fake provider vouches for: the `id` is required, whatever else you leave out is empty (`email: null`, `emailVerified: false`, …). See docs/oauth.md#testing. */
export interface FakeSocialProfile extends Partial<SocialProfile> {
  /** The account's id, a non-empty string. For an `oidc()` provider it is the `sub` of the ID token. */
  readonly id: string;
  /** More claims for the ID token of an `oidc()` provider, such as `hd` for Google. A claim the checks own (`iss`, `sub`, `aud`, `iat`, `exp`, `nonce`, `auth_time`) is ignored. */
  readonly claims?: Readonly<Record<string, unknown>>;
}

/** What `fakeOAuth()` takes besides the app. */
export interface FakeOAuthOptions {
  /** The providers to make active; every other one stays inactive. Default: every registered provider. */
  readonly only?: readonly string[];
}

const HOST = 'https://oauth.fake.invalid';
const CLIENT_ID = 'fake-client';
const CLIENT_SECRET = 'fake-secret';
/** The claims the checks of an ID token own: a test cannot set them through `claims`. */
const OWNED = new Set(['iss', 'sub', 'aud', 'iat', 'exp', 'nonce', 'auth_time', 'azp', 'nbf']);
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
const FIXED_TENANT = '11111111-2222-3333-4444-555555555555';
const random = (): string => randomBytes(18).toString('base64url');
const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** What the next callback of a provider is told to do. */
interface Pending {
  profile?: FakeSocialProfile;
  /** How long before the callback the person signed in, in seconds; `undefined` leaves `auth_time` out. */
  authAgo?: number;
  denied?: boolean;
}

/** What a code stands for: the authorization it answers and the person it will vouch for. */
interface Grant {
  readonly name: string;
  readonly authorization: URLSearchParams;
  readonly profile: FakeSocialProfile;
  /** Seconds since the epoch, or `undefined` for no `auth_time`. */
  readonly authTime: number | undefined;
}

/** @internal What the fake knows of a provider it made active. */
export interface FakeProviderKind {
  /** Whether the provider is an `oidc()` provider (by identity), so its tokens are ID tokens. */
  readonly oidc: boolean;
  /** Whether it can prove a fresh sign-in: an `oidc()` provider that is not marked as unable to. */
  readonly confirms: boolean;
  /** Claims every ID token carries unless the test says otherwise (the tenant a provider's mapping needs). */
  readonly claims: Readonly<Record<string, unknown>>;
  readonly resolved: ResolvedOAuthProvider;
}

/** The profile as a provider's userinfo answer says it. */
const userinfoOf = (profile: FakeSocialProfile): Record<string, unknown> => ({
  id: profile.id,
  email: profile.email ?? null,
  email_verified: profile.emailVerified === true,
  name: profile.name ?? null,
  nickname: profile.nickname ?? null,
  avatar: profile.avatar ?? null,
});

const profileOf = (raw: unknown): SocialProfile => {
  const answer = raw as Record<string, unknown>;
  return {
    id: typeof answer.id === 'string' ? answer.id : '',
    email: typeof answer.email === 'string' ? answer.email : null,
    emailVerified: answer.email_verified === true,
    name: typeof answer.name === 'string' ? answer.name : null,
    nickname: typeof answer.nickname === 'string' ? answer.nickname : null,
    avatar: typeof answer.avatar === 'string' ? answer.avatar : null,
  };
};

/** Fixed answers of the fake token endpoint: a refusal carries a code and nothing else, as a provider's does. */
const refused = (error: string, status = 400): Response => Response.json({ error }, { status });

/**
 * Stands in for the social login providers of an app in its tests: every provider goes through the real flow (state, PKCE, nonce,
 * the ID token checks, the confirmation with `account` and `auth_time`), and the provider's side is answered by `app.http`, so nothing
 * leaves the process. Make it with `fakeOAuth()`. See docs/oauth.md#testing and docs/fakes.md#social-login.
 */
export class OAuthFake {
  readonly #now: () => number;
  readonly #kinds: ReadonlyMap<string, FakeProviderKind>;
  readonly #pending = new Map<string, Pending>();
  readonly #grants = new Map<string, Grant>();
  readonly #tokens = new Map<string, FakeSocialProfile>();
  readonly #authorizations: URLSearchParams[] = [];

  /** @internal Made by {@link fakeOAuth}. */
  constructor(kinds: ReadonlyMap<string, FakeProviderKind>, now: () => number, http: HttpClientFake) {
    this.#kinds = kinds;
    this.#now = now;
    for (const [name, kind] of kinds) {
      const base = `${HOST}/${name}`;
      http.respond(new RegExp(`^${base.replaceAll('.', '\\.')}/(token|userinfo)$`), async (request) => {
        if (request.url === `${base}/userinfo`) return this.#userinfo(request);
        return this.#token(name, kind, request);
      });
      if (kind.oidc) {
        http.respond(`${base}/.well-known/openid-configuration`, () =>
          Response.json({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, userinfo_endpoint: `${base}/userinfo` }),
        );
      }
    }
  }

  /**
   * Makes the next callback of `name` vouch for `profile`, and starts a new preparation: what `reauthenticated()` or `staleAuthentication()`
   * set after an earlier `user()` and was not used is dropped. Call it first: it throws a `TypeError` when a preparation without a profile is
   * already waiting for `name`, for a `name` that is not active, an `id` that is not a non-empty string, or `claims` for a provider that is no
   * `oidc()` provider. For an `oidc()` provider the provider's own mapping decides what the profile says, so `emailVerified: true` counts only
   * where the provider would vouch for the address. For a plain OAuth 2.0 provider neither its `profile()` nor its `mapUser()` runs and `emailVerified`
   * is what the test says, so an own provider that never vouches does vouch in a test.
   */
  user(name: string, profile: FakeSocialProfile): this {
    const kind = this.#kind(name);
    if (typeof profile !== 'object' || profile === null || typeof profile.id !== 'string' || profile.id === '') {
      throw new TypeError(`fakeOAuth(): the id of the profile for "${name}" must be a non-empty string.`);
    }
    if (profile.claims !== undefined && !kind.oidc) throw new TypeError(`fakeOAuth(): "${name}" is no oidc() provider, so it has no ID token to add claims to.`);
    const waiting = this.#pending.get(name);
    if (waiting !== undefined && waiting.profile === undefined) {
      throw new TypeError(`fakeOAuth(): a preparation for "${name}" is waiting without a profile (reauthenticated(), staleAuthentication() or deny() came first). Call user('${name}', …) first, then the others.`);
    }
    this.#pending.set(name, { profile });
    return this;
  }

  /** Makes the next callback of `name` carry an `auth_time` of now, as a provider's does after the person signed in again. Throws a `TypeError` for a provider that cannot confirm anybody, as in production. */
  reauthenticated(name: string): this {
    return this.staleAuthentication(name, 0);
  }

  /** Makes the next callback of `name` carry an `auth_time` `secondsAgo` before now: a negative test for a confirmation that is too old. Throws a `TypeError` for a provider that cannot confirm anybody, as in production, and for a number that is not finite or is negative. */
  staleAuthentication(name: string, secondsAgo: number): this {
    if (typeof secondsAgo !== 'number' || !Number.isFinite(secondsAgo) || secondsAgo < 0) throw new TypeError('staleAuthentication() takes the seconds ago as a finite number of 0 or more.');
    const kind = this.#kind(name);
    if (!kind.confirms) throw new TypeError(`The provider "${name}" cannot confirm anybody, as in production: only an oidc() provider whose ID token can carry auth_time confirms.`);
    this.#next(name).authAgo = secondsAgo;
    return this;
  }

  /** Makes the next callback of `name` the answer of a person who said no (`error=access_denied`). Throws a `TypeError` for a `name` that is not active. */
  deny(name: string): this {
    this.#next(name).denied = true;
    return this;
  }

  /**
   * The address the provider sends the browser back to for the authorization `redirect` opened: the path and query of its `redirect_uri` with
   * the `state` of the authorization and a `code` the fake token endpoint will trade (or `error=access_denied` after `deny()`). Takes the
   * `Location` of the response of `redirect()` (a response, or any object with `headers`), or the address as a `URL` or text. `options.state`
   * replaces the state, so a test can send what a forged callback would. The preparation of `user()` is used up by the call. Throws a `TypeError`
   * for an address that is no authorization page of the fake (the message names it), and when no profile is queued and the provider was not denied.
   */
  callbackUrl(redirect: Response | { readonly headers: Headers } | URL | string, options: { readonly state?: string } = {}): string {
    const location = typeof redirect === 'string' ? redirect : redirect instanceof URL ? redirect.href : redirect.headers.get('location');
    if (location === null) throw new TypeError('callbackUrl() needs the address of the authorization page: the response has no Location header.');
    // Parsed against a base that is not the provider's, so a relative address (the app's own) fails the check of the origin below.
    const authorization = new URL(location, 'https://app.fake.invalid');
    const name = authorization.origin === HOST ? authorization.pathname.split('/')[1] : undefined;
    if (name === undefined || !this.#kinds.has(name)) {
      throw new TypeError(`callbackUrl() takes an authorization address of fakeOAuth(), which starts with ${HOST}/<name>/; this is "${location}".`);
    }
    const params = authorization.searchParams;
    const state = params.get('state');
    const redirectUri = params.get('redirect_uri');
    if (state === null || redirectUri === null) throw new TypeError(`callbackUrl(): the authorization address "${location}" has no state or no redirect_uri.`);
    const pending = this.#pending.get(name) ?? {};
    if (pending.denied !== true && pending.profile === undefined) {
      throw new TypeError(`fakeOAuth(): no profile is queued for "${name}". Call user('${name}', { id: '…' }) before callbackUrl().`);
    }
    this.#pending.delete(name);
    this.#authorizations.push(new URLSearchParams(params));
    // Built on the address the flow sent, so a query of an own callback address stays.
    const back = new URL(redirectUri);
    back.searchParams.set('state', options.state ?? state);
    if (pending.denied === true) {
      back.searchParams.set('error', 'access_denied');
    } else {
      const code = `fake-${random()}`;
      const authTime = pending.authAgo === undefined ? undefined : Math.floor((this.#now() - pending.authAgo * 1000) / 1000);
      this.#grants.set(code, { name, authorization: new URLSearchParams(params), profile: pending.profile!, authTime });
      back.searchParams.set('code', code);
    }
    return `${back.pathname}${back.search}`;
  }

  /** The authorization requests `callbackUrl()` was given, in order: what the app sent the browser to the provider with. */
  get authorizations(): readonly URLSearchParams[] {
    return this.#authorizations.map((params) => new URLSearchParams(params));
  }

  #kind(name: string): FakeProviderKind {
    const kind = this.#kinds.get(name);
    if (kind === undefined) throw new TypeError(`fakeOAuth() made no provider "${name}" active. The active ones: ${[...this.#kinds.keys()].join(', ') || 'none'}.`);
    return kind;
  }

  #next(name: string): Pending {
    this.#kind(name);
    let pending = this.#pending.get(name);
    if (pending === undefined) this.#pending.set(name, (pending = {}));
    return pending;
  }

  async #userinfo(request: Request): Promise<Response> {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const profile = bearer === undefined ? undefined : this.#tokens.get(bearer);
    return profile === undefined ? refused('invalid_token', 401) : Response.json(userinfoOf(profile));
  }

  /** The token endpoint: it holds the request to what the authorization asked, as a provider does (client, secret, redirect address, PKCE), and trades a code once. */
  async #token(name: string, kind: FakeProviderKind, request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const code = form.get('code') ?? '';
    const grant = this.#grants.get(code);
    // A code works once, also when a check below fails.
    this.#grants.delete(code);
    if (form.get('grant_type') !== 'authorization_code' || grant === undefined || grant.name !== name) return refused('invalid_grant');
    const { authorization } = grant;
    const basic = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const secret = basic === undefined ? form.get('client_secret') : new URLSearchParams(`v=${Buffer.from(basic, 'base64').toString().split(':').slice(1).join(':')}`).get('v');
    if (secret !== kind.resolved.credentials.clientSecret) return refused('invalid_client', 401);
    const clientId = authorization.get('client_id');
    if (form.get('client_id') !== clientId || form.get('redirect_uri') !== authorization.get('redirect_uri')) return refused('invalid_grant');
    // The PKCE check of RFC 7636: the verifier of the token request must hash to the challenge of the authorization (S256).
    const challenge = authorization.get('code_challenge');
    if (challenge !== null) {
      const verifier = form.get('code_verifier');
      if (authorization.get('code_challenge_method') !== 'S256' || verifier === null || createHash('sha256').update(verifier).digest('base64url') !== challenge) return refused('invalid_grant');
    }
    const accessToken = `fake-access-${random()}`;
    this.#tokens.set(accessToken, grant.profile);
    const body: Record<string, unknown> = { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: this.#scopeAnswer(kind, authorization.get('scope')) };
    if (kind.oidc) body.id_token = this.#idToken(name, kind, grant, clientId ?? CLIENT_ID);
    return Response.json(body);
  }

  /** The `scope` of the token response: the scopes the authorization asked for, as the provider names them (GitHub with commas, every other provider with spaces). */
  #scopeAnswer(kind: FakeProviderKind, asked: string | null): string {
    const definition = kind.resolved.definition as CommaScopesDefinition;
    const scopes = (asked ?? '').split(definition.scopeSeparator ?? ' ').filter((scope) => scope !== '');
    return scopes.join(definition[COMMA_SCOPES] === true ? ',' : ' ');
  }

  /** An ID token of the form a provider sends: the claims of the checks, the `nonce` of the authorization, and `auth_time` only when the test asked for it. The signature is empty: the package does not check it (docs/oauth.md#openid-connect-providers). */
  #idToken(name: string, kind: FakeProviderKind, grant: Grant, clientId: string): string {
    const seconds = Math.floor(this.#now() / 1000);
    const { profile } = grant;
    const own = Object.fromEntries(Object.entries(profile.claims ?? {}).filter(([key]) => !OWNED.has(key)));
    const claims: Record<string, unknown> = {
      ...kind.claims,
      email: profile.email ?? undefined,
      email_verified: profile.email === undefined || profile.email === null ? undefined : profile.emailVerified === true,
      name: profile.name ?? undefined,
      preferred_username: profile.nickname ?? undefined,
      picture: profile.avatar ?? undefined,
      ...own,
      iss: `${HOST}/${name}`,
      sub: profile.id,
      aud: clientId,
      iat: seconds,
      exp: seconds + 300,
      nonce: grant.authorization.get('nonce') ?? undefined,
      auth_time: grant.authTime,
    };
    for (const key of Object.keys(claims)) if (claims[key] === undefined) delete claims[key];
    return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
  }
}

/**
 * The fake's replacement of a provider's definition, made from the real one the start checks accepted. An `oidc()` provider (by object
 * identity, not by the marker a spread copies) becomes an `oidc()` fake that keeps the provider's own `mapUser` over the claims the fake issues, so what
 * the provider would vouch for is what the test gets, and keeps whether it can confirm. Every other provider becomes a plain OAuth 2.0
 * provider that never confirms, whatever its definition carries.
 */
function fakeDefinition(name: string, real: OAuthProviderDefinition, container: Container, credentials: OAuthCredentials): { definition: OAuthProviderDefinition; oidc: boolean; confirms: boolean } {
  const base = `${HOST}/${name}`;
  const marked = real as Partial<OidcDefinition>;
  const own = {
    ...(real.clientAuth === undefined ? {} : { clientAuth: real.clientAuth }),
    ...(real.authorizeParams === undefined ? {} : { authorizeParams: real.authorizeParams }),
  };
  if (isBuiltByOidc(real)) {
    const noConfirmation = marked[NO_CONFIRM] === true;
    // The issuer policy of the real provider holds: the fake's token (its own issuer) is accepted for the claims the real provider lists an issuer for,
    // and for no other. A provider restricted to one tenant refuses another tenant here as it does in production.
    const realIssuers = marked[ACCEPTED_ISSUERS];
    const policy = realIssuers === undefined ? {} : { acceptedIssuers: (claims: Readonly<Record<string, unknown>>) => (realIssuers(claims).length > 0 ? [base] : []) };
    const factory = oidcWith({ issuer: base, label: real.label, scopes: real.scopes, mapUser: (claims: Record<string, unknown>) => real.mapUser(claims), ...own, ...policy } as OidcOptions, noConfirmation ? { noConfirmation: true } : {});
    return { definition: factory({ name, credentials: { ...credentials, issuer: undefined }, container }), oidc: true, confirms: !noConfirmation };
  }
  const definition: OAuthProviderDefinition = {
    label: real.label,
    endpoints: { authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token` },
    scopes: [...real.scopes],
    ...(real.scopeSeparator === undefined ? {} : { scopeSeparator: real.scopeSeparator }),
    ...(real.pkce === undefined ? {} : { pkce: real.pkce }),
    ...(real.nonce === undefined ? {} : { nonce: real.nonce }),
    ...own,
    ...((real as CommaScopesDefinition)[COMMA_SCOPES] === true ? { [COMMA_SCOPES]: true as const } : {}),
    profile: ({ http, tokens }) => http.json(`${base}/userinfo`, { bearer: tokens.accessToken }),
    mapUser: profileOf,
  };
  return { definition, oidc: false, confirms: false };
}

/** The tenant a Microsoft-style provider reads from `OAUTH_<NAME>_TENANT`, as the ID token's `tid`: a tenant ID as it is, `consumers` as its ID, anything else a fixed one. */
function tenantOf(given: string | undefined): string {
  if (given !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(given)) return given.toLowerCase();
  return given === 'consumers' ? CONSUMERS : FIXED_TENANT;
}

const OPTION_KEYS: readonly string[] = ['only'];

/**
 * Replaces the social login providers of the app with ones that answer from `app.http`, so a test signs in through the real
 * `redirect()` and `callback()` with no network. Every registered provider (or the ones in `only`) becomes active with test credentials,
 * goes through the checks of the start (a refusal throws the same `OAuthSetupError` with the code A11), and keeps what it can do in production:
 * an `oidc()` provider is replaced by an OpenID Connect fake with discovery, a nonce and an ID token and keeps its own `mapUser`, any other by a
 * plain OAuth 2.0 one. The app needs `APP_URL` (or a redirect address) and the session, as for a real flow, and `app.http` must be the
 * `HttpClientFake` the app's `HttpClient` is. Call it before the request that reads `OAuth`. Throws a `TypeError` for an option that does
 * not exist, a name in `only` that is not registered, or an `app.http` that is not the app's client (`http: 'real'`); the registry stays as it was then.
 * See docs/oauth.md#testing.
 *
 * ```ts
 * const oauth = fakeOAuth(app).user('github', { id: '42', email: 'ada@example.com', emailVerified: true });
 * const browser = app.keepingCookies();
 * const start = await browser.post('/auth/github/start');
 * const back = await browser.get(oauth.callbackUrl(start));
 * ```
 */
export function fakeOAuth(app: { readonly container: Container; readonly http: HttpClientFake }, options: FakeOAuthOptions = {}): OAuthFake {
  const { container } = app;
  let http: unknown;
  try {
    http = app.http;
  } catch (cause) {
    throw new TypeError('fakeOAuth() needs the HttpClientFake of the test app, and this app has none (createTestApp(…, { http: \'real\' })): the provider side answers from it.', { cause });
  }
  if (!(http instanceof HttpClientFake) || container.make(HttpClient) !== http) {
    throw new TypeError("fakeOAuth() needs app.http to be the HttpClient of the app: the provider side answers from it, and the flow must reach it. Do not turn the fake off with { http: 'real' }.");
  }
  if (typeof options !== 'object' || options === null) throw new TypeError('fakeOAuth() takes an options object: { only }.');
  const unknownKeys = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknownKeys.length > 0) throw new TypeError(`fakeOAuth() does not take ${unknownKeys.map((key) => `"${key}"`).join(', ')}. The options are ${OPTION_KEYS.join(', ')}.`);
  const { only } = options;
  if (only !== undefined && (!Array.isArray(only) || !only.every((name) => typeof name === 'string'))) throw new TypeError('fakeOAuth({ only }) takes a list of provider names.');
  const entries = registeredProviders(container);
  if (only !== undefined) {
    const unknown = only.filter((name) => !entries.some((entry) => entry.name === name));
    if (unknown.length > 0) throw new TypeError(`fakeOAuth({ only }) names providers that are not registered: ${unknown.map((name) => `"${name}"`).join(', ')}. Registered: ${entries.map((entry) => entry.name).join(', ')}.`);
  }
  const kinds = new Map<string, FakeProviderKind>();
  const resolved: ResolvedOAuthProvider[] = [];
  for (const entry of entries) {
    const { name } = entry;
    if (only !== undefined && !only.includes(name)) continue;
    const { config, issuer: issuerRule } = credentialsFor(entry);
    // What the app's own environment gives (a tenant, an issuer, a redirect address, scopes) is kept, so the provider is built as it would be; the two secrets are the fake's.
    const given = container.make(config);
    const needsIssuer = issuerRule === 'required' && (given.issuer === undefined || given.issuer === '');
    // The start's own checks and copy run for the provider, with the app's real http client bound.
    const real = resolveProvider(container, entry, { ...given, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...(needsIssuer ? { issuer: `${HOST}/${name}` } : {}) });
    const { definition, oidc, confirms } = fakeDefinition(name, real.definition, container, real.credentials);
    const provider: ResolvedOAuthProvider = Object.freeze({ name, label: definition.label, definition: Object.freeze(definition), credentials: real.credentials });
    resolved.push(provider);
    const tenant = Object.hasOwn(given.options, 'TENANT') ? { tid: tenantOf(given.options.TENANT) } : {};
    kinds.set(name, { oidc, confirms, claims: oidc ? tenant : {}, resolved: provider });
  }
  container.instance(OAuthProviders, new OAuthProviders(resolved));
  return new OAuthFake(kinds, () => container.make(Clock).now(), http);
}
