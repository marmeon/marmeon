# Pages & Components

## Introduction

A package can bring pages, components for the app's pages, and types that extend the app's own. This page covers how a package declares its interface in `package.json`, how an app uses a component of a package, how a package extends a type, and how you write an adapter for another UI library. The `"marmeon"` field is described in [Package Development: Getting Started](package-development.md#the-marmeon-field).

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

Every path is a subpath of `exports`, not a path in the package, so the conditions apply as they do for any import: a package in your
app's workspace can lead `@marmeon/source` to `src/views/*.tsx` while the published package leads to `dist/views/*.js`
([set up as described here](package-workspace.md#a-package-in-your-apps-workspace)).

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
