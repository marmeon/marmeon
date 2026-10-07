# Upgrading

What changes for an app from one version of Marmeon to the next — in Laravel's manner: each entry says how likely it is
to affect you (**impact**), what to do (before → after), and how to keep the old behaviour where there is a way.

**Impact:** High — most apps must act. Medium — apps that use the feature must act. Low — only in rare cases, or nothing
to do. The newest version comes first. In 0.x a minor version may break, and every break has an entry here; a patch never
breaks ([versions and deprecations](README.md#versions-and-deprecations)). Every package, `marmeon` and
`create-marmeon` share one version: upgrade them together — set every `@marmeon/*` and `marmeon` in `package.json` to the new
version and install. Two versions of a framework package in one app mean two containers and two `Application` classes.

**Marmeon was called BespokeCore up to 0.1.0** (never published) — every entry below uses the new names: `@marmeon/*`, the CLI
`marmeon`, `create-marmeon`, `x-marmeon-*`, `/_marmeon/*`, `MARMEON_*`, `[marmeon:…]`.

## Upgrading to 0.2.0 from 0.1.0

The changes of Wave 9 (client and navigation). Nothing is High: no app must act. The entries come by impact, and within an
impact by area:

| Area | Medium | Low |
| --- | --- | --- |
| Lists and data | [revalidations replace merged props](#medium-an-actions-or-a-live-hints-reload-replaces-merged-props--a-deleted-row-stays-gone) · [`paginate(…, ctx.query)`](#medium-paginate-takes-ctxquery--pagequery-in-the-query-schema-paginationfrom-deprecated) · [`<Pagination>`](#medium-pagination-takes-its-links-from-the-parsed-query-and-its-texts-from-labels) | [GET arrays](#low-a-list-in-a-gets-data-is-the-key-repeated) · [`merge()` of a paginator](#low-merge-of-a-paginator-appends-its-data-matchon-takes-paths-merge-marks-no-longer-pile-up) · [encrypted cursors](#low-cursors-are-encrypted--cursorpaginate-needs-the-encrypter-an-old-cursor-is-a-400) · [queries take turns on a shared connection](#low-queries-on-a-shared-connection-take-turns--a-transactions-a-tests-pinned-one) · [a filter on a hidden column](#low-a-tables-filter-on-a-hidden-column-is-hidden-with-it) |
| Live updates | [16 streams per session](#medium-one-session-holds-at-most-16-live-streams-per-process--the-17th-tab-gets-a-429) · [a cluster needs Redis](#medium-a-cluster-marmeon-start-with-workers-needs-live_driverredis) | — |
| Navigation | [the Navigation API](#medium-the-navigator-uses-the-navigation-api--historystate-is-null-its-navigate-events-are-visible) | [the guard](#low-the-guard-cancels-a-back-where-the-browser-lets-it--and-goes-back-by-the-browsers-key) · [optimistic patches on first use](#low-userouter-loads-the-pages-optimistic-patches-on-first-use) · [the kit's `Confirm`](#low-the-starter-kit-asks-in-the-pages-language--its-own-confirm) · [view transitions](#low-view-transitions-are-opt-in--with-viewtransition-react-a-page-change-is-a-react-transition) · [`reset()` after saving](#low-a-reset-in-a-submits-onsuccessonfinish-resets-to-the-defaults-before-the-submit--the-saved-form-is-not-dirty) · [reloads built while rendering](#low-a-page-that-builds-its-reloads-while-rendering-renders-on-the-server-again) |
| Accounts | [`make:auth` private by default](#medium-the-registration-of-makeauth-is-private-by-default--auth_private_registrationfalse-turns-it-off) · [pending change of address](#medium-with-private-registration-a-change-of-address-is-pending-until-its-link-is-clicked--migrate-the-new-columns) · [SMTP requires TLS](#medium-smtp-requires-tls--starttls-or-no-mail-mail_require_tls) | — |
| Server and deployment | — | [`KEEP_ALIVE_TIMEOUT`](#low-the-server-keeps-idle-connections-65-s-keep_alive_timeout) · [build without `.env`](#low-marmeon-build-needs-no-env-and-no-key--drop-the-throwaway-key-from-your-dockerfile) · [tini](#low-the-image-runs-marmeon-under-tini--rebuild-it) · [pnpm 12.9.1](#low-pnpm-1291) · [`<title>`](#low-a-new-apps-title-is-its-name-not-marmeon) · [a program on 127.0.0.1 at the port](#low-the-start-warns-when-another-program-holds-127001-at-its-port--and-a-taken-port-fails-startserver) |
| Security | — | [no CORS in `marmeon dev`](#low-marmeon-dev-answers-other-origins-without-cors-headers) · [S3 content type](#low-an-s3-temporary-url-names-the-content-type-by-the-file-name) · [S3 disks sharing a prefix](#low-a-private-s3-disk-that-shares-a-prefix-of-one-bucket-with-a-public-one-fails-the-start) · [`verified()` fails closed](#low-verified-treats-a-user-without-email_verified_at-as-unverified) |

*Estimated upgrade time:* minutes for most apps (read the Medium entries of the features you use); about an hour for an app with
`merge()`d lists that load more, `paginationFrom`, live props under `--workers`, or private registration (its migration and
controllers). The guides of the wave: [lists](docs/lists.md), [tables](docs/tables.md), [navigation](docs/navigation.md),
[real time](docs/realtime.md).

### Wave 9 — client and navigation

#### Medium: an action's or a live hint's reload replaces merged props — a deleted row stays gone

*Likelihood of impact: medium — pages with `merge()`/`deepMerge()` props that an action or a live hint reloads.* A partial reload
that **revalidates** — what an action reloads once it succeeded (`router.reloading({ only })`, `layer.reloading`, an island's
`reloading`), what a live hint reloads, what `revalidateOnBack` reloads — now **replaces** the props it brings, also those the
server marks `merge()` or `deepMerge()` (E183). Before, it merged them: on a list that had loaded more, a row the action deleted
came back from the pages loaded before (the first page was merged over the old list). Now the list is what the server says — and
starts over at its first page; "load more" (a visit or reload with `data`/`query`: `<Link query={{ cursor }} only preserveUrl>`,
`reload({ data: { cursor }, only })`) appends as before. The difference comes from where a reload comes from, not from what it
looks like. To keep the old behaviour for one reload: `router.reloading({ only: ['people'], reset: [] })` (`reset` names the
props it replaces — default: all it brings). Live hints and `revalidateOnBack` have no switch: they replace.

#### Medium: `paginate` takes `ctx.query` — `pageQuery()` in the query schema, `paginationFrom` deprecated

*Likelihood of impact: medium — controllers that paginate with `paginationFrom(ctx.query)`.* The page of a list is now a part of
the route's query schema: spread `pageQuery({ perPage: [25, 50, 100] })` (`@marmeon/database`) into it — `?page=` and
`?per_page=` parsed like every query field (an invalid value falls back to its default, never a 422; `ctx.query.per_page` typed
`25 | 50 | 100`) — and hand `paginate(db, query, ctx.query)` / `repository.paginate(query, ctx.query)` the parsed query. A query
without a page is a type error that says so. `paginationFrom` keeps working (it reads a parsed query object now too) but is
deprecated: with a query schema, `ctx.query` is no `URLSearchParams`, and `<Pagination>` builds its links from the schema. Before:
`paginate(db, q, paginationFrom(ctx.query, { perPage: 25 }))`; after: `query: v.object({ ...pageQuery({ perPage: [25, 50] }), … })`
and `paginate(db, q, ctx.query)`. `{ page, perPage }` written out is still accepted.

#### Medium: `<Pagination>` takes its links from the parsed query and its texts from `labels`

*Likelihood of impact: medium — pages that render `<Pagination>`.* Its links come from the page's parsed query (`PageObject.query`
+ `queryDefaults`, E55) instead of the address: the rest of the query (search, sort, page size) stays, the defaults stay out
(`?page=1` is no page's URL), and keys the schema does not know are no longer carried along. On a route **with** a query schema,
the schema needs the page's field — spread `pageQuery()` into it (development warns: R17); a route without a schema keeps its
query string as before. Its texts are English unless the app passes its own words: `labels={{ navigation, previous, next, page:
(n) => … }}`, from the app's language files (`useTranslation`, E38) — best in a small wrapper component of the app (see the web
app's `layouts/Pagination.tsx`); before, every text was a fixed English literal. An app without `labels` looks as before. The old links — the address's query string carried along —
remain for a route without a query schema; with one there is no switch back (a key the schema does not know was never the page's
state).

#### Medium: one session holds at most 16 live streams per process — the 17th tab gets a 429

*Likelihood of impact: medium — apps with live props whose users keep many tabs open, and tests that open many streams for one
session.* `GET /_marmeon/live` now counts the streams of each session (W9 step 4): beyond `LIVE_MAX_STREAMS_PER_SESSION` (default
**16**) in one process a new stream is refused with **429** (`Retry-After: 30`, a `warn` line in the log) — the 17th tab of a browser
gets no live hints until one of the others closes (its client tries again every 30 s). Before, one session could take every stream
of the process (`LIVE_MAX_STREAMS`, 1000) and leave live updates dead for every other user. The counts are atomic now (fifty tabs
opening at once never get past a limit), and a stream asked for while the server closes is refused with 503 instead of holding
the shutdown. To allow more tabs: `LIVE_MAX_STREAMS_PER_SESSION=32` (there is no "off" — set it as high as `LIVE_MAX_STREAMS` for
the old behaviour). A test that opens many streams for one user raises it in its environment.

#### Medium: a cluster (`marmeon start` with workers) needs `LIVE_DRIVER=redis`

*Likelihood of impact: medium — apps started with `marmeon start --workers=N` and the default `LIVE_DRIVER=memory`.* With the memory
backend every worker of the cluster has its own pub/sub and its own sequences: a hint reached the tabs connected to the worker that
sent it, and a tab that reconnected to another worker compared its sequences with another counter — live updates went missing
without a sound. Now a worker does not start with `LIVE_DRIVER=memory` (`LiveSetupError`: "memory pub/sub never reaches the other
workers — use LIVE_DRIVER=redis …"), and the cluster stops with the worker's code. Set `LIVE_DRIVER=redis` (with
[@marmeon/redis](packages/redis/README.md)) — the web app's `.env.example` does — or start one process without `--workers`.
One process with `memory` (`marmeon start`, `marmeon dev`) is unchanged.

#### Medium: the navigator uses the Navigation API — `history.state` is null, its `navigate` events are visible

*Likelihood of impact: medium — code that reads or writes `history.state`, listens to `navigation`'s `navigate` event, or builds its
own adapter or client feature.* Where the browser has the Navigation API (Chrome, Edge, Firefox 147+, Safari 26.2+), the navigator
writes and follows the history through it (E184): a visit commits its entry with `navigation.navigate(url, { state, info })` and
intercepts that navigation, Back/Forward to its own entries are intercepted (`navigation.transition` — the browser's loading indicator
while one asks the server). So **`history.state` is `null`** — an entry's state is `navigation.currentEntry.getState()` (positions
only, as before, E36); code that read `history.state.key` or `.url` reads it there, or not at all. **The `navigate` events of visits
reach the app's own listeners** (`navigationType` `push`/`replace`, the navigator's `info`): a listener that intercepts or cancels
every `navigate` now also catches visits — leave the ones with an `info` you did not set alone. A plain `<a href>`, a plain form,
another site and entries without the navigator's state stay the browser's, as before. Without the API (Safari before 26.2) nothing
changes: the History fallback writes `history.state` as before — a chunk `createMarmeonApp` loads only then. There is no switch
back to the History API in a browser that has the Navigation API (the two would follow the same Back twice).
**For an adapter of your own:** load the fallback where `!window.navigation` and pass it with the features from the start
(`new Navigator({ …, features: [await loadHistoryFallback()] })`; development warns `[marmeon:C13]`). **For a client feature:**
`HistoryState.index` and `HistoryWriter.index` are gone (the fallback counts for itself); a feature that wrote a field into every
entry by wrapping `host.history.push`/`replace` gives it a value instead — `host.history.field(name, check, (entry) => value)`; the
`popState` hook gets the navigator's `HistoryState` (no longer any `history.state`), and a new `navigate` hook sees Back/Forward before
the navigator intercepts it (the guard's).

#### Medium: with private registration a change of address is pending until its link is clicked — migrate the new columns

*Likelihood of impact: medium — apps made with `make:auth --private-registration` (or `create-marmeon --private-registration`);
the default registration is unchanged.* The security page told whether an address has an account: "taken" for one, an address
change for a free one (W9 step 9, E146/E187). Now a new address is **pending** — kept beside the account's own until the link sent
to it is clicked while signed in; a free and a taken address get the same answer in the same time; the owner of a taken one gets a
note (`EmailInUseMail`) and nothing changes for anybody. The account changes only with the click (then confirmed, the old address
told as before). Your `modules/auth` is yours, so the update does not change it — take the variant over by hand:

1. A migration that adds `pending_email` (string 255, nullable), `pending_email_token` (string 64, nullable, **`.secret()`**) and
   `pending_email_expires_at` (timestamp, nullable) to `users` — `stubs/react/modules/auth/migrations/0001_01_01_000004_add_pending_email_to_users_table.ts`
   of `@marmeon/auth`; `marmeon migrate`, then the regenerated `bootstrap/database.d.ts` (a `User` literal of yours — mail
   previews, test doubles — needs `pending_email` and `pending_email_expires_at`).
2. From the same directory: `email-change.ts`, the new methods of `UserRepository.ts` (`requestEmailChange`, `pendingEmailChange`,
   `confirmEmailChange`, `cancelEmailChange`, `pruneEmailChanges`; `changeEmail` goes), `controllers/UpdateEmailController.ts`,
   `controllers/ConfirmEmailChangeController.ts`, `controllers/ShowSecurityController.ts` and `views/Security.tsx` (the pending
   address), `jobs/SendEmailChangeMailJob.ts` (in `jobs` of `index.ts`), `mail/ConfirmNewEmailMail.ts`, `mail/EmailInUseMail.ts`,
   `tasks/PruneEmailChanges.ts` (in `schedule.ts`), the two routes of `routes.ts` (`throttle('email-change')` on `PUT
   /settings/email`, the signed `/email/change/:id/:token`) and `email-change.test.ts`; the `email-change` limiter of the default
   `AuthServiceProvider.ts` and the texts of `lang/en.ts` (`security.email_change_sent`, `security.email_pending`, `email_change.*`,
   `mail.confirm_new_email.*`, `mail.email_in_use.*`).

Until then the old controller keeps working — and keeps telling "taken". (Since E193 the templates are one module with both
behaviours — see the next entry: the files above now read `AuthConfig.privateRegistration`.)

#### Medium: the registration of `make:auth` is private by default — `AUTH_PRIVATE_REGISTRATION=false` turns it off

*Likelihood of impact: medium — new auth modules (`marmeon make:auth`, `create-marmeon`'s starter kit) and scripts that pass
`--private-registration`; a module generated before is yours and does not change.* The private registration (E146) is the
default now, and the flag that chose it is gone (E193): `make:auth` writes **one** module whose registration and change of
address never tell whether an address has an account — the same answer in the same time, a note to the owner instead, a
confirmed address before the app's pages open, a pending change of address. The controllers decide at run time by
`AuthConfig.privateRegistration` (`AUTH_PRIVATE_REGISTRATION`, default `true`; only `true` and `false` boot):

| | before (0.1.0) | after (0.2.0) |
| --- | --- | --- |
| `marmeon make:auth` | registration says "taken", signs in at once | private |
| `marmeon make:auth --private-registration` | private | a warning (the flag is gone) — the same module as without it |
| `create-marmeon --private-registration` | private | a warning on stderr — the same app as without it (with `--minimal` no longer an error) |
| Laravel-like registration in a new module | the default | `AUTH_PRIVATE_REGISTRATION=false` in `.env` |

With `AUTH_PRIVATE_REGISTRATION=false` the module behaves as the old default did: a taken address is a field error (live and on
submit), a new account is signed in at once and the app's pages let an unconfirmed account through (`middleware/ConfirmedAddress.ts`;
put `verified()` there to keep asking), a new address takes effect at once; `/register/sent` and `/email/change/…` answer 404, and
the `pending_email` columns stay unused. Outside development and tests the boot then warns once (`PRIVATE_REGISTRATION_OFF_WARNING`
of `@marmeon/auth`): the form tells anyone who has an account. Scripts and CI that call `make:auth --private-registration` or
`create-marmeon --private-registration` keep working — drop the flag to silence the warning. `AuthConfig` has two more fields,
`privateRegistration` and `protected`: an `AuthConfig` object you build by hand (a test double) needs them.

#### Medium: SMTP requires TLS — STARTTLS or no mail (`MAIL_REQUIRE_TLS`)

*Likelihood of impact: medium — apps with `MAIL_MAILER=smtp` on a server without TLS (a local relay, Mailpit).* Without
`MAIL_SECURE=true` the SMTP transport upgraded with STARTTLS only when the server offered it — and sent in plain text when it did not:
a server without STARTTLS, or someone on the network who strips the offer, got the credentials and every mail, reset links
included. Now STARTTLS is required (E192): such a send fails (a queued mail is retried and lands with the failed jobs) instead of going
out unencrypted. `MAIL_SECURE=true` (TLS from the first byte, port 465) is unchanged. A server without TLS that you trust — Mailpit on
port 1025, a relay on the same machine — takes `MAIL_REQUIRE_TLS=false` (commented in `.env.example`); `new SmtpTransport({ …,
requireTls: false })` the same. The old behaviour: `MAIL_REQUIRE_TLS=false`.

#### Low: the server keeps idle connections 65 s (`KEEP_ALIVE_TIMEOUT`)

*Likelihood of impact: low — apps behind a proxy or a load balancer.* Node closes an idle keep-alive connection after 5 s; nginx (the
`make:docker --nginx` template: `upstream { keepalive 16; }`) keeps its connections to the app 60 s — so now and then it sent a
request on a connection the app was just closing, and the browser got a 502. The server now keeps them `KEEP_ALIVE_TIMEOUT` seconds
(default **65**, `headersTimeout` a second longer), above nginx's upstream `keepalive_timeout` (60 s, now written into the template) and an
AWS load balancer's idle timeout (60 s). Behind a proxy that keeps them longer (Google's load balancer: 600 s) set
`KEEP_ALIVE_TIMEOUT` above it; an nginx config of your own with a longer `keepalive_timeout` keeps it below. Nothing to do otherwise —
an idle connection stays open a minute longer than before (the drain on shutdown closes idle connections at once, as before).
The old behaviour: `KEEP_ALIVE_TIMEOUT=5`.

#### Low: `marmeon build` needs no `.env` and no key — drop the throwaway key from your Dockerfile

*Likelihood of impact: low — Dockerfiles and CI jobs written for 0.1.0 keep working; a provider that reads configuration while it
registers.* `marmeon build` writes the route types (`marmeon route:types`) from the app in its **build phase** (E187,
`createApplication({ phase: 'build' })`): every provider registered, none booted — no connection, no driver check — and the
configuration that does not validate without `.env` (`APP_KEY`, `APP_NAME`, `APP_URL`, database passwords, mail credentials …)
left out instead of failing. Before, the Dockerfile of `make:docker` copied `.env.example` to `.env` and generated a throwaway
`APP_KEY` for the build; now it runs `NODE_ENV=production marmeon build` with neither, and its `.dockerignore` keeps every
`.env*` out (no `!.env.example`). In a Dockerfile of your own, remove the `cp .env.example .env`, the
`APP_KEY="$(marmeon key:generate --show)"` and any `ARG`/`ENV` you added only for the build. Two consequences: a provider that
reads such a configuration in `register()` fails the build with `The configuration "…" is not available while building` — read
it in `boot()` or later; and named routes belong where `register()` sees them — a module's `routes` (the http provider now loads
them while registering, no longer in `boot()`) or a provider's own `register()`: routes loaded in `boot()` still serve requests
but are no longer in `bootstrap/routes.ts`. `marmeon route:types` runs so everywhere — also `route:types --check` in CI, without
a key. (`static boots = 'build'` is read for the built-in commands only: an app's own commands are found by booting the app, so
they run in a booted one.)

#### Low: the image runs `marmeon` under tini — rebuild it

*Likelihood of impact: low — images built from a Dockerfile of `make:docker`; Compose files with `init: true`.* The final stage of
the Dockerfile installs `tini` (the Debian package) and starts `ENTRYPOINT ["/usr/bin/tini", "--", "marmeon"]` (E187): Node as
PID 1 reaps no orphaned process (it stayed a zombie) and the kernel drops a signal to PID 1 that has no handler yet. tini passes
SIGTERM on and ends with marmeon's exit code — 0 after the drain, 70 for a stuck job, as before. `compose.production.yaml` no
longer sets `init: true` and the docs no longer ask for `docker run --init` (with one, tini runs as its child and warns that it is
not PID 1). To take it over: `marmeon make:docker --force` (it rewrites the Docker files — keep your own changes), or add the
`apt-get install -y --no-install-recommends tini` line to the final stage, change the `ENTRYPOINT`, drop `init: true` — and
rebuild the image.

#### Low: pnpm 12.9.1

*Likelihood of impact: low.* New apps pin `pnpm@12.9.1` in `packageManager`, and `make:docker` installs that version when the
app names none (`TESTED_PNPM`). An app keeps the pnpm it pins; to follow: `pnpm self-update 12.9.1` (a standalone pnpm) or
`npm i -g pnpm@12.9.1`, then set `"packageManager": "pnpm@12.9.1"` and run `pnpm install` once (pnpm 12 records itself in the
lockfile).

#### Low: a new app's `<title>` is its name, not "Marmeon"

*Likelihood of impact: low — nothing to do.* `create-marmeon my-shop` writes `<title>My Shop</title>` into `index.html` (the
blank app's is a neutral `<title>App</title>`); before, every new app was titled "Marmeon" until a page set its own. An
existing app changes the `<title>` in its `index.html` by hand.

#### Low: the start warns when another program holds 127.0.0.1 at its port — and a taken port fails `startServer`

*Likelihood of impact: low — servers on every interface (no `HOST`, `::`, `0.0.0.0`), mostly on macOS.* macOS lets a server on every
interface listen beside a program that holds the same port on 127.0.0.1 only — requests to `127.0.0.1:<port>` then reach that program,
not the app (W9 step 2: `/up` answered 501). `marmeon start`/`dev` (and a cluster's primary, once) now look before listening and log a
warning: "Another program holds 127.0.0.1:<port> — … Set HOST … or another PORT." The start goes on (elsewhere it fails with
EADDRINUSE right after). Not looked at with `PORT=0` or a single interface in `HOST`. `startServer()` now rejects with Node's error
(`EADDRINUSE`, `EACCES`) when it cannot listen — before, the error was an uncaught exception; `marmeon start` reports both the same
way. No switch: set `HOST` (127.0.0.1 behind a proxy on the machine, 0.0.0.0 in a container) and the warning has nothing to say.

#### Low: a list in a GET's data is the key repeated

*Likelihood of impact: low — `visit`/`reload`/`useForm` GETs with a list in `data`.* `reload({ data: { role: ['admin', 'owner'] } })`
asks for `?role=admin&role=owner` — what a query schema reads as a list and what `toSearchParams`/`<Link query>` write. Before, the
list was joined with commas (`?role=admin%2Cowner`): one value, which a `v.array(…)` field read as a list of one. A server that
split the commas itself reads the repeated key now (`searchParams.getAll`, or a query schema). Where a server of your own needs
the old form, join the list yourself: `data: { role: roles.join(',') }`.

#### Low: `merge()` of a paginator appends its data, `matchOn` takes paths, merge marks no longer pile up

*Likelihood of impact: low.* `merge({ data, meta })` (a paginator) appends `data` and takes the new `meta` — before, a shallow merge
replaced `data`, so "load more" needed `deepMerge()`; `merge(page).matchOn('data.id')` is typed now. `matchOn('user.id')` matches
the items of a list by a path into them. A page's `mergeProps`/`deepMergeProps`/`matchPropsOn` are the latest answer's for the
props it brought — before, they collected every answer's (only the devtools showed it). `deepMerge()` lists keep working unchanged;
a paginator that should be replaced on "load more" is not `merge()`d at all.

#### Low: cursors are encrypted — `cursorPaginate` needs the `Encrypter`, an old cursor is a 400

*Likelihood of impact: low — apps that use `cursorPaginate`.* `meta.nextCursor` is now the last row's values encrypted and
authenticated with the app key, its own context per order (columns, direction) — a client can neither read a hidden sort column's
value from the URL nor make up a cursor (one of another list with the same order decrypts there, as a position among that list's
own rows). `cursorPaginate(query, { …, encrypter })` takes the `Encrypter` (inject it from
`@marmeon/encryption`; without it a type error); a cursor that does not decrypt — changed, of another order, of a key that
was rotated away, or **the base64url format before Wave 9** (bookmarked "load more" URLs) — answers **400** instead of the first
page. Also: the unique `key` (default `id`) is added as the last order by itself (`{ column: 'name' }` orders by `(name, id)`),
a nullable sort column orders `NULLS LAST` and a NULL is a cursor like any other (before: "load more" started over), and an
`orderBy` of the query is taken out (before it came first). There is no way back to readable cursors — they showed the values of
the sort columns, hidden ones included.

#### Low: queries on a shared connection take turns — a transaction's, a test's pinned one

*Likelihood of impact: low — nothing to do.* Inside `connections.transaction(…)` every query of the call chain shares the transaction's
connection, and under the test isolation every request shares the test's one — a `Promise.all` over a page's props or two requests of
a test sent `pg` a query while another was under way ("client.query() when the client is already executing a query", deprecated in
pg 8, an error in pg 9). The database driver now runs the queries of one connection one after the other, in the order they were sent
(a failed one passes the turn on; a stream holds it until it ends). Results and transactions are unchanged; the logged duration of a
query that waited includes its wait. No switch: it is what `pg` did internally, made explicit.

#### Low: a table's filter on a hidden column is hidden with it

*Likelihood of impact: low — tables whose filters read a column with `.visible(…)`.* A filter had only its own visibility: on a column
a user may not see (`email: column('users.email').visible(…)`, `filters: { domain: filter.select('users.email', …) }`) it was offered
and applied, and the number of rows it left told the hidden values. Now such a filter is hidden with its column for that request —
not in the props, and `?filter[domain]=…` is a 400, like a sort by a hidden column. The same column counts with or without its
table (`created_at`, `users.created_at`). No switch; a filter that should stay give a column of its own that the user may see.

#### Low: the guard cancels a Back where the browser lets it — and goes back by the browser's key

*Likelihood of impact: low — apps with a navigation guard (`useBlocker`, `useForm(…, { guard })`).* Back or Forward with unsaved
changes is now **cancelled** where the browser allows it — right after a click or a key press (a user activation), or from a script —
and the address bar never changes; before, the browser always moved and the guard moved back. Without an activation (a Back a while
after the last click, or the second of two quick Backs) the browser still moves first: the guard goes back to the entry it left by the
browser's key — right after a reload or a session restore too, where the old counted index could be off — and asks; Leave goes
again. Nothing to change: the question, its words and `beforeunload` are the same. There is no switch back to "move, then
undo" for a Back the browser lets the page cancel.

#### Low: `useRouter()` loads the page's optimistic patches on first use

*Likelihood of impact: low — pages that call `router.optimistic()` or `router.reloading()`.* The code of the page's optimistic patches
is no longer in the first download of every app with a router (W9 step 7, ≈ 0.6 KB gzip): it loads with the first
`router.optimistic()`/`reloading()` call, a chunk of its own. That first patch of a page shows a moment later — the time to fetch the
chunk — every later one at once; a chunk that cannot load shows no patch, and the action's reload ends without one (its answer still
lands). A test that asserts a patch synchronously after the first call awaits a tick. There is no switch to bundle the patches
statically again (they were ≈ 0.6 KB of every app's first download).

#### Low: the starter kit asks in the page's language — its own `Confirm`

*Likelihood of impact: low — apps created with the starter kit of 0.1.0.* A new starter kit has its own dialog (`bootstrap/confirm.tsx`,
`createMarmeonApp({ confirm: Confirm })`) with the app's words in `lang/en.ts` and `lang/de.ts` (namespace `app`): a link's or an
action's `confirm`, the question before unsaved changes are left — and tab sync's question when another tab signed in or out
(`reason: 'session'`), which was English before. An app of 0.1.0 copies the three files from a new kit (`pnpm create marmeon`)
and adds `confirm: Confirm` to `bootstrap/client.tsx` — or keeps the browser's own dialog.

#### Low: view transitions are opt-in — with `viewTransition: 'react'` a page change is a React transition

*Likelihood of impact: low — apps that turn view transitions on (W9 step 8, E185).* Nothing changes without the option: a page change
renders as the plain update it was. `viewTransition: true` (`createMarmeonApp`, a `<Link>`, a visit) wraps the swap of a page in
`document.startViewTransition` — the page is loaded first, its history entry and scroll follow once it is swapped in, and Back/Forward
carry the type `back`/`forward`; none under `prefers-reduced-motion: reduce` or in a hidden tab, none for a layer. With
`createMarmeonApp({ viewTransition: 'react' })` every page change renders in React's `startTransition` (with `addTransitionType`) so
the views' `<ViewTransition>` animate — and transition semantics apply: a page that suspends inside a Suspense boundary already on
screen keeps the old page until it is ready (instead of showing the fallback), React waits briefly for a new image inside a
`<ViewTransition>`, and a page change waits for an async action of React's under way. A custom adapter that starts transitions itself
passes `NavigatorOptions.viewTransition: 'adapter'` and renders `RenderOptions.transition` (the types) in its own; every other adapter
ignores it. A custom feature can take a page's swap (`host.on('swap', (run, how, keep) => …)`).

#### Low: a `reset()` in a submit's `onSuccess`/`onFinish` resets to the defaults before the submit — the saved form is not dirty

*Likelihood of impact: low — forms that reset fields after saving (`submit({ onFinish: () => form.reset('password') })`, `<Form
resetOnSuccess>`).* A saved form takes what was sent as its new defaults. The callbacks used to run against the defaults of before the
submit while the form had already taken the new ones: a reset field went back to its old value, differed from the new defaults, and
the form stayed dirty — the guard asked on leaving (and `beforeunload` too). Now the new defaults are taken after the callbacks ran:
what they reset (a password emptied) is where the form starts over, the rest is what was sent; not dirty. No switch — the old state
was a bug; a later `reset()` goes back to the saved state.

#### Low: a page that builds its reloads while rendering renders on the server again

*Likelihood of impact: low — pages that call `router.reloading(…)` or `router.optimistic(…)` in their body.* Since `useRouter()` loads
the optimistic patches on first use, such a page failed its server render with `[marmeon:R11]` (the browser then rendered it — the
web app's `/notifications`). On the server both now hand out a target nothing uses (actions run in the browser). Nothing to do.

#### Low: `marmeon dev` answers other origins without CORS headers

*Likelihood of impact: low — development only.* Vite's development server answered any page on `localhost`, `127.0.0.1` or `[::1]` — at
any port — with `Access-Control-Allow-Origin`, also on the app's own answers: a page of another local project could read the devtools'
API, mail previews or the error page. Vite runs with `cors: false` now. The app and its modules share one origin; nothing of the
framework needed it. No switch.

#### Low: an S3 temporary URL names the content type by the file name

*Likelihood of impact: low — S3 disks.* `temporaryUrl(key, …)` decided inline (raster images) or download by the file name, but the store
sent the type the object was stored with: an object stored as `text/html` under `avatar.png` was shown inline — as HTML, on the
bucket's origin. The presigned URL now carries the type of the file name too (`response-content-type`), as the local disk serves it.
No switch; a file that should keep its stored type gets a file name of that type.

#### Low: a private S3 disk that shares a prefix of one bucket with a public one fails the start

*Likelihood of impact: low — several S3 disks in one bucket.* The start refused a private local disk inside (or around) a public one;
now also a private S3 disk whose `root` nests with a public S3 disk's in the same bucket on the same endpoint (or either has none) —
the public disk's URLs (and the bucket policy that makes them public) would reach the private files. Give the disks separate
prefixes (`root`) or buckets.

#### Low: `verified()` treats a user without `email_verified_at` as unverified

*Likelihood of impact: low — custom user providers that select columns.* The middleware let through every user whose
`email_verified_at` was not `null` — also one whose provider did not load the column (`undefined`). It fails closed now: the notice page
(403 for JSON). Load the column with the user.

### Wave 10 — Marmeon: lean dependencies

#### Medium: the app validates with `rules` — `password()`, `pageQuery()`, `upload()` and a table's query are rules, `confirmed()` of @marmeon/auth is gone

*Likelihood of impact: medium — every app made from the starter or `make:auth`, and every app that uses one of these helpers.* The
starter, `make:auth`'s module, `make:*` and the docs write their schemas with `rules` of `@marmeon/validation` (E197), and the
framework's helpers are rules now — they go into `r.object()`/`r.query()`, no longer into a Valibot object:

```ts
// before                                                      // after — import { rules as r } from '@marmeon/validation'
import * as v from 'valibot';
schema: confirmed(v.object({ password: password(),             schema: r.object({ password: password(), password_confirmation: r.string() })
  password_confirmation: v.string() })),                         .confirmed('password'),
query: v.object({ ...pageQuery({ perPage: [25, 50] }), … })     query: r.query({ ...pageQuery({ perPage: [25, 50] }), … })
schema: v.object({ avatar: v.nullish(upload({ maxBytes })) })  schema: r.object({ avatar: upload({ maxBytes }).nullable() })
v.object({ ...MembersTable.query.entries, tab: … })            r.query({ ...MembersTable.query.entries, tab: … })
env: v.object({ APP_URL: v.pipe(v.string(), v.url()) })        env: r.env({ APP_URL: r.url() })
```

- **`password()`** (`@marmeon/auth`) is a rule; missing or not a string says "Enter a password." as before. **`confirmed()` of
  `@marmeon/auth` is gone**: the object's `.confirmed('password')` reports on `password_confirmation` once the password is valid, with
  `marmeon.validation.confirmed` — "The password confirmation does not match." (it compares the fields as typed; the old helper
  compared them after Unicode normalization). The old text "The passwords do not match." is no framework text any more: the starter
  has it as `auth.validation.passwords_differ` (`messages: { 'password_confirmation.confirmed': … }`). The framework key
  `marmeon.validation.confirmation` (W10 step 3) is now `marmeon.validation.confirmed`.
- **`pageQuery()`** (`@marmeon/database`) returns `page: r.integer().min(1).default(1)` and `per_page: r.in(sizes).default(first)` — the
  same fields and fallbacks.
- **`upload()`** (`@marmeon/storage`) is `r.value()` with its limits as a mark (`uploadRuleOf()` reads it): `upload(…).nullable()` for an
  optional file; a missing field says "Choose a file.". It no longer fits into a Valibot object, and `UploadSchema` is the rule's type.
- **A table's `query`** is an object rule; its `entries` are rules (spread them into `r.query()`). An empty value (`?sort=`) is still a 400.
- **Messages:** a rule's own message (`custom()`, `regex()`, `unique({ message })`) may be `trans()`'s or `translatable()`'s function;
  a key given in a request's `messages` gets the rule's parameters — `{min}`, `{max}` — where Valibot's `trans()` had `{requirement}`:
  rename the placeholder in the app's language files.
- **The registration of `make:auth` asks no database in its schema** (E197): with `AUTH_PRIVATE_REGISTRATION=false` a taken address is
  still a field error on submit (the unique index decides), but **no longer when the field is checked live** — a live check of a taken
  and of a free address gets the same answer. To keep the live answer, add the check yourself:
  `email.custom(async (address, { request }) => !(await request!.resolve(UserRepository).emailTaken(address)) || 'auth.validation.email_taken').live()`
  — knowing that it tells anyone who types an address whether it has an account.
- `r.integer()`/`r.number()` take a number's spelling too (`'7'`): a job's `JobInput` (what `dispatch()` and `assertDispatched()` take)
  is ``number | `${number}` ``, `JobPayload` (what `handle()` gets) a number.
- An app drops `valibot` from its `package.json` and adds `@marmeon/validation` (`pnpm add @marmeon/validation && pnpm remove valibot`);
  `check:source` keeps it out of this repository's apps, stubs and templates.

The way back: Valibot, Zod or any Standard Schema library still works wherever a rule does — install it yourself and pass its schemas;
only the helpers above are rules now (`password()` inside a Valibot object: wrap the object in `r.object()` instead, or check the
password with Valibot).

#### Medium: `queue:work` takes every queue, fairly — a `--queue` list keeps its strict order

*Likelihood of impact: medium — apps with more than one queue, and every app with `make:auth` (its mails go to `mail`).* A worker
without `--queue` took only the connection's queue (`default`): the auth module's mails waited unless the worker was started with
`--queue=mail,default` — and even then they waited behind a full `default` queue, because a list is a strict priority. Now a worker
without `--queue` takes **every queue, fairly** (E199): the `database` driver the oldest due job of all queues in one statement
(an expired claim first), `redis` the queues in turn. `--queue=*` alone means the same; `--queue=mail,default` still narrows a
worker down to these queues in strict order (Laravel's), and `*` in a list stands for every queue it does not name
(`--queue=mail,*`). `marmeon dev`, `make:docker`'s compose file and systemd unit, the starter's README and `make:auth`'s hint start
the worker without `--queue`.

```text
# before                                              # after
marmeon queue:work                  # only default    marmeon queue:work                  # every queue, oldest due job first
marmeon queue:work --queue=mail,default               marmeon queue:work --queue=mail,default   # unchanged: these two, strictly
marmeon queue:work --queue=*        # alphabetically  marmeon queue:work --queue=*        # = no --queue
```

- **The `jobs` table gets a second index**, `(reserved_at, available_at, id)` — the fair claim walks it (EXPLAIN on SQLite and
  Postgres, 200 000 jobs: 0.01 / 0.06 ms instead of a sort of every due job). `make:queue-table`'s migration has it; an app with
  the table already adds a migration: `schema.alter('jobs', (table) => table.index(['reserved_at', 'available_at', 'id']))`.
- The worker's start line says `every queue (oldest first)` (database) or `every queue (in turn)` (Redis). The warning about a queue
  nobody takes comes only from a worker with a `--queue` list without `*`. `--queue=` with no name, or `*` twice, is an error.
- A driver of your own: `reserveAny(except)` is the new, optional claim of `QueueDriver`; without it the worker goes round
  `queues()` with `reserve`. `WorkOptions.queues` is optional (missing = every queue), and `QueueFake#work()` without `queues`
  runs the due jobs oldest first instead of queue by queue.

The way back: name the queues in the order you want them — `--queue=default,mail` is the strict order of before, `--queue=default`
the old default. A priority without starving the rest: two workers, one without `--queue` and one with `--queue=mail`.

#### Medium: the framework's look is a stylesheet — import `@marmeon/react/styles.css`, `LayerDialog`'s `style` arrives after the mount

*Likelihood of impact: medium — every app that shows layers, `ConfirmDialog`, the failure dialogs or the built-in error page, and every
app with `make:auth`.* The framework gave its components their default look as inline `style` props — `LayerDialog`, `ConfirmDialog`,
the dialogs of a failed visit, the built-in error page and `make:auth`'s layouts. Rendered on the server (a deep link to a layer, a
404, a sign-in page) they became `style` attributes, which a strict Content-Security-Policy (`style-src` without `'unsafe-inline'`)
blocks — a nonce does not cover attributes, and React does not add a blocked attribute while it hydrates (E202). Now they render
classes, and the look is a stylesheet of the app's origin: `@marmeon/react/styles.css`. Import it once in the client entry —
`marmeon build` puts it into the stylesheet the built `index.html` links:

```ts
// bootstrap/client.tsx — after
import { createMarmeonApp, progressBar } from '@marmeon/react';
import '@marmeon/react/styles.css';        // the framework's look
import '../modules/auth/auth.css';         // make:auth's module, if the app has it (make:auth adds the line)
```

- **Without the import the components are unstyled** — a layer is a plain dialog, the notice of an unreachable server no longer
  floats over the page. Apps from `create-marmeon` have it; for an existing app add the line.
- **`LayerDialog`'s `style` prop** is written through the CSSOM once the dialog is mounted — never a server-rendered attribute; a deep
  link shows the frame without it until it hydrates. A value that must be there at once belongs in a class of the app's stylesheet
  (`className`). `ConfirmDialog`'s `style` renders in the browser only, as before.
- **The classes** (each rule in `:where()`, so any class of the app overrides it): `marmeon-layer`, `marmeon-layer--modal`/`--slideover`,
  `marmeon-layer__content`, `marmeon-layer__close`; `marmeon-confirm` (`__title`, `__field`, `__actions`); `marmeon-failure--network`,
  `marmeon-failure--server`, `marmeon-failure__frame`; `marmeon-error` (`__status`, `__title`, `__exception`). The failure colours keep
  their CSS variables (`--marmeon-failure-background`, `-color`, `-dialog-background`, `-dialog-color`), now read by the stylesheet.
- **`make:auth`** writes `modules/auth/auth.css` (`auth-header`, `auth-settings`, `auth-settings-nav`, `auth-settings-page`,
  `auth-choice`) and imports it in `bootstrap/client.tsx` (or names the line). A module made before keeps its inline styles until you
  take the stubs' layouts over.
- Under `marmeon dev`, Vite adds a stylesheet the client entry imports as a `<style>` element with the response's nonce once the
  entry runs — a server-rendered layer shows unstyled until then (a build links it in the document). A policy that limits `style-src`
  in development too names the nonce: `contentSecurityPolicy({ styleSrc: ["'self'", NONCE] })` (what the web app does). The devtools'
  bar brings its look as a constructed stylesheet of its shadow root now — before, its `<style>` element without the nonce was refused.
- `pnpm csp:probe --app <dir> --build` (this repository) starts a built app in headless Chrome under an added `style-src 'self'` and
  counts the violations — deep link and click on a layer, the failure dialogs, the signed-in pages.

The way back: none needed. An app that styled `[data-marmeon-layer]` itself can leave the import out and keep its rules — set what it
took from the old inline defaults.

#### Medium: accounts without a confirmed address are deleted after 7 days — `AUTH_UNVERIFIED_DAYS`, `auth:prune-unverified`

*Likelihood of impact: medium — every app with the module of `make:auth`, above all one with `AUTH_PRIVATE_REGISTRATION=false`.* An
account whose address was never confirmed stayed forever: whoever signed up with somebody else's address kept holding it (a
"pre-hijacked" account), and the data of sign-ups nobody finished stayed too. Now the module deletes them (E203): its command
`auth:prune-unverified`, scheduled nightly at 03:20 (`onOneServer()`), deletes every account that **never** confirmed an address
(`email_verified_at` and the new `first_verified_at` null) and was made more than `AUTH_UNVERIFIED_DAYS` ago (default **7**; only
whole numbers boot) — through the module's new
`AccountDeletion`: the row (remember-me and API tokens cascade), its reset token, what other modules keep (they listen to
`AccountDeleted`, in the same transaction) and its sessions (`UserSessions` of `@marmeon/session`: removed from the `database` store,
ended at their next request with the others), in batches of 100, the number in the log. **Irreversible.** An account that was
confirmed once never goes — `users.first_verified_at` keeps the first confirmation for good (the verification link sets it), so a
pending change (private registration) or an unconfirmed new address (`AUTH_PRIVATE_REGISTRATION=false`) leaves it alone.

```ts
// modules/auth/schedule.ts — new line            // modules/auth/index.ts — new
s.command('auth:prune-unverified').daily().at('03:20').onOneServer();      commands: [PruneUnverifiedCommand],
```

- **With `AUTH_PRIVATE_REGISTRATION=false`** a new account is signed in at once and may have used the app for days before it goes,
  if it never clicks its link. Tell your users in the verification mail, or raise the days.
- **A new column, `users.first_verified_at`** (migration `0001_01_01_000005_add_first_verified_at_to_users_table.ts`): it fills
  itself from `email_verified_at` for every account confirmed before; `markEmailVerified` (and the confirmed change of address) set
  it with `coalesce(first_verified_at, now)`. A factory or seeder of your own that makes confirmed users sets it too.
- An app made with `make:auth` before: copy the migration, `AccountDeletion.ts`, `commands/PruneUnverifiedCommand.ts`, the methods
  `unconfirmedSince`/`deleteAccounts` and the new `markEmailVerified` of `UserRepository.ts`, the factory, the schedule line and
  `commands` from the stubs
  (`packages/auth/stubs/react/modules/auth/`), or run `marmeon make:auth --force` on a clean tree and merge. Without them nothing is
  deleted.
- New API: `UserSessions` (`end(userId)`) and the optional `SessionStore#destroyUser(userId)` (the `database` store has it), and
  `Inbox#deleteAll(recipient)` of `@marmeon/notifications`.

The way back: `AUTH_UNVERIFIED_DAYS=0` keeps every account (outside development and tests the boot says so once), or a larger number
of days.

#### Low: `redis` comes with `@marmeon/redis`, `nodemailer` with `@marmeon/mail` — install messages name the major

*Likelihood of impact: low — apps on a Redis driver or on SMTP, and code that imported `RedisSetupError`.* The driver rule (E198,
[CONTRIBUTING](CONTRIBUTING.md#dependencies-of-drivers)): a package that wraps exactly one driver brings it. `@marmeon/redis` depends
on `redis` (node-redis `^6.2.1`, before an optional peer `^5 || ^6`), and `@marmeon/mail` on `nodemailer` (`^10`, the decided
exception: no dependencies of its own, the production path). Before: `pnpm add @marmeon/redis redis`, and `pnpm add nodemailer` for
`MAIL_MAILER=smtp`; after: `pnpm add @marmeon/redis`, and nothing for SMTP. The app's own `redis`/`nodemailer` entries can go unless
its code imports them — kept, they do no harm (the same major is one copy); node-redis 5 is no longer what the framework talks to.
Gone with the missing client: `RedisSetupError`, `REDIS_INSTALL`, `loadRedisClient`, the type `ImportRedisClient` and the
`importClient` option of `RedisConnections`. A starter-kit install grows by `nodemailer` (≈ 1.9 MB, one package).

The drivers that stay optional peers — the AWS SDK (`@marmeon/storage`), `mjml` (`@marmeon/mail`), `pg` (`@marmeon/database`) — and
the shared peers `@opentelemetry/api` and `vite` are named with the tested major: `pnpm add @aws-sdk/client-s3@^3
@aws-sdk/s3-request-presigner@^3`, `pnpm add @aws-sdk/s3-presigned-post@^3`, `pnpm add mjml@^5`, `pnpm add pg@^8`,
`pnpm add @opentelemetry/api@^1`, `pnpm add -D vite@^8 @marmeon/vite`. A default disk or `UPLOADS_DISK` on S3 without the SDK now fails
the start (it failed the first use); an S3 disk the app only names still says it on first use. A broken install of `mjml` or `pg`
shows its own error instead of "install it". There is no old behaviour to keep.

#### Low: `@marmeon/validation` — Laravel's rules, typed; Standard Schema stays the contract

*Likelihood of impact: low — nothing has to change; apps whose schemas build messages with `translatable()`/`trans()`.* A new package
(E197): `import { rules as r } from '@marmeon/validation'` builds request, query and config schemas with Laravel's names —
`r.string().trim().required().max(255)`, `r.query({ page: r.integer().min(1).default(1) })`, `r.env({ APP_PORT: r.port().default(3960) })` —
with messages in the request's language (`marmeon.validation.*`, English and German in `@marmeon/i18n`), the first problem of a field
only, and `unique`/`exists` that get their repository from the request and **never run in a live validation** unless the rule says
`.live()`. Valibot is its internal engine — a dependency, never re-exported; the app installs nothing for it. `failOnDuplicate()` of
`@marmeon/database` turns a conflict on a unique index into the same 422 at the field. Valibot, Zod or any other Standard Schema library
keeps working everywhere (the stubs, templates and helpers moved to `rules` — the Medium entry above).

What changes for every app, quietly: `validateRequest` hands each schema `libraryOptions: { marmeon: { resolve, ctx, live } }` (other
libraries ignore it); `defineRequest` takes `messages` and `attributes` (Laravel's `messages()`/`attributes()`); a message made with
`translatable()`/`trans()` may name its field with `{attribute}` (the path with underscores as spaces, or the request's `attributes`);
a live validation drops an issue a rule marked as not live. The Standard Schema interface lives in `@marmeon/core` only — the router
re-exports the same types (`@marmeon/router` now depends on `@marmeon/core`, types only). There is no old behaviour to keep.

#### Low: staging takes the production branches of the browser code and of server rendering — short codes, no development warnings

*Likelihood of impact: low — apps on a staging server (`NODE_ENV=staging`) or built with one.* The client core, the React adapter,
the table's client and server rendering asked `process.env.NODE_ENV !== 'production'` for their explanations, warnings, devtools
hooks and error details — so `NODE_ENV=staging` (and any other value) took the development branch wherever the value is read at run
time: in server rendering always, in the browser when `marmeon build` ran with `NODE_ENV=staging`. They ask positively now (E201):
`process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'`. On staging an error says its code (`[marmeon:R2] users/Show`
instead of the explanation), the late-`<Head>` warning and the hydration notice on the page are gone, the devtools hook is never
called, and a React error page rendered on the server shows no exception message. Development and tests are unchanged; a production
client bundle is byte for byte the same. Two things stay as they were and are worth knowing: React renders with **its** development
build wherever `NODE_ENV` is not `production` (server rendering on staging; the browser too after a `NODE_ENV=staging` build), and
that build sends the message and stack of an error thrown after the shell into the page — see [deployment](docs/deployment.md#configuration). Code of your own that does the same check: `pnpm check:source` refuses
`!== 'production'` in this repository's packages; an app's code is its own.

The way back: none needed — to read a full message on staging, run the app with `NODE_ENV=development` on a machine of your own.

#### Low: the mail previews answer only `localhost` and the host of `APP_URL` — the devtools' host check moved to `@marmeon/core/dev`

*Likelihood of impact: low — developers who open `/_marmeon/mail` through another host name, and code that imported `allowedHosts`,
`LOOPBACK_HOSTS` or `hostAllowed` from `@marmeon/devtools`.* The mail previews (development only) had no host check: behind a DNS
rebinding a page on another site could read them — Vite's own host check is skipped under HTTPS. They now sit behind the same guard
as the devtools (E200): `localhost`, `127.0.0.1`, `[::1]` and the host of `APP_URL` get the page, any other `Host` a 403; every
answer is `no-store`, `nosniff`, `Cross-Origin-Resource-Policy`/`-Opener-Policy: same-origin`, without CORS headers. The guard lives
in `@marmeon/core/dev`: `devHosts(appUrl)` (before `allowedHosts` of `@marmeon/devtools`), `hostAllowed(request, hosts)`,
`LOOPBACK_HOSTS`, and `devOnly(hosts, handler)` for a development route of your own; `@marmeon/devtools` no longer exports them.

```ts
// before                                                   // after
import { allowedHosts, hostAllowed } from '@marmeon/devtools';   import { devHosts, devOnly, hostAllowed } from '@marmeon/core/dev';
const hosts = allowedHosts(env.APP_URL);                    const hosts = devHosts(env.APP_URL);
                                                            Route.get('/_dev/report', devOnly(hosts, () => report()));
```

The way back: open the previews through `localhost` or set `APP_URL` to the host you use.

#### Low: what a failure shows loads when it happens — the dialog of a 5xx and the error pages are a chunk of their own

*Likelihood of impact: low — apps that count on the error dialog appearing in the same tick, and tests that look for it at once.*
The dialog with the server's error page (a 5xx answer to a visit), the app's error page for a page that threw while rendering and the
built-in `errors/Error` are a chunk of their own (E202, like the layers, E71): `<MarmeonApp>` loads it when the failure happens — about
0.4 KB gzip less in every first download. The error boundary and the notice of an unreachable server stay in the first download (offline,
no chunk loads). If the chunk cannot load either, a 5xx shows that notice and a page that threw shows nothing in its place — never an
error of its own. A test that looks for `dialog[data-marmeon-failure="server"]` right after the visit waits a tick for it (`findBy…`,
a settle). The way back: none needed.

#### Low: a session draws its CSRF token when something needs it — a guest's request makes none

*Likelihood of impact: low — code that reads `session.currentToken()`, and custom middleware that expects every session to have a
`_token`.* `Session.start()` made a token for every new session — 30 random bytes per guest request, thrown away with the session
that was never kept (E143). Now the token is made on demand (E203): the first `session.token()`, a page of a kept session
(`page.csrf`) or the `XSRF-TOKEN` cookie of a kept session makes it, once; signing in and out (`regenerate()`, `invalidate()`) renew
it at once, as before. The check is unchanged: a post that needs the token and has none is a 419. `currentToken()` (internal) is
`string | undefined` now — `undefined` for a session that never needed one. An island resolved in-process gives its page's token;
one that reads a session without a token gives none (never one it made and cannot save). The way back: none needed — call
`session.token()` where you need the token.

#### Low: a caller's `traceparent` is a link of the request's span — `OTEL_TRUST_TRACEPARENT=true` continues its trace

*Likelihood of impact: low — apps with `@marmeon/otel` whose traces span services.* A request's server span continued the trace of
any `traceparent` header — so a client chose the trace its requests landed in, and its sampled flag decided whether they were
recorded at all (`-00` turned tracing off for it, `-01` on past your sampler). Now every request from outside starts a trace of its
own (your sampler decides) and a valid incoming `traceparent` is a **span link** (decided by Max, 07.10.): the caller's context stays
findable, nothing of it is taken — its baggage neither. In-process requests (islands, a layer's base) stay children of their page's,
a job continues the trace of its dispatch (E131).

```sh
OTEL_TRUST_TRACEPARENT=true   # behind an edge (gateway, ingress, mesh) that sets or strips the header — or for an internal service
```

A trusted proxy (`TRUSTED_PROXIES`) is no such edge by itself: it usually passes the client's header on unchanged. A hand-made setup
passes `instrument(app, api, { trustTraceparent: true })`. The way back: `OTEL_TRUST_TRACEPARENT=true`.

#### Low: a `URL` in a log context is masked like text — its query token and token-like path segments

*Likelihood of impact: low — log readers who searched for whole URLs logged as objects.* `logger.info('…', { link: new URL(…) })`
wrote the URL as it was (its `toJSON`): a `?token=…` or `/reset-password/<token>` reached the log. Now `redact()` masks a `URL` and
`URLSearchParams` like text (`token=[redacted]`, `/reset-password/[redacted]`), and the `Redactor` (devtools, error page, spans)
shows a `URL` through `url()` instead of an empty object. The way back: none needed — log `url.pathname` or a field you choose.

#### Low: `uploads:prune --hours` below `UPLOADS_LIFETIME` needs `--force`

*Likelihood of impact: low — scripts that call `uploads:prune --hours=0` (or below the token lifetime).* `--hours=0` deleted every
temporary upload — also those whose token still worked (a form still open lost its file). Now `--hours` below `UPLOADS_LIFETIME`
(default 120 minutes) stops with the reason and exit code 1; `--force` deletes them anyway. The scheduled `uploads:prune` (24 hours)
is not affected. The way back: add `--force`.

#### Low: a table's and an inbox's cursors belong to their list — `name` in `CursorOptions`

*Likelihood of impact: low — cursors kept in URLs across the upgrade.* An encrypted cursor was bound to its order (columns,
direction) only: one of another list with the same order decrypted — as a position among this list's rows. `cursorPaginate` takes
an optional `name` now, part of the cursor's context: a table passes its name, an inbox its recipient — another table's or another
recipient's cursor is a 400 (`InvalidCursorError`). A cursor of a table or an inbox from before the upgrade is a 400 once ("load more"
starts again from the first page). Unnamed lists are unchanged. The way back: none needed — name your own lists
(`name: 'articles'`) to get the same.

## Upgrading to 0.1.0 from the development snapshots

0.1.0 is the first release. An app made from it (`pnpm create marmeon`) has nothing to upgrade. This section is for apps
that followed the repository during its development waves: the changes of Wave 8 (ship-ready) first, then those of Wave 7
(devtools and observability) and Wave 6 (background services) — an app that followed until a wave reads from that wave
upwards.

*Estimated upgrade time:* about an hour for an app from Wave 7 — the High entries of Wave 8 (`marmeon` as a
dependency, the sessions table) and the Medium ones its features touch; half a day from Wave 6 or with a `SessionStore` of its
own. The first day after a release pnpm may hold the new versions back (`minimumReleaseAge`) — see
[the first day after a release](docs/versioning.md#the-first-day-after-a-release).

### Wave 8 — ship-ready

#### High: `marmeon` is a dependency of the app

*Likelihood of impact: high — every app.* `marmeon start`, `queue:work`, `schedule:work` and `migrate` run on the server, and a
production install (`pnpm install --prod`, a Docker image) leaves dev dependencies out — there was no `node_modules/.bin/marmeon`
(E159). Move it: `pnpm add marmeon` (pnpm moves it from `devDependencies` to `dependencies`). The same holds for what
`NODE_OPTIONS='--import ./bootstrap/telemetry.ts'` loads in production — the OpenTelemetry SDK packages of
[@marmeon/otel](packages/otel/README.md) belong in `dependencies`. `marmeon make:auth` names a runtime package it finds only
among the dev dependencies.

#### High: session keys are hashed — every user is signed out once; a `database` sessions table needs its upgrade migration

*Likelihood of impact: high — every app with sessions (once, at the deployment).* The stores keep a session under the SHA-256 of
its id now, never the id (E144): a leaked backup, replica or Redis yields no cookie that works. Sessions stored before are not
found any more — **every user is signed out once** (remember-me cookies sign them back in where the app has them). With
`SESSION_DRIVER=database` the `sessions` table also needs a `version` column (writes compare it, E145): run
`marmeon make:session-table --upgrade` and `marmeon migrate` before the new code serves requests — the migration makes the table
anew (its rows are keyed by raw ids, which nothing should keep). Without it every request fails with "The sessions table has no
version column … Run `marmeon make:session-table --upgrade`". New apps get the new table from `marmeon make:session-table`. The
`file` driver's old files (named by raw ids) and Redis' old `session:<id>` keys are no longer read; they go with
`session:prune` (files, by age) and their own TTL (Redis) — delete them right away if you like. There is no way to keep the old
keys.

#### Medium: protections apply to every `NODE_ENV` but `development` and `test` — staging and a missing `NODE_ENV` included

*Likelihood of impact: medium — apps that deploy with `NODE_ENV=staging`, another custom value, or none at all.* Before, a
protection checked for `NODE_ENV=production`; now it is fail-closed (E139, E164): wherever `NODE_ENV` is not `development` or
`test` the app is protected like production —

- `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:fresh` and `db:seed` refuse without `--force` (a deployment script
  without `NODE_ENV` must pass it now): `The application is protected (staging (protected)). Pass --force to migrate.`;
- logs are JSON unless `LOG_FORMAT=pretty` — also in tests and in a worker started without `NODE_ENV`; pretty lines are the
  default with `NODE_ENV=development` only;
- a write in a read-only request (an island's) is dropped and logged instead of thrown;
- `MAIL_MAILER=log` (or unset) warns at boot; `DEVTOOLS_ENABLED=true` fails the start; `tinker` shows the red banner
  (`PROTECTED (staging) — …`).

This includes commands typed on a development machine without any `NODE_ENV`: outside `marmeon dev` (which sets `development`
itself) `marmeon migrate` asks for `--force` and writes no table types — put `NODE_ENV=development` into the app's `.env` (next
entry) or the shell.
The development tools still run with `NODE_ENV=development` only (E115). To keep pretty logs in staging: `LOG_FORMAT=pretty`.
Code of your own checks `environment.isProtected()` / `environment.isDevelopment()` from `@marmeon/core`
([The environment](packages/core/README.md#the-environment-node_env)) instead of comparing with `'production'`.

#### Medium: `NODE_ENV` falls back to the app's `.env`

*Likelihood of impact: medium — every app (do it once on each development machine; check every server).* `NODE_ENV` is resolved
once per process (E170): the environment's value wins; else the one in the app's `.env` (only the base file — a `NODE_ENV` in
`.env.{NODE_ENV}` is ignored with a warning); else none, which is protected (`marmeon start` then sets `production`). Config
definitions, the CLI and the server read the same resolved value now (before, a `.env` `NODE_ENV` reached config definitions only).
On a development machine add `NODE_ENV=development` to `.env` (the `.env.example` files of the starters carry it). **On servers**
set `NODE_ENV` in the real environment and never deploy a development `.env`: a `marmeon start`, `queue:work` or `schedule:work`
that runs as development because of `.env` says so loudly in its log, and its start line names the source
(`development (from .env)`) — it is not refused.

#### Medium: `marmeon start` respects `NODE_ENV`

*Likelihood of impact: medium — apps started with a `NODE_ENV` other than `production`.* `marmeon start` set
`NODE_ENV=production` whatever the environment said; now it sets it only when `NODE_ENV` is missing — `NODE_ENV=staging marmeon
start` runs as staging, protected like production (above). The start line names the environment:
`Marmeon in staging (protected) on http://localhost:3000 (the build; …)` instead of `Marmeon [production] on …` — adjust
a log alert that matched the old line. The old behaviour: `NODE_ENV=production marmeon start`.

#### Medium: `migrate` writes the table types with `NODE_ENV=development` only

*Likelihood of impact: medium — workflows that ran `marmeon migrate` without `NODE_ENV` or in tests and committed the result.*
`migrate` and `migrate:fresh` regenerated `bootstrap/database.d.ts` with any `NODE_ENV` but `production` — on a staging box that
wrote into the app directory. Now only in development (E164). Elsewhere run `marmeon db:types` (it writes the file from the
migrations alone) or migrate with `NODE_ENV=development`.

#### Medium: cookies are `Secure` when `APP_URL` is `https://` — every cookie of the request

*Likelihood of impact: medium — apps whose `APP_URL` is `https://…` but that are reached over plain HTTP somewhere (a local
`.env` copied from production, a health check over `http://`).* `SESSION_SECURE_COOKIE` defaulted to `false` — in production too.
Now it follows `APP_URL` when unset (E162): `https://` → `Secure`, `http://` → not; `true`/`false` still decide. It applies to
every cookie the app sets without saying (`CookieDefaults`, bound by `@marmeon/session`, Laravel's cookie jar defaults): the
session's, `XSRF-TOKEN`, the remember-me token, the reset link's, the `cookie` driver's and an app's own `ctx.cookies.set(…)`.
A browser never sends a `Secure` cookie over plain HTTP — a staging server reached as `http://` with `APP_URL=https://…` loses
its sessions. Set `APP_URL` to the address users open, or `SESSION_SECURE_COOKIE=false` (warned about at boot), or a single
cookie's `{ secure: false }`. A protected environment whose cookies go without `Secure` logs one warning at boot ("Cookies are
sent without Secure: APP_URL is not https:// — …").

#### Medium: behind `TRUSTED_PROXIES`, `X-Forwarded-Proto` and `-Host` set the request's URL; ranges are allowed, typos fail the start

*Likelihood of impact: medium — apps behind a reverse proxy or load balancer.* Before, `TRUSTED_PROXIES` only decided whose
`X-Forwarded-For` sets `ctx.ip`, and only by exact address. Now (E162) it takes CIDR ranges (`10.0.0.0/8`, `fd00::/8`), and from a
trusted peer `X-Forwarded-Proto` (`http`/`https`) and `X-Forwarded-Host` replace the protocol and host of `ctx.request.url` — the
CSRF origin check, an island's origin and the asset version's reload URL see the address the client used. An entry that is no
address, range or `*` (`proxy.internal`) fails the start: `server: TRUSTED_PROXIES — Expected addresses or ranges like
10.0.0.0/8, or *: proxy.internal is not one`. Without `TRUSTED_PROXIES` nothing changes: every `X-Forwarded-*` is ignored. Make
sure the proxy **sets** these headers ([Behind a proxy](packages/server/README.md#behind-a-proxy-e162)).

#### Medium: CSRF — the browser's word first; a request from another site is 403, not 419

*Likelihood of impact: medium — apps with clients that post to `web` routes without a browser, tests with `csrf: true`, and code
that looks for 419.* `VerifyCsrfToken` decides in stages now (E143, Laravel 13's model, [CSRF protection](packages/session/README.md#csrf-protection)):
`Sec-Fetch-Site: same-origin` passes without a token; `same-site`/`cross-site` is refused with **403** unless its `Origin` is in
`CSRF_TRUSTED_ORIGINS`; without Fetch Metadata the `Origin` decides (the app's own — the one the request reaches it at, or
`APP_URL`'s — passes, any other is 403); only a request with neither header needs the session's token (419 without it, as
before). Before, every request needed the token, and a foreign origin answered 419.

- A script or a native client that posts to `web` routes sends its session's token (`X-XSRF-TOKEN`) or an `Origin` the app accepts.
- Tests with `createTestApp(App, { csrf: true })` send what a browser sends — `headers: { 'sec-fetch-site': 'same-origin' }` — or
  the token of a session they have; a test for a refused cross-site request expects 403.
- Over plain HTTP (a staging host without TLS) browsers send no Fetch Metadata: the `Origin` decides there.

There is no switch back: what passes without a token now is what the browser itself says comes from the app — a token adds nothing to that.

#### Medium: a guest's page starts no session — `page.csrf` and `XSRF-TOKEN` only with a session

*Likelihood of impact: medium — apps whose guest pages put `session.token()` into their props, or let guests upload files or
follow live channels.* A page handed every visitor the session's token (`PageObject.csrf`), which kept a session — a row, a file,
a Redis key and a cookie for every visit of the login page, bots included. Now (E143) a page carries `csrf` only when there is a
session anyway; a guest's forms pass by the browser's word (above). A session starts when something is written: a sign-in, flash
data, the errors of a failed form, `session.put()`.

- Views that rendered `<input name="_token" value={csrfToken}>` from a controller's `session.token()` keep working — but that
  call keeps a session for every visitor. Drop the field (what `marmeon make:auth` writes now: a plain form post passes by Fetch
  Metadata or `Origin`), or render `usePage().csrf` only when it is there (`<Form>` does that by itself).
- A guest's page with an upload field calls `session.persist()` in its controller: an upload belongs to a session, and an upload
  request (read-only, W6.9) cannot start one. A page that signs a live channel keeps the session by itself.
- `PageSession.scope()` is `undefined` without a kept session (it was a hash of an id nobody would see again); a live stream
  without a session answers 401 (was 403).
- New on `Session`: `persist()` (keep a session nothing was written to, because something is bound to it) and `exists` (a
  read-only request — an upload, a stream, an island — asks whether the session it read is a stored one).

#### Medium: a session written by two requests at once is merged, not overwritten — and custom stores compare versions

*Likelihood of impact: medium — apps with a `SessionStore` of their own; low for the others (behaviour gets better).* Before, a
loaded session was written back whole (`writeIfExists`) and the later of two requests won with its copy — a flash message one
request showed could come back with a prefetch's copy (W5b.7), messages of parallel requests were lost. Now every write compares
the version it read (E145): on a conflict the session is read again and this request's changes are applied — what it changed wins
key by key, flash messages are merged by id ([Hashed keys, versions and encryption](packages/session/README.md#hashed-keys-versions-and-encryption-e144-e145)).
A request whose session keeps being written by others for 2 s saves nothing and logs a warning; read-modify-write
routes declare `block()` (next entries). **The store contract changed** — before → after:

```ts
read(id): Promise<SessionPayload | undefined>                     →  read(key): Promise<{ data: string; version: number } | undefined>
write(id, data, lifetime): Promise<void>                          →  write(key, data, { expectedVersion, lifetimeSeconds, userId }):
writeIfExists(id, data, lifetime): Promise<boolean>                    Promise<'written' | 'conflict' | 'gone'>
```

`key` is the SHA-256 of the session id (hex), `data` text the store keeps as it is (JSON, or ciphertext with `SESSION_ENCRYPT`);
`expectedVersion: undefined` writes a new key, a number writes over that version — in one atomic step
([Your own store](packages/session/README.md#your-own-store)). `Session`'s constructor takes the `SessionCodec` as a third
argument (the container passes it); code that builds a `Session` by hand passes `plainSessionCodec`. Test code that read a store
by the session id reads `store.read(sessionKey(id))` and parses `data`.

#### Medium: the tabs of a browser follow each other's sign-in, sign-out and language — `createMarmeonApp` loads tab sync

*Likelihood of impact: medium — apps that sign in or out, or switch the language; nothing to do unless you want the old
behaviour.* Before, a tab kept what it showed (pages in memory, islands, pages fetched ahead, once props, remembered input) after
another tab signed out, until its own next request (E66). Now (E148, E149) `createMarmeonApp` loads the `tabSync` feature with the
first page: every page object carries the session's epoch (`PageObject.epoch`, opaque), the tabs post it on a `BroadcastChannel`
(`{ v: 1, epoch }`, nothing else), and a tab that hears another one — or becomes visible again, or comes back from the
back/forward cache — asks `GET /_marmeon/session`; if the epoch there is new, it lets go of everything and loads again. With
unsaved changes on screen it asks first (a `leave` question with `reason: 'session'` — word it in your confirm dialog; the
default text is English). Back/Forward to an entry of an older epoch loads it from the server
([Tab sync](packages/http/README.md#tab-sync-w8-step-8)).

- The old behaviour: `createMarmeonApp({ …, tabSync: false })` — then the risk E66 is back: a tab shows what it kept after a
  sign-out elsewhere until its next request.
- An adapter of your own attaches it from the start: `new Navigator({ …, features: [await loadTabSync()] })`.
- The path `/_marmeon/session` is the framework's now (in the `web` group, read-only).
- Code that writes `history.state` itself keeps the registered `epoch` field (as it keeps the navigator's other fields); a hook of
  your own on a new epoch: `navigator.use(tabSync).on('epoch', …)`.

#### Medium: signing out clears the site's storage too — `Clear-Site-Data: "cache", "storage"`; `clear({ siteCache })` is `clear({ siteData })`

*Likelihood of impact: medium — apps that keep something in `localStorage`, `sessionStorage` or IndexedDB, or call
`ClientHistory.clear({ siteCache: true })`.* `Auth.logout()` asked for `Clear-Site-Data: "cache"`; now (E165) it asks for
`"cache", "storage"`: the browser drops the site's HTTP cache **and its storage** — local and session storage, IndexedDB, service
workers — in every tab. What a signed-in user left there does not wait for the next one. Before → after:

```ts
history.clear({ siteCache: true })   →  history.clear({ siteData: true })      // "cache", "storage"
                                         history.clear({ siteData: ['cache'] }) // the cache alone (the web app's language switch)
                                         history.clear({ siteData: false })     // none — takes back what an earlier call asked for
```

To keep the storage across a sign-out (a theme setting, say), call `history.clear({ siteData: ['cache'] })` after
`auth.logout()` in your logout controller — the last call wins. `"cookies"` and `"executionContexts"` are never sent.

#### Low: `SESSION_ENCRYPT` encrypts the session data in its store

*Likelihood of impact: low — new, off by default.* `SESSION_ENCRYPT=true` (E144) encrypts the payload in the file, the `payload`
column or the Redis value with `APP_KEY` (AES-256-GCM; `APP_PREVIOUS_KEYS` still decrypt), bound to the session. Turning it on or
off signs everybody out once. The `cookie` driver's data is a cookie and encrypted anyway. The web app turns it on.

#### Low: `Route.….block()` runs a route's requests one at a time per session

*Likelihood of impact: low — new.* `RouteDefinition.block(lockSeconds = 10, waitSeconds = lockSeconds)` (Laravel's, E145) takes an
atomic lock on the session — through `@marmeon/cache`, which the app then needs — before `StartSession` reads it and frees it
after saving; a request that waits longer gets 423 ([Blocking routes](packages/session/README.md#blocking-routes-block)). The web app
and `make:auth` (both variants) block `PUT /settings/password` and `POST /settings/devices/logout`: a password hash and its
fingerprint in the session must stay a pair. Apps generated before can add `.block()` to those two routes.

#### Low: `marmeon key:generate --force` keeps the old key in `APP_PREVIOUS_KEYS`

*Likelihood of impact: low — apps that rotate their key.* `--force` replaced `APP_KEY` and left nothing behind — every session,
encrypted cookie and signed link died. Now the old key moves to the front of `APP_PREVIOUS_KEYS` in `.env` (E169), so all of it
stays valid; drop old keys from the list once nothing needs them, and set both variables on every server. To start without the
old key, remove it from `APP_PREVIOUS_KEYS` by hand.

#### Low: `CSRF_TRUSTED_ORIGINS` lists origins — the scheme counts

*Likelihood of impact: low.* Entries were compared by host only; now as whole origins (`https://admin.example.com` does not
let `http://admin.example.com` through), and an entry with a path (`https://admin.example.com/panel`) stops the boot.

#### Low: the `Login` event carries the request's address and browser by itself — `RequestInfo`

*Likelihood of impact: low — nothing to do.* `ip` and `userAgent` of `Login` were what the app passed to `attempt()`/`login()` —
the generated `LoginController` passed nothing, so they were `null` (a remember-me sign-in always). Now `Auth` takes them from
`RequestInfo` (http, E169: the address through `TRUSTED_PROXIES`, like `ctx.ip`); passing them still overrides. `RequestInfo` is
injectable wherever a service needs to know who sent the request.

#### Low: `marmeon make:auth --private-registration`; the generated forms carry no `_token`

*Likelihood of impact: low — new; existing modules belong to their app.* `make:auth` writes forms without a `_token` field (no
`csrfToken` props, no `Session` in the page controllers — Fetch Metadata and `Origin` vouch for a plain post), its registration tests in `registration.test.ts`,
and with `--private-registration` the variant that never tells whether an address has an account (E146,
[Private registration](packages/auth/README.md#private-registration-e146-e193)): the same answer in the same time
for new and known addresses, `AccountExistsMail` to the owner, no live check of the address, a confirmed address before the app
opens. A module generated before can take the views over by hand; the registration is the app's choice.

#### Low: one process for `marmeon start` and every command

*Likelihood of impact: low — process supervisors and scripts that relied on the launcher.* `marmeon start`, `queue:work`,
`schedule:work`, `migrate` and the other commands now run in the process that was started (E159) — no launcher in front:
PID 1 in a container is the server, signals reach it directly, a stuck worker's exit code 70 is the process's own, and
`NODE_OPTIONS='--import …'` (telemetry) is loaded once instead of twice. Only `marmeon dev` (`node --watch`) and commands inside
the framework's monorepo start a second Node. Nothing to change — a supervisor that sent its signal to the launcher's process
group still reaches the one process.

#### Low: one discovery manifest per condition set, relative paths, written by `marmeon build`

*Likelihood of impact: low.* `.marmeon/manifest.json` is the manifest of the published packages (production);
`.marmeon/manifest.source.json` is the monorepo's (`@marmeon/source`) — switching between `marmeon dev` and `marmeon start`
there no longer rewrites it on every switch (the first start after `dev` took ≈ 550 instead of ≈ 410 ms). Module paths are relative
to the app (a manifest written in a build stage works where the app is copied to). `marmeon build` writes the production manifest;
a server whose `.marmeon/` is read-only starts with one warning (discovered in memory) instead of failing with `EACCES` (E160).
The old `manifest.json` is rewritten once (format version 3). `.marmeon/` stays out of git.

#### Low: `marmeon build` precomputes the injection lists — deploy what you built

*Likelihood of impact: low — deployments that change app code on the server without running `marmeon build` again.* `marmeon
build` now writes `.marmeon/injections.json` first: the constructor-injection lists of every app module, with the SHA-256 of the
source they came from (E138). In a protected environment (production, staging, no `NODE_ENV`) the start applies them and does
not load oxc-parser — the web app starts in ≈ 270 instead of ≈ 385 ms, together with the compile cache below. Nothing is trusted
blindly: a module changed after the build (or missing from the file) is analysed as before, and the app logs once
`Build artifacts are stale (N files: …) … run marmeon build again.` (`Build artifacts are missing (.marmeon/injections.json)` without
the file). Build where you deploy, as for `dist/` — a Docker image's build stage does. `.marmeon/` stays out of git. Development
and tests analyse every module as before. Messages of a class that cannot be injected name the module relative to the app in
production (`modules/users/X.ts:12`), the absolute path in development.

#### Low: `marmeon start` writes Node's compile cache to `storage/framework/compile-cache`

*Likelihood of impact: low — servers whose app directory is read-only, or apps whose `storage/` is not ignored by git.* `marmeon
start` turns on Node's compile cache (type-stripped sources and V8 code cache) in `storage/framework/compile-cache` before the app
loads, and writes it once the server listens (E138; ≈ 60 ms of the web app's start). A changed module is never served from it —
Node checks every entry against the source after the injection hook. A directory that cannot be written leaves the start
uncached, without an error. To put it elsewhere: `NODE_COMPILE_CACHE=/path`; to turn it off: `NODE_DISABLE_COMPILE_CACHE=1`.
The blank app's `storage/framework/.gitignore` ignores it already; an app that keeps `storage/` in git ignores
`storage/framework/compile-cache/`.

#### Low: oxc-parser, pino-pretty and the tinker REPL load only when used

*Likelihood of impact: low — code that relied on a side effect of importing them.* `@marmeon/core` loads oxc-parser on the
first parse (the injection analysis, discovering a package's declarations), `@marmeon/log` loads pino-pretty for a pretty
logger only, and `marmeon tinker` loads `node:repl` when it runs — a production start loads 940 instead of 997 modules in the web
app. The APIs are unchanged; `insertionsOf`, `applyInsertions`, `computeInjectionArtifacts`, `writeInjectionArtifacts` and
`PrecomputedInjections` are new exports of `@marmeon/core`.

#### Low: `environments(…)` of the scheduler counts a missing `NODE_ENV` as `production`

*Likelihood of impact: low — schedules with `.environments(…)` on servers without `NODE_ENV`.* Before, a missing `NODE_ENV`
counted as `development` — a task limited to `production` never ran there. Now it counts as `production`, like Laravel's
`APP_ENV` default and the fail-closed rule above (E139). `schedule:work` names the environment it assumed when it starts.

#### Low: `createTestApp` runs as `NODE_ENV=test` unless its `env` names another

*Likelihood of impact: low — tests whose app definition brings its own `env` without `NODE_ENV`.* Such an app would now count as
protected (production-like); `createTestApp` puts `NODE_ENV=test` first, so it stays a test. A fixture booted with
`createApplication({ env })` directly should name `NODE_ENV: 'test'` itself.

#### Low: the packages ship their sources for the source maps, and a LICENSE each

*Likelihood of impact: low.* Each package now contains `src/` (without tests) next to `dist/`, so declaration and source
maps lead to real code ("Go to Definition" lands in the source). `exports` still point to `dist/` only — nothing imports
`src/`, and nothing needs to change. Every package carries the MIT `LICENSE`.

#### Low: the blank app has a `.env.example` and a `storage/` skeleton

*Likelihood of impact: low — apps copied from `apps/blank-app` before.* The blank app now ships `.env.example` (which
`marmeon key:generate` copies to `.env`) and `storage/` with `.gitignore` files that keep the directories and ignore what the
app writes there (the SQLite database, sessions, cache, files). Its `.gitignore` no longer ignores `storage/` as a whole.
To do the same in an older copy: add those `.gitignore` files (see `apps/blank-app/storage/`) and drop `storage/` from the
app's `.gitignore`.

#### Low: an opt-in Content-Security-Policy with a nonce per response — on in the web app and the starter's shell

*Likelihood of impact: low — apps that turn it on, and apps with their own `index.html` tags.* New: `contentSecurityPolicy()` from
`@marmeon/http` (E147) — `script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'self'` on every HTML response,
directives added or left out per app ([Content-Security-Policy](packages/http/README.md#content-security-policy-e147)). The blank
app (the base of `create-marmeon`) registers it next to its new `middleware/SecurityHeaders.ts` (with an HSTS switch, off by
default). For every app: `marmeon()` sets Vite's `html.cspNonce` to `__marmeon_csp_nonce__` (`CSP_NONCE_PLACEHOLDER`) — a value
of your own in `vite.config.ts` is replaced; the built `index.html` carries `nonce="__marmeon_csp_nonce__"` on its tags and a
`<meta property="csp-nonce">`, which the server fills in per response or strips when there is no policy. Inline scripts in your
`index.html` get the nonce that way too; HTML a controller writes itself uses `ctx.nonce()`. A route cached publicly
(`cacheControl('public, …')`) under the policy is warned about once. `PageRenderer.shell()` and `.render()` take the nonce
(`PageRenderOptions.nonce`), `SsrRenderOptions.nonce` reaches the adapter — custom renderers pass it on.

#### Low: `/assets/*` cached a year and sent precompressed — `marmeon build` writes `.br` and `.gz`

*Likelihood of impact: low — nothing to do.* Assets had no `Cache-Control` and went uncompressed. Now (E162) they answer with
`public, max-age=31536000, immutable`, and `marmeon build` writes a `.br` and a `.gz` next to every compressible file of
`dist/client/assets`, which the server sends by `Accept-Encoding` (`Vary: Accept-Encoding`). The server never compresses per
request — documents least of all (BREACH); a proxy may compress what it likes. Deploy `dist/` as built (the variants included).

#### Low: `HOST` chooses the interface; the start line names it and the port it got

*Likelihood of impact: low.* The server listened on every interface; it still does unless `HOST` is set (E162) — `127.0.0.1`
behind a proxy on the same machine, `0.0.0.0` in a container. `RunningServer.port` and the start line are the port the server
actually got (with `PORT=0` the system's choice, before `0`).

#### Low: the development error page and the mail preview bring their own Content-Security-Policy

*Likelihood of impact: low — development only.* Both send a policy of their own (the error page allows its inline style and
script by hash, the mail preview no script at all), which an app's `contentSecurityPolicy()` leaves alone; a script in a mail
preview's `srcdoc` frame never ran (sandbox) and still does not.

#### Low: `/up/ready` answers 503 from SIGTERM on and keeps a result for a second; `SHUTDOWN_DELAY`

*Likelihood of impact: low — apps whose monitoring expects a fresh readiness run on every probe, or that call `startServer()`
themselves.* Readiness falls at the stop signal now, not when the server closes: `503 {"status":"draining"}` at once, while `/up`
stays 200 until the server closes (E163). A result of the checks answers every probe for one second (failing results too) — a
probe right after a database came back may still see `failing` for up to a second. New and off by default: `SHUTDOWN_DELAY`
(seconds) keeps the server answering after SIGTERM before it closes (responses then carry `Connection: close`) — set it to about 5
behind a load balancer that learns from its probes (kamal-proxy, Traefik, cloud load balancers, Kubernetes ingresses) instead of a
`preStop` sleep; SIGINT (Ctrl+C) skips it. `RunningServer.close()` applies the delay; `close({ immediately: true })` does not.
`ServerClosing` (http) has a second signal, `draining`, aborted at the stop signal (`signal` still aborts when the server
closes). `marmeon dev`/`start` install their signal handlers before the server listens: a SIGTERM during the start drains once it
listens instead of ending the process.

#### Low: `marmeon start --workers=N` and `marmeon make:docker`

*Likelihood of impact: low — nothing to do; new.* `marmeon start --workers=N` runs N servers on one port with `node:cluster` (E140)
— the primary passes signals on, each worker drains, the exit code is 0 when all ended with 0
([Several processes](packages/cli/README.md#several-processes---workers-e140)). `marmeon make:docker [--caddy|--nginx]
[--systemd]` writes a Dockerfile (`node:26-slim`, non-root, health check, `marmeon` as the process), `.dockerignore`,
`compose.production.yaml` with one role per container and, on request, a proxy configuration and systemd units (E141,
[Production files](packages/cli/README.md#production-files-makedocker-e141)). The deployment guide is `docs/deployment.md`.

#### Low: a flash message stays with the tab that flashed it

*Likelihood of impact: low — apps with a `Flasher` of their own.* A message waited in the session for whichever answer the user
was shown next — another tab's poll could take it (E67). Now (E165) every request of a tab names its document
(`x-marmeon-document`, the tabSync feature), a message is bound to the document whose request flashed it
(`FlashEntry.document`), and another document's request leaves it; a request naming none — a full page load, a client without tab
sync — takes every message. A `Flasher` of your own takes the document: `takeFlash(document?: string)`, `hasFlash(document?:
string)`; `PageSession` implementations add `generation()` (the session's part of the epoch — `undefined` for a guest).

#### Low: middleware sets the headers of the framework's responses in place — `editableResponse()`

*Likelihood of impact: low — middleware that keeps a reference to a response after handing it on.* The framework's middleware (the
cookies, `SetLocale`, the CSP, `NoStoreWhenSignedIn`, `throttle`, `cacheControl`, the kernel's request id) used to copy every
response before adding a header; a page was copied four or five times (W8 step 9). They now go through `editableResponse(response)`
([@marmeon/router](packages/router/README.md#adding-headers-to-the-response--editableresponse), also exported by
@marmeon/http): a response the framework made for this request is changed in place, any other — one your action or middleware
returns — is copied once and then owned. Your own responses are never changed in place, as before. What changes: a middleware
that holds on to the response its `next()` returned and reads it again after returning sees the headers outer middleware added.
Your own header middleware keeps working with `new Response(response.body, response)`; to drop the copy, write
`const response = editableResponse(await next())` — the web app's and the blank app's `SecurityHeaders` do.

#### Low: `MiddlewareGroups.get()` and `Router.middlewareFor()` return the same frozen list until a group changes

*Likelihood of impact: low — code that changed the array these returned.* Each request sorted the global and the group's
middleware again; the lists are now worked out once (per group, per route) and frozen. `append`/`remove` still work at any time —
the next request sees the change. Pushing into the returned array throws a `TypeError` now; use `append`.

#### Low: the `Encrypter` runs on `node:crypto` — the same payloads, about five times faster

*Likelihood of impact: low — nothing to do.* `AesGcmEncrypter` used WebCrypto (≈ 18 µs per call, each a job and a promise); it
uses `node:crypto` now (≈ 3–4 µs) with the same layout — version, IV, ciphertext, 16-byte tag — and the same contexts. Cookies,
encrypted sessions (`SESSION_ENCRYPT`), queued payloads and everything else encrypted before decrypt as they are, with `APP_KEY`
and `APP_PREVIOUS_KEYS`; nobody is signed out. A tag shorter than 16 bytes was never accepted and is not now.

#### Low: `marmeon make:auth` no longer maps `/` to the sign-in page

*Likelihood of impact: low — apps that generate the auth module from now on.* The generated routes had `GET /` show the sign-in
page to guests; the starter kit of `create-marmeon` has a home module for `/` (E150), and two modules must not claim one
path. An app made with `make:auth` alone answers `/` with 404 until it has a page there. An existing `modules/auth` is the app's
code and keeps its route. To have the old behaviour in a new module: `guests.get('/', ShowLoginController);` in
`modules/auth/routes.ts`.

#### Low: `create-marmeon` — the blank app is its `--minimal` output, with the devtools, a test and `pnpm test`

*Likelihood of impact: low — apps copied from `apps/blank-app` before.* New apps start with `pnpm create marmeon my-app`
([create-marmeon](packages/create-marmeon/README.md)): the starter kit (`make:auth`, a home page, the devtools, oxlint,
Vitest) by default, the blank app with `--minimal` (E150, E167). The blank app is that output: it has `@marmeon/devtools` as a
dev dependency (development only, absent from production installs), a first test (`modules/system/system.test.ts`, `GET /up`),
a `test` script (`vitest run`) and `engines.node`. In an older copy: `pnpm add -D @marmeon/devtools` for the devtools, the
rest as you like. `make:auth` names the devtools only for an app that lacks them.

#### Low: the dev server pre-bundles from the client entry and the pages

*Likelihood of impact: low — nothing to do.* `marmeon()` sets Vite's `optimizeDeps.entries` to the client entry and the pages (and
`optimizeDeps.include` to the devtools' bar where it is installed): Vite found an app's packages only on the first request
before, and reloaded the page once or twice (a 504 "Outdated Optimize Dep" in the console). Entries of your own in
`vite.config.ts` are added to these.

#### Low: one version for every package — 0.1.0 from npm

*Likelihood of impact: low — apps that took the framework from a checkout or from tarballs.* The packages were `0.0.0`, linked
from the repository (`workspace:*`) or installed from `pnpm pack` tarballs (`file:`). From 0.1.0 they come from npm, all at one
version (E152: Changesets with one `fixed` group — every `@marmeon/*` package, `marmeon` and `create-marmeon`), and
they name each other at exactly that version. Replace every `workspace:*`, `file:…` or `0.0.0` of a `@marmeon/*` package or `marmeon` in
the app's `package.json` with `0.1.0` (and drop the `overrides` that pointed at tarballs). There is no meta package (E194):
an app lists the packages it imports, all at that one version.

#### Medium: `TRUSTED_PROXIES='*'` trusts the direct peer only — a client can no longer choose its address

*Likelihood of impact: medium — apps with `TRUSTED_PROXIES='*'`.* `*` trusted every hop of `X-Forwarded-For`, so `ctx.ip` was its
left-most entry. Behind a proxy that appends to the header (nginx's `$proxy_add_x_forwarded_for` — which the `make:docker --nginx`
template used together with `*`), that entry is the one the client sent itself: any client could choose the address that rate
limits (sign-in, registration, password resets), logs and the `Login` event see. Now (E172, as Laravel and Symfony read `*`) `*`
means "the direct peer is the proxy": `ctx.ip` is the right-most entry — the address that proxy saw — and `X-Forwarded-Proto`/
`-Host` keep taking the right-most value; explicit addresses and ranges keep the walk from the right past every trusted hop. The
nginx template also sets `proxy_set_header X-Forwarded-For $remote_addr;` now (as Caddy does).

- Two proxies in a row (a CDN in front of nginx) with `*`: `ctx.ip` is now the CDN's address — list both proxies' addresses or
  ranges instead of `*` (`TRUSTED_PROXIES=10.0.0.0/8,173.245.48.0/20,…`).
- An app made with `make:docker --nginx` before: change that line in `deploy/nginx.conf` (or run `marmeon make:docker --nginx
  --force`) — with E172 it is safe either way.
- `clientIp(remote, forwardedFor, ['*'])` (router) returns the right-most entry; a check function keeps the walk.

#### Low: a guest's island that follows a live channel answers without the subscription — not 500

*Likelihood of impact: low.* Since a guest's page starts no session (above), an island (read-only, it can start none) that
declared `.live(…)` for a guest without a session failed with 500 ("this request has none"). Now the island goes out without
the subscription — the guest gets no hints for it until a page keeps a session (a page that signs a channel does). A
`LiveSigner` of your own: `sign()` may return `undefined` (no subscription), and `LiveTokens.for(scope, readOnly)` takes the
request's read-only check.

#### Low: the `file` stores break a stale guard one waiter at a time — `withFileGuard`

*Likelihood of impact: low — nothing to do.* The `file` session and cache stores serialise writers per entry with a guard file;
one left by a crash (older than 2 s) was removed by name, and two waiters that both found it stale could remove each other's
fresh guards — two writers at once, a lost session update. Now one waiter at a time breaks a stale guard, only while it is the
very file found stale, and a holder removes only its own. The guard is `withFileGuard(file, work, options)` of
`@marmeon/core`, for stores of your own.

#### Low: an idle worker names a queue nobody takes

*Likelihood of impact: low — nothing to do; new.* `marmeon queue:work` without `--queue` takes only the connection's queue
(`default`), and the auth module of `make:auth` queues its mails on `mail` — a worker started by hand sent none of them, without
a word. Now an idle worker looks at the other queues once a minute and names, once, a queue that had jobs ready at two looks in a
row with none of them running: `Jobs are waiting on the "mail" queue …, which this worker does not take (it takes default)`.
Start production workers with every queue the app uses, in priority order — `--queue=mail,default` (the `make:docker` templates
do) — or `--queue=*`. `Worker#run({ watchOtherQueues: false })` turns the look off ([Which queues a worker takes](packages/queue/README.md#which-queues-a-worker-takes)).

#### Low: `PORT=0` asks the system for a free port

*Likelihood of impact: low — nothing to do.* `PORT` had to be 1–65535; `0` is allowed now and means "a free port" — the start
line names the one the server got. Useful for tests and tools that start a server next to others.

#### Low: with `--workers=N` the boot's warnings come once, from the primary

*Likelihood of impact: low — nothing to do.* `marmeon start --workers=N` logged every boot warning (the log mailer, cookies
without `Secure`, stale build artifacts) N + 1 times — once from the primary and once from each worker. The workers now keep
their boot's warnings to themselves (the primary booted the same app with the same configuration); what a worker warns about
after its boot is logged as before. The primary marks its workers with `MARMEON_CLUSTER_WORKER=1` (`CLUSTER_WORKER` of
`@marmeon/core`); the mark counts only in a worker of `node:cluster`.

#### Low: `marmeon` in a copy under `node_modules` runs its `dist/`; a failed start names Node's error code

*Likelihood of impact: low.* `marmeon` took any copy of the framework whose `package.json` still carried the workspace's
`exports` (with the `@marmeon/source` condition) for the framework's monorepo and started Node with that condition — in the
output of `pnpm deploy` (or with injected workspace dependencies) Node then refused the TypeScript sources under `node_modules`.
A copy under `node_modules` now runs its built `dist/`, as a published package does. When the start fails, the message ends with
Node's code (`(ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)`), and that error comes with a solution: a package that brings its
TypeScript sources was packed with `npm pack` (pack with pnpm), copied with its workspace manifest, or loaded with the source
condition.

#### Low (contributors): the monorepo needs pnpm 12

*Likelihood of impact: low — only for work on Marmeon itself.* The repository pins pnpm 12 (`packageManager`), its root
package is called `marmeon-monorepo` (the name `marmeon` is the CLI's), and packages are packed and
published with pnpm only (`npm pack` would ship the `@marmeon/source` condition). Apps are not affected.

### Wave 7 — devtools and observability

The 22 hints of the Wave 7 acceptance, sorted by impact; where Wave 8 changed a hint, the entry says so.

#### High: every app needs an `APP_KEY`

*Likelihood of impact: high — apps without cookies or sessions that never set one.* `@marmeon/http` depends on
`@marmeon/encryption` (signed URLs, the session epoch, encrypted cookies), so every app boots with an encrypter — and a
missing `APP_KEY` fails the start with a `ConfigError` that names it. Run `marmeon key:generate` (it writes `.env` from
`.env.example` with a fresh key) or set `APP_KEY` in the environment; `create-marmeon` writes one. There is no way to boot
without a key.

#### Medium: development features run with `NODE_ENV=development` only — never "not production"

*Likelihood of impact: medium — apps that ran staging, tests or a missing `NODE_ENV` with the development tools, and tests of
the mail preview.* Server-Timing, the development error page (`ServerConfig.debug`), the devtools, the **mail preview**
(`MailConfig.previews`) and Vite's dev server in `startServer`/`marmeon serve` are on only when `NODE_ENV` is `development`
(E115). Staging, test and a missing `NODE_ENV` serve the build, and `marmeon serve` starts no worker, scheduler or watcher there.
Tests of the mail preview create their app with `createTestApp(App, { env: { NODE_ENV: 'development' } })`. *Changed by Wave 8
(E139, E170):* the protections — JSON logs, `migrate --force`, the boot warnings — now apply to every `NODE_ENV` but
`development` and `test`, and `NODE_ENV` falls back to the app's `.env` (the Wave 8 entries above). There is no switch to turn a
development tool on elsewhere.

#### Medium: `/up` and `/up/ready` belong to the framework

*Likelihood of impact: medium — apps with a route of their own at `/up` or `/up/ready`.* The health endpoints (E126) answer
before every middleware group; an app route on one of the two paths is a boot error ("Give the route another path, or move the
health check: HEALTH_PATH=/healthz (or HEALTH_PATH=off)"). Move your route, or the health check with `HEALTH_PATH=/healthz` —
`HEALTH_PATH=off` turns the endpoints off (a container's health check then needs another way).

#### Medium: shared props are optional — layouts must cope with `undefined`

*Likelihood of impact: medium — apps whose layouts read `auth`, `locales` or other shared props.* A path without a route (the
404 page, a framework endpoint) runs through no middleware group: no session, no shared props. `SharedProps` are typed as
optional now, and a layout that reads `page.props.auth.user` must accept `auth` being `undefined` — `page.props.auth?.user`
(the pattern is in [@marmeon/react](packages/react/README.md)). The generated auth module (`make:auth`) does so. Before →
after: `const { user } = usePage().props.auth` → `const user = usePage().props.auth?.user ?? null`.

#### Medium: discovery follows pnpm — an app discovers only what it installs

*Likelihood of impact: medium — apps that relied on packages they did not list.* Discovery resolves a package's peers from the
directory of the package that depends on it, as pnpm does. Before, `@marmeon/testing`'s dev links pulled nearly every
package into every app; now an app loses the providers it only had that way (the blank app lost devtools, live, notifications,
redis and storage). Add what you use to `package.json` (`pnpm add @marmeon/storage`). A manifest that names a package
missing in production (`ERR_MODULE_NOT_FOUND`) is discovered anew once instead of failing.

#### Medium: client code imports server modules with `import type` only

*Likelihood of impact: medium — apps whose views or client code import controllers, jobs, repositories or other server
modules for a type.* The Vite plugin checks the client's imports (E121): a value import of a server module breaks `marmeon
dev`, `marmeon build` and the SSR tests with an error naming the import chain. **`import { type X } from '…'` counts as a value
import** (the module is still loaded); write `import type { X } from '…'`. Your own conventions go into
`marmeon({ serverModules: [...] })`.

#### Medium: `MAIL_MAILER=log` writes mail texts to the log — protected environments warn

*Likelihood of impact: medium — apps that deploy without a mail transport.* `log` is the default mailer in every environment
and writes the mails' texts — password-reset and verification links included — unredacted to the log. The start warns once per
process (`LOG_MAILER_WARNING`) when the app is protected (E135; *changed by Wave 8, E139:* every `NODE_ENV` but `development`
and `test`, staging and a missing `NODE_ENV` included). In production set `MAIL_MAILER=smtp` (and the `MAIL_*` settings); in
development the log mailer is the way to read the links.

#### Low: `marmeon dev` sets `NODE_ENV=development` when it is missing

*Likelihood of impact: low.* With another `NODE_ENV` set, `marmeon dev` warns and serves the build instead of Vite's dev
server. (Wave 8 also resolves `NODE_ENV` from the app's `.env`, E170 — see above.)

#### Low: `onOneServer()` and `withoutOverlapping()` with a `file` or `memory` cache warn instead of throwing

*Likelihood of impact: low — apps whose scheduler uses those cache stores.* E123 revises E88: a task with `onOneServer()` or
`withoutOverlapping()` on a cache that cannot lock across machines no longer throws a `ScheduleError` — the start warns in every
environment (also `schedule:list`). `ScheduleError` remains for a missing cache. `checkProcess` skips the commands of other
environments. Use a `database` or `redis` cache for tasks that must run once.

#### Low: the scheduler's events — the field is `skipped`

*Likelihood of impact: low — apps that listen to the scheduler.* `ScheduledTaskStarting`, `ScheduledTaskFinished` (`ms`),
`ScheduledTaskFailed` (`error`, `ms`) and `ScheduledTaskSkipped` (`skipped`) share `task`, `minute` and `reason` (E127). The
skipped event's field is called `skipped`, not `reason` as E127 sketched it.

#### Low: diagnostics channels for observing the framework

*Likelihood of impact: low — new; custom drivers may add methods.* `@marmeon/core/diagnostics` publishes `http.request`,
`db.query`, `queue.dispatch`, `queue.job`, `schedule.task`, `mail.send`, `notification.send`, `live.refresh`, `render.ssr`,
`command.run`, `log`, `exception` and `event` (E118; API `channels.subscribe/tracing/event/built/around`). A subscriber that
throws becomes a process warning. The messages carry **raw** values — a subscriber that records them redacts with `Redactor`.
`JobRecord.requestId` is always set, `traceparent` once a tracer listens. A `QueueDriver` of your own may implement `counts()`,
a `PageRenderer` of your own `failed()` (both optional).

#### Low: `createTestApp` turns the devtools off unless asked

*Likelihood of impact: low — tests of apps with `@marmeon/devtools`.* `createTestApp` sets `DEVTOOLS_ENABLED=false` unless
the test opts in: `createTestApp(App, { devtools: true })` records into a memory store (`app.devtools`). The error page in tests:
`{ debug: true }`.

#### Low: `marmeon make:lint-config` and the lint preset

*Likelihood of impact: low — new.* `marmeon make:lint-config [--boundaries]` writes `.oxlintrc.json` (with oxlint as a dev
dependency and a `lint` script). An app needs a `.gitignore` (oxlint follows pnpm's `node_modules` links otherwise), and a
nested `.oxlintrc.json` replaces the root's instead of extending it.

#### Low: redaction reaches into lists, child loggers and the request log line

*Likelihood of impact: low — log consumers that matched redacted values.* `redact()` looks into arrays, maps, sets and errors
(deeper than 6 levels → `[…]`, E125); the bindings of `logger.child()` and the `ConsoleLogger` are redacted; **the request log
line shows sensitive route parameters and token-like path segments as `[redacted]`**; `Redactor.headers` accepts list values.

#### Low: `html`, `raw`, `Html` and `escapeHtml` live in `@marmeon/core`

*Likelihood of impact: low.* They moved from `@marmeon/mail` to core; mail re-exports them, so imports keep working.
`interpolate` is called `interpolateHtml` in core.

#### Low: the devtools are a package of their own

*Likelihood of impact: low — new.* `pnpm add -D @marmeon/devtools` (a dev dependency: production installs leave it out);
`DEVTOOLS_ENABLED=true` together with `NODE_ENV=production` is a boot error. The recordings live in
`storage/framework/devtools/`; `config/devtools.ts` is optional (convention). The web app schedules `devtools:prune` hourly for
`development`.

#### Low: OpenTelemetry — the app brings the SDK, as `dependencies`

*Likelihood of impact: low — apps that trace.* `@marmeon/otel` is optional and has only `@opentelemetry/api` as a peer; the
SDK and the exporter are the app's, loaded with `NODE_OPTIONS=--import ./bootstrap/telemetry.ts` (no `sdk-node`: its
`protobufjs` needs a postinstall script pnpm refuses). *Changed by Wave 8 (E159):* the SDK packages belong in `dependencies` —
a production install leaves dev dependencies out — and `marmeon start` runs in one process, so the `--import` applies exactly
once.

#### Low: a defaulted constructor parameter of an injectable type warns

*Likelihood of impact: low.* A class the container builds whose constructor has a default or optional parameter of an
injectable type is never injected there (E128) — the development log warns once. Remove the default, or give the class a
`static inject` list.

#### Low: a `ConfigError` shows its solution only when it lists variables

*Likelihood of impact: low.* The solution text appears only when the message lists the variables (`•`) it is about.

#### Low: tinker keeps a history — plain text, and a banner where it is protected

*Likelihood of impact: low.* `marmeon tinker` writes its history to `storage/framework/tinker_history` (0600, the plain text of
what was typed; `--no-history` keeps none). In production — since Wave 8 in every protected environment — it shows a red
banner (`PRODUCTION`, `PROTECTED (staging)`).

#### Low (contributors): `pnpm run ci` is the check command — not `pnpm ci`

*Likelihood of impact: low — only for work on Marmeon itself.* `pnpm run ci` (`scripts/ci.ts`) runs every check;
`pnpm ci` without `run` is pnpm's own clean install (it deletes every `node_modules`, installs again and exits 0 — nothing
checked).

#### Low (contributors): the Postgres test databases are dropped after a test run

*Likelihood of impact: low — only for work on Marmeon itself.* At the end of a Vitest run the repository's global setup drops
the databases it created (`marmeon_{test,cache,queue,schedule,types}_*`) — only on the server of `MARMEON_TEST_PGSQL_URL`.

### Wave 6 — background services

#### Medium: an event with a queued listener needs `static event` and `static schema`

*Likelihood of impact: medium — apps with queued listeners.* A queued listener (`static queue`) receives its event in a worker,
so the event needs a stable name and the JSON of what is queued: `static event = 'orders.placed'` and a `static schema` read
from the event object (`get userId() { return this.user.id; }`). Without them `listen(Event, Listener)` is a type error ("A
queued listener (static queue) needs an event that can be queued — …") and the start fails. Events with only synchronous
listeners are unchanged.

#### Medium: `createTestApp()` fakes the queue, events, storage and notifications

*Likelihood of impact: medium — tests that relied on the real services.* `queue`, `events` (recorded; listeners still run
unless `events: 'fake' | [...]`), `storage` and `notifications` are fakes by default, as `mail` was. Pass `'real'` where a test
needs the real one: `createTestApp(App, { queue: 'real' })`.

#### Medium: mails need absolute links

*Likelihood of impact: medium — apps whose mails link with `href="/…"`.* A mail composed in a worker has no request to resolve a
relative link against; `compose()` refuses `href="/…"`. Build links from `APP_URL` (the starters' `AppConfig` requires it).

#### Low: the `Login` event carries `via`, `ip` and `userAgent` and can be queued

*Likelihood of impact: low — code that constructs `Login` itself.* `Login` (auth) has a required `via`
(`'attempt' | 'login' | 'remember'`) and `ip`/`userAgent` (`LoginOptions` take them) and is queueable
(`static event = 'auth.login'`); `Registered` is queueable too (`auth.registered`, `{ userId }`). Pass `via` where you construct
`Login`. (Wave 8 fills `ip` and `userAgent` by itself — `RequestInfo`, above.)

#### Low: queued listeners have no `afterCommit` any more

*Likelihood of impact: low.* E109: queued listeners join the transaction like every dispatch (a row in it on the database
queue, held until the commit elsewhere) — `afterCommit` in `static queue` is a type error ("afterCommit is always on: queued
listeners join the transaction (E107/E109) — remove it") and a boot error. Remove it.

#### Low: custom stores implement more

*Likelihood of impact: low — apps with a store of their own.* A `CacheStore` implements `add`, `increment`, `lock`, `unlock`,
`forceUnlock` and `lockOwner` (and optionally `prune`). A `SessionStore` implemented `writeIfExists` in Wave 6 — since Wave 8 its
`write` compares versions instead (the Wave 8 entry above, [Your own store](packages/session/README.md#your-own-store)).

#### Low: constructors that take a `Clock` take it as a required parameter

*Likelihood of impact: low — code that builds the auth token stores or `UrlSigner` by hand.* The container injects the `Clock`;
code that constructs them itself passes `new SystemClock()`.
