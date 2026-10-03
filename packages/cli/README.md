# @bespokecore/cli

The `bespoke` command: the launcher (`bespoke dev`, `bespoke start`), the built-in commands (`route:list`, `route:types`,
`build`, `key:generate`, `make:*`, `tinker`) and the commands of the installed packages and the app's modules. A command is
a class with `handle()` and constructor injection, built in a container scope of its own (see `src/command.ts`). This README
covers `bespoke tinker` and the lint preset (`make:lint-config`); the rest follows with the docs app.

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

## Lint

`bespoke make:lint-config` writes an [oxlint](https://oxc.rs/docs/guide/usage/linter) config for the app (E121) —
`.oxlintrc.json` in the app root, yours to change (`--force` writes it anew):

```text
$ bespoke make:lint-config [--boundaries]
✓ Created .oxlintrc.json
$ pnpm add -D oxlint && pnpm exec oxlint
modules/auth/views/Login.tsx:3:1: error eslint(no-restricted-imports): '../controllers/ShowLoginController.ts' import is
  restricted from being used by a pattern. help: Client code (views, layouts, the client entry) imports server code —
  controllers, repositories, service providers, a module's entry (#modules/…) — only with `import type`: a value import
  bundles it, and everything it imports, into the browser.
```

**Client code imports server code as types only.** A view needs its controller's type (`PageProps<ShowLoginController>`),
never the class. `import { ShowLoginController }` is a value import even where only the type is used — with
`verbatimModuleSyntax` it stays in the output and drags the controller, and everything it imports (the session, the database
driver …), into the browser bundle. The preset restricts, in `modules/*/views/**`, `modules/*/layouts/**`, `layouts/**` and
`bootstrap/client.*`, imports of `**/controllers/**`, of `*Repository`/`*ServiceProvider` files and of module entries
(`#modules/<name>`) to `import type` (`no-restricted-imports` with `allowTypeImports`), and everywhere
`import { type X }` to `import type { X }` (`typescript/no-import-type-side-effects`): the inline form also stays in the
output, as `import {} from …`, and loads the module.

oxlint sees the import's text, not the file it resolves to. The authoritative check is the `bespoke()` Vite plugin's: it
resolves every import of client code, follows indirect ones (view → helper → controller) and knows more server modules
(jobs, listeners, mails, policies, `config/` …) — an error in the dev overlay and a failed build, without a linter
(`@bespokecore/vite`, "Server code in the browser"). The preset shows the common case in the editor.

**`--boundaries` (opt-in, Leitprinzip 5):** a module imports another module only through its entry —
`import { MemberStats } from '#modules/user-profile'` (the app's `package.json` maps `"#modules/*": "./modules/*/index.ts"`),
never `../../user-profile/MemberStats.ts`. The module's `index.ts` decides what it shares; its tables stay its own with
`Database<'module'>` and `exposes` (E20). Tests may reach into any module (factories, jobs). Without the flag nothing about
module structure is checked — BespokeCore imposes no architecture.

Why the generated file is long: oxlint matches import specifiers as text, so "leaves the module" depends on the folder depth
(`../billing/x.ts` from `modules/auth/a.ts`, `../../billing/x.ts` from `modules/auth/listeners/b.ts` — but
`../notifications/n.ts` from there is the module's own `notifications/` folder). The preset has one override per depth
(eight, more when the app's modules go deeper), and a later override replaces an earlier one's options for the same rule, so
the client folders carry both rules. The patterns are gitignore globs with negations (`!../*/index.*`): oxlint's `regex`
has no lookaround, and a regex it cannot compile is dropped without a word — the generator's test lints a fixture app to
prove every pattern fires. Two more oxlint findings: its `ignorePatterns` filters what it reports but still walks the
directories — only a `.gitignore` (or `--ignore-pattern`) keeps it out of `node_modules`; without one, the walk through pnpm's
links took 30 s and more (the blank app now has its own `.gitignore`). And a nested `.oxlintrc.json` replaces the one above it
instead of merging (an app's preset is complete on its own).

**Before E121**, nothing enforced `import type` (W7 plan, finding 8). A value import of a controller in a view failed the
build only by accident — after 144 "externalized for browser compatibility" warnings, with
`Rolldown failed to resolve import "@oxc-parser/binding-wasm32-wasip1"` (core's injection analyzer pulls in oxc-parser), and
the view named nowhere; a server module that did not reach `@bespokecore/core` built green and shipped its code. The dev
server showed the same unrelated error in the overlay, and the page did not hydrate.

**The repository** lints itself with `pnpm lint` (`oxlint --deny-warnings`, part of `pnpm run ci`): the root
`.oxlintrc.json` (oxlint's correctness rules as errors, plus `no-import-type-side-effects`; off with a reason: unused
private brands such as `readonly #event = true`, deliberate copies before deleting while iterating, `this` aliases that walk a
parent chain). The apps carry the generated preset — `apps/web-app` with `--boundaries`, `apps/blank-app` without — which
oxlint takes for their files instead (nested configs do not merge). `make:auth` does not write a lint config (it belongs to
the app, not to a module); the make:auth fixture test lints the generated module with and without `--boundaries`.
