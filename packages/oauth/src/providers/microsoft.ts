import { withCode } from '@marmeon/core/internal';
import { OAuthSetupError } from '../config.ts';
import type { OAuthProviderFactory } from '../definition.ts';
import { oidc } from '../oidc.ts';

const HOST = 'https://login.microsoftonline.com';
/** The tenant of personal Microsoft accounts. */
const CONSUMERS = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const issuerOf = (tenant: string): string => `${HOST}/${tenant}/v2.0`;

/**
 * Microsoft, through OpenID Connect, for the tenant in `OAUTH_MICROSOFT_TENANT`: `common` (the default), `organizations`, `consumers`
 * or a tenant ID. Tokens of `common` and `organizations` name the tenant of the person, so the issuer is the one of the token's `tid`
 * and the `id` holds the tenant. The address is never reported as verified: Microsoft does not say that it checked it. A confirmation works
 * only when the ID token carries the optional claim `auth_time`. A value that is no keyword and no tenant ID, such as a domain name, stops the start of an active provider (A11).
 * See docs/oauth.md#the-built-in-providers.
 */
export const microsoft: OAuthProviderFactory = (context) => {
  // Under another name the provider's class lists no TENANT, and the variable would be ignored: the start stops instead of running as `common`.
  if (!Object.hasOwn(context.credentials.options, 'TENANT')) {
    throw new OAuthSetupError(
      withCode('A11', `The OAuth provider "${context.name}" is the built-in Microsoft provider, which reads OAUTH_MICROSOFT_TENANT: bring it under the name "microsoft" only.`),
    );
  }
  const given = context.credentials.options.TENANT;
  const tenant = given === undefined || given === '' ? 'common' : given;
  const keyword = tenant === 'common' || tenant === 'organizations' || tenant === 'consumers';
  const guid = tenant.toLowerCase();
  if (!keyword && !GUID.test(guid)) {
    throw new OAuthSetupError(
      withCode('A11', `OAUTH_MICROSOFT_TENANT is not common, organizations, consumers or a tenant ID (keywords are lower case). A domain name does not work: use the tenant ID.`),
    );
  }
  const wide = tenant === 'common' || tenant === 'organizations';
  // The one tenant a token may name, when it is a single one: a token of another tenant is refused even if Microsoft signed it.
  const only = tenant === 'consumers' ? CONSUMERS : guid;
  return oidc({
    issuer: issuerOf(wide ? tenant : only),
    label: 'Microsoft',
    // The documents of `common` and `organizations` name the issuer with the literal placeholder; the token names its tenant.
    ...(wide
      ? { discoveryIssuer: `${HOST}/{tenantid}/v2.0` }
      : tenant === 'consumers'
        ? { discoveryUrl: `${HOST}/consumers/v2.0/.well-known/openid-configuration` }
        : {}),
    acceptedIssuers: (claims) => {
      const tid = claims.tid;
      if (typeof tid !== 'string') return [];
      if (wide) return GUID.test(tid) && !(tenant === 'organizations' && tid === CONSUMERS) ? [issuerOf(tid)] : [];
      return tid === only ? [issuerOf(only)] : [];
    },
    mapUser: (claims) => {
      const tid = claims.tid;
      // A `sub` is unique within one tenant only; acceptedIssuers has let nothing but a GUID through.
      if (typeof tid !== 'string') throw new Error('The ID token has no tid.');
      return {
        id: `${tid}|${claims.sub}`,
        email: textOf(claims.email),
        // Microsoft's `email` claim is not one it checked (its `email_verified` is not a statement about this address), so it is never verified.
        emailVerified: false,
        name: textOf(claims.name),
        nickname: textOf(claims.preferred_username),
        avatar: null,
      };
    },
  })(context);
};
