# Social login

## Introduction

`@marmeon/oauth` describes a service people can sign in with as a **provider** with a name. An app or a package registers providers by
name, the app configures each one from environment variables, and a provider whose variables are not set does not exist for the app.
This page covers registering and configuring providers; the pages of the flow itself follow as they are written.

A provider is a class that brings a name and the variables it reads:

```ts title="providers/GiteaProvider.ts"
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

Here `OAUTH_GITEA_ISSUER` holds the address of your Gitea server. The provider is active once that and the client ID and secret are set.

## Configuring a provider

Every provider reads the same variables, named after it. The prefix is `OAUTH_`, the name in upper case, and a dash in the name becomes an
underscore: the provider `my-idp` reads `OAUTH_MY_IDP_CLIENT_ID`.

| Variable | Default | Effect |
| --- | --- | --- |
| `OAUTH_<NAME>_CLIENT_ID` | none | The client ID your app has at the provider. |
| `OAUTH_<NAME>_CLIENT_SECRET` | none | The client secret. Keep it out of the repository. |
| `OAUTH_<NAME>_REDIRECT_URL` | none | The callback address of this provider. An absolute `https:` URL (or `http:` on a loopback host in development and test), without a user name or fragment. |
| `OAUTH_<NAME>_SCOPES` | none | Comma-separated scopes, each without spaces. |
| `OAUTH_<NAME>_ISSUER` | none | Read only by a provider that asked for it with `issuer`. |
| `APP_URL` | none | The URL of your app, needed by an active provider that has no `OAUTH_<NAME>_REDIRECT_URL`. An absolute `https:` URL (or `http:` on a loopback host in development and test), without a user name or fragment. |

A provider is **active** when its client ID and client secret are set, and its issuer too where the provider requires one. An empty variable
counts as not set. An inactive provider is never created: its factory does not run, and its definition, `SCOPES` and `REDIRECT_URL` are
not checked. Reading the variables never fails, so an app without social login starts with any value in them.

`OAuthProviders` holds the providers that are active. Inject it where you need them:

```ts
providers.active(); // [{ name: 'gitea', label: 'Gitea' }]
providers.get('gitea'); // the provider, or undefined when it is unknown or inactive
```

### Starting the app

The providers are checked when the app starts, so a mistake stops the start instead of the first sign-in. The start throws an
`OAuthSetupError`, and its message begins with `[marmeon:A11]` ([error codes](errors.md#server-error-codes)). It stops when:

- two providers bring one name, a name is not lower case letters, digits and dashes (starting with a letter), or a name is longer than 32 characters;
- the value of `static oauthProviders` is not an object of functions;
- the class that brings a name does not list `oauthCredentials(name)` in its own `static config`. The message shows the line to add;
- a class lists `oauthCredentials(name)` twice, or two different credentials configurations read one variable, including the option keys
  of one provider and the standard variables of another;
- an **active** provider has a definition that is wrong: a missing or oversize `label`, `endpoints` or `scopes` of the wrong form, a
  `scopeSeparator`, `pkce`, `nonce`, `clientAuth`, `authorizeParams` or `allowAddresses` of the wrong type, a `profile` or `mapUser` that is
  not a function, an `authorizeParams` entry the flow sets itself, or a field that is not part of a definition (a typo such as `nonse`);
- an **active** provider has an endpoint that is not an absolute URL, carries a user name or a fragment, or does not use `https:`, or an
  `authorizeUrl` whose query sets a parameter the flow sets itself;
- an **active** provider's `allowAddresses` has an entry that is not an address range, or its `OAUTH_<NAME>_SCOPES` or
  `OAUTH_<NAME>_REDIRECT_URL` is not valid;
- an **active** provider has no `OAUTH_<NAME>_REDIRECT_URL` and `APP_URL` is missing or not valid. The message names the provider. The
  host of a request is never used instead;
- a provider is active and no `HttpClient` is bound. Register `FetchServiceProvider` from `@marmeon/fetch`, which a new app has.

Plain `http:` is accepted for an endpoint, `OAUTH_<NAME>_REDIRECT_URL` or `APP_URL` on `localhost`, `127.0.0.1` or `[::1]`, and only while
`NODE_ENV` is `development` or `test`. A missing or other `NODE_ENV` is production, where every address needs `https:`.

The checked definition is copied and frozen at the start. Changing the object a factory returned afterwards changes nothing.

## Your own provider

A provider is a name and a definition. Register the name in `static oauthProviders` of a service provider class, list
`oauthCredentials(name)` in the `static config` of the same class, and describe the service with `defineOAuthProvider`:

| Field | Form |
| --- | --- |
| `label` | Text of 1 to 64 characters. |
| `endpoints` | `{ authorizeUrl, tokenUrl }`, with `issuer` for a service that signs ID tokens, or a function that finds them. |
| `scopes` | A list of scopes, each non-empty and without spaces. |
| `scopeSeparator` | A non-empty string. |
| `pkce`, `nonce` | `true` or `false`. |
| `clientAuth` | `'client_secret_post'` or `'client_secret_basic'`. |
| `authorizeParams` | An object of strings. |
| `allowAddresses` | A list of address ranges such as `10.20.0.0/16`, for a service inside your network. |
| `profile` | A function that loads the person's data and returns it as it is. |
| `mapUser` | A function that turns that data into `{ id, email, emailVerified, name, nickname, avatar }`. |

A plain object may hold these fields only: a field of another name stops the start (A11). State that `profile` or `mapUser` needs belongs
in an instance of a class, in a `#private` field that they read through `this`.

`profile` and `mapUser` share one type: what `profile` returns is what `mapUser` receives, so you type the answer once. `id` is the
provider's own identifier of the account, never the e-mail address. `emailVerified` is `true` only when the provider itself vouches for the
address; say `false` when you cannot tell.

`authorizeParams` and the query of `authorizeUrl` may not set `response_type`, `response_mode`, `client_id`, `redirect_uri`, `scope`,
`state`, `code_challenge`, `code_challenge_method`, `nonce`, `prompt`, `max_age`, `request` or `request_uri`. The flow sets these, and a
provider that set one would replace a protection. The check ignores the case of the name.

Give `defineOAuthProvider` a function when the definition depends on the configuration. The function receives the provider's `name`, its
`credentials` and the `container`, and is called once at the start, only when the provider is active. The credentials hold `clientId`,
`clientSecret`, `redirectUrl`, `scopes`, `issuer` and `options`. A provider that needs more variables asks for them by key:

```ts
static config = [oauthCredentials('gitea', { issuer: 'required', options: ['ORGANIZATION'] })];
```

and finds `OAUTH_GITEA_ORGANIZATION` in `context.credentials.options.ORGANIZATION`. A key is upper case letters, digits and underscores, and
cannot be one of the names every provider has. `oauthCredentials` throws a `TypeError` for a name or key of another form, and for an
`issuer` that is not `'required'` or `'optional'`.
