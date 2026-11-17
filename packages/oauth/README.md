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

export class GiteaProvider {
  static config = [oauthCredentials('gitea', { issuer: 'required' })];
  static oauthProviders = { gitea: defineOAuthProvider((context) => ({ /* endpoints, profile, mapUser */ })) };
}
```

A provider is active once `OAUTH_GITEA_CLIENT_ID` and `OAUTH_GITEA_CLIENT_SECRET` are set.

## Documentation

- [Social login](https://marmeon.com/docs/oauth)
- [Your own provider](https://marmeon.com/docs/oauth#your-own-provider)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
