# Package Development

## Introduction

A package brings services, configuration, commands, middleware and routes into every app that installs it, and the app lists
nothing. The framework's own packages work this way, and a package of yours does the same. It opts in with a `"marmeon"` field
in its `package.json` that names its service provider:

```json title="package.json"
{
  "name": "@acme/marmeon-audit",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "files": ["dist"],
  "marmeon": {
    "providers": ["AuditServiceProvider"]
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

After `pnpm add @acme/marmeon-audit`, the app registers `AuditServiceProvider` at its next start, with no extra step. This page
builds that package: an audit log with its configuration, a middleware, a command and a route.

## The `"marmeon"` field

| Key | What it holds |
| --- | --- |
| `providers` | The names of service provider classes that the package's entry exports. |
| `browser` | Globs of the package's files that run only in the browser, relative to the package, such as `["src/client/**"]`. |
| `migrations` | The migrations that create the package's tables, and the module they go to: `{ "format": 2, "module": "permissions", "from": "stubs/migrations" }`. Details below. |

The app finds the field when it walks its dependencies, the dev dependencies included, and the dependencies of those. A package's
providers register after the providers of the packages it depends on, so list the framework packages you build on as dependencies.
A name in `providers` that the entry does not export stops the app with
`@acme/marmeon-audit lists provider "AuditServiceProvider" in package.json, but its entry does not export it.`

The app writes what it found to `.marmeon/manifest.json` and writes it again by itself when `package.json` or the lockfile
change. The [modules](modules.md#discovery) page explains discovery from the app's side, and how an app turns it off.

### Declaring the migrations a package ships

`migrations` names the directory of the package that holds the stubs that **create** its tables:
`{ "format": 2, "module": "permissions", "from": "stubs/migrations" }`. The field only declares the directory; it copies nothing. An app
copies the files with `marmeon publish <package>` ([publishing the migrations of a
package](migrations.md#publishing-the-migrations-of-a-package)), which accepts only a direct dependency of the app and never runs code
of the package.

Each file in the directory is named like a migration of an app, `<timestamp>_<name>.ts`, such as
`2026_01_01_000000_create_permissions_table.ts`. The migrations are read in the order of their file names. The timestamp only orders
the files within the package: `publish` gives a copy a new one in the app. The name without the timestamp (`create_permissions_table`)
is what identifies a migration, so it is unique in the directory. The framework's packages start with
`0001_01_01_000000_<name>.ts`; a file added later carries the date it was written. A file that has shipped is never edited or deleted:
a change of a table is a new file behind the others. Anything in the directory that does not end in `.ts`, such as a `README.md`, and
every sub-directory is passed over.

`module` is required. It is a suggestion: the module the tables go to when the files are copied into the app, which the app can
change. Which module owns a table follows from the module its migration file is in, not from the package. The framework's own
packages name `system`.

A package's `package.json` is not trusted, so the field is read strictly, and a wrong one fails with
[D21](errors.md#server-error-codes):

- `format` is `2`. `1` named every file (`"files": [...]`) and is no longer read; a higher number was written for a newer Marmeon.
- Only `format`, `module` and `from` are allowed.
- `module` is a kebab-case name such as `permissions`, so never a path; it has at most 64 characters and is no Windows device name (`nul`, `com1`, …).
- `from` is a relative path that uses `/`: no leading `/`, no drive letter, no `\`, no `.`, `..` or empty segment. Its real path, after following symlinks, lies inside the package and is a directory.
- Every entry is checked by its own real path: a file that is a symlink leading out of the package, or is no regular file, is refused (so is a symlink to a directory whose name ends in `.ts`: it is no file, not passed over). A file whose contents are not valid UTF-8 or have no `export default` is refused too: it cannot be a migration. A hard link to a file outside the package is not detected.
- A `.ts` file is named `<timestamp>_<name>.ts` (so `create_things.ts` and `things.d.ts` are refused), at most 1 MiB, at most 100 in the directory, and the names without timestamp differ. The directory holds at least one.

List the directory in `files` of your `package.json`, so the stubs ship in the tarball; `pnpm pack:check` of this repository does
that for the framework's packages.

## The service provider

A package has no module definition, so its provider carries what a module would list: its configuration, its health checks and its
solutions. The [service providers](providers.md) page explains `register()`, `boot()` and `shutdown()`; here is what matters for a
package:

```ts title="src/AuditServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { AuditConfig } from './AuditConfig.ts';
import { AuditLog } from './AuditLog.ts';
import { PruneAuditCommand } from './PruneAuditCommand.ts';
import { RecordRequest } from './RecordRequest.ts';

export class AuditServiceProvider implements ServiceProvider {
  static config = [AuditConfig];
  static commands = [PruneAuditCommand];

  register(container: Container): void {
    container.singleton(AuditLog);
  }

  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, RecordRequest, 50);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(AuditLog).flush();
  }
}
```

- **`register()`** binds only, because another package's services may not be bound yet. The one exception is the `Router`, to
  load named routes, as [routes](#routes) explains.
- **`boot()`** runs once every provider of the app has registered, and may resolve anything.
- **`shutdown()`** runs when the app stops, in reverse order, while the services the provider depends on still exist.
- **`static health`** lists checks for `/up/ready`, which the [health](health.md#writing-a-health-check) page covers, and
  `static solutions` lists solutions for the package's errors, shown on the [development error page](errors.md#solutions).

### Configuration

`static config` lists the package's configuration definitions. The app checks them with its own before any provider registers, so
a wrong value stops the start with the variable's name:

```ts title="src/AuditConfig.ts"
import { defineConfig, env, type ConfigOf } from '@marmeon/core';

export const AuditConfig = defineConfig('audit', {
  env: env({
    AUDIT_ENABLED: env.boolean().default(true),
    AUDIT_RETENTION_DAYS: env.integer().min(1).max(3650).default(90),
  }),
  resolve: (e) => ({ enabled: e.AUDIT_ENABLED, retentionDays: e.AUDIT_RETENTION_DAYS }),
});
export type AuditConfig = ConfigOf<typeof AuditConfig>;
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
glob gets no list, so no injection code reaches a client bundle.

## Drivers

A package can bring a driver for a service that selects its drivers by name, such as a queue driver for SQS. It lists a factory in
a static record of its provider, such as `static queueDrivers = { sqs }`, and the app selects it with an environment variable. The
[drivers](drivers.md) page lists the records, the names a driver may take and the checks at the start.

## Commands

A package lists its commands as `static commands` on its provider. The CLI collects them while the app registers, before anything
boots, so `marmeon build` sees them and stops on a name that is taken twice; the message names both commands and the provider.
`marmeon` stays an optional peer dependency — the command files import only its types. A command is a class like any
[command of an app](console.md#writing-commands):

```ts title="src/PruneAuditCommand.ts"
import type { CommandInput } from 'marmeon';
import { AuditConfig } from './AuditConfig.ts';
import { AuditLog } from './AuditLog.ts';

export class PruneAuditCommand {
  static command = 'audit:prune';
  static description = 'Delete audit entries older than AUDIT_RETENTION_DAYS';

  readonly #log: AuditLog;
  readonly #config: AuditConfig;

  constructor(log: AuditLog, config: AuditConfig) {
    this.#log = log;
    this.#config = config;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const deleted = await this.#log.pruneOlderThan(this.#config.retentionDays);
    output.success(`Deleted ${deleted} audit entries.`);
    return 0;
  }
}
```

Name a package's commands with a prefix of their own, such as `audit:`. A package's commands always run in a booted app.
`static boots` is read for the framework's built-in commands only.

`DevProcesses` of `marmeon` adds a process that `marmeon dev` starts next to the server, as the queue does with its worker:
`app.container.make(DevProcesses).add({ name: 'audit', args: ['audit:watch'] })`. The arguments are those of a `marmeon` command.

### Registering what a generator writes

A generator that writes a class for a module can also list it there. `editDefinitionFile` of `@marmeon/core` adds an entry to a list of the object that `defineModule` or `defineApplication` receives, together with the imports it needs. It only inserts: the rest of the file stays as it was, comments, quotes and line endings included. Running it twice adds nothing the second time.

```ts
import { join } from 'node:path';
import { editDefinitionFile } from '@marmeon/core';

const outcome = editDefinitionFile(join(root, 'bootstrap', 'app.ts'), {
  define: { name: 'defineApplication', from: '@marmeon/core' },
  key: 'modules',
  add: { element: (names) => names.audit!, position: 'last' },
  imports: [{ name: 'audit', from: '#modules/audit', kind: 'default' }],
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

```ts title="src/AuditTableCheck.ts"
import type { AppCheck, CheckProblem } from 'marmeon';
import { AuditLog } from './AuditLog.ts';

export class AuditTableCheck implements AppCheck {
  static check = 'audit-table';
  static phase = 'run' as const;

  readonly #log: AuditLog;

  constructor(log: AuditLog) {
    this.#log = log;
  }

  async handle(): Promise<readonly CheckProblem[]> {
    if (await this.#log.hasTable()) return [];
    return [{ severity: 'error', message: 'The audit table is missing', fix: 'marmeon migrate', docs: 'docs/audit.md#installation' }];
  }
}
```

`static phase = 'build'` is for a check that reads only what registering the app builds, with no secret and no connection; `'run'`
is for anything that reads configuration or opens a connection, and gets the booted app. The check is built through the container in
a scope of its own. `handle()` is given `{ signal }`, aborted when the time is up: release what you opened. Return `{ skipped: 'why' }` instead of findings when the check should not run here. A finding is a [`CheckProblem`](check.md#json-output); its message is masked by the app's redactor, but name no secret in it.
A check that throws, or takes longer than a minute (`static timeout` sets it), ends as `error`, never as another check's result.

A bad or duplicate check name stops every command, not only `marmeon check`, as a command name used twice does. The name must be unique, in kebab-case, and none of `types`, `lint`, `internal-imports`, `agents`, `boot` or `readiness`; the app does
not start otherwise, and the message names both checks. A check that asks whether the package's service is reachable is not a
check but a [health check](health.md#writing-a-health-check): `marmeon check` runs those as `readiness`.

## Tables

A package that keeps tables in the app's database does not write them into the app itself. It ships the migrations as stubs, and
the app copies them. The contract has six parts:

1. **The directory.** The files lie in the directory `from` names and are called `<timestamp>_<name>.ts`, such as
   `2026_01_01_000000_create_audit_table.ts`. Name a file after its table, as an app does. They run in the order of their names,
   and a name without its timestamp is unique in the directory.
2. **Append-only.** A file that has shipped is never edited, renamed or deleted, because an app has copied it and its database has
   run it. A release that changes a table adds a file that sorts after every other in the directory. In the framework's repository, the "api label" check refuses a pull request that does otherwise.
3. **The plan.** `up(schema)` is synchronous and only describes the change; the app computes what it did without running it. Data
   changes go through `schema.data()` and nowhere else. A column that holds a secret, such as a token's hash, is marked
   `.secret()`. See [migration structure](migrations.md#migration-structure).
4. **The list and `publish`.** `"marmeon": { "migrations": … }` in `package.json` names the directory of
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

## Middleware

`router.middleware.append(group, Middleware, priority)` adds a middleware to the global stack, `GLOBAL`, or to a group such as
`web` or `api`. The priority places it among the framework's middleware, lower first. Your app's own middleware has `app`, 1000.
The [middleware](middleware.md#the-order) page lists every priority, and `MiddlewarePriority` of `@marmeon/router` holds them.

Add middleware in `boot()`, as the provider above does. A middleware in the global stack runs for every request of every app that
installs the package, also for paths without a route, so keep it cheap.

## Routes

`router.load({ group, prefix }, routes)` loads a route file into a group. The same provider, with a page of its own:

```ts title="src/AuditServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { defineRoutes, everyone, Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { AuditConfig } from './AuditConfig.ts';
import { AuditLog } from './AuditLog.ts';
import { PruneAuditCommand } from './PruneAuditCommand.ts';
import { RecordRequest } from './RecordRequest.ts';
import { ShowAuditController } from './ShowAuditController.ts';

export class AuditServiceProvider implements ServiceProvider {
  static config = [AuditConfig];
  static commands = [PruneAuditCommand];

  register(container: Container): void {
    container.singleton(AuditLog);
    container.make(Router).load(
      { group: 'web', prefix: '/audit' },
      defineRoutes((Route) => {
        // The page is open to anyone by this package's design, so it says so.
        Route.authorize(everyone).get('/', ShowAuditController).name('audit.index');
      }),
    );
  }

  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, RecordRequest, 50);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(AuditLog).flush();
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
| `router.intercept({ claims, answer })` | Answers the requests it claims in the route's place, after the route's middleware, bindings and `authorize`. The controller is never built. The storage package answers its upload requests this way. |

A hook runs for every route of every app that installs the package, so keep it narrow: claim requests by a header of your own, and
leave everything else alone.

## Extending the app's types

A package that adds a key to a module's definition declares it by declaration merging, as the queue adds `jobs`:

```ts title="src/index.ts"
import type { AuditedTable } from './AuditLog.ts';

export { AuditConfig } from './AuditConfig.ts';
export { AuditLog } from './AuditLog.ts';
export { AuditServiceProvider } from './AuditServiceProvider.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** The tables of this module whose changes go into the audit log. */
    readonly audited?: readonly AuditedTable[];
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
invariant). `@marmeon/http/client/adapter` is what an adapter builds on: the `Navigator`, regions and layers, `defineFeature`, reading the
first page, the form and link helpers and the page helpers. It is [experimental](releases.md#experimental) until a second adapter
exists, so it can change in any minor version. `@marmeon/http/client` keeps what an app uses (the `hooks` and `tabSync` handles for
`useFeature()`, `xsrfToken`, the types an adapter re-exports) and does not change with it.

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

It runs `tsc -b` for each directory you name, or the current one, and writes the injection lists into the compiled files. Each
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
