import { oidcWith } from '../oidc.ts';
import type { OAuthProviderFactory } from '../definition.ts';

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Google, through OpenID Connect. Google writes its issuer with and without the scheme in a token; the `iss` parameter of the callback
 * must still be the issuer of the discovery document, and it is checked before the code is traded. The `id` is the `sub`. Google never
 * confirms a person. See docs/oauth.md#the-built-in-providers.
 */
export const google: OAuthProviderFactory = oidcWith(
  {
    issuer: 'https://accounts.google.com',
    label: 'Google',
    mapUser: (claims) => {
      const email = textOf(claims.email);
      const hosted = typeof claims.hd === 'string' && claims.hd !== '';
      return {
        id: claims.sub,
        email,
        // Google's own rule: `email_verified` counts for a gmail.com address, and for any other only in a Workspace domain (`hd`). Without
        // `hd`, the address of another domain may be one the person never proved at Google.
        emailVerified: email !== null && claims.email_verified === true && (email.toLowerCase().endsWith('@gmail.com') || hosted),
        name: textOf(claims.name),
        nickname: textOf(claims.preferred_username) ?? textOf(claims.nickname),
        avatar: textOf(claims.picture),
      };
    },
  },
  // `auth_time` comes only with a `claims` request and a setting, and Google does not know `prompt=login`: nothing here proves a fresh sign-in.
  { tokenIssuerAliases: ['accounts.google.com'], noConfirmation: true },
);
