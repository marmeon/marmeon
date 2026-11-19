import { createHash, randomBytes } from 'node:crypto';
import { Clock } from '@marmeon/core';
import { abort, Controller, defineRequest, ValidationError, type ContextOf, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { LocalOidc, type AuthorizeParams } from '../LocalOidc.ts';
import { LocalOidcCodes, sameText } from '../LocalOidcCodes.ts';

// The local OpenID Connect provider of the development setup. Every route is behind `LocalOidcHost` (development, and only the app's own host) and
// asks `LocalOidc.provider()`: the two form and token requests in their `authorize`, before the body is read; the authorize page reads its query
// first and then asks.

/** The session key of the person who answered at the provider: what a sign-in without `prompt=login` reuses. */
const IDENTITY = 'lab.local-oidc.identity';

interface Identity {
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  /** Seconds since the epoch: when the person answered. */
  readonly authTime: number;
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * What the token endpoint is sent, and the authorization form: any value passes the schema, and `textOf()` decides in the controller. A schema that
 * fails would be answered by the error handler with a redirect back into a session, which the stateless `api` group of the token endpoint has not
 * (an answer of 500), and an OAuth client wants its own JSON in any case.
 */
const text = r.value<unknown>(() => undefined).optional();
/** The longest value of a protocol field: a longer one, or one that is not text, is as good as none. */
const MAX_TEXT = 2048;
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined);
const protocolFields = { client_id: text, redirect_uri: text, response_type: text, code_challenge: text, code_challenge_method: text, nonce: text, state: text, prompt: text };

/** `authorize` of the provider's routes: a 404 before the body is looked at. */
class LocalOidcGate {
  readonly #oidc: LocalOidc;

  constructor(oidc: LocalOidc) {
    this.#oidc = oidc;
  }

  open(): boolean {
    this.#oidc.provider();
    return true;
  }
}

const paramsOf = (get: (name: keyof AuthorizeParams) => unknown): AuthorizeParams => ({
  client_id: textOf(get('client_id')) ?? '',
  redirect_uri: textOf(get('redirect_uri')) ?? '',
  response_type: textOf(get('response_type')) ?? '',
  code_challenge: textOf(get('code_challenge')) ?? '',
  code_challenge_method: textOf(get('code_challenge_method')) ?? '',
  nonce: textOf(get('nonce')) ?? '',
  state: textOf(get('state')) ?? '',
  prompt: textOf(get('prompt')) ?? '',
});

/** The discovery document. The issuer is the configured one, character for character; the token endpoint lives in the stateless `api` group. */
export class ShowLocalOidcConfigurationController extends Controller {
  readonly #oidc: LocalOidc;

  constructor(oidc: LocalOidc) {
    super();
    this.#oidc = oidc;
  }

  handle() {
    const provider = this.#oidc.provider();
    const base = this.#oidc.base();
    return this.json({
      issuer: provider.credentials.issuer,
      authorization_endpoint: `${base}/_dev/oidc/authorize`,
      token_endpoint: `${base}/api/_dev/oidc/token`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    });
  }
}

/** The shared part of the two authorization controllers: where a code or a refusal goes back to, and the code itself. */
abstract class LocalOidcAuthorizeController extends Controller {
  protected readonly oidc: LocalOidc;
  protected readonly codes: LocalOidcCodes;
  protected readonly clock: Clock;
  protected readonly session: Session;

  constructor(oidc: LocalOidc, codes: LocalOidcCodes, clock: Clock, session: Session) {
    super();
    this.oidc = oidc;
    this.codes = codes;
    this.clock = clock;
    this.session = session;
  }

  /** The provider, and the parameters when they are the ones this app sends: otherwise a 400 that says which rule failed. */
  protected checked(params: AuthorizeParams) {
    const provider = this.oidc.provider();
    const refusal = this.oidc.refusal(params, provider);
    if (refusal !== undefined) abort(400, refusal);
    return provider;
  }

  /** Sends the browser back to the callback with a fresh code for `identity`. */
  protected grant(params: AuthorizeParams, identity: Identity, issuer: string) {
    const code = this.codes.issue({
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      challenge: params.code_challenge,
      nonce: params.nonce,
      name: identity.name,
      email: identity.email,
      emailVerified: identity.emailVerified,
      authTime: identity.authTime,
    });
    const back = new URL(params.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', params.state);
    back.searchParams.set('iss', issuer);
    return this.redirect(back.href);
  }
}

/**
 * The page where the person answers as whoever they like. A person who answered before is not asked again, unless the request says
 * `prompt=login`: then the page always comes, and the answer is dated to the moment it is sent.
 */
export class ShowLocalOidcAuthorizeController extends LocalOidcAuthorizeController {
  handle(ctx: HttpContext) {
    const query = new URL(ctx.request.url).searchParams;
    const params = paramsOf((name) => query.get(name) ?? undefined);
    const provider = this.checked(params);
    const before = this.session.get(IDENTITY) as Identity | undefined;
    if (before !== undefined && params.prompt !== 'login') return this.grant(params, before, provider.credentials.issuer);
    return this.view('lab/LocalOidcAuthorize', { params });
  }
}

export const LocalOidcAnswerRequest = defineRequest({
  // The person's fields are checked by `handle()` for an approval only: a cancellation carries none.
  schema: r.object({
    ...protocolFields,
    decision: r.in(['approve', 'deny']),
    name: r.string().trim().max(100).optional(),
    email: r.string().trim().lowercase().email().max(255).optional(),
    verified: r.in(['true', 'false']).optional(),
  }),
  authorize: (_ctx, resolve) => resolve(LocalOidcGate).open(),
});

/** The answer of the person: the same checks as the page, since a hidden field is only a field. */
export class StoreLocalOidcAuthorizeController extends LocalOidcAuthorizeController {
  static request = LocalOidcAnswerRequest;

  handle(ctx: ContextOf<typeof LocalOidcAnswerRequest>) {
    const params = paramsOf((name) => ctx.body[name]);
    const provider = this.checked(params);
    if (ctx.body.decision === 'deny') {
      const back = new URL(params.redirect_uri);
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('state', params.state);
      back.searchParams.set('iss', provider.credentials.issuer);
      return this.redirect(back.href);
    }
    // An approval needs a name and an address: the page shows what is missing.
    const missing = { ...(ctx.body.name ? {} : { name: ['Give a name.'] }), ...(ctx.body.email ? {} : { email: ['Give an e-mail address.'] }) };
    if (Object.keys(missing).length > 0) throw new ValidationError(missing, ctx.body);
    // The moment of the answer, not of an earlier one: `auth_time` is what a confirmation checks.
    const identity: Identity = { name: ctx.body.name!, email: ctx.body.email!, emailVerified: ctx.body.verified === 'true', authTime: Math.floor(this.clock.now() / 1000) };
    this.session.put(IDENTITY, identity);
    return this.grant(params, identity, provider.credentials.issuer);
  }
}

export const LocalOidcTokenRequest = defineRequest({
  schema: r.object({
    ...protocolFields,
    grant_type: text,
    code: text,
    code_verifier: text,
    client_secret: text,
  }),
  authorize: (_ctx, resolve) => resolve(LocalOidcGate).open(),
});

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' };

/**
 * The token endpoint: trades a code once for the ID token. The client proves itself with its secret, the code is spent before it is looked at,
 * and the verifier must be the one whose hash the authorization request carried. The ID token is unsigned: the package takes it only from this
 * response (docs/oauth.md#openid-connect-providers).
 */
export class LocalOidcTokenController extends Controller {
  static request = LocalOidcTokenRequest;
  readonly #oidc: LocalOidc;
  readonly #codes: LocalOidcCodes;
  readonly #clock: Clock;

  constructor(oidc: LocalOidc, codes: LocalOidcCodes, clock: Clock) {
    super();
    this.#oidc = oidc;
    this.#codes = codes;
    this.#clock = clock;
  }

  handle(ctx: ContextOf<typeof LocalOidcTokenRequest>) {
    const provider = this.#oidc.provider();
    const raw = ctx.body;
    // A field that is not text, or too long, is a request that is not one: the same answer for every field, whatever the schema says.
    if (Object.values(raw).some((value) => value !== undefined && textOf(value) === undefined)) return this.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE });
    const body = raw as { readonly [K in keyof typeof raw]: string | undefined };
    const fail = (error: string, status: number) => this.json({ error }, { status, headers: NO_STORE });
    if (body.grant_type !== 'authorization_code') return fail('unsupported_grant_type', 400);
    // The secret first, in constant time: nothing about a code is told to a caller that is not this app.
    if (body.client_id !== provider.credentials.clientId || !sameText(body.client_secret ?? '', provider.credentials.clientSecret)) return fail('invalid_client', 401);
    // Spent before the grant is looked at: a wrong verifier or address burns the code too.
    const grant = this.#codes.spend(body.code ?? '');
    if (grant === undefined) return fail('invalid_grant', 400);
    // The client id was compared with the configured one above, and the code was issued for that client alone: only the address is left.
    if (grant.redirectUri !== body.redirect_uri) return fail('invalid_grant', 400);
    const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url');
    if (!sameText(challenge, grant.challenge)) return fail('invalid_grant', 400);

    const now = Math.floor(this.#clock.now() / 1000);
    const claims = {
      iss: provider.credentials.issuer,
      aud: grant.clientId,
      // The same address is the same person every time, so signing in again finds the account.
      sub: createHash('sha256').update(grant.email).digest('hex'),
      email: grant.email,
      email_verified: grant.emailVerified,
      name: grant.name,
      nonce: grant.nonce,
      iat: now,
      exp: now + 300,
      auth_time: grant.authTime,
    };
    return this.json(
      {
        access_token: randomBytes(32).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`,
      },
      { headers: NO_STORE },
    );
  }
}
