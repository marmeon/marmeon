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
pnpm add -D vite@^8 @marmeon/vite@<version of your app> @vitejs/plugin-react
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
- **Files Vite will not serve.** Beyond Vite's own list (`.env` files, keys and certificates, `.git`), the dev server refuses
  `storage/`, `dist/` and `.marmeon/` of the app root, and every database file (`*.sqlite`, `*.sqlite3`, `*.db`, `*.db3` and their `-wal`/`-shm` companions), with a 403, even to
  a client on the network. A page that loads a file from `storage/` through Vite stops working: serve it with a route. An entry
  of your own in `server.fs.deny` is added to the list. A symlink elsewhere in the app that points into `storage/` is still
  served, so do not create one. Tests and builds are unchanged.
- **Styles and the policy.** The stylesheets the client entry imports are linked in development with a `<link>` to the
  app's own origin that carries the response's CSP nonce; the `<style>` elements Vite adds later carry it too. A
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
after `index` has run: the page's chunk, the chunks it imports and the one for tab sync, as `<link rel="modulepreload">` tags, and the page's stylesheets as `<link rel="stylesheet">` tags.
The server reads them from `dist/client/.vite/manifest.json` when it starts. Without that file the documents preload nothing; a
file that is no Vite manifest stops the start. Nothing is preloaded in development, and the manifest is never served.

### The base

The server serves `dist/client` under `/`, so Vite's `base` is `/` (the default) or an absolute URL where you put the assets
yourself, such as `base: 'https://cdn.example/app/'`. With a URL, `index.html`, the preload tags and the page stylesheets all
start with it. The server reads it from the built `index.html`. A path such as `/static/` or a relative `./` fails
`marmeon build`, because the server would answer every asset with a 404; a build made earlier stops `marmeon start` with a message
that names the value. Every tag is `crossorigin`, so the CDN must answer scripts, stylesheets and fonts with `Access-Control-Allow-Origin`. Under the
default policy (`'nonce-…' 'strict-dynamic'`) the nonce admits the scripts and, with the [strict
recipe](styling.md#a-strict-policy-for-styles), the stylesheets; a policy without the nonce needs the origin in `script-src` and
`style-src`.

Every script, stylesheet and preload tag of `index.html` gets a nonce placeholder. The server puts each response's nonce in its
place, or removes the attribute when the response has no policy.

## Fonts

A web font starts to load only when the browser has parsed the stylesheet that names it, so text paints late or swaps. `fonts`
names the files the first screen sets, and `marmeon build` adds a `<link rel="preload" as="font" crossorigin>` for each to the
built `index.html`:

```ts title="vite.config.ts"
export default defineConfig({
  plugins: [
    marmeon({ fonts: [{ file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2' }] }),
    react(),
  ],
});
```

The stylesheet still declares the font, for example with `@import '@fontsource-variable/ibm-plex-sans/wght.css'`. `file` is the
path inside the package, and only `.woff2` is accepted: every browser that preloads fonts reads it, and a `.ttf` or `.woff` would
be a second download. The URL in the tag is the file's hashed one under `/assets/`, so it caches for good. The option never
becomes a URL by itself.

Name only what the first screen sets, since a preloaded file competes with the styles and scripts for the first bytes. A font
package ships many subsets and weights, and the manifest cannot tell which ones your pages use, so the plugin does not guess.
More than four files log a warning. A named font is never inlined into the stylesheet, whatever its size. A file that the build does not emit, because the name is wrong or no stylesheet loads it, stops
the build with its name. A `file` that is not a `.woff2` path of a package stops the config. Nothing is preloaded in development,
where the dev server loads the font with the stylesheet, and `test: true` checks the entries but adds no preload.

### A fallback with the same size

While the font loads, the browser sets the text in the next font of the stack, and when the font arrives the lines move,
because every font takes another width and height. With `family` and `fallback`, the plugin reads the font's own metrics
(`head`, `hhea` and `OS/2`, from the file; no extra package) and writes a fallback that takes the same room:

```ts title="vite.config.ts"
marmeon({
  fonts: [{ file: '@fontsource-variable/ibm-plex-sans/files/ibm-plex-sans-latin-wght-normal.woff2', family: 'IBM Plex Sans Variable', fallback: 'Arial' }],
});
```

The fallback is a font named `<family> Fallback`, made from the local font `fallback` with `size-adjust` and the three `*-override`
descriptors. Import the stylesheet from the client entry and put the fallback after the font in `font-family`:

```ts title="bootstrap/client.tsx"
import 'virtual:marmeon/fonts.css';
```

```css title="styles/app.css"
body { font-family: 'IBM Plex Sans Variable', 'IBM Plex Sans Variable Fallback', system-ui, sans-serif; }
```

`family` is the name the font's own `@font-face` gives it, with letters, digits, spaces and `-` only: it is written into CSS, so
anything else stops the config. `fallback` is one of `Arial`, `Helvetica`, `Times New Roman`, `Georgia` and `Courier New`; pick the
one that looks closest (sans-serif, serif or monospace). Both go together. The font may be `.woff2` only, as for the preload; a
file the plugin cannot read stops the build with its name. `Helvetica` exists only on Apple systems, and `Arial` or `Times New Roman` are often missing on Linux and Android; there the browser takes the next font of the stack, as it would without a fallback. The stylesheet is bundled with the app's own, so a strict `style-src`
needs nothing, and it works in development the same way. It exists once `fonts` has an entry.

## Virtual modules

The plugin serves four modules that your entries import:

| Module | What it exports | Used by |
| --- | --- | --- |
| `virtual:marmeon/pages` | Every page, each loaded on its own, keyed by its path | `resolveModulePages(pages)` |
| `virtual:marmeon/lang` | Every language file, each loaded on its own | `createMessageLoader(lang)` of `@marmeon/i18n/messages` |
| `virtual:marmeon/routes` | `routes`: the named routes the browser knows | `createMarmeonApp({ routes })`, `createSsrRenderer(…, { routes })` |
| `virtual:marmeon/fonts.css` | The stylesheet of the fallback fonts, once `fonts` has an entry | the client entry, `import 'virtual:marmeon/fonts.css'` ([fonts](#fonts)) |

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
| `fonts` | none | `.woff2` files to preload from `index.html`, as `{ file }`, and with `family` and `fallback` a fallback font of the same size. See [Fonts](#fonts). |
| `serverModules` | none | More server modules, as globs. `'!glob'` takes files out of the conventions. |
| `routeSinks` | none | More places where client code hands the framework a route name, for an adapter of your own. |
| `images` | `{ widths: [640, 960, 1280, 1920, 2560], formats: ['avif', 'webp'], quality: 70 }` | How `?image` imports are built. See [Images of the app](images.md#images-of-the-app). |
| `test` | `false` | For `vitest.config.ts`. |
| `viteEnv` | `false` | Keep Vite's own handling of `.env` files and `VITE_*` variables. See [Environment variables](#environment-variables). |

Pages are the `.tsx` files in `modules/<module>/views/`, and language files are the `.ts` files in `lang/` and `modules/<module>/lang/`. `marmeon()` takes no `pages` or `lang` option and throws a `TypeError` if you pass one.

## Environment variables

Vite normally reads the `.env` files of the app's folder and writes every `VITE_*` variable that client code reads through
`import.meta.env` into the public bundle, whatever its value. A misnamed variable, or a CI secret that happens to start with
`VITE_`, would reach every visitor without passing the [configuration](configuration.md#values-for-the-browser) checks.

`marmeon()` therefore reads no `.env` file and gives `import.meta.env` no variable prefix: `import.meta.env.VITE_*` is
`undefined`, in `marmeon dev` and in `marmeon build`. `import.meta.env.MODE`, `DEV`, `PROD`, `SSR` and `BASE_URL` stay. This holds in client and in server (SSR) code. To hand a value to
the browser, [share it as a prop](configuration.md#values-for-the-browser).

The plugin owns `envDir` and `envPrefix`: an app's own value, or a prefix another plugin adds, stops the start with an error that
names `viteEnv: true`.

An app that needs Vite's behaviour sets `marmeon({ viteEnv: true })` in `vite.config.ts`, and in `vitest.config.ts` if its tests
read the variables. Then every `VITE_*` variable of the process and of the `.env` files is public.

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
