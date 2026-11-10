# Upgrading

This page lists every change between one version and the next that an app has to act on: how likely it is to affect your app, what to do, and the way back where there is one. The
[release policy](docs/releases.md#what-a-version-promises) says what a version promises.

## Upgrading to 1.1.0 from 1.0.0

### Security hardening

#### Low: A passkey with an RSA key under 2048 bits or an unlisted algorithm no longer signs in

*Likelihood of impact: low — accounts whose stored passkey uses an RSA key under 2048 bits, or an algorithm other than ES256, EdDSA and RS256 (for example from imported rows). Common RS256 authenticators such as Windows Hello make 2048-bit keys.*

Nothing changes in code. Registration refuses an RSA key shorter than 2048 bits, and sign-in refuses such a stored key, or one whose algorithm registration does not offer, before anything is verified. Each attempt ends like any invalid credential: the same `invalid` result and the usual failure events (`PasskeySignInFailed`, `TwoFactorChallengeFailed`). An affected account signs in with its password and another second factor or a recovery code, then registers a new passkey. There is no way back: the bound has no setting.

## Upgrading to 1.0.0 from 0.4.0

### Before and right after the upgrade

#### High: Before you upgrade

*Likelihood of impact: high — every app checks this list before it moves to this release.*

1.0.0 reads what 0.4 wrote: sessions, the session and remember-me cookies, API tokens, queued jobs, cache entries, uploads and the record of migrations. Nobody has to sign in again, no queue has to run empty, and servers of 0.4 and 1.0 may run side by side during a rolling deploy. What two versions do not share: the live stream ([the stream's protocol version](#low-the-live-stream-carries-its-protocol-version)), whose hints between old and new nodes are lost during the rollout, so that a tab opened before it gets no live updates until its next visit; values encrypted without a context (step 1); links without an expiry and temporary links over seven days (step 3.3); and a reset link that is older than a lowered `AUTH_RESET_MINUTES` (step 3.3). Do these in order.

1. **On 0.4, before you move a package.** Some changes cannot be made afterwards:
   - **Values you encrypted without a context:** re-encrypt them, deploy the code that passes the context, then upgrade. This release reads none of them ([encryption](#medium-every-encryption-takes-a-context-of-its-own)).
   - **A named Redis connection without a prefix:** give it one in its `resolve`, and move the keys it kept without a prefix under the new one first ([Redis](#low-a-named-redis-connection-needs-a-prefix)).
   - **A Redis queue whose name ends in `:delayed` or `:reserved`:** rename it, and move its jobs with the workers stopped ([queue names](#medium-a-redis-queue-name-must-not-collide-with-the-keys-of-another-queue)).
2. **In development, with the packages at 1.0.0.**
   1. Move every framework package at once: `pnpm up --latest "@marmeon/*" marmeon`. Then check that `package.json` names every `@marmeon/*` package and `marmeon` at exactly `1.0.0`: an app made before 1.0 does not save exact versions, so pnpm may write `^1.0.0`. Set each one to `1.0.0` by hand where it did and run `pnpm install`; never upgrade one alone ([how to upgrade](docs/releases.md#how-to-upgrade)). On the first day after the release, pnpm holds the new versions back ([the first day after a release](docs/releases.md#the-first-day-after-a-release)).
   2. Change what stops the start, in `.env`, `.env.test`, `.env.example`, the compose file and the CI configuration. `make:auth`, `migrate`, `db:types` and `route:types` start the app, so they stop on each of these, with a message that names the problem:
      - `SERVER_MAX_BODY_SIZE`, `MAX_BODY_SIZE` and `HASH_ARGON_MEMORY` become `SERVER_MAX_BODY_MB` and `HASH_ARGON_MEMORY_KB` ([sizes](#medium-a-size-in-an-environment-variable-names-its-unit));
      - `AUTH_RESET_MINUTES` and `UPLOADS_SEND_WITHIN_MINUTES` are at most 1440 ([auth](#medium-access-tokens-password-changes-and-reset-links-have-safe-defaults), [temporary URLs](#low-a-temporary-url-lasts-at-most-seven-days-on-every-disk));
      - `SERVER_TRUSTED_PROXIES` has no `0.0.0.0/0`, `::/0` or IPv6 range that holds all of IPv4: write `*` if every peer really is your proxy, or list the proxy ranges ([proxies](#low-a-0-proxy-range-stops-the-start-and-development-details-go-only-to-allowed-hosts));
      - a slow Postgres server, such as a paused serverless database, needs `?connect_timeout=<seconds>` in `DB_URL` when it takes longer than 10 s to accept a connection ([Postgres](#low-postgres-connections-time-out-after-10-seconds-and-keep-utc));
      - a Vite `base` that is a path or relative (`/static/`, `./`) becomes `/` or the absolute URL of the assets ([the base](#low-vites-base-is--or-an-absolute-url-and-the-server-links-a-pages-chunks-under-it)).
   3. An app made with the starter kit: add `oxc-transform` and run `marmeon make:auth --force` ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-once-more)). Until then its tests and its type check fail on the old module.
   4. Run `marmeon migrate` on the development database, then `marmeon db:types`, `marmeon route:types` and `marmeon agents:sync`, and commit what they write. 1.0.0 adds no migration an existing app has to run, but `migrate` writes the table types in development; `db:types --check` fails with "generated by another version" until the types are written again ([table types](#high-the-generated-table-types-declare-primary-keys)); `agents:sync` brings the block of `AGENTS.md` up to date, which `marmeon check` reports until then ([coding agents](docs/agents.md)).
   5. Make the changes of the other entries below. The compiler, `marmeon check` and the tests point at most of them; the lists after this procedure name what they cannot find.
3. **Deploy.**
   1. Set the environment of the servers and the platform to the new names and limits of step 2.2, in the same deploy as the new release: an old name that is still set stops the start.
   2. Run `marmeon migrate --force` once, as with every deploy ([deployment](docs/deployment.md#checklist)), and roll the new release out. There is nothing to stop and no session or token to end.
   3. Links you sent before the upgrade: a signed link without an expiry answers 403 unless its route says `signed({ forever: true })` ([signed links](#medium-a-signed-link-carries-its-expiry-and-signed-refuses-one-without)), and a temporary storage link made for longer than seven days answers 403: send new ones, or serve such files through a route of your own ([temporary URLs](#low-a-temporary-url-lasts-at-most-seven-days-on-every-disk)). If `AUTH_RESET_MINUTES` was above 1440 and you lowered it, an open password-reset link older than the new limit is refused when it is used: the limit applies at use, so ask those users to request a new link.

The start stops with a message that names the problem for: a command named `dev` or `start` (K8), a scoped binding whose binder does not scope (H11), a route pattern that cannot be read the same way everywhere (H13), a check timeout over its limit, at zero or below (K13), a named Redis connection with an empty prefix (K6), a default layout whose `error` is no component (R19), a `MAIL_DRIVER` that no provider brought (Q8), a body schema with a file in a list, a union or an optional object (S2), an environment variable with an old size name, two different `defineConnection()` definitions with the same name (D23), a `csrfExcept` pattern that matches every path, does not start with `/` or starts with a placeholder (a `TypeError`, [CSRF exclusions](#low-a-wildcard-in-a-csrf-exclusion-matches-within-one-path-segment)), `abilities()` without an ability, a default Redis queue whose name collides (Q4), the proxy ranges, `AUTH_RESET_MINUTES` and `UPLOADS_SEND_WITHIN_MINUTES` above, and an invalid `connect_timeout`. `vite.config.ts` refuses the options `pages` and `lang`, and `marmeon build` a Vite `base` that is no URL. `marmeon dev`, `build`, `route:types` and `check` stop for an error page or a layer backdrop in its former place (K14, [system module](#low-the-error-pages-and-the-layer-backdrop-live-in-the-system-module)).

Neither the compiler nor the start finds these: a check timeout written in milliseconds; a number in `once(fn, { for })`, which is seconds; a number of milliseconds as the timeout of the live test reader, now seconds; a string returned from a route, now sent as `text/plain`; a link without `expires` at `signed()`; a `sync` or unique job dispatched through a transaction you began yourself; `auth.updatePassword()` without a confirmed password; a script that tests for exit code 1 after a wrong argument; a `temporaryUrl()` longer than seven days on a local disk, which now throws when it is signed; a `Limit` built from a count that is zero or not a number, which now throws when the limiter runs; a test app that runs as production and posts without a CSRF token, which now gets a 419; a call of `AccountSessions.end(userId)` or `marmeon auth:end-sessions` that must keep the user's API tokens, which now revokes them; a test or a `layout(name)` that compares the name of an error page or the backdrop; an island that reads a cookie while its page is rendered on the server for a visitor without a session ([islands and cookies](#medium-an-island-rendered-with-its-page-sees-cookies-only-while-the-page-is-private)); a closure route that returns `island()`, an `island` imported through a re-export, a module package built before this version and a controller that returns a page or an island depending on a branch, which all answer 404 ([island routes](#low-an-island-request-reaches-only-a-controller-that-returns-island)); a `csrfExcept` such as `/webhooks/*` that no longer covers `/webhooks/stripe/events`, whose requests get 419 ([CSRF exclusions](#low-a-wildcard-in-a-csrf-exclusion-matches-within-one-path-segment)); a page that shows a table without `.attach(T.endpoints())`, also a table without actions or exports, which fails when the page is requested ([table endpoints](#medium-a-tables-endpoints-hang-on-its-page-with-endpoints)); a mail template with `mj-social-element`, `mj-accordion` or `mj-carousel` without its image attributes, which `fromMjml()` refuses with Q7 when the mail is rendered or sent ([MJML](#low-mjml-components-without-an-image-source-of-their-own-are-refused)); a `TimeZone` in the `?options=` of `DB_URL`, which UTC silently replaces ([Postgres](#low-postgres-connections-time-out-after-10-seconds-and-keep-utc)); a body schema built by a factory with a file in a list, a union or an optional object, which answers 500 at its first submit ([files](#low-a-file-in-a-list-a-union-or-an-optional-object-stops-the-start)); a table whose `authorize` returns something other than `true` ([table authorize](#low-a-tables-authorize-must-return-true)); and a script or a person that read a mail's reset or verification link from a production log, where only recipients and subject are written now ([the log mailer](#medium-the-log-mailer-writes-only-recipients-and-subject-outside-development-and-tests)).

An entry below that names no way back has none.

#### High: Apps made with the starter kit take its auth module once more

*Likelihood of impact: high — apps made with `make:auth`, and every app made with `create-marmeon` on 0.4.*

The kit's controllers, mails, tests and translations changed with the entries of this release, and nothing updates them in an app. Once the packages are at 1.0.0 the app still loads, but its type check and many of its tests fail on the old module. On a clean working tree:

1. Run `pnpm add -D oxc-transform` if the app lacks it: the kit's mails are React views, which the server compiles with it, and `marmeon build` stops without it while any mail view exists.
2. Run `marmeon make:auth --force`. It writes the module again and keeps every migration the app has, adding only the ones it lacks. It deletes the files of the old kit that the new one no longer writes, when `marmeon-stubs.json` shows the app left them unchanged: `controllers/CreateAccessTokenController.ts`, which the kit of 1.0 ships as `StoreAccessTokenController.ts`, and `mail/layout.ts`, which became the component `mail/Layout.tsx`. A file you changed stays and the command names it: carry your changes to the mail frame (branding, footer) into `Layout.tsx`, because the new mails no longer import `layout.ts`, and delete the old file once nothing of yours imports it.
3. Run `marmeon migrate`, `marmeon db:types` and `marmeon route:types`.
4. Look at `git diff` and put your own changes back.

Without `--force`, port the changes from `packages/auth/stubs/react/modules/auth` of the installed version; the compiler and the tests point at most places.

Every app made with `create-marmeon` on 0.4, with or without the kit, also has `HASH_ARGON_MEMORY` in `.env.test` and `progressBar({ delay: 250 })` in `bootstrap/client.tsx`: rename them to `HASH_ARGON_MEMORY_KB` ([sizes](#medium-a-size-in-an-environment-variable-names-its-unit)) and `delayMs` ([the client's spans of time](#medium-the-clients-spans-of-time-name-their-unit-in-milliseconds)).

There is no way back. See [the starter kit](docs/starter-kit.md).

### Security defaults

#### Medium: Every encryption takes a context of its own

*Likelihood of impact: medium — apps that call `encrypt()` or `decrypt()` themselves.*

`Encrypter.encrypt(plaintext, context)` and `decrypt(payload, context)` require the context, also in `AesGcmEncrypter` and `CursorEncrypter`. `''` or a missing argument throws a `TypeError`. The context binds a ciphertext to its use: without one, two values an app encrypted were interchangeable.

- Give each use of your own a context of its own that starts with none of `cookie:`, `session:`, `queue:` or `marmeon`:

  ```ts
  // before
  encrypt(value)
  // after
  encrypt(value, 'billing:coupon')
  ```

- Values stored without a context used the empty one. This release does not decrypt them, and no method reads them. Re-encrypt them **before you upgrade, on 0.4**, where `decrypt(payload)` still reads them and `encrypt(text, context)` already takes a context: run `encrypt(await decrypt(row.code), 'billing:coupon')` over the column, deploy the code that passes the context, then upgrade.
- The payload format does not change, and every framework caller already passed a context, so cookies, sessions, jobs and cursors keep decrypting. An app that always passed a context changes nothing.


#### Medium: A signed link carries its expiry, and signed() refuses one without

*Likelihood of impact: medium — apps that make signed links or have routes behind `signed()`.*

Making a link:

| Before | After |
| --- | --- |
| `signer.temporarySignedRoute(name, params, '7d', { base })` | `signer.signedRoute(name, params, { expiresIn: { days: 7 }, base })` |
| `signer.signedRoute(name, params)` (never expired) | `signer.signedRoute(name, params, { expiresIn: … })`, or `signer.foreverSignedRoute(name, params)` if the link really must never expire |
| `signer.signedPath(path)` | `signer.signedPath(path, { expiresIn: … })` |

- `expiresIn` is required and at least one second: a number of seconds or a `Duration` object, never a string such as `'7d'`. 0, negative or sub-second values throw a `RangeError`. Untyped code without `expiresIn` gets a `TypeError` that names `foreverSignedRoute()`.
- `params` is always required: pass `{}` for a route without parameters.

Accepting a link:

- A route behind `signed()` answers 403 to a link without `expires`, and `hasValidSignature(url)` is `false` for it. An expired link is refused as before.
- Links from `foreverSignedRoute()`, and old links in mails that were made without an expiry, need `signed({ forever: true })` on their route, or `hasValidSignature(url, { forever: true })`. `forever` takes only `true`. Prefer giving such links an expiry.
- An empty or doubled `expires=`, or one in the path or fragment, is refused.

Links made with an expiry change nothing, and links sent before the upgrade *with an `expires`* keep working; the signature and the query format are unchanged. A link sent without one needs `forever` as above.


#### Medium: Access tokens, password changes and reset links have safe defaults

*Likelihood of impact: medium — apps with `@marmeon/auth` that create API tokens, change passwords outside the kit's controllers, or end a user's sessions.*

- **Tokens:** `{ abilities, expiresIn }` is required.

  ```ts
  // before
  tokens.create(user.id, 'CI')
  // after
  tokens.create(user.id, 'CI', { abilities: ['users:read'], expiresIn: { days: 90 } })
  ```

  `abilities: ['*']` allows everything and `[]` nothing; `expiresIn: null` never expires and `0` is expired at once. An untyped caller without options gets a `TypeError` before anything is written. A custom `AccessTokenStore` takes the now required `options`.
- **Password change:** `auth.updatePassword()` throws unless the password was confirmed within `AUTH_PASSWORD_TIMEOUT_SECONDS`. A route that calls it runs `checkPassword(current)` first, as the kit does, or sits behind `confirmedPassword()`.
- **Ending a user's sessions:** `AccountSessions.end(userId)` and `marmeon auth:end-sessions` now also revoke the user's API tokens and delete their password-reset link, like `endEveryone()`. Keep the tokens with `end(userId, { accessTokens: false })` or `--keep-api-tokens`, for an integration that must outlive a sign-out; the result says how many it revoked (`accessTokens`). The options are an object: `end(userId, false)` throws a `TypeError`.
- **Reset links:** a changed password deletes the account's reset link inside its transaction, so an older link answers `invalid-token`. A `PasswordResetTokenStore` of your own is asked to `forget()` the account's address there and when sessions end, as stored and trimmed in lower case (the form the starter kit creates links under); when it fails, the password change fails.
- **`AUTH_RESET_MINUTES`:** 1 to 1440; a larger value such as 10080 stops the start.
- **Session id:** a right password in `checkPassword()` regenerates the session. Browsers follow on their own. Live streams in other tabs end until the tab navigates, and a request that still carries the old cookie (a double submit, a parallel fetch) is a guest.
- **Tests** that hold a session cookie across a right password take the new one from the response:

  ```ts
  cookie = (await app.withCookie(S, cookie).post('/confirm-password', …)).cookie(S) ?? cookie;
  ```

  An app that copied the kit's tests takes their updated versions from the kit.

The kit's controllers already pass `abilities` and an expiry and confirm the password first, so they are unchanged, and so is the reset flow through `PasswordBroker.reset()`. A stolen remember cookie, a cloned passkey and `auth:reset-two-factor` end the sessions but keep the API tokens; the clone mail tells the owner to check them. A passkey clone suspended inside an app transaction now stays suspended after a rollback.


#### Medium: A string from a route is sent as text, and only Html as HTML

*Likelihood of impact: medium — apps with routes, controllers or error handlers that return a string.*

| Result | Before | Now |
| --- | --- | --- |
| a string | `text/html` | `text/plain; charset=utf-8` |
| ``html`…` `` or `raw(…)` | JSON `{}` | `text/html; charset=utf-8` |

Return ``html`…` `` from `@marmeon/core` or `this.view()` for markup, and drop any `String(…)` around an `html` template:

```ts
// before
return String(html`…`);
// after
return html`…`;
```

This holds for closures, controller `handle()`, action requests and error handlers. An `Html` result gets the CSP header, so `ctx.nonce()` works in it.


#### Low: A /0 proxy range stops the start, and development details go only to allowed hosts

*Likelihood of impact: low — apps that trust every peer through a `/0` range, or develop on a LAN IP or a Compose host name.*

- `SERVER_TRUSTED_PROXIES` with any `/0` (including `/00`), `::/0`, or an IPv6 range that holds all of the IPv4-mapped block (`::ffff:0.0.0.0/96`, `::/80`) stops the start. Such a range let every client write its own address into `X-Forwarded-For`. Write `*` if every peer really is your proxy, or list the proxy ranges.
- In development, the error page, the exception text of region and island errors, the SSR overlay, the page and island hints and the details of `/up/ready` go only to `localhost`, a loopback address or the host of `APP_URL`. Any other `Host` gets the plain answer. If you develop on a LAN IP or a Compose host name, set `APP_URL` to that host.


#### Low: A named Redis connection needs a prefix

*Likelihood of impact: low — apps with a `defineRedisConnection()` whose `resolve` returns `prefix: ''`.*

An empty prefix on a named connection stops the start with the "Invalid configuration" error (K6), as `REDIS_PREFIX` already did. Give every `defineRedisConnection(...)` a non-empty `prefix` in its `resolve`, e.g. `'notes-app:'`. If the connection kept keys without a prefix, move them under the new prefix first: the connection now reads and writes under it. `resolve` also runs during that check, so keep it free of side effects.


#### Low: A middleware list that would drop a layer throws

*Likelihood of impact: low — apps in plain JavaScript, or with conditional middleware entries.*

Each of these throws a `TypeError` when the routes or groups are defined; the TypeScript signatures are unchanged.

- Several layers in one call: chain them.

  ```ts
  // before
  Route.middleware(throttle('x'), authenticate())
  // after
  Route.middleware(throttle('x')).middleware(authenticate())
  ```

  The same for `Route.authorize(a).authorize(b)`. Chained `authorize()` calls add up, so every check must pass.
- `undefined` or another non-middleware entry in a route or group list, e.g. `Route.middleware(flag ? throttle('x') : undefined)` or an entry in `defineApplication({ middleware: { global: [...] } })`: build the list with `.filter(Boolean)` or chain conditionally.
- `MiddlewareGroups.append()` takes a number as its priority.


#### Low: A binder of your own declares that it scopes

*Likelihood of impact: low — apps that use `scopedBy` with a route binder of their own.*

A binder used with `bind(…, { scopedBy })` declares `static readonly routeBindingScoped = true` and reads `binding.scope` (docs/routing.md › "Your own binder"). Without the mark TypeScript refuses `scopedBy`, and the app stops with H11 when its routes load. A subclass of `Repository` keeps the mark; one that overrides `resolveRouteBinding` passes `binding` on to `super`. A scoped binding whose parent is missing from the request answers 404 without calling the binder.


#### Low: Live validation leaves out every field named like a secret

*Likelihood of impact: low — forms that validate card numbers, codes, tokens or similar fields live.*

The client no longer sends a field that `isSensitiveField` knows (passwords, passcodes and passphrases, card numbers and CVCs, one-time codes, tokens, secrets and keys) with a live validation, at any depth. Check such fields when the form is sent.

- `form.validate('cardNumber')`, `validating('cardNumber')` and `validate: { fields: ['cardNumber'] }` are type errors; drop those names.
- The type `PasswordNeverLive` from `@marmeon/http/page` is `SensitiveNeverLive`.


#### Low: The deprecated remembered-field patterns are gone

*Likelihood of impact: low — apps or client adapters that test field names against the two patterns.*

Neither `@marmeon/http/client` nor `@marmeon/http/client/adapter` exports `SENSITIVE_REMEMBER_FIELD` and `NEVER_REMEMBERED_FIELD` any more.

```ts
// before
SENSITIVE_REMEMBER_FIELD.test(name) // or NEVER_REMEMBERED_FIELD.test(name)
// after
isSensitiveRememberField(name)
```

Its second argument lists the fields a form lets in after all, never a password: `isSensitiveRememberField(name, ['card_number'])`. It answers `true` until `loadSensitiveFields()` has resolved (docs/forms.md#remembering-input).


#### Medium: A rate limit takes its numbers by name

*Likelihood of impact: medium — apps that call `RateLimiter.attempt()` themselves, or build a `Limit` from a number that may be zero or missing.*

`limiter.attempt(key, 5, 60)` becomes `limiter.attempt(key, { maxAttempts: 5, decay: 60 })`. The two numbers were easy to swap: `attempt(key, 60, 5)` allowed 60 attempts every 5 seconds instead of 5 a minute, and nothing said so. The old form is a type error, and in JavaScript it throws a `TypeError` without counting an attempt; so do a `maxAttempts` that is not a positive finite number and a missing or invalid `decay`.

The `Limit` factories (`Limit.perSecond()`, `perMinute()`, `perHour()`, `perDay()`) throw a `TypeError` for a count that is not a positive finite number. Such a limit used to be dropped, so `Limit.perMinute(Number(env.LOGIN_MAX))` with the variable unset let every request through; it now fails the request instead. `Limit.perMinute(0)` throws as well. For no limit, use `Limit.none()`.

`hit()`, `tooManyAttempts()` and the route middleware `throttle()` are unchanged. `new Limit(…)`, `limit.maxAttempts` and `limit.decaySeconds` are internal: build limits with the factories.


#### Low: Only the test app turns CSRF protection off

*Likelihood of impact: low — code that called `CsrfProtection.disable()`, tests that run the test app as production, and apps with a `csrfExcept` pattern that matches every path.*

`CsrfProtection.disable()`, `enable()` and `skips()` are no longer API, and `disable()` throws in a protected environment — any `NODE_ENV` but `development` and `test`, read from the app's environment, not the process's — so a line copied from a test cannot turn the protection off in production. Tests run without it as before, and `createTestApp(app, { csrf: true })` keeps it on. A test app that runs as production (`env: { NODE_ENV: 'production' }`) keeps it on as well, as on a server: a post without a token gets a 419.

A `csrfExcept` or `except()` pattern that matches every path (`*`, `/*`, `**`) throws, so a `csrfExcept` like that stops the start: it turned the check off everywhere. Name the paths that need it (`/webhooks/*`), or put such routes in a group without CSRF verification. A route that takes signed requests from other sites can use `verifyWebhook()` instead.


#### Low: A temporary URL lasts at most seven days on every disk

*Likelihood of impact: low — apps that sign `temporaryUrl()` links for longer than a week, or set `UPLOADS_SEND_WITHIN_MINUTES` above 1440.*

`disk.temporaryUrl(key, { expiresIn })` throws a `RangeError` for more than 7 days on every disk. On S3 such a link failed already, but only in production; on a local disk it was a link that practically never expired. A file that has to stay reachable longer goes through a route of your own that checks access and answers with `serveFile()`. A disk driver of your own is never asked for more than 604 800 seconds.

The route that serves temporary links of local and memory disks (`/_marmeon/storage`) refuses one whose expiry lies more than seven days ahead, so links signed for longer before the upgrade answer 403. `UPLOADS_SEND_WITHIN_MINUTES` above 1440 stops the start, like `UPLOADS_LIFETIME_MINUTES`.


#### Low: abilities() needs at least one ability

*Likelihood of impact: low — routes that use `abilities()` without a name.*

`abilities()` without a name checked nothing and let every token through. It is now a type error, and it throws a `TypeError` when the route is defined, as does an empty name or one that is not a string. A route that every token may call needs no `abilities()`.


#### Low: Only html and raw() make an Html

*Likelihood of impact: low — code that wrote `new Html(…)` or `new Mjml(…)`.*

An `Html` is sent as `text/html`, so `new Html(markup)` was a second way past the escaping of the `html` template. The constructor is no longer public, and it throws a `TypeError` at run time too, from JavaScript and from a subclass. Build markup with the `html` template, and wrap markup you trust with `raw()` — never a value from a request. `Html` stays a type, and `instanceof Html` works as before.

The same holds for `Mjml` of `@marmeon/mail`: only the `mjml` template makes one, so `new Mjml(markup)` becomes ``mjml`${raw(markup)}` ``.


#### Low: Mails load a web font only from an mj-font of the template

*Likelihood of impact: low — apps whose mail templates name Open Sans, Droid Sans, Lato, Roboto or Ubuntu in a `font-family` without an `<mj-font>` of their own.*

mjml imported these fonts from Google Fonts whenever a template named one, so every opened mail called a third party. `fromMjml()` turns that list off: such a template now renders in the next font of its stack. To keep the web font, add `<mj-font name="…" href="…" />` inside `<mj-head>`, with a source you may load; it applies to that mail only. Mails of the starter kit need no change: their frame lists system fonts before Roboto.

The way back, for one mail, is its own `<mj-font>`. See [writing mails](docs/mail.md#writing-mails).


#### Low: MJML components without an image source of their own are refused

*Likelihood of impact: low — apps whose MJML uses `mj-social-element`, `mj-accordion` or `mj-carousel`, or loads an image from a host the template names nowhere else.*

mjml fills a missing source of these components with an image from mailjet.com or imgur.com, which every opened mail would then load. `fromMjml()` refuses such a template with Q7, an `MjmlError` naming the component, the missing attribute and the host:

- `mj-social-element` without `src`;
- `mj-accordion` without `icon-wrapped-url` and `icon-unwrapped-url`;
- `mj-carousel` without `left-icon` and `right-icon`.

Set the attribute, on the tag or through `mj-attributes` (a tag, `mj-all` or an `mj-class`), to an image you host. The compiled HTML may also load only from hosts the template itself loads from (an image `src`, a `background-url`, an `mj-font`; a link or text does not count): an image that, for example, a component of your own adds from another host fails with Q7 and its URL, so write that URL into the template. Relative, `data:` and `cid:` URLs are fine. The starter kit's mails are unaffected.

There is no way back. See [writing mails](docs/mail.md#writing-mails).


#### Low: A wildcard in a CSRF exclusion matches within one path segment

*Likelihood of impact: low — apps with a `*` in `csrfExcept` or in an exclusion a service provider adds.*

A `*` matched across `/`, so `/*/unsubscribe/*` also exempted every writing route below a workspace whose slug was `unsubscribe`. Now `*` matches within one path segment and `**` across segments. Search your modules and service providers for `*` in their CSRF exclusions:

- A pattern meant for several levels (`/webhooks/*` for `/webhooks/stripe/events`) becomes `/webhooks/**`; otherwise those requests get 419.
- A pattern that does not start with `/`, starts with a placeholder (`*`, `/*`, `/**`, `/*/unsubscribe/*`, `/**/x`) or has one in its first segment (`/webhooks*`) stops the start with a `TypeError`. Write the first segment out, one pattern per locale (`/de/abmelden/*`, `/en/unsubscribe/*`).

There is no way back. See [excluding paths](docs/csrf.md#excluding-paths).


#### Medium: A table's endpoints hang on its page with endpoints()

*Likelihood of impact: medium — apps that call `tableRoutes()`.*

`tableRoutes()` is removed. A table's action, bulk and export endpoints hang on the page that shows it, and run everything that page runs, including the `authorize` of the page controller's request:

```ts
// before
list.get('/', ListMembersController).name('index');
tableRoutes(list.middleware(throttle('members-table')), MembersTable, { export: { middleware: [throttle('members-export')] } });

// after
list.get('/', ListMembersController).name('index').attach(MembersTable.endpoints({
  middleware: [throttle('members-table')],
  export: { middleware: [throttle('members-export')] },
}));
```

- Attach every table a page shows with `resolve()`, also one without actions or exports (`.attach(T.endpoints())`); otherwise `resolve()` fails and names the table and the page.
- The endpoints are under the page's path. For a page at the root of its registrar, the URL stays the same.
- Someone who may not see the page can no longer call its export or actions.
- A table has routes only for the kinds it has: one without actions has no action route, one without an export no export route. A request to such a `/_tables/…` URL is a 404 for everyone; `tableRoutes()` registered all three, so a user the table's `authorize` refused got a 403 there. Nothing a user could do is gone, but a test or a monitor that expects that 403 has to expect the 404.


#### Medium: The log mailer writes only recipients and subject outside development and tests

*Likelihood of impact: medium — apps that read mail links (password reset, verification, signed links) from a production log.*

`MAIL_DRIVER=log` is the default in every environment, and it wrote each mail's whole text to the log, so reset and verification links and their tokens reached production logs. Outside development and tests (production, or no `NODE_ENV`) the log mailer now writes only each mail's recipients and subject, with a note that the text is left out. Queued mails go through the same transport. Development and tests still log the whole mail.

- An app that has to deliver mails sets `MAIL_DRIVER=smtp` with `MAIL_HOST`, `MAIL_USERNAME` and `MAIL_PASSWORD`, or uses a transport of its own (docs/drivers.md#mail-transports).
- An app that only logged mails changes nothing; the boot warning says that no mail is sent.

There is no option to log the text in production. See [the log mailer](docs/mail.md#the-log-mailer).


#### Low: The image of make:docker no longer holds the project's .npmrc

*Likelihood of impact: low — apps that keep a registry token in `.npmrc` and build their image with a Dockerfile from `make:docker`.*

A Dockerfile from `make:docker` copied the project's `.npmrc` into the image, so a registry token in it (`//npm.pkg.github.com/:_authToken=…`) was readable by anyone who could pull the image. A new Dockerfile deletes every `.npmrc` before the run stage and takes the credential as a BuildKit secret.

- Run `marmeon make:docker --force` again, or copy the secret mounts and the `.npmrc` cleanup at the end of the last build-stage `RUN` from a newly generated Dockerfile.
- Remove the auth line from the project's `.npmrc` and pass the credential with `docker build --secret id=npmrc,src=$HOME/.npmrc`.
- **Rotate every token that was in a pushed image or a pushed build cache.**

See [a private registry](docs/deployment.md#a-private-registry).


### Spans of time

#### Medium: Spans of time are seconds or a Duration, and values handed back name their unit

*Likelihood of impact: high — apps that write a span of time as a string such as `'7d'`, apps with their own health or app checks, `once()` props, job middleware or scheduler overlap locks, and code that reads the auth, session, queue or uploads config, a queue event's delay, a cache entry's TTL or a limiter.*

A bare number is seconds; anything else is a `Duration` such as `{ minutes: 5 }` (docs/time.md). A value the framework hands back names its unit. The environment variables (`AUTH_RESET_MINUTES` …), the worker flags `--sleep`, `--max-time` and `--stop-timeout`, and the stored records keep their names and units.

**Strings are gone:**

- `'7d'` becomes `{ days: 7 }` and `'60m'` becomes `{ minutes: 60 }`: in signed links, in the `expiresIn` of API tokens and verification links, and wherever else a span was a string. A string is a type error, and untyped code gets a `TypeError` that names the object to write.
- Import `Duration` from `@marmeon/core`; `@marmeon/http` no longer exports it. The object form is the type `DurationParts`.
- An expiry is rounded down to a whole second; a temporary storage URL used to round up. A storage `expiresIn` under one second is a `RangeError`.
- A `Temporal.Duration` with `years`, `months`, `weeks`, `microseconds` or `nanoseconds` is refused; it used to count as zero.

**Three numbers that keep compiling and change their meaning:**

- A `static timeout` of a health check or an app check (`marmeon check`) is seconds, not milliseconds. Check every one, small values included: `100`, meant as 100 ms, now waits 100 seconds.

  ```ts
  // before
  static timeout = 5000;
  // after
  static timeout = 5; // or { milliseconds: 5000 }
  ```

  A health check allows up to 60 s and an app check up to 600 s; over that, at zero or below, the start stops with K13, naming the check class.
- `once(fn, { ttl })` in milliseconds is `once(fn, { for })`, a `Duration`, and **a number in `for` is seconds**: `for: 60_000` would mean about 16.7 hours.

  ```ts
  // before
  once(fn, { ttl: 60_000 })
  // after
  once(fn, { for: { minutes: 1 } }) // or { for: 60 }
  ```

  An old `ttl` key throws a `TypeError` naming the new form.
- In tests, the timeout of `LiveStreamReader.hello()` and `waitFor()` is a `Duration`: `stream.waitFor(n, 3000)`, meant as 3 s, now waits 3000 seconds. Write `{ seconds: 3 }` or `3`.

**Core and router:**

- `DEFAULT_HEALTH_TIMEOUT` is no longer exported: write `2` or `{ seconds: 2 }`.
- The `lock` and `wait` of `Route.block({ lock, wait })` are `Duration`s, and zero or a negative span throws a `TypeError` ([block()](#low-block-on-a-route-takes-lock-and-wait-by-name)).
- `CookieOptions.maxAge` and a queued listener's `backoff` also take a `Duration` (the backoff a list of them); nothing to change.
- `HealthCheckResult.ms`, `/up/ready` and `check --json` keep milliseconds.

**HTTP and server:**

- `createHttpKernel(app, { islandTimeout: 5000 })` becomes `{ islandTimeoutMs: 5000 }`; an old `islandTimeout` key throws.
- `securityHeaders({ hsts: { maxAge: 31_536_000 } })` keeps working, and `maxAge: { days: 365 }` works too: whole seconds, and at least a year with `preload`.

**Queue, notifications and cache:**

- `retryAfter` is `retryAfterSeconds`: on a connection of the queue config, in the `QueueConnection` a driver factory returns, in the options of the memory, database and redis drivers, and in `JobMiddlewareContext` and the `QueueConnectionOptions` of `QueueConnections.options()`. `QUEUE_*_RETRY_AFTER_SECONDS` is unchanged, and the docs anchor is `queues.md#timeouts-and-retryafterseconds`.
- `JobQueued.delay` and `JobReleased.delay` are `delaySeconds`, as is the `delay` of the entries of `app.queue.dispatched()` and of the `queue.dispatch` diagnostics message. A queue driver of your own reads `delaySeconds` in `QueuedPush` (the `next` entries of `ack(job, next)`).
- A job middleware reads `context.timeoutSeconds`; reading `context.timeout` throws.
- `cache.ttl(key)` becomes `cache.ttlSeconds(key)`, and `limiter.availableIn(key)` becomes `limiter.availableInSeconds(key)`; the old names are gone.
- The cache's `ttl`, `lock()` and `Lock.block()` take a `Duration`; numbers keep meaning seconds. A `Limit` window that is not a whole number of seconds (`Limit.perSecond(5, 0.5)`), or zero or below (`Limit.perSecond(5, 0)`, `Limit.perMinute(5, 0)`), is a `RangeError`; `Limit.none()` is unchanged. A count that is not a positive number throws as well ([rate limit](#medium-a-rate-limit-takes-its-numbers-by-name)).
- A `Duration` is taken by a job's `timeout` and `backoff`, `job.once(key, fn, { for })`, `withoutOverlapping({ releaseAfter, expiresAfter })`, the `WorkOptions` `sleep`, `maxTime`, `stopTimeout` and `watchOtherQueues`, `worker(connection, stopTimeout)` and a notification's `backoff`.
- A worker started with a span that is not finite or below 0 (or `'5s'` from untyped code) stops with a `QueueError` at once, before it claims a job.

**Storage:**

- `UploadsConfig.lifetime` and `sendWithin` are `lifetimeMinutes` and `sendWithinMinutes`; the environment variables are unchanged.
- A disk driver of your own (`static diskDrivers`): the factory returns a `DiskDriver`, and its `temporaryUrl(key, options)` receives `{ expiresInSeconds, filename?, base? }`, whole seconds of at least 1, instead of `expiresIn`. The app-facing `disk.temporaryUrl(key, { expiresIn })` still takes a `Duration`.

**Scheduler:**

- `.withoutOverlapping(30)` (minutes) becomes `.withoutOverlapping({ expiresAfter: { minutes: 30 } })`. The old form is a type error, and untyped code gets a `TypeError` naming the new form. The default stays 24 hours.

**Auth and session:**

| Before | After |
| --- | --- |
| `AuthConfig.passwordTimeout` (seconds) | `passwordTimeoutSeconds` |
| `AuthConfig.resetExpire` (minutes) | `resetMinutes` |
| `AuthConfig.resetThrottle` (seconds) | `resetThrottleSeconds` |
| `AuthConfig.emailChangeThrottle` (seconds) | `emailChangeThrottleSeconds` |
| `SessionConfig.lifetime` (minutes) | `lifetimeMinutes` |
| `confirmedPassword({ seconds: 60 })` | `confirmedPassword({ maxAge: 60 })` or `{ maxAge: { minutes: 1 } }` |
| `TWO_FACTOR_MAX_AGE` | no longer exported; write `{ hours: 24 }` |
| `error.retryAfter` of a `throttled` failure | `error.retryAfterSeconds` |

- Reading an old config key throws a `TypeError` naming the new one, and `confirmedPassword({ seconds })` is refused.
- `twoFactor({ maxAge })` takes a `Duration` too; a number still means seconds, and the default stays 24 hours.
- A `throttled` failure comes from `attempt()`, two-factor, passkeys and password checks. An app that copied the kit's auth controllers renames the field there.
- Every window keeps its value.


#### Medium: The client's spans of time name their unit, in milliseconds

*Likelihood of impact: medium — apps on `@marmeon/react` that set prefetch, progress, pending, debounce or poll times.*

Rename the options; the values stay milliseconds, and TypeScript reports every place that still uses an old name.

| Before | After | Where |
| --- | --- | --- |
| `cacheFor` | `cacheForMs` | `<Link>`, `router.prefetch()`, `PrefetchOptions` |
| `delay` | `delayMs` | `progressBar()`, `showProgress()` (`ProgressOptions`) |
| `delay: 300` | `delayMs: 300` | `usePending()`; `delay: 'short'` stays |
| `debounce` | `debounceMs` | `useQueryState()` (`QueryStateOptions`), the `validate` option of `useForm()` and `<Form>` (`LiveValidationOptions`) |
| `searchDebounce` | `searchDebounceMs` | `useTable()` (`TableControllerOptions`) |
| `poll` | `pollMs` | `<Island>` |
| `HOVER_PREFETCH_DELAY` | `HOVER_PREFETCH_DELAY_MS` | `@marmeon/http/client/adapter` |

`usePoll` and `createPoll` take their interval in the options:

```ts
// before
usePoll(15_000, reloadOptions, { keepAlive });
createPoll(run, 1000, options);
// after
usePoll({ intervalMs: 15_000, keepAlive }, reloadOptions);
createPoll(run, { intervalMs: 1000, ...options });
```

The old form is a type error and throws a `TypeError` naming `{ intervalMs }`. An interval that is not finite, not above 0 or above 2 147 483 647 ms throws C5, in `usePoll` on the server too.


### Data and the queue

#### High: The generated table types declare primary keys

*Likelihood of impact: high — every app with `@marmeon/database`.*

`bootstrap/database.d.ts` is format 3: it fills a new `PrimaryKeys` interface with the primary key of every table, and a repository takes its key from the schema instead of a column named `id`. A `json()` column is written as `JsonColumn<'table.column'>`, which reads as `Json` unless the app declares a type for that key (below).

- Run `marmeon db:types` once and commit `bootstrap/database.d.ts`; `marmeon db:types --check` fails with "generated by another version" until then.
- Replace `KeyOf<'table'>` with `PrimaryKeyOf<'table'>`.
- A table you type by hand declares its key, or `find()` and the other methods that take a key refuse it in the types:

  ```ts
  declare module '@marmeon/database' {
    interface PrimaryKeys { orders: 'id' }
  }
  ```

- A table without a single-column primary key makes `find()`, `findOrFail()`, `exists()`, `update()`, `tryUpdate()`, `delete()`, `forceDelete()`, `restore()`, `relation()`, `chunk()` and the route binding throw a `TypeError`; there is no fallback to `id`. Use `query()` for such a table.
- A table that raw SQL (`schema.raw()`) created is unknown to a managed connection, so its repository has no key: create the table with `schema.create()`, or use `query()`.
- A route binding checks the value against the key column first: digits for an integer, a UUID for a `uuid`, at most 255 characters for anything else; any other value answers 404. A key of a timestamp, boolean, JSON or decimal column needs a `static routeKeyPattern` on its repository, and so does a text key longer than 255 characters.
- A scoped route binding compares with the column the foreign key references, and a scope column that is no foreign key is a `TypeError`.
- A `json()` column can carry the type of its value. Declare it once and `Row<…>`, `select` and `find()` read the column as that type instead of `Json`; a declared type that is not JSON (a `Date`, a class, a function, `bigint`, `unknown`) reads as a message that names the key, and an open part is typed as `Json`. The type is a promise: nothing checks the shape of a value on read, and writes still take a string (`JSON.stringify`). Nothing changes for a column without a declaration. See [a JSON column's type](docs/queries.md#a-json-columns-type).

  ```ts
  declare module '@marmeon/database' {
    interface JsonTypes { 'surveys.options': readonly string[] }
  }
  ```


#### Low: Postgres connections time out after 10 seconds and keep UTC

*Likelihood of impact: low — apps whose Postgres server is slow to accept a connection, or that set `TimeZone` through `?options=`.*

- The pool and the migration lock give up connecting after 10 s with D11. If the server needs longer, e.g. a paused serverless database, set `?connect_timeout=<seconds>` in `DB_URL`: whole seconds from 0 to 2147483, and `0` waits without a limit, as before. Any other value stops the start, naming it.
- A full pool that cannot hand out a connection in that time fails with D11 "no free connection; raise `DB_POOL_MAX` or shorten transactions".
- A `DB_URL` with its own `?options=` keeps them, and UTC is set after them, so a `TimeZone` among them is replaced by UTC.


#### Low: queue.using(trx) follows its own transaction, and a stopped job keeps its attempt

*Likelihood of impact: low — apps that dispatch through `queue.using(trx)` or listen to `JobQueued`.*

- Dispatch a `sync` or unique job through `queue.using(trx)` only with the `trx` that `connections.transaction()` hands you. With a transaction you began yourself (`db.transaction()`, `db.startTransaction()`, a second connection) or a derived handle (`trx.withSchema()`), such a dispatch throws `QueueError`, in `Queue` and in `QueueFake`.
- A listener on `JobQueued` runs after the commit, and not for a transaction you began yourself.
- A job cut off by a worker stop (past `--stop-timeout`) goes back without counting its attempt, so it no longer lands in `failed_jobs`. A worker killed outright or a job that times out still counts it.


#### Low: A transaction takes one of three isolation levels

*Likelihood of impact: low — apps that pass `isolationLevel: 'snapshot'` or `'read uncommitted'`.*

`TransactionOptions.isolationLevel` takes the exported `IsolationLevel`: `'read committed'`, `'repeatable read'` or `'serializable'`. Anything else is a type error and throws a `TypeError` before the transaction begins.


#### Low: A lock that waits returns a Result

*Likelihood of impact: low — apps that call `lock.block()`.*

`lock.block(wait, callback)` returns `ok(result)`, or `err({ kind: 'timeout' })` without calling the callback, like `lock.get(callback)` returns `err({ kind: 'locked' })`. `LockTimeoutError` is gone. Returned from a `transaction()` callback, `timeout` rolls the transaction back.

`block()` always takes the callback now, and throws a `TypeError` without one: the protected code never runs without the lock. To hold a lock without a callback, take it with `get()` and release it yourself.

```ts
// before
const report = await cache.lock('report', 60).block(5, () => this.#reports.build());

// after
const report = await cache.lock('report', 60).block(5, () => this.#reports.build());
if (!report.ok) abort(423);
```


#### Low: Queue sizes and unique jobs in tests name what they mean

*Likelihood of impact: low — apps that count a queue on another connection, or assert on unique jobs in tests.*

- `queue.size(name, connection)` becomes `queue.size(name, { connection })`. `queue.size('redis')` counted the queue named `redis`; a second string is now a type error and throws.
- In tests, the `unique` of a dispatched job reads `forSeconds` instead of `for` (type `DispatchedUnique` of `@marmeon/queue/testing`).


#### Low: The where of unique() and exists() is typed by the repository's query

*Likelihood of impact: low — apps that pass `where` to `unique()` or `exists()`.*

The `where` callback gets the repository's own query type instead of `any`. A wrong column name, a value of another type, or a callback that does not return the query (an `async` one, one without `return`) is a compile error. Fix the column or the value, or run `marmeon db:types` if the column is new. `ctx` stays `any` unless you annotate it with the context the request has, such as `ctx: HttpContext<Authenticated, { workspace: Row<'workspaces'> }>`, which then also checks `ctx.params`. Run-time behaviour does not change.

There is no way back. See [database rules](docs/validation.md#database-rules-and-why-they-never-run-live).


#### Low: Equal live hints of one transaction go out once

*Likelihood of impact: low — apps that call `broadcast.refresh()` per row inside a transaction, and their tests that count hints.*

Inside a transaction, `refresh()` registers its hint on the outermost transaction, and after the commit equal hints go out once: the same channel, the same `only` in any order, leaving out the same tab. A hint from a savepoint that rolled back is dropped; outside a transaction every hint goes out at once, as before. The channel's sequence rises once per transaction, so an open tab reloads once. A test that expected n hints for n rows changed in one transaction expects one, in `assertRefreshed({ times: n })`, `app.live(path).waitFor(n)` and `app.broadcast.refreshed(channel)`.

There is no way back. See [sending hints](docs/realtime.md#sending-hints).


#### Medium: A Redis queue name must not collide with the keys of another queue

*Likelihood of impact: low — apps on the Redis queue driver with a queue whose name ends in `:delayed` or `:reserved`.*

On the Redis driver, a queue named `a:delayed` used the key `queues:a:delayed` as its list, which is queue `a`'s delayed set; the same held for `:reserved`. A push or a reserve failed with `WRONGTYPE` or mixed the jobs of two queues. The driver now refuses such a name before any Redis call, in push, reserve, size, counts, ack, release and fail, with a message that names the queue, the suffix and the queue it would collide with. `a:delayed:x` and `delayed` stay allowed; the database and memory drivers are unaffected.

- A default queue with such a name (`QUEUE_REDIS_QUEUE`) stops the app at the start with Q4.
- A refused name that is already in the queue registry is no longer listed or taken, so jobs queued under it are not worked. `queue:size`, the devtools page and the worker's look at other queues keep working.
- Rename the queue, then move its jobs with the workers stopped:
  1. Pick a name no queue uses yet. Move `<prefix>queues:x:delayed` to `<prefix>queues:x-delayed` with `RENAMENX`, and do the same for its `:delayed` and `:reserved` keys if they exist. `RENAMENX` refuses an existing target; `RENAME` would overwrite it and lose its jobs. Check `TYPE <prefix>queues:x:delayed` first: only a `list` belongs to `x:delayed`; a `zset` is queue `x`'s delayed set and stays.
  2. Run `SREM <prefix>queues x:delayed` and `SADD <prefix>queues x-delayed`.

There is no way back. See [the queue drivers](docs/queues.md#drivers).

### Configuration and drivers

#### Medium: A size in an environment variable names its unit

*Likelihood of impact: medium — apps that set `SERVER_MAX_BODY_SIZE`, `MAX_BODY_SIZE` or `HASH_ARGON_MEMORY`, or pass `maxBodySize`.*

An old name that is still set stops the start and names the new one, with the conversion. Check `.env`, `.env.test`, the deployment settings and CI.

| Before | After | Value |
| --- | --- | --- |
| `SERVER_MAX_BODY_SIZE=8m`, `MAX_BODY_SIZE` | `SERVER_MAX_BODY_MB=8` | whole MiB, 1 to 1024 |
| `HASH_ARGON_MEMORY` | `HASH_ARGON_MEMORY_KB` | KiB, unchanged |
| `createHttpKernel(app, { maxBodySize })` | `createHttpKernel(app, { maxBodyBytes })` | bytes |
| `ServerConfig.maxBodySize` | `ServerConfig.maxBodyBytes` | bytes |
| `DEFAULT_MAX_BODY_SIZE` (`@marmeon/router`) | no longer exported; the default stays 8 MB | |

Divide a value in bytes by 1,048,576; it must come out as a whole number. A limit under 1 MB, or one that is no whole number of MB, goes through `createHttpKernel(app, { maxBodyBytes })`.


#### Low: A mail transport of your own returns the provider's message id

*Likelihood of impact: low — apps with a mail transport or a `Mailer` of their own, or code that reads `MailConfig`.*

- A transport's `send()` resolves with a `MailReceipt`, `{ messageId }`, where `messageId` is `undefined` when the provider gives none. It may have a `close()`.
- A class that implements `Mailer` resolves `send()` with a `SentMail`: the composed message and its `messageId`.
- `MailConfig.mailer` is `MailConfig.driver`, and the boot warnings of the log mailer carry the log context key `driver`.
- A provider can bring a transport with `static mailDrivers = { name: factory }` and `MAIL_DRIVER=name`; binding `MailTransport` in the container still works. A `MAIL_DRIVER` that no provider brought stops the start with Q8 and lists the known names.


#### Low: The Vite plugin has no pages and lang options

*Likelihood of impact: low — apps that pass `pages` or `lang` to `marmeon()` in `vite.config.ts`.*

Remove both options; passing either throws a `TypeError`. Views live in `modules/<module>/views/` (`.tsx`), language files in `lang/` and `modules/<module>/lang/`. A custom glob only half worked before: the route types and the server's translator read the default places.


#### Low: createPinoLogger() takes its destination and app as options

*Likelihood of impact: low — apps that build their own pino logger.*

`createPinoLogger(config, stream, app)` is `createPinoLogger(config, { destination: stream, app })`. A stream as the second argument, or a third argument, throws a `TypeError`.


#### Low: The kernel's asset version is assetVersion

*Likelihood of impact: low — apps that pass `version` to `createHttpKernel()`.*

`createHttpKernel(app, { version })` is `createHttpKernel(app, { assetVersion })`, the name of `ServerConfig.assetVersion` and `SERVER_ASSET_VERSION`. The old key throws a `TypeError`.


#### Low: Vite's base is / or an absolute URL, and the server links a page's chunks under it

*Likelihood of impact: low — apps that set `base` in their Vite config.*

The server serves the build under `/` only, so a path base (`/static/`) or a relative one (`./`) never worked without a proxy. `marmeon build` now refuses both when Vite resolves its config, and a build made earlier with such a base stops `marmeon start`, with the value named. An absolute `http(s)` URL that ends in `/` and carries no credentials, query or fragment is accepted; the server then prefixes every modulepreload and page stylesheet with it, where it used to link them as `/assets/…` on its own origin, which answered 404 when the assets lived elsewhere.

- Build with `base: '/'` (the default) or with the absolute URL where the assets are hosted. Apps that leave `base` alone change nothing.
- A CDN base: the CDN has to send `Access-Control-Allow-Origin`, because every tag is `crossorigin`; and a policy without the nonce needs the origin in `script-src` and `style-src`.

There is no way back. See [the base](docs/vite.md#the-base).

#### Low: A session codec of your own has no encrypts

*Likelihood of impact: low — apps that bind a `SessionCodec` of their own.*

`SessionCodec` is `seal()` and `open()`; `encrypts` is gone, and nothing read it. Remove it from your codec: an object typed as `SessionCodec` with `encrypts` no longer compiles.

```ts
// before
const codec: SessionCodec = { encrypts: true, seal, open };
// after
const codec: SessionCodec = { seal, open };
```


### Routes and pages

#### Low: A route pattern reads the same everywhere, or the start stops

*Likelihood of impact: low — apps with unusual route patterns.*

A pattern that the server, links, the bind check and the sitemap could read differently stops the app with H13, which names the pattern:

- a parameter name is letters, digits and `_`, starting with a letter or `_` (`:user_id`, not `:user-id`);
- a parameter fills a whole segment (not `/a/:x{[a-z]+}.json`);
- only the last parameter may be optional (not `/a/:x?/b`);
- a name may not repeat in one pattern;
- a constraint must be closed and may not name a group.

`ExtractParams` reads a parameter only after `/` or at the start of the path, so `/files/v:version` gives no key, as at run time.


#### Low: A file in a list, a union or an optional object stops the start

*Likelihood of impact: low — apps with an `upload()` field that is not a field of its own.*

A body schema with `upload()` inside a list (`r.array`, `r.list`), a union, a field added with `.when()`, or an optional, nullable or defaulted object at any depth stops the start with S2, naming the field. Such a schema never worked: the submit answered "invalid" without saying why. Give each file a field of its own, in the body or in an object that is always there; `upload(…).optional()` and `.nullable()` on the field stay allowed. A schema built by a factory is checked at its first submit instead, and answered with a 500.


#### Low: twitter.image takes the shape of openGraph.image

*Likelihood of impact: low — pages that set `twitter.imageAlt`.*

```tsx
// before
twitter: { image: '/card.png', imageAlt: 'A card' }
// after
twitter: { image: { url: '/card.png', alt: 'A card' } }
```

A plain `twitter: { image: '/card.png' }` keeps working. `twitter:image:alt` is written only next to an image that survives URL resolution, and a relative URL resolves against the origin of `APP_URL`.


#### Low: Head keeps its server tags when the page hydrates

*Likelihood of impact: low — tests that assert the head marker, default layouts with an `error` that is no component, and path-relative head URLs.*

- A test that asserts `data-marmeon-head="ssr"` on a child tag of `<Head>` now sees `ssr-tag`; the title and the head fields keep `ssr`.
- A default layout whose `error` is not a component fails on every page with R19, like a page's own layout. Such an app was already broken on its first error.
- A path-relative head URL (e.g. `canonical="notes/1"`) resolves against the origin of `APP_URL`, not its path. Root-relative values such as `/de/x` are unchanged.
- An element that `<Head>` creates gets only primitive props, never `on*`, objects or functions. Script and style get the page's nonce; their own `nonce` prop is ignored.


#### Low: Once props are scoped by the page's language

*Likelihood of impact: low — apps that copied the auth kit's tests.*

The browser keeps a page's once props per session and language, so a switch from `/de/…` to `/en/…` sends them again. An app's code changes nothing. An app that copied the kit's tests keeps an old test in `modules/auth/auth.test.ts` ("the app name in the layout … comes with the first page only") that now fails: take the current version from the kit (`marmeon make:auth --force` for the test file, or copy it).


#### Low: block() on a route takes lock and wait by name

*Likelihood of impact: low — routes that pass arguments to `.block()`.*

`.block(5, { seconds: 2 })` becomes `.block({ lock: 5, wait: { seconds: 2 } })`: two spans of time side by side were easy to swap. `.block()` without arguments is unchanged, and so are the defaults (`lock` 10 seconds, `wait` as long as `lock`). A number as the first argument, a key it does not know, or a second argument throws a `TypeError`.


#### Low: Flash data is put with session.flashData()

*Likelihood of impact: low — apps that call `session.flash()`.*

`session.flash(key, value)` is `session.flashData(key, value)`. "Flash" now always means the message that `redirect().flash()` sends and `useFlash()` shows; flash data is read with `session.get()` on the next request, like `redirect().with()`. There is no alias, so TypeScript points at every call.


#### Low: WhenVisible takes reload, and resolveRoute() takes options

*Likelihood of impact: low — pages that pass `params` to `<WhenVisible>`, and client adapters of your own.*

- `<WhenVisible params={{ only: ['stats'] }}>` is `<WhenVisible reload={{ only: ['stats'] }}>`. On every other component `params` are route parameters. `params` on `<WhenVisible>` throws a `TypeError` naming `reload`.
- For client adapters: `resolveRoute(manifest, name, params, query, { locale })` is `resolveRoute(manifest, name, { params, query, pageLocale })`. More arguments, or a key it does not know, throw a `TypeError`. `Navigator.cachedPages` is internal.


#### Low: The error pages and the layer backdrop live in the system module

*Likelihood of impact: low — apps with their own error page (`modules/errors/views/`) or layer backdrop (`modules/layers/views/Backdrop.tsx`).*

Move `modules/errors/views/` to `modules/system/views/errors/` and `modules/layers/views/Backdrop.tsx` to `modules/system/views/layers/Backdrop.tsx`, then run `marmeon route:types`. The views are named `system/errors/Error`, `system/errors/<status>` and `system/layers/Backdrop`: a test that asserts `assertPage('errors/Error')` asserts `system/errors/Error`, and a `layout(name)` that compares names gets the new ones. Until the files are moved, `marmeon dev`, `build`, `route:types` and `check` stop with K14 and name the new path.


#### Low: A binder's context is typed by the state of its route

*Likelihood of impact: low — apps with a route binder of their own that reads `ctx`, and code that calls `resolveRouteBinding()` itself.*

`RouteBindingContext<State>` types `ctx` by the state the binder needs; without the argument it carries no state, where it was `any`.

- A binder that reads `ctx.user`, or anything else a middleware adds, declares it: `resolveRouteBinding(value: string, { ctx }: RouteBindingContext<Authenticated>)`. `bind()` then compiles only on a route behind `authenticate()`, and the message names the missing keys.
- Code that calls `resolveRouteBinding()` itself passes a context whose `params` are the raw strings, or uses `findByRouteKey(value)`. `findByRouteKey()` hands the binder a context that throws a `TypeError` naming the repository when read.
- Binders that read only `scope`, `with`, `request` or `params` are unaffected.

There is no way back. See [your own binder](docs/routing.md#your-own-binder).


#### Low: A form's field for a boolean rule is a boolean

*Likelihood of impact: low — pages whose form has a field of `r.boolean()` or `r.accepted()` and set it to something other than `true` or `false`, compare it with `'on'`, or cast it.*

In a form typed from its controller (`useForm('route', …)`, `useForm<Controller>()`, `FormHandle`, `FormPart`) a field whose rule is `r.boolean()` or `r.accepted()` holds a `boolean`, also inside an object or a list; with `.optional()` or `.default()` it is `boolean | undefined`. The same holds for such a field in the `data` of `useAction().submit()`, and `PendingSubmission.input` types it `boolean`. A checkbox needs no cast: `checked={form.data.agree}` and `form.set('agree', event.target.checked)`.

- Code that sets such a field to `'on'`, `'1'`, `1` or another spelled-out value, in `form.set()`, `setData()` or the initial data, or casts it to the rule's input type, no longer compiles: set `true` or `false`.
- A check like `form.data.agree === 'on'` becomes `form.data.agree`.
- A form typed directly (`useForm<{ agree: BooleanInput }>()`) keeps its type.

Requests do not change: the rules still take `'on'`, `'0'` and `'1'` from a form posted without JavaScript.

There is no way back. See [fields and errors](docs/forms.md#fields-and-errors).


#### Medium: A route form types number fields as numbers and defaulted fields as present

*Likelihood of impact: medium — every `useForm()` form that has a number rule or a `.default()` field.*

`form.data.count` was `number | \`${number}\``, and a field with `.default()` was optional in `form.data` and `initial`. Now:

- A number rule's field is `number`. Where the field may be missing (optional, nullable or defaulted), it also takes `''` for an empty input.
- A defaulted field is required in `form.data` and `initial`, inside objects, lists and union members too.
- A pending submission's `input` is what was sent: an action's data as passed, or a route form's fields.
- `useAction()` bodies are unchanged. `FormOutputOf<C>` and `ActionFields` are exported.

What an app does: set numbers (`e.target.valueAsNumber`), or `''` for an empty optional field; add every defaulted field to `initial`, and drop `?? []` fallbacks. In an app from the starter kit, both two-factor forms need `{ code: '', recovery_code: '' }`. `pnpm typecheck` lists each place. There is no way back.

#### Low: A later .when() sees the fields of the .when()s before it

*Likelihood of impact: low — schemas that put a condition on a conditional field.*

A condition on a field that an earlier `.when()` adds never held, so its fields were neither checked nor in the body. Now a later `.when()` sees the fields of the ones before it, and its fields are checked and kept. Send the fields the form shows, or change the condition. There is no way back.

#### Low: A standalone describeAccess() check sees HttpContext, not any

*Likelihood of impact: low — checks written apart from their route that read params or middleware state.*

`describeAccess((ctx) => …, label)` outside `.authorize()` gave `ctx: any`, so a typo in `ctx.params` compiled. Such a check now sees `HttpContext`, and it must return `boolean` or `Promise<boolean>`. A check written inside `.authorize()` keeps the route's bound context. Write the check inside `.authorize()` after the `.bind()` it reads, annotate `ctx` (`HttpContext<Authenticated, { ticket: Ticket }>`), or pass the type argument. There is no way back.

#### Low: An island request reaches only a controller that returns island()

*Likelihood of impact: low — islands built outside a controller method, module packages with island controllers, and tests that stand in for an island.*

A request with the island header used to reach any route, run its middleware, and only then learn whether the handler returned an island. Now the loader marks the controllers whose own methods call `this.island(…)` or `island(…)` imported from `@marmeon/http`, in development, in Vitest and, through `.marmeon/injections.json`, in production. An island request to any other route answers 404 before a middleware runs, and a marked route answers a page request with 404 after the global middleware.

- A closure route or a helper outside the controller that returns `island()`: write it as a controller class that calls `this.island(…)` in one of its methods.
- `island` imported through a module of the app that re-exports it: import it from `@marmeon/http` in the controller's own file, or call `this.island()`.
- A module package that ships island controllers: rebuild it with `marmeon package:build` from this version; a package built before answers 404 for its islands.
- A controller that returns a page or an island depending on a branch: split it into two routes.
- Tests: a fixture that stands in for an island needs such a controller too; a test that expected a login redirect on a direct call of an island URL expects 404.

`marmeon route:list` shows island routes. There is no way back.

#### Low: A resolver you pass to the router takes a class or a token

*Likelihood of impact: low — code that passes its own `resolve` to `validate()`, `new Router()` or `dispatch()`.*

A route's checks (`authorize`, `afterAuthorize`, `describeAccess`) and its hooks can now resolve a token, not only a class: `resolve(Clock)` or `resolve(Translator)` works where only `resolve(SomeClass)` did. A hook can read `session.readOnly` to tell whether the request may change the session, and runs after the locale is set, so a hook after `RequestLocale.use()` already speaks the new language ([after the checks](docs/routing.md#after-the-checks)).

An app that uses the defaults has nothing to do. A resolver you pass yourself, to `validate(schema, value, { resolve })`, `new Router({ resolve })` or `dispatch(…, { resolve })`, is now typed `<T>(key: Constructor<T> | Token<T>) => T`:

```ts
// before
resolve: (Class) => new Class()
// after
resolve: (key) => container.make(key)
```

A resolver typed for classes only does not compile any more; otherwise check `typeof key === 'function'` before `new key()`. Outside an app, the default resolver refuses a token with a `TypeError` that names it.

There is no way back.

#### Low: A table's filters and its actions' answers are typed by name and by handler

*Likelihood of impact: low — pages that type a `run()` or `runBulk()` callback with the bare `TableRunOutcome`, or a table's data by hand.*

`table.filter('status')` reads the filter `status` of the props as its definition made it (a select with `options`, a date range, a `has` filter); a name the table does not define is a type error. `run()` and `runBulk()` type `outcome.data.data` as what the action's handler returns, serialized (a `Date` becomes a `string`). A handler that answers with `json(body)` types `outcome.data` as that body, without counts; a `Response` handler gives `unknown`; a redirect-only handler has no data outcome at all.

- A callback typed with the bare `TableRunOutcome` no longer accepts the outcome of an action whose handler returns `json()` or a `Response`. Let the run type it, or widen it on purpose:

  ```ts
  // before — no longer compiles for such an action
  table.run('report', row).then((outcome: TableRunOutcome) => …);
  // after
  table.run('report', row).then((outcome) => …);
  const report = (outcome: TableRunOutcome<any, any, boolean>) => …;
  ```

- A value typed by hand as `TableData<Row, …>` no longer fits `TableProps<typeof SomeTable>` for a table with actions or filters: type it as `TableProps<typeof SomeTable>`.
- A cast such as `outcome.data.data as { at: Date }` fails, because the date arrives as a string.

A hand-written `TableFilter<'a' | 'b'>` still fits, `useTable()` call sites do not change, and a bare `TableRunOutcome` is the same type as before. There is no way back.

#### Low: IslandElementProps is a union of route and href

*Likelihood of impact: low — components that are typed with `IslandElementProps`.*

`<Island href={…}>` embeds an island whose URL the server chooses, so a page can render the panels a user may see without knowing every panel's route ([islands the server chooses](docs/deferred-props.md#islands-the-server-chooses)). `IslandElementProps` is therefore a union of the `route` form and the `href` form. A component typed `(props: IslandElementProps<N>)` narrows before it reads `props.route`; `href` is the other member. `Omit<IslandElementProps, …>` no longer distributes over the members. Apps that only use `<Island route>` change nothing.

There is no way back.

#### Medium: An island rendered with its page sees cookies only while the page is private

*Likelihood of impact: medium — apps with islands on pages outside the session group, or on a guest's page, that read a cookie or the session.*

An `<Island route>` on a page without `StartSession` was resolved in-process with the visitor's `cookie` header. When the island's route started the session, it loaded the visitor's own, although the page had gone out as `public` with the shell: a cache could keep a signed-in visitor's data and serve it to everyone. The server now decides before it runs the island:

- An island whose route starts the session, on a page that started none, loads in the browser: the server renders its `fallback`, and the island appears after hydration with the visitor's own session. Nothing runs twice.
- The `cookie` header reaches an island rendered with its page only while the page is private: for a visitor whose session the store already keeps (a signed-in one, or a guest whose session holds data). On pages without `StartSession`, on a guest's page in the session group, and in apps without `@marmeon/session`, the island sees no cookies.
- In development, a warning names the page route and the island route once.

Pass what such an island reads from a cookie as page props, or let it load in the browser; to render a session island on the server, put its page in the session group. Check tests that expect server-rendered content from session islands on such pages.

There is no way back. See [how islands load](docs/deferred-props.md#how-islands-load).


#### Low: A table's authorize must return true

*Likelihood of impact: low — tables whose `authorize` returns something other than a boolean.*

A table's own `authorize` was tested for truthiness, so an untyped check that returned a `Response`, an object, `1` or a non-empty string let the request through; the `boolean` type stopped it only at compile time. The page, the row actions, the bulk actions and the exports now let a request through only when the awaited check is `true`. Any other value answers 403, like `false`; a check that throws (`can()` with 403 or 404) still propagates. An `authorize` that returns a boolean changes nothing.

### Renamed exports

#### Low: Names that two packages exported have names of their own

*Likelihood of impact: medium — apps that import one of the names below; TypeScript reports each.*

Rename the imports and type positions; there are no aliases.

| Before | After | Package |
| --- | --- | --- |
| `RequestInfo` (type and token) | `ClientInfo` | `@marmeon/http` |
| `NO_REQUEST_INFO` | no longer exported; write `{ ip: undefined, userAgent: undefined }` | `@marmeon/http` |
| `RequestInfo`, `JobInfo`, `TaskInfo` | `CurrentRequest`, `CurrentJob`, `CurrentTask` | `@marmeon/core` |
| `ActionException`, `VisitException` | `ActionError`, `VisitError` | `@marmeon/http/client`, `/client/adapter`, `@marmeon/react` |
| `Router`, `Action` (the types of `useRouter()` and `useAction()`) | `ClientRouter`, `ClientAction` | `@marmeon/react` |
| `KeyOf`, `ParamsOf`, `CheckKey` | `MessageKeyOf`, `MessageParamsOf`, `CheckMessageKey` | `@marmeon/i18n`, `@marmeon/i18n/messages` |
| `Invokable`, `InvokableClass` | `CallableTask`, `CallableTaskClass` | `@marmeon/scheduler` |
| `Entry` | `CacheEntry` | `@marmeon/cache` |
| `ServeOptions` | `ServeFileOptions` | `@marmeon/storage` |
| `ColumnOf` | `RepositoryColumnOf` | `@marmeon/validation` |
| `PasskeyConfigError` | `PasskeySetupError` | `@marmeon/auth/passkeys` |

`ActionError` and `VisitError` are types, not classes, so there is no `instanceof` to change.


#### Low: PostgresConnection is PostgresConnectionOptions

*Likelihood of impact: low — apps that import the type of a Postgres connection's options.*

The options of a Postgres connection (`driver: 'pgsql'`, `url`, `host` …) are `PostgresConnectionOptions`, like `RedisConnectionOptions` and `QueueConnectionOptions`. `Connection` stays the connection itself. There is no alias.


### Packages that left experimental

#### Low: The data tables have names of their own

*Likelihood of impact: low — apps with `@marmeon/table`, `@marmeon/react/table` or `@marmeon/react/table-tanstack`.*

| Before | After |
| --- | --- |
| `Table` (what `defineTable()` returns) | `DataTable` |
| `Tables` (the injected service) | `DataTables` |
| `RowOfTable` | `DataTableRow` |
| `RowOf` of `@marmeon/react/table` and `@marmeon/table/client` | `TableRowOf` |
| `Column` | `ColumnDefinition` |
| `CheckKey` | `CheckColumnKey` |
| `VisibilityCheck` | `TableVisibilityCheck` |

- The `RowOf` helper of `@marmeon/table` is no longer exported: read a row with `DataTableRow<typeof MembersTable>`. `KeyName` and `Visibility` are no longer exported either.
- The constructor of `DataTables` is internal: take the service by injection.


#### Low: @marmeon/live names the units of its config and its test reader

*Likelihood of impact: low — apps that read `LiveConfig` or test live updates.*

- `LiveConfig.heartbeat` and `retry` are `heartbeatSeconds` and `retryMs`; the environment variables are unchanged.
- In tests, `BroadcastRecorder` is `BroadcastTester`, and `stream.retry` of a `LiveStreamReader` is `stream.retryMs`. The timeout of `hello()` is a `Duration`, so a number is seconds ([spans of time](#medium-spans-of-time-are-seconds-or-a-duration-and-values-handed-back-name-their-unit)). `stream.waitFor(until, timeout, what)` becomes `stream.waitFor(until, { timeout, what })`, with `timeout` a `Duration`; `waitFor(1)` is unchanged. The constructor of `LiveStreamReader` is internal.
- `LiveBackend` and `LiveMessage` are no longer exported; they have no replacement.


#### Low: @marmeon/devtools has names of its own

*Likelihood of impact: low — apps that import from `@marmeon/devtools` or read its entries.*

- `DevtoolsConfigError` is `DevtoolsSetupError`.
- Each content type is named after its entry: `MailContent` is `MailEntryContent`, `RequestContent` is `RequestEntryContent`, and so on; the embedded `ErrorContent` is `ErrorDetails`. The keys of the entries (`'mail'`, `'exception'` …) stay.
- `FileStore` and `FileStoreOptions` are `FileDevtoolsStore` and `FileDevtoolsStoreOptions`. `MemoryStore` is no longer exported: type a variable `DevtoolsStore`.
- A reader of job entries reads `content.delaySeconds` instead of `content.delay`.
- `DevtoolsTester` is exported as a type only (`import type`); `createTestApp()` makes it, and `app.devtools` stays.
- Entries written before the upgrade may show incompletely; `marmeon devtools:clear` empties them.


#### Low: The client adapter API is stable and smaller

*Likelihood of impact: low — client adapters of your own; apps on `@marmeon/react` change nothing.*

- `pageQuery(page)` is `pageQueryOf(page)`.
- `@marmeon/http/client/adapter` no longer exports `loadLiveValidation`, `loadPrefetch`, `loadViewTransitions`, `withoutDefaults`, `mergePage` and `ResetProps`. For the two remembered-field patterns, see [the remembered-field patterns](#low-the-deprecated-remembered-field-patterns-are-gone).
- `defineFeature`, `Feature.setup`, `FeatureHost`, `slot`/`Slot`, `LayerHost`, the members of `LayerStack` but `list`, and the constructors of `RegionOwner`, `Region`, `LayerStack` and the feature classes are internal: an adapter uses the features the core ships.
- `islands.region()` refuses an owner that this navigator did not make with a `TypeError`, and `RegionOwner.live` is a `ReadonlyMap`.


### Internals moved

#### Low: Undocumented machinery leaves the stable API

*Likelihood of impact: low — apps that imported names no docs page names.*

One rename: `ReadOnlyViolation` (`@marmeon/http`) is `ReadOnlyError`; its code stays H6. Everything else below was undocumented; use the documented API instead.

- **`@marmeon/http`:** no longer exported from the main entry: `CONNECTION_HEADER`, `LIVE_PATH`, `LiveSigner`, `DOCUMENT_HEADER`, `SESSION_PATH`, `INTENDED_KEY`, `OLD_INPUT_KEY`, `flashableInput`, `jsonResponse`, `PageSession`, `AssetVersion`, `LiveDeclaration`, `browserRoutes`, `BrowserRoutes`, `Flasher`, `FlashEntry`, `PropOrigins`, `staticView` (now internal), and `addFlash`, `addLive`, `carryLive`, `withLiveMethod`, `toLayer`, `compilePolicy`, `epochOfResolver`, `SessionEpoch`, `SessionEpochController`, `SessionEpochAnswer`, `TabSyncMessage`, `TAB_SYNC_CHANNEL`, `LIVE_CHANNEL`, `mergeOf`, `propKind`, `resolveProp`, `ResolvedPage`, `PartialReload`, `OnceContext`, `ReadOnlyOptions`, `WritePermit`, `ERRORS_KEY`, `httpSolutions`, `BrowserRoute`, `HiddenReason`. `@internal`: `RedirectResult.toResponse()` and `CloseLayerResult.toResponse()`, `SharedData.entries/resolve/liveChannels`, `Prefetches.landed()/size`, and `Session.queueFlash/takeFlash` in `@marmeon/session`. Instant visits stay available through `<Link instant>` and `app.placeholder()`.
- **`@marmeon/core`:** no longer exported from the main entry: `MAX_ENTRY_BYTES`, `ENCRYPTED`, `currentTransaction`, `REDACTED_KEYS`, `runTransaction`, `rollBackOnErr`, `missingListenerQueue`, `InjectionWarning`, `NODE_ENVIRONMENTS`, `DOTENV_MARKER`, `resolveEnvironment`; the last three are internal in `@marmeon/core/environment` too ([the last machinery](#low-the-last-machinery-of-the-services-leaves-the-api)). `readEnvFile` is exported from no entry. `Container.onWarning()` and `Container.warnings` are `@internal`. Ask about a transaction with `inTransaction()`.
- **`@marmeon/router`:** no longer exported: `joinPaths`, `queryInput`, `issueOfFields`, `nothingToValidate`, `attributeName`, `parseCookies`, `serializeCookie`, `createNonce` (use `ctx.nonce()`), `messageOf`, `NOT_LIVE`. `Router.dispatch()` and `dispatchNotFound()` with their types `DispatchInput`, `DispatchOptions` and `ResponseFactory` are internal: a server of your own uses `createHttpKernel()`, and tests use the test app. The constructors of `Route` and `RouteDefinition` are `@internal`.
- **`@marmeon/validation`:** `RuleDefinition`, `RuleStep`, `BuildContext` and `Engine` are no longer exported; the `Rule` constructor, `~rule`, `~engine` and `with` are `@internal`. `~standard` is unchanged.
- **`@marmeon/database`:** a migration uses the builder's methods (`table.string()`, `table.index()` …), not `Blueprint`'s lists or `seal()`; the constructors of `Blueprint`, `Column` and `PendingFactory`, `Column.spec` and `allIndexes()` are `@internal`. The running methods of `Migrator` (`migrate`, `rollback`, `reset`, `fresh`, `dropAllTables`, `connections`) are `@internal`: run `marmeon migrate`, or, where a call must stay, pass `{ onRun, … }` as its only argument. `status()`, `changed()`, `missing()`, `projection()` and `files()` stay public. `SchemaMarker`, `MigrateOptions`, `MigrationRun`, `UnknownSchema`, `TypeGenerator` and `Rendered` are no longer exported.
- **`@marmeon/queue` and `@marmeon/notifications`:** `JobRunner`, `PayloadCipher`, `Prepared`, `WorkerDependencies`, `NotificationDeliverer`, `DelivererDependencies`, `PendingDelivery`, `NotificationRegistry` and `RecipientRegistry` are no longer exported. `QueueConnections.runner()` and `cipher()` and the constructors of `Worker` and `SendQueuedNotification` are `@internal`; get a worker with `app.make(QueueConnections).worker(…)`.
- **`@marmeon/auth`:** `PasswordHasherInternals` is no longer exported, and `new PasswordHasher(options)` takes only its options.
- **`@marmeon/server`, `@marmeon/testing`, `@marmeon/table`, `@marmeon/storage`, `@marmeon/devtools`:** build test responses with `createTestApp()`, table builders with `column()`/`filter.*`/`action()`/`bulk()`/`exportCsv()`, and render pages with the kernel's own renderer: the constructors of `TestResponse`, `PendingTestResponse`, `ColumnDefinition`, `Filter`, `RowAction`, `BulkAction` and `TableExport`, `TestResponse.from` and `KernelOptions.renderer` are `@internal`, and `PageRenderer`, `PageRenderOptions`, `RenderFailureDetails`, `CookieCrypto` and `SessionAccess` are no longer exported. `TemporaryUploads`, `TargetRequest`, `UploadTarget`, `UploadSource` and `UploadsOptions` are no longer exported, and the constructors of `TemporaryUpload` and `RejectedUpload` are `@internal`. `checkS3Sdk` is not needed. `StorageFake` no longer extends `StorageManager` (never importable); its public members are unchanged, only the protected `build()`/`memory()` are gone.
- **`marmeon`:** `run` from `marmeon/main` is no longer API; only the launcher calls it.


#### Low: Auth events take the user, the details and the time; service constructors are internal

*Likelihood of impact: low — apps that build auth events in tests or fakes, or build a framework service with `new` or extend one.*

`new SignedIn(user, remember, at, { via, ip, userAgent })` becomes `new SignedIn(user, { remember, via, ip, userAgent }, at)`, and `new TwoFactorChallengeFailed(user, at, details)` becomes `new TwoFactorChallengeFailed(user, details, at)`. The event objects keep their fields.

An app gets the framework's services from the container, and tests get the fakes from `createTestApp()`, so their constructors are no longer stable API:

- **`@marmeon/auth`:** `Auth`, `TwoFactor`, `Passkeys`, `EmailChange`, `PasswordBroker`, `AccountSessions`, `Gate`, `NoStoreWhenSignedIn`, `EmailVerification`, `TwoFactorStore`, `PasskeyStore`, `DatabaseAccessTokens`, `DatabasePasswordResetTokens`, `DatabaseSignIns`. The symbol-keyed members of `Auth` and `AccountSessions` are internal too. `DatabaseEmailChanges` keeps its constructor.
- **`@marmeon/session`:** `Session`, `StartSession`, `VerifyCsrfToken`, `ShareErrorsFromSession`, `UserSessions`, `SessionLottery`.
- **`@marmeon/http`:** `CheckAssetVersion`, `ClearClientHistory`, `EncryptCookies`, `UrlSigner`, `ValidateSignature`.
- **`@marmeon/core`:** `ErrorReports`, `EventDispatcher`, `ConsoleLogger`. A logger of your own implements `Logger` rather than extending `ConsoleLogger`. `TransactionFrame` is no longer exported at all ([the last machinery](#low-the-last-machinery-of-the-services-leaves-the-api)).
- **`@marmeon/database`:** `Migrator`, `Factories` (`Seeding` is no longer exported at all, [more names](#low-more-names-only-the-framework-used-leave-the-api)). **`@marmeon/cache`:** `RateLimiter`, `CacheHealthCheck`, `LimitLiveValidation`. **`@marmeon/i18n`:** `Locales`, `Translators`. **`@marmeon/redis`:** `RedisConnection`.
- **`@marmeon/queue`, `@marmeon/storage`, `@marmeon/notifications`:** `QueueConnections`, `QueueHealthCheck`, `QueueFake`, `StorageFake`, `NotificationFake`, `Inbox`. `NotificationStore` is no longer exported at all ([the last machinery](#low-the-last-machinery-of-the-services-leaves-the-api)).
- **`@marmeon/scheduler`:** `Scheduler`, and its methods `checkProcess()`, `lockWarning()` and `releaseHeld()`; run `marmeon schedule:work`.

Replace `new Gate(…)` with `container.make(Gate)` (or take it by injection), and a fake built by hand with the one `createTestApp()` installs.


#### Low: More names only the framework used leave the API

*Likelihood of impact: low — apps that imported a helper no docs page names.*

An app that imported one of these gets a type error. Where an app has a use for it, the replacement is named:

- **`@marmeon/core`:** `deprecated` is imported from `@marmeon/core/deprecation` only. `LOOPBACK_HOSTS`, `devSecured`, `devEnvironment`, `forbiddenDevHost` and `notInDevelopment` leave `@marmeon/core/dev`; `devHosts`, `devOnly` and the two host checks stay.
- **`@marmeon/http`:** `ActionParamsOf` is `ParamsOf`, and `ActionQueryOf` is `QueryParams` from `@marmeon/http/page` or `@marmeon/router`. `WrappedProp`, `ClientRoutesOptions`, `isLiveValidation` and `liveValidationFields` are no longer exported; `toSearchParams` leaves `@marmeon/http/page` and is internal everywhere ([the last machinery](#low-the-last-machinery-of-the-services-leaves-the-api)).
- **`@marmeon/router`:** `fillPath`, `isLiveValidation`, `liveValidationFields`, `AccessProblem`, `MiddlewareProblem`, `PipelineOptions`, `RequestStateOptions`, `ValidateOptions`, `MessageOptions`, `ValidatedRequest` and `RouteEntry` are no longer exported.
- **`@marmeon/auth/testing`:** `authenticatedToken` is no longer exported; sign in with `actingAs(user, { guard: 'api' })`, or create a token with `create()` of the `AccessTokenStore` (`app.make(AccessTokenStore).create(user.id, name, { abilities, expiresIn: null })`; `expiresIn` takes a `Duration` or `null` for a token that never expires).
- **`@marmeon/database`:** `Seeding` is no longer exported; run seeders with `marmeon db:seed` or the test app's `seed` option.
- **`@marmeon/i18n`:** `CurrentLocale` and `createTranslate` are gone, and `Messages` is imported from `@marmeon/i18n/messages` only.
- **`@marmeon/cli`:** `CheckReport`, `CheckStatus`. **`@marmeon/queue`:** `CacheSource`, `JobEvents`. **`@marmeon/storage`:** `TemporaryUrls`, `UploadRule`, `RejectedUpload`. **`@marmeon/notifications`:** `AnyRecipientResolverClass`. **`@marmeon/mail`:** `compose`. None has a replacement an app needs.


#### Low: The last machinery of the services leaves the API

*Likelihood of impact: low — apps and tests that built a framework service with `new`, or called a member or imported a name no docs page names.*

What the container or `createTestApp()` builds, and what only the framework calls, is internal. Take services from the container and fakes from the test app (`app.events`, `app.mail`, `app.schedule`, `app.storage` …):

- **`@marmeon/core`:** the constructors of `Container`, `EnvBlock`, `EnvSchema`, `EventFake`, `HealthChecks`, `ErrorSolutions`, `Redactor` and `TransactionFinishedError` (the error class stays); `Container.isScope`, `EventRegistry.listenersFor()` and `bindingsFor()`, `EventFake.isFaked()`, `Redactor.payload()` and `fit()`, `CurrentJob.fromReporter`. Make a scope with `container.createScope()` and environment variables with `env()` and the `e.*` builders. The `container` option of `createApplication()` is internal. `TransactionFrame` and `EventDispatcherOptions` are no longer exported. `environment.problem`, `check`, `fromDotEnv` and `dotEnvDevelopmentWarning` are gone from `environment`; `isDevelopment()`, `isProtected()`, `isTest()`, `name()`, `app()` and `describe()` stay. `resolveEnvironment()`, `buildEnvironment()`, `ResolvedEnvironment`, `DOTENV_MARKER` and `NODE_ENVIRONMENTS` in `@marmeon/core/environment` (and `ResolvedEnvironment` in `@marmeon/core`) are internal: the `marmeon` launcher resolves `NODE_ENV`, an app reads it through `environment` and names a value with `NodeEnvironmentName`. `HealthReport`, `HealthCheckResult`, `ListenerQueue` and `escapeHtml` are internal: write HTML with the `html` template, which escapes every value, and read `/up/ready` by its documented JSON; `@marmeon/queue` binds `ListenerQueue`.
- **`@marmeon/router`:** the constructors of `Router` and `CookieJar`, and `RouterOptions`; `CookieJar.lock()`, `useCodec()` and `queued()`, and `CookieCodec`; `RequestNonce.want()` and `forDocument()`; `MiddlewareGroups.version`; `Router.findByName()`; `RouteDefinition.routeName`, `inSitemap`, `isInternal` and `blocking`, and the `RouteBlocking` type. `matchesPath` and `urlFor` leave `@marmeon/router` and `@marmeon/router/url`, and `urlFor` leaves `@marmeon/http/page`: build a URL with `router.url(name, params, query)` or redirect with `redirect().route()`. A client adapter keeps `matchesPath` from `@marmeon/http/client/adapter`. `statusText()`, `toSearchParams()` (also from `@marmeon/router/url`), `ResponseContext`, `PageQuery`, `GET_HAS_NO_BODY` and `ISLAND_IS_GET_ONLY` are internal: read a status's text from `response.statusText`, and build a query with `URLSearchParams`. `CookieDefaults`, from `@marmeon/router` and `@marmeon/http`, is internal: `SESSION_SECURE_COOKIE` decides `Secure` for every cookie.
- **`@marmeon/i18n`:** `Locales.add()` is gone; the supported locales are fixed once the app has booted, and an app adds one through a language file or `APP_LOCALES`. `Catalog.namespaces()`.
- **`@marmeon/http`:** `ServerClosing`, `ReadOnly` and `ParentRequest` are no longer exported: the framework drives them, and there is no public replacement. The constructor of `CloseLayerResult` (use `closeLayer()`); `ClientHistory.cleared` and `siteData`; `CookieEncryption.isEncrypted()`. The fields of the page prop descriptors (`AlwaysProp.value`, `DeferredProp.group` and `resolve`, `MergeProp.value` and `match`, `OnceProp.resolve`, `key` and `expiresInMs`, `OptionalProp.resolve` …) are internal: create props with `always()`, `defer()`, `merge()`, `once()` and `optional()`.
- **`@marmeon/session`:** `Session.start()`, `save()`, `abandoned`, `ended`, `hasFlash()`, `started`, `persists` and `regenerateToken()`; `Session.readOnly` stays public. `Session.id` and `exists` are internal too: the id is the session's secret, so never log it or key data by it. Rotate the token with `session.regenerate()`.
- **`@marmeon/database`:** the constructor of `Connections`, and `isolate()`, `used()` and `verify()`; a test gets a clean database with `createTestApp(app, { database: 'refresh' })`, which isolates the `default` connection. Isolating another connection has no public replacement.
- **`@marmeon/table`:** `DataTables.runAction()`, `runBulk()` and `export()`, `DataTable.definition` and the read-only fields of the builders (`isSortable`, `visibility`, `confirms`, `limit` …); `TableDefinition` and `RowAuthorization` are no longer exported. `tables.resolve()` stays.
- **`@marmeon/auth`:** the writing methods of `TwoFactorStore` (`startSetup`, `confirm`, `useStep`, `consumeRecoveryCode`, `replaceRecoveryCodes`, `removeTotp`) and its `remainingRecoveryCodes()`, and those of `PasskeyStore` (`userHandle`, `create`, `updateCounter`, `suspend`, `release`, `rename`, `remove`): change factors through `TwoFactor` and `Passkeys`. The constructors of the auth events the framework dispatches — all but `SignedIn`, `Registered` and `TwoFactorChallengeFailed`. The `_auth_*` keys are no longer declared on `SessionData`; don't write them. `FACTOR_CHANGE_MAX_AGE` is no longer exported (it is 15 minutes, with no setting). `AuthConfig.protected` is gone, and reading it throws; ask `environment.isProtected()`. The constructor of `PolicyResponse`: use `allow()`, `deny()` and `denyAsNotFound()`.
- **`@marmeon/cache` and `@marmeon/redis`:** the constructors of `Lock` (use `cache.lock()`), `Limit` (use `Limit.perMinute()` …), `RedisConnections` and `RedisHealthCheck`; `Limit.maxAttempts` and `decaySeconds`; `RedisConnections.inUse()`.
- **`@marmeon/queue` and `@marmeon/scheduler`:** `Worker.process()`, `QueueConnections.verify()`, `cache()` and `events`, `JobRegistry.add()`; the constructors of the queue events (`JobQueued`, `JobProcessing`, `JobProcessed`, `JobReleased`, `JobFailed`); `QueueFake.listenerQueued()` (assert with `assertListenerQueued()`); the constructors of `ScheduleTester`, `ScheduledTaskFinished` and `ScheduledTaskSkipped`; `Scheduler.schedules()`, `due()`, `tick()` and `runNow()`; the constructor of `CronExpression`, and its `matches()`, `matchesHour()` and `hourRestricted`.
- **`@marmeon/mail`, `@marmeon/notifications`, `@marmeon/storage`:** the constructor of `MailFake` (use `app.mail`, and don't subclass it); `NotificationStore` is no longer exported (read notifications through `Inbox`); `StorageFake.defaultDisk`, `named()`, `options()`, `verify()` and `close()`; `TemporaryUpload.extension`. `UPLOAD_TYPES` is internal: `UploadMime` names the types an upload rule accepts.
- **`@marmeon/cli` and `@marmeon/devtools`:** the constructor of `Output`; `FileDevtoolsStore.directory` and `maxAgeMs`.
- **Types and registries only the framework used:** `RouteLookup` (from `@marmeon/router` and `@marmeon/http`), `TaskRun` and `WallTime` (from `@marmeon/scheduler`) and `UploadProblem` (from `@marmeon/storage`) are no longer exported; drop a type import of them. `HealthChecks.add()`, `all()` and `run()` and `ErrorSolutions.add()` and `find()` are internal: register checks with `static health` and solutions with `static solutions`, and read the checks through `/up/ready`. Also internal: `ErrorReports.flush()`, `QueueConnections.find()` and `failed()` (the `queue:failed*` commands read the failed jobs), `RedisConnections.verify()` and `close()`, `NotificationChannels.make()` (`add()` stays), `FileDevtoolsStore.maxBytes`, and `redact()` from `@marmeon/core`.


#### Low: Passkeys need the password, and EverySessionEnded takes the time last

*Likelihood of impact: low — apps that register or remove passkeys, or build `EverySessionEnded` in tests.*

- `passkeys.register(response, name, password)` and `passkeys.remove(id, password)` require the password as a string in their type, as they always did when they ran: without it the answer was `invalid-password`. An empty password gets that answer before anything is hashed.
- `new EverySessionEnded(at, counts)` is `new EverySessionEnded(counts, at)`, like the other auth events; `at` is optional, and a `Date` as the first argument throws a `TypeError`. Its constructor is internal now, like those of the other events the framework dispatches: a test reads the event the framework fired from `app.events` instead of building one.


### Commands and the scheduler

#### Low: The built-in command classes are no longer exported

*Likelihood of impact: low — apps that import a framework command class, usually in tests or a schedule.*

The command classes of auth, cache, database, devtools, notifications, queue, scheduler, session and storage are exported from no entry; a command's API is its name and flags. Run a command by its name instead:

```ts
// in a test
const run = await app.command('queue:retry', { args: ['all'] });
// in a schedule
s.command('queue:retry');
```

`run.code` is the exit code and `run.lines` every printed line, with `✓ ` before success and `✗ ` before error lines (docs/testing.md#running-commands).


#### Low: A refused command argument exits with 2

*Likelihood of impact: low — scripts and tests that check a command's exit code.*

A command that refuses an argument throws `CommandArgumentsError` and exits **2**, with the message on stderr, an empty stdout and no stack. A missing module, an existing file or a missing `--force` still exits 1.

- A script that tests for exit code 1 after a wrong argument gets 2 now. This covers the `make:*` generators, `start`/`dev`, `queue:work`, `schedule:work`, `queue:retry`, `queue:forget`, `queue:prune-failed`, `schedule:test`, `migrate` and the rollback commands, `publish`, `auth:end-all-sessions`, `auth:end-sessions`, `auth:reset-two-factor`, `auth:prune-tokens`, `make:auth --adapter`, `notifications:prune` and `uploads:prune` (docs/console.md).
- In tests, `app.command()` returns `code: 2` for them.
- An app's own command throws `CommandArgumentsError` (from `marmeon` or `@marmeon/core`) to exit with 2.
- An app that copied the kit's `end-sessions.test.ts` and `two-factor.test.ts` takes their current version: they expect 2.


#### Low: dev and start are reserved for the launcher

*Likelihood of impact: low — apps or packages with a command named `dev` or `start`.*

The launcher always answered `marmeon dev` and `marmeon start` itself, so such a command was unreachable. Registering one now stops the app with K8: rename it.


#### Low: The scheduler writes timeZone, and a task definition is read-only

*Likelihood of impact: low — apps that set the time zone of a task or a schedule.*

- `.timezone('Europe/Berlin')` becomes `.timeZone('Europe/Berlin')`, and `timezone` in `TaskDefinition` and `ScheduleConfig` becomes `timeZone`. `SCHEDULE_TIMEZONE` stays.
- `TaskDefinition` is read-only; code that mutated one no longer compiles.
- `.description()` is shown in `schedule:list` and must be one line of text; anything else is refused (Q5).


#### Low: The scheduler names the time a task was due dueAt

*Likelihood of impact: low — listeners on the scheduler's events or its `schedule.task` channel, and tests that read a task run.*

`event.minute` of `ScheduledTaskStarting`, `ScheduledTaskFinished`, `ScheduledTaskFailed` and `ScheduledTaskSkipped`, and `minute` of `TaskResult`, are `dueAt`: a point in time in epoch milliseconds, not a minute of the hour. The same holds for `ScheduleTaskMessage`, the report on the `schedule.task` channel. In the devtools, a schedule entry reads `content.dueAt` (`assertRecorded('schedule')`, the JSON API); entries written before the upgrade still show, without their due time.

A scheduler event built in a test takes `{ task, dueAt, reason, … }`; one without a numeric `dueAt` throws a `TypeError`.


#### Low: modules:check and schema:project are steps of marmeon build

*Likelihood of impact: low — scripts that call `marmeon modules:check` or `marmeon schema:project`.*

Both are hidden commands that `marmeon build` runs, and a hidden command is no longer API: it may change in any release. `serve`, which `marmeon start` and `marmeon dev` run, stays API. Run `marmeon build`.


### Formats

#### Low: schedule:list --json writes format 2

*Likelihood of impact: low — scripts that read `schedule:list --json`.*

`options.overlapMinutes` is `options.overlapSeconds` (30 minutes is 1800), and each task has a `description`, a string or `null`.


#### Low: The live stream carries its protocol version

*Likelihood of impact: low — apps with live updates notice it once, during the rollout.*

Nothing to change. The stream URL carries `v=1` and the messages between nodes carry `"v":1`; a stream request of another version gets a 204, and a message without the mark is ignored. A tab opened before the upgrade stops getting live updates until its next visit reloads it. During a rollout from 0.4, live hints between old and new nodes are lost; an end is bounded by `LIVE_MAX_STREAM_SECONDS`.

## Upgrading to 0.4.0 from 0.3.0

#### High: Upgrade with every process of the old release stopped

*Likelihood of impact: high — every app.*

0.4.0 cannot run next to 0.3: it renames the session and remember-me cookies, gives API tokens a new form, marks sessions, queued jobs and the page protocol with a format version, and reads no record of the old release. Upgrade in this order ([the upgrade that stops every process](docs/deployment.md#the-upgrade-that-stops-every-process)):

1. **Before, while 0.3 runs.** Let the queue run empty: `marmeon queue:work --stop-when-empty`, until `marmeon queue:size` shows nothing waiting or delayed (a job delayed into the future does not run empty). Retry or give up what `marmeon queue:failed` lists: failed jobs of 0.3 cannot be retried afterwards. Plan to issue every API token again, and tell your users that they sign in again.
2. **In development**, in this order:
   1. Move every framework package to 0.4.0 at once: `pnpm up --latest "@marmeon/*" marmeon`. Afterwards `package.json` names every `@marmeon/*` package and `marmeon` at exactly `0.4.0`; never upgrade one alone ([how to upgrade](docs/releases.md#how-to-upgrade)). On the first day after the release, pnpm holds the new versions back ([the first day after a release](docs/releases.md#the-first-day-after-a-release)).
   2. Rename the environment variables in the files of the repository (`.env`, `.env.test`, `.env.example`, the compose file, the CI configuration) and give Redis and Postgres the names they now require. `make:auth`, `migrate`, `db:types` and `route:types` start the app, and 0.4.0 stops at the start while an old name is set or `REDIS_PREFIX` or `DB_DATABASE` is missing (K6) ([environment variables](#high-environment-variables-are-named-after-what-they-configure-and-their-unit), [Redis](#high-an-app-with-marmeonredis-sets-app_name-or-redis_prefix), [Postgres](#high-an-app-on-postgres-sets-db_database-or-a-db_url-with-the-databases-name)). The environment of the servers and the platform follows in step 4.
   3. An app made with `make:auth`: remove the auth module from `bootstrap/app.ts`, run `marmeon make:auth --force` and delete the files of 0.3 it leaves ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-again)). Until then the app does not load.
   4. Rewrite the migrations before anything runs them ([a migration is a plan](#high-a-migration-is-a-plan-up-and-down-describe-the-change-instead-of-running-it)).
   5. An app made with `make:auth` on 0.3: add the migrations of its auth tables ([the kit's migrations](#high-apps-made-with-makeauth-on-03-write-the-migrations-of-their-auth-tables)).
   6. Run `marmeon agents:sync` and commit `AGENTS.md` and `CLAUDE.md`, which are new in this release: without them `marmeon check` reports `agents` as skipped ([coding agents](docs/agents.md)). Optionally, `marmeon make:lint-config --force` writes the lint preset anew with the rule that refuses imports of `@marmeon/*/internal`; it replaces your changes to `.oxlintrc.json`, so add them back, and pass `--boundaries` if you use it ([lint](docs/console.md#lint)). Also optionally, `securityHeaders()` from `@marmeon/http` replaces `middleware/SecurityHeaders.ts` in the `global` middleware of `bootstrap/app.ts`. If you turned on HSTS in that file, pass it on, as `securityHeaders({ hsts: { maxAge: 31_536_000, includeSubDomains: true } })`, or the header is no longer sent ([the other security headers](docs/csp.md#the-other-security-headers)).
   7. Run `marmeon migrate` on the development database, then `marmeon db:types` and `marmeon route:types`, and commit what they write: until then their `--check` fails with "generated by another version of Marmeon". If a command stops at the start, its message names what is missing; a queued listener of your own needs its name first ([queued listeners](#high-a-queued-listener-needs-a-stable-name-or-the-app-does-not-start)).
   8. Make the changes of the other entries below. The compiler, `marmeon check` and the tests point at most of them.
3. **Stop every process of 0.3** on every machine: web, workers, the scheduler, cron jobs and every CI or release job that runs `marmeon`. With the queue on Redis nothing makes a forgotten worker fail, so stop each one.
4. **Set the environment of the servers and the platform to the new names, with `REDIS_PREFIX` and `DB_DATABASE` where they apply (0.3 reads none of the new names, and 0.4.0 stops at the start on an old one), deploy, run `marmeon migrate --force`, then `marmeon auth:end-all-sessions --force --keep-reset-tokens` (apps with `@marmeon/auth`), then start the new release.** Until `migrate` has run, every query fails with D2 and `/up/ready` is red. The second command deletes the sign-ins with their remember-me tokens, revokes the API tokens that are left and rotates every session key, so nothing of 0.3 signs anyone in. After the kit's migrations it reports `0 sign-ins deleted` and `0 API tokens revoked`, because those migrations deleted both already; the session keys it rotates are what it is still run for.
5. **After the start**, issue the API tokens again and hand them out.

What is lost:

- Every session and every "keep me signed in" token. Users sign in again, with their second factor where they have one; a sign-in that waited for its second factor during the upgrade ends too.
- Every API token ([the API token entry](#high-api-tokens-have-a-new-form-and-every-token-is-issued-again)).
- What an open tab had typed and not sent: the tab gets a `409` on its next request and loads the page anew. If you cache HTML documents publicly with a `max-age`, a tab can get an old document once after that reload ([deployment](docs/deployment.md)).
- The jobs of 0.3 that had not run, queued listeners, mails and notifications included. Their records carry no version: a worker of 0.4.0 fails each at once (Q1), logs and reports it and keeps its payload readable in `queue:failed`, but none can be retried, so the mail or notification it would have sent is not sent ([deploying while jobs wait](docs/queues.md#deploying-while-jobs-wait)).

Everything else stays: users, passwords, second factors and recovery codes, passkeys, reset links (with `--keep-reset-tokens`), uploads, notifications and the cache, as long as the app keeps its Redis prefix and its database name ([Redis](#high-an-app-with-marmeonredis-sets-app_name-or-redis_prefix), [Postgres](#high-an-app-on-postgres-sets-db_database-or-a-db_url-with-the-databases-name)).

From this release on, a job a worker does not know waits up to six hours for a worker that knows it, instead of failing after its tries; a queue driver of your own honours the new `availableAt` option of `release()` ([queue drivers](docs/drivers.md#queue-drivers-and-failed-job-stores)). When you rotate `APP_KEY` later, keep the old key in `APP_PREVIOUS_KEYS`, or everyone is signed out again.

There is no way back: 0.3 reads neither the cookies, the sessions and the jobs nor the record of migrations that 0.4.0 writes.

#### High: Apps made with the starter kit take its auth module again

*Likelihood of impact: high — apps made with `make:auth`.*

The kit's controllers, commands, listeners, translations and tests changed with the entries of this release, and nothing updates them in an app. Once the packages are at 0.4.0 and the environment is renamed ([the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped), step 2), the app does not even load: the kit's module of 0.3 imports names that 0.4.0 no longer exports, such as `Lockout`, so `make:auth`, a command of `@marmeon/auth`, is not offered either (`marmeon list` shows only the built-in commands). On a clean working tree:

1. Remove the auth module from `bootstrap/app.ts`: the line `import auth from '#modules/auth';` and `auth` in `modules`.
2. Run `marmeon make:auth --force`. It writes the module again and adds it to `bootstrap/app.ts` again. It keeps every migration the app has and adds only the ones it lacks.
3. Delete the files of 0.3 that the kit no longer has. `make:auth` deletes nothing, and the type check fails on what they import:

   ```sh
   git -C modules/auth rm account-failures.ts account-failures.test.ts throttle.ts email-change.ts tasks/PruneEmailChanges.ts commands/EndSessionsCommand.ts commands/ResetTwoFactorCommand.ts passkeys.ts passkeys-browser.test.ts
   ```

4. Look at `git diff` and put your own changes back.

The files that go, in `modules/auth`:

- `account-failures.ts` and `account-failures.test.ts` (sign-ins are limited inside `Auth.attempt()` now);
- `throttle.ts` (password checks are limited by `@marmeon/auth`);
- `email-change.ts` and `tasks/PruneEmailChanges.ts` (a change of address is `EmailChange` now);
- `commands/EndSessionsCommand.ts` and `commands/ResetTwoFactorCommand.ts`: `auth:end-sessions` and `auth:reset-two-factor` come with `@marmeon/auth`, and two commands of one name stop every `marmeon` command with K8. A command you customized keeps working under another name. Tests import the classes from `@marmeon/auth`; pass the address as it is stored (lower case);
- `passkeys.ts` and `passkeys-browser.test.ts` (the browser side of passkeys is `@marmeon/auth/passkeys/browser`).

New in the module: `password-errors.ts`, `listeners/QueueLockoutMail.ts` (without it the owner of a locked account gets no mail), `listeners/NotifyAboutEmailChange.ts`, and the tests `login-limits.test.ts` and `route-limits.test.ts`. `AuthServiceProvider.ts` no longer binds `SignInStore` (the binding is harmless but redundant). Without `--force`, port the files from `packages/auth/stubs/react/modules/auth` of the installed version; the compiler points at most places.

There is no way back. See [the starter kit](docs/starter-kit.md).

#### High: A migration is a plan: `up` and `down` describe the change instead of running it

*Likelihood of impact: high — every app with migrations, the copies of the starter kit's included.*

`marmeon migrate` takes the steps a migration describes and runs them, and the app knows its schema from these plans, not from the database. In `modules/*/migrations`:

- `up: async (schema) =>` and `down: async (schema) =>` become `up: (schema) =>` and `down: (schema) =>`. Find them with `grep -rnE '(up|down): async \(schema\)' modules`.
- `await schema.create(`, `.alter(`, `.drop(`, `.dropIfExists(` and `.rename(` lose the `await`. Find them with `grep -rnE 'await schema\.(create|alter|drop|dropIfExists|rename)\(' modules`.
- Data written through `schema.db` moves into `schema.data(async (db) => { … })`.
- Raw DDL (`` sql`…`.execute(schema.db) ``) becomes `schema.raw(sql`…`)`. A branch on `schema.driver` becomes `schema.raw({ sqlite: …, pgsql: … })`, or reads `driver` in `schema.data(async (db, { driver }) => …)`. Marmeon records no owner, secret, soft-delete or timestamps mark for what raw SQL makes.
- `schema.hasTable()` and `schema.hasColumn()` are gone: a migration describes one change. Use `dropIfExists`, or SQL with `if exists` where a table may be missing.
- A plan is deterministic: no time, environment, file or database content may decide which steps `up` adds.
- A migration that changes a table created by raw SQL with `schema.alter()` or `schema.rename()` stops with D19, even when both ran already. Rewrite the raw `create table` in the old migration as `schema.create()` (this keeps `.secret()` and `softDeletes()`), or make the change in raw SQL too.
- On Postgres, an index whose default name is longer than 63 bytes stops with D5. For a migration that ran already, pass the name Postgres stored (`select indexname from pg_indexes where tablename = '…'`); in a new migration, a short name of your own, so that a later `dropIndex` finds it.

Rewrite the files before the first `marmeon migrate` of 0.4.0. That run adds a `checksum` column to `migrations` and records the checksum of every migration file as it is then; from then on `migrate` and `migrate:status` warn about a file that changed after it ran. Editing a migration that ran changes nothing in the database.

There is no way back. See [Migrations](docs/migrations.md) and [raw SQL](docs/migrations.md#raw-sql).

#### High: Apps made with `make:auth` on 0.3 write the migrations of their auth tables

*Likelihood of impact: high — apps made with `make:auth` on 0.3, and apps with a `sign_ins` table from `make:sign-ins-table`.*

The kit's tables changed: API tokens are found by a unique hash, a device's remember-me token lives on the row of its sign-in and `remember_tokens` goes, every account has a session key, and an open change of address has a table of its own, `email_changes`, instead of three columns of `users`. A migration the framework shipped never changes, so nothing writes these changes for an app made on 0.3. Until they have run, `/up/ready` is red and names what is missing.

1. Take the kit again first ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-again)). `make:auth --force` keeps every migration the app has and adds the one it lacks, `0001_01_01_000007_create_email_changes_table`. `migrate` runs it although migrations with later timestamps ran already: it creates a new table and changes none. An app that ports the kit by hand copies that file from the kit instead. Never write a second `email_changes` table: `migrate` then fails.
2. Add these migrations to `modules/auth/migrations`, named with the current timestamp so that they sort after every migration that ran, in this order. Each one ends what it touches: the upgrade ends every session anyway.

   ```ts
   // <timestamp>_reissue_personal_access_tokens.ts — every token is deleted: its form is gone and no code reads it.
   import { defineMigration } from '@marmeon/database';

   export default defineMigration({
     up: (schema) => {
       schema.data(async (db) => {
         await db.deleteFrom('personal_access_tokens').execute();
       });
       schema.alter('personal_access_tokens', (table) => table.unique('token_hash'));
     },
     down: (schema) => schema.alter('personal_access_tokens', (table) => table.dropUnique('personal_access_tokens_token_hash_unique')),
   });
   ```

   ```ts
   // <timestamp>_add_remember_columns_to_sign_ins.ts — the remember-me token moves onto the sign-in row; every sign-in ends.
   import { defineMigration } from '@marmeon/database';

   export default defineMigration({
     up: (schema) => {
       schema.data(async (db) => {
         await db.deleteFrom('sign_ins').execute();
       });
       schema.alter('sign_ins', (table) => {
         table.dropUnique('sign_ins_remember_selector_unique');
         table.dropColumn('remember_selector');
       });
       // A column cannot be marked secret later: the selector is made again.
       schema.alter('sign_ins', (table) => {
         table.string('remember_selector', 32).nullable().secret().unique();
         table.string('remember_validator_hash', 64).nullable().secret();
         table.string('remember_previous_validator_hash', 64).nullable().secret();
         table.timestamp('remember_rotated_at').nullable();
         table.timestamp('remember_created_at').nullable();
         table.string('remember_fingerprint', 64).nullable();
       });
     },
     down: (schema) => {
       schema.alter('sign_ins', (table) => {
         table.dropColumn('remember_validator_hash');
         table.dropColumn('remember_previous_validator_hash');
         table.dropColumn('remember_rotated_at');
         table.dropColumn('remember_created_at');
         table.dropColumn('remember_fingerprint');
         table.dropUnique('sign_ins_remember_selector_unique');
         table.dropColumn('remember_selector');
       });
       schema.alter('sign_ins', (table) => {
         table.string('remember_selector', 32).nullable().unique();
       });
     },
   });
   ```

   ```ts
   // <timestamp>_fill_empty_session_keys.ts — a random key for every account without one, from the database's own generator.
   import { defineMigration, sql } from '@marmeon/database';

   export default defineMigration({
     up: (schema) => {
       schema.data(async (db, { driver }) => {
         if (driver !== 'pgsql' && driver !== 'sqlite') throw new Error(`fill_empty_session_keys: no source of random bytes known for "${driver}"`);
         const key = driver === 'pgsql' ? sql`replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')` : sql`lower(hex(randomblob(32)))`;
         await db.updateTable('users').set({ session_key: key }).where('session_key', 'is', null).execute();
       });
     },
     down: () => {},
   });
   ```

   ```ts
   // <timestamp>_drop_remember_tokens_table.ts — the tokens are not copied; "keep me signed in" works again after the next sign-in.
   import { defineMigration } from '@marmeon/database';

   export default defineMigration({
     up: (schema) => schema.drop('remember_tokens'),
     down: (schema) =>
       schema.create('remember_tokens', (table) => {
         table.id();
         table.foreignId('user_id').constrained().cascadeOnDelete();
         table.string('selector', 32).unique();
         table.string('validator_hash', 64).secret();
         table.string('previous_validator_hash', 64).nullable().secret();
         table.timestamp('rotated_at').nullable();
         table.timestamp('last_used_at').nullable();
         table.timestamp('expires_at');
         table.string('account_fingerprint', 64).nullable();
         table.timestamps();
       }),
   });
   ```

   ```ts
   // <timestamp>_drop_pending_email_columns_from_users.ts — an open change of address is not carried over; its owner asks again.
   import { defineMigration } from '@marmeon/database';

   export default defineMigration({
     up: (schema) =>
       schema.alter('users', (table) => {
         table.dropColumn('pending_email');
         table.dropColumn('pending_email_token');
         table.dropColumn('pending_email_expires_at');
       }),
     down: (schema) =>
       schema.alter('users', (table) => {
         table.string('pending_email', 255).nullable();
         table.string('pending_email_token', 64).nullable().secret();
         table.timestamp('pending_email_expires_at').nullable();
       }),
   });
   ```

3. Once the environment variables are renamed ([environment variables](#high-environment-variables-are-named-after-what-they-configure-and-their-unit)), run `marmeon migrate` (in production as step 4 of [the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)), then `marmeon db:types`.

Code that read `users.pending_email*` reads nothing now: a change of address goes through `EmailChange` and `EmailChangeStore`. An app without the kit but with a `sign_ins` table from `make:sign-ins-table` needs the sign-in migration above and drops its own `remember_tokens` table; an app with a `UserProvider` and no `sign_ins` table runs `marmeon make:sign-ins-table` ([sign-ins](docs/authentication.md#sign-ins)). A `remember_tokens` table created under another migration name is not dropped for you. With a user table of your own, give every account without a session key a random one, as the third migration does.

There is no way back; the tokens and columns these migrations drop hold nothing that still works after the upgrade.

#### High: The app reads its schema from the migrations and refuses queries while one is pending

*Likelihood of impact: high — every app with a database.*

- An app that starts before `marmeon migrate` refuses every query with D2 (`MigrationStateError`) and readiness is red. It recovers within a second after `migrate`, without a restart. Scripts and `marmeon tinker` against a database that is not migrated set `DB_MANAGED=false`.
- `table_owners`, `secret_columns` and `schema_markers` of 0.3 stay in the database, and `migrate` names them. Drop them by hand once no process of 0.3 runs, on every connection that has them. The record of migrations of 0.3 is read as it is.
- Tables and columns made with `schema.raw()` or by another tool are not in `Tables` and `Relations` and have no relations, kinds or marks: `with()` on them stops working and code that used their types fails to compile. Create them with `schema.create()`, or type them for reading with `db.withTables<{ … }>()`.
- `selectAll()` and `returningAll()` name the columns the migrations know: a column that raw SQL or another tool added no longer comes back, so name it in the query. A whole-row value of a migration table (`to_jsonb(t)`, `eb.table('t')`) fails with D9. The compiled SQL lists the columns instead of `select *`; update query snapshots.
- Raw SQL in a migration that renames or drops a table or column the migrations know rolls the migration back (D3): use `schema.alter()` or `schema.rename()`. A new migration with an older timestamp that changes a table a migration already run has changed is refused until it is renamed.
- Dropping or renaming a column breaks every `selectAll()`, `returningAll()` and relation of that table in processes of the release before. Drop or rename a column only in the release after the one that stops using it; `retire()` takes it out of use first.
- Own tables without a record of migrations are kept: `migrate` creates `migrations` and names the tables it did not make. A database another tool manages (with a `migrations` table of its own, say) gets `managed: false` or `DB_MANAGED=false`.
- `Migrator.onOneConnection()`, `owners()`, `secrets()` and `markers()` are removed: use `migrator.projection()`. A `switch` over `MigrationStateError.reason` handles the new `'unmanaged'`.
- Tests that build tables with raw DDL on a managed connection use migrations instead.

There is no way back. See [how the app knows its schema](docs/migrations.md#how-the-app-knows-its-schema).

#### High: Environment variables are named after what they configure and their unit

*Likelihood of impact: high — every app that sets one of the old names in a `.env` file, its deployment, a compose file or CI.*

Rename these variables in `.env`, `.env.test` and `.env.example`, and wherever else the environment is set: compose files, CI, and the server or platform (in step 4 of [the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)). The values stay the same; nothing is converted. The `.env.test` of an app made on 0.3 sets `MAIL_MAILER=array`: until it says `MAIL_DRIVER=array`, every test stops with K6. An old name that is set stops the start in every environment, even next to the new one, names its replacement and is never read; `marmeon check` reports it too.

| Old | New |
| --- | --- |
| `DB_CONNECTION` | `DB_DRIVER` |
| `QUEUE_CONNECTION` | `QUEUE_DRIVER` |
| `DB_QUEUE_CONNECTION` | `QUEUE_DATABASE_CONNECTION` |
| `DB_QUEUE` | `QUEUE_DATABASE_QUEUE` |
| `DB_QUEUE_RETRY_AFTER` | `QUEUE_DATABASE_RETRY_AFTER_SECONDS` |
| `REDIS_QUEUE_CONNECTION` | `QUEUE_REDIS_CONNECTION` |
| `REDIS_QUEUE` | `QUEUE_REDIS_QUEUE` |
| `REDIS_QUEUE_RETRY_AFTER` | `QUEUE_REDIS_RETRY_AFTER_SECONDS` |
| `MAIL_MAILER` | `MAIL_DRIVER` |
| `AUTH_PASSWORD_TIMEOUT` | `AUTH_PASSWORD_TIMEOUT_SECONDS` |
| `AUTH_RESET_EXPIRE` | `AUTH_RESET_MINUTES` |
| `AUTH_RESET_THROTTLE` | `AUTH_RESET_THROTTLE_SECONDS` |
| `AUTH_EMAIL_CHANGE_THROTTLE` | `AUTH_EMAIL_CHANGE_THROTTLE_SECONDS` |
| `SESSION_LIFETIME` | `SESSION_LIFETIME_MINUTES` |
| `UPLOADS_LIFETIME` | `UPLOADS_LIFETIME_MINUTES` |
| `UPLOADS_SEND_WITHIN` | `UPLOADS_SEND_WITHIN_MINUTES` |
| `LIVE_REDIS_CONNECTION` | `LIVE_CONNECTION` |
| `LIVE_HEARTBEAT` | `LIVE_HEARTBEAT_SECONDS` |
| `LIVE_RETRY` | `LIVE_RETRY_MILLISECONDS` |
| `MAX_BODY_SIZE` | `SERVER_MAX_BODY_SIZE` |
| `HEALTH_PATH` | `SERVER_HEALTH_PATH` |
| `ASSET_VERSION` | `SERVER_ASSET_VERSION` |
| `SHUTDOWN_DELAY` | `SERVER_SHUTDOWN_DELAY_SECONDS` |
| `KEEP_ALIVE_TIMEOUT` | `SERVER_KEEP_ALIVE_TIMEOUT_SECONDS` |
| `TRUSTED_PROXIES` | `SERVER_TRUSTED_PROXIES` |
| `SSR_ENABLED` | `SERVER_SSR_ENABLED` |
| `OTEL_TRUST_TRACEPARENT` | `MARMEON_OTEL_TRUST_TRACEPARENT` |
| `OTEL_RECORD_QUERY_VALUES` | `MARMEON_OTEL_RECORD_QUERY_VALUES` |

`PORT`, `HOST` and the names of the OpenTelemetry specification (`OTEL_SDK_DISABLED` …) keep theirs. An app with files from `marmeon make:docker` runs it again with `--force`, or renames `HEALTH_PATH` in its `Dockerfile`, `SHUTDOWN_DELAY` and `TRUSTED_PROXIES` in its compose file, and `TRUSTED_PROXIES` in the systemd units of `--systemd`. A test that pins `DB_CONNECTION` pins `DB_DRIVER`.

These variables are read as switches now: `MAIL_SECURE`, `MAIL_REQUIRE_TLS`, `AUTH_PRIVATE_REGISTRATION`, `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE`, `SESSION_ENCRYPT`, `SESSION_SECURE_COOKIE`, `SERVER_SSR_ENABLED`, `MARMEON_OTEL_TRUST_TRACEPARENT`, `MARMEON_OTEL_RECORD_QUERY_VALUES` and `DEVTOOLS_ENABLED`. They take `true`, `false`, `1` and `0` in any letter case; any other text (`yes`, `off`) stops the start, and empty keeps the default (`SESSION_SECURE_COOKIE` then follows `APP_URL`). `DEVTOOLS_ENABLED=1` counts as on, so it also stops a production start. `OTEL_SDK_DISABLED` follows the OpenTelemetry specification: only `true` disables, any other value, `1` included, leaves spans on.

There is no way back; the old names are never read. See [renamed variables](docs/configuration.md#renamed-variables) and [every variable](docs/configuration.md#every-variable).

#### High: An app with `@marmeon/redis` sets `APP_NAME` or `REDIS_PREFIX`

*Likelihood of impact: low — apps with `@marmeon/redis` installed whose environment sets neither variable. Apps made by `create-marmeon` require `APP_NAME` already.*

The prefix of every Redis key and channel comes from `REDIS_PREFIX`, or from `APP_NAME` as a slug, and no longer falls back to `marmeon:`: two apps on one Redis without either shared their sessions, cache, rate limits, locks and queues. An app with `@marmeon/redis` installed, whichever drivers it uses, now stops at start:

```text
[marmeon:K6] Invalid configuration — the application cannot start:
  • redis: REDIS_PREFIX — set REDIS_PREFIX, or APP_NAME (with a letter or digit) — apps on one Redis share their keys otherwise (docs/redis.md#configuration)
```

Set one of them in `.env` and wherever the environment is set (CI, and the server or platform in step 4 of [the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)):

- `APP_NAME="My App"` gives the prefix `my-app:`.
- `REDIS_PREFIX=notes-app:` is used as written; end it with the colon yourself. An empty `REDIS_PREFIX=` and an `APP_NAME` without a letter or digit count as not set.
- An app whose keys live under `marmeon:` because it relied on the old default sets `REDIS_PREFIX=marmeon:` to keep them. Otherwise its cache starts empty, and jobs still waiting under `marmeon:` are not found, not even as failed ones.
- Staging and production on one Redis give each its own `REDIS_PREFIX`.

A named connection from `defineRedisConnection()` keeps the prefix it gives in `resolve`. There is no way back to a default prefix. See [Redis](docs/redis.md#configuration).

#### High: An app on Postgres sets `DB_DATABASE` or a `DB_URL` with the database's name

*Likelihood of impact: low — apps with `DB_DRIVER=pgsql` that set neither `DB_DATABASE` nor a `DB_URL` with a path, and so used the database `marmeon`.*

Postgres no longer falls back to the database `marmeon`: two apps on one server without a name of their own shared every table, from users and sessions to the cache and the jobs. Such an app now stops at start:

```text
[marmeon:K6] Invalid configuration — the application cannot start:
  • database: DB_DATABASE — set DB_DATABASE, or DB_URL with the database's name in its path — apps on one Postgres server share their tables otherwise (docs/database.md#configuration)
```

Set one of them in `.env` and wherever the environment is set (CI, and the server or platform in step 4 of [the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)): `DB_DATABASE=notes`, or `DB_URL=postgres://user:secret@host:5432/notes`; the URL wins. `DB_DRIVER` is the `DB_CONNECTION` of 0.3 ([renamed variables](#high-environment-variables-are-named-after-what-they-configure-and-their-unit)).

- An app whose tables are in the database `marmeon` sets `DB_DATABASE=marmeon`, or `/marmeon` in `DB_URL`. Any other name is another, empty database.
- An empty `DB_DATABASE=` counts as not set, and so does a `DB_URL` without a path (`postgres://app@db:5432`, `postgres://app@db/`): `pg` would then read `PGDATABASE` or take the user name.
- Staging and production on one server each need their own database name.
- A named connection from `defineConnection()` whose `url` has no path gives it one, or sets `database`; otherwise it throws a `TypeError`.

SQLite keeps its default file. There is no way back to a default name. See [database configuration](docs/database.md#configuration).

#### High: API tokens have a new form, and every token is issued again

*Likelihood of impact: medium — apps that issue API tokens.*

A token no longer carries its row id: it looks like `marmeon_…`, without the `|`, and is found by the unique hash of its secret. Every token issued before stops working, and the upgrade deletes them ([the kit's migration](#high-apps-made-with-makeauth-on-03-write-the-migrations-of-their-auth-tables), `auth:end-all-sessions`). Each app issues its tokens again and hands them to every integration, script and client that used one: plan this before you deploy.

- `AUTH_TOKEN_PREFIX` is empty, or at most 16 lower-case letters, digits and `_`, ending in `_` (default `marmeon_`). Any other value stops the start, so change it before you deploy.
- `AccessToken.id` is `number | string`. Code that cut the id out of a token reads it from `AccessTokenStore.list()` instead.
- A token table of your own: delete the old rows and add `unique('token_hash')` in a migration. With UUID keys, adapt the revoke controller.

There is no way back. See [the token format](docs/api-tokens.md#the-token-format).

#### High: A queued listener needs a stable name, or the app does not start

*Likelihood of impact: medium — apps with queued listeners: a class with `static queue` passed to `listen(Event, Class)`.*

A worker finds a queued listener by a name that a rename or a minifier cannot change. Add one to each:

```ts
export class SendWelcomeMail {
  static readonly listener = 'accounts.send-welcome-mail';
  static queue = { tries: 3 };
  // …
}
```

Use lower-case words with a `.` after the module, and never change the string later. The app does not start until every queued listener has one. Notifications and mails with `static queue` need none. Queued listener jobs of 0.3 do not run ([the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)).

There is no way back. See [queued listeners](docs/events.md#queued-listeners).

#### High: An `ExceptionHandler` with a `report()` method no longer reports

*Likelihood of impact: medium — apps that extended `DefaultExceptionHandler` and overrode `report()`, for example to send errors to a tracker, or bound an `ExceptionHandler` of their own with a `report()` method.*

Errors go to the error reporters that providers bring, and the framework no longer calls `report()` on the handler. TypeScript does not flag the extra method, so such an app **stops reporting without a type error**; the kernel logs one warning at the first server error ("The ExceptionHandler has a report() method, which is not called any more").

- Move the code into an `ErrorReporter` (`report(report: ErrorReport)`), list it in a provider's `static errorReporters`, and remove `report()` from the handler.
- `DefaultExceptionHandler` has no constructor parameters: a subclass that calls `super(logger, redactor)` drops the arguments.
- An error you catch yourself while the request still answers 200 is reported with `app.container.make(ErrorReports).report(error, { source: 'request' })`.
- A reporter whose constructor throws stops the start with K12; a wrong DSN no longer switches reporting off without a sound.

The log line of an error is unchanged. There is no way back. See [reporting](docs/errors.md#reporting).

#### High: A `UserProvider` writes the session key with the password and compares both

*Likelihood of impact: high — every app with `@marmeon/auth`: apps made with `make:auth` take the kit's `UserRepository.ts`, a provider of your own implements the methods below.*

A session is bound to the account's id and session key, no longer to its password hash. A rehash after higher `HASH_*` costs keeps every sign-in, and code that writes `password` itself ends no session any more: write a new key with it, or call `AccountSessions.end()`. To end everything, run `marmeon auth:end-all-sessions`.

- **Apps made with `make:auth`:** take `UserRepository.ts` from the kit and replace the tests `auth.test.ts`, `two-factor.test.ts` and `passkeys.test.ts` ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-again)). Your own calls `updatePasswordHash(id, hash, expected)` become `updatePasswordHash(id, hash, { expected })`. Tests that write `password` directly also write a `session_key`; a test double that overrides `findById` returns `sessionKey`.
- **A provider of your own:**
  - `updatePasswordHash(id, hash, { expected?, sessionKey?, expectedSessionKey? })` returns a boolean. With `sessionKey` it writes hash and key in one statement, and only where the stored key equals `expectedSessionKey` (`IS NULL` for `null`); otherwise it returns `false`.
  - `updateSessionKey(id, key, expected)` is a compare-and-set in one statement (`IS NULL` for `null`); called with the stored key as both `key` and `expected`, it returns `true`.
  - `updateEverySessionKey(key)` is one `UPDATE` without `WHERE` and returns `{ accounts, sampleId }`; `sampleId` is required when `accounts > 0`. `auth:end-all-sessions` needs it.
  - `findById()` and `findForSignIn()` (before: `findForLogin()`, [renamed](#medium-auth-events-methods-and-types-are-named-after-signing-in)) return `sessionKey` (`null` when the account has none) from a `session_key` column (64 characters, `.secret()`), read after the write, not from a cache; otherwise `updatePassword()` and a reset fail with A5. `findForSignIn()` compares the normalized identifier exactly.
  - New accounts get a random key (32 bytes, base64url); `NULL` stays allowed.
  - The framework checks only the shape of the answers: test the compare-and-set yourself.
- **JavaScript providers with the positional `expected`** now receive an object: on SQLite the binding throws, on Postgres the comparison never matches, so a sign-in that needs a rehash is refused as a wrong password.
- **Every app with a `UserProvider`** installs `@marmeon/cache` and registers its provider, or the boot stops with A7: sign-ins and password checks are limited through it. Test harnesses with `discover: false` add `CacheServiceProvider` (with `CACHE_DRIVER=memory`, say).

There is no way back. See [for your own user provider](docs/authentication.md#for-your-own-user-provider).

#### Medium: Auth events, methods and types are named after signing in

*Likelihood of impact: high — every app with `@marmeon/auth`: the kit's `UserRepository.ts`, every provider of your own, and code that uses the auth API.*

Rename what the compiler points at:

| Before | After |
| --- | --- |
| `Login` (event) | `SignedIn` |
| `Logout` (event) | `SignedOut` |
| `Failed` (event) | `SignInFailed` |
| `Lockout` (event) | `SignInLockedOut` |
| event name `auth.login` | `auth.signed-in` |
| `LoginPayload` | `SignedInPayload` |
| `LoginInput` | `SignedInInput` |
| `LoginVia` | `SignInVia` |
| `via: 'login'` (event field, `Auth.signIn()`) | `via: 'app'` |
| `auth.login(user)` | `auth.signIn(user)` |
| `auth.logout()` | `auth.signOut()` |
| `LoginOptions` | `SignInOptions` |
| `LoginThrottle` | `SignInThrottle` |
| `findForLogin()` (`UserProvider`) | `findForSignIn()` |

`findForSignIn()` keeps the signature and the contract of `findForLogin()`. Rename it in the kit's `UserRepository.ts` ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-again)), in every provider of your own, and in seeders and tests that call it. In JavaScript or behind a cast, a provider with only the old name stops the boot with A5, which names `findForSignIn()`; nobody is signed in and no account is reported as unknown.

The kit's `LoginController`, `ShowLoginController`, `LogoutController` and the view `Login.tsx` keep their names, and so do the routes `auth.login` and `auth.logout`. A queued listener job stored under the event name `auth.login` is never delivered to a listener of `auth.signed-in`; the jobs of 0.3 fail at once after the upgrade in any case, so let the queue run empty before ([the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)).

There is no way back. See [Authentication](docs/authentication.md) and [for your own user provider](docs/authentication.md#for-your-own-user-provider).

#### Medium: Password checks and sign-in limits are part of `Auth`

*Likelihood of impact: medium — apps with their own sign-in, password, two-factor or passkey controllers.*

`Auth.attempt()` limits password sign-ins per client and per account and dispatches `SignInLockedOut` itself, and every password check of a signed-in user runs under its throttle.

- Replace `auth.confirmPassword(p)` with `(await auth.checkPassword(p)).ok`, and show `throttled` to the user.
- Replace `logoutOtherDevices(p)` with `checkPassword(p)` followed by `updateSessionKey()`.
- Test `TwoFactor.disable()` through `.ok`, never its truthiness.
- Remove your own counting around sign-ins, `checkPassword()`, `disable()` and the passkey methods, and your own lockout dispatches; otherwise each counts twice. Tests that read the cache key `limiter:login:<email>|<ip>` stop doing so.
- Handle `throttled` from `attempt()`: `retryAfter`, and `account: true` when waiting does not help.
- `new SignInLockedOut(identifier, ip, scope)` takes the scope; a listener that blocks an IP acts only on `'client'`.
- Set the device cookie after a successful sign-in (`auth.deviceCookie()`) and after a reset (`broker.deviceCookie(user)`).
- Code that builds `Auth` or `PasswordBroker` by hand passes a `RateLimiter` and a `SignInThrottle` as the last arguments; resolve them from the container instead.

The new environment variables of the limits are optional. There is no way back. See [limits on password sign-ins](docs/authentication.md#limits-on-password-sign-ins).

#### Medium: The auth stores and the session store are abstract classes

*Likelihood of impact: low — apps with their own reset-token, API-token, two-factor, sign-in, remember-me or session store, their own hasher, or test doubles of these.*

- Write `extends PasswordResetTokenStore`, `AccessTokenStore`, `TwoFactorState`, `SignInStore` or `SessionStore` instead of `implements`, call `super()`, and implement every member, `forgetEveryone()` and `revokeEveryone()` included. Test doubles written as object literals (`container.instance(SessionStore, { … })`) become subclasses. User id parameters are `AuthUserId`: convert a string route parameter for a numeric id.
- `RememberTokenStore` is gone: a remember-me token lives on the row of its sign-in. Move its methods into one class that `extends SignInStore`: `issueToken` instead of `create`, `consume` (it returns `signIn` now), `remembered` instead of `exists`, `forgetToken` instead of `forget`, `rebind`, `dropToken`, and `endAll` / `endEveryone` instead of `forgetUser` / `forgetEveryone`. `prune(window, days)` takes the days. Keep the guarantees their JSDoc names: user-scoped writes, an atomic revocation on theft, `commitAnyway` on expiry and theft, read-after-write for `remembered`.
- A session store: `class YourStore extends SessionStore`, with `override` before `destroyUser` under `noImplicitOverride`. Extend `SessionStore` itself, never a built-in store.
- A source passed to `combineFactors()` needs `factors`, `enabledSince` and `removeAll`. A store for changes of address adds `waiting()`.
- A hasher of your own adds `failureFloorMs()`, returning milliseconds of 0 or more; `0` gives up the padding of failed sign-ins.
- In JavaScript or behind a cast, a missing member or an invalid `failureFloorMs()` answer fails with A6.
- Listeners of `EveryoneEnded` and `EverySessionEnded` stop reading `rememberTokens`.
- Code that constructs `AccountSessions`, `NewPassword`, `PruneTokensCommand`, `PasswordBroker`, `TwoFactor` or `Passkeys` itself: their constructor parameters changed (`TwoFactor` and `Passkeys` take `SessionConfig` last); resolve them from the container.
- Removing a passkey through the package API instead of the kit's controller: call `updateSessionKey()` afterwards, as the controller does, so that the sessions of a cloned passkey end.

There is no way back. See [your own stores](docs/authentication.md#your-own-stores).

#### Medium: The session and remember-me cookies are named `__Host-…` over https

*Likelihood of impact: medium — apps that set `SESSION_COOKIE` or `AUTH_REMEMBER_COOKIE`, run behind a TLS proxy, or name these cookies in tests.*

With `Secure` cookies the two cookies carry the `__Host-` prefix and no `Domain`. The cookies of 0.3 are never read ([the stopped upgrade](#high-upgrade-with-every-process-of-the-old-release-stopped)).

- `AUTH_REMEMBER_COOKIE` defaults to `marmeon_remember` (before: `remember_web`). An app that sets it checks the name.
- If `SESSION_COOKIE` or `AUTH_REMEMBER_COOKIE` starts with `__Host-` or `__Secure-`, remove the prefix: the framework adds it, and the app does not start otherwise.
- Behind a TLS proxy, serve with `APP_URL=https://…`.
- Tests that read or set these cookies by name take the names from `cookieNames(app)` (`@marmeon/auth/testing`) or `sessionCookieName()` / `rememberCookieName()`: with an https `APP_URL` the literal names no longer match.
- `ctx.cookies` no longer shows cookies whose names are not RFC 6265 tokens (`a[b]`, `x:y`).

There is no way back. See [the `__Host-` prefix](docs/session.md#the-__host--prefix).

#### Medium: Pages and visits give `PageInfo`, not the page object

*Likelihood of impact: medium — apps that read protocol fields of `usePage()`, of what `router.visit()` and `router.reload()` resolve to, or of visit callbacks.*

`usePage()`, `router.visit()`, `router.reload()`, `router.on('success')`, `onSuccess` and `VisitException.page` give `PageInfo`: `props`, `url`, `component`, `route`, `locale`, `query` and `flash`, read-only. For the fields that are gone:

| Before | After |
| --- | --- |
| `.version` | `useNewVersion()` or `router.on('version')` |
| `.deferredProps` | `<Deferred>` or `<WhenVisible>` |
| `.layers` | `useLayer()` |
| `.csrf` | `xsrfToken()` from `@marmeon/http/client` (same-origin requests pass by Fetch Metadata anyway) |
| `.epoch` | `tabSync` |

`@marmeon/react` exports only the app's API now:

- Remove imports of `Backdrop` and `ErrorPage`: the built-in error page and layer backdrop still apply; to replace them, add `modules/errors/views/Error.tsx` or `modules/layers/views/Backdrop.tsx`.
- `SHORT_PENDING_DELAY` becomes `usePending(name, { delay: 'short' })`, `pagesAround` becomes `<Pagination>`; `layoutsOf` has no replacement.
- `pageQuery` is no longer in `@marmeon/http/client`: use `useQueryState()`, which also fills in the defaults.
- `MarmeonApp` and `MarmeonAppProps` are no longer exported: the app's entry is `createMarmeonApp()`.

There is no way back. See [Pages](docs/pages.md).

#### Medium: A controller passes the status and headers of a result as options

*Likelihood of impact: high — apps that answer with another status than 200 from a controller.*

```ts
this.view('notes/Edit', props, 422);  // before
this.view('notes/Edit', props, { status: 422 });

this.json(data, 201);  // before
this.json(data, { status: 201 });

this.redirect(url, 301);  // before
this.redirect(url).status(301);
```

The same goes for the standalone `view()` and `json()` of `@marmeon/http`, whose headers move from a further argument into `{ headers }`, and for `new RedirectResult(url, status)`, which becomes `new RedirectResult(url).status(status)`. The compiler points at each call; a number that slips through at run time throws a `TypeError` that names `{ status: 422 }`.

There is no way back. See [Responses](docs/responses.md).

#### Medium: A middleware adds to the request context and never replaces a key

*Likelihood of impact: medium — apps with middleware of their own, or code that assigns to `ctx`.*

- `next()` refuses every key the context has already and the names every object has (`then`, `toJSON`, `constructor`). A reserved key (`request`, `params`, `route`, `query`, `input`, `inputRead`, `cookies`, `ip`, `nonce`, `expectsJson`, `body`, `pageQuery`) in what a middleware declares does not compile; any key given to `next()` that is reserved or present fails when the request runs with a `TypeError` (H8) and a 500. Give the value a key of its own (`next({ activeTeam })`). A middleware may not replace a key an earlier one set (`user` after `authenticate()`). Adding a new key works as before.
- The context is frozen one level deep, and so are `ctx.params` and `ctx.route`: `ctx.team = …`, `Object.assign(ctx, …)` and assignments to `ctx.params` throw a `TypeError`; use `next({ … })`. Values inside the other keys (the `user` object, `ctx.query`, `ctx.request.headers`) stay changeable.
- A loaded route is frozen: `route.name()`, `route.internal()`, `route.block()`, `route.middleware.push(…)` or `route.reserved = …` after `Router.load` throw a `TypeError`. Set these inside `defineRoutes()`.
- Two middleware that declare the same key in `static adds` stop the start with H8, naming the route, the key and both, for instance `authenticate()` on a group and again on a route: remove one. `marmeon check` reports it.
- A middleware that adds keys declares them: `static adds = ['team'] as const` in a class, `defineMiddleware(name, handle, { adds: ['team'] })` for an object. Without it, only the run-time check applies.

There is no way back. See [adding to the context](docs/middleware.md#adding-to-the-context).

#### Medium: `useForm` takes the route parameters as an option

*Likelihood of impact: high — apps with forms whose route has parameters, and every app made with `make:auth`.*

```ts
useForm('notes.update', { note: id }, initial, options);  // before
useForm('notes.update', initial, { params: { note: id }, ...options });

useForm('notes.store', {}, initial);  // before
useForm('notes.store', initial);
```

The compiler points at each call; where it cannot see one (untyped code), the old forms throw a `TypeError` when the component renders. Apps made with `make:auth` take the kit's views ([the kit](#high-apps-made-with-the-starter-kit-take-its-auth-module-again)) or edit them as the compiler shows.

There is no way back. See [Forms](docs/forms.md).

#### Medium: The database's types have names of their own, and a module's database runs queries only

*Likelihood of impact: medium — apps that name query-builder types or run DDL or raw SQL through a module's `Database`.*

- `Kysely<DB>` becomes `Connection<DB>`, `SelectQueryBuilder` becomes `SelectQuery`; `Selectable<Tables['t']>`, `Insertable<…>` and `Updateable<…>` become `Row<'t'>`, `NewRow<'t'>` and `RowUpdate<'t'>` (for a table type not in `Tables`: `RowOf<T>`, `NewRowOf<T>`, `RowUpdateOf<T>`). All come from `@marmeon/database` and are the same types; `Transaction<DB>` and `sql` keep their names.
- `queue.using(x)` takes only a transaction (`trx` from `connections.transaction()`): `queue.using(db)` does not compile. Pass the transaction, or dispatch without `using()`.
- `Database<'module'>` offers `selectFrom`, `selectNoFrom`, `fn`, `case`, `dynamic` and `isTransaction`, plus `insertInto`, `updateTable`, `deleteFrom` and `transaction()` for the module's own tables. `schema`, `executeQuery`, `getExecutor`, `destroy`, `introspection`, `$extendTables`, `$omitTables` and `$pickTables` are gone: code that runs `` sql`…`.execute(db) `` with a module's database, changes the schema or closes the connection injects the unscoped `Database`, or moves into a migration. `Database` without a module name is unchanged.
- A statement kind the secret guard does not know is refused at run time, and so is a function name that is not an identifier, in `fn.agg` and quoted (`fn('"MyFunc"')`) too: write a plain or schema-qualified name (`pg_catalog.lower`), or use `` sql`…` ``.

There is no way back. See [table types](docs/queries.md#table-types) and [module boundaries](docs/queries.md#module-boundaries).

#### Medium: The migrations of a module come only from the app or its workspace

*Likelihood of impact: low — apps with a module that reads its `migrations` from a package in `node_modules`, a link to another repository, or a place outside the app.*

A module whose migrations lie in `node_modules` or outside the app and its workspace stops the start with D20: Bun with a symlink backend, Deno's npm cache, a `link:` to another repository, a volume outside the app root, a link to `node_modules` or outside in a subfolder of `migrations`, a real `node_modules` inside it, and a workspace root that everyone can write or another user owns. Monorepos with `pnpm-workspace.yaml` or `workspaces` and the lockfile in their root are not affected.

Move the files, with the same names, into a module of your app and point `migrations` at them; new timestamps would make new migrations that create the tables a second time. If the app's module has another name, run `UPDATE migrations SET module = '<your module>' WHERE module = '<package module>'` once. A package brings its migrations through `marmeon publish`.

There is no way back. See [migrations from a package](docs/migrations.md#migrations-from-a-package).

#### Medium: The page client's adapter API moves to `@marmeon/http/client/adapter`

*Likelihood of impact: low — apps that drive the client core, write client features of their own or import page-protocol names.*

- `useFeature()` and `navigator.use()` take only a stable `FeatureHandle`; `@marmeon/http/client` offers two, `hooks` and `tabSync`. Every other handle (`actions`, `islands`, `layers`, `live`, `liveValidation`, `prefetch`, `optimistic`, `remember`, `guard`, `instant`, `revalidateOnBack`, `queryState`, `selection`, `uploads`, `viewTransitions`, `devtools`), its API type, `Navigator`, `defineFeature` and the other building blocks of the client core come from `@marmeon/http/client/adapter`, which may change in any minor release. A handle that `defineFeature()` did not make throws a `TypeError`, and a feature it made is frozen.
- `VisitOptions.ignoreGuards` takes `IgnoredGuard` (`message`, `active()`); a custom `ProgressIndicator` receives a `ProgressSource` instead of the navigator.
- `pageInfo`, `pageName`, `scriptJson`, `ERROR_PAGE`, `LAYER_BACKDROP` and `matchesPath` move from `@marmeon/http/page` to `@marmeon/http/client/adapter`.
- The page protocol has its own entry: the `*_HEADER` constants, `PAGE_SCRIPT_ID`, `MAX_LAYER_DEPTH`, the types `PageObject`, `RegionObject`, `OnceInfo`, `LayerInfo`, `LiveHint`, `LiveSubscription`, `RegionKind`, `RegionOutcomeStatus` and `LayerClose`, and `isPageObject`, `isPrefetch`, `isActionRequest` and `regionOf` come from `@marmeon/http/protocol`, no longer from `@marmeon/http` or `@marmeon/http/page`. Augmentations of `@marmeon/http/page` (`Views`, `SharedProps`, `FlashData`) stay.
- No longer exported, without replacement: the `DEFAULT_*` constants, `SCROLL_REGION_ATTRIBUTE` (write the `scroll-region` attribute), `matchesRouteName`, `confirmRequest` and `nativeConfirm`, `isSensitiveField` and `SENSITIVE_FIELD` (use `isSensitiveRememberField`), and from the client entries of devtools and table `DevtoolsBar`, `installDevtoolsHook` and `parseSort`, `sortValue`, `propOf` (for a column's sort value write `-name` or `name`).

There is no way back. See [writing a UI adapter](docs/package-development.md#writing-a-ui-adapter).

#### Low: The page protocol has a version

*Likelihood of impact: low — apps with a client of their own that sends `x-marmeon` headers, and tests that set them by hand.*

A request of another protocol version gets a `409` before any controller runs, and the tab loads the page anew. A client of your own sends `x-marmeon: 1`. In tests, replace a hand-set `x-marmeon: 'true'` with the helpers of the test app (`navigating()`, `acting()`, `island()` …) or with `PROTOCOL_VERSION` from `@marmeon/http/protocol`.

There is no way back. See [a tab of another protocol version](docs/navigation.md#a-tab-of-another-protocol-version).

#### Low: Test doubles come from `/testing`, and the internals of the packages are no longer exported

*Likelihood of impact: medium — app tests that import fakes, and code that imported names the docs do not describe.*

| Name | Import from |
| --- | --- |
| `TestClock`, `EventFake` | `@marmeon/core/testing` |
| `QueueFake` | `@marmeon/queue/testing` |
| `StorageFake`, `ExpectedContents` | `@marmeon/storage/testing` |
| `ScheduleTester` | `@marmeon/scheduler/testing` |
| `MailFake` | `@marmeon/mail/testing` |
| `NotificationFake` | `@marmeon/notifications/testing` |
| `twoFactorCode`, `authenticatedSession` | `@marmeon/auth/testing` |
| `DevtoolsTester` | `@marmeon/devtools/testing` |
| `BroadcastRecorder`, `LiveStreamReader`, `RecordedRefresh`, `LiveEvent` | `@marmeon/live/testing` |

Tests that go through `createTestApp()` (`app.mail`, `app.notifications`, `app.queue` …) change nothing. Further:

- `createHttpKernel()` and `TestApp.kernel` offer `fetch`, `request` and `settle` only. A test that faked the peer with Hono's env argument (`{ incoming: { socket: { remoteAddress } } }`) passes `{ remoteAddress }`.
- `PinoLogger` is not exported: use `createPinoLogger()`.
- `LocalDisk`, `MemoryDisk` and `S3Disk` are not exported: configure the disk in `defineStorage()`, or implement `Disk` for a driver of your own.
- `MarmeonEntries` and `MarmeonPluginApi` (`@marmeon/vite`) become `MarmeonOptions['entries']`.
- `new DatabaseHealthCheck(connections)` goes: `DatabaseServiceProvider` registers the check.
- Every other name that left a package was not documented and lives under its `/internal` subpath, which may change in any release: the generated lint config forbids importing it, and `marmeon check` reports such imports. An app that needs one should open an issue.

There is no way back. See [Fakes](docs/fakes.md).

#### Low: Some packages and options are experimental

*Likelihood of impact: low — apps that use devtools, live, otel, table or tinker.*

Nothing to change. These may change in a minor release now: `@marmeon/devtools`, `@marmeon/live`, `@marmeon/otel`, `@marmeon/table` (with `@marmeon/react/table` and `/table-tanstack`), `marmeon tinker`, the devtools feature of `@marmeon/http/client`, the Vite options `pages` and `lang`, the `devtools`, `broadcast` and `live()` helpers of the test app, and `ResolvePage.features`. See [experimental](docs/releases.md#experimental).

#### Low: The app's definition is apart from the options that boot it

*Likelihood of impact: low — apps whose definition carries `env`, `phase`, `container` or `override`, and tests that pass `env` inside the definition.*

- Move `env`, `phase`, `container` and `override` from the definition in `bootstrap/app.ts` into `createApplication(definition, { … })`.
- `createTestApp({ ...definition, env })` becomes `createTestApp(definition, { env })`. The option layers over `.env` and the process environment instead of replacing them, so pin every key the test depends on, such as `DB_DRIVER`.
- A package that augmented `ApplicationOptions` augments `ApplicationDefinition` and reads `app.definition` instead of `app.options`.

There is no way back. See [Modules](docs/modules.md).

#### Low: The schemas of the framework's queued payloads are Standard Schemas

*Likelihood of impact: low — code that passed such a schema to Valibot, for example `v.parse(SignedIn.schema, …)`.*

For types, use `EventPayload<typeof SignedIn>`, `JobPayload<…>` or the named `…Payload` types; to validate, `SignedIn.schema['~standard'].validate(value)`. Run-time behaviour does not change. There is no way back.

#### Low: `marmeon` exits with 2 when a command is called wrongly

*Likelihood of impact: low — scripts that read exit code 1 as "called wrongly".*

Check for 2 instead. Scripts that only test for a non-zero exit need no change. There is no way back. See [exit codes](docs/console.md#exit-codes).

#### Low: A cache store of your own is a driver, and its locks a `LockStore`

*Likelihood of impact: low — apps with a cache store of their own, or code that typed a variable as `CacheStore` and locked through it.*

- Register the store as a driver: `static cacheDrivers = { name: factory }` on a provider, whose factory returns `{ store, locks }`. The methods `lock`, `unlock`, `forceUnlock` and `lockOwner` move to the `LockStore` returned as `locks` (one object may be both).
- `CacheStore` has no lock methods: `store.lock()` on a `CacheStore` does not compile; `new Lock(store, …)` takes a `LockStore`.
- `CacheConfig.driver` is a `string`, so an exhaustive `switch` over it stops narrowing. `CACHE_DRIVER` accepts any lower-case name; a name no provider brought is refused at `boot()` with the known names.

Apps that only use `Cache`, `cache.lock()` and `RateLimiter` change nothing. There is no way back. See [locks](docs/cache.md#locks).

#### Low: The passkey types come from `@marmeon/auth/passkeys`

*Likelihood of impact: low — code that types passkey values with the types of `@simplewebauthn/browser` or `/server`.*

Take the types from `@marmeon/auth/passkeys`. A value typed with the other ones may no longer compile against `Passkeys.register()`, `signIn()` or `confirm()`: `prf` values are base64url strings, and `attestationFormats` is `string[]`. There is no way back. See [Passkeys](docs/passkeys.md).

#### Low: A package's `"marmeon"` field holds only the keys the protocol knows

*Likelihood of impact: low — apps that use a package with another key in the `"marmeon"` field of its `package.json`.*

An unknown key (a misspelt `provider`, a `migrations` key) or a field that is `null`, `false` or a string stops the next start or `marmeon discover` with a message naming the package and the key. The package has to be fixed; until then use a version without the key, or `pnpm patch` / `overrides` it. A package author keeps `providers`, `browser` and `experimental` only, and declares migrations on the provider as `static migrations`. There is no way back. See [the package protocol](docs/package-development.md#the-package-protocol).

#### Low: `next()` takes the extension when any member of a union adds keys

*Likelihood of impact: low — middleware declared with a union whose members add keys, such as `defineMiddleware<{ user: User } | {}>` or `next: Next<A | B>` in a class, that calls `next()` without an argument.*

Such a middleware no longer compiles: the next handler would read a key that was never set. Pass the extension to `next(…)`, or declare the keys as optional in one type (`{ user?: User }`). `{}` and `object` still allow `next()` without an argument. Run-time behaviour does not change. There is no way back. See [adding to the context](docs/middleware.md#adding-to-the-context).

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
