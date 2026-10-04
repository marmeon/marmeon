# @bespokecore/vite

The Vite plugin of a BespokeCore app — UI-agnostic; the adapter's own plugin goes next to it. A dev dependency of the app
(`pnpm add -D vite @bespokecore/vite`), used by `bespoke dev`, `bespoke build` and the tests; it has no provider and nothing
of it runs on a production server.

```ts
export default defineConfig({ plugins: [bespoke(), react()] });          // vite.config.ts
export default defineConfig({ plugins: [bespoke({ test: true })] });     // vitest.config.ts
```

What `bespoke()` does:

- **resolution:** the framework's workspace sources while serving (the `@bespokecore/source` condition — dev server and tests,
  never a build); the non-optional peers of the app's framework packages deduped (one React for the adapter and the app);
- **constructor injection:** the transform of `@bespokecore/core/vite` for code Vite loads — SSR and tests
  ([Constructor injection](../core/README.md#constructor-injection));
- **entries:** adds the client entry to `index.html` (`async` in a build: a streamed page hydrates its shell while the rest
  arrives), builds the client to `dist/client` and the SSR entry to `dist/server/ssr.js`;
- **chunks:** splits the first page's download into `vendor` (third-party packages) and `index` (the framework, the app's entry
  and layouts) — `CLIENT_CHUNKS`; what loads on first use stays in its own chunks (the size budget:
  [@bespokecore/react](../react/README.md#the-size-budget-e75));
- **virtual modules** (below) and the browser's **route manifest** (E57);
- keeps **server code out of the browser** (E121, below).

## Options

| Option | Default | What |
| --- | --- | --- |
| `entries` | `{ client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' }` | the entries, relative to the app root |
| `pages` | `'modules/*/views/**/*.tsx'` | the page components (`virtual:bespoke/pages`) |
| `lang` | `['modules/*/lang/*.ts', 'lang/*.ts']` | the language files (`virtual:bespoke/lang`) |
| `routeSinks` | — | more places where client code hands a route name to the framework, besides `ROUTE_SINKS` |
| `serverModules` | — | more server modules (globs), `'!glob'` takes some out of the conventions ([below](#server-code-in-the-browser-e121)) |
| `test` | `false` | for `vitest.config.ts`: conditions, injection, virtual modules and the server-import check only — no entries, no HTML, no build settings |

## Virtual modules

Types: add `"@bespokecore/vite/client"` to `compilerOptions.types` in the app's `tsconfig.json`.

| Module | Default export / exports | Used by |
| --- | --- | --- |
| `virtual:bespoke/pages` | every page, lazily (`import.meta.glob`), keyed by its path from the root (`/modules/user-profile/views/Show.tsx`) — one chunk per page | `resolveModulePages(pages)` ([@bespokecore/react](../react/README.md)) |
| `virtual:bespoke/lang` | every language file, lazily — one chunk per file, so the browser loads only the page's locale | `createMessageLoader(lang)` ([@bespokecore/i18n](../i18n/README.md)) |
| `virtual:bespoke/routes` | `routes`: the named routes the browser knows (`{ method, path }` by name) | `createBespokeApp({ routes })`, `createSsrRenderer(…, { routes })` |

```ts
// bootstrap/pages.ts, bootstrap/client.tsx (apps/web-app)
import pages from 'virtual:bespoke/pages';
import { routes } from 'virtual:bespoke/routes';
export const resolvePage = resolveModulePages(pages);
void createBespokeApp({ resolve: resolvePage, title, routes, layout, layer, messages, progress: progressBar({ delay: 250 }),
  confirm: Confirm });
```

## The route manifest (E57)

`virtual:bespoke/routes` comes from `.bespoke/routes.json`, which `bespoke route:types` writes (`bespoke dev` and
`bespoke build` run it). Which routes the browser may learn at all is the app's choice (`clientRoutes`,
[@bespokecore/router](../router/README.md#configuration): the `web` routes by default; API routes, `.internal()`
routes and `clientRoutes.except` never). Of those:

- **a client build** ships only the names client code writes out at a **sink** — `<Link route>`, `<Island route>`,
  `<Form route>`, the function `useRoute()` returns, `useForm(name, …)`, `useAction(name)`, `usePending(name)`,
  `useQueryState(name, …)` (`ROUTE_SINKS`). A route only the server links to (`redirect().route()`) never reaches the bundle.
  A name the build cannot see (built at runtime, passed in from elsewhere) fails the build, with "did you mean";
- **the SSR build and the dev server** know every route the browser may learn; the same collector runs while serving, so a
  name built at runtime is an error there too, and one the collector never saw warns that production lacks it.

Another adapter brings its own sinks (`bespoke({ routeSinks })`), keyed by the package that exports them — rows like the React
adapter's:

```ts
{ module: '@bespokecore/react', export: 'Link', kind: 'element', prop: 'route' }                  // <Link route="…">
{ module: '@bespokecore/react', export: 'useForm', kind: 'call', argument: 0, minArguments: 2 }   // useForm('…', initial)
{ module: '@bespokecore/react', export: 'useRoute', kind: 'route-function' }                      // useRoute()('…')
```

`kind` is `element` (a JSX attribute: `prop`), `call` (an argument of a function: `argument`, `minArguments`) or
`route-function` (the function a hook returns, called with the name first).

## Server code in the browser (E121)

Client code — the pages (`modules/*/views/**`), the layouts and the client entry, and every module they import — never
imports a server module **as a value**. A value import bundles the module, and everything it imports, into the browser:

```tsx
// modules/auth/views/Login.tsx
import { ShowLoginController } from '../controllers/ShowLoginController.ts';        // ✗ ships the controller
import type { ShowLoginController } from '../controllers/ShowLoginController.ts';   // ✓ erased — the view needs the type only
type Props = PageProps<ShowLoginController>;
```

A class is a value even where only its type is used: with `verbatimModuleSyntax` the first line stays in the output (so does
`import { type ShowLoginController }`, as `import {} from …`). The plugin makes it an error:

- **dev server** — Vite's overlay, when the browser loads the module (and already when the page renders on the server);
- **`bespoke build`** — the build stops, with the message and no stack:

```text
✗ [bespoke] modules/auth/views/Login.tsx:3:1 — imports modules/auth/controllers/ShowLoginController.ts as a value: a controller
  is server code, and a value import bundles it — with everything it imports — into the browser. A class is a value even where
  only its type is used: write import type { ShowLoginController } from '../controllers/ShowLoginController.ts'. If the
  browser needs a value from it, move that value into a module both sides import.
✗ Not built: 1 import brings server code into the browser.
```

- **tests** — the server renderer of `createTestApp(app, { ssr: true })` (the app's Vite config) and Vitest with
  `bespoke({ test: true })` check pages, layouts and the client entry too.

**Indirect imports count.** A page imports `helpers.ts`, which imports a controller: the error names the helper's line and
the way there — `modules/auth/helpers.ts:1:1 — imports modules/auth/controllers/ShowLoginController.ts as a value
(modules/auth/helpers.ts is client code: modules/auth/views/Login.tsx → modules/auth/helpers.ts) …`.

**What is a server module** — by convention, globs relative to the app root (`SERVER_MODULES`):

| Pattern | What |
|---|---|
| `modules/*/controllers/**` | controllers |
| `modules/*/{listeners,jobs,mail,notifications,policies,middleware,tasks,health,commands,migrations,seeders,factories}/**` | each its kind |
| `modules/*/index.ts`, `routes.ts`, `api-routes.ts`, `schedule.ts`, `config.ts` | a module's definition, routes, schedule, config |
| `**/*ServiceProvider.ts`, `**/*Repository.ts` | providers, repositories |
| `bootstrap/app.ts`, `config/**`, `middleware/**` | the app's definition, config, middleware |

Views, layouts, language files and anything else (`modules/auth/abilities.ts`, a `shared.ts`) are not server modules — they
are client code as soon as a page imports them, and the check follows them. More or fewer:

```ts
bespoke({ serverModules: ['modules/*/services/**', '!modules/shop/jobs/labels.ts'] })
```

**What counts as a value import:** `import … from`, `import './x'`, `import { type X } from` (see above), `export … from`,
`export * from`, and `import('…')` with a literal. Not: `import type`, `export type … from`, `export type * from`, a
`typeof import('…')` type. Only imports that can name one of the app's files are resolved (relative, `/…`, `#…` subpath
imports such as `#modules/auth`, Vite aliases) — packages are not app modules.

**SSR may import server code.** The SSR build is not checked (its entry renders with whatever the server has); the client
build has checked everything that reaches the browser. While serving, the SSR environment checks only pages, layouts and the
client entry and what they import — a server module that imports a helper is fine, the same helper imported by a page is not
(also when the helper was loaded as server code first).

**Only at build time:** the check reads the source in `transform` and returns nothing — no code reaches a chunk (the size
budgets and the leak test are unchanged). It costs one parse and the resolution of the relative imports per module.

**Before this check** (W7 step 6), a value import of a controller failed the client build only by accident: 144 warnings
`Module "node:…" has been externalized for browser compatibility`, then `Rolldown failed to resolve import
"@oxc-parser/binding-wasm32-wasip1"` — `@bespokecore/core`'s injection analyzer pulls in oxc-parser, whose WebAssembly fallback
cannot be resolved for the browser. The view was named nowhere. A server module that did not reach `@bespokecore/core` built
green and shipped its code. The dev server showed the same unrelated error in the overlay and the page did not hydrate; the
SSR build bundled a second copy of what the imported module ran at load (`defineConfig('app', …)` with its own key).

The [lint preset](../cli/README.md#lint) (`bespoke make:lint-config`) flags the common case in the editor; this check is the one
that resolves imports and cannot be skipped.
