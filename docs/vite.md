# Asset Bundling (Vite)

## Introduction

A Marmeon app builds its browser code and its server rendering with Vite. The `marmeon()` plugin of `@marmeon/vite` sets Vite up for
the app, and React's plugin goes next to it:

```ts title="vite.config.ts"
import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({ plugins: [marmeon(), react()] });
```

The plugin adds the client entry to `index.html`, builds the browser's files and the server rendering, serves the app's pages, its
language files and its route manifest as virtual modules, and refuses server code in the browser. A new app comes with this file.
`marmeon dev` and `marmeon build` run Vite for you, so you rarely start it yourself.

## Installation

Vite and the plugin are development dependencies. Nothing of them runs on a production server:

```sh
pnpm add -D vite@^8 @marmeon/vite @vitejs/plugin-react
```

Vite is a peer of the plugin, so the plugin runs inside your app's own Vite. The types of the virtual modules come from
`@marmeon/vite/client` in `compilerOptions.types` of `tsconfig.json`, which a new app lists. The plugin also makes the app and the
framework share one copy of React, which hooks need.

## The entries

The plugin looks for two entries:

| Entry | Default | What it does |
| --- | --- | --- |
| Client | `bootstrap/client.tsx` | Starts the app in the browser. The plugin adds it to `index.html`. |
| Server | `bootstrap/ssr.tsx` | Exports `render`, which the server calls for every page. |

`index.html` is the document every page renders into. The server puts the page's head where `<!--app-head-->` stands and its
markup where `<!--app-html-->` stands. Keep both comments, and keep the element with the id `app` around the markup. The
[pages](pages.md#the-entries) page shows what the entries contain.

## The dev server

`marmeon dev` runs Vite inside the app's server, on the app's port. An edited page or layout updates in the browser without a
reload, and the server renders the edited page on the next request without a restart. A change to server code restarts the server.

Before you change `server` in `vite.config.ts`, know what the app relies on:

- **Host names.** Vite answers only the host names it allows, and refuses others with a 403, which protects against DNS rebinding.
  `localhost` and IP addresses are allowed. When `APP_URL` uses another name, such as `http://notes.test`, add it:
  `server: { allowedHosts: ['notes.test'] }`. `allowedHosts: true` turns the check off, and so does `server.https`. Use either
  only on a network you trust, because then any page the browser visits can reach the dev server under a name of its own. The
  framework's own development routes keep their own check either way.
- **Other origins.** The server answers no other origin, so a page on another site cannot read the app's development answers.
- **Styles and the policy.** The `<style>` elements Vite adds in development carry the response's CSP nonce. A
  Content-Security-Policy with `styleSrc: ["'self'", NONCE]` therefore holds in development too. The
  [styling](styling.md#a-strict-policy-for-styles) page explains the policy.

## Building

`marmeon build` runs the type check and both Vite builds, among other steps that the
[deployment](deployment.md#building-and-starting) page lists. Vite writes the browser's files to `dist/client/` and the server
rendering to `dist/server/ssr.js`.

The first page loads two scripts: `vendor`, with the npm packages such as React, and `index`, with the framework, your entry and
your layouts. `vendor` stays cached across your own deployments, as long as the packages do not change. Pages, dialogs and features
that load on first use stay in chunks of their own. The client entry starts as soon as it has arrived, so a streamed page hydrates
its first part while slower parts still arrive.

In production, each document also names the scripts its page needs, so the browser fetches them with the document instead of
after `index` has run: the page's chunk, the chunks it imports and the one for tab sync, as `<link rel="modulepreload">` tags.
The server reads them from `dist/client/.vite/manifest.json` when it starts. Without that file the documents preload nothing; a
file that is no Vite manifest stops the start. Nothing is preloaded in development, and the manifest is never served.

Every script, stylesheet and preload tag of `index.html` gets a nonce placeholder. The server puts each response's nonce in its
place, or removes the attribute when the response has no policy.

## Virtual modules

The plugin serves three modules that your entries import:

| Module | What it exports | Used by |
| --- | --- | --- |
| `virtual:marmeon/pages` | Every page, each loaded on its own, keyed by its path | `resolveModulePages(pages)` |
| `virtual:marmeon/lang` | Every language file, each loaded on its own | `createMessageLoader(lang)` of `@marmeon/i18n/messages` |
| `virtual:marmeon/routes` | `routes`: the named routes the browser knows | `createMarmeonApp({ routes })`, `createSsrRenderer(…, { routes })` |

```ts title="bootstrap/pages.ts"
import { resolveModulePages } from '@marmeon/react';
import pages from 'virtual:marmeon/pages';

export const resolvePage = resolveModulePages(pages);
```

Vite keeps them current when you add or remove a page or a language file. The browser loads only the language files of the page's
locale. The route manifest holds only the routes your client code names. The [URL
generation](urls.md#which-routes-the-browser-knows) page explains which those are.

## Options

`marmeon()` works without options. These change its conventions:

| Option | Default | Effect |
| --- | --- | --- |
| `entries` | `{ client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' }` | Where the entries are, relative to the app root. |
| `pages` | `'modules/*/views/**/*.tsx'` | Which files are pages. Only files in `modules/<module>/views/` at the app root get a page name; any other file the glob matches is ignored. |
| `lang` | `['modules/*/lang/*.ts', 'lang/*.ts']` | Which files are language files. |
| `serverModules` | none | More server modules, as globs. `'!glob'` takes files out of the conventions. |
| `routeSinks` | none | More places where client code hands the framework a route name, for an adapter of your own. |
| `test` | `false` | For `vitest.config.ts`. |

## Server code in the browser

A page, a layout, the client entry and every module they import run in the browser. None of them may import a server module as a
value, because a value import bundles the module, and everything it imports, into the browser:

```tsx
import { ShowNoteController } from '../controllers/ShowNoteController.ts';        // refused: ships the controller
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';   // erased: the view needs the type only
```

A class is a value even where only its type is used. `import { type ShowNoteController }` is not enough either, because the
compiler keeps it as an empty import that still loads the module. The plugin refuses such an import in Vite's overlay while you
develop, and the build stops with the file, the line and the fix:

```text
✗ [marmeon] modules/notes/views/Show.tsx:3:1 — imports modules/notes/controllers/ShowNoteController.ts as a value: a controller is server code, and a value import bundles it — with everything it imports — into the browser. A class is a value even where only its type is used: write import type { ShowNoteController } from '../controllers/ShowNoteController.ts'. If the browser needs a value from it, move that value into a module both sides import.
✗ Not built: 1 import brings server code into the browser.
```

An indirect import counts too. When a page imports a helper that imports a controller, the error names the helper's line and the
way from the page to it. Tests check the same: server rendering in tests and Vitest with `marmeon({ test: true })`.

These files are server modules by convention:

| Pattern | What |
| --- | --- |
| `modules/*/controllers/**` | Controllers |
| `modules/*/listeners/**`, `jobs/**`, `mail/**`, `notifications/**`, `policies/**`, `middleware/**`, `tasks/**`, `health/**`, `commands/**`, `migrations/**`, `seeders/**`, `factories/**` | Each of its kind, inside a module |
| `modules/*/index.ts`, `routes.ts`, `api-routes.ts`, `schedule.ts`, `config.ts` | A module's definition, routes, schedule and configuration |
| `**/*ServiceProvider.ts`, `**/*Repository.ts` | Service providers and repositories |
| `bootstrap/app.ts`, `config/**`, `middleware/**` | The app's definition, its configuration and its middleware |

Anything else becomes client code as soon as a page imports it: views, layouts, language files, a `shared.ts`. When the browser
needs a value from a server module, move the value into a module both sides import. `serverModules` adds patterns of your own:

```ts title="vite.config.ts"
import { marmeon } from '@marmeon/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [marmeon({ serverModules: ['modules/*/services/**', '!modules/notes/jobs/labels.ts'] }), react()],
});
```

The check reads the source while building and adds no code to any chunk. The lint preset, which `marmeon make:lint-config`
writes, flags the common case in the editor already. The [console](console.md#lint) page lists the command.

## Tests

`vitest.config.ts` uses the plugin with `test: true`:

```ts title="vitest.config.ts"
import { marmeon } from '@marmeon/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [marmeon({ test: true })],
  test: { include: ['modules/**/*.test.ts'] },
});
```

In this mode the plugin sets up module resolution, the container's injection, the virtual modules and the server-import check,
and nothing for the browser: no entries, no HTML, no nonce and no build settings.

## When the plugin is missing

The server reads the entries from the plugin. A `vite.config.ts` without `marmeon()` stops `marmeon dev` and `marmeon build`:

```text
vite.config.ts does not use the marmeon() plugin, which tells the server where the app's entries are:
  import { marmeon } from '@marmeon/vite';
  export default defineConfig({ plugins: [marmeon(), react()] });
```
