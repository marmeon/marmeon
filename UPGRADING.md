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

#### Low (contributors): the monorepo needs pnpm 12

*Likelihood of impact: low — only for work on BespokeCore itself.* The repository pins pnpm 12 (`packageManager`), its root
package is called `bespokecore-monorepo` (the name `bespokecore` is the meta package's), and packages are packed and
published with pnpm only (`npm pack` would ship the `@bespokecore/source` condition). Apps are not affected.

<!-- Later steps of Wave 8 add their entries above; Wave 7 and Wave 6 follow below (W8 step 11). -->

### Wave 7 — devtools and observability

*Collected in W8 step 11.*

### Wave 6 — background services

*Collected in W8 step 11.*
