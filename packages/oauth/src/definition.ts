import type { Resolver } from '@marmeon/core';
import type { OAuthCredentials } from './credentials.ts';

/** The two addresses a flow needs — and the issuer, for a provider that signs its ID tokens. */
export interface OAuthEndpoints {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly issuer?: string;
}

/** What the token endpoint handed back. */
export interface OAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: Date;
  readonly scopes: readonly string[];
  readonly idToken?: string;
}

/** A person as every provider describes them after `mapUser`. */
export interface SocialProfile {
  /** The provider's stable identifier of the account — never the e-mail address. */
  readonly id: string;
  readonly email: string | null;
  /** Whether the provider vouches for `email`. Only an exact `true` counts. */
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly nickname: string | null;
  readonly avatar: string | null;
}

/** A signed-in person: the profile, the provider's raw answer and the tokens. */
export interface SocialUser extends SocialProfile {
  readonly provider: string;
  readonly raw: unknown;
  readonly tokens: OAuthTokens;
}

/** What `profile()` and a function-form `endpoints` may call to make a JSON request. */
export interface OAuthHttp {
  json(
    url: string,
    init?: {
      readonly bearer?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly maxBytes?: number;
    } & (
      | { readonly method?: 'GET'; readonly form?: undefined }
      // A form is sent with POST, which is the default method when there is a form.
      | { readonly method?: 'POST'; readonly form?: Readonly<Record<string, string>> }
    ),
  ): Promise<unknown>;
}

/** What `profile()` gets once the tokens are exchanged. */
export interface OAuthProfileInput {
  readonly http: OAuthHttp;
  readonly tokens: OAuthTokens;
  readonly nonce: string | undefined;
  readonly clientId: string;
  /** The current time in milliseconds. */
  readonly now: number;
}

/**
 * How one provider speaks OAuth. `Raw` is what `profile()` returns and `mapUser()` takes, so the two cannot disagree.
 * A plain object may hold these fields only; a field of another name stops the start (A11). State that `profile()` or `mapUser()` needs
 * belongs in an instance of a class (a `#private` field), which they reach through `this`.
 * See docs/oauth.md#your-own-provider.
 */
export interface OAuthProviderDefinition<Raw = unknown> {
  /** The name a sign-in button shows, 1 to 64 characters. */
  readonly label: string;
  /** The endpoints, or a function that finds them (discovery). */
  readonly endpoints: OAuthEndpoints | ((http: OAuthHttp) => Promise<OAuthEndpoints>);
  /** The scopes of the provider, each non-empty and without spaces. Used by the sign-in flow unless `OAUTH_<NAME>_SCOPES` is set. */
  readonly scopes: readonly string[];
  /** Used by the sign-in flow to join the scopes in the request. Default for the flow: a space. */
  readonly scopeSeparator?: string;
  /** Whether the sign-in flow uses PKCE. Default for the flow: `true`. */
  readonly pkce?: boolean;
  /** Whether the sign-in flow sends a nonce and hands it to `profile()`. Default for the flow: `false`. */
  readonly nonce?: boolean;
  /** How the sign-in flow sends the client secret to the token endpoint: in the body or in a Basic header. Default for the flow: `'client_secret_post'`. */
  readonly clientAuth?: 'client_secret_post' | 'client_secret_basic';
  /** Extra parameters of the authorization request. The ones the flow owns are refused. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /** Address ranges the provider's own endpoints may resolve to (a provider inside your network), as `HttpClient` takes them. */
  readonly allowAddresses?: readonly string[];
  // Properties, not methods: a method parameter is checked bivariantly, so a `mapUser` that reads more than `profile()` returns would compile.
  readonly profile: (input: OAuthProfileInput) => Promise<Raw>;
  readonly mapUser: (raw: Raw) => SocialProfile;
}

/** What a provider's factory is told. */
export interface OAuthProviderContext {
  readonly name: string;
  readonly credentials: OAuthCredentials;
  readonly container: Resolver;
}

/** Creates a provider's definition. Called once at the start, and only when the provider's variables are set. */
export type OAuthProviderFactory = (context: OAuthProviderContext) => OAuthProviderDefinition;

/**
 * The value of `static oauthProviders = { name: … }`: a definition, or a function of the provider's context when it needs the
 * credentials (an issuer, an option). See docs/oauth.md#your-own-provider.
 */
export function defineOAuthProvider<Raw>(
  definition: OAuthProviderDefinition<Raw> | ((context: OAuthProviderContext) => OAuthProviderDefinition<Raw>),
): OAuthProviderFactory {
  return (typeof definition === 'function' ? definition : () => definition) as OAuthProviderFactory;
}
