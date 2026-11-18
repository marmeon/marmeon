import { defineConfig, env, type ConfigOf } from '@marmeon/core';

/**
 * Thrown at the start (A11) when a provider is registered wrongly, and at first use (A10) when the app cannot run a flow.
 * See docs/oauth.md#starting-the-app and docs/oauth.md#the-flow-and-its-security.
 */
export class OAuthSetupError extends Error {
  override readonly name = 'OAuthSetupError';
}

/**
 * The part of the configuration that every provider shares: the app's URL. An active provider without its own
 * `OAUTH_<NAME>_REDIRECT_URL` needs it, and the start checks it then. Reading it never fails.
 * See docs/oauth.md#configuring-a-provider.
 */
export const OAuthConfig = defineConfig('oauth', {
  env: env({
    /** The app's URL: the base address of the providers that have no `OAUTH_<NAME>_REDIRECT_URL`. Never taken from a request. */
    APP_URL: env.string().optional(),
  }),
  resolve: (e) => ({ appUrl: e.APP_URL }),
});
export type OAuthConfig = ConfigOf<typeof OAuthConfig>;
