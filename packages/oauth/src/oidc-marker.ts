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
 * The `acceptedIssuers` function of an `oidc()` provider, when it has one. The fake reads it so that a test is held to the issuer policy
 * of the real provider (which tenants may sign in). Not exported from the package.
 */
export const ACCEPTED_ISSUERS = Symbol('marmeon.oauth.oidc.accepted-issuers');

/**
 * Set to `true` on the definition of an `oidc()` provider that cannot prove a fresh sign-in (its ID token has no usable `auth_time`).
 * `redirect()` with the intent `confirm` then answers `reauthentication-unsupported`, and the callback refuses a confirmation. Only
 * the package's own built-in providers set it; `oidc()` takes no option for it. Not exported from the package.
 */
export const NO_CONFIRM = Symbol('marmeon.oauth.oidc.no-confirmation');

/**
 * Set to `true` on the definition of a provider whose token response separates the scopes with commas (GitHub). Every other provider's
 * `scope` is split at white space only, since a comma can be part of a scope. Only the package's own built-in providers set it. Not
 * exported from the package.
 */
export const COMMA_SCOPES = Symbol('marmeon.oauth.comma-separated-scopes');

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

/**
 * The definitions `oidc()` built, by object identity (a spread of a definition copies the marker, never this membership). The registry
 * carries the membership over to its frozen copy. Module-wide and not exported from the package.
 */
const built = new WeakSet<object>();

/** Records that `oidc()` built `definition`. */
export function recordBuilt(definition: object): void {
  built.add(definition);
}

/** Whether `definition` is an object `oidc()` built (or the registry's frozen copy of one). */
export function isBuiltByOidc(definition: object): boolean {
  return built.has(definition);
}

/** The definition `oidc()` builds: a definition with the readers. */
export type OidcDefinition = OAuthProviderDefinition & {
  readonly [OIDC]: true;
  readonly [ISSUER_PARAM]?: true;
  readonly [ACCEPTED_ISSUERS]?: (claims: Readonly<Record<string, unknown>>) => readonly string[];
  readonly [NO_CONFIRM]?: true;
};

/** A definition that may carry {@link COMMA_SCOPES}. */
export type CommaScopesDefinition = OAuthProviderDefinition & { readonly [COMMA_SCOPES]?: true };
