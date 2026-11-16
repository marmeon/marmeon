# Package Development

## Introduction

A package brings services, configuration, commands, middleware and routes into every app that installs it, and the app lists
nothing. The framework's own packages work this way, and a package of yours does the same. It opts in with a `"marmeon"` field
in its `package.json` that names its service provider:

```json title="package.json"
{
  "name": "@acme/marmeon-request-log",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "marmeon": {
    "providers": ["RequestLogServiceProvider"]
  },
  "dependencies": {
    "@marmeon/core": "^0.1.0",
    "@marmeon/http": "^0.1.0",
    "@marmeon/router": "^0.1.0",
    "@marmeon/validation": "^0.1.0"
  },
  "peerDependencies": {
    "marmeon": "^0.1.0"
  }
}
```

After `pnpm add @acme/marmeon-request-log`, the app registers `RequestLogServiceProvider` at its next start, with no extra step. This page
builds that package: a request log with its configuration, a middleware, a command and a route. Its `RequestLog` buffers an entry
for every request and writes the buffer when it is flushed, so it is not an audit trail: an entry written later and outside the
transaction of a change can be missing for a change that was kept. A trail that must commit with its change is a listener that
writes in the change's transaction, see [an audit trail](events.md#an-audit-trail).

## The package protocol

Everything on this page that an app or the framework reads from a package is the *package protocol*. A package may rely on what
this section lists, and on nothing else: not on the order in which the framework reads a list, and not on a static it does not name here.

**The version of the protocol is the major version of `@marmeon/core`**, the one your package's range for `@marmeon/core` (or for
`marmeon`, which has the same version) accepts. There is no second version field in `package.json`, since it could only contradict
the range.

The rule for change is the one of the public API:

- Removing a part of the protocol or changing what it means happens only in a major version, after a [deprecation](releases.md#deprecations).
- A new key of the `"marmeon"` field, a new static or a new kind of class is added in a minor version and never changes what a
  package without it does. A package must therefore not read a static it does not know to be its own, and the framework never
  needs a package to declare one.

The tables below list every part.

### The `"marmeon"` field

| Key | What it holds |
| --- | --- |
| `providers` | The names of service provider classes that the package's entry exports, each a JavaScript identifier. |
| `browser` | Globs of the package's files that run only in the browser, relative to the package, such as `["src/client/**"]`. |
| `experimental` | `true`, or a list of the package's `exports` subpaths: marks the package, or those entries, as [experimental](releases.md#experimental). |
| `namespace` | The prefix of the package's pages and texts, such as `"status"`: lowercase letters, digits and single hyphens, starting with a letter, at most 32 characters, and not `app` or `marmeon`. Required with `entry`, `views` or `lang`; alone it marks a package whose code is user interface. See [Pages of a package](#pages-of-a-package). |
| `entry` | `{ "client": "./area/client", "ssr": "./area/ssr" }`: two subpaths of the package's `exports` that start its own document. Only with `views`. |
| `views` | The subpath of the package's pages, such as `"./views"`. Its `exports` holds the pattern `"./views/*"`. Only with `entry`. |
| `lang` | The subpath of the package's texts, such as `"./lang"`, with the pattern `"./lang/*"` in `exports`. |
| `serverModules` | Only in the app's own package.json: globs of server code beyond the conventions. Ignored in a dependency. See [Server folders of your own](vite.md#server-folders-of-your-own). |

The field is an object with these keys and no others. The app finds it when it walks its dependencies, the dev dependencies
included, and the dependencies of those, and a field that does not hold to this stops the app, because the package's `package.json`
is someone else's file and a key that is silently skipped hides a mistake:

- A key that is not listed, such as `provider` for `providers`, ends discovery with `K7`: `@acme/marmeon-request-log has an unknown key
  "provider" in its "marmeon" field (known: providers, browser, experimental, serverModules, namespace, entry, views, lang) — a misspelt key would leave its providers out.`
  The message names the package and the key, and the key only if it is a plain identifier; it never repeats a value of the field.
  The same holds for a `migrations` key, since migrations are a static of the provider (below).
- A field that is not an object (an array, a string, `null`), a `providers` that is not a list of class names, or a `browser` that
  is not a list of strings also ends discovery with `K7`.

- A `namespace` that is not valid, `entry`, `views` or `lang` without a `namespace`, an `entry` without exactly `client` and `ssr`, `entry`
  without `views` or the reverse, or two packages with one namespace also end discovery with `K7`, naming both packages in the last case.

A package's providers register after the providers of the packages it depends on, so list the framework packages you build on as
dependencies. A name in `providers` that the entry does not export stops the app with
`@acme/marmeon-request-log lists provider "RequestLogServiceProvider" in package.json, but its entry does not export it.`

The app writes what it found to `.marmeon/manifest.json` and writes it again by itself when `package.json` or the lockfile
change. The [modules](modules.md#discovery) page explains discovery from the app's side, and how an app turns it off.

### Provider statics

A provider class lists what it brings in these statics. All are optional, and a provider with none of them, no `register()`,
`boot()` or `shutdown()` is refused (`K9`). The first four are read by `@marmeon/core`; the others are added by the package that
reads them, and are known once that package is installed.

| Static | Type | Read by | More |
| --- | --- | --- | --- |
| `config` | `readonly ConfigDefinition[]` | the application, before any provider registers | [Configuration](#configuration) |
| `solutions` | `readonly SolutionDefinition[]` | the development error page | [Solutions](errors.md#solutions) |
| `health` | `readonly HealthCheckClass[]` | `/up/ready` | [Health checks](health.md#writing-a-health-check) |
| `errorReporters` | `readonly ErrorReporterClass[]` | the application, for every server error | [Reporting](errors.md#reporting) |
| `commands` | `readonly CommandClass[]` | `marmeon` | [Commands](#commands) |
| `checks` | `readonly AppCheckClass[]` | `marmeon check` | [Checks](#checks) |
| `migrations` | `{ from: URL, module: string }` | `marmeon publish` | [Declaring the migrations a package ships](#declaring-the-migrations-a-package-ships) |
| `publishes` | `{ lang: URL }` | `marmeon publish` | [Declaring the files a package publishes](#declaring-the-files-a-package-publishes) |
| `queueDrivers` | `Record<string, QueueDriverFactory>` | `@marmeon/queue` | [Drivers](drivers.md#bringing-a-driver) |
| `failedJobDrivers` | `Record<string, FailedJobStoreFactory>` | `@marmeon/queue` | [Drivers](drivers.md#bringing-a-driver) |
| `diskDrivers` | `Record<string, DiskDriverFactory>` | `@marmeon/storage` | [Drivers](drivers.md#bringing-a-driver) |
| `cacheDrivers` | `Record<string, CacheDriverFactory>` | `@marmeon/cache` | [Drivers](drivers.md#bringing-a-driver) |
| `mailDrivers` | `Record<string, MailDriverFactory>` | `@marmeon/mail` | [Drivers](drivers.md#bringing-a-driver) |

### Statics of other classes

| Class | Static | Meaning |
| --- | --- | --- |
| any class the container builds | `inject` | The list of what the constructor needs, in the order of its parameters. Without it, the build or the app's start derives it from the `.d.ts` files ([injected classes](#injected-classes)). |
| a health check | `check`, `timeout` | The check's name, unique among the checks, and how long it may take: a number of seconds, or a [`Duration`](time.md#spans-of-time) ([health](health.md#writing-a-health-check)). |
| a check of `marmeon check` | `check`, `phase`, `timeout` | The check's name in kebab-case, `'build'` or `'run'`, and how long it may take ([checks](#checks)). |
| a command | `command`, `description`, `usage`, `options`, `hidden`, `experimental` | The name one types and what `marmeon list` shows ([writing commands](console.md#writing-commands)). A `hidden` command is a step of another command and no API, unlike the package's other commands. |
| a controller | `request` | The request schema that validates the route's input and types its context ([controllers](controllers.md)). |
| a repository | `table`, `connection`, `routeKey`, `routeKeyPattern` | The table, the default connection, and the column and pattern a route parameter is bound by ([repositories](queries.md#defining-a-repository)). |
| an event that queued listeners listen to | `event`, `schema` | Its stable name and the schema of what is queued ([queued listeners](events.md#queued-listeners)). |

The statics of jobs, notifications and queued listeners (`job`, `schema`, `tries`, `backoff`, `timeout`, `encrypted`, `middleware`, `notification`, `database`, `queue`, `listener`) and the `preview` of a mail are not part of the protocol: only a module registers those classes, and a package's provider does not list them. That holds for the listeners of a [guard's](authentication.md#events-of-a-guard) or a [guard slot's events](authentication.md#events-of-a-guard-slot) too: the app lists them in a module.

## The service provider

A package has no module definition, so its provider carries what a module would list: its configuration, its health checks and its
solutions. The [service providers](providers.md) page explains `register()`, `boot()` and `shutdown()`; here is what matters for a
package:

```ts title="src/RequestLogServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { RequestLogConfig } from './RequestLogConfig.ts';
import { RequestLog } from './RequestLog.ts';
import { PruneRequestLogCommand } from './PruneRequestLogCommand.ts';
import { RecordRequest } from './RecordRequest.ts';

export class RequestLogServiceProvider implements ServiceProvider {
  static config = [RequestLogConfig];
  static commands = [PruneRequestLogCommand];

  register(container: Container): void {
    container.singleton(RequestLog);
  }

  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, RecordRequest, 50);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RequestLog).flush();
  }
}
```

- **`register()`** binds only, because another package's services may not be bound yet. The one exception is the `Router`, to
  load named routes, as [routes](#routes) explains.
- **`boot()`** runs once every provider of the app has registered, and may resolve anything.
- **`shutdown()`** runs when the app stops, in reverse order, while the services the provider depends on still exist.
- **`static health`** lists checks for `/up/ready`, which the [health](health.md#writing-a-health-check) page covers, and
  `static solutions` lists solutions for the package's errors, shown on the [development error page](errors.md#solutions). `static errorReporters` lists error reporters that receive the
  app's server errors in a masked form; [reporting](errors.md#reporting) shows how to write one.

### Configuration

`static config` lists the package's configuration definitions. The app checks them with its own before any provider registers, so
a wrong value stops the start with the variable's name:

```ts title="src/RequestLogConfig.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const RequestLogConfig = defineConfig('requestLog', {
  env: env({
    REQUEST_LOG_ENABLED: env.boolean().default(true),
    REQUEST_LOG_RETENTION_DAYS: env.integer().min(1).max(3650).default(90),
  }),
  resolve: (e) => ({ enabled: e.REQUEST_LOG_ENABLED, retentionDays: e.REQUEST_LOG_RETENTION_DAYS }),
});
export type RequestLogConfig = ConfigOf<typeof RequestLogConfig>;
```

The environment reader `env` comes with `@marmeon/core`, which every package depends on, so a package's configuration needs no
validation library. The [configuration](configuration.md#reading-variables) page lists its building blocks.

Prefix the variables with the package's name, so they never collide with the app's. Give every variable a default that is safe,
and document each one in a table, as these pages do. Read configuration in `boot()` or in the services themselves, never in
`register()`: `marmeon build` registers every provider without `.env` and without secrets, and reading a configuration that
needs one there throws. The [configuration](configuration.md#configuration-and-the-build) page explains it.

### Injected classes

The app builds a package's classes through the container like its own. Their constructors list what they need, and the lists of
what to inject come from the build: `marmeon package:build` writes them into the compiled files. Without it, the app derives them
at start from the `.d.ts` files, for the classes that the package's entry and its other `exports` subpaths export. Every parameter
must be a class or a token, as the [service container](container.md#constructor-injection) page explains. A class in a `browser`
glob gets no list, so no injection code reaches a client bundle. `marmeon package:build` also marks a controller that answers with an
[island](deferred-props.md#the-islands-route); a package built before that mark existed answers an island's request with a 404 until
it is built again, because the app's loader leaves `node_modules` alone.

## Drivers

A package can bring a driver for a service that selects its drivers by name, such as a queue driver for SQS. It lists a factory in
a static record of its provider, such as `static queueDrivers = { sqs }`, and the app selects it with an environment variable. The
[drivers](drivers.md) page lists the records, the names a driver may take and the checks at the start.

## Commands

A package lists its commands as `static commands` on its provider. The CLI collects them while the app registers, before anything
boots, so `marmeon build` sees them and stops on a name that is taken twice; the message names both commands and the provider.
`marmeon` stays an optional peer dependency — the command files import only its types. A command is a class like any
[command of an app](console.md#writing-commands):

```ts title="src/PruneRequestLogCommand.ts"
import type { CommandInput } from 'marmeon';
import { RequestLogConfig } from './RequestLogConfig.ts';
import { RequestLog } from './RequestLog.ts';

export class PruneRequestLogCommand {
  static command = 'request-log:prune';
  static description = 'Delete request-log entries older than REQUEST_LOG_RETENTION_DAYS';

  readonly #log: RequestLog;
  readonly #config: RequestLogConfig;

  constructor(log: RequestLog, config: RequestLogConfig) {
    this.#log = log;
    this.#config = config;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const deleted = await this.#log.pruneOlderThan(this.#config.retentionDays);
    output.success(`Deleted ${deleted} request-log entries.`);
    return 0;
  }
}
```

Name a package's commands with a prefix of their own, such as `request-log:`. A package's commands always run in a booted app.
`static boots` is read for the framework's built-in commands only.

`DevProcesses` of `marmeon` adds a process that `marmeon dev` starts next to the server, as the queue does with its worker:
`app.container.make(DevProcesses).add({ name: 'request-log', args: ['request-log:watch'] })`. The arguments are those of a `marmeon` command.

### Registering what a generator writes

A generator that writes a class for a module can also list it there. `editDefinitionFile` of `@marmeon/core` adds an entry to a list of the object that `defineModule` or `defineApplication` receives, together with the imports it needs. It only inserts: the rest of the file stays as it was, comments, quotes and line endings included. Running it twice adds nothing the second time.

```ts
import { join } from 'node:path';
import { editDefinitionFile } from '@marmeon/core';

const outcome = editDefinitionFile(join(root, 'bootstrap', 'app.ts'), {
  define: { name: 'defineApplication', from: '@marmeon/core' },
  key: 'modules',
  add: { element: (names) => names.requestLog!, position: 'last' },
  imports: [{ name: 'requestLog', from: '#modules/request-log', kind: 'default' }],
});
```

The outcome is `added` (the file is written), `present` (the entry is already there) or `manual`. A file the editor does not understand
is `manual` and stays untouched: a list held in a variable, a spread that could set the key, two `defineModule` calls, a name that
is already bound to something else (a constant, class, type, interface, namespace or `import … = require()`), a file that is not writable. The generator then prints the reason and the lines to add by hand. `add: { value }` sets a
property such as `migrations` instead of a list entry. `editDefinition` does the same on a source string, and `importedBindings`
lists a file's imports for a generator that follows one.

The reasons name the file by its path. Pass an app-relative name as the third argument, `editDefinitionFile(file, edit, 'bootstrap/app.ts')`, so that a message does not show an absolute path.

## Checks

A package adds checks to [`marmeon check`](check.md) as `static checks` on its provider, a module as `checks` in its definition.
A check is a class with `static check` (its name, in kebab-case) and `static phase`, and a `handle()` that returns what it found:

```ts title="src/RequestLogTableCheck.ts"
import type { AppCheck, CheckProblem } from 'marmeon';
import { RequestLog } from './RequestLog.ts';

export class RequestLogTableCheck implements AppCheck {
  static check = 'request-log-table';
  static phase = 'run' as const;

  readonly #log: RequestLog;

  constructor(log: RequestLog) {
    this.#log = log;
  }

  async handle(): Promise<readonly CheckProblem[]> {
    if (await this.#log.hasTable()) return [];
    return [{ severity: 'error', message: 'The request-log table is missing', fix: 'marmeon migrate', docs: 'docs/request-log.md#installation' }];
  }
}
```

`static phase = 'build'` is for a check that reads only what registering the app builds, with no secret and no connection; `'run'`
is for anything that reads configuration or opens a connection, and gets the booted app. The check is built through the container in
a scope of its own. `handle()` is given `{ signal }`, aborted when the time is up: release what you opened. Return `{ skipped: 'why' }` instead of findings when the check should not run here, or `{ problems, silenced }` to report findings a comment of the app silenced (each with its `reason`; one without a reason is a finding, not silenced). A finding is a [`CheckProblem`](check.md#json-output); its message is masked by the app's redactor, but name no secret in it.
A check that throws, or takes longer than a minute (`static timeout` sets it: seconds, or a `Duration` like `{ minutes: 2 }`, at most ten minutes; more stops the start with `K13`), ends as `error`, never as another check's result.

A bad or duplicate check name stops every command, not only `marmeon check`, as a command name used twice does. The name must be unique, in kebab-case, and none of `types`, `lint`, `internal-imports`, `raw-sql`, `inner-html`, `agents`, `packages`, `boot` or `readiness`; the app does
not start otherwise, and the message names both checks. A check that asks whether the package's service is reachable is not a
check but a [health check](health.md#writing-a-health-check): `marmeon check` runs those as `readiness`.

## Tables

A package that keeps tables in the app's database does not write them into the app itself. It ships the migrations as stubs, and
the app copies them. The contract has six parts:

1. **The directory.** The files lie in the directory `static migrations` names and are called `<timestamp>_<name>.ts`, such as
   `2026_01_01_000000_create_request_log_table.ts`. Name a file after its table, as an app does. They run in the order of their names,
   and a name without its timestamp is unique in the directory.
2. **Append-only.** A file that has shipped is never edited, renamed or deleted, because an app has copied it and its database has
   run it. A release that changes a table adds a file that sorts after every other in the directory. In the framework's repository, the "api label" check refuses a pull request that does otherwise.
3. **The plan.** `up(schema)` is synchronous and only describes the change; the app computes what it did without running it. Data
   changes go through `schema.data()` and nowhere else. A column that holds a secret, such as a token's hash, is marked
   `.secret()`. See [migration structure](migrations.md#migration-structure).
4. **The declaration and `publish`.** `static migrations` of your service provider names the directory of
   the stubs ([declaring the migrations a package ships](#declaring-the-migrations-a-package-ships)). `marmeon publish <package>`
   copies the files the app lacks ([publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package)),
   also after an update, and a command of your own can point the app to `marmeon publish <package>`.
5. **The requirements.** A table the package needs is registered with `SchemaRequirements` (from `@marmeon/database`). In `boot()`,
   take it with `app.container.make(SchemaRequirements)` once `app.container.has(Connections)`, and call
   `require({ connection, table, columns, secrets?, whenPresent? })`; a new instance checks nothing. `columns` are the columns
   the package reads and writes and `secrets` the ones that must be marked `.secret()`: readiness is red while the table
   is missing, lacks a column or has one unmarked, as in a table made by hand (not on a connection with `managed: false`). A
   requirement with `whenPresent: true` is for a table the app may never have made (the feature is unused): it is only checked once
   the table exists.
6. **No module with migrations.** A module's `migrations` must not point into the package's own folder in `node_modules`: the app
   refuses that with error D20, because a package update would change migrations the database has run. Ship the migrations as stubs
   the app copies.

Once a stub is on `main` it never changes and is never deleted: an app matches migrations by name, so an edit would reach new
apps and never the old ones. A change to a table is a new file that sorts after every file in its directory and has a name its
directory does not use yet. The repository's "api label" check refuses a pull request that does otherwise, whatever its labels.

### Declaring the migrations a package ships

The service provider of the package names the directory that holds the stubs that **create** its tables, and the module they go to:

```ts
import type { ServiceProvider } from '@marmeon/core';

export class RequestLogServiceProvider implements ServiceProvider {
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'request-log' };
  // …
}
```

`from` is a `file:` URL, built from `import.meta.url` so it names the same directory in `src/` and in the build: the path leads from
the file that holds the provider, so a provider in `src/provider.ts` writes `../stubs/migrations` and one in `src/request-log/provider.ts`
writes `../../stubs/migrations`. The static only declares the directory; it copies nothing. An app copies the files with
`marmeon publish <package>` ([publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package)), which
accepts only a direct dependency of the app. It reads `static migrations` of the providers the app boots, and imports the main
entry of each direct dependency a declaration points into (usually one the app has booted already).

The type is `ProviderMigrations` from `@marmeon/database`. A package that has `@marmeon/database` only as an optional peer writes
`satisfies ProviderMigrations` with an `import type`, or no annotation, so the type is checked while the package's `.d.ts` does
not mention the database.

Each file in the directory is named like a migration of an app, `<timestamp>_<name>.ts`, such as
`2026_01_01_000000_create_request_log_table.ts`. The migrations are read in the order of their file names. The timestamp only orders
the files within the package: `publish` gives a copy a new one in the app. The name without the timestamp (`create_request_log_table`)
is what identifies a migration, so it is unique in the directory. The framework's packages start with
`0001_01_01_000000_<name>.ts`; a file added later carries the date it was written. A file that has shipped is never edited or deleted:
a change of a table is a new file behind the others. Anything in the directory that does not end in `.ts`, such as a `README.md`, and
every sub-directory is passed over.

`module` is required. It is a suggestion: the module the tables go to when the files are copied into the app, which the app can
change. Which module owns a table follows from the module its migration file is in, not from the package. The framework's own
packages name `system`.

The directory must lie in your package: in the directory the app installed, not in a `node_modules` inside it, and not through a
symlink that leads out. The same holds for the files `main`, `types` and `exports` name: discovery stops with [K7](errors.md#server-error-codes) when one lies outside the package, and when `exports` nests deeper than 32 levels. A provider re-exported from another package declares that package's migrations, which the app publishes from
that package. The provider must be exported from the main entry (`.`) of the package the directory lies in: a provider that entry
does not export is not counted for the package, and `publish` says so with a warning. A declaration that lies in no package the app
depends on, such as one in the app's own provider, is passed over. To see what `publish` makes of yours, run
`marmeon publish --check <package>` in an app that depends on it.

A package's code is not trusted, so the static is read strictly, once, and a wrong one fails with
[D21](errors.md#server-error-codes):

- `static migrations` is an object with only `from` and `module`, and two providers do not declare a directory for one package.
- `from` is a `file:` URL without host, query or fragment. Its real path, after following symlinks, lies inside the package, is not the package itself and is a directory.
- `module` is a kebab-case name such as `permissions`, so never a path; it has at most 64 characters and is no Windows device name (`nul`, `com1`, …).
- Every entry is checked by its own real path: a file that is a symlink leading out of the package, or is no regular file, is refused (so is a symlink to a directory whose name ends in `.ts`: it is no file, not passed over). A file whose contents are not valid UTF-8 or have no `export default` is refused too: it cannot be a migration. A hard link to a file outside the package is not detected.
- A `.ts` file is named `<timestamp>_<name>.ts` (so `create_things.ts` and `things.d.ts` are refused), at most 1 MiB, at most 100 in the directory, and the names without timestamp differ. The directory holds at least one.

List the directory in `files` of your `package.json`, so the stubs ship in the tarball; `pnpm pack:check` of this repository does
that for the framework's packages.

### Declaring the files a package publishes

`static publishes` names directories of files `marmeon publish --only=<kind>` copies into an app. In this version only `@marmeon/i18n` publishes
files, its language files, to `lang/marmeon/` (the target is fixed and is not the package's to choose):

```ts
export class I18nServiceProvider implements ServiceProvider {
  static publishes = { lang: new URL('../stubs/lang', import.meta.url) };
}
```

A package that declares `lang` and is not `@marmeon/i18n` (by its own `package.json`) is told so by a warning and publishes nothing. The
declaration is read like the migrations' (assigned to the package that exports the provider and holds the directory), and refused with
[D25](errors.md#server-error-codes) when:

- `static publishes` is no object with only `lang`, or `lang` is no `file:` URL without host, query or fragment.
- Its real path, after following symlinks, lies outside the package, is the package itself or is no directory.
- A file in it is named otherwise than `<language tag>.ts` (`en.ts`, `pt-BR.ts`), is a symlink leading out of the package or no regular file, is larger than 1 MiB, is not UTF-8 or has no `export default`.
- The directory holds more than 100 files, or none.

List the directory in `files` of your `package.json`.

## Middleware

`router.middleware.append(group, Middleware, priority)` adds a middleware to the global stack, `GLOBAL`, or to a group such as
`web` or `api`. The priority places it among the framework's middleware, lower first. Your app's own middleware has `app`, 1000.
The [middleware](middleware.md#the-order) page lists every priority, and `MiddlewarePriority` of `@marmeon/router` holds them.

Add middleware in `boot()`, as the provider above does. A middleware in the global stack runs for every request of every app that
installs the package, also for paths without a route, so keep it cheap.

## Routes

`router.load({ group, prefix }, routes)` loads a route file into a group. The same provider, with a page of its own:

```ts title="src/RequestLogServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { defineRoutes, everyone, Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { RequestLogConfig } from './RequestLogConfig.ts';
import { RequestLog } from './RequestLog.ts';
import { PruneRequestLogCommand } from './PruneRequestLogCommand.ts';
import { RecordRequest } from './RecordRequest.ts';
import { ShowRequestLogController } from './ShowRequestLogController.ts';

export class RequestLogServiceProvider implements ServiceProvider {
  static config = [RequestLogConfig];
  static commands = [PruneRequestLogCommand];

  register(container: Container): void {
    container.singleton(RequestLog);
    container.make(Router).load(
      { group: 'web', prefix: '/request-log' },
      defineRoutes((Route) => {
        // The page is open to anyone by this package's design, so it says so.
        Route.authorize(everyone).get('/', ShowRequestLogController).name('request-log.index');
      }),
    );
  }

  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, RecordRequest, 50);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RequestLog).flush();
  }
}
```

Load named routes in `register()`. `marmeon build` writes the app's route types from an app that registers and boots nothing, so
routes loaded in `boot()` serve requests but are not in `bootstrap/routes.ts`. Loading a route builds nothing, and the `Router`
is bound by `@marmeon/http`, whose provider registers before yours when your package depends on it. Routes without a name may load
in `boot()`. Prefix the paths and the names with the package's name, and protect a route the way an app would, with its own
middleware such as `authenticate()`. The prefix `/_marmeon/` belongs to the framework: a package route there stops the app at
start (see [the framework's paths](routing.md#the-frameworks-paths)). A package route says who may call it like an app's: with
`can(…)` or a check of your own through `Route.authorize(…)` or the request's `authorize`, or with `everyone` when anyone may. The
`@marmeon/*/internal` subpaths are how the framework's own packages mark theirs as the framework's, they are not API and outside semver, so they can change in any release, and a route
loaded with their marker outside `/_marmeon/` is refused at load; `pnpm check:source` refuses importing them outside the
framework's own sources.

A package that ships test doubles for its users' tests puts them in a `./testing` subpath of their own (`@marmeon/core/testing`
holds `TestClock` and `EventFake`), not in its main entry: the main entry stays what an app's code imports, and a bundle of the
app never contains a fake. Name the fakes `*Fake`, document them on [the fakes page](fakes.md) and export the types their
methods name from the same subpath.

### Hooks of the router

Two hooks let a package take part in every request. Add them in `boot()`:

| Hook | What it does |
| --- | --- |
| `router.beforeValidation(hook)` | Runs before every body schema, after the request's `authorize`, for a submit and a live validation alike. It may replace input values: the storage package puts a verified upload in place of its token. |
| `router.intercept({ claims, answer })` | Answers the requests it claims in the route's place, after the route's middleware, bindings and `authorize`. The controller is never built. A claimed request that is a live validation too answers 400: `throttle()` lets a live validation through without counting it. The storage package answers its upload requests this way. |

A hook runs for every route of every app that installs the package, so keep it narrow: claim requests by a header of your own, and
leave everything else alone.

## Pages of a package

A package can bring pages, an entry of its own and texts. It declares them in the `"marmeon"` field of its `package.json`, and
the app reads the declaration without running a line of the package: from `package.json` and the directories it names.

### Declaring the interface in `package.json`

```json
{
  "name": "@acme/status-board",
  "exports": {
    ".": "./dist/index.js",
    "./area/client": "./dist/area/client.js",
    "./area/ssr": "./dist/area/ssr.js",
    "./views/*": "./dist/views/*.js",
    "./lang/*": "./dist/lang/*.js"
  },
  "marmeon": {
    "providers": ["StatusBoardServiceProvider"],
    "namespace": "status",
    "entry": { "client": "./area/client", "ssr": "./area/ssr" },
    "views": "./views",
    "lang": "./lang"
  }
}
```

Every path is a subpath of `exports`, not a path in the package, so the conditions apply as they do for any import: in a monorepo
`@marmeon/source` can lead to `src/views/*.tsx` while the published package leads to `dist/views/*.js`.

- `entry.client` and `entry.ssr` are exact subpaths: `"./area/client"` needs the key `"./area/client"` in `exports`. The client entry is
  resolved with the browser's conditions and the server entry with the server's, so `"./area/ssr"` may have a `node` target alone.
- `views` and `lang` name a folder: `"./views"` needs the pattern `"./views/*"`, whose target ends in `/*` and an extension
  (`./dist/views/*.js`). The files below that directory are the package's views, and its texts for `lang`. The `lang` pattern must resolve under the
  server's conditions, because the server loads the texts: a `"./lang/*"` with only a `browser` target stops the start with `K7`.
- A view's name is its path below the pattern without the extension: `dist/views/entries/Edit.js` is `entries/Edit`. Each segment holds
  letters, digits, `_` and `-`, joined by `/`. A language file's name is its language tag, `en` or `de-AT`, and `lang` has no folders.
- Only that directory of the package is listed, never `node_modules`. Files whose names start with a dot, files with `.test.`, `.spec.`
  or `.type-test.` in the name and `.d.ts` files are not views or texts. A package may have at most 1000 views and 100 language files, and its views may nest at most 16 folders deep.
- `namespace` is required with any of the others. `entry` and `views` come together: a package's pages are always rendered by its own
  entry. `lang` can stand alone, and so can `namespace`.
- A package with a `namespace` is compiled by the app's Vite like the app's own source, in development, in the build and in server
  rendering, so the app's Vite plugins see its modules (see [Packages with pages or components](vite.md#packages-with-pages-or-components)).
- Two installed packages cannot share a namespace, and neither can two installed copies of one package.
- A directory below `views` that is a link is not followed, so a link cannot lead the listing out of the package or into a loop.

Everything the field names must lie in the package, also by its real path. A target with `..`, an absolute path, a `node_modules`
folder, or a file that is a link leading out of the package stops the app with `K7`; a link to a file inside the package is followed.
The message names the package and the key and never repeats a value of the file.

A malformed field, a missing `exports` key and a shared namespace stop the app at start, whatever the conditions. The other refusals
depend on the conditions in force and come when the build or the server reads the surface.

The app refuses only what it can see to be wrong: a missing `exports` key, a target outside the package or in its root, a name that is no view name,
a folder below `views` or `lang` that cannot be read, views nested deeper than the limit, a shared namespace. A folder that does not exist yet (the package is not built) lists nothing, and an entry whose file does not exist
yet is not an error here: the build and the server say so when they need the file.

## A package with an area of its own

A package that brings an area, an admin section or a status board, ties the pieces above together: routes behind its own access check, pages
in a document of its own, texts the app may reword and a policy for that document. The status board of the web app is such a package, and the
code below is shortened from it (`fixtures/status-board`).

The package serves server code from its main entry, where its provider is, and the components an app renders on its own pages from
`./components`. The main entry exports the provider, which imports `@marmeon/auth` and the router, so a browser import of `.` would pull
server code into the client bundle:

```json title="package.json"
{
  "name": "@acme/status-board",
  "type": "module",
  "exports": {
    ".": "./dist/index.js",
    "./components": "./dist/components.js",
    "./area/client": "./dist/area/client.js",
    "./area/ssr": "./dist/area/ssr.js",
    "./views/*": "./dist/views/*.js",
    "./lang/*": "./dist/lang/*.js"
  },
  "marmeon": {
    "providers": ["StatusBoardServiceProvider"],
    "namespace": "status",
    "entry": { "client": "./area/client", "ssr": "./area/ssr" },
    "views": "./views",
    "lang": "./lang",
    "browser": ["src/area/**", "src/views/**", "src/components.ts", "src/*.tsx"]
  },
  "peerDependencies": {
    "@marmeon/auth": "^0.1.0",
    "@marmeon/core": "^0.1.0",
    "@marmeon/http": "^0.1.0",
    "@marmeon/i18n": "^0.1.0",
    "@marmeon/react": "^0.1.0",
    "react": "^19.3.0"
  }
}
```

### The routes, the access check and the policy

The provider loads the routes below a path from its configuration, so the app can move the area. Its routes carry the area's policy, ask
for a signed-in user and then for the app's decision:

```ts title="src/StatusBoardServiceProvider.ts"
import { authenticate } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, describeAccess, NONCE, Router } from '@marmeon/http';
import { ShowStatusController } from './ShowStatusController.ts';
import { StatusAccess } from './StatusAccess.ts';
import { StatusBoardConfig } from './StatusBoardConfig.ts';

export class StatusBoardServiceProvider implements ServiceProvider {
  static config = [StatusBoardConfig];

  register(container: Container): void {
    const { path } = container.make(StatusBoardConfig);
    const policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] });
    container.make(Router).load(
      { group: 'web', prefix: path },
      defineRoutes((Route) => {
        Route.middleware(policy)
          .middleware(authenticate())
          .authorize(describeAccess(async (ctx) => (container.has(StatusAccess) ? await container.make(StatusAccess).allows(ctx.user) : false), 'status access'))
          .get('/', ShowStatusController)
          .name('status.index');
      }),
    );
  }
}
```

```ts title="src/StatusAccess.ts"
import type { AuthUser } from '@marmeon/auth';
import { token } from '@marmeon/core';

/** Who may open the area. The app binds it; the package never decides for it. */
export interface StatusAccess {
  allows(user: AuthUser): boolean | Promise<boolean>;
}
export const StatusAccess = token<StatusAccess>('StatusAccess');
```

- **The gate fails closed.** Every route needs a decision (see [authorization](authorization.md#every-route-decides)). This one asks the
  app through a token the package defines. An app that binds nothing opens nothing: every user gets a 403, and a guest is sent to the sign-in
  by `authenticate()` before the check runs. The controller renders the page only after the check, so a refused request never builds
  the area's document.
- **The policy is the route group's.** A response that sets none gets the [strict default](csp.md#policies-of-a-package-area) with its
  nonce; a policy of the group, as here, replaces both that default and the app's global one for the area's pages.
- **The routes load in `register()`**, so `marmeon route:types` lists `status.index` and a page of the app can link to it.

### The entry, a page and its texts

The client entry starts the app in the browser with the area's own pages and texts, and the server entry renders them:

```tsx title="src/area/client.tsx"
import { createMarmeonApp, resolveModulePages } from '@marmeon/react';
import '@marmeon/react/styles.css';
import { createMessageLoader } from '@marmeon/i18n/messages';
import lang from 'virtual:marmeon/lang/status';
import pages from 'virtual:marmeon/pages/status';
import { routes } from 'virtual:marmeon/routes';

void createMarmeonApp({ resolve: resolveModulePages(pages), routes, messages: createMessageLoader(lang) });
```

```tsx title="src/area/ssr.tsx"
import { createMessageLoader } from '@marmeon/i18n/messages';
import { resolveModulePages } from '@marmeon/react';
import { createSsrRenderer } from '@marmeon/react/server';
import lang from 'virtual:marmeon/lang/status';
import pages from 'virtual:marmeon/pages/status';
import { routes } from 'virtual:marmeon/routes';

export const render = createSsrRenderer(resolveModulePages(pages), { routes, messages: createMessageLoader(lang) });
```

The page is `status::Index`, the file `views/Index.tsx`. It links back to the app by route name, and the area's route names and the app's share one
manifest:

```tsx title="src/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link, useTranslation } from '@marmeon/react';
import type { ShowStatusController } from '../ShowStatusController.ts';
import { StatusBoard } from '../StatusBoard.tsx';

export default function Index({ services }: PageProps<ShowStatusController>) {
  const t = useTranslation('status');
  return (
    <main>
      <Head title={t('title')} />
      <h1>{t('title')}</h1>
      <StatusBoard services={services} />
      <Link route="dashboard.show">{t('back')}</Link>
    </main>
  );
}
```

```ts title="src/ShowStatusController.ts"
import { Controller } from '@marmeon/http';

export class ShowStatusController extends Controller {
  handle() {
    return this.view('status::Index', { services: [{ name: 'Web', state: 'up' }] });
  }
}
```

The texts are `src/lang/en.ts` with `title`, `intro` and `back` (declared in `Translations` as [a module's are](localization.md#texts-of-a-package)),
and `de.ts` next to it.

### What the app does

The app decides who may open the area, by binding the token in a provider of one of its modules, and rewords a text of the package in
`lang/status/de.ts`:

```ts title="modules/dashboard/StatusAccessServiceProvider.ts"
import { StatusAccess } from '@acme/status-board';
import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { DashboardConfig } from './config.ts';

export class StatusAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(StatusAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return { allows: (user) => (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) };
    });
  }
}
```

```ts title="lang/status/de.ts"
import type en from '@acme/status-board/lang/en';
import type { MessageOverrides } from '@marmeon/i18n/messages';

export default {
  title: 'Systemzustand',
} satisfies MessageOverrides<typeof en>;
```

An allowlist of addresses needs confirmed addresses: anybody can sign up with a listed one, so the check above also asks for
`email_verified_at`, the notion `verified()` uses. An account that has not confirmed its address gets a 403 whatever its address.

A page of the app links to the area by `<Link route="status.index">`. That visit loads the area's document fully: the answer is a `409` that
names the address, and the browser loads it (see [a visit into another entry](navigation.md#a-visit-into-another-entry)). The link back
does the same the other way.

### What the area keeps out of the app's pages

`marmeon build` writes one client build with an entry for the app and one for the area (see [packages with an entry](vite.md#packages-with-an-entry)).
The document of a public page loads nothing that only the area's entry reaches: not its code, not its stylesheets and not its texts, in any
language. Texts of an area that an administrator reads stay out of the public bundle. A text a public page needs belongs to the app, and reaches
the page as a prop.

The web app proves it. `apps/web-app/modules/dashboard/status-area.test.ts` signs in as an administrator, as another member and as a
guest, reads the area's document, its policy and its texts, and crosses the boundary in both directions;
`status-area-build.test.ts` builds a copy of the app and checks the built files.

## A package with users of its own

A package whose users are not the app's, such as a back office for editors, brings a guard of its own: its own table, its own sign-ins, its own second factors and passkeys, its own sudo mode and its own limits. The back office of the web app is such a package. Its source is `fixtures/back-office` in the framework's repository, and the code below is taken from it with the package's name written as `@acme/back-office`. It shows the case of a website with a customer portal in one app: the app's users are the customers of the portal, and the back office is for the editors, who are other people with a table of their own. [When to use a second guard](authentication.md#when-to-use-a-second-guard) says when a package should go this way.

The package runs in one of two modes, which the app chooses at boot with `BACK_OFFICE_USERS`:

| Mode | The back office's users | What the package brings |
|---|---|---|
| `own` (the default) | The editors in the table `office_users`. | The guard `office`, its sign-in with an authenticator app, recovery codes and passkeys, sign-out, list of sign-ins and sudo mode, and its limits. |
| `app` | The app's users, the customers of the portal. | Nothing to sign in to: the routes of the guard answer 404, people sign in to the app with the app's own second factors, and the app says which of them are editors. |

The package writes its policy, its overview and its routes once. A guard slot makes them follow the mode ([using the app's users instead](authentication.md#using-the-apps-users-instead)). The routes, the guard and its tables are the same in both modes, so the app's route list and its readiness never depend on `BACK_OFFICE_USERS`. An installation that has data does not switch from one mode to the other: the two modes are two sets of accounts, and an id means another person in each.

### The guard, the slot and the tables

The guard is defined once, and the slot beside it names "the editors, whoever they are":

```ts title="src/guard.ts"
import { defineGuard, defineGuardSlot, type GuardAccountSessions, type GuardAuth, type GuardPasskeys, type GuardTwoFactor } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { OfficeUserRepository } from './OfficeUserRepository.ts';
import type { EditorUser, OfficeUser } from './OfficeUser.ts';

/**
 * The guard of the back office's own editors: their table `office_users`, their sign-ins in `office_sign_ins`, an authenticator app with recovery codes
 * (`office_two_factor_*`) and passkeys (`office_passkeys`), a working day of eight hours and no "keep me signed in".
 */
export const OfficeGuard = defineGuard('office', {
  users: OfficeUserRepository,
  tablePrefix: 'office_',
  twoFactor: TwoFactor,
  passkeys: Passkeys,
  settings: { sessionMaxHours: 8, rememberDays: 0, twoFactorIssuer: 'Back Office' },
});

// A type alias and a constant of the same name: a controller takes `auth: OfficeAuth`, and the container finds the guard's service.
export type OfficeAuth = GuardAuth<OfficeUser>;
export const OfficeAuth = OfficeGuard.Auth;
export type OfficeAccountSessions = GuardAccountSessions<OfficeUser>;
export const OfficeAccountSessions = OfficeGuard.AccountSessions;
export type OfficeTwoFactor = GuardTwoFactor<OfficeUser>;
export const OfficeTwoFactor = OfficeGuard.TwoFactor;
export type OfficePasskeys = GuardPasskeys<OfficeUser, Passkeys>;
export const OfficePasskeys = OfficeGuard.Passkeys;

/**
 * The editors, whoever they are: the guard's users in the own mode, the app's users in the other. The back office's policy and overview name the slot.
 * It has no `twoFactor` option, so it forwards no `twoFactor()` middleware: that one would force every editor to set up a factor. Neither mode does. An editor
 * with a factor is asked for it at the guard's sign-in, and an app user at the app's. The package's `confirmedSecondFactor()` is the guard's own, since those
 * routes exist in the mode `own` only, and it demands nothing of an editor who has no factor.
 */
export const EditorSlot = defineGuardSlot<EditorUser>('editor');
```

The guard has `twoFactor: TwoFactor` and `passkeys: Passkeys`, so its editors can use an authenticator app, recovery codes and passkeys on tables of the guard's own ([two factors and passkeys](#two-factors-and-passkeys) below). `GuardTwoFactor<OfficeUser>` and `GuardPasskeys<OfficeUser, Passkeys>` name the guard's services for a controller. The slot has no `twoFactor` option. With it the slot would forward `EditorSlot.twoFactor()`, which sends every editor without a factor to set one up, and neither mode forces that. `confirmedSecondFactor()` demands nothing of an editor who has no factor, and the package uses the guard's own because those routes exist in the mode `own` only. An editor who has a factor is asked for it at the guard's sign-in in the mode `own`, and a customer who has one at the app's sign-in in the mode `app`, where the slot is bound to `'web'`. A package that wants to demand a factor defines its slot with `defineGuardSlot<EditorUser>('editor', { twoFactor: true })` ([guard slots](authentication.md#using-the-apps-users-instead)).

The class `OfficeUserRepository` implements `UserProvider` on the table `office_users`: it takes `Connections`, reads the password hash and the session key with `secret()` next to the user, and leaves the writes of the hash and the key to `credentialWriter()` with `{ table: 'office_users' }` ([for your own user provider](authentication.md#for-your-own-user-provider)). A package names its user type, `credentialWriter<OfficeUser>(db, { table: 'office_users' })`, because the writer is otherwise typed by the app's user. It never reads the app's `users`.

The package ships five migrations as stubs in `stubs/migrations`: `office_users` (the editors, with the `password` and `session_key` as `secret()` columns, and a `role` that is `viewer` unless set), the two tables of the guard, `office_sign_ins` and `office_password_reset_tokens`, with the columns [the tables of a guard](authentication.md#the-tables) list, and the tables of the second factors and passkeys, `office_two_factor_authentications`, `office_two_factor_recovery_codes` and `office_passkeys`, with the shape of [the app's tables](two-factor-authentication.md#for-a-guard-of-a-package) under the guard's prefix. A stub that has shipped is never changed: a package adds a stub that sorts after the last one. The provider declares them with `static migrations` (the module it proposes is `back-office`), and the app takes them over:

```sh
marmeon publish @acme/back-office
marmeon migrate
```

`marmeon publish --check @acme/back-office` ends with exit code 0 once every migration is in the app. `/up/ready` is red until all six tables have every column the package reads, in both modes: the guard is registered in both, and so is the requirement for `office_users`.

### The provider and its two modes

The provider registers the guard, binds the slot to the guard or to `'web'`, and loads the routes below `BACK_OFFICE_PATH`:

```ts title="src/BackOfficeServiceProvider.ts"
import { can } from '@marmeon/auth';
import { PasskeyConfig } from '@marmeon/auth/passkeys';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, everyone, NONCE, Router } from '@marmeon/http';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficeBeginTwoFactorController } from './OfficeBeginTwoFactorController.ts';
import { ConfirmController } from './ConfirmController.ts';
import { ConfirmOfficeTwoFactorController } from './ConfirmOfficeTwoFactorController.ts';
import { DisableOfficeTwoFactorController } from './DisableOfficeTwoFactorController.ts';
import { EditorSignInLog } from './EditorSignInLog.ts';
import { EndSessionController } from './EndSessionController.ts';
import { EditorSlot, OfficeGuard } from './guard.ts';
import { OfficeLoginController } from './OfficeLoginController.ts';
import { OfficeLogoutController } from './OfficeLogoutController.ts';
import { OfficePasskeyChallengeController } from './OfficePasskeyChallengeController.ts';
import { OfficePasskeyChallengeOptionsController } from './OfficePasskeyChallengeOptionsController.ts';
import { OfficePasskeyConfirmController } from './OfficePasskeyConfirmController.ts';
import { OfficePasskeyConfirmOptionsController } from './OfficePasskeyConfirmOptionsController.ts';
import { OfficePasskeyRegistrationOptionsController } from './OfficePasskeyRegistrationOptionsController.ts';
import { OfficePasskeySignInController } from './OfficePasskeySignInController.ts';
import { OfficePasskeySignInOptionsController } from './OfficePasskeySignInOptionsController.ts';
import { OfficePasskeyStepUpController } from './OfficePasskeyStepUpController.ts';
import { OfficePasskeyStepUpOptionsController } from './OfficePasskeyStepUpOptionsController.ts';
import { OfficeTwoFactorChallengeController } from './OfficeTwoFactorChallengeController.ts';
import { OfficeTwoFactorVerifyController } from './OfficeTwoFactorVerifyController.ts';
import { OfficeAccess } from './OfficeAccess.ts';
import { OfficePolicy } from './OfficePolicy.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import { officeRole } from './OfficeUser.ts';
import { OwnUsersOnly } from './OwnUsersOnly.ts';
import { OFFICE_USERS_COLUMNS, OfficeUserRepository } from './OfficeUserRepository.ts';
import { RedirectToOfficeSecurityController } from './RedirectToOfficeSecurityController.ts';
import { RegenerateOfficeRecoveryCodesController } from './RegenerateOfficeRecoveryCodesController.ts';
import { RegisterOfficePasskeyController } from './RegisterOfficePasskeyController.ts';
import { RemoveOfficePasskeyController } from './RemoveOfficePasskeyController.ts';
import { ShowConfirmController } from './ShowConfirmController.ts';
import { ShowOfficeLoginController } from './ShowOfficeLoginController.ts';
import { ShowOfficeTwoFactorChallengeController } from './ShowOfficeTwoFactorChallengeController.ts';
import { ShowOfficeTwoFactorVerifyController } from './ShowOfficeTwoFactorVerifyController.ts';
import { ShowOverviewController } from './ShowOverviewController.ts';
import { ShowSecureController } from './ShowSecureController.ts';
import { ShowOfficeSecurityController } from './ShowOfficeSecurityController.ts';
import { ShowSessionsController } from './ShowSessionsController.ts';

/**
 * Registers the back office: its routes below `BACK_OFFICE_PATH`, for the users `BACK_OFFICE_USERS` names. With `own` it defines the guard
 * `office` on its table, with its sign-in, second factors, passkeys, sign-in list and sudo mode; with `app` those routes answer 404, nobody signs in to the guard, and people go to the app's sign-in.
 */
export class BackOfficeServiceProvider implements ServiceProvider {
  // The guard's passkeys use the app's relying party, which an app that has not registered the passkey provider has not bound: the check happens at boot, so a later provider counts too.
  static config = [BackOfficeConfig, PasskeyConfig];
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'back-office' };

  register(container: Container): void {
    const { users, path } = container.make(BackOfficeConfig);
    const own = users === 'own';
    // The guard is registered in both modes, and so are its tables and routes: the app's route list and its readiness never depend on the mode.
    // In the mode `app` the guard has no users and no route reaches it (the slot is bound to `'web'`).
    OfficeGuard.register(container);
    EditorSlot.bind(container, own ? OfficeGuard : 'web');
    container.singleton(EditorSignInLog);
    // The roles come from the table in the first mode and from the app's `OfficeAccess` in the second, never the app's for an editor's id.
    // Nothing bound means nobody has a role: the check asks at request time.
    // Whatever the app answers that is not one of the two roles is no role.
    container.singleton(OfficeRoles, (resolver) =>
      own ? resolver.make(OfficeUserRepository) : { roleOf: async (id) => (container.has(OfficeAccess) ? officeRole(await container.make(OfficeAccess).roleOf(id)) : undefined) },
    );

    // The back office's document gets this policy, not the app's: nothing but its own origin may load or be connected to.
    const policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] });
    container.make(Router).load(
      { group: 'web', prefix: path },
      defineRoutes((Route) => {
        const area = Route.middleware(policy);
        // The overview is the same in both modes: the slot hands the request to the bound guard.
        area.middleware(EditorSlot.authenticate({ loginRoute: own ? 'office.login' : 'auth.login' })).authorize(can(OfficePolicy, 'open')).get('/', ShowOverviewController).name('office.index');

        // The routes below are the mode `own`'s: the sign-in, its second step, the sign-in list, the sudo mode and the security page are the guard's. They exist in both modes and answer 404 in the other.
        const own404 = area.middleware(OwnUsersOnly);
        const guests = own404.authorize(everyone).middleware(OfficeGuard.guest({ homeRoute: 'office.index' }));
        guests.get('/login', ShowOfficeLoginController).name('office.login');
        guests.middleware(OfficeGuard.throttle('login')).post('/login', OfficeLoginController).name('office.login.store');
        // The second step of the sign-in: a correct password waits here for the code (a guest still: nobody is signed in yet). One request per session at a time (`block()`).
        guests.get('/two-factor-challenge', ShowOfficeTwoFactorChallengeController).name('office.two-factor.challenge');
        guests.middleware(OfficeGuard.throttle('two-factor-challenge')).post('/two-factor-challenge', OfficeTwoFactorChallengeController).name('office.two-factor.challenge.store').block();
        guests.middleware(OfficeGuard.throttle('passkey-challenge-options')).post('/two-factor-challenge/passkey/options', OfficePasskeyChallengeOptionsController).name('office.passkeys.challenge.options');
        guests.middleware(OfficeGuard.throttle('passkey-challenge')).post('/two-factor-challenge/passkey', OfficePasskeyChallengeController).name('office.passkeys.challenge').block();
        // A passkey alone is a whole sign-in. The options open the session's one challenge and the answer spends it.
        guests.middleware(OfficeGuard.throttle('passkey-sign-in-options')).post('/passkeys/sign-in/options', OfficePasskeySignInOptionsController).name('office.passkeys.sign-in.options');
        guests.middleware(OfficeGuard.throttle('passkey-sign-in')).post('/passkeys/sign-in', OfficePasskeySignInController).name('office.passkeys.sign-in').block();
        const editors = own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(can(OfficePolicy, 'open'));
        // Signing out needs a signed-in editor and nothing else: an editor whose role is gone must still be able to end the sign-in.
        own404.middleware(OfficeGuard.authenticate({ loginRoute: 'office.login' })).authorize(everyone).post('/logout', OfficeLogoutController).name('office.logout');
        editors.get('/sessions', ShowSessionsController).name('office.sessions');
        editors.get('/confirm-password', ShowConfirmController).name('office.confirm');
        editors.post('/confirm-password', ConfirmController).name('office.confirm.store');
        // Confirming with a passkey: the options open a challenge per call, so they are limited per editor.
        editors.middleware(OfficeGuard.throttle('passkey-confirm-options')).post('/confirm-password/passkey/options', OfficePasskeyConfirmOptionsController).name('office.confirm.passkey.options');
        editors.post('/confirm-password/passkey', OfficePasskeyConfirmController).name('office.confirm.passkey').block();
        const sudo = editors.middleware(OfficeGuard.confirmedPassword({ confirmRoute: 'office.confirm' }));
        sudo.post('/sessions/:signIn/end', EndSessionController).name('office.sessions.end');
        sudo.get('/secure', ShowSecureController).name('office.secure');

        // Proving the second factor again in this session, where `confirmedSecondFactor()` sends a session that has not proven one lately. A wrong code ends nothing.
        editors.get('/two-factor-verify', ShowOfficeTwoFactorVerifyController).name('office.two-factor.verify');
        editors.post('/two-factor-verify', OfficeTwoFactorVerifyController).name('office.two-factor.verify.store').block();
        editors.middleware(OfficeGuard.throttle('passkey-step-up-options')).post('/two-factor-verify/passkey/options', OfficePasskeyStepUpOptionsController).name('office.passkeys.step-up.options');
        editors.post('/two-factor-verify/passkey', OfficePasskeyStepUpController).name('office.passkeys.step-up').block();
        // The factors: the sudo mode for all of it, and a factor proven within 15 minutes where the editor has one, because the guard's methods throw without it.
        const factors = sudo.middleware(OfficeGuard.confirmedSecondFactor({ verify: 'office.two-factor.verify' }));
        factors.get('/security', ShowOfficeSecurityController).name('office.security');
        factors.post('/security/two-factor/setup', OfficeBeginTwoFactorController).name('office.two-factor.begin');
        // Confirming needs a signed-in editor and the password in the form, not the sudo mode: the code of a setup that took a while to scan must not be lost.
        editors.post('/security/two-factor/confirm', ConfirmOfficeTwoFactorController).name('office.two-factor.confirm');
        factors.post('/security/two-factor/recovery-codes', RegenerateOfficeRecoveryCodesController).name('office.two-factor.codes');
        factors.post('/security/two-factor/disable', DisableOfficeTwoFactorController).name('office.two-factor.disable');
        // The recovery codes are a layer that answers these POSTs over the security page, shown once while it is open; a reload or Forward asks their addresses with a GET.
        editors.get('/security/two-factor/confirm', RedirectToOfficeSecurityController);
        editors.get('/security/two-factor/recovery-codes', RedirectToOfficeSecurityController);
        // Passkeys: adding one asks for the password again, and so does removing one.
        factors.post('/security/passkeys/options', OfficePasskeyRegistrationOptionsController).name('office.passkeys.options');
        factors.post('/security/passkeys', RegisterOfficePasskeyController).name('office.passkeys.store').block();
        factors.post('/security/passkeys/:passkey/remove', RemoveOfficePasskeyController).name('office.passkeys.destroy').block();
      }),
    );
  }

  boot(application: { container: Container }): void {
    const { container } = application;
    if (!container.has(Connections)) return;
    // Readiness waits for the editors' table in both modes, as it does for the guard's two tables: the app migrates all three.
    container.make(SchemaRequirements).require({ connection: 'default', table: 'office_users', columns: OFFICE_USERS_COLUMNS, secrets: ['password', 'session_key'] });
  }
}
```

- **The overview is the same in both modes.** `EditorSlot.authenticate()` hands the request to the bound guard. A guest of the back office goes to `office.login` in the mode `own` and to the app's `auth.login` in the mode `app`. A customer of the app is a guest of the guard `office`, even when a customer and an editor have the same id.
- **The routes of the mode `own` exist in both modes.** `OwnUsersOnly` stands before the guard's middleware and answers 404 in the mode `app`, for a GET and a POST alike, before anything looks at a session. The sign-in and its second step, the passkey routes, the sign-out, the list of the editor's sign-ins, the sudo mode and the security page are the guard's.
- **The provider carries the passkey configuration.** `static config = [BackOfficeConfig, PasskeyConfig]` binds the relying party for an app that has not registered the passkey provider. The check runs at boot, so a provider that comes later counts too ([for a guard of a package](passkeys.md#for-a-guard-of-a-package)).
- **Two limits count sign-ins, and the guard has its own of each.** The route limit `OfficeGuard.throttle('login')` lets one client post 30 sign-ins a minute, whatever the addresses. Inside the sign-in, `attempt()` allows five a minute for one address from one client (`AUTH_LOGIN_ATTEMPTS_PER_MINUTE`) and 100 password sign-ins a day for one account, counted from the last successful one (`AUTH_ACCOUNT_SIGN_INS_PER_DAY`). All of them are counted under the guard's name, apart from the app's.
- **The device cookie is the way back.** A sign-in with the password hands the browser the guard's device cookie, which keeps the editor signing in after strangers have used up the account's daily count. Without it, anyone who knows an editor's address could lock them out, and this package has no password reset yet. The login controller sets it as the app's does.
- **The sudo window is the guard's.** `OfficeGuard.confirmedPassword()` asks the editor for the back office password, although the customer's window of the app is open, and the editor's confirmation opens nothing in the app. The page that ends another sign-in and the page `/office/secure` need it.
- **The page a guest wanted is the back office's.** The session keeps one such page for all guards, not one for each. The sign-in and the confirmation follow it only when it lies below the back office's path, and leave a page of the app in place. The other direction is the app's: its sign-in follows whatever page was stored last, so a visit to a page of the back office after a customer's wish replaces that wish.
- **The group has a policy of its own.** The back office's document gets its own content security policy, not the app's.

The web app's own middleware shares the signed-in user and the notification bell with every page of its `web` group. It leaves out the pages of the back office, so a customer signed in in the same browser shows no name there and the page follows no channel of the customer's.

### Two factors and passkeys

An editor sets up an authenticator app on the security page, `/office/security`, and adds passkeys there. The package writes its own controllers and pages for them, and each controller calls one method of the guard's services, `OfficeAuth`, `OfficeTwoFactor` and `OfficePasskeys`. The starter kit's controllers do the same for the app's users, so each one in the table is the template for the package's: copy it, take the guard's service in `static inject` in place of the app's, and name the routes `office.…`.

| Page or request | Controller of the package | Method of the guard's service | Template in the starter kit (`modules/auth/…`) |
|---|---|---|---|
| The second step after the password | `ShowOfficeTwoFactorChallengeController` | `OfficeAuth.pendingSecondFactor()` | `controllers/ShowTwoFactorChallengeController.ts` |
| A code or a recovery code | `OfficeTwoFactorChallengeController` | `OfficeTwoFactor.challenge({ code })`, `challenge({ recoveryCode })` | `controllers/TwoFactorChallengeController.ts` |
| A passkey after the password | `OfficePasskeyChallengeOptionsController`, `OfficePasskeyChallengeController` | `OfficePasskeys.challengeOptions()`, `OfficeTwoFactor.challenge({ passkey })` | `controllers/PasskeyChallengeOptionsController.ts`, `controllers/PasskeyChallengeController.ts` |
| Signing in with a passkey alone | `OfficePasskeySignInOptionsController`, `OfficePasskeySignInController` | `OfficePasskeys.signInOptions()`, `signIn()` | `controllers/PasskeySignInOptionsController.ts`, `controllers/PasskeySignInController.ts` |
| The security page | `ShowOfficeSecurityController` | `OfficeTwoFactor.status()`, `setup()`, `OfficePasskeys.list()` | `controllers/ShowTwoFactorController.ts`, `controllers/ShowPasskeysController.ts` |
| Starting the authenticator app | `OfficeBeginTwoFactorController` | `OfficeTwoFactor.begin()` | `controllers/BeginTwoFactorController.ts` |
| Turning it on with the first code | `ConfirmOfficeTwoFactorController` | `OfficeTwoFactor.confirm(code, password)` | `controllers/ConfirmTwoFactorController.ts` |
| Turning it off | `DisableOfficeTwoFactorController` | `OfficeTwoFactor.disable(password)` | `controllers/DisableTwoFactorController.ts` |
| New recovery codes | `RegenerateOfficeRecoveryCodesController` | `OfficeTwoFactor.regenerateRecoveryCodes(password)` | `controllers/RegenerateRecoveryCodesController.ts` |
| Adding a passkey | `OfficePasskeyRegistrationOptionsController`, `RegisterOfficePasskeyController` | `OfficePasskeys.registrationOptions()`, `register(response, name, password)` | `controllers/PasskeyRegistrationOptionsController.ts`, `controllers/RegisterPasskeyController.ts` |
| Removing a passkey | `RemoveOfficePasskeyController` | `OfficePasskeys.remove(id, password)` | `controllers/RemovePasskeyController.ts` |
| The sudo mode with a passkey | `OfficePasskeyConfirmOptionsController`, `OfficePasskeyConfirmController` | `OfficePasskeys.confirmOptions()`, `confirm()` | `controllers/PasskeyConfirmOptionsController.ts`, `controllers/PasskeyConfirmController.ts` |
| Proving a factor again | `ShowOfficeTwoFactorVerifyController`, `OfficeTwoFactorVerifyController` | `OfficeTwoFactor.status()`, `stepUp({ code })`, `stepUp({ recoveryCode })` | `controllers/ShowTwoFactorVerifyController.ts`, `controllers/TwoFactorVerifyController.ts` |
| The recovery codes, reloaded or Forward | `RedirectToOfficeSecurityController` | none: it redirects to the security page | `controllers/RedirectToTwoFactorController.ts` |
| Proving a passkey again | `OfficePasskeyStepUpOptionsController`, `OfficePasskeyStepUpController` | `OfficePasskeys.stepUpOptions()`, `OfficeTwoFactor.stepUp({ passkey })` | `controllers/PasskeyStepUpOptionsController.ts`, `controllers/PasskeyStepUpController.ts` |

Three pages of the package replace the starter kit's views: `office::Security` joins its two-factor and passkeys pages, `office::Challenge` is its sign-in challenge and its verify page in one (the prop `step` says which), and `office::RecoveryCodes` is its recovery codes layer.

The starter kit's pages for renaming a passkey and releasing a suspended one are not in the package: a passkey whose counter went backwards is suspended, and the editor removes it and adds a new one.

The routes keep the order the starter kit uses:

- **The second step is a guest page.** A correct password does not sign anybody in while the editor has a factor: `attempt()` answers `two-factor-required` and `OfficeLoginController` sends the browser to `office.two-factor.challenge`. The challenge routes sit behind `OfficeGuard.guest()` and have their own limits (`OfficeGuard.throttle('two-factor-challenge')` and the passkey ones), and a request that checks an answer is `block()`ed, so two codes of one session are never counted at once. After five wrong codes the wait ends and the editor types the password again.
- **The security page is behind the sudo mode and a proven factor.** `OfficeGuard.confirmedPassword()` comes first, then `OfficeGuard.confirmedSecondFactor({ verify: 'office.two-factor.verify' })`: an editor who has a factor and proved none in the last 15 minutes is sent to the page that asks again, because the guard's methods that change a factor throw without that proof. Turning the authenticator on is the one request outside the sudo mode, since it carries the password in its form, and a setup that took a while to scan must not lose its code.
- **Every change asks for the password again.** The controllers pass the password typed now to `confirm()`, `disable()`, `regenerateRecoveryCodes()`, `register()` and `remove()`, which check it under the guard's limits.
- **A passkey is the editor's own and nobody else's.** The passkey routes answer the guard's `office_passkeys`: the passkey of a customer with the same id signs in at the app and not at the back office, and the editor's does the other way round, with the same answer as for an unknown passkey.
- **The sudo mode takes a passkey in place of the password.** `OfficePasskeyConfirmController` opens the window of `OfficeGuard.confirmedPassword()`, the same one as the password's.
- **A sign-in follows the page the editor wanted only below the back office.** The sign-in, the second step and the passkey sign-in go on to `intended()` only when `intendedBelow()` says the stored page is one of the back office's; otherwise they go to the overview.

The recovery codes are a layer over the security page that answers the POST (`office::RecoveryCodes`, the key `office.two-factor.codes`), as in the starter kit. They never sit in the session or in a history entry, the database keeps their hashes, closing the layer drops them from the tab's memory, and Back or Forward asks their address with a GET that redirects to the security page. The codes of a first passkey come back as JSON and live in the page's state only.

The package mails the editor about what happens to their sign-ins and factors, through the guard's events. `OfficeNotices` reads the address from `office_users` by the id the guard's event carries and queues an `OfficeSecurityMail` to it. The app lists the four queued listeners in its module next to `RecordEditorSignIn`:

| The guard's event | Listener | The mail says |
|---|---|---|
| `OfficeGuard.events.SignedIn` | `NotifyEditorOfSignIn` | A new sign-in, with its time. |
| `OfficeGuard.events.TwoFactorEnabled` | `NotifyEditorOfTwoFactorEnabled` | A second factor was turned on. |
| `OfficeGuard.events.TwoFactorDisabled` | `NotifyEditorOfTwoFactorDisabled` | The authenticator app was removed and the passkeys still protect the account, or the second factor is off when no passkey of the guard is left. An operator's removal and a reset have their own texts. |
| `OfficeGuard.events.PasskeyRegistered` | `NotifyEditorOfPasskeyAdded` | A passkey was added. |

The mail listeners need a bound `Mailer` and a running mail queue (`marmeon queue:work`, which `marmeon dev` starts), and `@marmeon/mail` is a peer dependency of the package. Each listener mails only a payload of the guard `office`: a payload that names another guard mails nobody. The passkeys use the app's relying party, so `APP_URL`, `AUTH_PASSKEY_RP_ID` and `AUTH_PASSKEY_ORIGINS` apply to the back office as they do to the app ([for a guard of a package](passkeys.md#for-a-guard-of-a-package)).

A listener of the app's own `SignedIn` never hears the guard's event, so the customer with the editor's id gets no mail and no notification about it ([events of a guard](authentication.md#events-of-a-guard)). In the mode `app` the guard has no users and raises nothing, and the app's own listeners tell the customers.

Ending a sign-in of the back office ends the browser's session: an ended sign-in row, `AccountSessions.end()`, a new password, a passkey that looks copied and `sessionMaxHours` all do. The customer of the app who is signed in in the same browser is signed out with it, and the same customer in another browser is not ([signing out](authentication.md#signing-out)).

### The roles

The policy names the slot and asks for the editor's role through a token the package binds by mode, `OfficeRoles`. In the mode `own` the answer is the column `role` of the editor's row. In the mode `app` it is the app's `OfficeAccess`, which the app binds. The package never asks `OfficeAccess` for an editor of its own table: the ids of the two tables are other people.

```ts title="src/OfficeAccess.ts"
import { token } from '@marmeon/core';
import type { OfficeRole } from './OfficeUser.ts';

/**
 * Which role the app gives one of its users in the back office, for the mode that serves the app's users (`BACK_OFFICE_USERS=app`). The app
 * binds it; the package never decides for it, so an app that binds nothing admits nobody. The own mode never asks it: its editors are
 * another set of accounts whose ids mean other people.
 */
export interface OfficeAccess {
  roleOf(userId: number): OfficeRole | undefined | Promise<OfficeRole | undefined>;
}
export const OfficeAccess = token<OfficeAccess>('OfficeAccess');
```

```ts title="src/OfficePolicy.ts"
import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import type { EditorUser } from './OfficeUser.ts';

/** What an editor may do. It names the slot, so it judges the editors of the mode the back office runs in, never the other mode's accounts. */
export class OfficePolicy {
  static readonly guard = EditorSlot;
  static readonly inject = [OfficeRoles] as const;

  readonly #roles: OfficeRoles;

  constructor(roles: OfficeRoles) {
    this.#roles = roles;
  }

  /** Enter the back office: a role of the two the package knows, and nothing else. */
  async open(user: EditorUser): Promise<boolean> {
    const role = await this.#roles.roleOf(user.id);
    return role === 'editor' || role === 'viewer';
  }

  /** Publish: editors, not viewers. */
  async publish(user: EditorUser): Promise<boolean> {
    return (await this.#roles.roleOf(user.id)) === 'editor';
  }
}
```

Only `editor` and `viewer` are roles. Anything else, such as a row whose `role` is `suspended` or empty, or an answer of the app's `OfficeAccess` that is `null` or another text, is no role and opens nothing: the policy, the binding and the listener each allow the two names and refuse the rest. An app that binds nothing admits nobody in the mode `app`: the check asks at request time, and a missing binding is no role. The overview takes its capability prop from the same policy (`gate.allows(OfficePolicy, 'publish')`), so the page offers publishing to editors only.

In the mode `own` the back office is a guard of its own, so a policy of the app on one of its routes answers no, never yes: the prop is `false` and the action is a 403, and in development the first such question writes a warning with error [A9](errors.md#server-error-codes) ([policies of a guard](authorization.md#policies-of-a-guard)). In the mode `app` the back office's routes belong to the app's guard, and a policy of the app is judged as on any page of the app.

### What the app does for the back office

Keep the app's shared props off the package's pages. The web app's `ShareAppProps` returns before it shares the signed-in user, the bell and the live channel when the matched route's path is `BackOfficeConfig.path` or below it (the router matches the decoded path, so an encoded address is no way around it), so a customer signed in in the same browser shows no name on a page of the back office.

The app takes the migrations over, and in the mode `app` it binds `OfficeAccess`. The web app says that its administrators, the ones `DASHBOARD_ADMINS` lists, are editors, as long as their address is confirmed; every other customer has no role in the back office:

```ts title="modules/back-office/OfficeAccessServiceProvider.ts"
import type { VerifiableUser } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { OfficeAccess } from '@acme/back-office';
import { UserRepository } from '#modules/auth';
import { DashboardConfig } from '#modules/dashboard';

/**
 * With `BACK_OFFICE_USERS=app` the back office serves the app's users, and the app says who is an editor: the administrators the dashboard
 * knows (`DASHBOARD_ADMINS`), with a confirmed address. Every other customer has no role there. In the default mode (`own`) the back office
 * never asks this: its editors are accounts of `office_users`, and an id of that table is not an id of `users`.
 */
export class OfficeAccessServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(OfficeAccess, (resolver) => {
      const { admins } = resolver.make(DashboardConfig);
      return {
        roleOf: async (id) => {
          const user = await container.make(UserRepository).find(id);
          return user !== undefined && (user as VerifiableUser).email_verified_at != null && admins.includes(user.email.toLowerCase()) ? 'editor' : undefined;
        },
      };
    });
  }
}
```

The package records the editors' sign-ins with a listener the app lists, and the mails to the editors are listeners too (five in all, the mails for the mode `own`). Packages do not register listeners, so the app lists them in the module that owns the package's tables, the recorder for the slot's event, which follows the binding:

```ts title="modules/back-office/index.ts"
import {
  EditorSlot,
  NotifyEditorOfPasskeyAdded,
  NotifyEditorOfSignIn,
  NotifyEditorOfTwoFactorDisabled,
  NotifyEditorOfTwoFactorEnabled,
  OfficeGuard,
  RecordEditorSignIn,
} from '@acme/back-office';
import { defineModule, listen } from '@marmeon/core';
import { OfficeAccessServiceProvider } from './OfficeAccessServiceProvider.ts';
import { OfficeUsersSeeder } from './OfficeUsersSeeder.ts';

// The tables of @acme/back-office: `marmeon publish @acme/back-office` writes their migrations here.
// They are the app's now — change them like any other migration.
export default defineModule({
  name: 'back-office',
  // `BACK_OFFICE_USERS=app` only: who is an editor among the app's users.
  providers: [OfficeAccessServiceProvider],
  // The package never registers listeners: the app lists the one that records editor sign-ins, whichever users the back office runs on, and the four
  // that mail the editors (the mode `own`).
  listeners: [
    listen(EditorSlot.events.SignedIn, RecordEditorSignIn),
    // The mails to the editors go through the guard's own events, never the app's: a listener of the app would mail the customer with the same id. They are
    // for the mode `own`; in the mode `app` the guard has no users and raises nothing.
    listen(OfficeGuard.events.SignedIn, NotifyEditorOfSignIn),
    listen(OfficeGuard.events.TwoFactorEnabled, NotifyEditorOfTwoFactorEnabled),
    listen(OfficeGuard.events.TwoFactorDisabled, NotifyEditorOfTwoFactorDisabled),
    listen(OfficeGuard.events.PasskeyRegistered, NotifyEditorOfPasskeyAdded),
  ],
  migrations: new URL('./migrations/', import.meta.url),
  seeders: [OfficeUsersSeeder],
});
```

`RecordEditorSignIn` writes `(guard, userId, at)` to the package's `EditorSignInLog`: `('office', 1)` for the editor with the id 1 in the mode `own`, `('web', 1)` for the customer with the id 1 in the mode `app`. It keeps the guard with the id, because the same id in the two modes is two people, and it records only the sign-ins the back office gives a role: the slot of the mode `app` hears every sign-in of the app, customers included ([events of a guard slot](authentication.md#events-of-a-guard-slot)). A sign-in of a customer in the mode `own` never reaches it.

```ts title="src/RecordEditorSignIn.ts"
import { EditorSignInLog } from './EditorSignInLog.ts';
import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';

/**
 * Records the editor sign-ins: one entry of the mode and the id for each. The app lists it for `EditorSlot.events.SignedIn`
 * (`docs/package-development.md#a-package-with-users-of-its-own`). A slot bound to the app's users hears every sign-in of the app, customers
 * included, so it records only the ones the back office gives a role.
 */
export class RecordEditorSignIn {
  static readonly inject = [EditorSignInLog, OfficeRoles] as const;

  readonly #log: EditorSignInLog;
  readonly #roles: OfficeRoles;

  constructor(log: EditorSignInLog, roles: OfficeRoles) {
    this.#log = log;
    this.#roles = roles;
  }

  async handle(event: InstanceType<typeof EditorSlot.events.SignedIn>): Promise<void> {
    const role = await this.#roles.roleOf(event.user.id);
    if (role !== 'editor' && role !== 'viewer') return;
    this.#log.record({ guard: event.guard, userId: event.user.id, at: event.at });
  }
}
```

### What the web app proves

The web app runs the claims above against the real package (`apps/web-app/modules/back-office`). In the mode `own`: a guest and a customer are sent to the back office's sign-in, an editor signs in, the list of sign-ins and the sudo window work and are the guard's, the sixth sign-in of a minute is `throttled` while the app's counter stays at zero, a locked account lets the owner's browser in through its device cookie, the capability prop follows the role and an unknown role opens nothing, and a policy of the app on a route of the back office says no. An editor sets up an authenticator app and is asked for its code at the next sign-in, a wrong code is refused and a recovery code works once. An editor signs in with a passkey alone, the app's passkey sign-in refuses it and the back office refuses a customer's, and a passkey opens the sudo window. The mail of a new sign-in goes to the editor's address and never to the customer with the same id, and ending an editor's sign-in signs the customer out in the same browser. In the mode `app`: the customers are judged by `OfficeAccess` with the table `office_users` never read, an answer that is no role admits nobody, the routes of the mode `own`, the second factors and passkeys among them, answer 404, and the route list is the same as in the mode `own`. `back-office-build.test.ts` builds a copy of the app and checks that no document of the app loads the back office's pages or texts.

## Components on the app's pages

A package can bring components that an app renders on its own pages. The package declares a `namespace` in its `"marmeon"` field
(nothing else is needed: no `entry`, no `views`), and the app imports the component like any other:

```tsx title="modules/dashboard/views/Show.tsx"
import { StatusBoard } from '@acme/status-board/components';

const services = [
  { name: 'Mail', state: 'up' },
  { name: 'Search', state: 'degraded' },
] as const;

export default function Show() {
  return <StatusBoard services={services} />;
}
```

The component renders on the server with the page and hydrates in the browser. The app's Vite compiles the package like the app's own
source, so the pieces work as they do for a component of the app:

- A `<Link route="…">` or `useRoute()` in the package's compiled code puts that route name into the browser's route manifest, as if
  the page had written it (see [Packages with pages or components](vite.md#packages-with-pages-or-components) for the compiled form the build reads).
- A stylesheet the component imports (`import './status-board.css'`) ships in the package's `dist` and lands in the chunk of the page
  that imports the component when a lazily loaded page does, not in the stylesheet every page loads. A component imported by a layout or the client
  entry puts its stylesheet into the first one. It must be finished CSS: the app's Tailwind does not see directives in it.
- The package lists `@marmeon/react`, `react` and `react-dom` (when it uses it) as peer dependencies, never as dependencies, so the app and the
  package share one copy and a `<Link>` of the package finds the router of the app.

The package's stylesheet and the app's share one document. Wrap the package's rules in `@layer <namespace>` (`@layer status { … }`),
so the app's own layers decide when both style an element, and give its classes a prefix (`.status-board-…`) so they do not meet the
app's. Marmeon enforces neither.

## Extending the app's types

A package that adds a key to a module's definition declares it by declaration merging, as the queue adds `jobs`:

```ts title="src/index.ts"
import type { LoggedTable } from './RequestLog.ts';

export { RequestLogConfig } from './RequestLogConfig.ts';
export { RequestLog } from './RequestLog.ts';
export { RequestLogServiceProvider } from './RequestLogServiceProvider.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The tables of this module whose requests the log notes. */
    readonly logged?: readonly LoggedTable[];
  }
}
```

The provider reads it from `app.modules`. A setting of the whole app goes into `ApplicationDefinition` the same way, as http adds
`middleware`, and the provider reads it from `app.definition`. Do not put anything there that only a boot decides: `env`,
`phase` and `override` belong to the options of `createApplication()`. The same works for the framework's other extensible types, such as `SharedProps` of
`@marmeon/http/page` for a prop on every page.

A page name with `::` (`package::Page`) belongs to a package: an app's page files may not contain it, and
`marmeon route:types` fails when one does (see [where pages live](pages.md#where-pages-live)).

## Writing a UI adapter

A UI adapter renders pages; the client core does the rest (the protocol, history, the page cache, requests and every security
invariant). `@marmeon/http/client/adapter` is what an adapter builds on: the `Navigator`, regions and layers, the features the core ships, reading the
first page, the form and link helpers and the page helpers. It is stable like any other entry point: a new required member of an
interface an adapter implements is a `breaking` change, a new capability arrives as an optional member or as one of the
core's features. `defineFeature` is the framework's own route to a feature and is not part of the entry; a public way for
third parties to write features would need a deliberately narrow host, and it could be added after 1.0 without breaking this
entry. `@marmeon/http/client` keeps what an app uses (the `hooks` and `tabSync` handles for `useFeature()`,
`xsrfToken`, the types an adapter re-exports).

An adapter that keeps a form's errors builds the record with `errorRecord(entries)`: an object without a prototype, so a field named
`constructor` or `__proto__` is a key and not an inherited member. `firstErrors(page)` returns one.

Browser code of a package imports the core only from these two entries, and never from `@marmeon/http/internal`: that one is server
code. The contract of an adapter, what it has to provide and the test that proves it, is in
[CONTRIBUTING.md](../CONTRIBUTING.md#the-client-core-and-its-adapters).

## Deprecating an API

Remove an API in two steps: first mark it deprecated in a release, then delete it in the next major version. Mark it twice, in
the types and at run time:

```ts
import { deprecated } from '@marmeon/core/deprecation';

export class Greeter {
  /**
   * @deprecated Use {@link Greeter.greet} instead. Removed in 2.0; docs/greeter.md#greeting.
   */
  hello(name: string): string {
    deprecated('greeter.hello', 'Greeter.hello() is deprecated, use Greeter.greet() instead.', '2.0');
    return this.greet(name);
  }
}
```

`deprecated(id, message, removeIn)` warns once per `id`. Name the id `<package>.<name>`, let `message` name the replacement, and give
`removeIn` as the version that removes the API. Import it from `@marmeon/core/deprecation` in code that runs in the browser: that
entry point does not load the rest of the core.

The warning appears only when `NODE_ENV` is `development` or `test`, so production pays nothing. On the server it is a Node
`DeprecationWarning`: `node --no-deprecation` silences it, and `node --throw-deprecation` turns it into an error, which makes a
test run fail on deprecated calls.

## Building and publishing

Node strips types only outside `node_modules`, so a published package runs its compiled JavaScript. Publish `dist/` with its `.js`
and `.d.ts` files, and point `exports` at them. A package whose entry is TypeScript stops the app with Node's
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and `marmeon` names the cause.

Build with `marmeon package:build`:

```sh
pnpm marmeon package:build --clean
```

It runs `tsc -b` for each directory you name, or the current one, and writes the injection lists and the island marks into the compiled files. Each
directory needs a `tsconfig.json` and TypeScript installed. A directory without a `tsconfig.json` stops the command before it builds
anything, with exit code 1 and the directory's name.
`--clean` empties `dist/` and the build info first, because `tsc -b` never deletes what a removed source left behind. A package
inside your own monorepo, whose entry is TypeScript, runs from its sources there, and the app derives its lists while it loads
them.

## Dependencies of drivers

A package that talks to a third-party service decides how the app gets its driver library. The framework's packages follow one
rule, and a package of yours should too:

1. A package that wraps exactly **one** library and is useless without it lists it in **`dependencies`**, at a caret range of the
   major you tested. `@marmeon/redis` brings `redis` that way, so the app installs one package.
2. A package with **several** drivers to choose from, usually one built in, keeps the third-party ones as **optional peer
   dependencies**. Its error names the exact install command with the major, such as `pnpm add @aws-sdk/client-s3@^3
   @aws-sdk/s3-request-presigner@^3`. Where the driver is surely used, such as a configured default disk on S3, the start fails
   with it, not the first request.
3. A library whose instance or types the app must **share** stays a **peer dependency**: React, Vite, the OpenTelemetry API. A
   dependency would install a second copy, and the two would not see each other.

Two decided exceptions keep a library as a dependency that rule 1 would not: `nodemailer` in `@marmeon/mail`, and
`@simplewebauthn/server` in `@marmeon/auth`, whose passkey verification is security-critical and which only the `@marmeon/auth/passkeys`
subpath loads.

The framework packages you build on are a different case. List them as `dependencies` with a caret range of the version the app
uses, as the framework's own packages list each other, so the package manager resolves them to the app's one copy. A range the
app's version does not satisfy installs a second copy, whose `Router` and container tokens the app never sees.

The framework's packages are coupled the same way: an optional peer dependency on another framework package, such as
`@marmeon/redis` for a Redis cache, with a start that fails and names the package when the configuration needs it.
