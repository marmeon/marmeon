# Getting started with Marmeon

From nothing to a running app with sign-in, and the first feature of your own. You need **Node 26.10** or newer and **pnpm 12**
(or npm). Marmeon runs TypeScript natively — there is no compile step for your code.

## Create the app

```sh
pnpm create marmeon my-app
```

On a terminal it asks four things — the starter kit (yes), Docker files (no), the package manager (pnpm), a git repository
(yes) — `--yes` takes those answers without asking. What you get:

- **the starter kit**: an auth module (`modules/auth/`: sign-in, registration with e-mail confirmation, password reset, a
  security page with "sign out other devices", API tokens — written by `marmeon make:auth`, so it is your code), a home page
  (`modules/home/`), a layout, the devtools, oxlint with the app's preset and Vitest, with tests for all of it;
- `.env` with a fresh `APP_KEY` and `NODE_ENV=development` (never committed — this machine's environment for every `marmeon`
  command, E170), SQLite in `storage/`, the tables migrated;
- a strict Content-Security-Policy with a nonce per response, security headers, no session for guests;
- a git repository with one commit.

`--minimal` makes a blank app (only the `system` module), `--docker` the files of [deployment](deployment.md), `--npm` an npm app.
The starter kit's registration never tells whether an address has an account (a note goes to the owner instead, and the app opens
for a confirmed address only); `AUTH_PRIVATE_REGISTRATION=false` in `.env` makes it say "taken" and sign a new account in at once,
like Laravel's starter kits — and gives away who has an account ([private registration](../packages/auth/README.md#private-registration-e146-e193)). Without a terminal — in CI, in a
script — nothing is asked and a missing directory is exit code 2. All options:
[create-marmeon](../packages/create-marmeon/README.md) — also what to do in the first day after a release, when pnpm's
`minimumReleaseAge` still holds the new versions back.

## Run it

```sh
cd my-app
pnpm dev
```

`marmeon dev` starts the server with Vite (hot reload), a queue worker and the scheduler on http://localhost:3000, with
`NODE_ENV=development`: errors show the development error page, and the devtools (`/_marmeon/devtools`, and a bar on every page)
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
pnpm exec marmeon make:module notes                                  # modules/notes/index.ts + routes.ts
pnpm exec marmeon make:controller ShowNotes --module=notes --view    # an invokable controller and its page
```

Register it in `bootstrap/app.ts` (`modules: [auth, home, notes, system]`), add the route
(`Route.get('/notes', ShowNotesController).name('notes.index')` in `modules/notes/routes.ts`), and the page is there — typed
end to end: the controller's props are the page's, `<Link route="notes.index">` knows the route. `marmeon dev` keeps
`bootstrap/routes.ts` (the route and page types) current. A table: `marmeon make:migration create_notes_table --module=notes`, then
`marmeon migrate` — it writes the table types into `bootstrap/database.d.ts`.

The packages' guides go further: [core](../packages/core/README.md) (modules, providers, injection, config),
[router](../packages/router/README.md) (routes, controllers, validation), [react](../packages/react/README.md) (pages, forms,
layouts), [database](../packages/database/README.md), [auth](../packages/auth/README.md).

## Build and start

```sh
pnpm build       # type-checks the app, builds client and SSR, precomputes the injection lists, compresses the assets
pnpm start       # the build, one Node process — set NODE_ENV and the configuration in the environment of the server
```

`.env` is this machine's file: on a server, `NODE_ENV=production` (or `staging`), `APP_KEY`, `APP_URL=https://…`, the database
and the mailer come from the real environment, which wins over `.env`. A `NODE_ENV` that is missing everywhere counts as
production; one that comes from a `.env` on the server is named loudly in the log — never deploy this file. The queue worker
`marmeon queue:work` takes every queue (the auth module's mails wait on `mail`, the welcome job on `default`). Containers,
proxies and the scheduler in production: [deployment](deployment.md); what the app protects by itself and what is left to you:
[security](security.md).
