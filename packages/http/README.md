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
component name and props in text) visits, goes back and forward, loads deferred props, reloads partially, follows a
409 and renders islands and layers — with no UI framework anywhere.

### What the core provides

| Export | What it does |
| --- | --- |
| `Navigator` | Visits (`visit`, `reload`, `prefetch`), their events (`on('start' \| 'progress' \| 'success' \| 'error' \| 'exception' \| 'cancel' \| 'finish')` and per-visit `onX` callbacks, E44), the `x-bespoke` request headers (asset version, XSRF from the `XSRF-TOKEN` cookie, partial reloads), JSON or multipart bodies (upload progress via XHR), 409 + `x-bespoke-location` → full page load and every kept page dropped, history entries **without props** plus an in-memory page cache (E36, refetch on a miss), Back/Forward, bfcache, scroll restoration (window and `[scroll-region]`), deferred props loaded per group after every show, `merge`/`deepMerge`/`matchOn`, `async` and `preserveUrl` visits, prefetching (GET only, `Purpose: prefetch`, `cacheFor`) |
| `mergePage` | A partial reload's props merged into the page (what the navigator does) |
| `navigator.region(url, { owner, initial })` → `Region` | A region (E50) — an island (E48): the view of another route with its own region object (`RegionObject`: component, props, URL, query), loaded with `x-bespoke-region: island` (never following a redirect), `load()`/`reload({ query, only, except, reset })`, its deferred props, a `snapshot` (`loading \| ready \| unauthorized \| forbidden \| exception`, `pending`, `failure`) and `subscribe`. One per URL and owner (identical islands share one request); a newer request of a region aborts its older one. Its failures are its own — a redirect/401/403 is `unauthorized`/`forbidden`, never a page navigation (E52) — except a 409: the whole page loads again. Never prefetched |
| `regionInitial(result)` | What a region starts with when the server resolved it while rendering the page (E49): the `RegionResult` it streamed into the island's boundary (`<script type="application/json">`) → `navigator.region(url, { owner, initial })` — `ready` with its region object, `unauthorized`/`forbidden` (no data), `exception` (shown, not kept), or nothing (`browser`: the region loads itself). No request |
| `navigator.receiveStreamed(group, result \| null)` | A deferred group of the first page that the server streamed with the document (`PageObject.streamedProps`, E49): the navigator does not ask for it, lands it once the document has finished streaming (`DOMContentLoaded` — an update earlier would make React render a still-streaming island in the browser), and asks for it after all when it gets `null` |
| `RegionOwner` | Where regions keep what they loaded: the history entry of their page (`render` hands it over), in memory only — Back/Forward shows islands without a request, `history.state` never holds them (E36). Closed (requests aborted, nothing lands) when the entry leaves the screen or the document is left. Pluggable for layers |
| `navigator.layers` → `Layer[]` | Layers (E53) — a region with a history entry over the page: a page object whose `layer` (`{ key, base, once? }`) says so. `visit(url, { layer: true })` (header `x-bespoke-region: layer`) — and any visit answered with a layer — opens one over what is on screen (stacked, up to `MAX_LAYER_DEPTH`; beyond, it is shown as a page); a history entry of its own (`HistoryState.layer = { depth, below }`: keys only, E36). `layer.visit/reload/close/onClose`, `page` + `subscribe`, `owner` (its islands): an answer with the same key replaces it in place (validation errors), another key stacks, `LAYER_CLOSE_HEADER` (`closeLayer()`) closes it and reloads what stays (the page first). Back closes the top one from memory — the page is not rendered again, its deferred props and islands are not asked again; `close()` is Back when it was pushed over what is beneath (and forgets it: Forward asks the server), else the entry is replaced. A deep link's document brings `page.layers`. `once` layers (an action's answer) are forgotten when they leave the screen, and what stays reloads. Sign-out/409 drops them with the pages |
| `navigator.queryState(options)` → `QueryState` | Typed URL state (E55): `value(page)` is the page's query as the server parsed it (`PageObject.query` + `queryDefaults` — the browser never parses a URL) or what is being typed (`draft`); `set(patch \| fn)` changes it at once and visits the page's URL after `debounce` ms (partial with `only`, `reset` = `only` by default, `history: 'push' \| 'replace'`, state and scroll kept); the draft gives way when the page changes otherwise (Back/Forward, a link). `navigator.subscribe(listener)` follows the page on screen |
| `navigator.action(url, options)` → `ActionOutcome` | Actions (E59): requests that do not navigate — no history entry, nothing in the page cache, no progress bar, no events. `x-bespoke-action` + `Accept: application/json`, XSRF for writes, `redirect: 'manual'`, `cache: 'no-store'`; the server answers data (`this.json()`), 422 with field errors, or `204` + `x-bespoke-redirect` for a redirect (reported, not followed; `onRedirect: 'visit'` follows). Ends `data \| redirect \| invalid \| exception \| cancelled` — never rejects, never retries (401/419 after signing out are an `exception`). Calls run side by side; `key` makes a newer one cancel the older; `signal` aborts. A 409 + location (signed out through it) leaves the document |
| `navigator.optimistic(patch)`, `layer.optimistic`, `region.optimistic` → `OptimisticUpdate` | Model 1 (E59): a patch of the props of the page on screen (its history entry), a layer or a region — shown at once **over** the props in memory (`layer.view`, `region.snapshot.region`, the page handed to `render`), never written into them: the page cache and `history.state` never hold it. Rolled back when the action (or a form's visit: `visit({ optimistic })`) fails; a patch is a function of the props beneath it, so several on one list compose and a failure takes only its own out |
| `navigator.reloading(spec)`, `layer.reloading`, `region.reloading` → `Reloading` | What an action reloads once it succeeded (`only`/`except`/all), in the background: its patches on that target go in the same update the server's props land in; reloads of one target replace each other (an older answer never lands last); a patch on a target that does not reload becomes its state |
| `navigator.submissions` + `subscribeSubmissions` | Model 2 (E59): actions and route forms (`visit({ name })`) under way, with their input — ghost rows. Listed until their reloads have landed |
| `navigator.validate(url, request)`, `navigator.liveValidation(url, options)` → `LiveValidation` | Live validation (E62): the form's own request (method, URL, body, XSRF) plus `x-bespoke-validate: name,email` — the server runs middleware, `authorize` and the schema, never the controller, and answers `204` or `422` (both with `x-bespoke-validated`) with the named fields' errors; anything else is an `exception` (a redirect, 403, 419, 429). Password fields (`/password/i`) and files are never sent. `LiveValidation` per form: `changed(field)` (touched; `on: 'change'` or a field showing an error checks after `debounce`), `blurred(field)` (checks the touched fields when this one was touched), `validate()`, `validating(field)`/`pending` + `subscribe`, `cancel()` (on submit), `reset()`; a newer check aborts the older, a field typed over drops its stale result. The adapter keeps the errors (`onResult`) |
| `NavigatorOptions.revalidateOnBack(component)` | E58: what a view declares to reload when Back/Forward shows it from memory (`true` or prop names) — the page, a layer Forward opens again, an island of a restored entry (`RegionOwner({ onBack })`): shown at once, then reloaded in the background (no events, no progress bar). Never on a first load, a visit or a refetch |
| `owner.remembered` → `Remembered`, `rememberable(value, include)` | Remembered state (E63): per history entry (a page's owner, a layer's `layer.owner`), next to its islands in the page cache — **memory only**, never `history.state` or storage. Gone with the entry (evicted, a layer closed for good) and with the document (every 409, a reload). `rememberable` leaves out fields named like a password (always), a token, a secret or a card (`include` lets those in) and files, at any depth. No tab sync (E66) |
| once props (automatic) | E64: page objects with `onceProps` (+ `onceScope`) are kept by the navigator (`OnceStore`); every page request names what it holds (`x-bespoke-once`, `x-bespoke-once-scope`), the server skips those and the navigator puts them back before `render`. A page of another scope drops them; every 409 clears them |
| `visit(url, { instant: { component, props } })` | Instant visits (E64): `render(page, { placeholder: true })` with `{ component, props }` = the target view and what the link hands its placeholder — shown at once, the page when its answer lands; the history entry is pushed only then. Failed or cancelled: the page on screen again (scroll kept); Back during it cancels it; a page fetched ahead shows at once instead |
| `on('version', event)`, `newVersion` + `subscribeNewVersion`, `reloadForNewVersion()` | The asset-version 409 (E64, `x-bespoke-reload: version` — exactly that value): `event.preventDefault()` keeps the page (`newVersion` says where the full load waits; the user's next GET visit makes it); without it, unsaved changes nobody agreed to leave ask first (`event.unsaved`). Every other 409 (`history`: signing in or out, or no reason) is never cancelable and never asks |
| `formObject(entries)`, `defaultFormEntries(form)`, `formEntries(form)`, `restoreFormEntries(form, entries, names)`, `fieldPath(name)` | Uncontrolled forms (E64, `<Form>`): the data the server builds from a form's entries (bracket notation), where a form starts (its controls' defaults — "dirty"), its entries now, remembered entries put back, `links[0][url]` → `links.0.url` |
| `queryUrl`, `pageQuery`, `withoutDefaults`, `linkQuery`, `assertQueryPage` | Query helpers: a URL without the defaults, the page's query with them, a link's query for the page on screen, the "only on its route's page" check |
| `showProgress(navigator, options)` | The progress bar: plain DOM, inline CSS-variable styles (CSP-safe), not for `async` requests |
| `createPoll(run, interval, options)` | Polling, paused while the tab is hidden |
| `readInitialPage()`, `rootElement(id)`, `hasServerMarkup(root)` | The hydration entry's first steps: the page from `#bespoke-page`, the root (also while streaming), hydrate or render |
| `loadPageMessages(page, messages)`, `pageLocale(page, messages)` | The page's messages in its `locale`, falling back to the server's `fallbackLocale` (`APP_FALLBACK_LOCALE`, sent with every page) — any loader with `fallback` and `load(locale, { fallback })`, e.g. `createMessageLoader` of `@bespokecore/i18n/messages`. Load them before a page renders, in the browser and the SSR entry |
| `resolveRoute(manifest, name, params, query)` | A named route's URL and method from the manifest (`virtual:bespoke/routes`) |
| `visitUrlOf(click, href, target)`, `prefetchTriggers`, `prefetchUrlOf`, `HOVER_PREFETCH_DELAY` | Which link clicks become visits (plain left clicks, same origin, no other `target`) and when links prefetch |
| `firstErrors(page)` | The first validation message per field (forms) |
| `TitleRegistry`, `defaultTitle` | The document title from the mounted head components — the last one wins, none → `template('')` |
| `isDevelopment()` | `process.env.NODE_ENV !== 'production'`, as bundlers replace it |

### What an adapter provides

1. **Rendering a page object.** `new Navigator({ initialPage, render })`: `render(page, { preserveState, owner, layers })` resolves the
   page's component (and its messages), shows it with `page.props`, and **resolves once it is on screen** — the navigator
   restores the scroll position after that. `preserveState: true` keeps component state when the same component comes
   back (a form that failed validation); otherwise the page mounts fresh. A rejection makes the browser load the URL
   itself (a chunk gone after a deployment). Then `navigator.start()` (returns the stop function) and, if wanted,
   `showProgress(navigator)`. Failures (`exception`: offline, 5xx with the server's error page) are the adapter's to show;
   the page stays. `owner` is where the page's islands live: render them with `navigator.region(url, { owner })` (the
   first page: `navigator.regionOwner`), each into an element of its own, from its `snapshot` — its fallback while
   `loading`, an `unauthorized` UI, an error UI with a retry (`reload()`), and its view otherwise, inside an error boundary
   of its own. `layers` are the layers over the page (E53), bottom first: render each in a frame over it (a modal `<dialog>`:
   focus kept inside and returned to the opener, Escape and the backdrop `layer.close()`, the page beneath inert and not
   scrolling), with its own page context so visits and forms inside go through `layer.visit()`; when only they changed,
   `page` is the page on screen (with `preserveState`) and must not render again.
   Actions (E59): render `layer.view` (not `layer.page`) and a region's `snapshot.region` — they carry the optimistic patches —
   and pass `revalidateOnBack` to the navigator (the adapter knows the views: React reads `View.revalidateOnBack`).
   Instant visits (E64): `render(page, { placeholder: true })` shows the placeholder of `page.component`'s view (React:
   `View.placeholder`) with `page.props` inside that view's layouts — never the view itself, and the page context stays the page
   on screen; no placeholder → nothing changes; one that resolves after a later render started is dropped. Remembered state
   (E63): keep it in the `owner` of the level it renders in (`owner.remembered`, a layer's `layer.owner.remembered`), keyed by
   the app (an island's apart). Forms without JavaScript (E64): `page.csrf` as `_token`, `_method` for PUT/PATCH/DELETE (the
   kernel spoofs the method from a POST body, never from the query).
2. **Persistent layouts** (E35): `Page.layout = Layout | [Outer, Inner] | null`, a default per app; the same layout at the
   same depth stays mounted across visits. Error boundaries inside them (a page that throws shows the error page).
3. **Head management**: a head component that sets the title through a `TitleRegistry` and adds/removes its tags in the
   browser; on the server it records title and tags so the SSR entry returns them as `head`.
4. **The SSR renderer**: the app's `bootstrap/ssr.tsx` exports `render: SsrRender` (from `@bespokecore/http/page`):
   `(page, { complete, onError, onWarning, signal, resolveIsland, resolveDeferred }) => Promise<{ html: string | ReadableStream<Uint8Array>; head?: string; streamedProps?: string[] }>`.
   It gets the page as the browser does (JSON values only), resolves with the shell (or, with `complete`, the whole page —
   bots), returns `html: ''` for pages that do not render on the server (`Page.ssr = false`), and **rejects** when the
   shell cannot render — the server then sends the document without markup and the browser renders the page. The server
   puts `head` into `<!--app-head-->`, `html` into `<!--app-html-->` and the page object into `<script id="bespoke-page">`.
   **Islands and deferred props in the stream (E49)** — both callbacks are per request, the server stays UI-agnostic:
   - `resolveIsland(url)` → `RegionResult`: the server runs the island's route in-process (its own middleware and
     authorization, read-only, the page request's session as a copy). Render each eager island behind a Suspense boundary
     that waits for it (the shell never does), with its view and — in the same boundary — a data block
     `<script type="application/json" id="…">` holding the result (`scriptJson`: `<` escaped; inert, so no CSP nonce),
     ids stable across server and browser. `complete` waits for every island (bots get their markup). `load="visible"`
     islands are not resolved on the server.
   - `resolveDeferred(group)` → the group's props (or `null`: not streamed): computed in the page's scope once the
     response headers are out (read-only then). Render one boundary per group with its data block — **inside a host
     element**: a boundary at the top of the tree may still bring `<html>`/`<head>` (React's preamble), and React would
     hold the whole shell back — and return the groups as `streamedProps` (the server writes them into the page object).
     Not when rendering `complete` (the groups are computed after the headers).
   - In the browser, hydrating: read each data block once and render it again unchanged; islands start from it
     (`regionInitial`), groups go to `navigator.receiveStreamed`. A boundary the adapter ends up rendering in the browser
     (an error, or an update of the page while it was still streaming) finds no data block: the island or group loads as
     on a client-side visit. Keep an island's boundary element stable until it hydrated, so a re-render of the page does
     not cause that.
5. **The hydration entry**: the app's `bootstrap/client.tsx` (injected into `index.html` by `bespoke()`): `readInitialPage()`,
   resolve the component and the messages of the page's locale **before** hydrating (so the markup matches), then hydrate
   `rootElement('app')` when `hasServerMarkup(root)`, else render into it.
6. **Hooks/components on top of the navigator**, in the framework's idiom: the current page and shared props, a router
   (`visit`/`reload`/`prefetch`/`on`), `<Link>` (with `visitUrlOf` and the prefetch triggers), forms (`visit` with
   `method` + `data`, `firstErrors`), route URLs (`resolveRoute`), deferred props, polling, translations, query state
   (`navigator.queryState`, rendering `value(page)` — on the server from the page object alone; links to the page on
   screen leave its defaults out, `linkQuery`).
7. **Its route sinks** (E57): every place where app code hands the adapter a route name (`<Link route>`, the function of
   `useRoute()`, `useForm(name, …)`, `useQueryState(name, …)`, `<Island route>`) is a row in `ROUTE_SINKS` of `@bespokecore/vite` (or `bespoke({ routeSinks })`).
   The client build ships only the names written out at a sink; a name built at runtime fails the build. Route names
   never come from props — the server sends URLs (`router.url()`).

Pages come from `virtual:bespoke/pages` (`bespoke({ pages })` in `@bespokecore/vite`, default `modules/*/views/**/*.tsx`),
language files from `virtual:bespoke/lang` and the route manifest from `virtual:bespoke/routes`; the adapter brings its framework's Vite plugin
(`plugins: [bespoke(), react()]`).
