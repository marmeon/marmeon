import { Clock, EnvironmentConfig } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import { OAuthSetupError } from './config.ts';
import { createDiscovery } from './discovery.ts';
import type { OAuthProfileInput, OAuthProviderContext, OAuthProviderDefinition, OAuthProviderFactory, SocialProfile } from './definition.ts';
import { checkEndpoint } from './endpoints.ts';
import { checkIdToken, type IdTokenClaims } from './id-token.ts';
import { ACCEPTED_ISSUERS, ISSUER_PARAM, NO_CONFIRM, OIDC, recordBuilt, recordChecked, type OidcDefinition } from './oidc-marker.ts';

export type { IdTokenClaims } from './id-token.ts';
export { OIDC, ISSUER_PARAM } from './oidc-marker.ts';
export type { OidcDefinition } from './oidc-marker.ts';

/** The options that do not depend on each other. */
interface OidcBaseOptions {
  /** The issuer, as the provider writes it. Without it the issuer is `OAUTH_<NAME>_ISSUER`, which exists only when the class lists `oauthCredentials(name, { issuer: 'required' | 'optional' })`. Setting both stops the start (A11). */
  readonly issuer?: string;
  /** The name a sign-in button shows. Default `'OpenID Connect'`. */
  readonly label?: string;
  /** The scopes; `openid` is always asked for. Default `openid`, `profile` and `email`. */
  readonly scopes?: readonly string[];
  /** The address of the discovery document. Default: the issuer, without a trailing slash, and `/.well-known/openid-configuration`. */
  readonly discoveryUrl?: string;
  /** The issuer the discovery document names, when it is not the issuer. Default: the issuer. Compared as exact text. */
  readonly discoveryIssuer?: string;
  /** Also asks the userinfo endpoint for claims. Its `sub` must be the one of the ID token. */
  readonly userinfo?: boolean;
  /** How the client secret reaches the token endpoint. Default `'client_secret_post'`. */
  readonly clientAuth?: OAuthProviderDefinition['clientAuth'];
  /** Extra parameters of the authorization request. The ones the flow owns are refused. */
  readonly authorizeParams?: Readonly<Record<string, string>>;
  /** Address ranges the provider may resolve to (a provider inside your network). */
  readonly allowAddresses?: readonly string[];
}

/** The profile mapping that is the default. See {@link OidcOptions}. */
type Mapping = (claims: IdTokenClaims) => SocialProfile;

/**
 * What `oidc()` takes. `acceptedIssuers` comes with a `mapUser`: a `sub` is unique only within its issuer, so the `id` must hold the
 * issuer or the tenant. See docs/oauth.md#openid-connect-providers.
 */
export type OidcOptions = OidcBaseOptions &
  (
    | {
        /**
         * Turns the claims into a profile. With `userinfo: true` these are the claims of the ID token with those of the userinfo answer
         * added, except the ones only the ID token sets, and `email_verified` (`phone_number_verified`) comes from the userinfo answer
         * alone when it gives an `email` (`phone_number`). Default: `sub`, `email`, `email_verified`, `name`, `preferred_username`, `picture`.
         */
        readonly mapUser?: Mapping;
        readonly acceptedIssuers?: undefined;
      }
    | {
        /**
         * The issuers that may sign in, when it is not just the issuer (one for each tenant). Called with the claims of an ID token; the
         * answer is compared as exact text. The `iss` parameter of the callback must equal the issuer of the token. Must be synchronous.
         * It comes with a `mapUser` that puts the issuer or the tenant into the `id`.
         */
        readonly acceptedIssuers: (claims: Readonly<Record<string, unknown>>) => readonly string[];
        /** Turns the claims into a profile; see the other form of the options. */
        readonly mapUser: Mapping;
      }
  );

const OPTION_KEYS = ['issuer', 'label', 'scopes', 'discoveryUrl', 'discoveryIssuer', 'acceptedIssuers', 'userinfo', 'clientAuth', 'authorizeParams', 'allowAddresses', 'mapUser'];
/** Claims that only the ID token may set: userinfo is a second answer, and must not change who the person is or when they signed in. */
const FROM_ID_TOKEN = new Set(['sub', 'iss', 'aud', 'azp', 'exp', 'iat', 'nbf', 'nonce', 'auth_time', 'acr', 'amr']);
/** A claim and the claim that says whether the provider vouches for it. They come from one answer: a flag from one and a value from the other would vouch for the wrong one. */
const VERIFIED_PAIRS: readonly (readonly [string, string])[] = [['email', 'email_verified'], ['phone_number', 'phone_number_verified']];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function mapClaims(claims: IdTokenClaims): SocialProfile {
  const email = textOf(claims.email);
  return {
    id: claims.sub,
    email,
    emailVerified: email !== null && claims.email_verified === true,
    name: textOf(claims.name),
    nickname: textOf(claims.preferred_username) ?? textOf(claims.nickname),
    avatar: textOf(claims.picture),
  };
}

function checkOptions(options: OidcOptions): void {
  if (typeof options !== 'object' || options === null) throw new TypeError('oidc() takes an options object.');
  const unknown = Object.keys(options).filter((key) => !OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError(`oidc() does not take ${unknown.map((key) => `"${key}"`).join(', ')}. The options are ${OPTION_KEYS.join(', ')}.`);
  for (const key of ['issuer', 'discoveryUrl', 'discoveryIssuer'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'string') throw new TypeError(`oidc(): ${key} must be a string.`);
  }
  if (options.userinfo !== undefined && typeof options.userinfo !== 'boolean') throw new TypeError('oidc(): userinfo must be true or false.');
  if (options.acceptedIssuers !== undefined && typeof options.acceptedIssuers !== 'function') throw new TypeError('oidc(): acceptedIssuers must be a function.');
  if (options.mapUser !== undefined && typeof options.mapUser !== 'function') throw new TypeError('oidc(): mapUser must be a function.');
  // A `sub` is unique only within its issuer: with several issuers, two people of two issuers can share one.
  if (options.acceptedIssuers !== undefined && options.mapUser === undefined) {
    throw new TypeError('oidc(): acceptedIssuers needs a mapUser that puts the issuer or the tenant into the id, as a sub is unique only within its issuer. For example: mapUser: (claims) => ({ id: `${claims.iss}|${claims.sub}`, … }).');
  }
}

/**
 * An OpenID Connect provider from its issuer: finds the endpoints through discovery, always sends a `nonce`, and checks the ID token
 * of the token response in full. The issuer comes from the `issuer` option or from `OAUTH_<NAME>_ISSUER`, which exists when the class lists
 * `oauthCredentials(name, { issuer: 'required' | 'optional' })`. Throws a `TypeError` for an option of the wrong form, or for
 * `acceptedIssuers` without `mapUser`. The start stops with an `OAuthSetupError` (A11) when there is no issuer or two, or when the
 * issuer or `discoveryUrl` is not a usable address. See docs/oauth.md#openid-connect-providers.
 *
 * ```ts
 * static config = [oauthCredentials('keycloak', { issuer: 'required' })];
 * static oauthProviders = { keycloak: oidc({ label: 'Keycloak' }) };
 * ```
 */
export function oidc(options: OidcOptions = {}): OAuthProviderFactory {
  return oidcWith(options, {});
}

/** What only the package's own providers ask of `oidc()`; the public function takes none of it. */
export interface OidcInternals {
  /** Spellings of the issuer that an ID token may carry besides the issuer. The `iss` parameter of the callback is still compared with the issuer of the document, before the code is traded. */
  readonly tokenIssuerAliases?: readonly string[];
  /** The provider cannot prove a fresh sign-in: a confirmation at it is refused. */
  readonly noConfirmation?: true;
}

export function oidcWith(options: OidcOptions, internals: OidcInternals): OAuthProviderFactory {
  checkOptions(options);
  return (context: OAuthProviderContext): OAuthProviderDefinition => {
    const variable = `OAUTH_${context.name.replaceAll('-', '_').toUpperCase()}_ISSUER`;
    const fromCredentials = context.credentials.issuer === '' ? undefined : context.credentials.issuer;
    if (options.issuer !== undefined && fromCredentials !== undefined) {
      throw new OAuthSetupError(withCode('A11', `The OAuth provider "${context.name}" has an issuer in oidc() and in ${variable}: set the issuer in one place.`));
    }
    const issuer = options.issuer ?? fromCredentials;
    if (issuer === undefined || issuer === '') {
      throw new OAuthSetupError(withCode('A11', `The OAuth provider "${context.name}" is an OpenID Connect provider and needs an issuer: pass issuer to oidc(), or list oauthCredentials("${context.name}", { issuer: 'required' }) and set ${variable}.`));
    }
    const node = context.container.make(EnvironmentConfig).node;
    const local = node === 'development' || node === 'test';
    checkEndpoint(issuer, `The issuer of the OAuth provider "${context.name}"`, 'A11', local);
    let base = issuer;
    while (base.endsWith('/')) base = base.slice(0, -1);
    const discoveryUrl = options.discoveryUrl ?? `${base}/.well-known/openid-configuration`;
    if (options.discoveryUrl !== undefined) checkEndpoint(discoveryUrl, `The discoveryUrl of the OAuth provider "${context.name}"`, 'A11', local);
    const documentIssuer = options.discoveryIssuer ?? issuer;
    const userinfo = options.userinfo === true;
    const clock = (): number => context.container.make(Clock).now();
    const discover = createDiscovery({ url: discoveryUrl, issuer: documentIssuer, userinfo, now: clock, local });
    const mapUser = options.mapUser ?? mapClaims;
    const accepted = options.acceptedIssuers;

    /** The issuers that may sign in for these claims. A function that throws, answers a promise (a rejection is taken, so it cannot surface) or answers no list lists none. */
    const issuersFor = (claims: Readonly<Record<string, unknown>>): readonly string[] => {
      if (accepted === undefined) return [issuer, ...(internals.tokenIssuerAliases ?? [])];
      const listed: unknown = accepted(claims);
      const then = typeof listed === 'object' && listed !== null ? (listed as { then?: unknown }).then : undefined;
      if (typeof then === 'function') {
        try {
          then.call(listed, undefined, () => undefined);
        } catch {
          // Nothing more to do with a thenable that throws.
        }
        return [];
      }
      return Array.isArray(listed) ? (listed as readonly string[]) : [];
    };

    const profile = async ({ http, tokens, nonce, clientId, now }: OAuthProfileInput): Promise<Readonly<Record<string, unknown>>> => {
      // Nothing was sent without a nonce, so a flow without one is not ours: refused before the token is looked at.
      if (nonce === undefined) throw new Error('The flow of an OpenID Connect provider has no nonce.');
      if (tokens.idToken === undefined) throw new Error('The token response has no id_token.');
      const claims = checkIdToken(tokens.idToken, { issuers: issuersFor, clientId, nonce, now });
      if (!claims.ok) throw new Error(`The ID token is not accepted: ${claims.error.kind}.`);
      const token = claims.value;
      let merged: Record<string, unknown> = { ...token };
      if (userinfo) {
        const answer = await http.json((await discover(http)).userinfoUrl!, { bearer: tokens.accessToken });
        if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) throw new Error('The userinfo answer is not an object.');
        const info = answer as Record<string, unknown>;
        // A userinfo answer about another person than the one the ID token vouches for would put that person's data on this sign-in.
        if (info.sub !== token.sub) throw new Error('The sub of the userinfo answer is not the one of the ID token.');
        merged = { ...token, ...Object.fromEntries(Object.entries(info).filter(([key]) => !FROM_ID_TOKEN.has(key))) };
        // Where the userinfo answer gives the value, it gives the flag too: the ID token's flag was about the ID token's value.
        for (const [value, flag] of VERIFIED_PAIRS) {
          // Without the value in the userinfo answer, the pair is the ID token's: a flag alone from userinfo would vouch for the token's value.
          const from = info[value] === undefined ? token : info;
          if (from[flag] === undefined) delete merged[flag];
          else merged[flag] = from[flag];
        }
      }
      const raw = Object.freeze(merged);
      // A frozen copy of its own: what the app holds as `raw` cannot change what the reader answers.
      recordChecked(raw, deepFreeze(structuredClone({ ...token })) as IdTokenClaims);
      return raw;
    };

    const definition: OidcDefinition = {
      label: options.label ?? 'OpenID Connect',
      endpoints: async (http) => (await discover(http)).endpoints,
      scopes: [...new Set(['openid', ...(options.scopes ?? ['profile', 'email'])])],
      pkce: true,
      nonce: true,
      ...(options.clientAuth === undefined ? {} : { clientAuth: options.clientAuth }),
      ...(options.authorizeParams === undefined ? {} : { authorizeParams: options.authorizeParams }),
      ...(options.allowAddresses === undefined ? {} : { allowAddresses: options.allowAddresses }),
      profile,
      mapUser: (raw) => mapUser(raw as IdTokenClaims),
      [OIDC]: true as const,
      ...(accepted === undefined ? {} : { [ISSUER_PARAM]: true as const, [ACCEPTED_ISSUERS]: issuersFor }),
      ...(internals.noConfirmation === true ? { [NO_CONFIRM]: true as const } : {}),
    };
    // Frozen before it is recorded: a definition that `oidc()` built cannot gain an own `profile()` afterwards and still count as checked.
    Object.freeze(definition);
    recordBuilt(definition);
    return definition;
  };
}
