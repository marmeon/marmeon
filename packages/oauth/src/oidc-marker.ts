import type { OAuthProviderDefinition } from './definition.ts';
import type { IdTokenClaims } from './id-token.ts';

/**
 * A marker, set to `true` on the definition that `oidc()` builds. It proves nothing by being there, since a spread of the definition
 * copies it: the claims of a checked ID token are read only through `checkedClaimsOf`. Not exported from the package.
 */
export const OIDC = Symbol('marmeon.oauth.oidc');

/**
 * Set to `true` next to {@link OIDC} when `acceptedIssuers` is given. The `iss` parameter of a callback is then not compared with the
 * issuer of the discovery document before the code is traded; after `profile()` it must equal the issuer of the ID token that passed
 * every check.
 */
export const ISSUER_PARAM = Symbol('marmeon.oauth.oidc.issuer-parameter');

/**
 * The ID token claims of each raw answer `oidc()` made (a frozen copy, not the object the app holds). A raw answer that is not in it did
 * not come from a checked token. Module-wide and not exported from the package: a definition cannot bring its own reader, so only a token
 * that `oidc()` checked can vouch for anything.
 */
const checked = new WeakMap<object, IdTokenClaims>();

/** Records the claims of the ID token that passed every check for `raw`. */
export function recordChecked(raw: object, claims: IdTokenClaims): void {
  checked.set(raw, claims);
}

/** The claims of the checked ID token behind `raw`, or `undefined` for an answer `oidc()` did not make. */
export function checkedClaimsOf(raw: unknown): IdTokenClaims | undefined {
  return typeof raw === 'object' && raw !== null ? checked.get(raw) : undefined;
}

/** The definition `oidc()` builds: a definition with the readers. */
export type OidcDefinition = OAuthProviderDefinition & {
  readonly [OIDC]: true;
  readonly [ISSUER_PARAM]?: true;
};
