# Upgrading

This page lists every change between one version and the next that an app has to act on: how likely it is to affect your app, what to do, and the way back where there is one. The
[release policy](docs/releases.md#what-a-version-promises) says what a version promises.

## Upgrading to 0.3.0 from 0.2.0

#### High: A server listens on 127.0.0.1 unless `HOST` says otherwise

*Likelihood of impact: high — every app that runs `marmeon start` or `marmeon dev` outside the generated Docker image or the systemd unit and has to be reached from another machine.*

Before, a server without `HOST` listened on every interface. Now `HOST` defaults to `127.0.0.1` in every environment, and `startServer()` falls back to it as well, so the server answers only the machine it runs on. A buildpack or PaaS that runs `marmeon start` itself, a load balancer or proxy on another host and a phone on the LAN that tests `marmeon dev` no longer reach it.

Set the interface the server must answer on:

```sh
HOST=0.0.0.0
```

Behind a proxy on the same machine, in the generated image (its Dockerfile sets `HOST=0.0.0.0`) and with the systemd unit (`HOST=127.0.0.1`), nothing changes. Code that calls `heldOnLoopback(port, undefined)` directly has to pass the host, a plain `string`.

The start line shows `127.0.0.1` as `http://localhost:PORT`. On macOS a program on `::` or `::1` with the same port does not stop a server on `127.0.0.1`, and `localhost` then reaches that program: before listening, the start tries `[::1]:PORT` and warns once when something answers (`PORT=0` skips the check).

The way back is `HOST=0.0.0.0`, which listens on every interface as before. See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md).

#### High: Accounts keep a session key that `UserProvider.updateSessionKey()` compares and sets

*Likelihood of impact: high — apps made with `make:auth` and every custom `UserProvider` or `RememberTokenStore`.*

`AccountSessions.end(id)` is new: it ends every session of an account on any session driver by deleting its remember-me tokens, rotating its session key and removing the session rows a store can find. For it, and for the races around password changes and signing out other devices, `UserProvider.updateSessionKey(id, key, expected)` is now a compare-and-set, `RememberTokenStore` has an `exists()` and `auth.updateSessionKey()` returns a `boolean`. A provider that returns nothing from `updateSessionKey()` makes the call throw, with the remedy in its message.

What the app has to do:

- **Apps made with `make:auth`:** add a nullable, secret `session_key` column to `users` (`table.string('session_key', 64).nullable().secret()`), and take `updateSessionKey()` and the `sessionKey` in `#credentials` from the stub's `UserRepository.ts`. Port `commands/ResetTwoFactorCommand.ts`: inject `AccountSessions`, call `end()` before removing the factors and check the factors again afterwards; without it `auth:reset-two-factor` leaves a lost device signed in, which can enrol a first factor of its own. Optionally copy `commands/EndSessionsCommand.ts` and register it for `marmeon auth:end-sessions <email> --force`.
- **A custom `UserProvider`:** `updateSessionKey(id, key, expected: string | null | undefined): Promise<boolean>`. With a string or `null` it writes only if the stored key equals `expected` (`IS NULL` for `null`), in one statement, and returns whether it wrote; with `undefined` it writes regardless. `findById` has to hand the key back as `sessionKey`.
- **A custom `RememberTokenStore`:** `exists(cookie): Promise<boolean>`, by selector and consistent with `forgetUser()` at once (no cache, no lagging replica).
- Code that uses the result of `auth.updateSessionKey()`: `false` means this session was ended meanwhile and is signed out.

There is no way back; the interfaces require the new members. See [Authentication](docs/authentication.md).

#### High: Changing a second factor needs a second factor proven in the last 15 minutes

*Likelihood of impact: high — apps with two-factor authentication or passkeys, made with `make:auth` or with their own routes for these methods.*

`TwoFactor` (`begin`, `setup`, `regenerateRecoveryCodes`, `disable`) and `Passkeys` (`registrationOptions`, `register`, `remove`, `release`) require the second factor proven within the last 15 minutes (`FACTOR_CHANGE_MAX_AGE`) on an account that has one, and throw otherwise. Without the new middleware the two-factor and passkey routes answer 500 for such accounts once the proof is older, and the e-mail change and the API-token creation are refused only by this middleware. `confirm()` records a fresh proof only for the first factor, and registering the first passkey drops a TOTP setup begun before it.

Add `confirmedSecondFactor({ verify: 'auth.two-factor.verify' })` after `confirmedPassword()` (accounts without a factor pass it):

```ts
import { confirmedSecondFactor } from '@marmeon/auth/two-factor';

const factors = sudo.middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' }));

factors.post('/settings/tokens', CreateAccessTokenController);
```

and register these routes on `factors`: the two-factor settings page, setup, recovery codes and disable, the passkey page, options, store, release and remove, and `POST /settings/tokens`. For `PUT /settings/email`, add `.middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' }))` after `confirmedPassword()` in its own chain and keep `throttle('email-change')`, as the stub does. Leave it off two-factor confirm, verify, the step-up routes and the passkey rename. The stub's `routes.ts` shows all of it. Also add `await twoFactor.requireRecentProof('changeEmail')` at the start of your `UpdateEmailController`, as the stub does, so an e-mail route added without the middleware is refused too.

There is no way back. See [Two-factor authentication](docs/two-factor-authentication.md).

#### High: The `cookie` session driver is gone

*Likelihood of impact: low — only apps that set `SESSION_DRIVER=cookie`.*

A session kept in the cookie lives in the browser, so the server cannot end it: signing out other devices, a password change or `AccountSessions.end()` never reached it. `SESSION_DRIVER` accepts `file` (the default), `database`, `redis` or `memory`, and an app that still sets `cookie` fails at boot with a message naming the four.

Choose one: `file`, `database` (publish the table with `make:session-table`) or `redis`. Existing cookie sessions end once; users sign in again.

In code: `CookieSessionStore` (`@marmeon/session`) and `COOKIE_SESSION_WARNING` (`@marmeon/auth`) are removed; `SessionConfig['driver']` no longer includes `'cookie'`, so a comparison against it stops compiling; `new UserSessions(store)` requires its store.

There is no way back. See [Sessions](docs/session.md).

#### High: Remember-me tokens are bound to the account state and need an `account_fingerprint` column

*Likelihood of impact: high — apps made with `make:auth` and every app with its own `RememberTokenStore` or `UserProvider`.*

Before, a remember-me token signed the account in as long as its row existed. Now each token stores the fingerprint of the account state the sign-in verified (the one sessions keep: a SHA-256 of the id, the password hash and the session key), and a cookie signs in only while the account still has it. A password reset, a new password, a new session key, `AccountSessions.end()` and a rehash after changed `HASH_*` costs therefore end every remember-me token of the account, not only its sessions. A token without a fingerprint is refused. `attempt()` also compares the account it verified with a fresh `findById()` after the password check, and answers `invalid-credentials` if the hash or the key changed meanwhile.

What the app has to do:

- **Add the column before the new code serves requests.** Until `remember_tokens.account_fingerprint` exists, remember-me sign-ins and requests with a remember-me cookie fail with a database error. Apps made with `make:auth` before this release need a migration, named with the current timestamp:

  ```ts
  import { defineMigration } from '@marmeon/database';

  export default defineMigration({
    up: (schema) => schema.alter('remember_tokens', (table) => table.string('account_fingerprint', 64).nullable()),
    down: (schema) => schema.alter('remember_tokens', (table) => table.dropColumn('account_fingerprint')),
  });
  ```

  Run it with `marmeon migrate`. The remember-me cookies of existing devices stop working once; those users sign in again.
- **A custom `RememberTokenStore`:** `create(userId, expiresAt, fingerprint)` takes the fingerprint (a third, required parameter), stores it and returns it from `consume()` as `fingerprint`. `rebind(userId, cookie, fingerprint)` is optional: it keeps the device that changes its own key (`updateSessionKey()`, `logoutOtherDevices()`) signed in. Without it that device signs in again.
- **A custom `UserProvider`:** `findForLogin()` returns `sessionKey` exactly as `findById()` does. If only one of them returns a key, `attempt()` throws an error that names the provider.

There is no way back; a token without a fingerprint is never accepted. See [Authentication](docs/authentication.md#remember-me).

#### High: `marmeon start` refuses a development `NODE_ENV` that comes from `.env`

*Likelihood of impact: high — every app that runs `marmeon start` or `pnpm start` locally, and every server, container, CI job or end-to-end test that gets `NODE_ENV` from a `.env` file.*

Before, `marmeon start` served the app with the development tools (Vite, devtools, mail previews, error pages with source code) whenever `.env` said `NODE_ENV=development`, which is what the starter `.env` says, and only logged a warning. Now `marmeon start` and the hidden `marmeon serve` exit with 1 before any app code loads when `NODE_ENV=development` or `test` comes from `.env` alone. The message names the way out. `marmeon dev`, a `NODE_ENV` set in the process environment, and a `.env` without `NODE_ENV` or with `production` are unchanged. `queue:work` and `schedule:work` only warn, as before.

What the app has to do:

- **To try the build on your machine:** `NODE_ENV=production marmeon start` (`pnpm start` is the same, the app's `start` script is `marmeon start`).
- **To run the development stack through `start` on purpose:** set `NODE_ENV=development` in the shell, or use `marmeon dev`.
- **Servers, containers, systemd units, CI jobs and `webServer` entries of end-to-end tests** that relied on `.env` for `NODE_ENV` set `NODE_ENV=production` in the real environment. The generated Docker image and a server that already sets it need no change.

The way back is `NODE_ENV=development` in the process environment, which is only worth it on a machine that is meant to run the development stack. See [Configuration](docs/configuration.md) and [Deployment](docs/deployment.md).

#### Medium: A passkey confirms sudo mode, and some actions ask for the password again

*Likelihood of impact: medium — apps that bind passkeys, and apps that call `Passkeys.remove()` or `TwoFactor.regenerateRecoveryCodes()` themselves.*

A passkey proven now, with user verification, confirms sudo mode like a typed password, and a passwordless passkey sign-in counts as a fresh confirmation. So `passwordRecentlyConfirmed()` and `confirmedPassword()` no longer mean "a password was typed". This applies the moment the app upgrades: a passwordless passkey sign-in reaches `confirmedPassword()` routes straight away, whether or not the app adds the passkey confirmation routes. In a kit app made before this release the e-mail and API-token forms do not ask for the current password, so a passkey holder (who also passes `confirmedSecondFactor()`) can change the address or create a token until the app copies those fields. An action that lets whoever holds the passkey stay in the account has to ask for the current password in its own form, as the kit does for the e-mail change, API-token creation, removing any passkey and regenerating recovery codes.

- `Passkeys.remove(id, password)` needs the password for every passkey; a call without one gets `invalid-password`.
- `TwoFactor.regenerateRecoveryCodes(password)` takes the password and returns a `Result` (`invalid-password` | `throttled`) instead of the codes.
- A `throttled` error from a password check may carry `account: true`: the account's cap held it up, and signing in again with the password lifts it. Password checks count per sign-in (5 a minute, 20 an hour) plus a per-account cap of 20 an hour for sessions that did not begin with a typed password. Existing sign-ins count against that cap until the user signs in again with the password. `takePasswordCheck()`, `clearPasswordCheck()` and `Auth.passwordCheckScope()` are public for app code.
- `TwoFactorChallengeFailed.during` can be `'confirm'`; an exhaustive `switch` over it stops compiling until it handles the value.
- Apps built from the kit: copy the current-password fields on the e-mail, API-token and recovery-code forms first, then the passkey confirmation controllers and routes (`auth.password.confirm.passkey.options`, `auth.password.confirm.passkey`), the new `throttle.ts` (per sign-in, with `auth`) and the sign-out of other devices in `RemovePasskeyController` from `packages/auth/stubs/react/modules/auth`.

Sudo mode also needs a confirmation made within the current sign-in, a typed password or a passkey proven now. After `auth.login(user)` (a magic link, OAuth, impersonation) a route behind `confirmedPassword()` asks again, even once the second factor is completed. A confirmation older than the current sign-in, including one left in the session by an earlier account, does not count.

There is no way back. See [Authentication](docs/authentication.md#sudo-mode) and [Passkeys](docs/passkeys.md#confirming-sudo-mode).

#### Medium: Sign-ins, remember-me cookies and second-factor proofs have upper bounds

*Likelihood of impact: medium — apps with `twoFactor()` areas, apps whose users stay signed in for more than a day, and apps with their own `RememberTokenStore`.*

- `twoFactor()` without `maxAge` accepts a proof for 24 hours (`TWO_FACTOR_MAX_AGE`) instead of for the whole session; pass `maxAge` (seconds) for another window, there is no "never". A remember-me sign-in carries the proof of the device that made the token, so a token older than the window asks for the factor again.
- `AUTH_REMEMBER_DAYS` accepts 0 to 30 (default 30); a value outside that stops the boot. A token older than the setting is refused even if its row says otherwise, and `auth:prune-tokens` deletes it, so schedule that command (the kit runs it daily). With `0` no remember-me cookie is made, a presented one signs nobody in and the kit hides the checkbox.
- A sign-in lasts at most `AUTH_SESSION_MAX_HOURS` (default 24, up to 720) from the moment it was made, however active the user is, so users without remember-me are signed out 24 hours after signing in. A session restored by a remember-me cookie also ends with that token. Sessions open at deploy time start their clock at their next request, so this limit cuts nobody off at deploy. A valid remember-me cookie signs the user in again in the same request. Raise the value if 24 hours is too short; tests that jump the clock past 24 hours need a higher value too.
- A custom `RememberTokenStore`: `prune(maxAgeDays: number)` deletes expired tokens and those made `maxAgeDays` or more days ago, and `consume()` must return a valid `createdAt` and `expiresAt`, or every remember-me sign-in is refused.
- Apps made with `make:auth`: `ShowLoginController` passes `remember: config.remember`, and `Login.tsx` renders the checkbox only when it is true (see the stub).

The way back is a larger `AUTH_SESSION_MAX_HOURS` (at most 720) and a `maxAge` on `twoFactor()`; the 30-day cap on remember-me has none. See [Authentication](docs/authentication.md).

#### Medium: The session cookie ends when the browser closes

*Likelihood of impact: medium — every app with sessions; no configuration changes, but what users notice does.*

The session cookie and `XSRF-TOKEN` are sent without `Max-Age`. The server still ends a session after `SESSION_LIFETIME` of inactivity and a sign-in after `AUTH_SESSION_MAX_HOURS`, whatever the browser keeps.

- Users who do not tick "Keep me signed in" are signed out when the browser closes (unless the browser restores its session, and then it keeps the cookie).
- A guest's session data ends at browser close: the chosen locale, the intended URL, flash data and anything the app keeps in the session, such as a cart. Keep what has to outlive the browser somewhere else.
- Remember-me users go through a remember-me sign-in after every browser restart: the token rotates, `viaRemember()` is true, the session is new (new CSRF token, no old input), sign-in events fire more often, and `twoFactor()` areas ask again once the token's factor proof is older than their `maxAge`.
- App tests that assert `Max-Age` on the session cookie or `XSRF-TOKEN` need updating.

There is no way back; remember me is how a user stays signed in across a browser restart. See [Sessions](docs/session.md).

#### Medium: A second factor, a passkey and an API token need a confirmed address

*Likelihood of impact: medium — apps made with `make:auth` that let anyone register or have users with unconfirmed addresses, apps with a custom `TwoFactorState`, and apps that listen to `TwoFactorDisabled` or `PasskeyRemoved`.*

Before, an account with an unconfirmed address could add an authenticator app or a passkey and create API tokens. Someone who registered a victim's address first could add a factor and wait; the victim's password reset did not remove it. Now the starter kit puts authenticator setup and confirm, the passkey options and store routes and API-token creation behind `verified()` in every registration mode, and an unconfirmed address sees a notice with a resend link instead of the setup controls. And a password reset of an account whose address was never confirmed (`email_verified_at` and `first_verified_at` are `null`) removes, in the same transaction as the new hash, every passkey, the authenticator (a pending setup too), the recovery codes and the API tokens.

What the app has to do:

- **Apps made with `make:auth`:** copy `routes.ts` (the `verified()` group for the factor and token routes), the two settings controllers and views, the language keys and the `NotifyAboutTwoFactorDisabled` and `NotifyAboutPasskeyRemoved` listeners from `packages/auth/stubs/react/modules/auth`. Your own routes that add a factor or create a token need `verified()` too.
- **A custom `TwoFactorState`** implements `removeAll(userId): Promise<void>`. TypeScript refuses a source without it, and a password reset throws a `TypeError` before the reset token is spent when the bound source has none.
- **Listeners:** `TwoFactorDisabled.via` can be `'reset'` and `PasskeyRemoved` has a `via` (`'user'`, `'reset'`; jobs queued before the upgrade read as `'user'`). Handle the new value; the kit sends one `disabled_by_reset` mail instead of one mail per factor.
- **The `UserProvider`** has to load `email_verified_at`. Without it the reset keeps the factors and logs a warning once.
- Creating an API token now needs a confirmed address, like adding a factor.

There is no way back. See [Security](docs/security.md), [Two-factor authentication](docs/two-factor-authentication.md) and [Email verification](docs/verification.md).

#### Medium: Open uploads are capped per session and in total

*Likelihood of impact: medium — apps with file upload fields; forms that take many or large files in one session notice, and apps with an existing `temporary_uploads` table need one migration.*

Before, a client could ask for any number of upload targets and leave the files unsent for a day. Now a session may hold `UPLOADS_MAX_OPEN` open uploads (default 20) with at most `UPLOADS_MAX_OPEN_MB` megabytes announced (1024), and all sessions together at most `UPLOADS_MAX_OPEN_TOTAL_MB` (10240, `0` turns this one off). Every open upload counts for at least 64 KiB. A target past a limit gets a 429 with `Retry-After`; a file larger than a limit could ever take gets a 422 with the real maximum. The bytes of a file are cut off at the announced size (a 413 above it), and on S3 the presigned POST binds that size. `uploads:prune` deletes unused uploads as soon as their token expires (`UPLOADS_LIFETIME`, default 120 minutes), not only after 24 hours; used uploads still go by age.

What the app has to do:

- **An existing `temporary_uploads` table** gets the two indexes the counts use. Add the migration shown in [File storage](docs/storage.md#the-uploads-table), named with the current timestamp, and run `marmeon migrate`. Without it the counts scan the table. Tables made by the current `make:uploads-table` have them.
- **Forms with many or large files per session** raise `UPLOADS_MAX_OPEN` and `UPLOADS_MAX_OPEN_MB`, and `UPLOADS_MAX_OPEN_TOTAL_MB` for a busy app.
- **Keep `uploads:prune` scheduled every hour;** it is also what frees the room an abandoned upload takes.
- **A client of your own** has to announce the true file size with the target, as the built-in client does.

The way back is high values for the three variables, or `0` for the total; the per-session limits cannot be switched off. See [File storage](docs/storage.md#uploads).

#### Medium: Vite reads no `.env` file and no `VITE_*` variable

*Likelihood of impact: low — only apps that read `import.meta.env.VITE_*`, or set their own `envDir` or `envPrefix` in the Vite config.*

Before, Vite read the `.env*` files and wrote every `VITE_*` variable that client code reads, from those files or from the process environment, into the public bundle. Now `marmeon()` sets `envDir: false` and a prefix no variable uses, so `import.meta.env.VITE_*` is `undefined` in client and server (SSR) code, without an error. `MODE`, `DEV`, `PROD`, `SSR` and `BASE_URL` stay. Without `viteEnv`, the plugin refuses at start an app's own `envDir` or `envPrefix`, and a prefix another plugin adds; the message names `viteEnv: true`.

What the app has to do:

- Move the values to [shared props](docs/configuration.md#values-for-the-browser), or set `marmeon({ viteEnv: true })` in `vite.config.ts` (and in `vitest.config.ts` if the tests read them).
- An app that sets its own `envDir` or `envPrefix` fails to start until it sets `viteEnv: true`.

The way back is `marmeon({ viteEnv: true })`; then every `VITE_*` variable of the process and of the `.env` files is public again. See [Vite](docs/vite.md#environment-variables).

#### Medium: Apps made with the starter kit copy its security fixes by hand

*Likelihood of impact: medium — every app made with `make:auth` or `create-marmeon` before this release; the code stays as it is, the apps own their copies of the kit and only gain the fixes below when they copy them.*

An app owns the files `make:auth` and `create-marmeon` wrote, so a framework update changes none of them. Each change below is in `packages/auth/stubs/react/modules/auth` (or the new-app template); compare your copy with it. Ordered by what it protects, security fixes first:

- **Sign-in limits per client and per account** (security). Without them an IPv6 host owns a whole /64 of rate-limit buckets, one client can try unlimited passwords at argon2 cost, and guesses spread over many clients against one account are never stopped.
  - Copy `AuthServiceProvider.ts` (every address-based limit keys on `clientKey(ctx.ip)` from `@marmeon/cache`, and the new `login-client` limit of 30 a minute), `controllers/LoginController.ts` (the key is `login:<email>|<client>`) and `routes.ts` (`throttle('login-client')` on `POST /login`). In your own limiters, replace `by(ctx.ip)` with `by(clientKey(ctx.ip))`.
  - For the ceiling of 100 failed password sign-ins an address may take a day (the 101st gets `auth.login.locked`, even with the right password): copy `account-failures.ts`, `jobs/SendLockoutMailJob.ts` and `mail/LockoutMail.ts`, add the `login.locked` and `mail.lockout.*` texts to `lang/en.ts` and `lang/de.ts`, register the job in `index.ts`, and update `LoginController` (takes `Queue`), `ResetPasswordController` and `PasskeySignInController` (take `RateLimiter`). Anyone who knows an address can lock its password sign-in for a day; the owner gets back in with a password reset or a passkey. Use the `database` or `redis` cache store and keep `cache:prune` scheduled, since each address tried leaves a cache entry for a day.
  - If you keep `auth.test.ts`, `@marmeon/server` becomes a dev dependency.
- **A rehash never writes an old password over a reset** (security). Without it, a password reset that lands between a sign-in's password check and its rehash is overwritten by the old password. In `UserRepository.ts`, `updatePasswordHash(id, hash, expected?)` returns a `boolean` and writes only `where password = expected` in one statement (as the stub does; the column is a secret, so the comparison is a raw `sql` fragment). A provider that returns nothing still works but keeps the race.
- **Secret files stay out of git** (security; new apps only get this by themselves). Without it only `.env` is ignored, and `make:docker`'s `.env.production` with production secrets can be committed by `git add -A`. Add to `.gitignore`:

  ```
  .env*
  !.env.example
  !.env.test
  ```

  Run `chmod 600 .env` (a `.env` copied from `.env.example` is readable by group and others; `marmeon key:generate` now creates it as 0600 and tightens an existing one before writing the key). If `.env.production` is already committed, run `git rm --cached .env.production` and rotate every secret in it. `.env.test` stays committed, so it must never hold real credentials.
- **At most one "account exists" mail per address and hour** (security: abuse). Without it anyone can flood an owner's inbox through the public sign-up form of an app with private registration. Copy `jobs/SendAccountExistsMailJob.ts` (it takes a `RateLimiter`, keys on the hash of the stored address and clears the window if mailing throws). The sign-up answer does not change.
- **The remember-me mail** (text and mails only). The owner is now told about every old or altered remember-me cookie, not only about the validator replaced just before. Reword `mail/SignInMail.ts` and the matching keys in `lang/en.ts` and `lang/de.ts` from the stub.

There is no way back for the framework side; each copy is yours to take or leave. See [Starter kit](docs/starter-kit.md), [Rate limiting](docs/rate-limiting.md#keys-and-the-clients-address) and [Configuration](docs/configuration.md).

#### Low: Confirming a second factor can answer `signed-out`

*Likelihood of impact: low — only apps with their own controllers for `TwoFactor.confirm()` or `Passkeys.register()`, or built from the kit before this release.*

Confirming an authenticator app or registering a passkey checks, inside the transaction that stores the factor, that the session still belongs to the account. A sign-out elsewhere, a password change or a deleted account that lands first makes `TwoFactor.confirm()` and `Passkeys.register()` return the new error kind `signed-out`, and nothing is stored.

- `ConfirmError` and `RegisterError` have the new kind; an exhaustive `switch` over them stops compiling until it handles it.
- Apps built from the kit: add the `signed-out` case to `ConfirmTwoFactorController` (redirect to `auth.login`) and `RegisterPasskeyController` (answer 401), and let `Passkeys.tsx` go to the sign-in on a 401, as in `packages/auth/stubs/react/modules/auth`.
- A custom `UserProvider` whose `updateSessionKey` skips no-op writes must still return `true` for `updateSessionKey(id, k, k)`; a provider that answers otherwise gets an error naming the rule.
- `TwoFactor`'s constructor takes `Connections` as its last parameter. Only code that builds it by hand notices; the container resolves it.

There is no way back. See [Authentication](docs/authentication.md).

#### Low: `LiveStreamRequest` takes `accounts` instead of `account`

*Likelihood of impact: low — only code that calls `LiveHub.open()` itself.*

A live stream is now filed under one keyed scope per key of `APP_KEY` and `APP_PREVIOUS_KEYS`, so an end announced during a key rotation closes the streams of processes on the old and on the new key alike. `LiveStreamRequest.account?: string` became `accounts?: readonly string[]`. The built-in live endpoint does this itself.

Code that calls `LiveHub.open()` passes `accounts: LiveTokens.accountScopes(scope)` instead of `account: LiveTokens.accountScope(scope)`. TypeScript flags the old property.

The way back is none; the old property is gone. See [Real-time](docs/realtime.md).

## Upgrading to 0.2.0 from 0.1.3

#### High: Every route has to say who may call it

*Likelihood of impact: high — every app with routes that has not stated an access decision.*

The app refuses to start (and `marmeon route:types` and `marmeon build` exit 1) while a route does not say who may call it. The
error is a `RouteAccessError`; it lists each route with its methods, path, name, controller and the file and line that registered it:

```
2 routes do not say who may call them:
  GET  /posts  posts.index  PostController  modules/posts/routes.ts:4
  POST  /posts  posts.store  Closure  modules/posts/routes.ts:5
Say it with one of these:
  - can(Policy, 'ability', 'param') as the request's `authorize`, or on its registrar: Route.authorize(can(…))
  - a check of your own: Route.authorize((ctx) => …) or `authorize` in defineRequest()
  - everyone, last: Route.authorize(everyone) says anyone its middleware lets through may call it — nothing else about it is checked
See docs/authorization.md#every-route-decides.
```

Start the app, then decide each route listed:

- `can(Policy, 'ability', 'param')` wherever the route reaches a record that belongs to someone, as the request's `authorize` or on the registrar: `Route.authorize(can(…))`.
- `everyone` where the route's middleware is the whole decision: `Route.middleware(authenticate()).authorize(everyone)`, or `defineRequest({ authorize: everyone })`.
- A route file that decides once for all its routes: `const Route = Root.authorize(everyone)`. That is the old behaviour, now written down.

A route that is open to `everyone` and loads a record from the URL without `scopedBy` is refused as well. Give it a policy, scope the
binding (`bind('child', Binder, { scopedBy: 'parent' })`), or, for a route that only reads (`GET`/`HEAD`) and whose records are really public,
mark the binding `bind('param', Binder, { public: true })`. A write under `everyone` is never excused by `public`.

With `tableRoutes(…)` under a registrar that only says `everyone`, give every action, bulk action and export its own `.authorize(…)`.

`Router.dispatch` refuses undecided routes and open unscoped bindings too, so tests that dispatch a route need a decision as well.
`FRAMEWORK_ROUTES` is no longer exported from `@marmeon/http` or `@marmeon/router`, and without that marker `load()` throws for any path
under `/_marmeon/`; a package that used it moves its routes to a prefix of its own and decides them like an app does. Routes are registered synchronously now: the root registrar is sealed once the route files have loaded, so a `defineRoutes(async …)`
callback, or a registrar kept and used after loading, fails at load. Move the `await` out of the route file.
A request's `authorize` that returns a truthy value other than `true` (possible from untyped code
only) now answers 403.

There is no way back to routes without a decision. See [Authorization](docs/authorization.md#every-route-decides).

#### Medium: `Auth.attempt()` and `Auth.login()` can wait for a second factor

*Likelihood of impact: medium — only when an account has a second factor (TwoFactorState bound); an app that does not bind two-factor authentication never sees the new case.*

`attempt()` can now fail with `{ kind: 'two-factor-required', factors }` after a right password, and `login()` returns
`'signed-in' | 'two-factor-required'` instead of `void`. In that case nobody is signed in: no `Login` event, no remember-me cookie.
A caller that ignores the new case leaves the user signed out.

Before:

```ts
const signedIn = await auth.attempt(email, password);
if (!signedIn.ok) throw new ValidationError({ email: ['These credentials do not match.'] });

await auth.login(newUser);
return redirect('/dashboard');
```

After:

```ts
const signedIn = await auth.attempt(email, password);
if (!signedIn.ok) {
  if (signedIn.error.kind === 'two-factor-required') return redirect('/two-factor-challenge');
  throw new ValidationError({ email: ['These credentials do not match.'] });
}

if ((await auth.login(newUser)) === 'two-factor-required') return redirect('/two-factor-challenge');
return redirect('/dashboard');
```

A `switch` over `error.kind` that is exhaustive fails to compile until it handles the new kind; the starter kit's login page and the
`make:auth` stub do. The way back is not to bind two-factor authentication: the case never occurs without it. See
[Two-factor authentication](docs/two-factor-authentication.md).

#### Low: A custom `RememberTokenStore` has to return `createdAt`

*Likelihood of impact: low — only apps with their own `RememberTokenStore`; the database store of `@marmeon/auth` already does.*

`consume()` now returns `createdAt` next to `userId`, `cookie` and `expiresAt`: when the token was first made, kept across rotation,
written with the app's clock and a time zone. It must be the token's original creation time as a valid `Date`: never the time of
`consume()`, never `new Date()`. Two-factor authentication refuses a remember-me token whose `createdAt` is not after the factor was
turned on, so a wrong value lets tokens from before the factor through. TypeScript points to the store that lacks the field.

Before:

```ts
return ok({ userId: row.user_id, cookie, expiresAt });
```

After:

```ts
return ok({ userId: row.user_id, cookie, expiresAt, createdAt: new Date(row.created_at) });
```

There is no way back; the interface requires the field whether or not two-factor authentication is bound (at runtime it is read only with a `TwoFactorState` bound).

#### Low: `LoginVia` has a fourth member, `'passkey'`

*Likelihood of impact: low — only code that switches exhaustively over `Login.via`.*

A sign-in with a passkey alone reports `via: 'passkey'` next to `'attempt'`, `'login'` and `'remember'`. A `switch` over
`event.via` that must be exhaustive fails to compile until it handles the new value; nothing changes at runtime for an app that does not
bind passkeys.
