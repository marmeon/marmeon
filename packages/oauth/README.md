# @marmeon/oauth

Social login for Marmeon apps: OAuth 2.0 and OpenID Connect providers that you register by name and configure from the environment.

## Installation

```sh
pnpm add -E @marmeon/oauth@<version of your app>
```

## Registering a provider

A package or the app brings a provider by name through `static oauthProviders`, and lists the variables it reads:

```ts
import { defineOAuthProvider, oauthCredentials } from '@marmeon/oauth';

interface GiteaUser {
  id: number;
  login: string;
  email: string;
  full_name: string;
  avatar_url: string;
}

export class GiteaProvider {
  static config = [oauthCredentials('gitea', { issuer: 'required' })];
  static oauthProviders = {
    gitea: defineOAuthProvider(({ credentials }) => {
      const server = credentials.issuer!.replace(/\/$/, '');
      return {
        label: 'Gitea',
        endpoints: { authorizeUrl: `${server}/login/oauth/authorize`, tokenUrl: `${server}/login/oauth/access_token` },
        scopes: ['read:user'],
        profile: async ({ http, tokens }) => (await http.json(`${server}/api/v1/user`, { bearer: tokens.accessToken })) as GiteaUser,
        mapUser: (user) => ({ id: String(user.id), email: user.email, emailVerified: false, name: user.full_name, nickname: user.login, avatar: user.avatar_url }),
      };
    }),
  };
}
```

`OAUTH_GITEA_ISSUER` holds the address of your Gitea server. A provider is active once that and `OAUTH_GITEA_CLIENT_ID` and `OAUTH_GITEA_CLIENT_SECRET` are set.

## Documentation

- [Social login](https://marmeon.com/docs/oauth)
- [Your own provider](https://marmeon.com/docs/oauth#your-own-provider)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
