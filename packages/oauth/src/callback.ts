import { err, ok, type Logger, type Result } from '@marmeon/core';
import type { Session } from '@marmeon/session';
import { EndpointError } from './endpoints.ts';
import type { OAuthEndpoints, OAuthHttp, SocialUser } from './definition.ts';
import { exchangeCode, failureOf } from './exchange.ts';
import { takeFlow } from './flow.ts';
import { checkedClaimsOf, COMMA_SCOPES, type CommaScopesDefinition, ISSUER_PARAM, NO_CONFIRM, OIDC, type OidcDefinition } from './oidc-marker.ts';
import { same } from './same.ts';
import { OAuthHttpError } from './http.ts';
import type { ResolvedOAuthProvider } from './registry.ts';
import { toSocialUser } from './social-user.ts';
import { markVerified } from './verified.ts';

/** What `callback()` hands back: the person the provider vouched for, and what the flow was started for. See docs/oauth.md#the-callback. */
export interface OAuthCallback {
  readonly user: SocialUser;
  /** The intent the flow was started with, as `redirect()` was given it. */
  readonly intent: string;
}

/**
 * Why `callback()` gave no user. `unknown-provider`: the name is unknown or inactive. `no-flow`: this session holds none (a second
 * callback, another browser, a session that expired). `expired`: the ten minutes are over. `invalid`: the answer does not belong to
 * the flow (a record of another form, the provider, the user, the state, the issuer, the code, or a session that cannot be written). `cancelled`: the person
 * refused. `provider-error`: the provider reported an error code. `unavailable`: the provider could not be reached. `rejected`: the
 * provider refused the code. `invalid-response`: the provider's answer is not usable. `not-reauthenticated`: a confirmation without proof that the person signed in again at the provider. No error
 * holds a body or a message of the provider. See docs/oauth.md#the-callback.
 */
export type OAuthCallbackError =
  | { readonly kind: 'unknown-provider' }
  | { readonly kind: 'no-flow' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'provider-error'; readonly error: string }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rejected' }
  | { readonly kind: 'invalid-response' }
  | { readonly kind: 'not-reauthenticated' };

/** What the callback works with once the provider is known and the session may be written. */
export interface CallbackContext {
  readonly provider: ResolvedOAuthProvider;
  readonly session: Session;
  /** Milliseconds since the epoch. */
  readonly now: number;
  readonly logger: Logger;
  readonly http: OAuthHttp;
  /** Finds the endpoints (once); `undefined` when the provider that finds them cannot be reached. */
  readonly endpoints: () => Promise<OAuthEndpoints | undefined>;
  /** The callback address `redirect()` sent. */
  readonly redirectUri: () => string;
}

const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/i;
const MAX_CODE = 2048;
/** How much earlier than the redirect an `auth_time` may be, and how much later than now, in seconds. */
const REAUTH_EARLY = 10;
const REAUTH_LATE = 60;
const QUIET = new Set(['no-flow', 'expired', 'cancelled']);

/** The value of a parameter that came exactly once, else `undefined`. */
function once(params: URLSearchParams, name: string): string | undefined {
  const all = params.getAll(name);
  return all.length === 1 ? all[0] : undefined;
}

/**
 * Completes a flow: takes it out of the session before anything is checked (so a state works once, even when a check fails), checks
 * the answer in a fixed order, trades the code for tokens, asks the provider who the person is, and marks the result as the
 * outcome of this flow. Nothing logs the code, a token, the state or the query: a failure logs `{ provider, reason }` only.
 */
export async function completeCallback(context: CallbackContext, params: URLSearchParams, userId: string | number | undefined): Promise<Result<OAuthCallback, OAuthCallbackError>> {
  const { provider, session, logger } = context;
  const name = provider.name;
  const refuse = <E extends OAuthCallbackError>(error: E, reason: string): Result<never, E> => {
    // What happens in a normal sign-in (a second tab, a slow person, a person who says no) is not a warning.
    (QUIET.has(reason) ? logger.debug : logger.warn).call(logger, 'An OAuth callback was refused.', { provider: name, reason });
    return err(error);
  };

  const taken = takeFlow(session, name, Math.floor(context.now / 1000));
  if (!taken.ok) return refuse(taken.error, taken.error.kind);
  const flow = taken.value;

  // The flow is bound to the user it was started for: a flow of a guest never serves a signed-in session, nor the reverse.
  if ((flow.userId === undefined) !== (userId === undefined)) return refuse({ kind: 'invalid' }, 'user');
  if (flow.userId !== undefined && !same(String(flow.userId), String(userId))) return refuse({ kind: 'invalid' }, 'user');

  // The state came back unchanged from the provider, so this browser began the sign-in that ends here.
  const state = once(params, 'state');
  if (state === undefined || !same(state, flow.state)) return refuse({ kind: 'invalid' }, 'state');

  // RFC 9207: an answer from another issuer than the one the flow began at (a mix-up) is refused.
  const iss = once(params, 'iss');
  if (params.has('iss') && iss === undefined) return refuse({ kind: 'invalid' }, 'issuer');
  let endpoints: OAuthEndpoints | undefined;
  if (iss !== undefined) {
    endpoints = await context.endpoints();
    if (endpoints === undefined) return refuse({ kind: 'unavailable' }, 'endpoints');
    // A provider that lists the issuers (several tenants) is checked after `profile()`, against the token's issuer; any other has one issuer.
    const later = (provider.definition as Partial<OidcDefinition>)[ISSUER_PARAM] === true;
    if (!later && endpoints.issuer !== undefined && iss !== endpoints.issuer) return refuse({ kind: 'invalid' }, 'issuer');
  }

  if (params.has('error')) {
    // `error_description` is never read: it is a text the provider chose, meant for a person.
    const error = once(params, 'error');
    if (error === 'access_denied') return refuse({ kind: 'cancelled' }, 'cancelled');
    return refuse({ kind: 'provider-error', error: error !== undefined && ERROR_CODE.test(error) ? error : 'unknown' }, 'provider-error');
  }

  const code = once(params, 'code');
  if (code === undefined || code === '' || code.length > MAX_CODE) return refuse({ kind: 'invalid' }, 'code');

  // A confirmation that can never be proven is refused before the code is traded: nothing is sent to the provider for it.
  if (flow.intent === 'confirm') {
    if ((provider.definition as Partial<OidcDefinition>)[OIDC] !== true || (provider.definition as Partial<OidcDefinition>)[NO_CONFIRM] === true) return refuse({ kind: 'invalid' }, 'confirm-provider');
    if (flow.userId === undefined) return refuse({ kind: 'invalid' }, 'confirm-user');
    if (flow.account === undefined) return refuse({ kind: 'invalid' }, 'confirm-account');
  }

  endpoints ??= await context.endpoints();
  if (endpoints === undefined) return refuse({ kind: 'unavailable' }, 'endpoints');
  const { definition, credentials } = provider;
  const tokens = await exchangeCode({
    http: context.http,
    tokenUrl: endpoints.tokenUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    clientAuth: definition.clientAuth ?? 'client_secret_post',
    redirectUri: context.redirectUri(),
    code,
    verifier: flow.verifier,
    asked: flow.scopes,
    commaScopes: (definition as CommaScopesDefinition)[COMMA_SCOPES] === true,
    now: context.now,
  });
  if (!tokens.ok) return refuse(tokens.error, `token-${tokens.error.kind}`);

  let raw: unknown;
  let user: SocialUser | undefined;
  try {
    raw = await definition.profile({ http: context.http, tokens: tokens.value, nonce: flow.nonce, clientId: credentials.clientId, now: context.now });
    // The parameter and the token must name one issuer: the one the token passed every check with.
    if (iss !== undefined && (definition as Partial<OidcDefinition>)[ISSUER_PARAM] === true) {
      if (checkedClaimsOf(raw)?.iss !== iss) return refuse({ kind: 'invalid' }, 'issuer');
    }
    const mapped: unknown = definition.mapUser(raw);
    // An `async` mapUser answers with a promise: refused, and its rejection is taken so that it cannot surface (it may quote a token).
    const then = typeof mapped === 'object' && mapped !== null ? (mapped as { then?: unknown }).then : undefined;
    if (typeof then === 'function') {
      try {
        then.call(mapped, undefined, () => undefined);
      } catch {
        // Nothing more to do with a thenable that throws.
      }
      return refuse({ kind: 'invalid-response' }, 'profile');
    }
    user = toSocialUser(name, raw, mapped, tokens.value);
  } catch (error) {
    // A setup mistake of the app (an address `http` refused) is not the provider's answer. Only this package's own error counts: the
    // provider's code can build any other, with a token in its text.
    if (error instanceof EndpointError) throw error;
    // The provider's code threw: what it says may quote a token or a profile, so nothing of it is logged.
    if (error instanceof OAuthHttpError) {
      const failure = failureOf(error);
      return refuse(failure.kind === 'rejected' ? { kind: 'invalid-response' } : failure, 'profile-request');
    }
    return refuse({ kind: 'invalid-response' }, 'profile');
  }
  if (user === undefined) return refuse({ kind: 'invalid-response' }, 'profile-id');

  const flowUserId = flow.userId === undefined ? undefined : String(flow.userId);
  if (flow.intent !== 'confirm') {
    markVerified(user, { intent: flow.intent, flowUserId });
    return ok({ user, intent: flow.intent });
  }
  // A fresh sign-in proves nothing unless it was the linked account that signed in: the id the provider vouches for is the one the
  // confirmation was started for, else anybody with a session could confirm with an account of their own.
  if (flow.account === undefined || !same(user.id, flow.account)) return refuse({ kind: 'invalid' }, 'confirm-account');
  // A confirmation is worth what the checked ID token proves, nothing else: `iat` says when the token was made, not when the person
  // signed in, so it never stands in for `auth_time`. The claims come from the module's own record of checked tokens, never from
  // anything the definition carries. A provider that did not say confirms nothing.
  const authTime = checkedClaimsOf(raw)?.auth_time;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) return refuse({ kind: 'not-reauthenticated' }, 'auth-time');
  // Not before the redirect (less the drift between this server and the provider), and not in the future (beyond a minute of drift).
  // Written as the range that is allowed, so that a value that compares false with everything is refused.
  if (!(authTime >= flow.issuedAt - REAUTH_EARLY && authTime <= context.now / 1000 + REAUTH_LATE)) return refuse({ kind: 'not-reauthenticated' }, 'auth-time');
  markVerified(user, { intent: flow.intent, flowUserId, reauthenticatedAt: Math.min(authTime * 1000, context.now) });
  return ok({ user, intent: flow.intent });
}
