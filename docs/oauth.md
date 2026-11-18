# Social login

## Introduction

`@marmeon/oauth` describes a service people can sign in with as a **provider** with a name. An app or a package registers providers by
name, the app configures each one from environment variables, and a provider whose variables are not set does not exist for the app.
The sections follow the order of the work:

- [Configuring a provider](#configuring-a-provider) and [your own provider](#your-own-provider) say how a provider is registered and which variables it reads.
- [The built-in providers](#the-built-in-providers) lists the ones the package ships.
- [OpenID Connect providers](#openid-connect-providers) cover providers that sign an ID token.
- [The flow and its security](#the-flow-and-its-security) start a flow, and [the callback](#the-callback) completes it.
- [Signing users in](#signing-users-in) turns the result into a signed-in user, and [linking and unlinking](#linking-and-unlinking) manage the accounts of a user.
- [Confirming with a provider](#confirming-with-a-provider) lets a person prove who they are again, and [opening the confirmation window](#opening-the-confirmation-window) makes that count.
- [Storing tokens](#storing-tokens) covers the `social_accounts` table and its migration, the service provider and its variables, and how tokens are kept.
- [Testing](#testing) runs the whole flow in an app test without a request leaving the process.

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
| `OAUTH_<NAME>_SCOPES` | none | Comma-separated scopes, each without spaces, at most 64 of at most 255 characters. |
| `OAUTH_<NAME>_ISSUER` | none | Read only by a provider that asked for it with `issuer`. |
| `APP_URL` | none | The URL of your app, needed by an active provider that has no `OAUTH_<NAME>_REDIRECT_URL`. An absolute `https:` URL (or `http:` on a loopback host in development and test), without a user name or fragment. |

The callback address is `OAUTH_<NAME>_REDIRECT_URL` when it is set, and otherwise `APP_URL` followed by `/auth/<name>/callback`: with
`APP_URL=https://app.example.com`, the provider `gitea` is sent `https://app.example.com/auth/gitea/callback` as the `redirect_uri` of the
authorization request. The address comes from configuration only; the host of a request is never used, so a request with a forged `Host`
header cannot point the provider's answer at another site. The package does not register the route that receives the answer; see [the callback](#the-callback).

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
- an **active** `oidc()` provider has no issuer, has one in `oidc()` and in `OAUTH_<NAME>_ISSUER`, or has an issuer or `discoveryUrl` that is not a usable address;
- a provider is active and no `HttpClient` is bound. Register `FetchServiceProvider` from `@marmeon/fetch`, which a new app has.

Plain `http:` is accepted for an endpoint, `OAUTH_<NAME>_REDIRECT_URL` or `APP_URL` on `localhost`, `127.0.0.1` or `[::1]`, and only while
`NODE_ENV` is `development` or `test`. A missing or other `NODE_ENV` is production, where every address needs `https:`.

The checked definition is copied and frozen at the start. Changing the object a factory returned afterwards changes nothing.

## The built-in providers

`OAuthServiceProvider` brings five providers: `github`, `google`, `microsoft`, `gitlab` and `discord`. They go through the same
`static oauthProviders` record as your own, so these five names are taken: a class that brings one of them stops the start. Each is active as
soon as its client ID and client secret are set, with the variables of [configuring a provider](#configuring-a-provider). The callback address of
each is `APP_URL` followed by `/auth/<name>/callback` (for example `https://app.example.com/auth/github/callback`), unless
`OAUTH_<NAME>_REDIRECT_URL` says another one. Register that address at the provider.

| Provider | Variables beyond the common ones | Kind | Can confirm |
| --- | --- | --- | --- |
| `github` | none | OAuth 2.0 | never |
| `google` | none | OpenID Connect | never |
| `microsoft` | `OAUTH_MICROSOFT_TENANT` | OpenID Connect | only with `auth_time` |
| `gitlab` | `OAUTH_GITLAB_ISSUER` | OpenID Connect | never |
| `discord` | none | OAuth 2.0 | never |

No built-in provider reports `emailVerified: true` unless the provider says so for that address. A provider that answers the flag for another address,
or no flag, gives `false`.

**GitHub** asks for the scopes `read:user` and `user:email` with PKCE. GitHub asks for its scopes separated by spaces and answers with commas, which the package reads as separate scopes. The `id` is the numeric id of the account, never the login, which a person can change.
The address is the primary one of `/user/emails` (asked for with `per_page=100`), and `emailVerified` is true only when GitHub says `verified: true` for that entry.
When the list is not available (403 or 404, or an answer that is no list), the public address of the profile is used and is never verified; the same holds for an
account whose list has no primary address. Any other failure of the list, such as a 401, ends the sign-in. GitHub cannot confirm: `redirect()` with the intent
`confirm` answers `reauthentication-unsupported`.

**Google** is an OpenID Connect provider with the issuer `https://accounts.google.com`. When the callback carries an `iss` parameter, it must be that issuer, and is checked before the
code is traded. An ID token may write its issuer with or without the scheme (`accounts.google.com`); both are accepted and no other. The `id` is the `sub`.
`emailVerified` is true when `email_verified` is `true` and the address ends in `@gmail.com`, or the token has a non-empty `hd`. Google cannot confirm: it gives `auth_time` only for a `claims` request that you would have to enable, and it does not document `prompt=login`.

**Microsoft** reads `OAUTH_MICROSOFT_TENANT`: `common` (the default), `organizations`, `consumers` or a tenant ID (a GUID). When the provider is active, a value that is
no keyword (in lower case) and no tenant ID, such as a domain name like `contoso.onmicrosoft.com`, stops the start (A11): use the tenant ID. With `common` and `organizations` the
token names the tenant of the person (`tid`), which must be a GUID, and the issuer must be the one of that tenant; `organizations` also refuses the tenant of personal
Microsoft accounts. With a tenant ID or `consumers`, a token of another tenant is refused. The `id` is the tenant and the `sub` (`<tid>|<sub>`), because a `sub` is unique only within
a tenant. `emailVerified` is always `false`: the claims of Microsoft do not say that the address was checked. A confirmation needs the optional claim `auth_time` in the ID token; without it
every confirmation at Microsoft ends in `not-reauthenticated`.

**GitLab** is an OpenID Connect provider for `https://gitlab.com`. For a self-hosted GitLab, set `OAUTH_GITLAB_ISSUER` to its address. The `id` is the issuer and the `sub` (`<issuer>|<sub>`), so
changing the issuer ends the match with the linked accounts: they are looked up under the new issuer and none is found. `emailVerified` is the `email_verified` claim when the issuer is exactly `https://gitlab.com` (also when `OAUTH_GITLAB_ISSUER` says so). At any other issuer, a self-hosted
GitLab included, it is always `false`, because such a server does not confirm addresses by default; to trust the flag of a server you run, write your own provider with [`oidc()`](#openid-connect-providers) and
its `mapUser`. GitLab cannot confirm: its `auth_time` is the last sign-in of the user, not that of the browser session.

The built-in providers are meant to be used under their own names. `microsoft` under another name stops the start (A11), because its tenant variable would not be read; `gitlab` under another name
runs, but with the variable and credentials of that name, which is a known limit.

**Discord** asks for the scopes `identify` and `email` with PKCE. `emailVerified` is true only for `verified: true` in the answer of Discord. The avatar address is
built from the id and the avatar hash only when the id is all digits and the hash holds letters, digits and underscores, so an answer cannot change the path. Discord cannot confirm.

## Your own provider

A provider is a name and a definition. Register the name in `static oauthProviders` of a service provider class, list
`oauthCredentials(name)` in the `static config` of the same class, and describe the service with `defineOAuthProvider`:

| Field | Form |
| --- | --- |
| `label` | Text of 1 to 64 characters. |
| `endpoints` | `{ authorizeUrl, tokenUrl }`, with `issuer` for a service that signs ID tokens, or a function that finds them. |
| `scopes` | A list of at most 64 scopes, each non-empty, without spaces and at most 255 characters. |
| `scopeSeparator` | A non-empty string that joins the scopes in the request. The `scope` of a token response is split at white space only, since a comma can belong to a scope; GitHub, which answers with commas, is the one exception. |
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

## OpenID Connect providers

`oidc()` makes a provider of any OpenID Connect server from its issuer. It finds the endpoints through discovery and sends a `nonce` with
every flow. It asks for the `openid` scope. It checks the ID token of the token response before it trusts the person:

```ts title="providers/KeycloakProvider.ts"
import { oauthCredentials, oidc } from '@marmeon/oauth';

export class KeycloakProvider {
  static config = [oauthCredentials('keycloak', { issuer: 'required' })];
  static oauthProviders = { keycloak: oidc({ label: 'Keycloak' }) };
}
```

`OAUTH_KEYCLOAK_ISSUER` holds the issuer, for example `https://keycloak.example.com/realms/main`. The same line serves Auth0
(`https://<tenant>.auth0.com/`), Okta, Authentik and every other server that publishes a discovery document.

The variable `OAUTH_<NAME>_ISSUER` exists only when the class lists `oauthCredentials(name, { issuer: 'required' })` or
`oauthCredentials(name, { issuer: 'optional' })`. When the issuer is fixed, pass `issuer` to `oidc()` and list `oauthCredentials(name)` without
the option. Giving the issuer in both places stops the start (A11). With `issuer: 'required'` the provider stays inactive until the variable
is set. With `'optional'` or without the option, no issuer at all stops the start (A11).

| Option | Effect |
| --- | --- |
| `issuer` | The issuer, as the provider writes it. A trailing slash matters. Default: `OAUTH_<NAME>_ISSUER`. |
| `label` | The text of the sign-in button. Default `OpenID Connect`. |
| `scopes` | Default `openid`, `profile` and `email`. `openid` is added when it is missing. `OAUTH_<NAME>_SCOPES` cannot remove it. |
| `discoveryUrl` | The address of the discovery document. It must be a usable endpoint address (A11 otherwise). Default: the issuer without a trailing slash, then `/.well-known/openid-configuration`. |
| `discoveryIssuer` | The issuer the discovery document names, when that text is not `issuer`. This is the case for a server whose document serves many tenants. Default: `issuer`. |
| `acceptedIssuers` | A function that lists the issuers a sign-in may come from. It is the only way to accept more than the configured issuer, and it needs your own `mapUser` (see below). |
| `userinfo` | `true` also asks the userinfo endpoint for claims. |
| `clientAuth` | How the client secret reaches the token endpoint, as in [your own provider](#your-own-provider). |
| `authorizeParams` | Extra parameters of the authorization request, as in [your own provider](#your-own-provider). |
| `allowAddresses` | Address ranges the server may resolve to. A server inside your network needs it: the discovery, token and userinfo requests refuse the addresses of your own network otherwise. |
| `mapUser` | A function from the claims to `{ id, email, emailVerified, name, nickname, avatar }`. Default: `id` is `sub`, `emailVerified` is `email_verified === true`, `nickname` is `preferred_username` or `nickname`, `avatar` is `picture`. |

`oidc()` throws a `TypeError` for an option of the wrong type and for `acceptedIssuers` without `mapUser`. `oidc()` runs when the class is
loaded, so the `TypeError` appears before the start.

The discovery document is fetched with a GET, at most 256 KiB. It is kept for an hour. A failure is kept for ten seconds, so a server that is
down does not cost a request for every sign-in. Calls that come while the document is being fetched share the request. The `issuer` in the
document must be the configured one, character for character. Another text is an `OAuthSetupError` with the code A10 that names both.
`authorization_endpoint` and `token_endpoint`, and `userinfo_endpoint` with `userinfo: true`, are held to the rule for every endpoint:
`https:`, no user name, no fragment. A document without them answers `unavailable`, and is kept for ten seconds like any failure.

The ID token is checked in full, as OpenID Connect Core 3.1.3.7 asks:

- It is three parts. The header and the payload are each base64url text of a JSON object. The signature may be empty.
- `iss` is one of the issuers `acceptedIssuers` lists, or, by default, only the configured issuer. Each is compared as exact text: a
  trailing slash or another case is refused.
- `aud` is your client ID or a list that holds it. With several entries `azp` is required. `azp`, when present, is your client ID.
- `exp` and `iat` are required. `exp` has not passed, and `iat` is not more than a minute ahead. One minute of difference between the
  clocks is tolerated. `nbf`, when present, is not more than a minute ahead.
- `nonce` is the one of this flow. A token without it, or with another, is refused: it was not issued for this sign-in.
- `sub` is one to 255 characters.

**The signature is not checked, and `alg` is read for nothing.** The package takes the ID token only from the token response. It made
that request itself, over TLS, with its own client secret and the PKCE verifier. OpenID Connect Core 3.1.3.7 (point 6) lets a client rely on
that channel in place of the signature. No option turns the signature check on. A token from any other source must never be passed to this
check: the package takes none from the query.

A token that fails a check ends the callback in `invalid-response`. The log holds a fixed reason and never the token. A token response
with no `id_token` is `invalid-response` as well.

With `userinfo: true`, the userinfo answer must name the same `sub` as the ID token, or the callback is `invalid-response`. The claims of
the answer are added to those of the ID token and replace a claim of the same name. Only the ID token sets `sub`, `iss`, `aud`, `azp`,
`exp`, `iat`, `nbf`, `nonce`, `auth_time`, `acr` and `amr`. A value and the flag that vouches for it come from one answer: when the userinfo
answer gives an `email`, `email_verified` comes from it alone, and an address without a flag there is not verified, whatever the ID token
said about another address. `phone_number` and `phone_number_verified` work the same way. `mapUser` receives these merged claims.

A `sub` is unique only within its issuer. When `acceptedIssuers` lists several issuers (one for each tenant), two people of two tenants can
have one `sub`, so `oidc()` requires your own `mapUser`, and the `id` it returns must hold the issuer or the tenant:

```ts
oidc({
  discoveryIssuer: 'https://login.example.com/{tenant}/v2',
  acceptedIssuers: () => ['https://login.example.com/team-a/v2', 'https://login.example.com/team-b/v2'],
  mapUser: (claims) => ({ id: `${claims.iss}|${claims.sub}`, email: null, emailVerified: false, name: null, nickname: null, avatar: null }),
});
```

`acceptedIssuers` answers at once with a list; a function that returns a promise, throws or answers no list accepts no token. It is called
with the claims of the ID token, so a list can be built from a claim such as a tenant ID. The `iss` parameter of the callback (RFC 9207)
is then checked against the token: after the token passed every check, it must equal the token's `iss`. Without `acceptedIssuers`, the
`iss` parameter must be the issuer of the discovery document, and is checked before the code is traded.

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
- a `nonce` for a provider that sets `nonce: true`, and always for an [OpenID Connect provider](#openid-connect-providers), whose ID token must carry it back;
- the `intent`, a lower case word such as `sign-in` (the default) or `link`, the `userId` when you give one, and, for a confirmation, the `account` it is for.

Each of the three random values has 256 bits. The session keeps them. The address carries the state, the challenge and, for a provider with
`nonce: true`, the nonce; the verifier never leaves the session.

A flow lasts ten minutes. A provider has one slot per session, so starting a second flow for the same provider replaces the first, and
the first can no longer be completed. A flow of one provider never serves another.

Start the flow from a `POST` (a form button), not from a link: a `POST` carries the CSRF check, so another site cannot make a visitor's
browser open a flow, and a prefetching browser does not open one either.

| Option | Effect |
| --- | --- |
| `intent` | What the sign-in is for: lower case letters and dashes, starting with a letter, at most 32. Default `sign-in`. `confirm` asks for a fresh sign-in, see [Confirming with a provider](#confirming-with-a-provider). |
| `userId` | The user the flow belongs to. Required for `intent: 'confirm'`. |
| `account` | For `intent: 'confirm'` only, and required there: the id of the linked account at the provider, which the person must sign in with again. Any other intent throws a `TypeError`. |
| `scopes` | Scopes to ask for besides the provider's own (or `OAUTH_<NAME>_SCOPES`). Duplicates are dropped. All together, with `openid` where the provider is OpenID Connect, at most 64: more throws a `TypeError`. |
| `prompt` | `'select_account'` or `'consent'`, to show the provider's account chooser or consent screen. Any other value, `none` and `login` included, throws a `TypeError`. |

The flow sets `response_type`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method` and `nonce` itself, after
the `authorizeParams` of the provider, so nothing a provider adds can replace them. For `confirm` it also sets `prompt=login` and `max_age=0`, last.

`redirect()` answers with a `Result`:

| Error | Meaning |
| --- | --- |
| `unknown-provider` | The name is unknown, or the provider is inactive. The session is not touched. |
| `unavailable` | The provider's discovery gave no usable answer: no answer, a status other than 2xx, no JSON, a redirect, too large an answer, a timeout, or endpoints that are not usable. No flow is stored. An error in your own `endpoints()` code is not hidden as `unavailable`: it is thrown. |
| `reauthentication-unsupported` | `intent: 'confirm'` at a provider that is no `oidc()` provider. See [Confirming with a provider](#confirming-with-a-provider). No flow is stored. |

`redirect()` throws an `OAuthSetupError` with the code `A10` ([error codes](errors.md#server-error-codes)) when the app cannot run a flow at all:

- `SESSION_SAME_SITE=strict`, see [SameSite](#samesite);
- the session package is not installed, the session is not started (add the `StartSession` middleware), or the request may not write it, as with an island or a live validation;
- neither `OAUTH_<NAME>_REDIRECT_URL` nor `APP_URL` is set, or the one that is used is not a usable address;
- `http` in your `endpoints()` code is asked for an address that is not `https:` (or `http:` on a loopback host in development and test), or that carries a user name or a fragment.

The provider's own requests (discovery, and `http` in `profile`) go through the `HttpClient`: ten seconds at most, 1 MiB of answer, no redirect,
and no address of your own network unless the provider's `allowAddresses` lists its range. An answer that is not 2xx or not JSON is an error
that carries its status and never its body. Nothing logs the state, the verifier, the nonce or an address of the flow.

### The callback

The provider sends the browser back to `/auth/<provider>/callback` with a query. `OAuth.callback()` completes the flow from it:

```ts title="modules/auth/controllers/SocialCallbackController.ts"
import { Controller, type HttpContext } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';

export class SocialCallbackController extends Controller {
  readonly #oauth: OAuth;

  constructor(oauth: OAuth) {
    super();
    this.#oauth = oauth;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    const params = new URL(ctx.request.url).searchParams;
    const result = await this.#oauth.callback(ctx.params.provider, params);
    if (!result.ok) return this.back('/login');
    const { user, intent } = result.value;
    // `user` is the person the provider vouched for; `intent` is what the flow was started for.
    return this.redirect('/');
  }
}
```

Pass `{ userId }` when somebody is signed in. A flow that was started with a `userId` needs the same `userId` at the callback, or the answer is
`invalid`; a flow started without one serves only a guest. A confirmation is checked further once the profile is known: the account must be the one
it was started for (`invalid`) and the ID token must prove a fresh sign-in (`not-reauthenticated`).

Register it as a `GET` route with the same `everyone` rule as the start route, and put `.block()` on it:

```ts title="modules/auth/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';
import { SocialCallbackController } from './controllers/SocialCallbackController.ts';

export default defineRoutes((Route) => {
  Route.authorize(everyone).get('/auth/:provider/callback', SocialCallbackController).name('auth.social.callback').block({ lock: { minutes: 1 }, wait: { seconds: 10 } });
});
```

The code works once at the provider, but two callbacks that reach the server together can both take the flow from a session before either
stores it. [`block()`](routing.md#one-request-at-a-time) runs the requests of one session one after another, so the second finds no flow. A
second request waits up to `wait`, here 10 seconds, and then answers `423`; without `wait` it waits as long as `lock`. The lock needs the
cache's atomic locks. It must outlast a callback: the token request, the profile and a discovery can take 10 seconds each, so the default
lock of 10 seconds is too short, and a crashed request holds it for that long.

`callback()` throws, and does not answer, when the app is set up wrongly. It throws a `TypeError` for options of the wrong form. It throws an
`OAuthSetupError` with the code `A10` ([error codes](errors.md#server-error-codes)) when there is no session package, or no usable callback
address, or the provider's `profile()` asks `http` for an address that is not usable; the flow has left the session in the last two cases. An
error thrown by your own `endpoints()` code passes through unchanged, and so does none from your `profile()` or `mapUser`: those end in
`invalid-response`. A session that is not started, or that this request may not write, is not a setup error: it answers `invalid`, takes
nothing and sends nothing.

`callback()` checks the answer in this order and stops at the first refusal:

1. The provider is known and active (`unknown-provider`; the session is not touched).
2. The session is started and this request may write it, or the answer is `invalid` and nothing is taken: a request that cannot write the
   session could not spend the flow.
3. The flow leaves the session, before any check below, so a `state` works once even when a check fails (`no-flow` when there is none). A
   record of another form, or with times that do not fit a flow, is `invalid`.
4. The flow is not older than ten minutes (`expired`), and is the flow of this provider (`invalid`).
5. The flow's user matches the `userId` you pass: both or neither, and the same (`invalid`).
6. The `state` of the query is the one of the flow, compared in constant time (`invalid`). A missing, repeated or different `state` is refused.
7. An `iss` parameter must equal the provider's `issuer`, when the provider has one (`invalid`); an `oidc()` provider with `acceptedIssuers` is checked after the token is checked instead: the parameter must equal the `iss` of the ID token. A repeated `iss` is refused.
8. An `error` parameter ends the flow: `access_denied` is `cancelled`, any other is `provider-error` with the code (`unknown` unless it is a
   plain code). The provider's `error_description` is never read.
9. The `code` is one to 2048 characters (`invalid`).

Then the code goes to the token endpoint with the PKCE verifier and the same `redirect_uri` as the start, the client secret in the body or in a
Basic header as the provider's `clientAuth` says, and the provider's `profile()` and `mapUser()` give the person. The tokens are accepted only
as a token response of the form the standard gives: a bearer `access_token`, and no `error` field even in a `200`. `tokens.expiresAt` is
milliseconds since the epoch, and `tokens.scopes` the scopes the provider names, or the ones the flow asked for (the provider's, those of `redirect({ scopes })` and the added `openid`) when the response has no `scope` at all. A `scope` that is there but is neither a text nor a list of texts counts as none.

| Error | Meaning |
| --- | --- |
| `unknown-provider` | The name is unknown, or the provider is inactive. |
| `no-flow` | This session holds no flow of the provider: a second callback, another browser, or an expired session. |
| `expired` | The ten minutes are over. |
| `invalid` | The answer does not belong to the flow, or the session cannot be written. Start again. |
| `cancelled` | The person refused at the provider. |
| `provider-error` | The provider reported an error; `error` holds its code. |
| `unavailable` | The provider could not be reached, or answered with a server error. Try again later. |
| `rejected` | The token endpoint answered with a 4xx status for the code (a rate limit with 429 included), or with a `200` that has an `error` field. |
| `invalid-response` | The provider's answer is not usable: an ID token that fails a check (see [OpenID Connect providers](#openid-connect-providers)) or is missing, the token answer is no JSON object or has no usable `access_token` or a token type other than bearer, a `200` that is no JSON, a 4xx from your `profile()` request, code of the provider that threw, or a profile without a usable `id`. |
| `not-reauthenticated` | A confirmation without proof that the person signed in again: see [Confirming with a provider](#confirming-with-a-provider). |

No error carries a body or a message of the provider, and nothing logs the code, a token, the state or the query: a refusal logs the provider
and a fixed reason only. A second tab, an expired flow and a person who said no are logged at debug level; the other refusals at warn.

What `mapUser` returns is checked, not trusted. The `id` is kept exactly as given, one to 255 characters, with no white space at either end (an `id` such as `" 7 "` is refused, not trimmed into `"7"`) and no control or format character (such as a
zero-width space or a direction override). The `email` is trimmed,
one address (no white space, control or format character, or any of `<>(),;:"[]\`, and one `@`), at most 255 characters, and lower-cased in ASCII
only; anything else, or a character that lower-casing would change, makes it `null`. `emailVerified` is `true` only for exactly `true` next to
an address. A `name` or `nickname` of more than 255 characters, or with a control or format character, is `null`. An `avatar` is kept only as an `https:` address, normalised. A
`mapUser` that throws, is `async`, or returns a profile without a usable `id` ends in `invalid-response`.

### SameSite

The browser returns from the provider with a request that starts on another site. A session cookie with `SameSite=Strict` is not sent with
it, so the callback would find no session and no flow, and every sign-in would fail after the person had already signed in at the provider.
`redirect()` throws an A10 error under `SESSION_SAME_SITE=strict` for that reason. Keep `lax` (the default), or `none` over `https`.

## Signing users in

Set up first: register the providers ([configuring a provider](#configuring-a-provider)), copy the migration of the `social_accounts` table
([storing tokens](#storing-tokens)) and set the variables of each provider.

`SocialAccounts` (from `@marmeon/oauth/accounts`) turns the result of a finished flow into a signed-in user. It takes only the
`SocialUser` that `OAuth.callback()` returned, and only for the intent of the call: `signIn()` needs a flow that began as a sign-in and
`link()` one that began as a link. Anything else, a copy of the object or the result of the other intent, throws a `TypeError`.
Everything it decides on (provider, ID, address, whether the provider verified the address) it reads from what the flow recorded.

The package never makes a user itself. The app says how users are found and made by binding `SocialUserProvider`. The class below follows
the `UserRepository` of the starter kit. A user who registers with a provider has no password; see
[Accounts without a password](authentication.md#accounts-without-a-password) for how the starter kit keeps such a user. Add this method to your `UserRepository`:

```ts
/** A new user from a provider: no password, and a confirmed address only when the provider vouched for it. */
registerSocial(values: { name: string; email: string; locale: string; verifiedAt: Date | null }): Promise<Result<User, { kind: 'duplicate' }>> {
  const { verifiedAt, ...rest } = values;
  return this.tryInsert({ ...rest, password: null, session_key: randomBytes(32).toString('base64url'), email_verified_at: verifiedAt, first_verified_at: verifiedAt });
}
```

```ts title="modules/auth/SocialUsers.ts"
import { Clock } from '@marmeon/core';
import type { SocialUser } from '@marmeon/oauth';
import type { SocialUserProvider } from '@marmeon/oauth/accounts';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';

export class SocialUsers implements SocialUserProvider<User> {
  readonly #users: UserRepository;
  readonly #clock: Clock;

  constructor(users: UserRepository, clock: Clock) {
    this.#users = users;
    this.#clock = clock;
  }

  async findByEmail(email: string) {
    // The address is unvalidated data of the provider: normalize it as the app does for every address.
    const user = await this.#users.findByEmail(email.trim().toLowerCase());
    return user && { user, emailVerified: user.email_verified_at != null };
  }

  /** The same question the password reset asks of the column: is `email_verified_at` set? */
  emailConfirmed(user: User): boolean {
    return user.email_verified_at != null;
  }

  create(social: SocialUser & { readonly email: string }, { emailVerified }: { emailVerified: boolean }) {
    // Store the address as confirmed only when `emailVerified` is true: the provider vouched for it, nobody else did.
    return this.#users.registerSocial({
      name: social.name ?? social.nickname ?? social.email,
      email: social.email.trim().toLowerCase(),
      locale: 'en',
      verifiedAt: emailVerified ? new Date(this.#clock.now()) : null,
    });
  }
}
```

```ts title="modules/auth/AuthServiceProvider.ts"
import type { Container } from '@marmeon/core';
import { SocialUserProvider } from '@marmeon/oauth/accounts';
import { SocialUsers } from './SocialUsers.ts';

export class AuthServiceProvider {
  register(container: Container): void {
    container.bind(SocialUserProvider, SocialUsers);
  }
}
```

`create` answers `err({ kind: 'duplicate' })` when another registration took the address first. The address it gets has no control
characters and is at most 254 characters, but it is not checked as an address. Without a binding, the first call that needs a user
(`signIn()` looking up an address, `link()` checking the user's address) throws an `OAuthSetupError` (A10) that says so; a sign-in with an
account that is linked already needs no binding. A bound class that cannot be built fails with its own error.

`signIn(social)` answers `Result<SocialSignIn, SocialSignInError>` and follows three rules, in this order:

1. **A linked account signs in its owner.** The provider account is found by provider and provider ID, never by address. The owner is
   signed in, or `two-factor-required` is answered when the account has a second factor, exactly as for a password. The time of the
   sign-in, the address and the nickname are noted. If the account was unlinked in the meantime, or its user is gone, nobody is signed in
   and the answer is `account-exists`. An account that is linked signs in whatever the provider says about the address.
2. **A matching address links the account, only when nothing is left to doubt.** The provider has verified the address, the app has
   confirmed it for the user it finds, and that user has no second factor (`TwoFactorState`). Then the account is linked,
   `SocialAccountLinked` is dispatched and the user is signed in. In every other case the answer is `account-exists`, and
   `providerVerified` says whether the provider vouched for the address. Nothing is linked: the person signs in the usual way and links
   the provider account from their settings. A user with a second factor never signs in around it.
3. **Otherwise a new user is made.** With `OAUTH_REGISTRATION=false` the answer is `registration-closed` and nothing is created.
   The user and the link are written in one transaction. A provider account taken in the meantime undoes the user as well, and the answer is
   `account-exists`.
   The app's `Registered` event is dispatched in that transaction, after the link, as the registration of the app does.
   `create` receives `emailVerified`; store the address as confirmed only when it is `true`.
   The new user is signed in and the answer is `signed-in` with `created: true`.

With private registration (`AUTH_PRIVATE_REGISTRATION`, on by default) an address the provider did not verify is refused with
`email-unverified` before any address is looked up. Nothing is made or linked, and the answer is the same whether or not an account has
the address, so it tells nobody which addresses are registered. The page tells the person to verify the address at the provider, or to sign
in the usual way. With open registration (`AUTH_PRIVATE_REGISTRATION=false`) rule 3 applies to such an address as it is.

The other kinds of refusal:

- `signed-in`: somebody is signed in already. It is answered before any account is looked up.
- `email-required`: the profile has no address and its account is not linked.
- `invalid-account`: the provider's data cannot be stored. An ID that is empty, only white space, longer than 255 characters, not well
  formed text or holds a control character, an address that is longer than 254 characters, not well formed text or has a control character
  (a line break, say), and a nickname that is not well formed text or has a NUL are refused, never cut or repaired.

### Linking and unlinking

`link(social)` adds a provider account to the signed-in user, `unlink(provider)` removes one, and `list()` answers the user's accounts with
the provider's label. Both changes need a recent confirmation of the user (`auth.passwordRecentlyConfirmed()`), which a password or a provider
[opens](#opening-the-confirmation-window). The check is made inside
`SocialAccounts`, not only by a middleware, and the answer `confirmation-required` tells the page to ask for the confirmation first: with a password, or with a provider that
[opens the window](#opening-the-confirmation-window).
`link()` throws a `TypeError` for the result of a flow that another user began: for `link()` that is a programming error. `confirm()` answers
`not-linked` instead, because a returning tab shows it there too.

`link()` answers `Result<SocialAccountSummary, SocialLinkError>`:

- `signed-out`: nobody is signed in.
- `confirmation-required`: the confirmation is not recent.
- `email-unconfirmed`: `SocialUserProvider.emailConfirmed()` did not answer `true` for the user. A password reset removes every linked account
  of an account whose address is not confirmed (`email_verified_at` is `null` or missing) in the transaction of the reset, because
  whoever registered the address first may have linked one. A link made before the address is confirmed would be one of those. The reset
  reads the column, not `emailConfirmed()`, so the method must mean the same. Each removal is logged with the user's ID and the number
  of accounts, never an address.
- `invalid-account`: the provider's data cannot be stored, as above.
- `taken`: the provider account belongs to another user. A provider account is never moved.
- `provider-linked`: the user has an account at this provider already.

Linking an account the user holds already adds nothing and dispatches no event, but it updates the address, the nickname, the time and the
tokens, as a sign-in does.

`unlink()` answers `Result<void, SocialUnlinkError>`. Besides `signed-out` and `confirmation-required`, it answers `not-found` when the
user has no account at that provider, and `last-method` when it would be the last way in. The account goes only if the user still has
a password, a passkey (`TwoFactorState` must know passkeys: without a bound source no passkey counts) or an account at a provider that is
active. An account at a provider that is not active, or that the app no longer registers, is no way in. Nothing is deleted when the
answer is `last-method`.

The summary of each account carries `canConfirm`: `true` for an active [`oidc()`](#openid-connect-providers) provider, the only kind that can be
offered for a [confirmation](#opening-the-confirmation-window); a provider that sends no `auth_time` still fails it. An account without a password
confirms through a linked provider that can; an account that has only a
GitHub or Discord login cannot confirm at all, and can link or unlink nothing until it has a password, which a reset link to its address gives it.

`SocialAccountLinked` (user, provider, address, nickname) and `SocialAccountUnlinked` (user, provider) are dispatched after the change is
stored, never for a refusal. Register a listener in a module, as [Registering listeners](events.md#registering-listeners) shows:

```ts title="modules/auth/index.ts"
import { defineModule, listen } from '@marmeon/core';
import { SocialAccountLinked } from '@marmeon/oauth/accounts';
import { NotifyAboutLinkedAccount } from './listeners/NotifyAboutLinkedAccount.ts';

export default defineModule({
  name: 'auth',
  listeners: [listen(SocialAccountLinked, NotifyAboutLinkedAccount)],
});
```

## Confirming with a provider

Some actions ask a signed-in person to prove who they are once more, such as deleting an account. `redirect()` with the intent `confirm` does that
at the provider: the person has to sign in again there, and the package checks that they did.

```ts
const result = await oauth.redirect('idp', { intent: 'confirm', userId: user.id, account: id }); // a Result: `result.value` is the address to send the browser to
```

[Opening the confirmation window](#opening-the-confirmation-window) shows the whole controller, including where `id` comes from.

`account` is the id of the account that was linked, the same id `callback()` hands back as `user.id`. A fresh sign-in at the provider with
another account is refused (`invalid`), since it proves nothing about the account that is linked.

`userId` and `account` are required (without either, `redirect()` throws a `TypeError`), and the callback must be given the same `userId`. The flow adds
`prompt=login` and `max_age=0` to the authorization request after everything else, so a `prompt` option cannot soften them.

Only [`oidc()`](#openid-connect-providers) providers can confirm, because only an ID token can say when the person signed in, and among the [built-in providers](#the-built-in-providers) only Microsoft does. GitHub, Google, GitLab, Discord and
your own OAuth 2.0 providers never confirm: `redirect()` answers `reauthentication-unsupported` and opens no flow. There is no fallback to a weaker
proof, such as asking again for the same session. Some providers leave `auth_time` out unless you request it in their app settings; without it every confirmation at that provider fails.

The callback accepts a confirmation only when the ID token that passed the checks carries a numeric `auth_time` that is no earlier than the
redirect minus 10 seconds (the drift between the clocks of the provider and of the server) and no later than now plus 60 seconds. A missing,
non-numeric, old or future `auth_time` answers `not-reauthenticated`; `iat` never takes its place. A confirmation is spent like any flow: a second
callback with the same state answers `no-flow`. The callback proves only that the id the provider vouched for equals the `account` it was given. Your app knows the person confirmed when
[`SocialAccounts.confirm()`](#opening-the-confirmation-window) answers `ok`; act on that and on nothing else.

### Opening the confirmation window

`SocialAccounts.confirm(social)` turns that answer into the confirmation window of the signed-in user: the same window a typed password opens, counted
from the sign-in at the provider. It lasts `AUTH_PASSWORD_TIMEOUT_SECONDS` from then, so `link()`, `unlink()` and the guards that ask
`auth.passwordRecentlyConfirmed()` accept it. It needs no password, so accounts that have none can use it.

`accounts.accountId(provider)` answers the id of the signed-in user's account at a provider, which `redirect()` takes as `account`, so no id is
typed by hand. It answers `undefined` when nothing is linked there:

```ts title="modules/auth/controllers/StartConfirmationController.ts"
import { Auth } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';

export class StartConfirmationController extends Controller {
  readonly #auth: Auth;
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;

  constructor(auth: Auth, oauth: OAuth, accounts: SocialAccounts) {
    super();
    this.#auth = auth;
    this.#oauth = oauth;
    this.#accounts = accounts;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    const userId = await this.#auth.id();
    const account = await this.#accounts.accountId(ctx.params.provider);
    if (userId === undefined || account === undefined) return this.back('/settings/accounts');
    const result = await this.#oauth.redirect(ctx.params.provider, { intent: 'confirm', userId, account });
    // `reauthentication-unsupported`, `unknown-provider` and `unavailable` are answered here: the page tries another way.
    if (!result.ok) return this.back('/settings/accounts');
    return this.redirect(result.value.href).status(303);
  }
}
```

The callback route (with `Route.block()`) completes the flow and opens the window:

```ts title="modules/auth/controllers/ConfirmCallbackController.ts"
import { Auth } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';
import { SocialAccounts } from '@marmeon/oauth/accounts';

export class ConfirmCallbackController extends Controller {
  readonly #auth: Auth;
  readonly #oauth: OAuth;
  readonly #accounts: SocialAccounts;

  constructor(auth: Auth, oauth: OAuth, accounts: SocialAccounts) {
    super();
    this.#auth = auth;
    this.#oauth = oauth;
    this.#accounts = accounts;
  }

  async handle(ctx: HttpContext<{}, { provider: string }>) {
    const userId = await this.#auth.id();
    if (userId === undefined) return this.back('/login');
    const params = new URL(ctx.request.url).searchParams;
    const result = await this.#oauth.callback(ctx.params.provider, params, { userId });
    if (!result.ok || result.value.intent !== 'confirm') return this.back('/settings/accounts');
    const confirmed = await this.#accounts.confirm(result.value.user);
    return this.redirect(confirmed.ok ? '/settings/accounts' : '/settings/accounts?confirm=failed');
  }
}
```

`confirm()` takes only the result of a flow that began as a confirmation, and checks again on its own side what it relies on: the flow was this
user's, the provider account is linked to this user (looked up in the table, never read from the flow), and the sign-in at the provider
is recent. It answers `Result<void, SocialConfirmError>`:

- `signed-out`: nobody is signed in.
- `not-reauthenticated`: the result carries no fresh sign-in at the provider.
- `not-linked`: the flow was another user's, or the provider account is not linked to the signed-in user. Another user's account, one that is
  not linked and one at another provider open nothing.
- `expired`: a confirmation as recent or more recent is held already, the provider sign-in lies before this session's sign-in, the proof waited too long, or the request cannot write the session.

Every answer of `confirm()`, a refusal too, spends the result: the person confirms again. A second `confirm()` with the same object throws a `TypeError`, as
does a result that did not come from a confirmation flow. Another user's flow and an account that is not linked answer `not-linked`.
`summary.canConfirm` tells a settings page which providers to offer. A refresh of the account that fails after the window is open is logged
(the provider and a fixed reason) and the answer stays `ok`. No event is dispatched: the window is not a change of the account.

`SocialAccountsServiceProvider` claims the re-authentication name `oauth` when it registers, and holds the capability to issue proofs. A second
registration on the same container, a registration on a request's scope and one after the auth provider has booted stop with the code `A12` ([error codes](errors.md#server-error-codes)).

## Testing

`fakeOAuth()` of `@marmeon/oauth/testing` makes every provider answer from the test's `app.http`, so no request leaves the process and every check of the
flow still runs: the state, the PKCE verifier against the challenge of the authorization, the nonce, the checks of the ID token, and the confirmation with
`account` and `auth_time`. The test queues the person a provider vouches for, starts the flow through the routes of the app (the ones under
[the flow](#the-flow-and-its-security) and [the callback](#the-callback)), and asks the fake for the address the provider would send the browser back to.
Start and callback must be one browser, since the flow lives in its session: use `app.keepingCookies()`.

```ts
import { fakeOAuth } from '@marmeon/oauth/testing';

const oauth = fakeOAuth(app).user('github', { id: '42', email: 'ada@example.com', emailVerified: true });
const browser = app.keepingCookies();
const start = await browser.post('/auth/github/start').assertStatus(303);
await browser.get(oauth.callbackUrl(start)).assertRedirect('/');
```

A confirmation needs the signed-in user in that browser and a provider that can prove a fresh sign-in:

```ts
const oauth = fakeOAuth(app).user('microsoft', { id: '42' }).reauthenticated('microsoft');
const browser = app.actingAs(user).keepingCookies();
const start = await browser.post('/account/confirm/microsoft'); // your route calls oauth.redirect('microsoft', { intent: 'confirm', userId, account })
await browser.get(oauth.callbackUrl(start)).assertRedirect('/account/delete');
```

Every provider keeps what it can do in production, in three groups. Plain OAuth 2.0 providers (GitHub, Discord and your own) never confirm, and
`reauthenticated()` throws for them. Google and GitLab are OpenID Connect fakes that cannot confirm either, and throw the same. Microsoft and your own `oidc()`
providers can confirm after `reauthenticated()`; without it the ID token has no `auth_time`, and `staleAuthentication()` makes it too old. The fake of an `oidc()` provider keeps
the provider's own mapping over the claims it issues, so `emailVerified: true` counts only where the provider would vouch for the address (Google for a gmail.com
address or with `claims: { hd }`, GitLab for gitlab.com, never Microsoft), and the `id` is what the mapping makes of the `sub` (Microsoft puts the tenant in front of it). A plain
OAuth 2.0 provider's own `profile()` and `mapUser()` do not run, and `emailVerified` is what the test says: an own provider that never vouches for an address does vouch in a test.

The fake builds each provider through the checks of the start, so a definition the start refuses (A11) fails in `fakeOAuth()` too. The members are in the table under [social login](fakes.md#social-login).

## Storing tokens

`@marmeon/oauth/accounts` keeps the accounts people link in the `social_accounts` table. A row holds the provider, the provider's ID for the
account, and the e-mail address and nickname the provider reported last. Two unique indexes carry the rules: one provider account belongs to
one user (`provider`, `provider_id`), and one user links one account per provider (`user_id`, `provider`). A provider account is never moved
to another user: creating a link for an account that exists is refused with `taken`, and a second account at one provider with
`provider-linked`. A provider ID is at most 255 characters, the limit of an OpenID Connect `sub`; the store throws a `TypeError` for a longer
one or an empty one and never cuts it. Deleting a user deletes their rows.

Copy this migration into the module that owns your users. The table points at your `users` table:

```ts title="modules/auth/migrations/2026_11_18_100000_create_social_accounts_table.ts"
import { defineMigration } from '@marmeon/database';

// The accounts people sign in with at a provider. Two unique indexes carry the rules: (provider, provider_id) says one provider account
// belongs to one user, and (user_id, provider) says one user links one account per provider. The tokens are secret columns, empty
// unless OAUTH_STORE_TOKENS is on, and hold ciphertext only. The e-mail address and nickname are what the provider reported last, as text: a provider's length is no limit of ours, and neither is ever a key.
export default defineMigration({
  up: (schema) =>
    schema.create('social_accounts', (table) => {
      table.id();
      table.foreignId('user_id').constrained('users').cascadeOnDelete();
      table.string('provider', 32);
      table.string('provider_id', 255);
      table.text('email').nullable();
      table.text('nickname').nullable();
      table.text('access_token').nullable().secret();
      table.text('refresh_token').nullable().secret();
      table.timestamp('token_expires_at').nullable();
      table.text('scopes').nullable();
      table.timestamp('last_used_at').nullable();
      table.timestamps();
      table.unique(['provider', 'provider_id']);
      table.unique(['user_id', 'provider']);
    }),
  down: (schema) => schema.drop('social_accounts'),
});
```

Add the provider to the module that owns your users. It needs a database and an `APP_KEY` for the encryption of the tokens. Readiness stays red
until the table has every column the store reads and the token columns are marked `.secret()`.

```ts title="modules/auth/index.ts"
import { defineModule } from '@marmeon/core';
import { SocialAccountsServiceProvider } from '@marmeon/oauth/accounts';
import { AuthServiceProvider } from './AuthServiceProvider.ts';

export default defineModule({
  name: 'auth',
  providers: [AuthServiceProvider, SocialAccountsServiceProvider],
  // …
});
```

`SocialAccountsServiceProvider` registers `SocialAccountStore` and `SocialAccounts`, and reads two variables:

| Variable | Default | Effect |
| --- | --- | --- |
| `OAUTH_REGISTRATION` | `true` | Whether a sign-in at a provider may create a new user. `false` answers `registration-closed`; accounts that are linked still sign in. |
| `OAUTH_STORE_TOKENS` | `false` | Whether the access and refresh token of a provider are stored. |

The tokens are **not stored** unless you turn `OAUTH_STORE_TOKENS` on: sign-in needs the provider's profile, not a token that outlives the
request, and a token you never use is only a risk. When it is on, both tokens are encrypted with the app key before they are written, and the
encryption context names the row (`social_accounts:<provider>:<provider_id>:access_token`), so a ciphertext copied into another row does not
decrypt. The token columns are secret columns: a `select *` does not return them. Read them with `store.tokens(userId, provider)`, which
decrypts, and which returns `undefined` while the variable is off. It throws a `DecryptError` for a token that does not decrypt: one moved to
another row, or one sealed with a key that is no longer in `APP_KEY` or `APP_PREVIOUS_KEYS`, so keep an old key listed until the tokens
sealed with it are replaced (they are, at the next sign-in of the account).

A sign-in that sends no refresh token keeps the one stored, and seals it again with the current key, so the stored token follows a key
rotation. A stored token that no key decrypts stays as it is until the provider sends a new one or the key is listed again, and the sign-in
still succeeds. Turning the variable off again clears the tokens of an account the next time it
signs in. To clear them all at once, run one statement:

```sql
UPDATE social_accounts SET access_token = NULL, refresh_token = NULL, token_expires_at = NULL, scopes = NULL;
```

`remove(userId, provider, otherMethod)` unlinks an account in one transaction that locks the user's rows. It resolves with the removed
account, with `not-found` when the user has none at the provider, or with `last-method` (changing nothing) when `otherMethod` says no. It
always asks `otherMethod(remaining)`, with the user's remaining accounts, so the caller decides what counts as a way in: a password, a
passkey, or an account at a provider that is still active. A passkey removed at the same moment is outside that lock; the
[password reset](passwords.md) remains the way back in.
