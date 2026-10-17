# Contributing to Marmeon

Thank you for helping. This page covers the rules for a contribution: the sign-off, the checks, pull requests and their labels. It says how a
release is made, and what the repository holds that the documentation does not: its layout, its own test suites and
benchmarks, and the inside of the framework's client. The principles the framework is built on are in the [README](README.md#principles); the
documentation is under `docs/` ([Writing documentation](#writing-documentation)).

## Sign your commits off (DCO)

Marmeon takes contributions under the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO), as the
Linux kernel and Node.js do — no contributor licence agreement. With the sign-off you certify that you wrote the change or have
the right to submit it under the project's licence (MIT, `LICENSE`; copyright [BespokeCode](https://bespokecode.de)). Every commit of a pull
request carries a `Signed-off-by` line with your real name and the e-mail of the commit:

```text
Signed-off-by: Jane Doe <jane@example.com>
```

`git commit -s` adds it (`git commit --amend -s --no-edit` for the last commit, `git rebase --signoff main` for a whole branch).
A check on every pull request (the DCO app) refuses commits without it. The text you certify:

```text
By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Set up

Node 26.10 or newer and pnpm 12 (the version in `packageManager` — `pnpm self-update` or Corepack-free `npm i -g pnpm@12.9.1`).

```sh
pnpm install
docker compose up -d   # Postgres, Redis and S3 for test:pgsql, test:redis and test:s3 (this repository's containers only)
pnpm dev               # the web app (apps/web-app) on http://localhost:3000 — first its .env and database (apps/web-app/README.md)
```

`pnpm-workspace.yaml` holds the install policy: a release younger than three days is not installed, a package whose trust evidence got weaker is refused, and no dependency runs an install script. The compose services listen on `127.0.0.1` only.

## Before you open a pull request

```sh
pnpm run ci            # every check CI runs: build, typecheck, lint, the test suites, sizes, types, docs, tarballs, image, release
```

`pnpm ci` without `run` is pnpm's own clean install — it checks nothing. The run has 16 parts (`pnpm run ci --list`;
[The repository](#the-repository) names them); some of them: `pnpm run ci --only test,lint`. `pack:smoke` and `image` need the
package store, the registry and Docker — without them they are reported as skipped, which is not green.

- **Tests** come with the change — type guarantees as `@ts-expect-error` tests, behaviour in Vitest, a feature shown in
  `apps/web-app` (principle 9).
- **Bundle sizes are reported, not limited:** the `size` check puts a table of the client bundles, this branch against its base
  commit, into the job summary and fails only when a build or measurement breaks. A maintainer decides per pull request whether
  its growth is worth it; say in the description what the bytes buy ([The bundle sizes](#the-bundle-sizes)).
- **Tests leave nothing behind:** every run gets its own temporary directory (`TMPDIR`), and `pnpm test` fails with a list when a
  test leaves a `marmeon-*` entry in it. Make temporary directories with `tempDir('marmeon-…')` (`scripts/test/temp-dir.js`): it
  removes them when the test, or the file, is done.
- **`pnpm check:source` holds** — the rules over the repository's own files ([next section](#rules-over-the-source-pnpm-checksource)).
- **A pull request** is one change; its title is its line in the release notes, and a maintainer gives it one release label
  ([Pull requests and releases](#pull-requests-and-releases)). You write no changelog entry. A breaking change gets its entry in
  [UPGRADING.md](UPGRADING.md) — impact, before → after, the way back — when the release is prepared; say in the description what
  an app has to do.
- **A change to a public API, an environment default or a command** changes its page under `docs/` in the same commit
  ([Writing documentation](#writing-documentation)).
- Code, comments and commit messages are in English; a commit subject says what the change does, in the imperative.

## The repository

```text
packages/*        the framework's packages, each with a short README for npm
apps/web-app      the app every feature is shown and tested in
apps/blank-app    an app without modules: what create-marmeon --minimal writes (pnpm template:sync), and what make:auth is tested against
examples/*        demos on the starter kit, each an overlay (files, edits, commands) that pack:smoke applies to its kit app and runs
apps/website      the documentation as a Marmeon app: docs/*.md and the policies at the root (pnpm website:dev; apps/website/Dockerfile, deploy/website)
docs              the documentation's pages, in the order apps/website/docs.config.ts lists them
scripts/ci.ts     pnpm run ci — its 16 parts, from the build to the release rules (below)
scripts/bench     pnpm bench — the start and the request path, measured (never a gate)
scripts/test      the test suite's temporary directory per run and tempDir() — the repository's own, not exported by a package
                  (pnpm test fails when a test leaves an entry behind)
deploy/website    the docs' Compose file and Caddyfile (one server)
UPGRADING.md      what changes for apps from one version to the next
.github           workflows/ (ci.yml: pnpm run ci in parallel jobs; release.yml: started by hand, staged publishing; pr-label.yml: the release label
                  check), release.yml (the notes' categories, generated) and release-base (the commit a release was prepared from)
```

```sh
pnpm run ci            # everything, as CI runs it (pnpm ci without `run` is pnpm's clean install)
pnpm test              # the test suite; test:pgsql, test:redis, test:s3 against the containers (docker compose up -d)
pnpm website:dev       # the docs on http://localhost:3970
pnpm website:image     # the docs' image (apps/website/Dockerfile): built, run read-only and behind Caddy (deploy/website) — part of `image`
pnpm pack:check        # the tarballs: clean build, pnpm pack, no tests or leftovers, LICENSE, exact versions, publint, attw
pnpm pack:smoke        # create-marmeon from the tarballs, outside the repository: the starter kit (pnpm) and a blank app (npm) — install, tests, lint, build, start
pnpm api:check         # every package's public surface against its api.md (after a build); pnpm api:update rewrites the files
pnpm template:sync     # apps/blank-app → the template of create-marmeon (a test fails while they differ)
pnpm release:prepare   # the next version, changelogs and upgrade-guide heading from the merged pull requests (below); pnpm check-release checks the release rules
pnpm csp:probe --app apps/web-app --build   # a built app in headless Chrome under style-src 'self': 0 CSP violations (never a gate)
```

`pnpm csp:probe` with `--build` builds, then starts the app (or probes `--url`; `--throwaway`: generated keys and a seeded temporary SQLite, for a fresh checkout),
signs in over HTTP and visits the guest and signed-in pages, a layer by deep link and by click, and a failing visit — in headless
Chrome under a second `style-src 'self'` policy; it needs Chrome (`--chrome <path>` or `CHROME`).

`pnpm run ci` runs 16 parts one after the other, each with its exit code and time, and fails when one is red: `build`,
`typecheck`, `lint`, `check:source` ([below](#rules-over-the-source-pnpm-checksource)), `test`, then `test:pgsql`, `test:redis`
and `test:s3` against this repository's containers (`compose.yaml`, started as needed), `size` (the bundle sizes against the base commit —
[The bundle sizes](#the-bundle-sizes)), `types:check` (the apps' generated route and table types are current), `api:check` (each package's `api.md` matches its built declarations — [The API snapshot](#the-api-snapshot)), `website:check`,
`pack:check`, `pack:smoke`, `image` (the starter kit's image from `make:docker`, then the docs' image) and `check-release`.
`pack:smoke` and `image` without a package store, the registry or Docker are reported as skipped, never as green.
`--only a,b`, `--skip a,b`, `--bail`, `--no-compose` (the databases already run) and `--list` choose; `--shard i/n` runs one n-th
of the files of the selected test parts (Vitest's `--shard`; with no test part selected it is an error). `ci.yml` splits the parts
into jobs that run side by side (the checks, the tests as three shards `test (1/3)` to `test (3/3)`, the tarballs, the image,
Postgres as two shards `test:pgsql (1/2)` and `(2/2)`, Redis, S3); a shard builds for itself, and a job's name is what a required
check of the repository would list. The job `test:pgsql` only waits for both Postgres shards and fails unless they passed, so the
name a required check lists stays the same.

### The test suites against real services

`pnpm test` runs every package's tests and the web app's on SQLite and in memory. Each run gets a temporary directory of its own
(`TMPDIR` points into it) and fails when a test leaves a `marmeon-*` entry behind; the framework's tests make theirs with
`tempDir()` of `scripts/test/temp-dir.js`. The cases for other backends run when their variable is set — the services come from
`compose.yaml` (`docker compose up -d`, ports of their own):

```sh
pnpm test:pgsql   # MARMEON_TEST_PGSQL_URL, DB_CONNECTION=pgsql and DB_URL → postgres://marmeon:secret@localhost:55432/marmeon
pnpm test:redis   # MARMEON_TEST_REDIS_URL=redis://127.0.0.1:56379
pnpm test:s3      # MARMEON_TEST_S3_ENDPOINT=http://127.0.0.1:56333
                  # (MARMEON_TEST_S3_KEY / MARMEON_TEST_S3_SECRET default to the compose identity)
```

Each of them runs only the test files that use its service, not the whole suite again. `scripts/test/services.ts` derives the
selection from the source — nothing is listed or marked by hand — and `vitest.config.ts` makes one Vitest project per set of
services (`plain`, `pgsql`, `pgsql+redis`, …; `pnpm test:pgsql` is `pnpm test --project '*pgsql*'`, and a path filter still
narrows it). A file is selected for a service by the files it reaches through relative imports (never through a package
specifier, so import a `__fixtures__` file relatively; the selection throws on a package specifier that names `__fixtures__`):

- **Postgres**: a file reads `MARMEON_TEST_PGSQL_URL`; a test or helper file (anything in `apps/`, `scripts/`, `__fixtures__/`,
  `test-helpers/`, `*.test-support.ts` or a test) builds a `database: 'refresh'` app; the test lives in an app that depends on
  `@marmeon/database` (`DB_CONNECTION` from the environment wins over the app's `.env`); a test or helper starts a nested Vitest
  (its refresh tests inherit `DB_CONNECTION`).
- **Redis** and **S3**: a file reads `MARMEON_TEST_REDIS_URL` or `MARMEON_TEST_S3_ENDPOINT`.

Each project gets tripwire values for the services its files were not selected for: `DB_CONNECTION=pgsql` with a Postgres URL, a Redis URL and an S3
endpoint on `not-selected-for-test-….invalid` hosts (which never resolve), so a file that reaches a service the rules do not
see fails in the plain `pnpm test` instead of silently dropping out of the service runs. An error that names
`not-selected-for-test-pgsql.invalid` (or `-redis`, `-s3`) means exactly that: import the helper relatively, or extend the
rule in `scripts/test/services.ts` — do not change the test.

With `DB_CONNECTION=pgsql` and `DB_URL` in the environment, refreshed test apps of any app use Postgres: the role needs the
right to create databases (one per worker, next to the configured one). Run `test:pgsql` for every change to the database,
sessions, auth, queues or locks — Postgres finds races SQLite hides. Never run two Postgres or Redis suites at once: they share
their test databases. A session store of the framework is held to the shared suite in
`packages/session/src/stores/stores.test.ts`, the contract's test: compare and write in one atomic step.

### Benchmarks

`pnpm bench` keeps the measurements in the repository — none of them is part of `pnpm run ci`, a laptop's noise (±3–5 % between
runs) would make a gate flaky:

```sh
pnpm bench boot --app apps/web-app                    # marmeon start → /up 200: median of 7, a breakdown from a CPU profile
pnpm bench login --base f785159 --without all         # the request path, A/B: this checkout against a commit, each side in a git worktree
pnpm bench people                                     # GET /people signed in
pnpm bench login --profile --base f785159             # CPU profiles of the measured requests: top lists (self, inclusive) and their diff
```

The request benchmarks boot the web app in-process (SQLite in memory, `SESSION_DRIVER=memory`) and send the requests through the
kernel as a browser would — the cookies as the server set them, the body read; none of the test helpers' work per response. Each
side runs from a `git worktree` under `$TMPDIR/marmeon-bench/` (this checkout as a snapshot with its uncommitted changes; before a
run each one must import what a measured process imports — a missing module reinstalls its `node_modules`), the sides
alternate in fresh processes, and the report gives the median, the mean's 95 % confidence interval and Welch's test per pair.
`--in-place` measures the checkout itself instead of a snapshot; the repository's own `apps/web-app/.env` (read under `.env.test`)
and the location of the worktrees changed results by several per cent, so every side runs from the same place.
`--without <measure>` (`session-hash`, `fetch-metadata`, `csp`, `epoch`; `all` for all four) switches one of the request path's
security measures off in one variant — counted, and refused when one still runs — so its cost shows on its own.

What one request cost the server at `0dd3448`, measured with `pnpm bench login` and `pnpm bench people` (`SESSION_ENCRYPT=false`;
median of 6 alternating runs, each the median of 3 × 10 000 requests) on an Apple M1 Pro (16 GB) with Node 26.10:

| Request | µs per request | without the four measures | at `f785159` |
| --- | --- | --- | --- |
| JSON visit of `/login` with a guest session — **the budget** | **≈ 117** | ≈ 115 | ≈ 141 |
| JSON visit of `/login` without a cookie (no session) | ≈ 87 | ≈ 85 | ≈ 112 (a session per request) |
| the `/login` document (HTML, CSP nonce) | ≈ 120 | ≈ 117 (without the CSP) | — |
| JSON visit of `/people` signed in (session, auth, queries, shared props) | ≈ 336 | ≈ 332 | ≈ 362 |

The measures cost, each switched off on its own: the session id's hash ≈ 0.3 µs per request with a cookie (`crypto.hash`), the
Fetch Metadata stage nothing on a GET (it checks unsafe methods only; ≈ 0.4 µs per POST), the CSP ≈ 1.5 µs per request (its
middleware) and ≈ 3 µs per document (the nonce, the header), the tab-sync epoch ≈ 0.9 µs per page (a memoized HMAC).
`SESSION_ENCRYPT=true` adds ≈ 9 µs to a request with a session (≈ 18 for `/people`): one decryption, one encryption.

What took the time back after `f785159` (CPU profiles, `pnpm bench login --profile --base f785159`): the cookie encryption moved
from WebCrypto (≈ 18 µs per call, three calls per page) to `node:crypto`; at most one copy of a response per request
(`editableResponse`, instead of four or five); the middleware list sorted once per route instead of per request; fewer
allocations in the container's lookups; the cookie headers serialized once; a cheaper request translator. Without the encryption
change the rest alone is level with `f785159`, within the noise.

## Rules over the source: `pnpm check:source`

A part of `pnpm run ci` (`scripts/check-source.ts`, its tests in `scripts/ci.test.ts`): rules a test of one package cannot see,
checked over every file of the repository — tracked, or new and not ignored. Exit 1 lists every hit as `path:line: text`.

1. **The old name is gone**: no file and no path says the framework's name from before 0.1.0, in any letter case.
   Allowed is the company name and its website's URL only (the `LICENSE` holder — every copy, the policies, the licence rule of `check-release`):
   nothing was released under the old name, so there is no rename hint. Code that must spell the old name — a test — builds it
   from parts (`['Bes', 'poke'].join('')`); the rule knows no file exceptions.
2. **No app installs a validation engine**: apps, the starter's template, the `make:auth` stubs, scripts and what the `make:*`
   generators write validate with `rules` of `@marmeon/validation` — no file outside a package's `src/` imports Valibot (in code or in
   a generator's template text), and no `package.json` of an app or of the template lists it. Inside `packages/<name>/src/` Valibot
   stays an internal engine. A test that must write the import builds the name from parts as well.
3. **`NODE_ENV` is checked positively**: no `!== 'production'` / `!= 'production'` (any quotes, either side), no
   `NODE_ENV === 'production'` and no `import.meta.env.DEV` / `!import.meta.env.PROD` (Vite derives them from `NODE_ENV ===
   'production'`: a build with any other value, or none, is `DEV`) in code people run or copy — a package's code
   (`packages/<name>/src/` and the stubs), the starter's template (`packages/create-marmeon/template/`) and the apps (`apps/<name>/`);
   tests, type tests and fixtures aside — comments count too. Either sends a missing `NODE_ENV`, which is production, down the
   development branch. Development branches ask
   `process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` inline (a client build folds it away), server code
   `environment.isDevelopment()` / `environment.isProtected()` of `@marmeon/core`.
4. **The old prefix of API tokens is gone**: `AUTH_TOKEN_PREFIX` defaults to `marmeon_`; no file says the two letters and the
   underscore of before in front of a digit, a `|`, a quote, whitespace or a line's end, anywhere. Tests spell it from parts like
   the old name.
5. **The docs speak to their readers**: no page under `docs/` carries the placeholder marker as a line of its own
   ([Writing documentation](#writing-documentation)) — every page is written. The pages, the packages' READMEs, the root
   `README.md`, the three policies the docs show (`UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`), what every new app copies
   (the starter's template `packages/create-marmeon/template/` and the packages' stubs `packages/<name>/stubs/`) and what a
   reader of one of the apps sees first (its `README.md` and `.env` files), and the website's own pages
   (`apps/website/modules/site/`) compare Marmeon with no other framework. Each part is
   an entry of `DOC_TEXT_RULES` with its pattern and the files it reads.
6. **The framework's messages speak to app developers**: no string of a package's code (`packages/<name>/src/`, tests and
   fixtures aside) or of its launchers (`packages/<name>/bin/*.js`) names a decision number, a wave or another framework —
   errors, warnings, solutions, command descriptions and output, the files the `make:*` generators write and the devtools'
   pages reach every app. Only strings count, read with oxc-parser; comments, names and regular expressions are rule 7's.
7. **No references to the private record**: no tracked file names a decision number (an `E` and two or three digits as a word
   of its own — a hex value, an exponent, `E2E`, `E.164` or `E164` is none), a wave or a step of the maintainers' plan, a
   personal date or a path into the maintainers' notes — a comment says what holds and links a page under `docs/`
   ([Comments](#comments)). `pnpm pack:check` holds every file of the packed tarballs to the same patterns.
8. **No mutant is switched off without a reason**: every `disable` comment of the mutation tester in code
   (`// Stryker disable next-line <Mutator>[, <Mutator>]: <why>`, also inside `/* */`; comments are read with oxc-parser, in
   Stryker's own grammar) names its mutators and gives a reason of at least three words after a colon directly behind them — why the
   mutant changes nothing anyone can observe. A range (`disable` without `next-line`) must be closed by `restore` comments
   covering every one of its mutators later in the same file and never covers `all`; `disable next-line all: <why>` needs only its reason.

9. **The internal subpath of a package is not API**: no code file outside `packages/<name>/src/` imports
   `@marmeon/<name>/internal` (the framework's own packages mark their routes with it). Apps, stubs, templates and scripts decide
   access with `everyone` or a check.

10. **Every deprecation shows the way forward**: each `@deprecated` tag in `packages/<name>/src/` (tests and fixtures aside) names
    the replacement (`Use {@link x}` or ``Use `x` ``), links the docs (`docs/<page>.md#<anchor>`, which the docs link test checks
    against the real page) and says when it goes (`Removed in x.y`):
    `@deprecated Use {@link isSensitiveRememberField}. Removed in 0.5; docs/forms.md#remembering-input.` Each
    `deprecated(id, message, removeIn)` call has three string literals: an id `<package>.<name>` whose package is the file's and
    that no other call uses, the message, and `removeIn` as `major.minor`. The version must lie after the current one — otherwise it
    is a typo or overdue. From 1.0 on it is a major version (`Removed in 2.0`). [Package development](docs/package-development.md#deprecating-an-api) shows both.

11. **Only the framework's packages import the query builder**: no code file outside `packages/<name>/src/` (apps, the
    template, stubs, scripts, the templates of `make:*`, the edits of an example) names `kysely` as a quoted module specifier —
    `import`, `import type`, `export … from`, `import()`, `require()`, `import.meta.resolve()`, any subpath such as
    `kysely/helpers/postgres` — and no code block of a docs page or README of a package, app or example imports it. No app or
    template manifest installs it: not as a dependency, an alias (`npm:kysely@…`), a bundled dependency or an override.
    Apps take the builder, `sql`, `Kysely` and `Transaction` from `@marmeon/database`. `UPGRADING.md` may show an old import.

A new rule joins the same script, with its test.

## Dependencies of drivers

A driver of another package, such as a queue driver for SQS, comes through the static record of its provider
(`static queueDrivers`), never through a change to the service's own package; see [drivers](docs/drivers.md).

Third-party driver libraries follow one rule. Each package README names the part that applies to it, with the exact install
command, and the [package development](docs/package-development.md#dependencies-of-drivers) page explains it to package authors:

1. A package that wraps exactly **one** third-party driver and is useless without it lists it in **`dependencies`**, at a caret
   range of the tested major: `@marmeon/redis` → `redis`, `@marmeon/validation` → `valibot` (its engine, never re-exported). The app
   installs the package, nothing else.
2. A package with **several** selectable drivers (usually with a built-in one) keeps the third-party drivers as **optional peers**,
   and its error names the **exact** install command with the major — `pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3`
   (storage), `pnpm add mjml@^5` (mail), `pnpm add pg@^8` (database). Where the driver is surely used (an S3 default disk, a
   Redis cache), the start fails with it, not the first request.
3. A library whose instance or types the app must **share** stays a **peer** — the OpenTelemetry API, React, Vite. A dependency would
   install a second copy, and the app's SDK would register on an API the framework never reads.
4. Decided exception: **`nodemailer` is a dependency of `@marmeon/mail`** — no dependencies of its own, the production path.
5. Decided exception: **`@simplewebauthn/server` is a dependency of `@marmeon/auth`** — passkeys are a required standard and their
   verification is security-critical, so a proven implementation; loaded only by `@marmeon/auth/passkeys`.
6. Decided exception: **`kysely` is an exact dependency of `@marmeon/database` and `@marmeon/table`** — no caret, the same version in
   both. The builder's shape is public API and the security plugins are tested against exactly this version; one pin in every
   package installs one copy. A Kysely update is a pull request of its own that changes both manifests. Once a week the
   workflow `.github/workflows/kysely-canary.yml` installs the newest Kysely under the `next` tag over that pin on its runner
   (nothing is committed), builds, typechecks and tests `database`, `table` and `queue`, and fails when something breaks or a
   new builder method or statement is unclassified. It is no required check and opens no issue: a red run is the cue to prepare the update. A version younger than the
   release-age gate of `pnpm-workspace.yaml`, or a `next` not newer than the pin, is skipped with a note in the run's summary
   (green). A schedule runs only on the default branch and GitHub disables it after 60 days without activity in the repository, so
   start the workflow by hand once after it merges. It runs
   code nobody pinned, so `pnpm check-release` holds it to a schedule and a manual start (never a pull request or a push), the
   `contents: read` permission and no secret, a checkout without credentials, actions pinned by SHA, and no cache, restored or saved.

A driver sub-package (`@marmeon/<package>-<driver>`) only when a driver brings its own code and configuration — ask first. Optional
peers on other framework packages (`@marmeon/queue` for `mailer.queue()`, `@marmeon/redis` for a Redis cache) are a different
thing: the coupling between the framework's packages. `pnpm pack:check` holds every packed manifest to the rule (`DRIVER_RULE` in
`scripts/packages.ts` — a new driver gets its line there), and `pnpm pack:smoke` boots the starter kit on the Redis drivers without
`redis` in its `package.json`, sends a mail over SMTP from the production install, and starts it with an S3 default disk and no AWS
SDK (the exact command, exit 1).

## Pull requests and releases

The framework is released in lockstep: every `@marmeon/*` package, the CLI `marmeon` and `create-marmeon` always have the same
version. Nobody writes a changelog entry: the release notes are made from the pull requests merged since the last release.

### Pull requests

- **One change per pull request.** Its **title is its line in the release notes**: in the imperative, saying what the change
  does, like a commit subject (`Add a dry-run flag to make:migration`, not `dry-run` or `Fixes #12`).
- **Exactly one label**, set by a maintainer at review, sorts it into the notes: `breaking` (an app has to change something),
  `feature` (something new), `fix` (a bug fixed), `docs` (documentation only) or `internal` (tests, tooling, refactoring — no
  line in the notes). The `release label` check fails a pull request with none or with two; contributors need not label.
  A `breaking` pull request says in its description what an app has to do — the release preparation turns that into the
  upgrade guide's entry.
- **Pull requests are squash-merged:** the title and `(#N)` become the commit's subject, and the pull request keeps its
  individual commits on GitHub. Merge commits and rebase merges are switched off.
- **Only release preparation writes the `CHANGELOG.md` files and the package versions;** a pull request that edits them is sent
  back at review. A breaking change's entry in the upgrade guide is written there too ([The upgrade guide](#the-upgrade-guide)).

### The API snapshot

Every package with an entry point has a `packages/<name>/api.md`: its public surface as the built `.d.ts` files emit it, so a
change to what an app can import shows in the pull request's diff. `pnpm api:check` (part of `pnpm run ci`, after the build)
fails on any difference; `pnpm api:update` builds and rewrites the files — commit them with the change that caused it. A
conflict in an `api.md` is never merged by hand: take either side, run `pnpm api:update`, commit.

Per entry point (every subpath of `exports` with `types`, except `./internal`) the file lists each exported declaration without
its comments, sorted by name: **Stable**; **Referenced, not exported** — the local helper types and `@internal` exports that a
public signature names, because their shape is public too; **Augments** — `declare module` and `declare global` blocks of the
files the entry reaches (a file belongs to the first entry that reaches it); **Experimental** — what is experimental (below).
Members and declarations tagged `@internal` are left out, a `@deprecated` declaration carries a `// @deprecated` line, and a
re-export from another package is the `export … from` statement (its declaration is in that package's snapshot). Below the
entry's heading, "Types from other packages" names the libraries whose types the entry's declarations mention.

Experimental has three forms, one source each: a whole entry point or package through `marmeon.experimental` in the
`package.json` (`true` for every entry point, variable and command of the package, or a list of subpaths such as
`["./client/adapter"]`); one option of an options interface through `@experimental` in the JSDoc of the member, which the
snapshot takes out of its declaration and lists as the item `<Declaration>.<member>`; one command through `static experimental
= true` on its class (`marmeon list` and `--help` say so). Experimental variables and commands stand in a section `## Experimental`
of the package. `pnpm api:check` fails unless `docs/releases.md` › "What is public API" › "Experimental" names every experimental
entry point (`@marmeon/x/y`), package and command (`marmeon tinker`) as inline code in a list item, and names nothing else. The helper types an experimental entry names but does not export are listed apart under "Experimental, referenced (not exported)", so a name nobody can import stays visible. `api label` does not
enforce Experimental, but moving something from Stable to Experimental removes it from the stable surface: label it `breaking`.

A class, function, constant or enum that an entry exports only as a type (`export type { Foo }`) carries a `// type-only` line:
an app can no longer `new` it. A public signature must not name a type of another package's `./internal` (no snapshot holds
its shape), and an entry cannot export a module of its own package as a namespace; `pnpm api:check` reports both. Stability is
transitive: a stable item — a stable declaration without its `@experimental` members, an augmentation or a re-export of a
stable entry — must not name a type that only experimental entry points export or that is marked `@experimental`, in its
own package or another one (the check walks through a helper type that no entry exports); `pnpm api:check` names the item,
the type and the file that declares it — mark the item or member `@experimental`, or name a stable type. A
`FOREIGN_TYPES` entry that no entry point of its package uses any more is reported, so it gets deleted with the change that
made it unnecessary.

An entry point may only expose the types of the libraries `FOREIGN_TYPES` in `scripts/api.ts` lists for its package (Node's
built-ins, `@marmeon/*` and `marmeon` are free); `pnpm api:check` fails otherwise. Each entry says why it is there — a peer the
app installs, or the change that removes it. Add an entry only for a peer, and give a type of your own to anything else.

The same file ends with the package's **Environment** and **Commands**, read from the built code of the providers its
`package.json` lists under `marmeon.providers` (`static config`, `static commands`) and, for the CLI, its built-in commands.
A variable shows its default as JSON, or `required`, or `optional`; a default that only a config's `resolve` sets is not
seen. A command shows its usage and its sorted options with their types — never its description, whose wording is no API.
Exit codes cannot be read from the code; tests secure them. A config whose `env` is not made by `env({ … })` fails
`pnpm api:check`, because its variables cannot be listed.

`pnpm api:usage <entry>` (for example `pnpm api:usage @marmeon/core`) lists, per export of an entry point from its `api.md`,
the docs, apps, kit files, neighbour packages and tests that import it outside the package, with a first guess — `keep`,
`testing`, `internal` or `drop` — for where the export belongs; `--files` names the importing files, `--json` prints the data.
An export that a public declaration of another entry or package names (`namedBy`) is always a `keep`, since an app would
otherwise meet it as a type it cannot import.

A pull request that changes an `api.md` needs matching labels. The check "api label" (`.github/workflows/api-label.yml`,
`scripts/api-label.ts`) compares the merge commit GitHub builds for the pull request with its first parent, `Experimental`
items left out — so what merged into the base meanwhile is not counted as its change. A **removed** entry needs `breaking`; a
removed `Referenced, not exported` item counts as a change, since an app cannot import it by name. A **changed** entry needs
`breaking`, or `api-compatible` when no app breaks — a loosened parameter, or a constructor that is only exported as a type
(core's `EnvString` and its kin), which no app can call anyway; `api-compatible` never covers a removal. A **new** entry needs
a release label other than `docs` and `internal`. Environment variables and commands are entries like any other. The check
reminds and does not protect — a pull request runs its own copy of the workflow, the review is the protection — and it runs on
untrusted code, so it holds no token and installs nothing: `pnpm check-release` keeps that shape, down to the files the script
may import.

### The upgrade guide

`UPGRADING.md` has a section `## Upgrading to <version> from <version>` for every breaking release. `pnpm check-release` (a part
of `pnpm run ci`) refuses a section that is not headed exactly so — level 2, the version as x.y.z, steps as `###` inside it; any
other heading that starts with "Upgrading to" or "Upgrading from" is refused. A section's `from` is the line directly below it
(for 1.0.0 any 0.y.z), its entries are listed in `UPGRADING_ANCHORS` (`scripts/check-release.ts`) and every listed entry must
stand under its release with its impact and its likelihood. A breaking release is a version `0.y.0` (y of 2 or more) or `x.0.0`
(x of 1 or more), and `check-release` asks for its section; a patch or a feature release asks for nothing. Prerelease versions
are refused. An entry is a `####` heading that starts with its impact (`#### High: …`, `Medium:` or `Low:`) under the section, and
a line `*Likelihood of impact: high|medium|low…` in its body.

### Preparing a release

Preparation is one command, again as often as needed. It needs a clean working tree, `HEAD` equal to `origin/<branch>` (`main`
or the maintenance branch) and an authenticated `gh` with write access to the repository (it asks GitHub to generate the notes):

```sh
git describe --tags --abbrev=0 --match 'v*'   # the last release
pnpm release:prepare --dry-run                # the version and the notes it would write; nothing written
pnpm release:prepare                          # write them and print the next steps
```

- **The version** comes from the last tag and the labels of the pull requests merged since: below 1.0 a `breaking` pull request
  makes a minor, anything else a patch; from 1.0 on `breaking` makes a major, `feature` a minor, anything else a patch. On a
  maintenance branch `breaking` is refused (it would leave the line). It stops while a merged pull request has no label and names
  it. Every published package gets the version and the same `## <version>` section on top of its `CHANGELOG.md` —
  `### Breaking changes`, `### Features`, `### Fixes`, `### Documentation`, new contributors, the full-changelog link. Sections of
  maintenance releases that `main` does not hold yet are carried over from their tags.
- **1.0 and release candidates:** `pnpm release:prepare --major` makes `1.0.0` from a 0.x release whatever the labels ask for
  (from 1.0 on it is refused: the labels decide); it says whether a merged pull request is `breaking`. `--rc` makes a release
  candidate `x.y.z-rc.N` of the version the labels (or `--major`) ask for: the first run `-rc.1`, a run after `v<x.y.z>-rc.1` is
  tagged `-rc.2`, and so on, for the same release. When the labels (or `--major`) come to ask for a higher release than the
  candidates lead to, they replace them: the version starts over (`--rc` at `-rc.1`), the log names the replaced candidates and
  their changelog sections stay. Candidates are made on `main` only. A run without `--rc` after a candidate makes the release itself. A
  candidate has its own changelog section, with the notes since the previous candidate; the release's section covers everything
  since the last release, and the candidates' sections stay below it. Only the release gets the `UPGRADING.md` heading. The
  deprecation check below sees the version already (`--major --rc` is refused for what `1.0.0` would be refused for). Other
  prereleases (`beta`, `alpha`) are not supported.
- **A breaking release** gets the heading of its `UPGRADING.md` section and a placeholder comment naming the pull requests.
  Replace it with one entry per breaking pull request (impact, before → after, the way back) and list the anchors in
  `UPGRADING_ANCHORS` **before** the printed `git add -A` and commit; `check-release` refuses the comment.
- **A release is refused while a deprecation is due:** every `@deprecated` tag or `deprecated()` call whose "Removed in x.y" is
  the release's version or an earlier one is listed with its path and line. Remove the API and its `deprecated()` calls with an
  entry in `UPGRADING.md`, or move the "Removed in" to the next breaking release. `--dry-run` refuses the same way.
- **`.github/release-base`** holds the version and the commit the preparation started from (`<version> <sha>`). The release
  commit has to sit directly on that commit; if another pull request merged in between, the release workflow refuses with
  "main moved after the release was prepared" — merge nothing else first, or run `pnpm release:prepare` again, which rewrites the
  section and the base.
- Then follow the printed next steps: a branch `release-<version>`, `git add -A`, the commit `Release <version>`,
  **`pnpm run ci`**, and a pull request titled `Release <version>` with the label `internal` (it is no line of the notes
  itself). To update an open release pull request instead, recreate its branch from `main` (`git switch -C release-<version>`),
  commit, and push with `--force-with-lease`; if the version changed (0.1.3 became 0.2.0 because a `breaking` pull request
  arrived), close the old one and open a new one.
- **A release pull request changes the release files only:** the package versions and changelogs, `UPGRADING.md`,
  `.github/release-base` and `scripts/check-release.ts` (the anchor list). The release guard refuses a release commit that
  changes anything else. A failure that `pnpm run ci` finds elsewhere is fixed in its own pull request, merged first; then run
  `pnpm release:prepare` again.

### Releasing

These are the maintainer's gates:

1. Merge the release pull request.
2. Start the *Release* workflow ("Run workflow") on `main`, or on the maintenance branch for a late fix of an older line.
3. Run `pnpm release:verify <commit>` — it rebuilds the release commit and compares its tarballs with the staged ones (below).
4. Approve the staged versions on npmjs.com with two-factor authentication.
5. Publish the draft GitHub Release.

The run releases the **release commit** — the last commit of the branch that changed a package's `CHANGELOG.md` or
`.github/release-base` — not the branch head, so whatever merged after it goes into the next release. The first job (`build`,
`contents: read`, **no** OIDC token) runs `scripts/release-guard.ts` before anything is installed: the
branch, the release commit (checked out, detached), one `x.y.z` or `x.y.z-rc.N` version, the same changelog section in every package,
`v<version>` not yet tagged, the version on no package of npm, the release base, the release commit changing release files only
and the dist-tag (a release candidate: `main` only, above npm's `latest`). Then `pnpm run ci --only build,pack:check,check-release`, and `scripts/release-pack.ts` packs every package
(`pnpm pack`) and writes `SHA512SUMS`; the tarballs and `SHA512SUMS` leave the job as an artifact (kept for a day), the hash of
`SHA512SUMS` as its output. The second job (`stage`, `id-token: write`, the only job in the `npm-release` environment) checks out nothing, installs nothing and runs no script
of the repository or of a dependency, so the code that runs in the first job never meets the OIDC token. It downloads the artifact, checks `SHA512SUMS` against the output and every tarball
against `SHA512SUMS`, and only then stages the tarballs `SHA512SUMS` names with `npm stage publish` (trusted publishing, OIDC,
no token in the repository; provenance) and prints `SHA512SUMS`. The hashes show that the staged files are the ones the first job
packed, not that the first job packed what the release commit builds — step 3 closes that gap. The third job (`release`,
`contents: write`, installs nothing) tags `v<version>` on the release commit (one tag per
release, none per package) and drafts the GitHub Release with the version's changelog section as its notes (a prerelease for a release candidate).

**Before approving (required):** the builds are reproducible, so a rebuild of the release commit must give the very tarballs npm
holds. The run's log has the commit's SHA; with an `npm login` session run `pnpm release:verify <commit>`. It rebuilds the commit in
a temporary worktree (your checkout stays as it is), downloads every staged tarball with `npm stage download`, compares the SHA-512
of each with the rebuilt tarball of the same name, flags staged packages without a rebuild and rebuilt ones that are not staged, and
exits 0 only when all match. That catches tarballs changed in CI (a compromised runner or action, a modified workflow), not a
compromised dependency in the lockfile: the rebuild uses the same lockfile. The log's `SHA512SUMS` (printed by the *stage* job) is
only a pointer to the right files: the log shows what the job checked, npm holds what will go live. Any difference — or a staged
package you cannot account for — means: do not approve. Reject the staged versions (`npm stage reject <stage-id>`; the command prints
the ids when the tarballs differ, otherwise `npm stage list` shows them) and look into the build job. By hand: `git switch --detach <commit>`, then
`pnpm install --frozen-lockfile && pnpm run clean && pnpm build && node scripts/release-pack.ts "$(mktemp -d)/tarballs"`, then
`npm stage download <stage-id>` per package (`npm stage list` shows the ids) and `shasum -a 512` against the rebuilt tarball.

Anyone with write access can start the workflow; the guards are conveniences and `check-release`'s check of the workflow files
is a review aid, not a barrier. The gate is the maintainer's two-factor approval on npm — nothing is public without it, and the
trusted-publisher configuration allows staging only, and only from the `npm-release` environment. npm accepts the OIDC token of
a run in that environment only, so a workflow started on another branch cannot stage. Set it up as follows (npm >= 11.15, an
`npm login` with 2FA, a maintainer's `gh`):

1. Create the environment (Settings › Environments) with deployment branches "Selected branches and tags": branch rules `main`
   and `*.x`, no tag rule, no secrets, no required reviewer — npm's 2FA approval is the gate. GitHub creates a referenced
   environment that does not exist *without* a branch policy, so never let the first run create it.
2. Verify the policy: `gh api repos/marmeon/marmeon/environments/npm-release --jq .deployment_branch_policy` must show
   `custom_branch_policies: true`, and
   `gh api repos/marmeon/marmeon/environments/npm-release/deployment-branch-policies --jq '.branch_policies[].name'` must list
   exactly `main` and `*.x`.
3. The "Protect Main" ruleset that covers `*.x` must include "Restrict creations", so only a maintainer can create a branch the
   environment admits.
4. Revoke each package's old trust: npm keeps one configuration per package, so `npm trust list <package>` and
   `npm trust revoke --id <id> <package>`.
5. Run `bash scripts/npm-trust.sh` (generated; passes `--environment npm-release`). It stops at the first package that still has
   an old configuration.
6. Verify: `npm trust list <package>` shows `environment: npm-release` for every package.

A package's very first version has to be published by hand, before
trusted publishing can be set up for it. The policies stay in place: the `LICENSE` holder, private reporting in `SECURITY.md`
and the deprecation policy in the README.

### A fix that comes late

- **The release pull request is still open:** merge the fix, run `pnpm release:prepare` again on `main` and update the release
  pull request's branch.
- **The release pull request is merged, the workflow not started:** run `pnpm release:prepare` again — for the same version it
  rebuilds the section from the previous tag to `HEAD` — and merge that small release pull request; its merge is the new release
  commit.
- **Staged, not yet approved:** reject the staged versions on npmjs.com and release the next patch (a candidate: the next one, `--rc`).
- **Released:** the next patch. A broken version is never unpublished; it is deprecated (`npm deprecate 'marmeon@0.2.1' 'Broken:
  use 0.2.2'`, for every package of the release).

### When a run fails

- **The guard, a check or the packing in the `build` job is red:** nothing was staged. Merge the fix through a pull request, run
  `pnpm release:prepare` again (any merge moves the release base), merge that release pull request and start the workflow again.
- **A hash check of the `stage` job is red** (before its first `npm stage publish`; the log says which line failed): nothing was
  staged, but the artifact is not what the `build` job hashed — do not re-run, look into the run, and start a new one.
- **The "stage the tarballs" step is red after a hash check passed:** treat it as possibly partly staged. Never re-run it:
  reject whatever was staged on npmjs.com and release the next patch (a candidate: the next one, `--rc`).
- **The tag step or the draft step failed after staging:** use **"Re-run failed jobs"** on the run. It repeats only the `release`
  job with the `build` job's outputs; nothing is staged again, a tag that already stands on the release commit is kept, and the
  draft is created. **Never "Re-run all jobs"**, and never start a new run after one that staged: a staged version is invisible
  to `npm view`, so the guards cannot see it.
- **If the re-run does not help,** or the workflow file itself was wrong (a re-run executes the same file again), approve on npmjs.com first, then tag and draft by hand (the release commit's SHA is in the
  run's log):

  ```sh
  git switch --detach <commit>
  notes=$(mktemp)
  git ls-remote --tags origin refs/tags/v<version>   # prints a line: the tag stands, skip the next two lines
  git tag -a v<version> <commit> -m v<version>
  git push origin refs/tags/v<version>
  node scripts/release-notes.ts <version> > "$notes"
  gh release create v<version> --draft --verify-tag --title v<version> --notes-file "$notes"   # plus --latest=false for a maintenance release, --prerelease for a candidate
  ```

### Maintenance releases

A **line** is `0.<minor>` before 1.0 and `<major>` from 1.0 on. Its branch is the line plus `.x` (`0.1.x`, `1.x`), cut from the
line's last tag; it releases versions of its line only. Each fix is cherry-picked from `main` as its own pull request into that
branch, with the same title and its own label so the notes find it. Then `pnpm release:prepare`, the release pull request and
the workflow run on that branch exactly as on `main`. The branch needs the same ruleset as `main`: the `release label` check,
squash merges only. Delete the branch when the line is done.

The dist-tag follows from the version: above npm's `latest` (or none yet) it is `latest`, and the draft is marked latest; below
it, `latest-<line>` (`latest-0.1`, `latest-1`) and the draft is not marked latest, so `latest` never moves back. `main` never
releases below `latest`, and a version equal to `latest` is refused. An app on an old line installs the exact version, or
`pnpm add @marmeon/core@latest-0.1`. The section of a maintenance release reaches `main`'s changelogs with `main`'s next
`pnpm release:prepare`.

### Release candidates

A release candidate (`x.y.z-rc.N`, prepared with `pnpm release:prepare --rc`) goes through the same workflow, staging and approval,
but only from `main` and only under the dist-tag `next`: never `latest`. Its draft GitHub Release is marked a prerelease, not the
latest release. `scripts/release-guard.ts` picks the dist-tag and the prerelease flag from the checked version alone
(`releaseTarget` in `scripts/release-rules.ts`); the workflow has no input, and `check-release` refuses one. The staging job checks
the pair again: a version with `-rc.` is staged as `next` only, any other version never as `next`. A candidate must be above npm's
`latest`; the release itself, `x.y.z`, is an ordinary release and takes `latest` from the candidates. To try one:
`pnpm add @marmeon/core@next`. The first release of a package is a plain `x.y.z`: on a first publish npm points `latest` at the version
whatever the tag, so the guard refuses a candidate while npm has no `latest`. After `x.y.z` ships, `next` still points at the last
candidate (below `latest`) until a maintainer moves or removes it (`npm dist-tag add|rm`, with two-factor authentication).

### The tarballs

- Packages are packed with **pnpm** only — `npm pack` and `npm publish` of a directory ignore `publishConfig.exports` and would
  ship the `@marmeon/source` condition, TypeScript sources Node does not strip under `node_modules` (`pnpm pack:check` proves the
  tarballs). A release stages the finished tarballs as files (`npm stage publish ./<name>.tgz`, from `scripts/release-pack.ts`
  and its `SHA512SUMS`), never a package directory.
- **`pnpm pack:check`** holds each tarball to these rules: no tests, type tests, `__fixtures__`, `test-helpers` or build info
  (`stubs/` and `template/` ship whole — generators and create-marmeon copy them into apps, tests included); no `dist/` file
  without its source in `src/` (a leftover of an earlier build) and every source map's sources in the tarball; `LICENSE` byte
  for byte the root's (`pnpm license:sync`) and a `README.md`; the packed manifest without the `@marmeon/source` condition and
  `workspace:` ranges, every internal dependency (optional peers too) at the package's own version; every `exports`/`bin` target
  in the tarball and none of them TypeScript source; MIT, a repository with the package's directory, `engines.node`, public
  access with provenance; the driver rule (`checkDriverRule` in `scripts/packages.ts`: one wrapped driver is a dependency, one
  of several an optional peer, a library the app must share one instance of — OpenTelemetry API, React, Vite — a peer); no
  reference to the private record. Then publint (warnings count) and attw with the `esm-only` profile (the packages are ESM
  only, so the CommonJS resolutions are not checked). `create-marmeon` has no dependencies at all — it is the first thing a
  stranger runs — and its template has no `.env` and no `APP_KEY` with a value. The root `tsconfig.json` references every package.
- `pnpm pack:smoke` makes a starter-kit app (pnpm) and a minimal one (npm) from the tarballs outside the repository and runs
  install, tests, lint, build without `.env`, and `marmeon start` as exactly one Node process, loading neither oxc-parser nor
  pino-pretty; the Redis step needs the Redis of `compose.yaml`. The apps live under `$TMPDIR`, with no `node_modules/@marmeon`
  or `pnpm-workspace.yaml` above them. On the starter kit it then applies the notes demo (`examples/notes`: `commands.json`,
  `files/`, `edits.json` — each `find` of an edit occurs exactly once, and only `marmeon <command>` lines run) and runs that app's
  tests, type check, lint, build and start; `--keep` leaves the app with a confirmed test user and a few notes to look at.
- A broken version is never unpublished; it is deprecated (`npm deprecate 'marmeon@0.2.1' 'Broken: use 0.2.2'`, for every
  package of the release) and fixed by the next patch.
- `scripts/npm-trust.sh` is generated (`node scripts/npm-trust.ts`) — the `npm trust github` call for every package, run once by
  a maintainer after the first publish.

## Inside the framework

What a contributor to the framework needs and an app never does. The exported functions and classes document themselves in their
sources; these are the rules that span several files.

### The entry points of `@marmeon/core`

Besides its main entry and the documented `@marmeon/core/diagnostics`, `@marmeon/core/dev` and `@marmeon/core/deprecation`
(`deprecated()` without the rest of the core, for client code) and `@marmeon/core/testing` (`TestClock` and `EventFake`, for a test
that builds its own container — the fakes of any package go to the `./testing` of their package, never to its main entry), the core
has three entry points that only the framework imports:

| Import | What |
| --- | --- |
| `@marmeon/core/internal` | what the framework's packages share and an app has no use for: injection analysis and embedding, the manifest, the file guard, the transaction frames, the request/job/task context, `messageBase`/`trace`/`publishEnded` of the diagnostics, `marmeonInjection()` (part of `marmeon()` in `@marmeon/vite`) and `CSP_NONCE_PLACEHOLDER`. Not API, outside semver; a name only a neighbour imports goes here, one nobody imports has no export |
| `@marmeon/core/environment` | `environment` and `resolveEnvironment` alone, without dependencies — what `marmeon` loads before anything else |
| `@marmeon/core/register` | the Node loader hook that writes the injection lists of app code. `marmeon` registers it in its own process (`module.registerHooks`) before a command loads; in a protected environment it takes `marmeon build`'s precomputed lists |

`pnpm api:usage @marmeon/core` shows who imports each export and suggests where it belongs.

### The source condition and the manifests

Inside this repository the packages resolve to their TypeScript sources through the `@marmeon/source` condition; a published
package does not carry it (`publishConfig.exports`). `marmeon` runs a command in its own process and starts Node a second time
only for what a running process cannot switch on: `node --watch` for `marmeon dev`, and the source condition when the CLI runs
inside this repository — a `pnpm-workspace.yaml` above it lists its directory among `packages`. Never for `marmeon start`, which
serves the packages' `dist/` here too. A copy of the CLI under `node_modules` (what `pnpm deploy` leaves) runs its `dist/` like a
published package.

Discovery writes one manifest per set of resolution conditions: `.marmeon/manifest.json` for the published packages and
`.marmeon/manifest.source.json` inside this repository, so switching between `marmeon dev` and `marmeon start` here rewrites
neither. Any other set gets its own file — Vitest adds `development`: `manifest.development+source.json`.

### The starter's template

`packages/create-marmeon/template/base` is `apps/blank-app`: change the blank app, then run `pnpm template:sync` — a test fails
while the two differ (`node scripts/sync-template.ts --check` names every file). The template stores `.gitignore` and
`package.json` as `_gitignore` and `_package.json` (npm turns a `.gitignore` into `.npmignore` when it packs, and a nested `package.json` in a
tarball confuses publint and bundlers; the scaffolder renames them back), makes `tsconfig.json` standalone, empties every `APP_KEY=` and leaves
`README.md` out — the scaffolder writes each app its own README and keys. `template/kit` holds what the starter kit adds: the
home module, the app's dialog, the look (`styles/app.css`) and, through `KIT_DEV_DEPENDENCIES` in `src/template.ts`, the font it imports as a dev dependency (kept equal to the website's).

`MARMEON_CREATE_TARBALLS=<dir>` makes `create-marmeon` take the framework from the tarballs of `pnpm pack` in that directory
instead of the registry. They are copied into the app's `vendor/marmeon/`, and every `@marmeon/*` dependency and `marmeon` point
there (`file:`), the packages' dependencies on each other too — through `overrides` in `pnpm-workspace.yaml` for pnpm, with
nothing hoisted and only for what gets installed (pnpm installs an overridden optional peer as if the app had asked for it), and
in `package.json` for npm, the optional peers nobody installs by absolute path (npm resolves a relative override from the
dependent's directory). A package the app adds later comes from its tarball:
`pnpm add ./vendor/marmeon/marmeon-redis-<version>.tgz`. That is how `pnpm pack:smoke` and `pnpm image:smoke` make their apps
before anything is published. It is not for apps: the variable never reaches the install and the generators.

The tests next to the kit's stubs (`packages/auth/stubs/react/modules/*/`) do not run where they lie: they import the app's paths, and the root `include` of Vitest takes no package's `stubs/`. They run once in `pnpm test`, in an app that `make:auth` writes: the starter kit in `packages/create-marmeon/src/kit.test.ts` ("the starter kit works"), on SQLite and, under `pnpm test:pgsql`, on Postgres. That one run also generates the routes, migrates, type-checks, lints (module boundaries on `modules/auth` and `modules/system`) and builds the kit. `pnpm pack:smoke` runs the tests again from the tarballs. `kit.test.ts` counts the passing tests of each `describe`, so a test added to one changes its count there. To run them alone: `pnpm test packages/create-marmeon/src/kit.test.ts`. Redis is covered by the copies of the modules in `apps/web-app`, so a change to a stub test belongs in its copy too.

### The client core and its adapters

A UI adapter — `@marmeon/react` is the one there is — is a rendering layer. Everything else lives in the UI-free client core,
`@marmeon/http/client`: the protocol, the history, the in-memory page cache, background requests and every security invariant.
What an adapter builds on is `@marmeon/http/client/adapter` (experimental as a whole); `@marmeon/http/client` keeps what an app uses —
the `hooks` and `tabSync` handles for `useFeature()` (typed `FeatureHandle`), `xsrfToken` and the types an adapter re-exports. Adapter code and the browser parts of other
packages import the core from these two entries only, never from `@marmeon/http/internal`; a name an adapter lacks goes into
`/client/adapter`. `packages/http/src/client/adapter.test.ts` is the proof, written against the two entries: a complete adapter in plain DOM visits, goes back and forward, loads
deferred props, reloads partially, follows a 409, and drives islands, layers, actions with their optimistic patches, flash
messages, the navigation guard, live validation, instant visits, remembered state and tab sync between two tabs — with no UI
framework anywhere. New protocol, visit, region or cache logic goes into the core first, with its case in that test, then into
the React hook, then into the default component.

An adapter provides:

1. **Rendering a page object.** `new Navigator({ initialPage, render, confirm, revalidateOnBack })`, then `navigator.start()`.
   `render(page, { preserveState, owner, layers, placeholder, transition })` shows the page and resolves once it is on screen —
   the navigator restores the scroll position after that; a rejection makes the browser load the URL itself. Islands render
   from `navigator.use(islands).region(url, { owner })` and their snapshots, layers in a modal frame with a page context of
   their own; render `layer.view` and a region's `snapshot.region`, which carry the optimistic patches. Flash messages come from
   `navigator.on('flash')`, never from props.
2. **Persistent layouts**, with error boundaries inside them.
3. **Head management** through a `TitleRegistry`; on the server the head is recorded for the SSR entry.
4. **The SSR renderer** (`SsrRender` of `@marmeon/http/page`): it resolves with the shell — the whole page with `complete` — and
   rejects when the shell cannot render. Each eager island and each streamed deferred group renders behind a boundary of its own,
   with its result in an inert JSON data block (`scriptJson`); groups inside a host element, returned as `streamedProps`.
5. **The hydration entry:** `readInitialPage()`, the component and the messages resolved before hydrating, `hasServerMarkup(root)`
   to hydrate or render. Without the Navigation API, `loadHistoryFallback()` in the same round trip, passed in `features` before
   the navigator writes its first entry.
6. **Hooks and components** over the navigator. Form state — values, errors, `processing` — stays per adapter; the core gives it
   the requests, the validation, the guard and the memory.
7. **Its route sinks:** every place where app code hands the adapter a route name is a row in `ROUTE_SINKS` of `@marmeon/vite`,
   so the client build ships only the names written out there.

`@marmeon/react` has no provider: `"marmeon": { "browser": ["src/**"] }` marks every source as browser code, so discovery
registers nothing for it and `marmeon package:build` embeds no injection lists. A test bundles it for the browser and fails on any module
outside its own sources, the client core and its adapter entry, `@marmeon/http/page`, `@marmeon/http/protocol` and `@marmeon/router/url`, and on any npm package but React.

### Client features

The navigator alone is the fixed core. Everything optional is a feature, and `NavigatorOptions.features` is empty by default. A
feature is attached where it is used (`navigator.use(feature)`), loaded on first use as a chunk of its own
(`navigator.load(loader)`), loaded beside the first page by default (tab sync, the History fallback), or loaded by the core when
an answer of the server needs it (the layers, live props). A new feature:

- is `defineFeature(name, setup, order?)`: `setup(host)` runs once per navigator, hooks into the pipeline with `host.on(…)` and
  returns what adapters use of it;
- keeps what came from the server or the user **only in slots** — `host.entry(slot, key)` per history entry,
  `host.document(slot)` per document. The core empties an entry's slots when memory lets go of it and every slot when the document
  is left (every 409), so nothing of a signed-in user outlives a sign-out;
- writes a history entry's state only through `host.history`, which takes positions and the fields registered with
  `host.history.field(name, check, value?)`. Anything else throws in development and is left out in production: no props in
  `history.state` or browser storage;
- joins `ALL_FEATURES` in `packages/http/src/client/security-matrix.test.ts` (every feature × every event that must forget) and
  gets markers in the leak test of `packages/react/src/bundle-size.test.ts`, so it is in a bundle only with its own import.

What any answer may need stays in the core, and so does every security invariant: the visit pipeline, Back and Forward, scroll
restoration, the page cache and the history writer; the 409 that leaves the document, empties every slot and aborts every request;
once, flash, deferred, merged and streamed props; a visit's own `confirm` and its optimistic patches; the `RegionOwner` of each
entry on screen. The devtools' hook (`globalThis.__MARMEON_DEVTOOLS_HOOK__`) is called only under an inline positive `NODE_ENV`
check, so a production build drops the calls.

### The bundle sizes

`pnpm size` reports each scenario in KB gzip of the initial download, measured in Vite's app mode
against `dist/` — minified, with production defines, without React, i18n and Vite's preload helper:

| Scenario | What |
| --- | --- |
| `core` | the client core as an adapter uses it: the navigator, the document, links, forms, routes, titles, messages |
| `emptyApp` | `createMarmeonApp` alone — an app without a page |
| `minimalApp` | `createMarmeonApp`, `Link`, `useForm`, `usePage`, `Head` |
| `everything` | all of `@marmeon/react`'s main entry |
| `table` | `createMarmeonApp` and `useTable` |
| `blank-app`, `web-app`, `website` | the real apps' client builds: the marginal cost of core and adapter in their initial load (React and the app's code do not move it) |

- `pnpm size` prints the table; the `size` check measures this commit and the pull request's base commit (a worktree of it,
  installed from the lockfile and built) and writes base, this commit and the delta into the job summary. There is no limit: it
  fails when a build or a measurement breaks, never for a size. `pnpm size --base <ref>` does the same locally (an install and a
  build of that ref).
- `bundle-size.test.ts` is also the **leak test**: every feature has markers (its modules) and must be in a bundle only with its own import —
  a lazy one only in a lazy chunk.
- `pnpm size web-app` (or a scenario name) attributes every byte to its module (source maps) and gives the marginal cost of core
  and adapter.
- `marmeon()` splits an app's first download into a `vendor` and an `index` chunk (`CLIENT_CHUNKS` of `@marmeon/vite`), initial
  modules only; the scenarios are built the same way.

### Lint

The repository lints itself with `pnpm lint` (`oxlint --deny-warnings`, part of `pnpm run ci`): the root `.oxlintrc.json` has
oxlint's correctness rules as errors, plus `no-import-type-side-effects`, and turns a few off with a reason — unused private
brands such as `readonly #event = true`, deliberate copies before deleting while iterating, `this` aliases that walk a parent
chain. The apps carry the preset of `marmeon make:lint-config` — `apps/web-app` with `--boundaries`, `apps/blank-app` without —
which oxlint takes for their files instead: nested configs replace, they do not merge.

The generated preset is long on purpose. oxlint matches import specifiers as text, so whether an import leaves its module
depends on the folder depth, and the preset has one override per depth. Its patterns are gitignore globs with negations
(`!../*/index.*`), because oxlint's `regex` has no lookaround and drops a pattern it cannot compile without a word; the
generator's test lints a fixture app to prove every pattern fires. The `make:auth` fixture test lints the generated module with
and without `--boundaries`.

## Comments

A comment earns its place by saying what the code cannot. Try a better name or a smaller function first; what is left to say
follows these rules. No check reads a comment's quality — the review does.

What stays:

- **JSDoc on exported API** — the hover an app developer reads: one or two sentences on what it does, plus only what is not
  obvious (the default, when it throws, a security note). For more, link the docs page instead of retelling it.

  ```ts
  // Good
  /** Signs `url` for `hasValidSignature()`, valid until `expires`. See docs/urls.md#signed-urls. */
  // Bad: the page retold, line by line
  /** Signs the URL. The signature is an HMAC over the path and the query, the key is APP_KEY, the expiry … */
  ```

- **The why**, where the code would otherwise look wrong: a security invariant, a race, a browser or driver quirk, a deliberate
  deviation — one to three lines.

  ```ts
  // Good
  // Compare in constant time: an early exit would tell how much of the token matched.
  // Bad
  // Compare the tokens.
  ```

- **A file header** only when the file's role is not clear from its name and exports — a few lines. Good: "Vitest global setup:
  a temporary directory per run, and a red run when a test leaves an entry in it." Bad: a header that lists the exports.

What goes:

- **History and derivation** — "used to", "after the review", "we decided", "since", who wanted what when. Git keeps the
  history. Bad: `// Not cached any more since the logout bug.` Good: `// Not cached: a cached copy would outlive a sign-out.`
- **Narration of the next line.** Bad: `// Increment the counter` above `count++`. Good: no comment — or the reason, if there is
  one: `// Counted before the await, so a second request sees it.`
- **References to decisions, plans, findings and people** — `pnpm check:source` refuses them (rule 7). Bad:
  `// Changed as the review asked.` Good: `// Claimed in one statement, so two workers never take the same job.`
- **Essays about behaviour.** What an app developer needs to know belongs on the docs page — move the sentence there, in the
  same commit; the rest goes. Bad: twenty lines on every option in a config file. Good: one line and
  `docs/queues.md#connections-and-drivers`.
- **Duplicate JSDoc** on an interface and its implementation, or the same text on every overload. Document it once, where the
  reader hovers. Bad: the same paragraph above `interface Mailer` and `class SmtpMailer`. Good: the interface's only.
- **Comments in tests that repeat the test's name.** The name says what is checked; a comment explains only setup that is not
  obvious. Bad: `// it logs out` inside `it('logs out')`. Good: `// Two processes on one database file: the lock must hold
  across them.`

**Security invariants stay.** A comment that says what must never happen, or in which order something must run, may be
shortened, never deleted.

## Writing documentation

The docs under `docs/` are the framework's documentation: one page per topic, in the order `apps/website/docs.config.ts` lists
them. They are the only source, written in English for people who build apps. **A change to a public API, an environment
default or a command changes its docs page in the same commit.** No check compiles the examples, so that commit is where they
stay true. Comments in the code follow [Comments](#comments).
`pnpm website:dev` shows the pages on http://localhost:3970. `docs/installation.md` and `docs/routing.md` are the model for every
other page.

- **Structure.** `# Title`, then `## Introduction`: what the feature is, what it is for, and a first example, in one to three
  paragraphs. Then the sections, from the common to the rare. A short `## Testing` section at the end only where it helps — it
  links to the Fakes page instead of repeating it.
- **One example per section** — a file and what goes with it, such as a route and its controller. Derive examples from real
  code: `apps/web-app`, the starter's template and the `make:auth` stubs. Compile a complex example once in a temporary file in
  `apps/web-app`, and delete the file again.
- **Titles and imports.** A code block with a title names its file — the fence reads ```` ```ts title="modules/notes/routes.ts" ````
  — and is complete enough to copy, imports included. A block without a title may continue an example of the same page, and
  leaves out the imports the page has already shown.
- **Tone.** Address the reader as "you", in the present tense and the active voice. One idea per sentence. No chains of
  parentheses, no strings of abbreviations, no marketing adjectives. No decision numbers and no wave numbers, and no comparisons
  with other frameworks: a page stands on its own.
- **Callouts, sparingly** — at most about one per section: `> [!NOTE]` for extra knowledge, `> [!WARNING]` for security and data
  loss, `> [!TIP]` for a shortcut.
- **Security defaults** get two to four sentences: what the default does, why, and how to change it on purpose.
- **Configuration** is a table with the columns Variable, Default and Effect. The default is the one in the code's schema.
- **Links** are relative links to other docs pages: `[route model binding](routing.md#route-model-binding)`. Link to an anchor
  only on a page that is written; a page still marked pending gets a link without one. Never link to a package README or a
  source file — a reader of the website cannot follow it.
- **Placeholders.** Every page is written: `pnpm check:source` refuses a page that carries `<!-- docs:pending -->` as a line
  of its own. While you write a new page, the marker on line 2 marks it "draft" in the navigation of `pnpm website:dev` (the website
  removes the line); delete it before you commit.
- **Code that names a page** — a solution's `docs`, an error message, a comment — names its repository path with the anchor:
  `docs/migrations.md#running-migrations`. A test of the website (`apps/website/modules/docs/links.test.ts`) follows every such path
  in the packages' code, the stubs, the starter's template, the apps, the package READMEs and the root README to its page and
  anchor, refuses a path to a package README, and refuses a page without its anchor outside the READMEs (which list pages).
- **Length:** as long as the topic needs. A page past about 600 lines probably wants splitting — propose it rather than
  splitting on your own.
- **Package READMEs are cards for npm**, not documentation: one sentence on what the package is, how to install it (or that a
  new app has it), one short example taken from its docs page, the page's links and the licence line. npm shows a README without
  the repository, so a card links with absolute website URLs
  (`https://marmeon.com/docs/<slug>#<anchor>`) — the website's links test checks each page and
  anchor. A package that needs a third-party driver names the exact install command. Everything else belongs on a docs page.

When the code and a README disagree, the code is right: describe what it does, and report the difference (or the bug) rather
than writing around it.

## Reporting a vulnerability

Never in a public issue — see [SECURITY.md](SECURITY.md).
