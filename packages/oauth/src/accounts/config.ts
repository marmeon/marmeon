import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/**
 * What the app decides about social accounts: `OAUTH_REGISTRATION` (default on), whether a sign-in at a provider may create a new user (nothing in this
 * package reads it yet), and `OAUTH_STORE_TOKENS` (default off — a token sits in the database only when the app uses it),
 * which makes `SocialAccountStore` keep the provider's tokens, encrypted.
 * See docs/oauth.md#storing-tokens.
 */
export const SocialAccountsConfig = defineConfig('socialAccounts', {
  env: env({
    /** Whether a sign-in at a provider may create a new user; nothing in this package reads it yet. */
    OAUTH_REGISTRATION: env.boolean().default(true),
    /** Whether the access and refresh token of a provider are stored, encrypted. */
    OAUTH_STORE_TOKENS: env.boolean().default(false),
  }),
  resolve: (e) => ({ registration: e.OAUTH_REGISTRATION, storeTokens: e.OAUTH_STORE_TOKENS }),
});
export type SocialAccountsConfig = ConfigOf<typeof SocialAccountsConfig>;
