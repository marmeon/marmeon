import type { OAuthProviderFactory } from '../definition.ts';
import { oidcWith } from '../oidc.ts';

const GITLAB_COM = 'https://gitlab.com';
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * GitLab, through OpenID Connect: `gitlab.com`, or the server in `OAUTH_GITLAB_ISSUER` for a self-hosted GitLab (the provider lists
 * `oauthCredentials('gitlab', { issuer: 'optional' })`). The `id` holds the issuer, so changing the issuer matches no linked account. It never
 * confirms a person. Only an issuer that is exactly `https://gitlab.com` has its `email_verified` trusted. See docs/oauth.md#the-built-in-providers.
 */
export const gitlab: OAuthProviderFactory = (context) => {
  // `oidc()` refuses an issuer in both places, so the default is passed only when the variable is not set.
  const own = context.credentials.issuer !== undefined && context.credentials.issuer !== '';
  const issuer = own ? context.credentials.issuer : GITLAB_COM;
  return oidcWith(
    {
      label: 'GitLab',
      ...(own ? {} : { issuer: GITLAB_COM }),
      mapUser: (claims) => {
        const email = textOf(claims.email);
        return {
          id: `${claims.iss}|${claims.sub}`,
          email,
          // Only gitlab.com's flag is trusted: a self-hosted GitLab does not confirm addresses by default, so its flag says nothing.
          emailVerified: issuer === GITLAB_COM && email !== null && claims.email_verified === true,
          name: textOf(claims.name),
          nickname: textOf(claims.preferred_username) ?? textOf(claims.nickname),
          avatar: textOf(claims.picture),
        };
      },
    },
    // `auth_time` at GitLab is the last sign-in of the user, not of this browser session.
    { noConfirmation: true },
  )(context);
};
