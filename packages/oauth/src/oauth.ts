import type { Clock, Logger } from '@marmeon/core';
import { err, ok, type Result } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { HttpClient } from '@marmeon/fetch';
import type { Session, SessionConfig } from '@marmeon/session';
import { OAuthSetupError, type OAuthConfig } from './config.ts';
import { variablePrefix } from './credentials.ts';
import type { OAuthEndpoints } from './definition.ts';
import { checkEndpoint, checkEndpoints, EndpointError } from './endpoints.ts';
import { completeCallback, type OAuthCallback, type OAuthCallbackError } from './callback.ts';
import { challengeOf, issueFlow } from './flow.ts';
import { createOAuthHttp, OAuthHttpError } from './http.ts';
import { OIDC, type OidcDefinition } from './oidc-marker.ts';
import type { OAuthProviders, ResolvedOAuthProvider } from './registry.ts';

/** What `redirect()` takes besides the provider. See docs/oauth.md#the-flow-and-its-security. */
export interface OAuthRedirectOptions {
  /** What the sign-in is for, a lower case word (letters and dashes, at most 32). Default `'sign-in'`. The flow is bound to it. */
  readonly intent?: string;
  /** The user this flow is for. The flow is bound to it. */
  readonly userId?: string | number;
  /** Scopes to ask for besides the ones of the provider or of `OAUTH_<NAME>_SCOPES`. */
  readonly scopes?: readonly string[];
  /** Asks the provider to show its account chooser or its consent screen. Not `none` and not `login`. */
  readonly prompt?: 'select_account' | 'consent';
}

/**
 * Why `redirect()` gave no address: `unknown-provider` (the name is unknown, or the provider is inactive), or `unavailable` (the
 * provider's discovery gave no usable answer). `reauthentication-unsupported` is reserved: a later release answers with it when
 * an intent needs a fresh sign-in and the provider cannot give one. A setup mistake of the app throws instead, see
 * {@link OAuth.redirect}. See docs/oauth.md#the-flow-and-its-security.
 */
export type OAuthRedirectError = { readonly kind: 'unknown-provider' } | { readonly kind: 'unavailable' } | { readonly kind: 'reauthentication-unsupported' };

/** What `callback()` takes besides the provider and the query. See docs/oauth.md#the-callback. */
export interface OAuthCallbackOptions {
  /** The signed-in user, if any. It must be the user the flow was started for; a flow started without a user serves only a guest, and passing one is refused. */
  readonly userId?: string | number;
}

const INTENT = /^[a-z][a-z-]{0,31}$/;
const PROMPTS: readonly string[] = ['select_account', 'consent'];

const OPTION_KEYS: readonly string[] = ['intent', 'userId', 'scopes', 'prompt'];
const CALLBACK_KEYS: readonly string[] = ['userId'];

const misuse = (message: string, cause?: unknown): never => {
  throw new OAuthSetupError(withCode('A10', message), cause === undefined ? undefined : { cause });
};

/**
 * Starts the sign-in at a provider with `redirect()` and completes it with `callback()`, in the session of the browser that asks. Resolved per request.
 * See docs/oauth.md#the-flow-and-its-security and docs/oauth.md#the-callback.
 */
export class OAuth {
  readonly #providers: OAuthProviders;
  readonly #session: () => Session | undefined;
  readonly #sessionConfig: () => SessionConfig | undefined;
  readonly #http: () => HttpClient;
  readonly #appUrl: string | undefined;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #local: boolean;

  /**
   * @internal The `OAuthServiceProvider` resolves it for each request. The session, its settings and the client are taken when a
   * flow starts, so `providers()` works in an app without them (the session and its settings answer `undefined` when the app has no session package). `local` allows plain http to a loopback host.
   */
  constructor(providers: OAuthProviders, session: () => Session | undefined, sessionConfig: () => SessionConfig | undefined, http: () => HttpClient, config: OAuthConfig, clock: Clock, logger: Logger, local: boolean) {
    this.#providers = providers;
    this.#session = session;
    this.#sessionConfig = sessionConfig;
    this.#http = http;
    this.#appUrl = config.appUrl;
    this.#clock = clock;
    this.#logger = logger;
    this.#local = local;
  }

  /** The providers a sign-in page lists: the ones that are active. */
  providers(): readonly { readonly name: string; readonly label: string }[] {
    return this.#providers.active();
  }

  /**
   * Opens a flow for the provider `name` and returns the address of its authorization page. Send the browser there with a `303`,
   * and start it from a POST so that no other site can make a visitor's browser open a flow. The flow lives in the session for ten
   * minutes, one per provider. Answers `unknown-provider` for a name that is unknown or inactive, and `unavailable` when the
   * provider's discovery gives no usable answer. Throws a `TypeError` for options of the wrong form (an unknown key included), and
   * an `OAuthSetupError` with the code A10 when the app cannot run a flow: `SESSION_SAME_SITE=strict`, no session package or a
   * session that is not started or that this request may not write, no callback address or one that is not usable, or a request
   * of the provider's code to an address that is not usable. An error in the provider's own `endpoints()` is thrown as it is.
   * See docs/oauth.md#the-flow-and-its-security.
   */
  async redirect(name: string, options: OAuthRedirectOptions = {}): Promise<Result<URL, OAuthRedirectError>> {
    const { intent, userId, scopes, prompt } = checkOptions(options);
    // Before the session is touched: an unknown or inactive name leaves no trace.
    const provider = this.#providers.get(name);
    if (provider === undefined) return err({ kind: 'unknown-provider' });
    const session = this.#checkSetup(provider);
    const redirectUri = this.#callbackOf(provider);

    const { definition, credentials } = provider;
    const endpoints = await this.#endpointsOf(provider);
    if (endpoints === undefined) return err({ kind: 'unavailable' });

    const flow = issueFlow(session, {
      provider: provider.name,
      intent,
      ...(userId === undefined ? {} : { userId }),
      pkce: definition.pkce !== false,
      nonce: definition.nonce === true,
      nowSeconds: Math.floor(this.#clock.now() / 1000),
    });

    const url = new URL(endpoints.authorizeUrl);
    // The provider's own parameters first; every parameter below replaces one of the same name, so nothing can undo a protection.
    for (const [key, value] of Object.entries(definition.authorizeParams ?? {})) url.searchParams.set(key, value);
    // An OpenID Connect provider is always asked for `openid`, also when OAUTH_<NAME>_SCOPES leaves it out: without it there is no ID token.
    const openid = typeof (definition as Partial<OidcDefinition>)[OIDC] === 'function' ? ['openid'] : [];
    const asked = [...new Set([...openid, ...(credentials.scopes ?? definition.scopes), ...(scopes ?? [])])];
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', asked.join(definition.scopeSeparator ?? ' '));
    url.searchParams.set('state', flow.state);
    if (flow.verifier !== undefined) {
      url.searchParams.set('code_challenge', challengeOf(flow.verifier));
      url.searchParams.set('code_challenge_method', 'S256');
    }
    if (flow.nonce !== undefined) url.searchParams.set('nonce', flow.nonce);
    if (prompt !== undefined) url.searchParams.set('prompt', prompt);
    // Never the state, the verifier, the nonce or the address: they are the secrets of this flow.
    this.#logger.debug('Opened an OAuth flow.', { provider: provider.name, intent });
    return ok(url);
  }

  /**
   * Completes the flow of the provider `name` from the query the provider sent the browser back with, and answers the person it vouches
   * for. Pass `userId` when somebody is signed in. The flow leaves the session before anything is checked. Throws a `TypeError` for
   * options of the wrong form, and an `OAuthSetupError` (A10) when the app has no session, or no usable callback address, or the provider's
   * code asks `http` for an address that is not usable (the flow is spent for the last two). An error in the provider's own `endpoints()`
   * is thrown as it is. A session that is not started or that this request may
   * not write answers `invalid` and takes nothing. Put `Route.block()` on the callback route. See docs/oauth.md#the-callback.
   */
  async callback(name: string, params: URLSearchParams, options: OAuthCallbackOptions = {}): Promise<Result<OAuthCallback, OAuthCallbackError>> {
    if (!(params instanceof URLSearchParams)) throw new TypeError('OAuth.callback() takes the URLSearchParams of the callback request as its second argument.');
    const { userId } = checkCallbackOptions(options);
    // Before the session is touched: an unknown or inactive name leaves no trace.
    const provider = this.#providers.get(name);
    if (provider === undefined) return err({ kind: 'unknown-provider' });
    const config = this.#sessionConfig();
    const session = this.#session();
    if (config === undefined || session === undefined) {
      return misuse(`OAuth.callback("${provider.name}") needs the session: register the session package (SessionServiceProvider) and add the StartSession middleware to this route (or its group).`);
    }
    // A request that may not write the session cannot spend the flow, so it would serve twice: nothing is taken, nothing is exchanged.
    if (!session.started || session.readOnly) {
      this.#logger.warn('An OAuth callback was refused.', { provider: provider.name, reason: 'session' });
      return err({ kind: 'invalid' });
    }
    const { allowAddresses } = provider.definition;
    let found: Promise<OAuthEndpoints | undefined> | undefined;
    return completeCallback(
      {
        provider,
        session,
        now: this.#clock.now(),
        logger: this.#logger,
        http: createOAuthHttp(allowAddresses === undefined ? this.#http() : this.#http().allowing(allowAddresses), this.#local),
        endpoints: () => (found ??= this.#endpointsOf(provider)),
        redirectUri: () => this.#callbackOf(provider),
      },
      params,
      userId,
    );
  }

  /** The refusals that need the app's attention; checked before anything is fetched or stored. Returns the session to write the flow into. */
  #checkSetup(provider: ResolvedOAuthProvider): Session {
    // Only a missing session package is this app's setup mistake; whatever else fails while resolving goes through as it is.
    const config = this.#sessionConfig();
    const session = this.#session();
    if (config === undefined || session === undefined) {
      return misuse(`OAuth.redirect("${provider.name}") needs the session: register the session package (SessionServiceProvider) and add the StartSession middleware to this route (or its group).`);
    }
    const sameSite = config.sameSite;
    if (sameSite === 'strict') {
      misuse(
        `The OAuth provider "${provider.name}" cannot sign anybody in with SESSION_SAME_SITE=strict: the browser comes back from the provider with a cross-site request and does not send a strict session cookie, so the callback would find no flow. Use 'lax' (the default).`,
      );
    }
    if (!session.started) misuse(`OAuth.redirect("${provider.name}") needs the session: add the StartSession middleware to this route (or its group).`);
    if (session.readOnly) {
      misuse(`OAuth.redirect("${provider.name}") must write the flow into the session, but this request may not change it (an island, a live validation, an upload or an event stream). Start the sign-in from a page route or a form post.`);
    }
    return session;
  }

  /** The callback address: the provider's own override, else `APP_URL` and the fixed path. Never the host of the request. */
  #callbackOf(provider: ResolvedOAuthProvider): string {
    const variables = variablePrefix(provider.name);
    const own = provider.credentials.redirectUrl;
    if (own !== undefined) return checkEndpoint(own, `${variables}REDIRECT_URL`, 'A10', this.#local).href;
    if (this.#appUrl === undefined) {
      return misuse(`The OAuth provider "${provider.name}" has no callback address: set APP_URL, or ${variables}REDIRECT_URL for this provider.`);
    }
    const app = checkEndpoint(this.#appUrl, 'APP_URL', 'A10', this.#local);
    let path = app.pathname;
    while (path.endsWith('/')) path = path.slice(0, -1);
    return `${app.origin}${path}/auth/${provider.name}/callback`;
  }

  /** The endpoints as an object, or `undefined` when the provider that finds them cannot be reached. */
  async #endpointsOf(provider: ResolvedOAuthProvider): Promise<OAuthEndpoints | undefined> {
    const { endpoints, allowAddresses } = provider.definition;
    if (typeof endpoints !== 'function') return endpoints;
    const client = this.#http();
    const http = createOAuthHttp(allowAddresses === undefined ? client : client.allowing(allowAddresses), this.#local);
    let found: unknown;
    try {
      found = await endpoints(http);
    } catch (error) {
      // Only a provider that did not answer is a runtime condition; a bug in the provider's own code is not hidden as one.
      if (!(error instanceof OAuthHttpError)) throw error;
      // A document that was fetched but is not usable carries the fixed reason of the endpoint check; nothing of its text.
      const reason = error.cause instanceof EndpointError ? { reason: error.cause.reason } : {};
      this.#logger.warn('An OAuth provider could not be reached to find its endpoints.', { provider: provider.name, status: error.status, ...reason });
      return undefined;
    }
    // What the provider's server answered is as untrusted as the definition was at the start. A document that fails the check is the
    // other side's state, like no answer: nothing of it (an address, a value) goes to the log.
    try {
      return checkEndpoints(found, `The OAuth provider "${provider.name}" found endpoints that`, 'A10', this.#local);
    } catch (error) {
      if (!(error instanceof EndpointError)) throw error;
      // `reason` is a fixed text; the message is not logged, as a branch of it quotes a key from the document.
      this.#logger.warn('An OAuth provider found endpoints that are not usable.', { provider: provider.name, reason: error.reason });
      return undefined;
    }
  }
}

const isUserId = (userId: unknown): boolean => (typeof userId === 'string' ? userId !== '' : Number.isSafeInteger(userId));

function checkCallbackOptions(options: OAuthCallbackOptions): { userId: string | number | undefined } {
  if (typeof options !== 'object' || options === null) throw new TypeError('OAuth.callback() takes an options object: { userId }.');
  const unknown = Object.keys(options).filter((key) => !CALLBACK_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError(`OAuth.callback() does not take ${unknown.map((key) => `"${key}"`).join(', ')}. The options are ${CALLBACK_KEYS.join(', ')}.`);
  const { userId } = options;
  if (userId !== undefined && !isUserId(userId)) throw new TypeError('The OAuth userId must be a non-empty string or a whole number.');
  return { userId };
}

function checkOptions(options: OAuthRedirectOptions): { intent: string; userId: string | number | undefined; scopes: readonly string[] | undefined; prompt: string | undefined } {
  if (typeof options !== 'object' || options === null) throw new TypeError('OAuth.redirect() takes an options object: { intent, userId, scopes, prompt }.');
  // A misspelt key would silently start a flow without its user, or a sign-in where a link was meant.
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError(`OAuth.redirect() does not take ${unknown.map((key) => `"${key}"`).join(', ')}. The options are ${OPTION_KEYS.join(', ')}.`);
  const { intent = 'sign-in', userId, scopes, prompt } = options;
  if (typeof intent !== 'string' || !INTENT.test(intent)) throw new TypeError(`The OAuth intent must be a lower case word (letters and dashes, starting with a letter, at most 32), not ${JSON.stringify(intent)}.`);
  if (userId !== undefined && !isUserId(userId)) throw new TypeError('The OAuth userId must be a non-empty string or a whole number.');
  if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string' && scope !== '' && !/\s/.test(scope)))) {
    throw new TypeError('The OAuth scopes must be a list of non-empty strings without spaces.');
  }
  if (prompt !== undefined && (typeof prompt !== 'string' || !PROMPTS.includes(prompt))) {
    throw new TypeError(`The OAuth prompt must be 'select_account' or 'consent', not ${JSON.stringify(prompt)}.`);
  }
  return { intent, userId, scopes: scopes && [...scopes], prompt };
}
