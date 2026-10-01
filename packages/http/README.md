# @bespokecore/http

HTTP for BespokeCore apps: controllers, views and page props (`view()`, `optional()`, `defer()`, `merge()` …), redirects,
signed URLs, encrypted cookies and the client history (`ClientHistory`). Three entry points:

| Import | Runs in | What |
| --- | --- | --- |
| `@bespokecore/http` | server | everything above; the provider is found by `bespoke discover` |
| `@bespokecore/http/page` | server **and** browser | the page contract: `PageObject`, the protocol headers, `SsrRender`, `Views`/`Routes` types |
| `@bespokecore/http/client` | browser (and the SSR entry) | the UI-free client core every UI adapter builds on (E39) |

`page` and `client` never import server code: a test bundles both for the browser and fails on any module outside
`src/client/`, `src/page.ts` and the router's URL builder, and on any Node built-in or npm package
(`src/client/browser-safe.test.ts`). The package compiles with the DOM library for `client/`; server code must not use it.

## The client core and the adapter contract

A UI adapter (`@bespokecore/react` today, a Vue adapter later) is a **rendering layer**. Everything else — the protocol,
the history, caching, background requests — is in `@bespokecore/http/client`, uses DOM APIs where it must, and knows no
UI framework. `src/client/adapter.test.ts` is the proof: a complete adapter in plain DOM (it renders a page as its
component name and props in text) visits, goes back and forward, loads deferred props, reloads partially and follows a
409 — with no UI framework anywhere.

### What the core provides

| Export | What it does |
| --- | --- |
| `Navigator` | Visits (`visit`, `reload`, `prefetch`), their events (`on('start' \| 'progress' \| 'success' \| 'error' \| 'exception' \| 'cancel' \| 'finish')` and per-visit `onX` callbacks, E44), the `x-bespoke` request headers (asset version, XSRF from the `XSRF-TOKEN` cookie, partial reloads), JSON or multipart bodies (upload progress via XHR), 409 + `x-bespoke-location` → full page load and every kept page dropped, history entries **without props** plus an in-memory page cache (E36, refetch on a miss), Back/Forward, bfcache, scroll restoration (window and `[scroll-region]`), deferred props loaded per group after every show, `merge`/`deepMerge`/`matchOn`, `async` and `preserveUrl` visits, prefetching (GET only, `Purpose: prefetch`, `cacheFor`) |
| `mergePage` | A partial reload's props merged into the page (what the navigator does) |
| `showProgress(navigator, options)` | The progress bar: plain DOM, inline CSS-variable styles (CSP-safe), not for `async` requests |
| `createPoll(run, interval, options)` | Polling, paused while the tab is hidden |
| `readInitialPage()`, `rootElement(id)`, `hasServerMarkup(root)` | The hydration entry's first steps: the page from `#bespoke-page`, the root (also while streaming), hydrate or render |
| `loadPageMessages(page, messages)`, `pageLocale(page, messages)` | The page's messages in its locale (any loader with `fallback` and `load(locale)`, e.g. `createMessageLoader` of `@bespokecore/i18n/messages`) — load them before a page renders, in the browser and the SSR entry |
| `resolveRoute(manifest, name, params, query)` | A named route's URL and method from `bootstrap/routes.ts` |
| `visitUrlOf(click, href, target)`, `prefetchTriggers`, `prefetchUrlOf`, `HOVER_PREFETCH_DELAY` | Which link clicks become visits (plain left clicks, same origin, no other `target`) and when links prefetch |
| `firstErrors(page)` | The first validation message per field (forms) |
| `TitleRegistry`, `defaultTitle` | The document title from the mounted head components — the last one wins, none → `template('')` |
| `isDevelopment()` | `process.env.NODE_ENV !== 'production'`, as bundlers replace it |

### What an adapter provides

1. **Rendering a page object.** `new Navigator({ initialPage, render })`: `render(page, { preserveState })` resolves the
   page's component (and its messages), shows it with `page.props`, and **resolves once it is on screen** — the navigator
   restores the scroll position after that. `preserveState: true` keeps component state when the same component comes
   back (a form that failed validation); otherwise the page mounts fresh. A rejection makes the browser load the URL
   itself (a chunk gone after a deployment). Then `navigator.start()` (returns the stop function) and, if wanted,
   `showProgress(navigator)`. Failures (`exception`: offline, 5xx with the server's error page) are the adapter's to show;
   the page stays.
2. **Persistent layouts** (E35): `Page.layout = Layout | [Outer, Inner] | null`, a default per app; the same layout at the
   same depth stays mounted across visits. Error boundaries inside them (a page that throws shows the error page).
3. **Head management**: a head component that sets the title through a `TitleRegistry` and adds/removes its tags in the
   browser; on the server it records title and tags so the SSR entry returns them as `head`.
4. **The SSR renderer**: the app's `bootstrap/ssr.tsx` exports `render: SsrRender` (from `@bespokecore/http/page`):
   `(page, { complete, onError, onWarning, signal }) => Promise<{ html: string | ReadableStream<Uint8Array>; head?: string }>`.
   It gets the page as the browser does (JSON values only), resolves with the shell (or, with `complete`, the whole page —
   bots), returns `html: ''` for pages that do not render on the server (`Page.ssr = false`), and **rejects** when the
   shell cannot render — the server then sends the document without markup and the browser renders the page. The server
   puts `head` into `<!--app-head-->`, `html` into `<!--app-html-->` and the page object into `<script id="bespoke-page">`.
5. **The hydration entry**: the app's `bootstrap/client.tsx` (injected into `index.html` by `bespoke()`): `readInitialPage()`,
   resolve the component and the messages of the page's locale **before** hydrating (so the markup matches), then hydrate
   `rootElement('app')` when `hasServerMarkup(root)`, else render into it.
6. **Hooks/components on top of the navigator**, in the framework's idiom: the current page and shared props, a router
   (`visit`/`reload`/`prefetch`/`on`), `<Link>` (with `visitUrlOf` and the prefetch triggers), forms (`visit` with
   `method` + `data`, `firstErrors`), route URLs (`resolveRoute`), deferred props, polling, translations.

Pages come from `virtual:bespoke/pages` (`bespoke({ pages })` in `@bespokecore/vite`, default `modules/*/views/**/*.tsx`)
and language files from `virtual:bespoke/lang`; the adapter brings its framework's Vite plugin
(`plugins: [bespoke(), react()]`).
