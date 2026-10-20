# Console

## Introduction

`marmeon` is the app's command line. It starts the development server, builds and starts the app, runs migrations and
workers, writes new files from templates, and runs the commands your modules add. Run it in the app's directory:

```sh
pnpm marmeon list
pnpm marmeon route:list
pnpm marmeon make:controller ShowNote --module=notes --view
```

`marmeon list`, or `marmeon` alone, prints every command the app has, grouped by the part before the colon. The list grows with
the app: every installed package adds its commands, and so does every module that lists some. With npm, run the commands as
`npx marmeon …`.

## Running commands

The `marmeon` package is a dependency of the app, not a dev dependency. `marmeon start`, `migrate`, `queue:work` and
`schedule:work` run on the server, and a production install leaves dev dependencies out.

Most commands boot the app first: they load `.env`, check the configuration and register every provider, just as the server
does. A command that cannot boot the app prints the error and the known solutions, and exits with 1:

```text
✗ [marmeon:K6] Invalid configuration — the application cannot start:
  • encryption: APP_KEY — Missing — run "marmeon key:generate"
Set these variables in the environment or in .env (see .env.example).

ℹ How to fix it: Generate an application key
  APP_KEY encrypts the cookies …
  $ marmeon key:generate
```

The generators, `build`, `discover`, `key:generate`, `make:lint-config` and `make:docker` work without booting, so they run
before the app has a valid `.env`. `route:types` and `make:command` register the app's providers without booting them, as the
build does, and need no secret either.

A command's options are checked before it runs. An unknown option, an option without its value or a value an option does not take (`--force=x`) is an error that prints
the command's usage line and exits with 2.
`marmeon <command> --help` (or `-h`) prints the command's description, its usage line and its options, and runs nothing; after a
`--`, `--help` is an argument like any other. `marmeon list` shows each command with its description. An unknown command says so
and exits with 2.

`--no-interaction` is an option of every command: it takes no value and is not among the command's `options`, and a command cannot
declare an option of that name. It stops a command from asking a question, as [asking a question](#asking-a-question) explains. Place
it after the command name and before a `--`; after a `--` it is an argument. A command run with `spawn()` inherits it through the
environment variable `MARMEON_NO_INTERACTION=1`, which `marmeon` sets for the child; setting it yourself has the same effect as the option.

The environment comes from `NODE_ENV` in the shell, then from the app's `.env`. `marmeon dev` is development without one and
`marmeon start` and `marmeon build` production. Every other command takes what it finds, and without a `NODE_ENV` it behaves like
production: `migrate` then asks for `--force`. A `NODE_ENV` other than `development`, `test` or `production` stops every command
before it runs. The [configuration](configuration.md#where-node_env-comes-from) page explains the rules.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The command succeeded. |
| `1` | The command ran and failed: the app could not start, or the command reported an error or threw. |
| `2` | `marmeon` was called wrongly: an unknown command, an unknown option, an option without its value, or a value an option does not take. |
| `130` | The person cancelled a question the command asked (Ctrl-C). |

[`marmeon check`](check.md#exit-codes) adds a `3` for a check that could not run.

A script can tell a typo from a failure this way. A built-in's options are checked before the app boots; an app's own command is looked
up once the app has booted, so a failed boot (1) comes first. A few commands have codes of their own: [`docs`](#reading-the-documentation) ends with 2 for an unknown page or options that do not go together, [`tinker`](#running-code-from-a-script) ends with
130 on a signal, and [`queue:work`](queues.md#timeouts-and-retryafter) with 70 when a job does not stop in time. A command that checks its own arguments, such as `schedule:test` without a name, still exits with 1.

## Machine-readable output

A command that takes `--json` prints one JSON document instead of its text, for scripts and tools:

```sh
pnpm marmeon route:list --json
```

- The first key of the document is `format`, a whole number: the version of that command's document. Each command counts on its
  own, so `route:list` format 1 and another command's format 1 are different formats.
- A new field is no new version. Removing or renaming a field, or changing its type or meaning, is a new `format` and a breaking
  change. `--json` always prints the newest format.
- stdout holds the document and nothing else; warnings are in its `warnings` list. With `--json` the app's logger (`@marmeon/log` and the console logger) writes every line, whatever its level, to stderr, and so does whatever `console.log` or `process.stdout.write` writes meanwhile. Writes straight to the file descriptor (`fs.writeSync(1, …)`, a logger with `destination(1)`) still reach stdout. A missing value is `null`, never left out.
- When the command fails (exit code other than 0), stdout stays empty and the message is on stderr, as without `--json`. Parse
  stdout only after exit code 0.

| Command | Document |
| --- | --- |
| `route:list --json` | [Listing routes](routing.md#listing-routes) |
| `check --json` | [Checking an app](check.md#json-output) |
| `schedule:list --json` | [Running the scheduler](scheduling.md#running-the-scheduler) |
| `db:show --json` | [Inspecting a connection](database.md#inspecting-a-connection) |
| `migrate:status --json` | [Status](migrations.md#status) |
| `docs --json` | [Reading the documentation](#reading-the-documentation) |
| `list --json` | The commands `marmeon list` shows. `complete` is `false` when the app did not load and only the built-in commands are known. Each command has `name`, `description`, `usage`, `options` (`name`, `type`, `short`, `multiple`, `default`), `experimental` and `launcher` (`dev` and `start`, which the launcher runs). |

A command of your own, or of a package, prints its document with `output.json({ format: 1, … })` and declares
`static options = { json: { type: 'boolean' } }`.

## The development server

`marmeon dev`, which `pnpm dev` runs, serves the app with Vite in front of it and starts what the app needs next to it. The
[installation](installation.md#running-the-app) page shows it from the outside. Under the hood:

- **Server code** is watched by Node: a change to a route, a controller or a provider restarts the server. A change to a page
  reaches the browser at once, without a restart.
- **Migrations** are watched as well: a file you add, change or remove under a module's `migrations/` is read again without a
  restart, and the app answers `marmeon migrate` run in another terminal within a second
  ([while you develop](migrations.md#while-you-develop)). The queue worker and the scheduler keep the schema they started with until
  the server restarts them.
- **A queue worker** on every queue starts next to the server, unless the default queue connection is `sync`.
- **The scheduler** starts when a module schedules tasks.
- **`bootstrap/routes.ts`** is written on every start, and again when a view is added or removed. Route names and views are then
  known to the type checker without running `route:types` yourself.
- **A warning** names every class under `modules/` with a literal `static job` or `static notification` that no module lists. The
  files are only read, never run, and the registration stays explicit. `marmeon build` prints the same warning.

The worker and the scheduler stop and start with the server, so a code change reaches them too. One that ends on its own is
started again a second later. One that ends right after its start, say with a configuration error, stays down until you save a
file. A server that is killed or crashes takes them along: they stop as on `SIGTERM`, and none is left running beside the next one.

`marmeon dev` sets `NODE_ENV=development` when neither the shell nor `.env` sets it. With another `NODE_ENV`, from either, it
says so and serves the build instead, without Vite, the devtools, the worker and the scheduler. `--workers` belongs to `marmeon
start`, and `marmeon dev` refuses it.

`marmeon build` and `marmeon start` are covered on the [deployment](deployment.md#building-and-starting) page, `--workers` under
[several processes on one machine](deployment.md#several-processes-on-one-machine) and `make:docker` under
[the Docker image](deployment.md#the-docker-image).

## Built-in commands

| Command | What it does |
| --- | --- |
| `dev` | The development server, with a worker and the scheduler next to it. |
| `build [--no-typecheck]` | Builds the app for production. See [deployment](deployment.md#building-and-starting). |
| `check [--only=<names>] [--skip=<names>] [--json]` | Runs the type check, the lint, the scan for imports of framework internals and the checks of the app (route and database types, boot, readiness), and exits with a code a script can read. See [checking an app](check.md). |
| `start [--workers=N]` | Starts the production server on the build. It refuses to run when `NODE_ENV=development` or `test` comes from `.env` alone: use `marmeon dev`, set `NODE_ENV=production` to try the build, or set `NODE_ENV=development` in the shell to start the development stack on purpose. |
| `route:list [--json]` | Every route with its method, path, name, group, middleware, who may call it (`ACCESS`) and action. See [listing routes](routing.md#listing-routes). |
| `route:types [--check]` | Writes `bootstrap/routes.ts`. `--check` fails when it is out of date, for CI. It also exits with 1 and lists every route that does not say who may call it, so `marmeon build` stops on one. See [typed route names](routing.md#typed-route-names) and [every route decides](authorization.md#every-route-decides). |
| `discover` | Finds the installed packages and their providers. See [discovery](modules.md#marmeon-discover). |
| `key:generate [--show] [--force]` | Sets `APP_KEY` in `.env`. |
| `agents:sync [--check]` | Writes `AGENTS.md` and `CLAUDE.md`, or brings the block of marmeon in `AGENTS.md` up to the installed version. `--check` writes nothing and fails when the block is missing or out of date, for CI. See [coding agents](agents.md). |
| `docs [<page>] [--path] [--json]` | Lists the pages of the documentation that came with the installed `marmeon`, or prints one. See [reading the documentation](#reading-the-documentation). |
| `tinker [--sandbox] [--execute "<code>"] [--no-history]` | A REPL with the booted app. See [tinker](#tinker). |
| `make:lint-config [--boundaries] [--force]` | Writes the lint preset. See [lint](#lint). |
| `make:docker [--caddy \| --nginx] [--systemd] [--force]` | Writes the files for a production image. See [deployment](deployment.md#the-docker-image). |
| `package:build [dirs…] [--clean]` | Builds framework packages for publishing. See [package development](package-development.md#building-and-publishing). |

`key:generate` copies `.env.example` to `.env` when there is no `.env` yet, then writes a new key. `--show` only prints a key. An
app that has a key keeps it unless you pass `--force`, which moves the old key to the front of `APP_PREVIOUS_KEYS`: sessions,
encrypted cookies and signed links made with it stay valid. The [deployment](deployment.md#rotating-app_key) page explains the
rotation on a server.

### Reading the documentation

`marmeon docs` reads the documentation of the installed version, the files [`marmeon` ships](installation.md#the-documentation-of-your-version),
and runs without booting the app, so it works in an app that does not start. It needs nothing from the network.

```sh
pnpm marmeon docs                    # every section and page: slug, title, file
pnpm marmeon docs routing            # the page on stdout, unchanged
pnpm marmeon docs routing --path     # only the absolute path of the file
pnpm marmeon docs --json             # the list for a program
```

- `<page>` is a slug from the list. `routing`, `routing.md` and `routing#anchor` name the same page; the anchor is ignored and the whole file printed.
- The command prints only pages that `docs/index.json` lists. What you type is looked up there and never used as a path, so `../package`, an absolute path or a symlink is not a page: an unknown page ends with exit code 2 and up to five similar slugs.
- `--path` needs a page, and `--json` takes none (exit code 2). There is no search; `grep` over the paths in the list does it.
- A `marmeon` without the documentation, as in the repository before `pnpm build`, or with an `index.json` of another format ends with exit code 1 and says so.

`docs --json` prints format 1: `format`, `version` (of `marmeon`), `root` (the absolute path of the package; `root` and a page's `file` make its path), `sections` (each with `title` and `pages`, whose entries have `slug`, `title` and `file`) and `warnings`. The pages are in reading order.

### Generators

The `make:*` commands write a file into a module from a template. `make:module` adds the module to `bootstrap/app.ts`. `make:listener`, `make:job`, `make:notification`, `make:command`, `make:seeder` and `make:migration`
also add the class (or the migrations folder) to the module's `index.ts`, where the module lists such things. When `index.ts` has another shape (a list kept in a variable, say),
they leave it as it is and print the lines to add; `--no-register` always prints them. The commands run without booting the
app (`make:command` registers it the way `marmeon build` does, no `.env` needed, to see every command name), and never overwrite a file unless you pass `--force`:

| Command | Writes |
| --- | --- |
| `make:module <name> [--no-register]` | `modules/<name>/index.ts` and `routes.ts`; adds the module last in `modules` of `bootstrap/app.ts`. |
| `make:controller <Name> --module=<m> [--view] [--request]` | A controller. `--view` adds its page, `--request` a query or body schema. See [controllers](controllers.md#creating-a-controller). |
| `make:event <Name> --module=<m>` | An event class in `events/`. See [events](events.md#defining-events). |
| `make:listener <Name> --event=<Event> --module=<m> [--queued] [--no-register]` | A listener in `listeners/`, added to the module's `listeners` with its event. `--queued` writes a [queued listener](events.md#queued-listeners) with `static queue` and a stable `static listener` (`<m>.<name>`). See [events](events.md#registering-listeners). |
| `make:job <Name> --module=<m> [--no-register]` | A queued job in `jobs/`, added to the module's `jobs`. See [queues](queues.md#generating-a-job). |
| `make:notification <Name> --module=<m> [--no-register]` | A notification in `notifications/`, added to the module's `notifications`. See [notifications](notifications.md#defining-notifications). |
| `make:command <Name> --module=<m> [--no-register]` | A console command in `commands/` named `<m>:<name>`, added to the module's `commands`. See [writing commands](#writing-commands). |
| `make:seeder <Name> --module=<m> [--no-register]` | A seeder in `seeders/`, added last to the module's `seeders`. See [seeding](seeding.md#generating-a-seeder). |
| `make:middleware <Name> --module=<m>` | A middleware class in `middleware/`. |
| `make:policy <Name> --module=<m>` | A policy in `policies/` that allows the owner of a record (`user_id`) and answers everyone else with a 404. Needs `@marmeon/auth` in the app's dependencies. See [generating a policy](authorization.md#generating-a-policy). |
| `make:test <name> --module=<m> [--path=/…]` | `modules/<m>/<name>.test.ts`: a test that boots the app and expects `--path` (default `/<m>`) to answer 200. It fails until the route exists — change it to what you test. See [creating the test app](testing.md#creating-the-test-app). |
| `make:resource <Name> [--module=<m>] [--no-register]` | A new module for a record of the signed-in user: migration, repository, [policy](authorization.md#generating-a-policy), the six controllers with their requests, two pages and a test, added to `bootstrap/app.ts`. Needs the auth module of the starter kit. It never changes an existing module. See [adding a resource](starter-kit.md#adding-a-resource). |
| `make:migration <snake_case_name> --module=<m> [--no-register]` | A timestamped migration in `migrations/`; adds the folder to the module once. See [migrations](migrations.md#generating-migrations). |
| `publish [<package>] [--module=<m>] [--check]` | The migrations a direct dependency of your app lists, into a module of the app; writes what is missing and skips what is there. Without a package it lists them and, at a terminal, asks which to publish. `--check` writes nothing and ends with exit code 1 when something is missing. See [migrations](migrations.md#publishing-the-migrations-of-a-package). |
| `make:sign-ins-table [--module=<m>]` | The migration of the `sign_ins` table that `DatabaseSignIns` uses: `publish` for `@marmeon/auth`. See [sign-ins](authentication.md#sign-ins). |
| `make:cache-table`, `make:session-table`, `make:queue-table`, `make:notifications-table`, `make:uploads-table` `[--module=<m>]` | The migrations of the database drivers' tables, each `publish` for its own package: writes what your app lacks, and ends with exit code 0 and "Nothing to publish" when it has it all. See [the framework's tables](migrations.md#the-frameworks-tables). |

`--module` names a module that exists: `make:module` comes first. `-m` is short for it.

`make:controller` decides nothing about who may call the controller: say it in the request's `authorize`, or with `Route.authorize(…)` on the registrar (`everyone` if anyone may). The command prints that reminder after the route line.

### Commands of the packages

The installed packages add their commands when the app boots:

| Package | Commands |
| --- | --- |
| `@marmeon/database` | `migrate`, `migrate:rollback`, `migrate:reset`, `migrate:fresh`, `migrate:status`, `publish`, `db:seed`, `db:show`, `db:types`. The four that change the schema take `--wait=<seconds>` (default 60) for another migration to end, see [one migration at a time](migrations.md#one-migration-at-a-time). See [migrations](migrations.md#running-migrations) and [seeding](seeding.md#running-seeders). |
| `@marmeon/queue` | `queue:work`, `queue:size`, `queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`, `queue:prune-failed`, `make:queue-table`. See [queues](queues.md). |
| `@marmeon/scheduler` | `schedule:work`, `schedule:run`, `schedule:list`, `schedule:test`. See [task scheduling](scheduling.md#running-the-scheduler). |
| `@marmeon/cache` | `cache:prune`, `cache:clear`, `make:cache-table`. See [cache](cache.md#expired-entries-and-clearing). |
| `@marmeon/session` | `session:prune`, `make:session-table`. See [session](session.md#expiry-and-clean-up). |
| `@marmeon/storage` | `uploads:prune`, `make:uploads-table`. See [file storage](storage.md#the-uploads-table). |
| `@marmeon/notifications` | `notifications:prune`, `make:notifications-table`. See [notifications](notifications.md#the-notifications-table). |
| `@marmeon/auth` | `make:auth`, `make:sign-ins-table`, `auth:end-all-sessions --force [--keep-api-tokens] [--keep-reset-tokens]` (signs every account out and revokes API and reset tokens, see [ending every session of every account](authentication.md#ending-every-session-of-every-account)), `auth:prune-tokens` (also deletes the sign-ins that are over, see [sign-ins](authentication.md#pruning-sign-ins)), `auth:end-sessions <identifier> --force` (see [ending every session of a user](authentication.md#ending-every-session-of-a-user)) and `auth:reset-two-factor <identifier> --force` (see [operator reset](two-factor-authentication.md#operator-reset)). The module `make:auth` writes adds `auth:prune-unverified`. See [starter kit](starter-kit.md). |
| `@marmeon/devtools` | `devtools:clear`, `devtools:prune`. See [devtools](devtools.md). |

## Writing commands

A command is a class with a name, a description and `handle()`. It is built through the container like a controller, so its
constructor gets what it asks for:

```ts title="modules/notes/commands/PruneArchivedNotesCommand.ts"
import { Clock } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { NoteRepository } from '../NoteRepository.ts';

const DAY = 86_400_000;

export class PruneArchivedNotesCommand {
  static command = 'notes:prune-archived';
  static description = 'Delete notes archived more than --days ago';
  static usage = '[--days=30]';
  static options = { days: { type: 'string' } } as const;

  readonly #notes: NoteRepository;
  readonly #clock: Clock;

  constructor(notes: NoteRepository, clock: Clock) {
    this.#notes = notes;
    this.#clock = clock;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const days = Number(options.days ?? 30);
    if (!Number.isInteger(days) || days < 1) {
      output.error(`--days must be a whole number of days, not ${String(options.days)}.`);
      return 1;
    }
    const deleted = await this.#notes.deleteArchivedBefore(new Date(this.#clock.now() - days * DAY));
    output.success(`Deleted ${deleted} archived notes.`);
    return 0;
  }
}
```

`marmeon make:command PruneArchivedNotes --module=notes` writes the class with the name `notes:prune-archived-notes` and lists it in
the module. The generator refuses, and writes nothing, when the name is taken — by a built-in, an installed package or a module. It loads the app the way `marmeon build` does, every provider registered and none booted, so an app that cannot be loaded stops it with that error. A module lists its commands, and they appear in `marmeon list`:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import { PruneArchivedNotesCommand } from './commands/PruneArchivedNotesCommand.ts';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  routes,
  commands: [PruneArchivedNotesCommand],
});
```

- **`static command`** is the name you type. A part before a colon groups it in the list. A name used twice by different commands — two modules, a module and a package, or a module and a built-in — fails `marmeon build` and the start with an error naming both classes and where they come from (a built-in that runs without booting, such as `make:*` or `key:generate`, still runs, but `marmeon build`, `marmeon list` and every command that loads the app report the clash); the same class listed twice is fine. `list` and `help` are marmeon's own and refused as command names.
- **`static usage`** is shown in errors, after the name: `Usage: marmeon notes:prune-archived [--days=30]`.
- **`static options`** declares the options in the format of Node's `parseArgs`: `{ type: 'string' }` or `{ type: 'boolean' }`,
  with `short: 'd'` for a one-letter form. An option the command does not declare is an error before the command runs.
- **`static hidden = true`** keeps a command out of `marmeon list`.
- **`static experimental = true`** marks a command that may change in any minor version. `marmeon list` and `--help` add
  "(experimental)". See [experimental](releases.md#experimental).
- **`handle(input)`** gets the positional arguments as `args`, the options as `options`, the console as `output` and the app's
  directory as `root`, `prompt` for [asking a question](#asking-a-question), and `spawn(...args)` runs another `marmeon` command in a fresh process. It returns the exit code, and
  nothing means 0.

`output` writes `line()`, `info()`, `success()` and `table(header, rows)` to stdout, and `warn()` and `error()` to stderr. Colours
are dropped when the output is no terminal.

Each run gets a scope of its own, as a request does. A scoped service, such as the `Translator`, is fresh for each command and
speaks `APP_LOCALE`. The app shuts down after the command, so open connections never keep the process alive. An error the command
throws prints its message and the first lines of its stack, and the exit code is 1.

The scheduler runs a command as a task: `s.command('notes:prune-archived', ['--days=60']).daily()`. Each run again gets a scope of
its own. The [task scheduling](scheduling.md#commands) page covers the schedule.

### Asking a question

A command that has to know which of several things to do can ask through `prompt`. Ask only when `prompt.interactive` is true, and
take the answer from an option otherwise. `prompt.choose(question, choices, { multiple })` numbers the choices from 1 and resolves with
the indexes of those picked:

```ts
async handle({ prompt, options, output }: CommandInput): Promise<number> {
  const packages = ['@marmeon/auth', '@marmeon/queue', '@marmeon/storage'];
  if (!prompt.interactive && options.package === undefined) {
    output.error('Say which package with --package=<name>; nothing is asked here.');
    return 2;
  }
  const picked = prompt.interactive ? await prompt.choose('Which packages?', packages, { multiple: true }) : [];
  // …
  return 0;
}
```

The answer is one number, or with `multiple` several, separated by commas or spaces, or `a` for all. An empty answer picks none. An
answer that is no choice is asked again, up to three times, then counts as none. Control characters in the question and the choices
are dropped, so a name taken from a package cannot redraw the terminal. Ctrl-C or the end of the input ends the command with
"cancelled" and exit code 130; a command that wraps `choose()` in a `try` should let that error pass.

`prompt.interactive` is true only when stdin and stdout are both a terminal, the environment variable `CI` is unset (or empty, `0` or
`false`) and `--no-interaction` is not given. Without a terminal, in CI or with `--no-interaction`, nothing is asked: `choose()` throws
instead of waiting. An agent without a terminal is never asked. The scheduler runs commands without a terminal.

## Tinker

`marmeon tinker` is experimental: it can change in any minor release. See [the release policy](releases.md#experimental).

`marmeon tinker` opens a REPL with the booted app. It is Node's own REPL: `await` works at the top level, input may span several
lines, and you type TypeScript with the same erasable syntax as the app's files:

```text
$ pnpm marmeon tinker
Marmeon tinker · my-app · NODE_ENV=development · db sqlite (storage/database.sqlite) · .ls lists helpers
> const user = await repos.users.find(1)
> url('notes.index')
'/notes'
> await jobs.dispatch(SendWelcomeMailJob, { userId: user!.id })
```

| Helper | What it is |
| --- | --- |
| `app` | The `Application`: its container, modules and root. |
| `make(Key)`, `make('Name')` | Resolves a class or token in the session's scope, also by its name. |
| `db` | The query builder of the default connection. |
| `repos.<table>` | The app's repositories, by their table, or by class name where two share a table. |
| `jobs` | The `Queue`. |
| `events` | The `EventDispatcher`. |
| `mail` | The `Mailer`. |
| `url(name, params?, query?)` | The path of a named route. |
| `t(key, params?)` | A text in `APP_LOCALE`. |
| `config.<name>` | The resolved configuration: `config.app`, `config.mail`, … |

Every class and token the container binds, every class a module lists, such as jobs, listeners and seeders, and every repository is
there by its name: `make(Mailer)` and `jobs.dispatch(SendWelcomeMailJob, …)` need no import. A helper is built on first use, and
one whose package the app lacks says what to install. A result that is a promise is awaited. Tab completes the helpers, the names,
`repos.`, `config.` and route names in `url('`. `.ls` lists them all, `.help` the REPL's commands.

The session has one scope from start to end. The log carries no request context.

### Trying things in a sandbox

`--sandbox` runs the whole session in one transaction on the default connection and rolls it back when the session ends: on
`.exit`, Ctrl-D, Ctrl-C twice, a signal or a crash. A session that dies never commits. Each input is a savepoint of its own, so a
failing input takes back only its own writes. So does an input whose value is an `err`, such as a `tryInsert()` of a taken
address: an `err` rolls its savepoint back, as the [transactions](transactions.md#returning-an-err) page explains, and tinker
still prints it. Jobs on the `database` queue join the transaction and are gone with it, and jobs on other queues and mails that
wait for the commit never go out.

A sandbox does not undo a mail sent directly, a file written to a disk, a Redis command or an HTTP call. Nor does it undo what the
cache, its locks and rate limits, and the sessions write: they use a connection of their own, also inside the sandbox. On SQLite,
when they share the app's file, they cannot write inside the transaction at all. Tinker says so and suggests giving them a file of
their own, which the [cache](cache.md#the-database-driver-and-transactions) page explains.

> [!WARNING]
> On SQLite, a sandbox session that wrote holds the file's write lock until it ends. The dev server and the worker still read,
> but their writes wait five seconds and then fail with `database is locked`. Keep sandbox sessions short there.

### Running code from a script

`--execute`, or `-e`, evaluates one input and exits:

```sh
pnpm marmeon tinker --execute "await repos.users.count()"
pnpm marmeon tinker --sandbox -e "await repos.notes.insert({ user_id: 1, title: 'Draft', body: '' })"
```

Only the value goes to stdout: a string as it is, anything else inspected, nothing for `undefined`. An error prints its stack to
stderr and the exit code is 1. A signal ends it with 130.

### On a server

Tinker works in every environment: whoever has a shell on the server can already do anything the app can. Where the app is
protected, in production, a staging server included, or without a `NODE_ENV`, the banner says so in red and names the database:
`PRODUCTION — NODE_ENV=production, APP_ENV=staging, db pgsql (db.internal:5432/app): every change is real.` It names the driver, host and
database, never a user or a password. With `--execute` the same line goes to stderr, so a script's stdout keeps only the value.
`--sandbox` is the safe way to look around.

### History

The inputs of interactive sessions are kept in `storage/framework/tinker_history`, the last 1000 lines. A new file is readable
only by its owner. It is plain text: a password you hash or a token you paste is in it. `--no-history` keeps none. The history
holds inputs only, never what the REPL printed.

## Lint

A new app has a lint preset, `.oxlintrc.json`, and `pnpm lint` runs [oxlint](https://oxc.rs/docs/guide/usage/linter) with it. The
preset is yours to change. `marmeon make:lint-config` writes it, and `--force` writes it anew over your changes.

Its main rule: client code imports server code as types only. A view needs its controller's type, never the class:

```tsx
import type { ShowNoteController } from '../controllers/ShowNoteController.ts'; // fine
import { ShowNoteController } from '../controllers/ShowNoteController.ts';      // a lint error in a view
```

A value import would bundle the controller, and everything it imports, into the browser. In views, layouts and the client
entry, the preset refuses value imports of controllers, repositories, service providers and module entries. Everywhere it asks
for `import type { X }` instead of `import { type X }`, since the inline form still loads the module.

The lint sees what an import says, not the file it resolves to. The `marmeon()` Vite plugin is the stricter check: it follows
every import of client code, also through a helper in between, and fails the build with the file and the line. The preset shows
the common case in the editor first.

In every file, tests included, the preset refuses imports of `@marmeon/<package>/internal`. Those subpaths are the framework's
own code and can change in any release; use the package's entry.

The preset also turns off the warning for unused private class members, in every class. That lets an event class carry
`readonly #event = true`, which `make:event` writes: the field is never read, and it makes the class a type of its own. The
[events](events.md#defining-events) page explains why. A private member your own classes no longer use is not reported either.

`--boundaries` adds a second rule: a module imports another module only through its entry, `#modules/<name>`. The
[modules](modules.md#a-modules-public-api) page explains it. Without the flag, nothing about the structure of your modules is
checked.
