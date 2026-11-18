import { defineOAuthProvider, type OAuthProviderFactory } from '../definition.ts';
import { COMMA_SCOPES } from '../oidc-marker.ts';
import { OAuthHttpError } from '../http.ts';

/** What GitHub's two answers hold; `emails` is `null` when `/user/emails` was not available. */
interface GitHubRaw {
  readonly user: Readonly<Record<string, unknown>>;
  readonly emails: readonly unknown[] | null;
}

const API = 'https://api.github.com';
// GitHub refuses a request without a user agent. The `accept` header is the one the package sets for every provider request: plain JSON.
const HEADERS = { 'user-agent': 'marmeon-oauth' };

const objectOf = (value: unknown): Readonly<Record<string, unknown>> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const textOf = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * GitHub, through OAuth 2.0 with the scopes `read:user` and `user:email`. It never confirms a person (`redirect()` with the intent `confirm`
 * answers `reauthentication-unsupported`): GitHub has no ID token that says when the person signed in. The address is the primary one
 * of `/user/emails`, verified only when GitHub says so for that address. See docs/oauth.md#the-built-in-providers.
 */
export const github: OAuthProviderFactory = defineOAuthProvider<GitHubRaw>({
  label: 'GitHub',
  endpoints: { authorizeUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token' },
  scopes: ['read:user', 'user:email'],
  pkce: true,
  clientAuth: 'client_secret_post',
  // GitHub asks for scopes separated by spaces but answers with commas. A marker, not a field: no public option for it.
  ...{ [COMMA_SCOPES]: true as const },
  profile: async ({ http, tokens }) => {
    const user = objectOf(await http.json(`${API}/user`, { bearer: tokens.accessToken, headers: HEADERS }));
    let emails: readonly unknown[] | null = null;
    try {
      const answer = await http.json(`${API}/user/emails?per_page=100`, { bearer: tokens.accessToken, headers: HEADERS });
      emails = Array.isArray(answer) ? answer : null;
    } catch (error) {
      // A token without the `user:email` scope (403) or an account without the list (404) leaves the public address; any other failure is a failure.
      if (!(error instanceof OAuthHttpError) || (error.status !== 403 && error.status !== 404)) throw error;
    }
    return { user, emails };
  },
  mapUser: ({ user, emails }) => {
    const id = typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : '';
    // Verified only for the primary address of `/user/emails`, and only when GitHub says `verified: true` for that entry. The public
    // address of `/user` carries no flag, so it is never verified.
    const primary = (emails ?? []).map(objectOf).find((entry) => entry.primary === true && typeof entry.email === 'string');
    const email = primary === undefined ? textOf(user.email) : (primary.email as string);
    return {
      id,
      email,
      emailVerified: primary !== undefined && primary.verified === true,
      name: textOf(user.name),
      nickname: textOf(user.login),
      avatar: textOf(user.avatar_url),
    };
  },
});
