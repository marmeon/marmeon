# BespokeCore

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

Status: in development, not published yet. MIT licence (`LICENSE`). Node 26.10 or newer, pnpm 12.

## Principles

1. **Type safety end to end** — from the database column through controller, validation and route names to the form error in
   the React component. No `any` at framework boundaries; type guarantees are tested with `@ts-expect-error`.
2. **No global state** — no facades, no singletons holding request data. One `Application` instance, a request scope in the
   container; tests run in parallel, HMR registers nothing twice.
3. **Web standards first** — `Request`, `Response`, `FormData`, `crypto.subtle`, `URL`.
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
9. **Every feature is shown in a real app** — `apps/web-app` uses each of them and tests it; these docs are a BespokeCore app
   too (`apps/docs`).

Security comes before parity with Laravel or Inertia: no page props in `history.state` or browser storage, `no-store` for
signed-in users, read-only islands, devtools only with `NODE_ENV=development`, redaction of everything recorded.

## Quick start

There is no project generator yet: the blank app (`apps/blank-app`) is the template — an app without modules. In a copy of
it (inside this workspace, so the framework packages resolve):

```sh
pnpm install
pnpm exec bespoke key:generate        # copies .env.example to .env and writes APP_KEY: cookies, signed URLs, encrypted jobs
pnpm exec bespoke make:auth           # sign-up, login, password reset, e-mail verification, API tokens — as code the app owns
pnpm exec bespoke migrate
pnpm dev                              # bespoke dev: the server with Vite, a queue worker and the scheduler
```

`make:auth` copies a complete auth module into `modules/auth/` and registers it in `bootstrap/app.ts`; from then on the pages,
routes and rules are the app's ([@bespokecore/auth](packages/auth/README.md#bespoke-makeauth)). `bespoke dev` sets
`NODE_ENV=development`: the error page with code and queries, the devtools under `/_bespoke/devtools` and the in-page bar are on
([@bespokecore/devtools](packages/devtools/README.md)). Production: `bespoke build`, then `bespoke start`
([@bespokecore/cli](packages/cli/README.md#commands)).

An app is a composition root and its modules:

```ts
// bootstrap/app.ts
export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, userProfile],
});
```

Installed framework packages register themselves (discovery through the `"bespoke"` field of their `package.json`,
[@bespokecore/core](packages/core/README.md#discovery-the-bespoke-field-and-bespoke-discover)) — adding `@bespokecore/queue` to
`package.json` is all it takes to have a queue.

## Packages

| Group | Package | What it does |
|---|---|---|
| Core | [core](packages/core/README.md) | the application, modules, providers, the container with constructor injection, config, events, the clock, diagnostics channels, redaction |
| | [cli](packages/cli/README.md) | `bespoke`: `dev`, `build`, `start`, generators, `tinker`, the lint preset |
| | [log](packages/log/README.md) | pino logging with the request and job context |
| | [encryption](packages/encryption/README.md) | `APP_KEY`, authenticated encryption, key rotation |
| | [testing](packages/testing/README.md) | `createTestApp`, requests and assertions, database refresh, fakes |
| HTTP | [router](packages/router/README.md) | routes, invokable controllers, requests with schemas, query schemas, route binding, middleware |
| | [http](packages/http/README.md) | the page protocol, props (deferred, optional, merged, once, live), the UI-free client core |
| | [server](packages/server/README.md) | the kernel, SSR, health endpoints, the development error page |
| | [session](packages/session/README.md) | sessions with drivers, CSRF protection |
| | [vite](packages/vite/README.md) | the Vite plugin: entries, virtual modules, the route manifest, the server-import check |
| | [i18n](packages/i18n/README.md) | translations, the request's locale, formatting |
| Data | [database](packages/database/README.md) | Kysely, migrations, generated table types, repositories, factories, transactions |
| | [cache](packages/cache/README.md) | the cache, atomic locks, rate limits |
| | [redis](packages/redis/README.md) | Redis connections for cache, session, queue and live |
| Auth & Mail | [auth](packages/auth/README.md) | `make:auth`, guards, password hashing, reset, verification, API tokens, policies |
| | [mail](packages/mail/README.md) | mails with MJML, queued mails, previews |
| | [notifications](packages/notifications/README.md) | notifications over mail, database and live channels |
| Background | [queue](packages/queue/README.md) | jobs, workers, retries, unique jobs, chains |
| | [scheduler](packages/scheduler/README.md) | scheduled tasks, `onOneServer()`, events |
| | [storage](packages/storage/README.md) | disks (local, S3), signed URLs, uploads |
| | [live](packages/live/README.md) | live props: reload hints over server-sent events |
| Frontend | [react](packages/react/README.md) | the React adapter: pages, layouts, `<Link>`, forms, islands, layers |
| Tools | [devtools](packages/devtools/README.md) | the recorder, `/_bespoke/devtools` and the in-page bar — development only |
| | [otel](packages/otel/README.md) | OpenTelemetry spans from the diagnostics channels |

## The repository

```text
packages/*        the framework packages (each with its README — these pages)
apps/web-app      the app every feature is shown and tested in
apps/blank-app    an app without modules: the template, and what make:auth is tested against
apps/docs         these docs: the READMEs as a BespokeCore app (pnpm docs:dev)
scripts/ci.ts     pnpm run ci — build, typecheck, lint, every test suite, size, types, docs, the tarballs
UPGRADING.md      what changes for apps from one version to the next
```

```sh
pnpm run ci            # everything, as CI runs it (pnpm ci without `run` is pnpm's clean install)
pnpm test              # the test suite; test:pgsql, test:redis, test:s3 against the containers (docker compose up -d)
pnpm docs:dev          # the docs on http://localhost:3970
pnpm pack:check        # the tarballs: clean build, pnpm pack, no tests or leftovers, LICENSE, exact versions, publint, attw
pnpm pack:smoke        # the tarballs in a copy of the blank app outside the repository: install, build, start, make:auth, tests
```

Packages are packed and published with pnpm only — `npm pack` ignores `publishConfig.exports` and would ship the
`@bespokecore/source` condition (TypeScript sources Node does not strip under `node_modules`).
