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

The app finds the field when it walks its dependencies, the dev dependencies included, and the dependencies of those. A package's
providers register after the providers of the packages it depends on, so list the framework packages you build on as dependencies.
A name in `providers` that the entry does not export stops the app with
`@acme/marmeon-audit lists provider "AuditServiceProvider" in package.json, but its entry does not export it.`

The app writes what it found to `.marmeon/manifest.json` and writes it again by itself when `package.json` or the lockfile
change. The [modules](modules.md#discovery) page explains discovery from the app's side, and how an app turns it off.

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
`@marmeon/*/internal` subpaths are how the framework's own packages mark theirs as the framework's, they are not API, and a route
loaded with their marker outside `/_marmeon/` is refused at load; `pnpm check:source` refuses importing them outside the
framework's own sources.

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

The provider reads it from `app.modules`. The same works for the framework's other extensible types, such as `SharedProps` of
`@marmeon/http/page` for a prop on every page.

A page name with `::` (`package::Page`) belongs to a package: an app's page files may not contain it, and
`marmeon route:types` fails when one does (see [where pages live](pages.md#where-pages-live)).

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
