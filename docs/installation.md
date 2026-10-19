# Installation

## Introduction

Marmeon is a full-stack framework for TypeScript. One command creates a new app: a server that renders React pages, a
database, sessions, mail, a queue and a scheduler, already wired together. You run it with one more command and register your
first account a few seconds later.

```sh
pnpm create marmeon my-app
cd my-app
pnpm dev
```

This page walks through those three commands: what you need first, how you call the creator, what it writes, and what runs
when you start the app.

## Requirements

You need **Node.js 26.10** or newer. Marmeon runs your TypeScript directly on Node, without a compile step, and relies on what
recent Node versions provide for that. An older Node stops the creator before it writes a single file. [Supported platforms](releases.md#supported-platforms) says
which Node, TypeScript and library versions Marmeon supports and how that changes.

You also need a package manager. Marmeon is built and tested with **pnpm 12**, and a new app pins the exact version in its
`package.json` (`"packageManager": "pnpm@12.9.1"`). npm works as well, with `--npm`.

Nothing else is required. The app uses SQLite in a file by default, so you need no database server to get started.

## Creating an app

Run the creator with the directory of the new app:

```sh
pnpm create marmeon my-app
```

With npm, the creator's own flags follow a `--`:

```sh
npm create marmeon@latest my-app -- --npm
```

The directory must not exist yet, or it must be empty. Its name becomes the package name, and a readable form of it becomes the
app's name: `my-app` is the package `my-app` and the app "My App".

### Options

| Option | Effect |
| --- | --- |
| `<dir>` | The directory of the new app. On a terminal it is asked for when you leave it out. |
| `-y`, `--yes` | Takes the defaults and asks nothing: the starter kit, pnpm, the install and a first commit. |
| `--minimal` | A blank app instead of the starter kit: no sign-in, no home page. |
| `--docker` | Adds a `Dockerfile`, a `.dockerignore` and a `compose.production.yaml`. |
| `--npm`, `--pnpm` | Chooses the package manager. pnpm is the default. |
| `--no-install` | Writes the files only. The output lists the commands to run next. |
| `--no-git` | Creates no git repository. |
| `-h`, `--help` | Shows the help. |
| `-v`, `--version` | Shows the version. Every framework package of the new app has this same version. |

### Without a terminal

In a script or in CI, the creator never waits for an answer. The flags and the defaults decide everything. A missing directory
ends the run with exit code 2:

```text
create-marmeon needs a directory: create-marmeon <dir> [--yes]
```

Every wrong call ends with exit code 2: an unknown flag, two directories, or `--npm` together with `--pnpm`. A directory that is
not empty and a Node older than 26.10 end with exit code 1, before anything is written. So does a missing pnpm when the creator
is about to install. When a later step fails, for example the install, the run ends with exit code 1 and shows that step's
output. The directory stays as it was at that moment, so you can fix the cause and run the step yourself. Ctrl+C at a question
ends the run with exit code 130.

## What you get

The creator copies the app's template, writes its `package.json` and `.env`, installs the dependencies and runs the app's own
generators. It then creates a git repository with one commit, unless the directory is already inside a repository.

The creator also writes `marmeon-stubs.json`, which records the version and the hash of every file it copied unchanged. Files it
fills in for your app or that commands rewrite, namely `package.json`, `.env.example`, `.env.test`, `README.md`, `index.html`,
`bootstrap/app.ts`, `bootstrap/client.tsx`, `bootstrap/head.ts` and the generated types `bootstrap/routes.ts` and
`bootstrap/database.d.ts`, and the migrations are not in it. [The starter kit](starter-kit.md#what-the-auth-module-holds) says what the file is for.

### The starter kit

By default you get the starter kit. It is a complete app with accounts:

- **An auth module** in `modules/auth/`: sign-in, registration with a confirmation mail, password reset, a security page with
  "sign out other devices", and API tokens. The `marmeon make:auth` generator writes it into your app, so the code is yours to
  read and change.
- **A home page** in `modules/home/` and a **dashboard** for signed-in users, framed by the auth module's layout.
- **Tests** for all of the above.

The starter kit's registration is private: it never tells anyone whether an address already has an account. The
[starter kit](starter-kit.md#private-registration) page explains what that means and how to turn it off.

### A blank app

`--minimal` creates a blank app. It has one module, `system`, that holds the tables of the framework's queue. You add your own
modules from there.

Both kinds of app share the rest: `bootstrap/`, the configuration, the security headers, the devtools that record what the app
does while you develop, Vitest and oxlint with the app's own preset.

### The environment file

The creator writes `.env` from `.env.example` and puts a fresh application key into it:

```sh title=".env"
NODE_ENV=development
APP_NAME="My App"
APP_URL=http://localhost:3000
APP_KEY=base64:…
PORT=3000
```

`APP_KEY` encrypts the session cookie and everything else the app encrypts or signs. The file is readable by its owner only,
and git ignores it, like every `.env*` file except `.env.example` and `.env.test`. `.env.example` lists the common settings with a comment and carries no key. `.env.test` is what the tests run
with, and it has a test key of its own.

`NODE_ENV=development` in `.env` makes every `marmeon` command on this machine run in development: the server, `migrate`, the
queue worker. The [configuration](configuration.md#the-environment-node_env) page explains how `NODE_ENV` and the other variables
are resolved.

> [!WARNING]
> `.env` belongs to this machine. Never deploy it. On a server, set `NODE_ENV=production`, `APP_KEY`, `APP_URL` and the rest in
> the real environment, which always wins over `.env`. The [deployment](deployment.md) page lists what a server needs.

### The database

The app starts on SQLite, in the file `storage/database.sqlite`. The creator runs `marmeon migrate`, so the tables exist when you
first start the app. In development, `migrate` also writes the table types to `bootstrap/database.d.ts`, which the type checker
uses for every query. You switch to PostgreSQL with `DB_CONNECTION=pgsql` and the server's `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and
`DB_PASSWORD` in `.env`, or its whole address in `DB_URL`.

### Security from the start

A new app answers with security headers and a strict Content-Security-Policy with a fresh nonce on every page. Guests get no
session cookie until something needs one. The stylesheet of the framework's components is imported in the client entry, so no
component writes a `style` attribute that the policy would have to allow.

## Running the app

Start the development server from the app's directory:

```sh
pnpm dev
```

`pnpm dev` runs `marmeon dev`. It serves the app on http://localhost:3000 and starts what the app needs next to it:

- **The server**, with Vite in front of it. Changes to a page appear in the browser at once. Changes to server code restart the
  server.
- **A queue worker**, which runs the queued jobs. The starter kit sends its mails through the queue.
- **The scheduler**, when a module has scheduled tasks. The starter kit's auth module prunes expired tokens at night.

`marmeon dev` runs in development unless your shell or the app's `.env` sets another `NODE_ENV`. Then it says so and serves the
build instead, without Vite, the devtools, the worker and the scheduler.

In development, a failing page shows the development error page: the code that threw, the request's queries and suggested
solutions. The devtools record requests, queries, jobs and mails at http://localhost:3000/_marmeon/devtools, and a small panel at
the bottom right of every page links to them. The [devtools](devtools.md) page covers both.

### Your first account

Open http://localhost:3000 and register. The confirmation mail does not leave your machine: in development the mailer writes
every mail to the log. The queue worker sends it a moment after you register, and it appears in the terminal where `pnpm dev`
runs. Copy the confirmation link from it and open it. The app asks you to sign in first, confirms the address and takes you to
the dashboard.

> [!NOTE]
> The log mailer writes links and tokens in plain text. Outside development the app warns at every start while `MAIL_MAILER` is
> still `log`. Set up a real mailer before anyone else uses the app.

### Tests and lint

The app's tests and lint run with two more scripts:

```sh
pnpm test
pnpm lint
```

`pnpm test` runs Vitest over `modules/**/*.test.ts`, on an in-memory SQLite database with the settings of `.env.test`. `pnpm lint`
runs oxlint with the app's preset. The preset keeps views from importing server code by value, which would bundle it into the
browser. The [testing](testing.md#creating-the-test-app) page explains how a test boots the app.

With npm, the scripts are `npm run dev`, `npm test` and `npm run lint`. The `marmeon` command itself runs as
`pnpm marmeon <command>` or `npx marmeon <command>`.

## The first day after a release

pnpm installs no package version younger than its `minimumReleaseAge`, one day by default. This protects you from a package that
is pulled again soon after it appears. For a day after a Marmeon release, `pnpm create marmeon` therefore falls back to an older
version of the creator, or stops when there is none, and the install of the new framework versions fails.

Wait a day, or let only the framework through for this one command:

```sh
pnpm_config_minimum_release_age_exclude='["@marmeon/*","marmeon","create-marmeon"]' pnpm create marmeon my-app
```

The variable reaches the install the creator runs and changes nothing else. The creator never changes your pnpm settings. npm
has no such delay.

## Next steps

- [Your First App](first-app.md) builds a small notes app on the starter kit, step by step.
- [Directory Structure](structure.md) shows where everything in the new app lives, and walks you through your first module.
- [Configuration](configuration.md) explains `.env`, `NODE_ENV` and each package's settings.
- [Routing](routing.md) is where every feature starts: a URL, a controller and a page.
- [Deployment](deployment.md) takes the app to a server: `marmeon build`, `marmeon start`, the worker and the scheduler.
