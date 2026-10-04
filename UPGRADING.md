# Upgrading

What changes for an app from one version of BespokeCore to the next — in Laravel's manner: each entry says how likely it is
to affect you (**impact**), what to do (before → after), and how to keep the old behaviour where there is a way.

> BespokeCore is not published yet. Until the first release (0.1.0) this guide collects the changes of the development
> waves; the release turns them into the guide for 0.1.0. In 0.x a minor version may break — every break has an entry here.

**Impact:** High — most apps must act. Medium — apps that use the feature must act. Low — only in rare cases, or nothing
to do. **Estimated upgrade time** is given per version once it is released.

## Unreleased → 0.1.0

### Wave 8 — ship-ready

#### High: `@bespokecore/cli` is a dependency of the app

*Likelihood of impact: high — every app.* `bespoke start`, `queue:work`, `schedule:work` and `migrate` run on the server, and a
production install (`pnpm install --prod`, a Docker image) leaves dev dependencies out — there was no `node_modules/.bin/bespoke`
(E159). Move it: `pnpm add @bespokecore/cli` (pnpm moves it from `devDependencies` to `dependencies`). The same holds for what
`NODE_OPTIONS='--import ./bootstrap/telemetry.ts'` loads in production — the OpenTelemetry SDK packages of
[@bespokecore/otel](packages/otel/README.md) belong in `dependencies`. `bespoke make:auth` names a runtime package it finds only
among the dev dependencies.

#### High: session keys are hashed — every user is signed out once; a `database` sessions table needs its upgrade migration

*Likelihood of impact: high — every app with sessions (once, at the deployment).* The stores keep a session under the SHA-256 of
its id now, never the id (E144): a leaked backup, replica or Redis yields no cookie that works. Sessions stored before are not
found any more — **every user is signed out once** (remember-me cookies sign them back in where the app has them). With
`SESSION_DRIVER=database` the `sessions` table also needs a `version` column (writes compare it, E145): run
`bespoke make:session-table --upgrade` and `bespoke migrate` before the new code serves requests — the migration makes the table
anew (its rows are keyed by raw ids, which nothing should keep). Without it every request fails with "The sessions table has no
version column … Run `bespoke make:session-table --upgrade`". New apps get the new table from `bespoke make:session-table`. The
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

This includes commands typed on a development machine without any `NODE_ENV`: outside `bespoke dev` (which sets `development`
itself) `bespoke migrate` asks for `--force` and writes no table types — put `NODE_ENV=development` into the app's `.env` (next
entry) or the shell.
The development tools still run with `NODE_ENV=development` only (E115). To keep pretty logs in staging: `LOG_FORMAT=pretty`.
Code of your own checks `environment.isProtected()` / `environment.isDevelopment()` from `@bespokecore/core`
([The environment](packages/core/README.md#the-environment-node_env)) instead of comparing with `'production'`.

#### Medium: `NODE_ENV` falls back to the app's `.env`

*Likelihood of impact: medium — every app (do it once on each development machine; check every server).* `NODE_ENV` is resolved
once per process (E170): the environment's value wins; else the one in the app's `.env` (only the base file — a `NODE_ENV` in
`.env.{NODE_ENV}` is ignored with a warning); else none, which is protected (`bespoke start` then sets `production`). Config
definitions, the CLI and the server read the same resolved value now (before, a `.env` `NODE_ENV` reached config definitions only).
On a development machine add `NODE_ENV=development` to `.env` (the `.env.example` files of the starters carry it). **On servers**
set `NODE_ENV` in the real environment and never deploy a development `.env`: a `bespoke start`, `queue:work` or `schedule:work`
that runs as development because of `.env` says so loudly in its log, and its start line names the source
(`development (from .env)`) — it is not refused.

#### Medium: `bespoke start` respects `NODE_ENV`

*Likelihood of impact: medium — apps started with a `NODE_ENV` other than `production`.* `bespoke start` set
`NODE_ENV=production` whatever the environment said; now it sets it only when `NODE_ENV` is missing — `NODE_ENV=staging bespoke
start` runs as staging, protected like production (above). The start line names the environment:
`BespokeCore in staging (protected) on http://localhost:3000 (the build; …)` instead of `BespokeCore [production] on …` — adjust
a log alert that matched the old line. The old behaviour: `NODE_ENV=production bespoke start`.

#### Medium: `migrate` writes the table types with `NODE_ENV=development` only

*Likelihood of impact: medium — workflows that ran `bespoke migrate` without `NODE_ENV` or in tests and committed the result.*
`migrate` and `migrate:fresh` regenerated `bootstrap/database.d.ts` with any `NODE_ENV` but `production` — on a staging box that
wrote into the app directory. Now only in development (E164). Elsewhere run `bespoke db:types` (it writes the file from the
migrations alone) or migrate with `NODE_ENV=development`.

#### Medium: cookies are `Secure` when `APP_URL` is `https://` — every cookie of the request

*Likelihood of impact: medium — apps whose `APP_URL` is `https://…` but that are reached over plain HTTP somewhere (a local
`.env` copied from production, a health check over `http://`).* `SESSION_SECURE_COOKIE` defaulted to `false` — in production too.
Now it follows `APP_URL` when unset (E162): `https://` → `Secure`, `http://` → not; `true`/`false` still decide. It applies to
every cookie the app sets without saying (`CookieDefaults`, bound by `@bespokecore/session`, Laravel's cookie jar defaults): the
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
  call keeps a session for every visitor. Drop the field (what `bespoke make:auth` writes now: a plain form post passes by Fetch
  Metadata or `Origin`), or render `usePage().csrf` only when it is there (`<Form>` does that by itself).
- A guest's page with an upload field calls `session.persist()` in its controller: an upload belongs to a session, and an upload
  request (read-only, W6.9) cannot start one. A page that signs a live channel keeps the session by itself.
- `PageSession.scope()` is `undefined` without a kept session (it was a hash of an id nobody would see again); a live stream
  without a session answers 401 (was 403).

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

#### Medium: the tabs of a browser follow each other's sign-in, sign-out and language — `createBespokeApp` loads tab sync

*Likelihood of impact: medium — apps that sign in or out, or switch the language; nothing to do unless you want the old
behaviour.* Before, a tab kept what it showed (pages in memory, islands, pages fetched ahead, once props, remembered input) after
another tab signed out, until its own next request (E66). Now (E148, E149) `createBespokeApp` loads the `tabSync` feature with the
first page: every page object carries the session's epoch (`PageObject.epoch`, opaque), the tabs post it on a `BroadcastChannel`
(`{ v: 1, epoch }`, nothing else), and a tab that hears another one — or becomes visible again, or comes back from the
back/forward cache — asks `GET /_bespoke/session`; if the epoch there is new, it lets go of everything and loads again. With
unsaved changes on screen it asks first (a `leave` question with `reason: 'session'` — word it in your confirm dialog; the
default text is English). Back/Forward to an entry of an older epoch loads it from the server
([Tab sync](packages/http/README.md#tab-sync-w8-step-8)).

- The old behaviour: `createBespokeApp({ …, tabSync: false })` — then the risk E66 is back: a tab shows what it kept after a
  sign-out elsewhere until its next request.
- An adapter of your own attaches it from the start: `new Navigator({ …, features: [await loadTabSync()] })`.
- The path `/_bespoke/session` is the framework's now (in the `web` group, read-only).

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
atomic lock on the session — through `@bespokecore/cache`, which the app then needs — before `StartSession` reads it and frees it
after saving; a request that waits longer gets 423 ([Blocking routes](packages/session/README.md#blocking-routes-block)). The web app
and `make:auth` (both variants) block `PUT /settings/password` and `POST /settings/devices/logout`: a password hash and its
fingerprint in the session must stay a pair. Apps generated before can add `.block()` to those two routes.

#### Low: `bespoke key:generate --force` keeps the old key in `APP_PREVIOUS_KEYS`

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

#### Low: `bespoke make:auth --private-registration`; the generated forms carry no `_token`

*Likelihood of impact: low — new; existing modules belong to their app.* `make:auth` writes forms without a `_token` field (no
`csrfToken` props, no `Session` in the page controllers — Fetch Metadata and `Origin` vouch for a plain post), its registration tests in `registration.test.ts`,
and with `--private-registration` the variant that never tells whether an address has an account (E146,
[Private registration](packages/auth/README.md#private-registration---private-registration-e146)): the same answer in the same time
for new and known addresses, `AccountExistsMail` to the owner, no live check of the address, a confirmed address before the app
opens. A module generated before can take the views over by hand; the registration is the app's choice.

#### Low: one process for `bespoke start` and every command

*Likelihood of impact: low — process supervisors and scripts that relied on the launcher.* `bespoke start`, `queue:work`,
`schedule:work`, `migrate` and the other commands now run in the process that was started (E159) — no launcher in front:
PID 1 in a container is the server, signals reach it directly, a stuck worker's exit code 70 is the process's own, and
`NODE_OPTIONS='--import …'` (telemetry) is loaded once instead of twice. Only `bespoke dev` (`node --watch`) and commands inside
the framework's monorepo start a second Node. Nothing to change — a supervisor that sent its signal to the launcher's process
group still reaches the one process.

#### Low: one discovery manifest per condition set, relative paths, written by `bespoke build`

*Likelihood of impact: low.* `.bespoke/manifest.json` is the manifest of the published packages (production);
`.bespoke/manifest.source.json` is the monorepo's (`@bespokecore/source`) — switching between `bespoke dev` and `bespoke start`
there no longer rewrites it on every switch (the first start after `dev` took ≈ 550 instead of ≈ 410 ms). Module paths are relative
to the app (a manifest written in a build stage works where the app is copied to). `bespoke build` writes the production manifest;
a server whose `.bespoke/` is read-only starts with one warning (discovered in memory) instead of failing with `EACCES` (E160).
The old `manifest.json` is rewritten once (format version 3). `.bespoke/` stays out of git.

#### Low: `bespoke build` precomputes the injection lists — deploy what you built

*Likelihood of impact: low — deployments that change app code on the server without running `bespoke build` again.* `bespoke
build` now writes `.bespoke/injections.json` first: the constructor-injection lists of every app module, with the SHA-256 of the
source they came from (E138). In a protected environment (production, staging, no `NODE_ENV`) the start applies them and does
not load oxc-parser — the web app starts in ≈ 270 instead of ≈ 385 ms, together with the compile cache below. Nothing is trusted
blindly: a module changed after the build (or missing from the file) is analysed as before, and the app logs once
`Build artifacts are stale (N files: …) … run bespoke build again.` (`Build artifacts are missing (.bespoke/injections.json)` without
the file). Build where you deploy, as for `dist/` — a Docker image's build stage does. `.bespoke/` stays out of git. Development
and tests analyse every module as before. Messages of a class that cannot be injected name the module relative to the app in
production (`modules/users/X.ts:12`), the absolute path in development.

#### Low: `bespoke start` writes Node's compile cache to `storage/framework/compile-cache`

*Likelihood of impact: low — servers whose app directory is read-only, or apps whose `storage/` is not ignored by git.* `bespoke
start` turns on Node's compile cache (type-stripped sources and V8 code cache) in `storage/framework/compile-cache` before the app
loads, and writes it once the server listens (E138; ≈ 60 ms of the web app's start). A changed module is never served from it —
Node checks every entry against the source after the injection hook. A directory that cannot be written leaves the start
uncached, without an error. To put it elsewhere: `NODE_COMPILE_CACHE=/path`; to turn it off: `NODE_DISABLE_COMPILE_CACHE=1`.
The blank app's `storage/framework/.gitignore` ignores it already; an app that keeps `storage/` in git ignores
`storage/framework/compile-cache/`.

#### Low: oxc-parser, pino-pretty and the tinker REPL load only when used

*Likelihood of impact: low — code that relied on a side effect of importing them.* `@bespokecore/core` loads oxc-parser on the
first parse (the injection analysis, discovering a package's declarations), `@bespokecore/log` loads pino-pretty for a pretty
logger only, and `bespoke tinker` loads `node:repl` when it runs — a production start loads 940 instead of 997 modules in the web
app. The APIs are unchanged; `insertionsOf`, `applyInsertions`, `computeInjectionArtifacts`, `writeInjectionArtifacts` and
`PrecomputedInjections` are new exports of `@bespokecore/core`.

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
`bespoke key:generate` copies to `.env`) and `storage/` with `.gitignore` files that keep the directories and ignore what the
app writes there (the SQLite database, sessions, cache, files). Its `.gitignore` no longer ignores `storage/` as a whole.
To do the same in an older copy: add those `.gitignore` files (see `apps/blank-app/storage/`) and drop `storage/` from the
app's `.gitignore`.

#### Low: an opt-in Content-Security-Policy with a nonce per response — on in the web app and the starter's shell

*Likelihood of impact: low — apps that turn it on, and apps with their own `index.html` tags.* New: `contentSecurityPolicy()` from
`@bespokecore/http` (E147) — `script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'self'` on every HTML response,
directives added or left out per app ([Content-Security-Policy](packages/http/README.md#content-security-policy-e147)). The blank
app (the base of `create-bespoke-app`) registers it next to its new `middleware/SecurityHeaders.ts` (with an HSTS switch, off by
default). For every app: `bespoke()` sets Vite's `html.cspNonce` to `__bespoke_csp_nonce__` (`CSP_NONCE_PLACEHOLDER`) — a value
of your own in `vite.config.ts` is replaced; the built `index.html` carries `nonce="__bespoke_csp_nonce__"` on its tags and a
`<meta property="csp-nonce">`, which the server fills in per response or strips when there is no policy. Inline scripts in your
`index.html` get the nonce that way too; HTML a controller writes itself uses `ctx.nonce()`. A route cached publicly
(`cacheControl('public, …')`) under the policy is warned about once. `PageRenderer.shell()` and `.render()` take the nonce
(`PageRenderOptions.nonce`), `SsrRenderOptions.nonce` reaches the adapter — custom renderers pass it on.

#### Low: `/assets/*` cached a year and sent precompressed — `bespoke build` writes `.br` and `.gz`

*Likelihood of impact: low — nothing to do.* Assets had no `Cache-Control` and went uncompressed. Now (E162) they answer with
`public, max-age=31536000, immutable`, and `bespoke build` writes a `.br` and a `.gz` next to every compressible file of
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
closes). `bespoke dev`/`start` install their signal handlers before the server listens: a SIGTERM during the start drains once it
listens instead of ending the process.

#### Low: `bespoke start --workers=N` and `bespoke make:docker`

*Likelihood of impact: low — nothing to do; new.* `bespoke start --workers=N` runs N servers on one port with `node:cluster` (E140)
— the primary passes signals on, each worker drains, the exit code is 0 when all ended with 0
([Several processes](packages/cli/README.md#several-processes---workers-e140)). `bespoke make:docker [--caddy|--nginx]
[--systemd]` writes a Dockerfile (`node:26-slim`, non-root, health check, `bespoke` as the process), `.dockerignore`,
`compose.production.yaml` with one role per container and, on request, a proxy configuration and systemd units (E141,
[Production files](packages/cli/README.md#production-files-makedocker-e141)). The deployment guide is `docs/deployment.md`.

#### Low: a flash message stays with the tab that flashed it

*Likelihood of impact: low — apps with a `Flasher` of their own.* A message waited in the session for whichever answer the user
was shown next — another tab's poll could take it (E67). Now (E165) every request of a tab names its document
(`x-bespoke-document`, the tabSync feature), a message is bound to the document whose request flashed it
(`FlashEntry.document`), and another document's request leaves it; a request naming none — a full page load, a client without tab
sync — takes every message. A `Flasher` of your own takes the document: `takeFlash(document?: string)`, `hasFlash(document?:
string)`; `PageSession` implementations add `generation()` (the session's part of the epoch — `undefined` for a guest).

#### Low: middleware sets the headers of the framework's responses in place — `editableResponse()`

*Likelihood of impact: low — middleware that keeps a reference to a response after handing it on.* The framework's middleware (the
cookies, `SetLocale`, the CSP, `NoStoreWhenSignedIn`, `throttle`, `cacheControl`, the kernel's request id) used to copy every
response before adding a header; a page was copied four or five times (W8 step 9). They now go through `editableResponse(response)`
([@bespokecore/router](packages/router/README.md#adding-headers-to-the-response--editableresponse), also exported by
@bespokecore/http): a response the framework made for this request is changed in place, any other — one your action or middleware
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

#### Low: `bespoke make:auth` no longer maps `/` to the sign-in page

*Likelihood of impact: low — apps that generate the auth module from now on.* The generated routes had `GET /` show the sign-in
page to guests; the starter kit of `create-bespoke-app` has a home module for `/` (E150), and two modules must not claim one
path. An app made with `make:auth` alone answers `/` with 404 until it has a page there. An existing `modules/auth` is the app's
code and keeps its route. To have the old behaviour in a new module: `guests.get('/', ShowLoginController);` in
`modules/auth/routes.ts`.

#### Low: `create-bespoke-app` — the blank app is its `--minimal` output, with the devtools, a test and `pnpm test`

*Likelihood of impact: low — apps copied from `apps/blank-app` before.* New apps start with `pnpm create bespoke-app my-app`
([create-bespoke-app](packages/create-bespoke-app/README.md)): the starter kit (`make:auth`, a home page, the devtools, oxlint,
Vitest) by default, the blank app with `--minimal` (E150, E167). The blank app is that output: it has `@bespokecore/devtools` as a
dev dependency (development only, absent from production installs), a first test (`modules/system/system.test.ts`, `GET /up`),
a `test` script (`vitest run`) and `engines.node`. In an older copy: `pnpm add -D @bespokecore/devtools` for the devtools, the
rest as you like. `make:auth` names the devtools only for an app that lacks them.

#### Low: the dev server pre-bundles from the client entry and the pages

*Likelihood of impact: low — nothing to do.* `bespoke()` sets Vite's `optimizeDeps.entries` to the client entry and the pages (and
`optimizeDeps.include` to the devtools' bar where it is installed): Vite found an app's packages only on the first request
before, and reloaded the page once or twice (a 504 "Outdated Optimize Dep" in the console). Entries of your own in
`vite.config.ts` are added to these.

#### Low (contributors): the monorepo needs pnpm 12

*Likelihood of impact: low — only for work on BespokeCore itself.* The repository pins pnpm 12 (`packageManager`), its root
package is called `bespokecore-monorepo` (the name `bespokecore` is the meta package's), and packages are packed and
published with pnpm only (`npm pack` would ship the `@bespokecore/source` condition). Apps are not affected.

<!-- Later steps of Wave 8 add their entries above; Wave 7 and Wave 6 follow below (W8 step 11). -->

### Wave 7 — devtools and observability

*Collected in W8 step 11.*

### Wave 6 — background services

*Collected in W8 step 11.*
