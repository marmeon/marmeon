# Modules & Discovery

## Introduction

A Marmeon app is one program made of modules. A module is a feature in a folder of its own, `modules/<name>/`, and its
`index.ts` says what the feature brings: its routes, its service providers, its configuration, its event listeners, its jobs, its
migrations and its schedule. The installed framework packages join the app on their own, through discovery.

```ts title="modules/notes/index.ts"
import { SignedIn } from '@marmeon/auth';
import { defineModule, listen } from '@marmeon/core';
import apiRoutes from './api-routes.ts';
import { NotesConfig } from './config.ts';
import { PruneTrashJob } from './jobs/PruneTrashJob.ts';
import { RecordLastVisit } from './listeners/RecordLastVisit.ts';
import { NotesServiceProvider } from './NotesServiceProvider.ts';
import routes from './routes.ts';
import { schedule } from './schedule.ts';

export { NoteRepository } from './NoteRepository.ts';

export default defineModule({
  name: 'notes',
  providers: [NotesServiceProvider],
  config: [NotesConfig],
  listeners: [listen(SignedIn, RecordLastVisit)],
  jobs: [PruneTrashJob],
  migrations: new URL('./migrations/', import.meta.url),
  routes,
  apiRoutes,
  schedule,
});
```

The app lists its modules in `bootstrap/app.ts`. A module that is not listed is not loaded, however complete its folder is.

### Why the list is explicit

The list is the one place that says what the app is made of, and it has three reasons to be a list:

- **The order.** A scan of the folder could only give alphabetical order, and a module carries no dependency information to
  sort by. The list gives [the order of modules](#the-order-of-modules) explicitly.
- **Nothing runs by accident.** The list holds static imports. A file that sits in `modules/` runs no code until something
  imports it, so a half-finished folder or a leftover from another branch cannot add routes or providers to the app.
- **The list is a value.** A test composes its own application from it, such as `{ ...application, modules:
  [...application.modules!, fixtures] }` to add a module of fixtures, or a shorter list to boot a part of the app.

The installed packages are different: they are discovered (see [Discovery](#discovery)), because a package opts in with a
`"marmeon"` field in its `package.json` and its dependencies give it a place in the order. `make:module` keeps the cost of
the explicit list low: it adds the new module to `bootstrap/app.ts` for you (see [Creating a module](#creating-a-module)).

## The application

`bootstrap/app.ts` exports the app's definition, made with `defineApplication()`. It describes the app and boots nothing: the
`marmeon` command boots it for the server or a command, and each test boots a fresh instance. The
[directory structure](structure.md#bootstrap) page shows a new app's file. The options:

| Option | What it is |
| --- | --- |
| `root` | The app's root folder, with `package.json`, `.env` and `index.html`. A new app sets it from `import.meta.dirname`. |
| `modules` | The feature modules, in the order they register and boot. |
| `config` | App-level config definitions. See [configuration](configuration.md). |
| `middleware` | The app's middleware: `global` for every request, `web` and `api` for the routes of each group. See [middleware](middleware.md#registering-middleware). |
| `clientRoutes` | Which named routes the browser may learn: `include` and `except`, by pattern. See [URL generation](urls.md#which-routes-the-browser-knows). |
| `providers` | App-level service providers. They boot after the packages' and before the modules'. |
| `listeners` | App-level event listeners: `listen(Event, Listener)`. |
| `health` | App-level checks for `/up/ready`. See [health checks](health.md). |
| `discover` | `false` registers none of the installed packages. Default: `true`. |
| `redact` | Key names and value patterns every redactor of the app masks besides the core's lists: `{ keys: ['iban'], patterns: [/\bacme_live_[A-Za-z0-9]{32}\b/] }`. See [patterns of your own](logging.md#patterns-of-your-own). |

The definition is what ships. What only one boot decides is not part of it: `defineApplication({ root, env: {} })` and
`defineApplication({ root, override: … })` are type errors, so a test double or a foreign environment cannot end up in the
app that runs in production. A definition that carries one anyway, through a variable or a spread the types cannot see, is refused
when `createApplication()` boots it. A package that adds an option to the definition declares it on `ApplicationDefinition` (see [extending
the app's types](package-development.md#extending-the-apps-types)).

`createApplication(definition, options)` boots an app from its definition and returns it. The `marmeon` command and
`createTestApp()` call it for you. The options are the ones a boot decides:

| Option | What it is |
| --- | --- |
| `env` | The environment to check the configuration against, instead of `.env` and the real environment. For tests and scripts. |
| `phase` | `'build'` registers the providers and boots none (what `marmeon build` needs). Default: `'run'`. |
| `override` | A function that replaces bindings after every provider registered and before any boots. For tests. |

 `app.shutdown()` stops the app again: every provider's `shutdown()` runs and closes its pools and connections. Code
that needs the booted app outside of a request, such as a maintenance script, belongs in a [console
command](console.md#writing-commands): `marmeon` boots the app for it and shuts it down afterwards.

## Defining a module

`defineModule()` takes the module's name and whatever the module contributes. The core knows a few keys, and each package adds
its own:

| Key | What it is | From |
| --- | --- | --- |
| `name` | The module's name, in kebab case. | core |
| `providers` | Its [service providers](providers.md). | core |
| `config` | Its [config definitions](configuration.md). | core |
| `listeners` | Its [event listeners](events.md): `listen(Event, Listener)`. | core |
| `health` | Its [health checks](health.md). | core |
| `routes` | Its route file, loaded into the `web` group. See [routing](routing.md#route-files). | `@marmeon/http` |
| `apiRoutes` | Its route file for the `api` group, under `/api`. | `@marmeon/http` |
| `commands` | Its [console commands](console.md). | `marmeon` |
| `checks` | Its [checks for `marmeon check`](package-development.md#checks). | `marmeon` |
| `migrations` | The folder of its [migrations](migrations.md): `new URL('./migrations/', import.meta.url)`. | `@marmeon/database` |
| `seeders` | Its [seeders](seeding.md). | `@marmeon/database` |
| `exposes` | The tables other modules may read and join. See [repositories](queries.md#module-boundaries). | `@marmeon/database` |
| `jobs` | Its [queued jobs](queues.md). A worker runs only registered jobs. | `@marmeon/queue` |
| `notifications`, `recipients` | Its [notifications](notifications.md) and who may receive them. | `@marmeon/notifications` |
| `liveAuthorizers` | Who may follow its [live channels](realtime.md#who-may-follow-a-channel). | `@marmeon/live` |
| `schedule` | Its [scheduled work](scheduling.md). | `@marmeon/scheduler` |
| `csrfExcept` | Paths that skip the [CSRF check](csrf.md#excluding-paths). | `@marmeon/session` |

Controllers, views and other classes need no list: a route names its controller, and the container builds it when a request
needs it.

### Creating a module

`make:module` writes a module with an empty route file:

```sh
pnpm marmeon make:module billing
```

It writes `modules/billing/index.ts` and `modules/billing/routes.ts`, and adds the module last in `modules` of
`bootstrap/app.ts` (routes match in module order). When that file has another shape, or with `--no-register`, it prints the two
lines to add instead. The [directory structure](structure.md#your-first-module) page walks through a first module from there.

### The order of modules

The modules register and boot in the order of `modules: [...]`, and their routes load in that order too. When two routes match
the same path, the one loaded first answers. The order rarely matters otherwise: every provider registers before any boots, so
a module can use what a later module binds once the app has booted.

## A module's public API

A module's `index.ts` is also its public face. What it exports is what the rest of the app may use, and other modules import it
from `#modules/<name>`:

```ts title="modules/dashboard/controllers/ShowDashboardController.ts"
import { Controller } from '@marmeon/http';
import { NoteRepository } from '#modules/notes';

export class ShowDashboardController extends Controller {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle() {
    return this.view('dashboard/Show', { notes: await this.#notes.query().selectAll().limit(5).execute() });
  }
}
```

`#modules/<name>` is an import map entry of the app's `package.json`: `"#modules/*": "./modules/*/index.ts"`. Node, Vite and
TypeScript all resolve it.

Nothing stops a module from importing a file inside another module, until you ask for it. `marmeon make:lint-config
--boundaries` writes the lint preset with one more rule: a module imports another module only through its entry. The lint then
refuses `import { NoteRepository } from '../../notes/NoteRepository.ts'`.

The preset also forbids `@marmeon/<package>/internal` in every file of the app, tests included. Those subpaths are the
framework's own code, not API, and can change in any release. Use the package's entry; if you need something only an internal
subpath has, open an issue. To add the rule to an existing preset, run `marmeon make:lint-config --force` (with `--boundaries` if you use it; it rewrites
the file, so carry your own changes over) or add the pattern by hand.

Two modules must not import each other's classes. If they do, one class is not defined yet when the other is, and the
container reports a constructor parameter that is `undefined` (K16, naming the class and the parameter). Under Node
(`marmeon dev`, `start`, commands) the import itself fails with "Cannot access 'X' before initialization"; in tests (Vite's
module runner) the container reports K16 instead. Break the cycle by letting one module read what the other
[exposes](queries.md#module-boundaries) (its table), or by depending on an abstract class that lives in a third place.

## Discovery

The framework's packages register themselves. A package that opts in with a `"marmeon"` field in its `package.json` has its
service providers registered by every app that installs it, so an app has no list of packages to maintain. This is the field
in the `package.json` of `@marmeon/http`:

```json
{
  "name": "@marmeon/http",
  "marmeon": {
    "providers": ["HttpServiceProvider"],
    "browser": ["src/client/**", "src/page.ts", "src/protocol.ts", "src/upload-header.ts", "src/live-protocol.ts", "src/tab-sync-protocol.ts"]
  }
}
```

`providers` names classes the package's entry exports. They register in the order of the dependencies: a package after the
packages it depends on. `browser` names the package's files that run only in the browser. The constructor injection leaves them
alone, so no injection code reaches a client bundle.

### `marmeon discover`

`marmeon discover` walks the app's dependencies and writes what it found to `.marmeon/manifest.json`: the providers of each
package, and the injection lists of the classes the packages export. You rarely run it yourself. The app writes the file again
by itself whenever `package.json`, the lockfile or the resolution conditions change, so `pnpm add -E @marmeon/redis@<version of your app>` needs no extra
step. It also writes it again when a listed package is gone, such as after a production install without the dev dependencies.
`marmeon build` writes the production list.

The file is data and is never imported, so rewriting it restarts no development server. Git ignores `.marmeon/`.

### A read-only `.marmeon/`

On a server whose app folder is read-only, the app cannot rewrite an outdated list. It discovers the packages in memory instead,
logs one warning and starts. Run `marmeon build` or `marmeon discover` where the folder is writable, such as in the build stage
of an image, and the warning goes away.

### Without discovery

`defineApplication({ discover: false })` registers none of the installed packages. The app then lists every provider it needs
in `providers`, in the right order. This is for tests and special setups. A normal app keeps discovery on. The
[package development](package-development.md#the-marmeon-field) page explains how a package of your own opts in.

## Testing

`createTestApp()` boots the app from the same definition, with its modules and the discovered packages:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('loads the notes module', async () => {
  await using app = await createTestApp(application);
  expect(app.application.modules.map((module) => module.name)).toContain('notes');
});
```

The [testing](testing.md#creating-the-test-app) page explains how a test boots the app.
