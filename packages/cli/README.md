# @bespokecore/cli

The `bespoke` command: the launcher (`bespoke dev`, `bespoke start`), the built-in commands (`route:list`, `route:types`,
`build`, `key:generate`, `make:*`, `tinker`) and the commands of the installed packages and the app's modules. A command is
a class with `handle()` and constructor injection, built in a container scope of its own (see `src/command.ts`). This README
covers `bespoke tinker`; the rest follows with the docs app.

## tinker

A REPL with the booted application (E122) — Node's own (`await` at the top level, preview, multi-line input), with
TypeScript input and a few helpers:

```text
$ bespoke tinker
BespokeCore tinker · web-app · NODE_ENV=development · db sqlite (storage/database.sqlite) · .ls lists helpers
> const user = await repos.users.find(1)
> const n: number = await repos.users.count()
> await jobs.dispatch(SendWelcomeMailJob, { userId: user!.id })
> url('user-profile.show', { user: 1 })
'/users/1'
> make(Mailer)                              // make(<Tab> completes class and token names
```

| Helper | What it is |
|---|---|
| `app` | the `Application` — container, modules, root |
| `make(Key)` · `make('Name')` | resolves a class or token in the session's scope (by name, too) |
| `db` | Kysely on the default connection (`@bespokecore/database`) |
| `repos.<table>` | the app's repositories: every `*Repository.ts` under the app (not `node_modules`, `dist`, `storage`), by its `static table` — by class name where two share a table |
| `jobs` | the `Queue` (`@bespokecore/queue`) |
| `events` | the `EventDispatcher` |
| `mail` | the `Mailer` (`@bespokecore/mail`) |
| `url(name, params?, query?)` | the path of a named route |
| `t(key, params?)` | a text in `APP_LOCALE` (`@bespokecore/i18n`) |
| `config.<name>` | the resolved configuration, by name (`config.app`, `config.mail`, …) |

- **By name:** every class and token the container binds, every class a module lists (jobs, notifications, seeders,
  listeners and their events, …) and every repository is there by its name — `make(Mailer)`, `jobs.dispatch(SendWelcomeMailJob, …)`
  need no import. A name the REPL already has (`URL`, `Response`) keeps its meaning.
- **Lazy:** a helper is built on first use; one the app has no package for says what to install (`.ls` marks it). Assigning
  to a helper (`db = …`) replaces it like any variable.
- **One scope per session**, like a command's: scoped services (the `Translator` in `APP_LOCALE`) live as long as the session.
  The log carries no request context.
- **TypeScript:** the input goes through Node's `module.stripTypeScriptTypes()` — the same erasable syntax as the app's files
  (no `enum`, no parameter properties; an `enum` is an error that says so). Input that ends too early continues on the next line.
- **A result that is a promise is awaited** — `repos.users.count()` shows the number, as with `await`.
- **Completion:** the helpers and names, `repos.<Tab>`, `config.<Tab>`, `make(<Tab>` / `make('<Tab>`, and route names in `url('<Tab>`.
- `.ls` lists the helpers, the repositories and the names; `.help` the commands.

### `--sandbox`: everything rolled back

```sh
bespoke tinker --sandbox
```

The whole session runs in one transaction on the default connection (E107) — the context holds from input to input — and
rolls back when the session ends: `.exit`, Ctrl-D, Ctrl-C twice, SIGINT/SIGTERM, an error of the process (a session that dies
never commits). Each input is a savepoint of its own: an input that fails takes back only its own writes, and on Postgres the
transaction stays usable after a failed statement. Jobs on the `database` queue join the transaction and are gone with it;
jobs on other queues and mails that wait for the commit (`afterCommit`) never go out.

What it does **not** undo: a mail sent directly, files written to a disk, Redis, HTTP calls — and the infrastructure (E108):
the cache with its locks and rate limits and the sessions write on a connection of their own, also inside the sandbox. On
SQLite without a file of their own they cannot write inside the transaction at all — tinker says so instead of waiting
(`InfrastructureTransactionError` plus a hint); give them their own file (`CACHE_CONNECTION`, `SESSION_CONNECTION`) or Redis.

> [!WARNING]
> **SQLite:** once a sandbox session wrote, it holds the file's write lock until it ends. Other processes — the dev server, a
> worker — still read, but their writes wait (5 s) and then fail with `database is locked`. Keep sandbox sessions short there.

### `--execute`: for scripts

```sh
bespoke tinker --execute "await repos.users.count()"          # prints 3
bespoke tinker -e "url('user-profile.show', { user: 1 })"     # prints /users/1 (strings as they are)
bespoke tinker --sandbox -e "await repos.users.insert({ … })"  # tries it, rolls back
```

Evaluates the code like one input of the REPL and prints the value (a string as it is, anything else inspected; nothing for
`undefined`) — only the value goes to stdout. An error prints its stack to stderr and exits with **1**.

### Production

`tinker` works in every environment: access to the server's shell is the gate (E122). In production the banner says so in
red — `PRODUCTION — NODE_ENV=production, db pgsql (db.internal:5432/app): every change is real.` (`--execute`: on stderr).
The banner names the driver, host and database, never a user or password. `--sandbox` is the safe way to look around.

### History

The inputs of interactive sessions are kept in `storage/framework/tinker_history` (1000 lines, readable only by its owner).
**It is plain text:** whatever you type — a password you hash, a token you paste — is in it. `--no-history` keeps none.
Values the REPL prints are not redacted: they are what you asked for (a `secret()` column you selected shows); the history
holds inputs only, never output, and the banner never shows a secret.
