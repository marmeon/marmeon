import { EnvironmentConfig } from '@marmeon/core';
import { abort } from '@marmeon/http';
import { OAuthConfig, OAuthProviders, type ResolvedOAuthProvider } from '@marmeon/oauth';

/** The parameters of an authorization request, as the browser sent them. */
export interface AuthorizeParams {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly response_type: string;
  readonly code_challenge: string;
  readonly code_challenge_method: string;
  readonly nonce: string;
  readonly state: string;
  readonly prompt: string;
}

/** The name of the local provider: its variables are `OAUTH_LOCAL_*`, its callback is `/auth/local/callback`. */
export const LOCAL_PROVIDER = 'local';

/** An S256 challenge: the SHA-256 of the verifier, base64url without padding. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The settings of the local OpenID Connect provider, and the gate its controllers and request classes ask first: outside development and test, and
 * while `local` is not active, `provider()` is a 404. The condition is `NODE_ENV` being `development` or `test`, nothing else: a missing or
 * unknown `NODE_ENV` is production. The gate is reached after the CSRF check of the `web` group, so in production the form post of the
 * authorize page answers 419 without the browser's word and 403 from another site; the pages, the discovery document and the token endpoint answer 404.
 */
export class LocalOidc {
  readonly #node: string;
  readonly #providers: OAuthProviders;
  readonly #appUrl: string | undefined;

  constructor(environment: EnvironmentConfig, providers: OAuthProviders, oauth: OAuthConfig) {
    this.#node = environment.node;
    this.#providers = providers;
    this.#appUrl = oauth.appUrl;
  }

  /** The active `local` provider, or a 404: never anything outside development and test. */
  provider(): ResolvedOAuthProvider & { readonly credentials: { readonly issuer: string } } {
    if (this.#node !== 'development' && this.#node !== 'test') abort(404);
    const provider = this.#providers.get(LOCAL_PROVIDER);
    const issuer = provider?.credentials.issuer;
    if (provider === undefined || issuer === undefined) abort(404);
    return provider as ResolvedOAuthProvider & { readonly credentials: { readonly issuer: string } };
  }

  /** The callback the package sends: the provider's own `OAUTH_LOCAL_REDIRECT_URL`, else `APP_URL` and the fixed path. */
  callback(provider: ResolvedOAuthProvider): string {
    if (provider.credentials.redirectUrl !== undefined) return new URL(provider.credentials.redirectUrl).href;
    const app = new URL(this.#appUrl ?? abort(404));
    return `${app.origin}${app.pathname.replace(/\/+$/, '')}/auth/${LOCAL_PROVIDER}/callback`;
  }

  /** The address of the app, without a trailing slash: where the endpoints of the provider live. */
  base(): string {
    const app = new URL(this.#appUrl ?? abort(404));
    return `${app.origin}${app.pathname.replace(/\/+$/, '')}`;
  }

  /** Why an authorization request is refused, or `undefined` when it is the one this app's own sign-in sends. */
  refusal(params: AuthorizeParams, provider: ResolvedOAuthProvider): string | undefined {
    if (params.client_id !== provider.credentials.clientId) return 'The client_id is not the one of this app.';
    // Exactly the callback the package derives: a prefix or another address would hand the code to somebody else.
    if (params.redirect_uri !== this.callback(provider)) return 'The redirect_uri is not the callback of this app.';
    if (params.response_type !== 'code') return 'Only response_type=code is supported.';
    if (params.code_challenge_method !== 'S256' || !CHALLENGE.test(params.code_challenge)) return 'PKCE with code_challenge_method=S256 is required.';
    if (params.nonce === '' || params.nonce.length > 255) return 'A nonce is required.';
    if (params.state === '' || params.state.length > 255) return 'A state is required.';
    return undefined;
  }
}
