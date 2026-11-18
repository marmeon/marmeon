# Social login

## Introduction

`@marmeon/oauth` describes a service people can sign in with as a **provider** with a name. An app or a package registers providers by
name, the app configures each one from environment variables, and a provider whose variables are not set does not exist for the app.
This page covers registering and configuring providers, and starting the flow; the rest of the flow follows as it is written.

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

The callback address is `OAUTH_<NAME>_REDIRECT_URL` when it is set, and otherwise `APP_URL` followed by `/auth/<name>/callback`: with
`APP_URL=https://app.example.com`, the provider `gitea` is sent `https://app.example.com/auth/gitea/callback` as the `redirect_uri` of the
authorization request. The address comes from configuration only; the host of a request is never used, so a request with a forged `Host`
header cannot point the provider's answer at another site. The route that receives the answer is not part of the package yet.

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

## The flow and its security

`OAuth` starts the sign-in. Inject it where you handle the request:

```ts title="modules/auth/controllers/StartSocialLoginController.ts"
import { Controller, type HttpContext } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';

export class StartSocialLoginController extends Controller {
  readonly #oauth: OAuth;

  constructor(oauth: OAuth) {
    super();
    this.#oauth = oauth;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    const result = await this.#oauth.redirect(ctx.params.provider);
    if (!result.ok) return this.back('/login');
    return this.redirect(result.value.href).status(303);
  }
}
```

Register the route with `POST` in the module's `routes.ts`, which loads into the `web` group, so the session and the CSRF check apply. Anyone may start
a sign-in, so the route says `everyone`:

```ts title="modules/auth/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';
import { StartSocialLoginController } from './controllers/StartSocialLoginController.ts';

export default defineRoutes((Route) => {
  Route.authorize(everyone).post('/auth/:provider/start', StartSocialLoginController).name('auth.social.start');
});
```

`OAuth.providers()` lists the active providers, each with its `name` and `label`. A page shows one form for each, and the form is covered by the [CSRF check](csrf.md#forms-and-javascript). The page gets `providers` from `oauth.providers()` in your controller:

```tsx
import { Form } from '@marmeon/react';

{providers.map(({ name, label }) => (
  <Form key={name} route="auth.social.start" params={{ provider: name }}>
    <button type="submit">Sign in with {label}</button>
  </Form>
))}
```

`redirect()` returns the address of the provider's authorization page. It opens a **flow** in the session of the browser that asks, and the
flow is bound to that browser, to the provider, to an intent and, if you pass `userId`, to one user. Only the session that holds the flow
can complete it.

A flow holds:

- a `state`, a random value that the provider sends back unchanged, so the callback knows the answer belongs to the sign-in this browser began;
- a PKCE verifier, whose SHA-256 (method `S256`) goes to the provider as the challenge. The provider releases the tokens only to the one that
  holds the verifier. A provider turns this off with `pkce: false`;
- a `nonce` for a provider that sets `nonce: true`;
- the `intent`, a lower case word such as `sign-in` (the default) or `link`, and the `userId` when you give one.

Each of the three random values has 256 bits. The session keeps them. The address carries the state, the challenge and, for a provider with
`nonce: true`, the nonce; the verifier never leaves the session.

A flow lasts ten minutes. A provider has one slot per session, so starting a second flow for the same provider replaces the first, and
the first can no longer be completed. A flow of one provider never serves another.

Start the flow from a `POST` (a form button), not from a link: a `POST` carries the CSRF check, so another site cannot make a visitor's
browser open a flow, and a prefetching browser does not open one either.

| Option | Effect |
| --- | --- |
| `intent` | What the sign-in is for: lower case letters and dashes, starting with a letter, at most 32. Default `sign-in`. |
| `userId` | The user the flow belongs to. |
| `scopes` | Scopes to ask for besides the provider's own (or `OAUTH_<NAME>_SCOPES`). Duplicates are dropped. |
| `prompt` | `'select_account'` or `'consent'`, to show the provider's account chooser or consent screen. Any other value, `none` and `login` included, throws a `TypeError`. |

The flow sets `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method` and `nonce` itself, after
the `authorizeParams` of the provider, so nothing a provider adds can replace them.

`redirect()` answers with a `Result`:

| Error | Meaning |
| --- | --- |
| `unknown-provider` | The name is unknown, or the provider is inactive. The session is not touched. |
| `unavailable` | The provider's discovery gave no usable answer: no answer, a status other than 2xx, no JSON, a redirect, too large an answer, a timeout, or endpoints that are not usable. No flow is stored. An error in your own `endpoints()` code is not hidden as `unavailable`: it is thrown. |
| `reauthentication-unsupported` | Reserved for asking a provider for a fresh sign-in. |

`redirect()` throws an `OAuthSetupError` with the code `A10` ([error codes](errors.md#server-error-codes)) when the app cannot run a flow at all:

- `SESSION_SAME_SITE=strict`, see [SameSite](#samesite);
- the session package is not installed, the session is not started (add the `StartSession` middleware), or the request may not write it, as with an island or a live validation;
- neither `OAUTH_<NAME>_REDIRECT_URL` nor `APP_URL` is set, or the one that is used is not a usable address;
- `http` in your `endpoints()` code is asked for an address that is not `https:` (or `http:` on a loopback host in development and test), or that carries a user name or a fragment.

The provider's own requests (discovery, and `http` in `profile`) go through the `HttpClient`: ten seconds at most, 1 MiB of answer, no redirect,
and no address of your own network unless the provider's `allowAddresses` lists its range. An answer that is not 2xx or not JSON is an error
that carries its status and never its body. Nothing logs the state, the verifier, the nonce or an address of the flow.

### SameSite

The browser returns from the provider with a request that starts on another site. A session cookie with `SameSite=Strict` is not sent with
it, so the callback would find no session and no flow, and every sign-in would fail after the person had already signed in at the provider.
`redirect()` throws an A10 error under `SESSION_SAME_SITE=strict` for that reason. Keep `lax` (the default), or `none` over `https`.
