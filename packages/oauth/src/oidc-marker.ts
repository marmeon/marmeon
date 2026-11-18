import type { OAuthProviderDefinition } from './definition.ts';
import type { IdTokenClaims } from './id-token.ts';

/**
 * Set on the definition that `oidc()` builds, and by nothing else. Its value is a reader: given the `raw` answer of a callback, it
 * answers the claims of the ID token that passed the checks, or `undefined` for anything `oidc()` did not make. Only that answer
 * proves a check; the presence of the symbol proves nothing, since a spread of the definition copies it. Not exported from the package.
 */
export const OIDC = Symbol('marmeon.oauth.oidc');

/**
 * Set to `true` next to {@link OIDC} when `acceptedIssuers` is given. The `iss` parameter of a callback is then not compared with the
 * issuer of the discovery document before the code is traded; after `profile()` it must equal the issuer of the ID token that passed
 * every check.
 */
export const ISSUER_PARAM = Symbol('marmeon.oauth.oidc.issuer-parameter');

/** The definition `oidc()` builds: a definition with the readers. */
export type OidcDefinition = OAuthProviderDefinition & {
  readonly [OIDC]: (raw: unknown) => IdTokenClaims | undefined;
  readonly [ISSUER_PARAM]?: true;
};
