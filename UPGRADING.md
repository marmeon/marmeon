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

#### Low (contributors): the monorepo needs pnpm 12

*Likelihood of impact: low — only for work on BespokeCore itself.* The repository pins pnpm 12 (`packageManager`), its root
package is called `bespokecore-monorepo` (the name `bespokecore` is the meta package's), and packages are packed and
published with pnpm only (`npm pack` would ship the `@bespokecore/source` condition). Apps are not affected.

<!-- Later steps of Wave 8 add their entries above; Wave 7 and Wave 6 follow below (W8 step 11). -->

### Wave 7 — devtools and observability

*Collected in W8 step 11.*

### Wave 6 — background services

*Collected in W8 step 11.*
