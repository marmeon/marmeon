# Directory Structure

## Introduction

A Marmeon app is a set of modules. Each feature lives in one folder under `modules/`, with its routes, controllers, pages,
migrations and tests side by side. Around the modules sit a few folders that hold the app together. This is a new app with the
starter kit, as `pnpm create marmeon my-app` writes it:

```text
my-app/
├── bootstrap/        the app's definition, its browser and server entries, generated types
├── config/           the app's own settings
├── lang/             texts the whole app shares
├── layouts/          the app's own components, such as its confirm dialog
├── modules/
│   ├── auth/         sign-in, registration, password reset, API tokens
│   ├── home/         the home page
│   └── system/       the tables of the framework's queue
├── storage/          what the app writes while it runs
├── index.html        the document every page renders into
├── .env              this machine's settings, never committed
├── .env.example
├── .env.test
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
└── .oxlintrc.json
```

A blank app from `pnpm create marmeon my-app --minimal` has the same skeleton without `lang/`, `layouts/`,
`modules/auth/` and `modules/home/`. This page walks through each part, then through your first module.

## The root directory

### `bootstrap/`

`bootstrap/` connects the parts. You edit the first file often, the others rarely:

| File | What it does |
| --- | --- |
| `app.ts` | Describes the app: its modules, its configuration and its global middleware. Every command and every test loads it. |
| `client.tsx` | The browser's entry. It reads the page from the document and hydrates it. |
| `ssr.tsx` | The server's entry for rendering pages. |
| `pages.ts` | Finds the page components under `modules/*/views/`, one code-split chunk per page. |
| `head.ts` | The document title, shared by both entries. |
| `i18n.ts` | Loads the language files for the page's locale, in the browser and on the server. |
| `routes.ts` | Generated: every named route and every view, for the type checker. Commit it. |
| `database.d.ts` | Generated: the types of the database tables. Commit it. |

`bootstrap/app.ts` only describes the app. It boots nothing itself. The `marmeon` command boots it for a command or the server,
and each test boots a fresh instance:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, securityHeaders } from '@marmeon/http';
import auth from '#modules/auth';
import home from '#modules/home';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, home, system],
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy()],
  },
});
```

The [modules](modules.md#the-application) page lists every option of `defineApplication()`.

### `config/`

`config/app.ts` holds the app's own settings: `APP_NAME` and `APP_URL`. Settings that belong to a feature live in its module
instead, and each installed package brings its own. The [configuration](configuration.md#defining-configuration) page explains
config definitions.

### `lang/`

The texts the whole app shares, such as the questions of `layouts/Confirm.tsx`, one file per language: `lang/en.ts`,
`lang/de.ts`. A module keeps its own texts in its `lang/` folder. The [localization](localization.md) page covers both.

### `layouts/`

Components the whole app shares, unlike a module's `layouts/`, which wraps that module's pages. The starter kit has
`Confirm.tsx`, the dialog the app asks its questions with, such as the one before unsaved changes are left;
`bootstrap/client.tsx` passes it to `createMarmeonApp`. The [dialogs](dialogs.md#asking-the-user) page shows it. Starter kit
only.

### `middleware/`

Middleware that belongs to no feature. A new app does not have the
folder yet: `securityHeaders()` from `@marmeon/http` already adds `nosniff`, a referrer policy and `X-Frame-Options` to every
response. The [middleware](middleware.md) page shows how to write your own.

### `modules/`

The features of the app. Each module is a folder with an `index.ts` that exports its definition:

| Module | What it holds |
| --- | --- |
| `auth/` | Sign-in, registration, password reset, the e-mail check, the security page and API tokens. Written by `marmeon make:auth`, and yours to change. The [starter kit](starter-kit.md) page describes it. |
| `home/` | The home page at `/`. Starter kit only. |
| `system/` | The migrations of the tables the framework's drivers need, such as the queue's `jobs` table. |

### `storage/`

What the app writes while it runs. Git keeps the folders and ignores their contents. On a server, `storage/` is a volume of its
own:

| Path | What it holds |
| --- | --- |
| `storage/database.sqlite` | The SQLite database. |
| `storage/app/private/`, `storage/app/public/` | The local disks of [file storage](storage.md). |
| `storage/framework/sessions/` | Sessions of the `file` driver. |
| `storage/framework/cache/` | The cache of the `file` driver. |
| `storage/framework/devtools/` | What the [devtools](devtools.md) recorded. Development only. |
| `storage/framework/compile-cache/` | Node's compile cache, which makes `marmeon start` faster. |
| `storage/framework/testing/` | The SQLite databases of [refreshed test apps](database-testing.md), one per test worker. |

### The files in the root

| File | What it does |
| --- | --- |
| `index.html` | The document template. The server renders each page into it. |
| `.env`, `.env.example`, `.env.test` | The settings of this machine, a template for them, and the settings of the tests. See [configuration](configuration.md#the-environment-files). |
| `package.json` | The dependencies and scripts. Its `imports` field maps `#modules/<name>` to `./modules/<name>/index.ts`. |
| `tsconfig.json` | Strict TypeScript that Node runs without a compile step. `erasableSyntaxOnly` refuses what Node cannot strip, such as enums and parameter properties. |
| `vite.config.ts` | Vite with the `marmeon()` plugin and the React plugin. |
| `vitest.config.ts` | The tests: `modules/**/*.test.ts`. |
| `.oxlintrc.json` | The lint preset. It keeps views from importing server code by value. |

### Generated folders

Three folders appear once you run the app or build it. Git ignores them:

| Folder | Written by | What it holds |
| --- | --- | --- |
| `node_modules/` | the package manager | The dependencies. |
| `.marmeon/` | `marmeon` itself | The list of installed packages and their providers, the routes the browser may learn, the schema the migrations describe, and after a build the precomputed injection lists. |
| `dist/` | `marmeon build` | The browser's files in `dist/client/` and the server rendering in `dist/server/`. |

## Inside a module

A module grows the folders it needs. The auth module of the starter kit uses most of them:

```text
modules/auth/
├── index.ts                the definition, and what other modules may import
├── routes.ts               the routes of the web group
├── api-routes.ts           the routes of the api group, under /api
├── AuthServiceProvider.ts  bindings and start-up code
├── controllers/            one class per endpoint
├── views/                  the pages
├── layouts/                the layouts around the pages
├── lang/                   the module's texts
├── middleware/
├── mail/                   mails
├── jobs/                   queued jobs
├── listeners/              event listeners
├── tasks/                  scheduled tasks
├── commands/               console commands
├── migrations/
├── factories/
├── seeders/
├── schedule.ts             when the scheduled work runs
└── auth.test.ts            tests, next to the code
```

Only `index.ts` is required, and two folder names matter: the pages are found under `views/`, and the module's texts under
`lang/`. Routes, providers, jobs,
listeners, commands, migrations and the schedule count once the module's definition lists them. Controllers and other classes
need no list: the container builds them when a route or a constructor asks for them.

`index.ts` is also the module's public face. Other modules import from `#modules/notes`, never from a file inside it, so
whatever `index.ts` exports is what the rest of the app may use. In this example the module also has a repository, which the
walk-through below does not create:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

// What other modules may use:
export { NoteRepository } from './NoteRepository.ts';

export default defineModule({
  name: 'notes',
  routes,
});
```

The [modules](modules.md) page shows every key a module definition can have, and how to enforce the boundaries with the lint
preset.

## Your first module

A new feature starts as a module. This walk-through adds a page at `/notes` for signed-in users.

### Create the module

`make:module` writes `index.ts` and an empty `routes.ts`, and `make:controller` writes a controller and its page:

```sh
pnpm marmeon make:module notes
pnpm marmeon make:controller ListNotes --module=notes --view
```

With npm, run the commands as `npx marmeon …`. `pnpm marmeon list` shows every command the app has.

### Register it

The app loads a module only when `bootstrap/app.ts` lists it. `make:module` adds the module last in `modules` (routes match in module order), which gives:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy, securityHeaders } from '@marmeon/http';
import auth from '#modules/auth';
import home from '#modules/home';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import notes from '#modules/notes';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [auth, home, system, notes],
  middleware: {
    global: [securityHeaders(), contentSecurityPolicy()],
  },
});
```

### Add the route, the controller and the page

The route points to the controller and gives it a name. `authenticate()` sends guests to the sign-in page, and `verified()`
sends an account whose address is not confirmed yet to the auth module's notice:

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).authorize(everyone).get('/notes', ListNotesController).name('notes.index');
});
```

`authenticate()` alone would let in an account registered with somebody else's address. The auth module's own pages check the
address themselves, and a route of yours needs `verified()` for that. The [starter kit](starter-kit.md#your-own-pages) page
explains why.

The controller answers with the page `notes/ListNotes`, which is `modules/notes/views/ListNotes.tsx`, and hands it its props:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class ListNotesController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    return this.view('notes/ListNotes', { author: ctx.user.name });
  }
}
```

The page takes its props from the controller's type, so a prop the controller does not send is a compile error:

```tsx title="modules/notes/views/ListNotes.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function ListNotes({ author }: PageProps<ListNotesController>) {
  return (
    <main>
      <Head title="Notes" />
      <h1>Notes of {author}</h1>
      <Link route="dashboard">Back to the dashboard</Link>
    </main>
  );
}
```

The view imports the controller with `import type`. A value import would bundle server code into the browser, and the lint
preset and the build both refuse it.

### See it

`pnpm dev` keeps `bootstrap/routes.ts` up to date, so `notes.index` is a known route name at once. Open
http://localhost:3000/notes and sign in with a confirmed account, and the page is there. The
[installation](installation.md#your-first-account) page shows how to register the first account. `pnpm marmeon route:list` shows
the route with every middleware it passes.

### A table for the notes

`make:migration` writes a migration into the module:

```sh
pnpm marmeon make:migration create_notes_table --module=notes
```

The first migration of a module also needs its folder in the module's definition: the command adds
`migrations: new URL('./migrations/', import.meta.url)` and prints the line only when the file has another shape or you pass
`--no-register`. `pnpm marmeon migrate` then creates the table and, in development,
writes its types into `bootstrap/database.d.ts`. The [migrations](migrations.md) and [repositories](queries.md) pages go on
from there. [Your First App](first-app.md) takes this module on to a complete notes app with a policy, forms and tests.
