# Security

## Introduction

This page lists what a Marmeon app protects by itself, what it leaves to you, and where each part is explained. The defaults are
chosen to be safe when nobody changes them. Where a protection costs something, such as a dependency, a migration or a cache, it is
a switch, and this page says which way it points. The [checklist](#your-checklist) at the end sums up what to do before a server
goes live.

Found a vulnerability in the framework? Report it privately, as [SECURITY.md](../SECURITY.md) describes, never in a public issue.

## The environment decides, and fails closed

`NODE_ENV` is `development`, `test` or `production`; any other value stops the start. Two rules depend on it, and they are not
mirror images of each other:

- **Development tools run only with `NODE_ENV=development`.** The error page with the code that threw, the devtools, the
  `Server-Timing` header, the mail previews and Vite's dev server stay off everywhere else, `test` included.
- **Protections apply to `production` and to a server where nobody set `NODE_ENV`.** JSON logs, `migrate` asking for `--force`,
  the warnings at start-up and the absence of lab pages hold there. `test` belongs to the test runner alone: it turns every
  protection off, and development-only routes answer under it, so it never belongs on a server.

One check does not depend on `NODE_ENV` at all: an app whose routes do not all say who may call them does not start, in
development, in `test` and in `production`. The same holds for an open route that loads a record by any key. The
[authorization](authorization.md#every-route-decides) page has the rule.

`APP_ENV` names the environment (`staging`, `production`, a name of your own) and changes neither rule: `APP_ENV=local` on a
server with `NODE_ENV=production` is protected, and its development routes answer 404. A staging server is
`NODE_ENV=production APP_ENV=staging`, with the production builds of the framework and of React, so a server error never reaches
its visitors with a message or a stack.

A forgotten variable therefore never shows your source code to a visitor. Set `NODE_ENV` in the server's real environment, and
never deploy a developer's `.env`: `marmeon start`, `queue:work` and `schedule:work` warn loudly when `development` comes from a
`.env`, and the start line says `development (APP_ENV=local, NODE_ENV from .env)`. The
[configuration](configuration.md#the-environment-node_env) page explains where `NODE_ENV` comes from.

Code that runs in the browser and in server rendering checks for development positively, as `development` or `test`, never as
"not production". Without a value, an error in the browser shows only its short code, such as `[marmeon:R2] users/Show`, no
development warning appears, and an error page rendered on the server carries no exception message.

## Development routes

The devtools at `/_marmeon/devtools` and the mail previews at `/_marmeon/mail` exist only with `NODE_ENV=development`. They sit
behind one host guard, `devOnly()` of `@marmeon/core/dev`: it answers `localhost`, `127.0.0.1`, `[::1]` and the host of `APP_URL`,
and gives every other `Host` a 403 before the handler runs. Every answer is `no-store` and `nosniff`, carries no CORS header, and
is shared with no other origin, neither as a resource nor as a window.

The attack it stops is DNS rebinding. A page on `evil.example` points its own name at `127.0.0.1`, reaches the developer's server
with `Host: evil.example`, and reads the answers as if they were its own: recorded requests, mails with reset links, source paths.

- `marmeon dev` puts Vite in front, and Vite refuses unknown hosts itself. It does not under HTTPS, with `server.https` in
  `vite.config.ts`, and not with `allowedHosts: true`. Then the guard alone protects the devtools and the mail previews, while
  Vite's own paths, such as source modules, and the development error page have no host check. Use either setting only on a
  network you trust, and keep `allowedHosts` a list. The [asset bundling](vite.md#the-dev-server) page covers Vite's settings.
- A development route of your own takes the same guard. Outside `development` and `test` it answers 404 by itself, asked on every
  request: a route registered on a server by mistake stays shut. The [routing](routing.md#development-only-routes) page shows how.
- `*.localhost` names pass Vite, since they are loopback by definition, but not the guard, unless `APP_URL` names one.

## Requests from other sites

Every request of the `web` group that may change something is checked for cross-site request forgery. The browser's
`Sec-Fetch-Site: same-origin` passes, and a request from another site is refused with 403. Without Fetch Metadata, the `Origin`
header decides. Only a client that sends neither needs the session's token, and without it gets 419.

- Guests get no session just for a token. A session draws its token only when something needs it, and signing in or out renews it.
  A guest who only reads leaves no cookie behind, unless the page keeps a session, such as one with an upload field.
- Browsers send Fetch Metadata to secure origins only. Over plain HTTP the check falls back to `Origin`, then to the token. Serve
  production over HTTPS.
- Trust other origins with `CSRF_TRUSTED_ORIGINS`, and exclude webhooks that cannot carry a token with a module's `csrfExcept`.
- The `api` group has no session and no CSRF check, since every request proves itself with its [API token](api-tokens.md).

The [CSRF protection](csrf.md) page explains every stage.

## Sessions and cookies

- **Every cookie is `Secure` when `APP_URL` starts with `https://`:** the session cookie, `XSRF-TOKEN`, the remember-me cookie and
  your own. `SESSION_SECURE_COOKIE` overrides it either way. A protected app whose cookies go without `Secure` warns at start-up.
  The [session](session.md#secure-cookies) page has the details.
- **Cookies are encrypted** with `APP_KEY` in the `web` group, all but `XSRF-TOKEN`, which the browser's JavaScript reads. The
  session cookie is also `HttpOnly`.
- **The store never sees a session id.** A session is kept under the SHA-256 hash of its id, so a leaked file, row or Redis key is
  no cookie. `SESSION_ENCRYPT=true` encrypts the data as well. The [session](session.md#how-sessions-are-stored) page explains both.
- **Signing in or out renews the session:** a new id and a new CSRF token, so an id handed out before signs nobody in.
- **Signed-in answers are `Cache-Control: no-store, private`,** so Back after signing out shows nothing from the browser's cache.
  Signing out also sends `Clear-Site-Data`, and the other tabs of the browser follow by themselves. The
  [authentication](authentication.md#signed-in-pages-are-never-cached) and
  [client features](client-features.md#the-browsers-storage-on-sign-out) pages explain them.
- **Requests that only read never write.** Islands, live streams and the tabs' session checks write no session data and set no
  cookie. The [request lifecycle](lifecycle.md#requests-that-only-read) page lists them.
- **Use a session driver on the server for an app with sign-in:** `file`, `database` or `redis`. The `cookie` driver cannot
  protect a sign-out against a request that was still running.

## Keys

`APP_KEY` encrypts cookies, encrypted jobs and sealed sessions, and the keys that sign URLs, live channels and uploads are derived
from it. Anyone who has it can read and forge all of them. Generate it once per environment with `marmeon key:generate`, keep it
out of the repository and out of the image, and rotate it with `APP_PREVIOUS_KEYS`, so that old cookies and signed links stay valid
until they expire. The [encryption](encryption.md#rotating-the-key) page explains the key and its rotation.

## Pages and scripts

- **Content Security Policy.** `contentSecurityPolicy()` gives every document a policy with a fresh nonce: scripts only with that
  nonce, and the chunks they load, no plugins, no foreign `<base>`. Every new app turns it on. A nonce must never reach a shared
  cache: the app warns when a publicly cached page carries one. The [Content Security Policy](csp.md) page explains the policy.
- **Styles without `'unsafe-inline'`.** The framework renders no `style` attribute, so `styleSrc: ["'self'"]` blocks nothing of
  its own in a built app. Your own `style` props need classes then, and `@marmeon/react/styles.css` is imported in the client
  entry. The [styling](styling.md#no-style-attributes) page shows how.
- **Escaping.** React escapes what pages render. HTML you write by hand goes through the `html` template of `@marmeon/core`, as
  the [responses](responses.md#html-you-write-yourself) page shows. Page data travels as JSON in an inert
  `<script type="application/json">`.
- **Security headers.** A new app's `middleware/SecurityHeaders.ts` sends `nosniff`, a strict `Referrer-Policy` and
  `X-Frame-Options: DENY` on every response. Its switch for `Strict-Transport-Security` is off until you turn it on, once the site
  answers over HTTPS alone. The [Content Security Policy](csp.md#the-other-security-headers) page lists them.
- **Behind a proxy,** `X-Forwarded-*` headers count only from the addresses in `TRUSTED_PROXIES`. Otherwise any client could choose
  its own address, for rate limits and logs, and its own scheme. `*` trusts the direct peer only, and is safe only when nothing
  but your proxy can reach the app. The [deployment](deployment.md#trusted-proxies) page explains the values.
- **No compression of documents.** A compressed page that holds a secret next to text an attacker controls leaks the secret byte
  by byte. The framework compresses assets at build time and never pages; leave pages uncompressed at the proxy too, as the
  [deployment](deployment.md#compression) page says.

## Accounts

- **Passwords** are hashed with Argon2id, within bounds that a planted hash cannot exceed. The [hashing](hashing.md) page explains
  the drivers and costs.
- **Rate limits.** The starter kit limits the sign-in per address and client together, the registration per client, reset mails
  per client and per address, and a signed-in user's password checks per user: the confirmation, the password change and "sign
  out other devices". The password change and "sign out other devices" run one at a time per session. The
  [rate limiting](rate-limiting.md#defining-limiters) page covers limiters.
- **A sign-in tells nothing.** An unknown address and a wrong password get the same answer in the same time. The
  [authentication](authentication.md#signing-in) page explains how.
- **Validation never tells whether a record exists while a field is typed.** The `unique` and `exists` rules and an async
  `custom()` do not run in a live validation unless the rule says `.live()`, which a rule that asks about accounts must never do.
  Without it, a free and a taken address get the same answer there, and only a submit tells, behind its rate limit. A schema of
  another library runs live only when its request says `live: true`, which a form that asks about accounts must never say either.
  The unique index stays the truth: `failOnDuplicate()` turns its conflict into a 422. The
  [validation](validation.md#database-rules-and-why-they-never-run-live) page explains why.
- **Mail goes out encrypted or not at all.** SMTP uses TLS from the first byte, or requires STARTTLS, so a server without it, or
  someone who strips the offer, never sees the credentials or a reset link. `MAIL_REQUIRE_TLS=false` turns the requirement off, for
  a local relay only. The [mail](mail.md#smtp-and-tls) page has the settings.
- **Policies decide what a user may do,** on every request: the session's user on a page, the token's user on a route behind
  `authenticate('api')`. Authorize an API route with the token's abilities and a policy. An ability only says what kind of action
  a token may do, never on whose record, so it alone leaves the records of every user open to whoever changes an id. The
  [authorization](authorization.md#policies-and-api-tokens) page shows both on one route.
- **Every route says who may call it.** The app does not start with a route that does not, and `abilities()` is not that decision.
  The [authorization](authorization.md#every-route-decides) page shows the check and its limits.

### Private registration

The registration of the starter kit never tells whether an address has an account. This is the default:

- Every registration gets the same answer in the same time. The owner of a known address gets a mail instead of a second account.
- Registering signs nobody in. The auth module's pages ask for a confirmed address, so whoever registered with somebody else's
  address sees only a notice, and the owner takes the account over with a password reset. Your own routes need `verified()` for
  the same: the [email verification](verification.md#requiring-a-confirmed-address) page explains it.
- A change of address waits until the link sent to the new address is opened, with the same answer for a free and a taken address.

### Open registration

`AUTH_PRIVATE_REGISTRATION=false` turns all of this off. The registration and the change of address then say "taken", a new account
is signed in at once, and a new address takes effect at once. From then on only the registration's rate limit stands between the
form and a list of who has an account. Outside development and tests the app logs a warning about it at every start. Turn it off
only when the accounts of your app are public anyway. The [starter kit](starter-kit.md#turning-it-off) page shows the switch.

An unconfirmed account is then a working account. Whoever registers with somebody else's address uses it at once: the module's
`ConfirmedAddress` lets every signed-in user through, the tokens page included, which asks only for the password they chose. When
the owner later takes the account over with a password reset, its sessions and remember-me tokens end. An API token created in the
meantime ends with them only with `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`; without it, it stays valid, up to 90 days with the
starter kit. With open registration, set `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true` and put `verified()` in place of
`ConfirmedAddress` on the token routes.

### Accounts nobody confirmed

`auth:prune-unverified` deletes accounts whose address was never confirmed, `AUTH_UNVERIFIED_DAYS` days after the sign-up, 7 by
default. An account confirmed once is never deleted. The command runs only when your app turns its line on in
`modules/auth/schedule.ts`, because deleting accounts is your app's decision. Once it runs, whoever registered with somebody
else's address stops holding it, and nothing of an unfinished sign-up stays: the account, its tokens and what other modules keep
go, and its sessions end. With open registration, such an account was signed in and may have used the app before it goes. Without
the line, these accounts stay: decide it for your app. The [email verification](verification.md#unconfirmed-accounts) page
explains the rules.

## Tables and exports

A table of `@marmeon/table` is one definition the server enforces on every request. These are the attacks of hand-written tables,
and what stops each:

- **Hidden columns stay hidden.** A column the policy hides is not selected: not in the SQL, so not in the props, the devtools'
  query log, a cursor or an export. The props are picked by name besides.
- **No sort oracle.** Sorting, filtering or searching by a column the user cannot see is a 400, as is any sort, filter or page size
  the definition does not name, such as `?sort=password` or `?per_page=10000`. An order by a secret would tell its values without
  showing them. Nothing from the URL reaches `ORDER BY` or `WHERE` that the definition did not name.
- **No bulk IDOR.** A bulk action acts on the keys sent, within the base query, and only on rows the policy allows. Another
  tenant's key or a made-up one is left out as missing, and a row the policy refuses is skipped. "All matching" sends the filter,
  never keys, and the server refuses more rows than the action's `max` with 422. Put the tenant into the base query: every endpoint
  starts from it. The endpoints take the middleware of the page's route registrar, not the page controller's `authorize`, so a
  table that needs one declares it.
- **No CSV injection.** Exported text cells that start with `=`, `+`, `-`, `@`, a tab or a line break get a `'` in front, and every
  field is quoted. An export has its own `authorize` and a row limit, 10 000 by default, beyond which it answers 422 before the
  first byte. Rate-limit it as well: it reads the whole filtered table.
- **Keys are parsed by their declared type** before any query, so text never reaches an integer column.

The cursors of `cursorPaginate()` and of cursor tables are encrypted with the app key: a hidden sort column's value never shows in
a URL, and a changed or made-up cursor is a 400. The [tables](tables.md#the-security-model) and
[pagination](pagination.md#cursors) pages explain both.

## Live updates

Live props send hints, never data. A tab that gets a hint reloads through the page's route, its middleware and its policies, so a
hint can never show what the user may not see. A subscription is signed for its session, and another channel or another session's
token answers 403. Limits keep one user from exhausting a process: at most 16 streams per session
(`LIVE_MAX_STREAMS_PER_SESSION`, beyond it 429 and a warning in the log), 1000 per process (`LIVE_MAX_STREAMS`, beyond it 503) and
20 channels per stream. The limit per session counts by session, not by address; a flood of fresh sessions meets the limit per
process, so limit connections at the proxy as well. The [real-time updates](realtime.md#limits) page explains them.

## Logs and recordings

The log masks the values of keys that look like secrets, such as `password`, `token`, `cookie` or `authorization`, in nested
objects too, and the names packages add to the app's `Redactor`, such as the session cookie's. A `URL` in the context, and the
message and stack of an error under any key, are masked as text. Every other string, the message included, is written as it is,
so never put a secret into one. The [logging](logging.md#keeping-secrets-out-of-the-log) page lists the rules, and
the app's `Redactor` for text you must log.

The devtools' recordings, the development error page and traces go further: the same `Redactor` also masks every string there.
The devtools exist in development only and refuse other hosts. The [logging](logging.md#what-the-framework-shows-elsewhere) page
explains what each shows.

## Traces

With `@marmeon/otel`, a request from outside starts a trace of its own, and an incoming `traceparent` header is only a link to the
caller's span. A client cannot put its requests into a trace it chose, nor switch their recording on or off with the sampled flag,
and its baggage is dropped. `OTEL_TRUST_TRACEPARENT=true` continues the caller's trace: set it only behind an edge that sets or
strips the header, such as a gateway, an ingress or a mesh. `TRUSTED_PROXIES` is no reason, since a proxy usually passes the
client's header on unchanged. The [observability](observability.md#a-callers-traceparent) page covers tracing.

## Your checklist

- `NODE_ENV=production`, or another protected value, in the server's environment, and no developer's `.env` on the server.
- `APP_URL=https://…`, and a fresh `APP_KEY` per environment, kept in the server's secrets.
- `contentSecurityPolicy()` in `bootstrap/app.ts`, which a new app has. New inline scripts take `ctx.nonce()`. With a `styleSrc`,
  classes instead of `style` props, and `@marmeon/react/styles.css` imported in the client entry.
- `AUTH_SESSION_MAX_HOURS` as long as you accept a stolen session to work (24 hours by default), and `AUTH_REMEMBER_DAYS` for "Keep me signed in" (30 at most, 0 turns it off).
  [How long a sign-in lasts](authentication.md#how-long-a-sign-in-lasts) lists both. An app that needs AAL2 sets `SESSION_LIFETIME=60`
  (at most an hour of inactivity); the silent sign-in by a remember-me cookie is AAL1, and AAL2 holds only behind `twoFactor()`.
- `verified()` after `authenticate()` on every route of your own that signed-in users reach.
- Every route of your own has a decision that you chose: a policy for a record, `everyone` only when anyone the middleware lets
  through may call it. `marmeon route:list` shows the `ACCESS` of each route.
- `marmeon dev` over HTTPS or with `allowedHosts: true` only on a trusted network. Staging private, since it shows server errors.
- Whether unconfirmed accounts go: the `auth:prune-unverified` line in `modules/auth/schedule.ts`, and `AUTH_UNVERIFIED_DAYS` as you
  want it, 7 by default. With `AUTH_PRIVATE_REGISTRATION=false`, tell your users that an unconfirmed account goes, and set
  `AUTH_REVOKE_TOKENS_ON_PASSWORD_CHANGE=true`.
- `abilities()` on every API route that acts: without it, every token of a user acts with all of the user's rights.
- `OTEL_TRUST_TRACEPARENT` only behind an edge that owns the header, and `OTEL_RECORD_QUERY_VALUES` only when your URLs carry no
  personal data.
- HSTS once the site answers over HTTPS only: the switch in `middleware/SecurityHeaders.ts`, or the proxy.
- `TRUSTED_PROXIES` set to exactly your proxy, or `*` for the direct peer when nothing else can reach the app. The proxy sets
  `X-Forwarded-*` itself and does not compress pages.
- Sessions in `file`, `database` or `redis`, not `cookie`, for an app with sign-in. `SESSION_ENCRYPT=true` when the store is shared.
- Tables: the tenant in the base query, `tableRoutes` on the page's registrar, an `authorize` for exports, a `throttle` on the
  table's routes.
- Update the framework's packages together and read [UPGRADING.md](../UPGRADING.md). Security fixes go to the latest minor
  version, as the [releases](releases.md#node-and-security-fixes) page explains.
