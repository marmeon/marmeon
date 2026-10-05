# Getting started with BespokeCore

From nothing to a running app with sign-in, and the first feature of your own. You need **Node 26.10** or newer and **pnpm 12**
(or npm). BespokeCore runs TypeScript natively — there is no compile step for your code.

## Create the app

```sh
pnpm create bespoke-app my-app
```

On a terminal it asks four things — the starter kit (yes), Docker files (no), the package manager (pnpm), a git repository
(yes) — `--yes` takes those answers without asking. What you get:

- **the starter kit**: an auth module (`modules/auth/`: sign-in, registration with e-mail confirmation, password reset, a
  security page with "sign out other devices", API tokens — written by `bespoke make:auth`, so it is your code), a home page
  (`modules/home/`), a layout, the devtools, oxlint with the app's preset and Vitest, with tests for all of it;
- `.env` with a fresh `APP_KEY` (never committed), SQLite in `storage/`, the tables migrated;
- a strict Content-Security-Policy with a nonce per response, security headers, no session for guests;
- a git repository with one commit.

`--minimal` makes a blank app (only the `system` module), `--private-registration` a registration that never tells whether an
address has an account, `--docker` the files of [deployment](deployment.md), `--npm` an npm app. Without a terminal — in CI, in a
script — nothing is asked and a missing directory is exit code 2. All options:
[create-bespoke-app](../packages/create-bespoke-app/README.md) — also what to do in the first day after a release, when pnpm's
`minimumReleaseAge` still holds the new versions back.

## Run it

```sh
cd my-app
pnpm dev
```

`bespoke dev` starts the server with Vite (hot reload), a queue worker and the scheduler on http://localhost:3000, with
`NODE_ENV=development`: errors show the development error page, and the devtools (`/_bespoke/devtools`, and a bar on every page)
record requests, queries, jobs and mails.

Register an account. The confirmation mail goes to the log (`MAIL_MAILER=log` in development) — the worker sends it, so it shows
in the terminal of `pnpm dev` a moment later; open its link, and the dashboard is yours. Sign out in one tab and the other tabs
follow (tab sync is on by default).

```sh
pnpm test        # Vitest: modules/**/*.test.ts — the auth module's, the home page's, the system module's
pnpm lint        # oxlint: views import controllers only as types (a value import would bundle server code)
```

## Your first module

A feature is a module: routes, controllers, views, migrations, tests in one folder.

```sh
pnpm exec bespoke make:module notes                                  # modules/notes/index.ts + routes.ts
pnpm exec bespoke make:controller ShowNotes --module=notes --view    # an invokable controller and its page
```

Register it in `bootstrap/app.ts` (`modules: [auth, home, notes, system]`), add the route
(`Route.get('/notes', ShowNotesController).name('notes.index')` in `modules/notes/routes.ts`), and the page is there — typed
end to end: the controller's props are the page's, `<Link route="notes.index">` knows the route. `bespoke dev` keeps
`bootstrap/routes.ts` (the route and page types) current. A table: `bespoke make:migration create_notes_table --module=notes`, then
`bespoke migrate` — it writes the table types into `bootstrap/database.d.ts`.

The packages' guides go further: [core](../packages/core/README.md) (modules, providers, injection, config),
[router](../packages/router/README.md) (routes, controllers, validation), [react](../packages/react/README.md) (pages, forms,
layouts), [database](../packages/database/README.md), [auth](../packages/auth/README.md).

## Build and start

```sh
pnpm build       # type-checks the app, builds client and SSR, precomputes the injection lists, compresses the assets
pnpm start       # the build, one Node process — set NODE_ENV and the configuration in the environment of the server
```

`.env` is this machine's file: on a server, `NODE_ENV=production` (or `staging`), `APP_KEY`, `APP_URL=https://…`, the database
and the mailer come from the real environment. Containers, proxies and the queue worker in production:
[deployment](deployment.md).
