# Package Development: Getting Started

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

After `pnpm add @acme/marmeon-request-log`, the app registers `RequestLogServiceProvider` at its next start, with no extra step. This section
builds that package: a request log with its configuration, a middleware, a command and a route. Its `RequestLog` buffers an entry
for every request and writes the buffer when it is flushed, so it is not an audit trail: an entry written later and outside the
transaction of a change can be missing for a change that was kept. A trail that must commit with its change is a listener that
writes in the change's transaction, see [an audit trail](events.md#an-audit-trail).

This page covers the package protocol and the service provider. The other pages of the section go deeper on one topic each, and the first three of them continue the request log:

- [Commands, Checks & Jobs](package-commands.md) adds a command, a check and a job.
- [Tables & Migrations](package-tables.md) ships tables, migrations and files.
- [Routes & Middleware](package-routes.md) adds a middleware and a route.
- [Pages & Components](package-pages.md) brings pages, components, types and a UI adapter.
- [An Area of Its Own](package-areas.md) ties routes, pages and texts into an area.
- [Packages with Users](package-users.md) gives a package its own guard and table of users.
- [Building & Publishing](package-publishing.md) builds, publishes and deprecates.
- [Workspace Packages](package-workspace.md) runs a package from its sources inside your app.

## The package protocol

Everything in this section that an app or the framework reads from a package is the *package protocol*. A package may rely on what
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
| `namespace` | The prefix of the package's pages and texts, such as `"status"`: lowercase letters, digits and single hyphens, starting with a letter, at most 32 characters, and not `app` or `marmeon`. Required with `entry`, `views` or `lang`; alone it marks a package whose code is user interface. See [Pages of a package](package-pages.md#pages-of-a-package). |
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
A listed name that is exported but is no class at run time (for example a type-only export), or that a package resolved to its TypeScript sources lists without a matching export, stops the app with `K7`, naming the file and the export.

The app writes what it found to `.marmeon/manifest.json` and writes it again by itself when `package.json`, the lockfile or the
resolution conditions change. It also does so when the `package.json` of a package in your workspace changes. The app also writes it again when a folder from your app up to your workspace gains or loses a workspace marker or a lockfile, or starts or stops being trusted. An app without a workspace counts the folders above it up to the first untrusted one. Your workspace is the first folder, from your app upwards, that has a `pnpm-workspace.yaml` (or a `package.json` with `workspaces`) or a
lockfile, else your app's folder. An app with a lockfile of its own is therefore its own workspace: a pnpm workspace with one lockfile per
project does not watch the packages beside the app. The search for your workspace stops below the first folder above your app that everyone can
write to or that a user other than you, root or the owner of your app owns; on a mount where every folder is writable by everyone (WSL
`/mnt/c`, some bind mounts), discovery then sees only what your app's `node_modules` and the install trees of the packages linked there hold. There, run `marmeon discover` after an install. That check does not run on Windows, and it lets
a folder pass that only a group can write to. Discovery looks for a package in the `node_modules` of the package that needs it and of each
folder above it, up to your workspace. A package linked from outside your workspace is looked up only in its own install tree and is not
watched; a name that is not installed there stays absent. A package in a `dependencies` list that is installed but out of that reach is named in a warning when the app starts, once per
process. The [modules](modules.md#discovery) page explains discovery from the app's side, and how an app turns it off.

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
| `commands` | `readonly CommandClass[]` | `marmeon` | [Commands](package-commands.md#commands) |
| `[providerJobs]` | `readonly JobClass[]` | `@marmeon/queue`, `marmeon` | [Jobs](package-commands.md#jobs) |
| `checks` | `readonly AppCheckClass[]` | `marmeon check` | [Checks](package-commands.md#checks) |
| `migrations` | `{ from: URL, module: string }` | `marmeon publish` | [Declaring the migrations a package ships](package-tables.md#declaring-the-migrations-a-package-ships) |
| `publishes` | `{ lang: URL }` | `marmeon publish` | [Declaring the files a package publishes](package-tables.md#declaring-the-files-a-package-publishes) |
| `queueDrivers` | `Record<string, QueueDriverFactory>` | `@marmeon/queue` | [Drivers](drivers.md#bringing-a-driver) |
| `failedJobDrivers` | `Record<string, FailedJobStoreFactory>` | `@marmeon/queue` | [Drivers](drivers.md#bringing-a-driver) |
| `diskDrivers` | `Record<string, DiskDriverFactory>` | `@marmeon/storage` | [Drivers](drivers.md#bringing-a-driver) |
| `cacheDrivers` | `Record<string, CacheDriverFactory>` | `@marmeon/cache` | [Drivers](drivers.md#bringing-a-driver) |
| `mailDrivers` | `Record<string, MailDriverFactory>` | `@marmeon/mail` | [Drivers](drivers.md#bringing-a-driver) |
| `fetchDrivers` | `Record<string, FetchDriverFactory>` | `@marmeon/fetch` | [Fetch transports](drivers.md#fetch-transports) |
| `oauthProviders` | `Record<string, OAuthProviderFactory>` | `@marmeon/oauth` | [Social login](oauth.md#your-own-provider) |
| `chatDrivers` | `Record<string, ChatDriverFactory>` | `@marmeon/chat-notifications` | [Chat drivers](drivers.md#chat-drivers) |
| `searchDrivers` | `Record<string, SearchDriverFactory>` | `@marmeon/search` | [Writing a driver](full-text-search.md#writing-a-driver) |
| `searchIndexes` | `readonly SearchIndexClass[]` | `@marmeon/search` | [Defining an index](full-text-search.md#defining-an-index) |

### Statics of other classes

| Class | Static | Meaning |
| --- | --- | --- |
| any class the container builds | `inject` | The list of what the constructor needs, in the order of its parameters. Without it, the build or the app's start derives it from the `.d.ts` files ([injected classes](#injected-classes)). |
| a health check | `check`, `timeout` | The check's name, unique among the checks, and how long it may take: a number of seconds, or a [`Duration`](time.md#spans-of-time) ([health](health.md#writing-a-health-check)). |
| a check of `marmeon check` | `check`, `phase`, `timeout` | The check's name in kebab-case, `'build'` or `'run'`, and how long it may take ([checks](package-commands.md#checks)). |
| a command | `command`, `description`, `usage`, `options`, `hidden`, `experimental` | The name one types and what `marmeon list` shows ([writing commands](console.md#writing-commands)). A `hidden` command is a step of another command and no API, unlike the package's other commands. |
| a controller | `request` | The request schema that validates the route's input and types its context ([controllers](controllers.md)). |
| a repository | `table`, `connection`, `routeKey`, `routeKeyPattern` | The table, the default connection, and the column and pattern a route parameter is bound by ([repositories](queries.md#defining-a-repository)). |
| a job | `job`, `schema`, `tries`, `backoff`, `timeout`, `encrypted`, `middleware` | Its stable name, the schema of its payload and its retry, timeout, encryption and middleware settings ([the job class](queues.md#the-job-class)). A provider lists the class in `static [providerJobs]`. |
| an event that queued listeners listen to | `event`, `schema` | Its stable name and the schema of what is queued ([queued listeners](events.md#queued-listeners)). |

The statics of notifications and queued listeners (`notification`, `database`, `queue`, `listener`, and their own `schema`) and the `preview` of a mail are not part of the protocol: only a module registers those classes, and a package's provider does not list them. That holds for the listeners of a [guard's](authentication.md#events-of-a-guard) or a [guard slot's events](authentication.md#events-of-a-guard-slot) too: the app lists them in a module.

## The service provider

A package has no module definition, so its provider carries what a module would list: its configuration, its health checks, its
solutions and its jobs. The [service providers](providers.md) page explains `register()`, `boot()` and `shutdown()`; here is what matters for a
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
  load named routes, as [routes](package-routes.md#routes) explains.
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
at start from the `.d.ts` files, for the classes that the package's entry and its other `exports` subpaths export.
The app imports, when it starts, the module that each injected class comes from. A class that several subpaths of `exports`, `"."` included, export comes
from the first of them in the order of `exports`, so list `"."` first when a subpath needs an optional or browser-only dependency.
An import that the entry or a subpath exports again is followed when it is relative and inside the package. An import from another package, or
from a file without a declaration file, is not followed, so that class gets no injection list (`K3` when the class is first built). A
relative import that leads out of the package stops the start with `K7`. Every parameter
must be a class or a token, as the [service container](container.md#constructor-injection) page explains. A class in a `browser`
glob gets no list, so no injection code reaches a client bundle. `marmeon package:build` also marks a controller that answers with an
[island](deferred-props.md#the-islands-route); a package built before that mark existed answers an island's request with a 404 until
it is built again, because the app's loader leaves `node_modules` alone.

## Drivers

A package can bring a driver for a service that selects its drivers by name, such as a queue driver for SQS. It lists a factory in
a static record of its provider, such as `static queueDrivers = { sqs }`, and the app selects it with an environment variable. The
[drivers](drivers.md) page lists the records, the names a driver may take and the checks at the start.
