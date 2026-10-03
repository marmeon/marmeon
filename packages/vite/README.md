# @bespokecore/vite

The Vite plugin of a BespokeCore app — UI-agnostic; the adapter's own plugin goes next to it:

```ts
export default defineConfig({ plugins: [bespoke(), react()] });          // vite.config.ts
export default defineConfig({ plugins: [bespoke({ test: true })] });     // vitest.config.ts
```

It resolves the framework's workspace sources while serving (never in a build), dedupes the adapter's peers, runs the
constructor-injection transform, adds the client entry to `index.html`, builds the SSR entry to `dist/server/ssr.js`, splits
the first page into `vendor` and `index`, serves `virtual:bespoke/pages`, `virtual:bespoke/lang` and `virtual:bespoke/routes`
(the browser's route manifest with only the names client code writes out, E57) — and keeps server code out of the browser.
This README covers the last; the rest follows with the docs app.

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

The lint preset (`bespoke make:lint-config`, `@bespokecore/cli`) flags the common case in the editor; this check is the one
that resolves imports and cannot be skipped.
