# Marmeon

A type-safe "Laravel for TypeScript": a modular monolith framework on Node.js that runs TypeScript natively (no transpile
step), with constructor injection, invokable controllers, server-rendered React pages over its own protocol, a data layer on
Kysely and the batteries a web app needs — sessions, auth, mail, queues, a scheduler, storage, live updates — each with a
contract, several drivers and a fake for tests.

```ts
// modules/user-profile/controllers/ShowUserProfileController.ts — one endpoint, one class
export class ShowUserProfileController extends Controller {
  readonly #directory: ProfileDirectory;

  constructor(directory: ProfileDirectory) {   // injected: the injection list is generated, no decorators
    super();
    this.#directory = directory;
  }

  handle(ctx: HttpContext<Authenticated, { user: Profile }>) {   // `user` bound by the route — a missing one is a 404
    return this.view('user-profile/Show', {
      profile: ctx.params.user,
      stats: optional(() => this.#directory.stats(ctx.params.user.id)),   // only when the page asks for it
    });
  }
}
```

```tsx
// modules/user-profile/views/Show.tsx — the props are the controller's, typed end to end
export default function Show({ profile }: PageProps<ShowUserProfileController>) {
  return <Link route="user-profile.edit" params={{ user: profile.id }} layer>Edit {profile.name}</Link>;
}
```

Status: 0.1.0 — prepared, not published yet. MIT licence (`LICENSE`, copyright BespokeCode). Node 26.10 or newer, pnpm 12.
Marmeon was called BespokeCore up to 0.1.0 ([UPGRADING.md](UPGRADING.md)).

## Principles

1. **Type safety end to end** — from the database column through controller, validation and route names to the form error in
   the React component. No `any` at framework boundaries; type guarantees are tested with `@ts-expect-error`.
2. **No global state** — no facades, no singletons holding request data. One `Application` instance, a request scope in the
   container; tests run in parallel, HMR registers nothing twice.
3. **Web standards first** — `Request`, `Response`, `FormData`, `URL`, Fetch Metadata, `BroadcastChannel`; Node's own modules
   where they are faster (the `Encrypter` runs on `node:crypto`).
4. **TypeScript runs natively on Node** — Node strips the types (`erasableSyntaxOnly`): no parameter properties, no enums, no
   decorators. Constructor injection works from generated injection lists instead
   ([constructor injection](packages/core/README.md#constructor-injection)).
5. **Modules first** — a feature module bundles routes, providers, migrations, views, config and tests; the framework
   discovers them. Boundaries between modules are possible, not prescribed.
6. **One endpoint, one class** — invokable controllers (`handle()`), also for jobs, listeners, commands, mails and policies.
7. **Batteries included, driver-based** — every service has a contract, several drivers (memory, file, database, Redis, …) and
   a fake for tests.
8. **Buy where it is world class** — Hono (HTTP), Vite (build, SSR), Standard Schema (validation), Kysely (SQL). Build where
   the developer experience is: the container, the data layer, the type bridge, the protocol.
9. **Every feature is shown in a real app** — `apps/web-app` uses each of them and tests it; these docs are a Marmeon app
   too (`apps/docs`).

Security comes before parity with Laravel or Inertia: no page props in `history.state` or browser storage, `no-store` for
signed-in users, read-only islands, devtools only with `NODE_ENV=development`, redaction of everything recorded
([Security](#security)).

## Getting started

Node 26.10 or newer and pnpm 12 (new apps pin `pnpm@12.9.1` in `packageManager`) — or npm with `--npm`:

```sh
pnpm create marmeon my-app        # the starter kit: sign-in and registration, a home page, devtools, oxlint, Vitest — then a first commit
cd my-app
pnpm dev                              # marmeon dev: the server with Vite, a queue worker and the scheduler on http://localhost:3000
```

> Not on npm yet (E152: Max publishes): until the first release, `pnpm pack:smoke --keep` in this repository makes such an app
> from the packages' tarballs and keeps it.

> **In the first day after a release** pnpm (11 and newer) holds the new versions back: its `minimumReleaseAge` (one day by default)
> protects against packages that are pulled again soon after they appear. `pnpm create marmeon` then falls back to an older
> release or stops, and the new exact `@marmeon/*` versions fail to install. Wait a day — or let only the
> framework through, for this one command:
> `pnpm_config_minimum_release_age_exclude='["@marmeon/*","marmeon","create-marmeon"]' pnpm create marmeon my-app`
> (the variable reaches the install `create-marmeon` runs). npm has no such delay.

`create-marmeon` copies the template, writes `.env` with a fresh `APP_KEY`, installs, and runs the app's own generators:
`marmeon make:auth` puts a complete auth module into `modules/auth/` — the pages, routes and rules are the app's from then on
([@marmeon/auth](packages/auth/README.md#marmeon-makeauth)) — and `marmeon migrate` creates the tables. `--minimal` makes a
blank app instead (the starter kit's registration never tells whether an address has an account — `AUTH_PRIVATE_REGISTRATION=false`
turns that off), `--docker` adds the files to run it in containers, `--npm` uses npm; without a terminal nothing is asked
([create-marmeon](packages/create-marmeon/README.md), and the longer walk-through in
[docs/getting-started.md](docs/getting-started.md)).

`marmeon dev` sets `NODE_ENV=development`: the error page with code and queries, the devtools under `/_marmeon/devtools` and the
in-page bar are on ([@marmeon/devtools](packages/devtools/README.md)); in development mails go to the log, the confirmation
link of a registration with them. The app's `.env` says `NODE_ENV=development` too (E170): every other `marmeon` command on this
machine — `migrate` (which then writes the table types without `--force`), `tinker`, `queue:work` — runs as development. Any
other value but `test`, and none, is protected like production (E139, [the environment](packages/core/README.md#the-environment-node_env)).
`.env` is this machine's file: on a server, set `NODE_ENV`, `APP_KEY` and `APP_URL` in the real environment — it wins over
`.env` — and never deploy a developer's `.env` (a `marmeon start` that runs as development because of it says so loudly).
Production: `marmeon build`, then `marmeon start` ([marmeon](packages/cli/README.md#commands),
[deployment](docs/deployment.md)).

An app is a composition root and its modules:

```ts
// bootstrap/app.ts
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, userProfile],
});
```

Installed framework packages register themselves (discovery through the `"marmeon"` field of their `package.json`,
[@marmeon/core](packages/core/README.md#discovery-the-marmeon-field-and-marmeon-discover)) — adding `@marmeon/queue` to
`package.json` is all it takes to have a queue.

## Packages

| Group | Package | What it does |
|---|---|---|
| Core | [core](packages/core/README.md) | the application, modules, providers, the container with constructor injection, config, events, the clock, diagnostics channels, redaction |
| | [cli](packages/cli/README.md) | `marmeon`: `dev`, `build`, `start`, generators, `tinker`, the lint preset |
| | [create-marmeon](packages/create-marmeon/README.md) | `pnpm create marmeon`: a new app — the starter kit or a blank app |
| | [log](packages/log/README.md) | pino logging with the request and job context |
| | [encryption](packages/encryption/README.md) | `APP_KEY`, authenticated encryption, key rotation |
| | [testing](packages/testing/README.md) | `createTestApp`, requests and assertions, database refresh, fakes |
| HTTP | [router](packages/router/README.md) | routes, invokable controllers, requests with schemas, query schemas, route binding, middleware |
| | [http](packages/http/README.md) | the page protocol, props (deferred, optional, merged, once, live), the UI-free client core and its navigator (the Navigation API, view transitions) |
| | [server](packages/server/README.md) | the kernel, SSR, health endpoints, the development error page |
| | [session](packages/session/README.md) | sessions with drivers, CSRF protection |
| | [vite](packages/vite/README.md) | the Vite plugin: entries, virtual modules, the route manifest, the server-import check |
| | [i18n](packages/i18n/README.md) | translations, the request's locale, formatting |
| | [validation](packages/validation/README.md) | `rules`: Laravel's validation rules, typed — messages in the request's language, database rules that never run live |
| Data | [database](packages/database/README.md) | Kysely, migrations, generated table types, repositories, factories, transactions, pagination |
| | [cache](packages/cache/README.md) | the cache, atomic locks, rate limits |
| | [redis](packages/redis/README.md) | Redis connections for cache, session, queue and live |
| | [table](packages/table/README.md) | server-driven tables: one definition, columns by policy, a strict URL state, row and bulk actions, CSV export |
| Auth & Mail | [auth](packages/auth/README.md) | `make:auth`, guards, password hashing, reset, verification, API tokens, policies |
| | [mail](packages/mail/README.md) | mails with MJML, queued mails, previews |
| | [notifications](packages/notifications/README.md) | notifications over mail, database and live channels |
| Background | [queue](packages/queue/README.md) | jobs, workers, retries, unique jobs, chains |
| | [scheduler](packages/scheduler/README.md) | scheduled tasks, `onOneServer()`, events |
| | [storage](packages/storage/README.md) | disks (local, S3), signed URLs, uploads |
| | [live](packages/live/README.md) | live props: reload hints over server-sent events |
| Frontend | [react](packages/react/README.md) | the React adapter: pages, layouts, `<Link>`, forms, islands, layers, `useTable` |
| Tools | [devtools](packages/devtools/README.md) | the recorder, `/_marmeon/devtools` and the in-page bar — development only |
| | [otel](packages/otel/README.md) | OpenTelemetry spans from the diagnostics channels |

## Versions and deprecations

The framework is released in **lockstep** (E152): every `@marmeon/*` package, the CLI `marmeon` and
`create-marmeon` always have the same version — upgrade them together.

- **0.x — now:** a **minor** version (0.1 → 0.2) may break, and every break has an entry in [UPGRADING.md](UPGRADING.md); a
  **patch** never breaks. Pin the exact version (`create-marmeon` does) or `~0.1.0`.
- **From 1.0 — after the reference app:** breaking changes only in a major version; a feature is deprecated first in a minor
  (documented, `@deprecated` in its types, a warning in development only) and removed in the next major.
- **A broken release** is never unpublished: it is deprecated on npm and fixed by the next patch. **Node** 26.10 or newer (E9) — a
  new minimum is a breaking change. Security fixes go to the latest minor version ([SECURITY.md](SECURITY.md)).

The whole policy, the first day after a release and how to upgrade: [docs/versioning.md](docs/versioning.md).

## Security

What an app protects by itself — CSRF by Fetch Metadata and `Origin` (E143), `Secure` cookies from an `https://` `APP_URL`,
session ids the stores never see (E144), a strict Content-Security-Policy with a nonce per response (E147), tabs that follow a
sign-out (E148), `Clear-Site-Data` on sign-out, protections that fail closed outside development (E139) — and what it leaves to
you: [docs/security.md](docs/security.md). Report a vulnerability privately, never in a public issue: GitHub's private
vulnerability reporting, as [SECURITY.md](SECURITY.md) describes (security fixes go to the latest minor version).

## Guides

[Getting started](docs/getting-started.md) · [Lists and pagination](docs/lists.md) · [Tables](docs/tables.md) ·
[Navigation and view transitions](docs/navigation.md) · [Real time](docs/realtime.md) · [Deployment](docs/deployment.md) ·
[Security](docs/security.md) · [Versions and deprecations](docs/versioning.md) · [Upgrading](UPGRADING.md) ·
[Contributing](CONTRIBUTING.md) — in the docs app under `/guides/…`, beside the packages' READMEs.

## Contributing

Contributions are welcome under the Developer Certificate of Origin (DCO 1.1, no contributor licence agreement) — every commit
signed off (`git commit -s`); how to set up, check (`pnpm run ci`), add a changeset and how a release is made:
[CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilities go through GitHub's private vulnerability reporting, never a public issue
([SECURITY.md](SECURITY.md)).

## The repository

```text
packages/*        the framework packages (each with its README — these pages)
apps/web-app      the app every feature is shown and tested in
apps/blank-app    an app without modules: what create-marmeon --minimal writes (pnpm template:sync), and what make:auth is tested against
apps/docs         these docs: the READMEs and docs/*.md as a Marmeon app (pnpm docs:dev; apps/docs/Dockerfile, deploy/docs)
docs              the guides: getting started, lists, tables, navigation, real time, deployment, security, versions
scripts/ci.ts     pnpm run ci — its 14 parts, from the build to the release rules (below)
scripts/bench     pnpm bench — the start and the request path, measured (never a gate)
scripts/gegen     pnpm gegen — the Gegenproben of each step: a measure taken out, its test red for its reason (never a gate)
scripts/test      the test suite's temporary directory per run and tempDir() — the repository's own, not exported by a package
                  (pnpm test fails when a test leaves an entry behind)
deploy/docs       the docs' Compose file and Caddyfile (one server, E142)
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
pnpm changeset         # a changeset for your change (CONTRIBUTING.md); pnpm check-changesets checks the release rules
pnpm gegen w9/s01      # the Gegenproben of a step (CONTRIBUTING.md): every case red for its reason; --control: all green without the patches
```

`pnpm run ci` runs 14 parts one after the other, each with its exit code and time, and fails when one is red: `build`,
`typecheck`, `lint`, `test`, then `test:pgsql`, `test:redis` and `test:s3` against this repository's containers (`compose.yaml`,
started as needed), `size` (the bundle limits — they only go down, each keeps a 0.5 KB reserve, E186), `types:check` (the apps' generated route and table types are current), `docs:check`,
`pack:check`, `pack:smoke`, `image` (the starter kit's image from `make:docker`, then the docs' image) and `check-changesets`.
`pack:smoke` and `image` without a package store, the registry or Docker are reported as skipped, never as green.
`--only a,b`, `--skip a,b`, `--bail`, `--no-compose` (the databases already run) and `--list` choose; `ci.yml` splits the parts
into six jobs that run side by side (the checks, the tarballs, the image, Postgres, Redis, S3).

### Benchmarks

`pnpm bench` keeps the measurements in the repository (E166) — none of them is part of `pnpm run ci`, a laptop's noise (±3–5 %
between runs) would make a gate flaky:

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
`--without <measure>` (`session-hash`, `fetch-metadata`, `csp`, `epoch`; `w8` for all four) switches Wave 8's security measures off
in one variant — counted, and refused when one still runs — so their cost shows on its own (E154). The numbers and the machine
are in [@marmeon/server](packages/server/README.md#the-request-path-e136-e154).

Packages are packed and published with pnpm only — `npm pack` ignores `publishConfig.exports` and would ship the
`@marmeon/source` condition (TypeScript sources Node does not strip under `node_modules`).
