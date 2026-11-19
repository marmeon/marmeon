import { defineOAuthProvider, type OAuthProviderFactory } from '../definition.ts';

const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);
// The avatar address is built from two values of the answer: a hash of plain characters and a numeric id cannot change the path.
const HASH = /^[a-z0-9_]+$/i;
const SNOWFLAKE = /^\d{1,32}$/;

/**
 * Discord, through OAuth 2.0 with the scopes `identify` and `email`. It never confirms a person (`redirect()` with the intent `confirm`
 * answers `reauthentication-unsupported`). The address counts as verified only when Discord answers `verified: true` for it.
 * See docs/oauth.md#the-built-in-providers.
 */
export const discord: OAuthProviderFactory = defineOAuthProvider<Readonly<Record<string, unknown>>>({
  label: 'Discord',
  endpoints: { authorizeUrl: 'https://discord.com/oauth2/authorize', tokenUrl: 'https://discord.com/api/oauth2/token' },
  scopes: ['identify', 'email'],
  pkce: true,
  profile: async ({ http, tokens }) => {
    const answer = await http.json('https://discord.com/api/users/@me', { bearer: tokens.accessToken });
    return typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {};
  },
  mapUser: (user) => {
    const id = textOf(user.id) ?? '';
    const email = textOf(user.email);
    const hash = textOf(user.avatar);
    return {
      id,
      email,
      emailVerified: email !== null && user.verified === true,
      name: textOf(user.global_name),
      nickname: textOf(user.username),
      avatar: hash !== null && HASH.test(hash) && SNOWFLAKE.test(id) ? `https://cdn.discordapp.com/avatars/${id}/${hash}.png` : null,
    };
  },
});
