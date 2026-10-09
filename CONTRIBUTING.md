# Contributing to Marmeon

Thank you for helping. This page covers the rules for a contribution: the sign-off, the checks and changesets. It says how a
release is made, and what the repository holds that the documentation does not: its layout, its own test suites and
benchmarks, and the inside of the framework's client. The principles the framework is built on are in the [README](README.md#principles); the
documentation is under `docs/` ([Writing documentation](#writing-documentation)).

## Sign your commits off (DCO)

Marmeon takes contributions under the [Developer Certificate of Origin 1.1](https://developercertificate.org/) (DCO), as the
Linux kernel and Node.js do — no contributor licence agreement. With the sign-off you certify that you wrote the change or have
the right to submit it under the project's licence (MIT, `LICENSE`; copyright BespokeCode). Every commit of a pull
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

## Before you open a pull request

```sh
pnpm run ci            # every check CI runs: build, typecheck, lint, the test suites, sizes, types, docs, tarballs, image, release
```

`pnpm ci` without `run` is pnpm's own clean install — it checks nothing. The run has 15 parts (`pnpm run ci --list`;
[The repository](#the-repository) names them); some of them: `pnpm run ci --only test,lint`. `pack:smoke` and `image` need the
package store, the registry and Docker — without them they are reported as skipped, which is not green.

- **Tests** come with the change — type guarantees as `@ts-expect-error` tests, behaviour in Vitest, a feature shown in
  `apps/web-app` (principle 9).
- **The bundle-size limits only go down** (`packages/react/size-budget.json`) — raising one is the maintainers' decision, and
  new bytes are paid for by savings first. A saving lowers a limit to the new size + 0.5 KB
  (`MARMEON_SIZE_BUDGET=update pnpm test packages/react`, `… pnpm size`); extra cost eats that reserve, which is never refilled
  ([The size budget](#the-size-budget)).
- **Tests leave nothing behind:** every run gets its own temporary directory (`TMPDIR`), and `pnpm test` fails with a list when a
  test leaves a `marmeon-*` entry in it. Make temporary directories with `tempDir('marmeon-…')` (`scripts/test/temp-dir.js`): it
  removes them when the test, or the file, is done.
- **A measure comes with its Gegenproben** ([below](#gegenproben)).
- **`pnpm check:source` holds** — the rules over the repository's own files ([next section](#rules-over-the-source-pnpm-checksource)).
- **A change an app can notice** gets a changeset ([Changesets and releases](#changesets-and-releases)) and, from the first
  release on, an entry in [UPGRADING.md](UPGRADING.md) — impact, before → after, the way back — in the next version's section, in
  its place by impact and area; `scripts/check-changesets.ts` lists its anchor under that version. Until the first release there
  is nothing to upgrade from: the page says so and holds no entry.
- **A change to a public API, an environment default or a command** changes its page under `docs/` in the same commit
  ([Writing documentation](#writing-documentation)).
- Code, comments and commit messages are in English; a commit subject says what the change does, in the imperative.

## The repository

```text
packages/*        the framework's packages, each with a short README for npm
apps/web-app      the app every feature is shown and tested in
apps/blank-app    an app without modules: what create-marmeon --minimal writes (pnpm template:sync), and what make:auth is tested against
apps/docs         the documentation as a Marmeon app: docs/*.md and the policies at the root (pnpm docs:dev; apps/docs/Dockerfile, deploy/docs)
docs              the documentation's pages, in the order apps/docs/docs.config.ts lists them
scripts/ci.ts     pnpm run ci — its 15 parts, from the build to the release rules (below)
scripts/bench     pnpm bench — the start and the request path, measured (never a gate)
scripts/gegen     pnpm gegen — the Gegenproben of each step: a measure taken out, its test red for its reason (never a gate)
scripts/test      the test suite's temporary directory per run and tempDir() — the repository's own, not exported by a package
                  (pnpm test fails when a test leaves an entry behind)
deploy/docs       the docs' Compose file and Caddyfile (one server)
UPGRADING.md      what changes for apps from one version to the next
.changeset        Changesets: the pending changes, one fixed group (pnpm changeset; scripts/check-changesets.ts checks the release rules)
.github/workflows ci.yml (pnpm run ci in six jobs) and release.yml (the version pull request, then staged publishing)
```

```sh
pnpm run ci            # everything, as CI runs it (pnpm ci without `run` is pnpm's clean install)
pnpm test              # the test suite; test:pgsql, test:redis, test:s3 against the containers (docker compose up -d)
pnpm docs:dev          # the docs on http://localhost:3970
pnpm docs:image        # the docs' image (apps/docs/Dockerfile): built, run read-only and behind Caddy (deploy/docs) — part of `image`
pnpm pack:check        # the tarballs: clean build, pnpm pack, no tests or leftovers, LICENSE, exact versions, publint, attw
pnpm pack:smoke        # create-marmeon from the tarballs, outside the repository: the starter kit (pnpm) and a blank app (npm) — install, tests, lint, build, start
pnpm template:sync     # apps/blank-app → the template of create-marmeon (a test fails while they differ)
pnpm changeset         # a changeset for your change (below); pnpm check-changesets checks the release rules
pnpm gegen w10/s05     # the Gegenproben of a step (below): every case red for its reason; --control: all green without the patches
pnpm csp:probe --app apps/web-app --build   # a built app in headless Chrome under style-src 'self': 0 CSP violations (never a gate)
```

`pnpm run ci` runs 15 parts one after the other, each with its exit code and time, and fails when one is red: `build`,
`typecheck`, `lint`, `check:source` ([below](#rules-over-the-source-pnpm-checksource)), `test`, then `test:pgsql`, `test:redis`
and `test:s3` against this repository's containers (`compose.yaml`, started as needed), `size` (the bundle limits —
[The size budget](#the-size-budget)), `types:check` (the apps' generated route and table types are current), `docs:check`,
`pack:check`, `pack:smoke`, `image` (the starter kit's image from `make:docker`, then the docs' image) and `check-changesets`.
`pack:smoke` and `image` without a package store, the registry or Docker are reported as skipped, never as green.
`--only a,b`, `--skip a,b`, `--bail`, `--no-compose` (the databases already run) and `--list` choose; `ci.yml` splits the parts
into six jobs that run side by side (the checks, the tarballs, the image, Postgres, Redis, S3).

### The test suites against real services

`pnpm test` runs every package's tests and the web app's on SQLite and in memory. Each run gets a temporary directory of its own
(`TMPDIR` points into it) and fails when a test leaves a `marmeon-*` entry behind; the framework's tests make theirs with
`tempDir()` of `scripts/test/temp-dir.js`. The cases for other backends run when their variable is set — the services come from
`compose.yaml` (`docker compose up -d`, ports of their own):

```sh
pnpm test:pgsql   # MARMEON_TEST_PGSQL_URL, DB_CONNECTION=pgsql and DB_URL → postgres://marmeon:secret@localhost:55432/marmeon
pnpm test:redis   # MARMEON_TEST_REDIS_URL=redis://127.0.0.1:56379
pnpm test:s3      # MARMEON_TEST_S3_ENDPOINT=http://127.0.0.1:56333 — packages/storage only
                  # (MARMEON_TEST_S3_KEY / MARMEON_TEST_S3_SECRET default to the compose identity)
```

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
pnpm bench login --base f785159 --without w8          # the request path, A/B: this checkout against a commit, each side in a git worktree
pnpm bench people                                     # GET /people signed in
pnpm bench login --profile --base f785159             # CPU profiles of the measured requests: top lists (self, inclusive) and their diff
```

The request benchmarks boot the web app in-process (SQLite in memory, `SESSION_DRIVER=memory`) and send the requests through the
kernel as a browser would — the cookies as the server set them, the body read; none of the test helpers' work per response. Each
side runs from a `git worktree` under `$TMPDIR/marmeon-bench/` (this checkout as a snapshot with its uncommitted changes; before a
run each one must import what a measured process imports — a missing module reinstalls its `node_modules`), the sides
alternate in fresh processes, and the report gives the median, the mean's 95 % confidence interval and Welch's test per pair.
`--without <measure>` (`session-hash`, `fetch-metadata`, `csp`, `epoch`; `w8` for all four) switches one of the request path's
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
   Allowed is the company name only (the `LICENSE` holder — every copy, the policies, the licence rule of `check-changesets`):
   nothing was released under the old name, so there is no rename hint. Code that must spell the old name — a test, a
   Gegenprobe — builds it from parts (`['Bes', 'poke'].join('')`); the rule knows no file exceptions.
2. **No app installs a validation engine**: apps, the starter's template, the `make:auth` stubs, scripts and what the `make:*`
   generators write validate with `rules` of `@marmeon/validation` — no file outside a package's `src/` imports Valibot (in code or in
   a generator's template text), and no `package.json` of an app or of the template lists it. Inside `packages/<name>/src/` Valibot
   stays an internal engine. A test or Gegenprobe that must write the import builds the name from parts as well.
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
5. **The docs speak to their readers**: the pages under `docs/`, the packages' READMEs, the root `README.md` and the three
   policies the docs show (`UPGRADING.md`, `CONTRIBUTING.md`, `SECURITY.md`) name no decision number (an `E` and two or three
   digits as a word of its own — a hex value, an exponent or `E2E` is none) and compare Marmeon with no other framework; the
   pages, the READMEs and `UPGRADING.md` name no wave of the maintainers' plan (a `W` and a number, or "wave" and a number) —
   this file may, for the Gegenproben's paths and steps; and no page under `docs/` carries the placeholder marker as a line of
   its own ([Writing documentation](#writing-documentation)) — every page is written. What every new app copies, the starter's
   template (`packages/create-marmeon/template/`) and the packages' stubs (`packages/<name>/stubs/`: the `make:auth` module, the
   migrations of `make:*-table`), carries no decision number, no wave, no personal date of the plan ("Max 07.10.") and no
   other framework. `UPGRADING.md` says what changed by version and by what it changes, never by decision or wave. Each part
   is an entry of `DOC_TEXT_RULES` with its pattern and the files it reads.
6. **The framework's messages speak to app developers**: no string of a package's code (`packages/<name>/src/`, tests and
   fixtures aside) or of its launchers (`packages/<name>/bin/*.js`) names a decision number, a wave or another framework —
   errors, warnings, solutions, command descriptions and output, the files the `make:*` generators write and the devtools'
   pages reach every app. Only strings count, read with oxc-parser: comments, names and regular expressions are for
   maintainers and may keep their decision numbers.

A new rule joins the same script, with its test and its Gegenprobe.

## Gegenproben

A test that passes proves little until it fails without the thing it tests. A *Gegenprobe* (counter-check) takes a measure out —
a patch — and shows the test turning red **for the measure's reason**. They live in the repository, one file per step of a wave
(`scripts/gegen/w10/s05-queue.ts`, `scripts/gegen/w9/s04-live.ts`) and run with `pnpm gegen` — never as part of `pnpm run ci`
(they patch the working tree; `scripts/ci.test.ts` keeps them out):

```sh
pnpm gegen --list                 # waves, steps, cases
pnpm gegen w10/s05                # one step: every case must be red, for its reason
pnpm gegen w10/s05 G1 G2          # some cases
pnpm gegen w10                    # the whole wave, in step order
pnpm gegen w10 --control          # without the patches: every case must be green
pnpm gegen w9 --control           # an older wave's control stays green — its anchors move with the code
pnpm gegen w10 --repo <checkout>  # against another checkout (a fresh git worktree)
pnpm gegen w10/s05 G1 --verbose   # print every run's output
```

### The format

A step's file default-exports `defineGegenproben({ step, cases })` (`scripts/gegen/define.ts` checks it when it loads: unique ids, a
reason for every red case, pairs that exist, patches inside the repository). A case names its patches, its run and its reason — a
real one, from `scripts/gegen/w9/s04-live.ts`:

```ts
import { defineGegenproben } from '../define.ts';

const HUB = 'packages/live/src/hub.ts';
const SESSION_LIMIT = { file: HUB, find: '    if ((this.#sessions.get(request.scope)?.size ?? 0) >= this.#perSession) {', replace: '    if (false) {' };

export default defineGegenproben({
  step: 'W9.4',
  cases: [
    {
      id: 'G1',
      title: 'no limit per session: the 17th stream of one session opens (200 instead of 429)',
      patch: [SESSION_LIMIT],
      run: { vitest: 'packages/live/src/live.test.ts', name: 'holds at most LIVE_MAX_STREAMS_PER_SESSION streams of one session' },
      expect: /expected 200 to be 429/,
      masks: 'G2',                                       // its masking pair: the atomic count (G2), each red on its own
    },
    // { id: 'G1c', …, expectGreen: true }              — a masking probe: one measure alone still holds
    // { id: 'G9', …, run: { command: ['pnpm', 'run', 'ci', '--only', 'pack:check'] }, expect: /orphaned/ }   — a command instead of Vitest
  ],
});
```

- **`patch`** — `{ file, find, replace }`, relative to the repository's root; `dist/` files too (after `pnpm build` — what
  `pack:smoke` packs). Each `find` must occur exactly once (after the case's earlier patches of the same file), or nothing is
  patched. A case's patches are applied all or none and taken back in reverse order — also on Ctrl-C; afterwards every file has its
  old hash and `git status` is unchanged, or the runner stops (exit 3).
- **`run`** — `{ vitest: file(s), name }` runs the repository's `pnpm test` with the name as a filter: plain text, the runner escapes
  it for `-t` (a regular expression); Vitest matches it against the full name, the describes joined with ` > `
  (`'every page > runs no inline script'`). Or `{ command: [...] }`: any command in the root, exit 0 is green. Both take `env` and a
  `timeout` (default 10 minutes).
- **`expect`** — the reason, matched against the failures' messages (the lines before the stack) or the command's output — not a
  matcher's name: Vitest says *expected 1 to be 2*, not `toBe`, and shortens long values with "…" (cut the reason to their start, or
  give the assertion a message of its own: `expect(problem, problem)`).

### Reading the result

Each case ends as one of: **red** (the reason matches) · **GREEN** — the measure has no effect, or the test does not test it · **red
for another reason** — does not count · **0 tests** — the name matched nothing (never red, never green) · **anchor problem** — a
`find` that is missing or not unique. The summary counts "n of m red (the reason matches), k masking probes as expected"; the exit code
is 0 when every case is as expected, 1 when one is not, 2 for a usage error, 3 when the working tree could not be put back exactly
(stop and look: `git status`), 130/143 after Ctrl-C/SIGTERM (the patches are taken back first).

- **Masking:** two measures that hide each other (a session lock and a cookie lock, a projection and a props filter) get a scenario
  each — `masks: 'G2'` pairs them, and both must be red on their own; a masking probe (`expectGreen: true`) shows that one measure
  alone still covers the case, and is counted apart.
- **The control** (`--control`) runs every case without its patch: all green, or the Gegenprobe proves nothing.
- **`--repo <checkout>`** patches and runs another checkout — the acceptance of a wave runs the whole wave in a fresh `git worktree`
  (no `.env`, `storage/` or `.marmeon/`), with and without `--control`.
- **Anchors age:** a later change can move a case's `find`; the anchor check says which, before anything is written. A change that
  moves an anchor of an older wave updates it in the same commit — `pnpm gegen w9 --control` and `pnpm gegen w10 --control` stay
  green. A case red for another (correct) reason after a later step — read the message, then correct the reason, never just count
  "red". A case whose measure is gone is removed, and a comment in its file says why.
- **Masked by the repository:** a dependency check inside the monorepo stays green (workspace links, devDependencies) — patch the
  packed manifest or `dist/` and run `pack:smoke`, with a masking scenario where the app installs the library itself.
  The old name and the validation engine in a patch or a reason are built from parts or written `[v]alibot` (`check:source` reads
  `scripts/` too).
- Never edit the repository while `pnpm gegen` runs, and never run it beside `pnpm test:pgsql`/`test:redis` (shared databases).

## Dependencies of drivers

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

A driver sub-package (`@marmeon/<package>-<driver>`) only when a driver brings its own code and configuration — ask first. Optional
peers on other framework packages (`@marmeon/queue` for `mailer.queue()`, `@marmeon/redis` for a Redis cache) are a different
thing: the coupling between the framework's packages. `pnpm pack:check` holds every packed manifest to the rule (`DRIVER_RULE` in
`scripts/packages.ts` — a new driver gets its line there), and `pnpm pack:smoke` boots the starter kit on the Redis drivers without
`redis` in its `package.json`, sends a mail over SMTP from the production install, and starts it with an S3 default disk and no AWS
SDK (the exact command, exit 1).

## Changesets and releases

The framework is released in lockstep: every `@marmeon/*` package, the CLI `marmeon` and
`create-marmeon` always have the same version — one `fixed` group in `.changeset/config.json`.

```sh
pnpm changeset         # pick any package and the bump; the fixed group carries the others along
```

- **0.x:** `minor` for a breaking change, `patch` for everything else. A `major` changeset would jump to 1.0.0 — `pnpm run ci`
  (`scripts/check-changesets.ts`) refuses it below 1.0.0. 1.0 comes after the reference app.
- **The upgrade guide** starts with the first release. Until then `UPGRADING.md` is a short page without entries, and
  `check-changesets` refuses an entry that stands under no release. The first `## Upgrading to <version> from <version>` section
  switches the requirement on: `check-changesets` refuses it until `UPGRADING_ANCHORS` lists its entries under that version, and
  from then on every listed entry must stand under its release, with its impact and its likelihood. Head a release's section
  exactly so — level 2, the version as x.y.z, steps as `###` inside it: under any other heading the check sees no release, so an
  entry there is refused as standing under no release and a section without entries goes unnoticed.
- **How a release happens** (`.github/workflows/release.yml`): on every push to `main`, the Changesets action opens or updates
  the *Version packages* pull request (`changeset version`: the versions, the changelogs). Merging it runs the checks again and
  **stages** every package that is not on npm yet — `pnpm stage publish -r` with trusted publishing (OIDC, no token in the
  repository) and provenance. Nothing is public until a maintainer approves the staged versions on npmjs.com with two-factor
  authentication; then `changeset git-tag` tags the release. The trusted-publisher configuration on npm allows staging only.
- Packages are packed and published with **pnpm** only — `npm pack` and `npm publish` ignore `publishConfig.exports` and would
  ship the `@marmeon/source` condition, TypeScript sources Node does not strip under `node_modules` (`pnpm pack:check` proves the
  tarballs).
- A broken version is never unpublished; it is deprecated (`npm deprecate 'marmeon@0.2.1' 'Broken: use 0.2.2'`, for every
  package of the release) and fixed by the next patch.
- `scripts/npm-trust.sh` is generated (`node scripts/npm-trust.ts`) — the `npm trust github` call for every package, run once by
  a maintainer after the first publish.

## Inside the framework

What a contributor to the framework needs and an app never does. The exported functions and classes document themselves in their
sources; these are the rules that span several files.

### The entry points of `@marmeon/core`

Besides its main entry and the documented `@marmeon/core/diagnostics` and `@marmeon/core/dev`, the core has three entry points
that only the framework imports:

| Import | What |
| --- | --- |
| `@marmeon/core/environment` | `environment` and `resolveEnvironment` alone, without dependencies — what `marmeon` loads before anything else |
| `@marmeon/core/register` | the Node loader hook that writes the injection lists of app code. `marmeon` registers it in its own process (`module.registerHooks`) before a command loads; in a protected environment it takes `marmeon build`'s precomputed lists |
| `@marmeon/core/vite` | the same transform as a Vite plugin (`marmeonInjection()`, part of `marmeon()` in `@marmeon/vite`) and `CSP_NONCE_PLACEHOLDER` |

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
`package.json` as `_gitignore` and `_package.json`, makes `tsconfig.json` standalone, empties every `APP_KEY=` and leaves
`README.md` out — the scaffolder writes each app its own README and keys. `template/kit` holds what the starter kit adds: the
home module and the app's dialog.

`MARMEON_CREATE_TARBALLS=<dir>` makes `create-marmeon` take the framework from the tarballs of `pnpm pack` in that directory
instead of the registry. They are copied into the app's `vendor/marmeon/`, and every `@marmeon/*` dependency and `marmeon` point
there (`file:`), the packages' dependencies on each other too — through `overrides` in `pnpm-workspace.yaml` for pnpm, with
nothing hoisted and only for what gets installed (pnpm installs an overridden optional peer as if the app had asked for it), and
in `package.json` for npm, the optional peers nobody installs by absolute path (npm resolves a relative override from the
dependent's directory). A package the app adds later comes from its tarball:
`pnpm add ./vendor/marmeon/marmeon-redis-<version>.tgz`. That is how `pnpm pack:smoke` and `pnpm image:smoke` make their apps
before anything is published. It is not for apps: the variable never reaches the install and the generators.

### The client core and its adapters

A UI adapter — `@marmeon/react` is the one there is — is a rendering layer. Everything else lives in the UI-free client core,
`@marmeon/http/client`: the protocol, the history, the in-memory page cache, background requests and every security invariant.
`packages/http/src/client/adapter.test.ts` is the proof: a complete adapter in plain DOM visits, goes back and forward, loads
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
outside its own sources, the client core, `@marmeon/http/page` and `@marmeon/router/url`, and on any npm package but React.

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

### The size budget

`packages/react/size-budget.json` holds a limit per scenario in KB gzip of the initial download, measured in Vite's app mode
against `dist/` — minified, with production defines, without React, i18n and Vite's preload helper:

| Scenario | What |
| --- | --- |
| `core` | the client core as an adapter uses it: the navigator, the document, links, forms, routes, titles, messages |
| `emptyApp` | `createMarmeonApp` alone — an app without a page |
| `minimalApp` | `createMarmeonApp`, `Link`, `useForm`, `usePage`, `Head` |
| `everything` | all of `@marmeon/react`'s main entry; a ceiling, not a ratchet |
| `table` | `createMarmeonApp` and `useTable` |
| `blank-app`, `web-app`, `docs` (`appsGzipKB`) | the real apps' client builds: the marginal cost of core and adapter in their initial load |

- `bundle-size.test.ts` (part of `pnpm test`; run `pnpm build` first) fails when a scenario grows over its limit, and when it is
  more than 0.6 KB under it, until the limit follows. `MARMEON_SIZE_BUDGET=update` lowers limits in place to the measured
  size + 0.5 KB and never raises one. Raising a limit is the maintainers' decision, recorded in the file's `$comment`.
- The same test is the **leak test**: every feature has markers (its modules) and must be in a bundle only with its own import —
  a lazy one only in a lazy chunk. `stillLeaking` is `[]` in every scenario.
- `pnpm size` attributes every byte of the scenarios and the real apps to its module (source maps) and checks the apps against
  `appsGzipKB`; `pnpm size web-app` lists every module.
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

## Writing documentation

The docs under `docs/` are the framework's documentation: one page per topic, in the order `apps/docs/docs.config.ts` lists
them. They are the only source, written in English for people who build apps. **A change to a public API, an environment
default or a command changes its docs page in the same commit.** No check compiles the examples, so that commit is where they
stay true.
`pnpm docs:dev` shows the pages on http://localhost:3970. `docs/installation.md` and `docs/routing.md` are the model for every
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
  source file — a reader of the docs app cannot follow it.
- **Placeholders.** Every page is written: `pnpm check:source` refuses a page that carries `<!-- docs:pending -->` as a line
  of its own. While you write a new page, the marker on line 2 marks it "draft" in the navigation of `pnpm docs:dev` (the docs
  app removes the line); delete it before you commit.
- **Code that names a page** — a solution's `docs`, an error message, a comment — names its repository path with the anchor:
  `docs/migrations.md#running-migrations`. A test of the docs app (`apps/docs/modules/docs/links.test.ts`) follows every such path
  in the packages' code, the stubs, the starter's template, the apps, the package READMEs and the root README to its page and
  anchor, refuses a path to a package README, and refuses a page without its anchor outside the READMEs (which list pages).
- **Length:** as long as the topic needs. A page past about 600 lines probably wants splitting — propose it rather than
  splitting on your own.
- **Package READMEs are cards for npm**, not documentation: one sentence on what the package is, how to install it (or that a
  new app has it), one short example taken from its docs page, the page's links and the licence line. npm shows a README without
  the repository, so a card links with absolute GitHub URLs
  (`https://github.com/marmeon/marmeon/blob/main/docs/<page>.md#<anchor>`) — the docs app's links test checks each page and
  anchor. A package that needs a third-party driver names the exact install command. Everything else belongs on a docs page.

When the code and a README disagree, the code is right: describe what it does, and report the difference (or the bug) rather
than writing around it.

## Reporting a vulnerability

Never in a public issue — see [SECURITY.md](SECURITY.md).
