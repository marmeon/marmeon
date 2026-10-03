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
409 — and drives everything Wave 5b added: islands (loaded by the client, and hydrated from the SSR stream's data block
without a request), layers (Back closes, Forward opens from memory), an action with an optimistic patch and its rollback,
a flash message fired once, the navigation guard (a visit and a Back held), live validation, an instant visit's
placeholder, remembered state and a postponed new build — with no UI framework anywhere. What a Vue adapter adds is
components and composables; the mechanics are here.

### What the core provides

| Export | What it does |
| --- | --- |
| `Navigator` | Visits (`visit`, `reload`), their events (`on('start' \| 'progress' \| 'success' \| 'error' \| 'exception' \| 'cancel' \| 'finish')` and per-visit `onX` callbacks, E44), the `x-bespoke` request headers (asset version, XSRF from the `XSRF-TOKEN` cookie, partial reloads), JSON or multipart bodies (upload progress via XHR — its code loads with the first such upload), 409 + `x-bespoke-location` → full page load and every kept page dropped, history entries **without props** plus an in-memory page cache (E36, refetch on a miss), Back/Forward, bfcache, scroll restoration (window and `[scroll-region]`), deferred props loaded per group after every show, `merge`/`deepMerge`/`matchOn`, `async` and `preserveUrl` visits |
| `mergePage` | A partial reload's props merged into the page (what the navigator does) |
| `navigator.use(feature)`, `defineFeature(name, setup, order?)`, `slot(name, create, clear?)`, `FeatureHost` | The feature host (Wave 5c, E70/E73): a feature's `setup(host)` runs once per navigator — the first `use` — and returns what adapters use of it (React: `useFeature(feature)`). It hooks into the pipeline (`host.on('visit' \| 'start' \| 'response' \| 'place' \| 'paint' \| 'popState' \| …)`, in the features' `order` — whenever each was attached — then attach order; the first result wins; events all run) and keeps what came from the server or the user **only in slots**: `host.entry(slot, key)` per history entry, `host.document(slot)` per document. The core empties them itself — an entry's when memory lets go of it (LRU eviction, another page replacing it, a layer forgotten), all of them when the document is left (every 409) — so a feature cannot leak data past a sign-out by forgetting to clear it (`security-matrix.test.ts` checks every feature × every such event). `history.state` is written only by `host.history`, which refuses anything but positions (`component`, `url`, `key`, `index`, `scroll`, `scrollRegions` and fields a feature registers with `host.history.field(name, check)`, e.g. a layer's depth and keys): it throws in development and leaves the field out in production (E36). Since Wave 5c no feature is attached by default (`NavigatorOptions.features`): each is attached where it is used (`navigator.use`), or loads on first use (`navigator.load(loader)`, E74: live validation, prefetching, instant visits) — and the core loads the layers itself when the server answers with one (E71, below) |
| `navigator.use(islands).region(url, { owner, initial })` → `Region` | A region (E50) — an island (E48), a feature attached where an island renders (React: `<Island>`): the view of another route with its own region object (`RegionObject`: component, props, URL, query), loaded with `x-bespoke-region: island` (never following a redirect), `load()`/`reload({ query, only, except, reset })`, its deferred props, a `snapshot` (`loading \| ready \| unauthorized \| forbidden \| exception`, `pending`, `failure`) and `subscribe`. One per URL and owner (identical islands share one request); a newer request of a region aborts its older one. Its failures are its own — a redirect/401/403 is `unauthorized`/`forbidden`, never a page navigation (E52) — except a 409: the whole page loads again. Never prefetched |
| `regionInitial(result)` | What a region starts with when the server resolved it while rendering the page (E49): the `RegionResult` it streamed into the island's boundary (`<script type="application/json">`) → `navigator.use(islands).region(url, { owner, initial })` — `ready` with its region object, `unauthorized`/`forbidden` (no data), `exception` (shown, not kept), or nothing (`browser`: the region loads itself). No request |
| `navigator.receiveStreamed(group, result \| null)` | A deferred group of the first page that the server streamed with the document (`PageObject.streamedProps`, E49): the navigator does not ask for it, lands it once the document has finished streaming (`DOMContentLoaded` — an update earlier would make React render a still-streaming island in the browser), and asks for it after all when it gets `null` |
| `RegionOwner` | The core's owner of an entry on screen (`render` hands it over, `navigator.regionOwner` for the first page; a layer has its own): its `entry` key (what the entry's components keep: islands in the slot `REGIONS`, remembered state), `back` (shown by Back/Forward: what views declare reloads, E58), the islands on screen (`live`). In memory only — Back/Forward shows islands without a request, `history.state` never holds them (E36). Closed (requests aborted, nothing lands, `live` emptied) when the entry leaves the screen or the document is left |
| `navigator.layers` → `Layer[]` | Layers (E53) — a region with a history entry over the page: a page object whose `layer` (`{ key, base, once? }`) says so. `visit(url, { layer: true })` (header `x-bespoke-region: layer`) — and any visit answered with a layer — opens one over what is on screen (stacked, up to `MAX_LAYER_DEPTH`; beyond, it is shown as a page); a history entry of its own (`HistoryState.layer = { depth, below }`: keys only, E36). `layer.visit/reload/close/onClose`, `page` + `subscribe`, `owner` (its islands): an answer with the same key replaces it in place (validation errors), another key stacks, `LAYER_CLOSE_HEADER` (`closeLayer()`) closes it and reloads what stays (the page first). Back closes the top one from memory — the page is not rendered again, its deferred props and islands are not asked again; `close()` is Back when it was pushed over what is beneath (and forgets it: Forward asks the server), else the entry is replaced. A deep link's document brings `page.layers`. `once` layers (an action's answer) are forgotten when they leave the screen, and what stays reloads. Sign-out/409 drops them with the pages. **Loaded on demand (E71):** the layers (`navigator.use(layers)`, the stack is their API and each layer's host) are a chunk of their own — the core loads it (`loadLayers`, or the adapter's `NavigatorOptions.loadLayers`) when an answer is a layer, a layer's request is sent, or Back/Forward goes to a layer's entry and nothing loaded them before (development: `[bespoke:C7]` on the console when nothing here asked for a layer). Meanwhile the answer is held by its visit alone — not shown as a page, not dropped; a newer visit or Back cancels it, a 409 leaves nothing of it; a chunk that cannot load is a full load of the URL. An adapter loads them where layers open (`<Link layer>`: `navigator.load(…)` when it renders) and **before the first render of a deep link** (`page.layers`): attached before the navigator takes over the history, so the layers hydrate with the server's markup |
| `navigator.use(queryState).create(options)` → `QueryState` | Typed URL state (E55), a feature (in an app only when it uses it): `value(page)` is the page's query as the server parsed it (`PageObject.query` + `queryDefaults` — the browser never parses a URL) or what is being typed (`draft`); `set(patch \| fn)` changes it at once and visits the page's URL after `debounce` ms (partial with `only`, `reset` = `only` by default, `history: 'push' \| 'replace'`, state and scroll kept); the draft gives way when the page changes otherwise (Back/Forward, a link). `navigator.subscribe(listener)` follows the page on screen |
| `navigator.use(actions).run(url, options)` → `ActionOutcome` | Actions (E59), a feature (attached where it is used — `useAction`): requests that do not navigate — no history entry, nothing in the page cache, no progress bar, no events. `x-bespoke-action` + `Accept: application/json`, XSRF for writes, `redirect: 'manual'`, `cache: 'no-store'`; the server answers data (`this.json()`), 422 with field errors, or `204` + `x-bespoke-redirect` for a redirect (reported, not followed; `onRedirect: 'visit'` follows). Ends `data \| redirect \| invalid \| exception \| cancelled` — never rejects, never retries (401/419 after signing out are an `exception`). Calls run side by side; `key` makes a newer one cancel the older; `signal` aborts. A 409 + location (signed out through it) leaves the document |
| `{ target: navigator.use(optimistic).target(entry), patch }` (the page on screen: `.page`), `layer.optimistic`, `region.optimistic` → `OptimisticUpdate` | Model 1 (E59) — the `optimistic` feature holds the pages' patches (attached where a page's patch is made — React: `router.optimistic`): a patch of the props of the page on screen (its history entry), a layer or a region — shown at once **over** the props in memory (`layer.view`, `region.snapshot.region`, the page handed to `render`), never written into them: the page cache and `history.state` never hold it. Rolled back when the action (or a form's visit: `visit({ optimistic })` — the core applies those, of any target) fails; a patch is a function of the props beneath it, so several on one list compose and a failure takes only its own out |
| `{ target: navigator.use(optimistic).page, spec }`, `layer.reloading`, `region.reloading` → `Reloading` | What an action reloads once it succeeded (`only`/`except`/all), in the background: its patches on that target go in the same update the server's props land in; reloads of one target replace each other (an older answer never lands last); a patch on a target that does not reload becomes its state |
| `navigator.use(actions).submissions()` → `Submissions` (`list` + `subscribe`) | Model 2 (E59): actions and route forms (`visit({ name })`) under way, with their input — ghost rows, listed from when the feature is attached (where they are shown) until their reloads have landed |
| `navigator.use(liveValidation).validate(url, request)` / `.form(url, options)` → `LiveValidation`; `liveValidationOnFirstUse(navigator, url, options)`, `navigator.load(loadLiveValidation)` | Live validation (E62), a feature loaded on first use (E74: its code is a chunk of its own — `liveValidationOnFirstUse` fetches it on a form's first change and replays what happened meanwhile; `cancel()`/`reset()` before then forget it): the form's own request (method, URL, body, XSRF) plus `x-bespoke-validate: name,email` — the server runs middleware, `authorize` and the schema, never the controller, and answers `204` or `422` (both with `x-bespoke-validated`) with the named fields' errors; anything else is an `exception` (a redirect, 403, 419, 429). Password fields (`/password/i`) and files are never sent. `LiveValidation` per form: `changed(field)` (touched; `on: 'change'` or a field showing an error checks after `debounce`), `blurred(field)` (checks the touched fields when this one was touched), `validate()`, `validating(field)`/`pending` + `subscribe`, `cancel()` (on submit), `reset()`; a newer check aborts the older, a field typed over drops its stale result. The adapter keeps the errors (`onResult`) |
| `navigator.on('flash', listener)`, `navigator.onFlash(key, listener)` — `FlashChannel` | Flash messages (E60, E67): every answer the user is shown may bring some — `PageObject.flash` (a page, a partial reload incl. polls and deferred groups, a layer), the `{ close, flash }` body of a layer's close, an action's `x-bespoke-flash` header. Each fires **once, by its id**, after what it came with is on screen: never again for a partial reload that delivers it again, Back/Forward or a page from memory (the core keeps no message with a page, none in `history.state`); the same message flashed twice has two ids. A message nobody listens to yet waits for the first listener of its key (the first page's). A prefetch answered `x-bespoke-flash-waiting` is not shown: the click asks the server, whose answer delivers them |
| `navigator.visiting` + `subscribeVisiting`, `isPending(name)`, `isCurrentLink(page, href, activeMatch)`, `matchesRouteName`, `dirtyPaths(initial, current)`/`isDirtyPath`, `markBusy(navigator)` | State for the UI (E64): the foreground visit under way (URL, method, route name), whether a route's visit or action is under way (`isPending`: the visit, and what a feature reports through its `pending` hook), whether a link is current (exactly the same URL — path and query in any order — or `activeMatch` against `PageObject.route`, `*` as wildcard), the leaves that differ between a form's start and now, and `aria-busy` on `<html>` while a visit runs (`markBusy`). The adapter renders them as `aria-current="page"` + `data-current`, `data-pending`, `data-dirty` |
| `navigator.use(guard).add(guard)` → lift, `isGuarded()` | The navigation guard (E64), a feature (attached where a component guards — `useBlocker`, a form's `guard`; a visit's own `confirm` is the core's, asked without it): while a `NavigationGuard` is registered (and `active()`), a visit that would take its level (the page, or its `layer`) off the screen asks first; Back/Forward — which the browser has done already — is undone by `history.go(-delta)` from `HistoryState.index`, asked, and redone on "leave"; closing a layer asks; closing the tab or reloading gets the browser's own question (`beforeunload`). A form passes its own guard when it is sent (`ignoreGuards`). Background requests (partial reloads, polls, deferred, a reload of the same page) never ask, and a 409 that is not `version` (signing in or out) never asks and is never stopped |
| `navigator.confirm(confirm)`, `NavigatorOptions.confirm` (`ConfirmHandler`), `confirmRequest`, `accepted`, `nativeConfirm` | Asking the user (E64): `confirm` of a visit, an action or a form, and the guard's question (`kind: 'leave'`). The adapter's handler shows a `ConfirmRequest` (message, title, labels, `destructive`, `prompt` for type-to-confirm) and answers `true`/`false` — or the text typed; **the core** decides: a type-to-confirm question is a yes only for exactly that text. Without a handler: the browser's `confirm()`/`prompt()`; without those, a confirmation is a no and a guard lets go |
| `NavigatorOptions.revalidateOnBack(component)` + `navigator.use(revalidateOnBack)` | E58, a feature (React: `resolveModulePages` brings it and `<BespokeApp>` attaches it — `ResolvePage.features`): what a view declares to reload when Back/Forward shows it from memory (`true` or prop names) — the page, a layer Forward opens again, an island of a restored entry (`RegionOwner({ onBack })`): shown at once, then reloaded in the background (no events, no progress bar). Never on a first load, a visit or a refetch |
| `navigator.use(remember).of(owner.entry)` → `Remembered`, `rememberable(value, include)` | Remembered state (E63), a feature (attached where a component remembers): per history entry (a page's owner, a layer's `layer.owner`: their `entry`) — the entry's slot `REMEMBERED`, next to its islands — **memory only**, never `history.state` or storage. Gone with the entry (evicted, a layer closed for good) and with the document (every 409, a reload). `rememberable` leaves out fields named like a password (always), a token, a secret or a card (`include` lets those in) and files, at any depth. No tab sync (E66) |
| once props (automatic) | E64: page objects with `onceProps` (+ `onceScope`) are kept by the navigator (`OnceStore`); every page request names what it holds (`x-bespoke-once`, `x-bespoke-once-scope`), the server skips those and the navigator puts them back before `render`. A page of another scope drops them; every 409 clears them |
| `visit(url, { instant: { component, props } })`, `navigator.load(loadInstant)` | Instant visits (E64), a feature loaded where an instant link renders (E74: a chunk of its own — a visit before it is there goes without its placeholder): `render(page, { placeholder: true })` with `{ component, props }` = the target view and what the link hands its placeholder — shown at once, the page when its answer lands; the history entry is pushed only then. Failed or cancelled: the page on screen again (scroll kept); Back during it cancels it; a page fetched ahead shows at once instead |
| `on('version', event)`, `newVersion` + `subscribeNewVersion`, `reloadForNewVersion()` | The asset-version 409 (E64, `x-bespoke-reload: version` — exactly that value): `event.preventDefault()` keeps the page (`newVersion` says where the full load waits; the user's next GET visit makes it); without it, unsaved changes nobody agreed to leave ask first (`event.unsaved`). Every other 409 (`history`: signing in or out, or no reason) is never cancelable and never asks |
| `formObject(entries)`, `defaultFormEntries(form)`, `formEntries(form)`, `restoreFormEntries(form, entries, names)`, `fieldPath(name)` | Uncontrolled forms (E64, `<Form>`): the data the server builds from a form's entries (bracket notation), where a form starts (its controls' defaults — "dirty"), its entries now, remembered entries put back, `links[0][url]` → `links.0.url` |
| `queryUrl`, `pageQuery`, `withoutDefaults`, `linkQuery`, `assertQueryPage` | Query helpers: a URL without the defaults, the page's query with them, a link's query for the page on screen, the "only on its route's page" check |
| `progressBar(options)` → `ProgressIndicator`, `showProgress(navigator, options)` | The progress bar (E82, opt-in): plain DOM, inline CSS-variable styles (CSP-safe), not for `async` requests, only for visits slower than `delay` (250 ms). `progressBar` is what an adapter takes (React: `createBespokeApp({ progress: progressBar({ delay: 250 }) })`); an app without it carries none of its code |
| `createPoll(run, interval, options)` | Polling, paused while the tab is hidden |
| `readInitialPage()`, `rootElement(id)`, `hasServerMarkup(root)` | The hydration entry's first steps: the page from `#bespoke-page`, the root (also while streaming), hydrate or render |
| `loadPageMessages(page, messages)`, `pageLocale(page, messages)` | The page's messages in its `locale`, falling back to the server's `fallbackLocale` (`APP_FALLBACK_LOCALE`, sent with every page) — any loader with `fallback` and `load(locale, { fallback })`, e.g. `createMessageLoader` of `@bespokecore/i18n/messages`. Load them before a page renders, in the browser and the SSR entry |
| `resolveRoute(manifest, name, params, query)` | A named route's URL and method from the manifest (`virtual:bespoke/routes`) |
| `prefetchWith(navigator, url, options)`; `navigator.load(loadPrefetch)` → `Prefetches` (`prefetch(url, options)`); `navigator.loaded(loader)` | Prefetching, a feature loaded with the first prefetch (E74: its code is a chunk of its own, fetched while the pointer rests on the link — before the click): GET only, `Purpose: prefetch`, `cacheFor`; a visit of the URL takes the page (or waits for its request); a write (a non-GET visit) drops every prefetched page, and so does leaving the document. A chunk that cannot load prefetches nothing. Once loaded, `navigator.loaded(loader)` hands a lazily loaded feature over at once: a press on a link prefetches before its click's visit, not a task later |
| `visitUrlOf(click, href, target)`, `prefetchTriggers`, `prefetchUrlOf`, `HOVER_PREFETCH_DELAY` | Which link clicks become visits (plain left clicks, same origin, no other `target`) and when links prefetch |
| `firstErrors(page)` | The first validation message per field (forms) |
| `TitleRegistry`, `defaultTitle` | The document title from the mounted head components — the last one wins, none → `template('')` |
| `isDevelopment()` | `process.env.NODE_ENV !== 'production'`, as bundlers replace it |

### What an adapter provides

1. **Rendering a page object.** `new Navigator({ initialPage, render, confirm, revalidateOnBack })`: `render(page, { preserveState, owner, layers, placeholder })` resolves the
   page's component (and its messages), shows it with `page.props`, and **resolves once it is on screen** — the navigator
   restores the scroll position after that. `preserveState: true` keeps component state when the same component comes
   back (a form that failed validation); otherwise the page mounts fresh. A rejection makes the browser load the URL
   itself (a chunk gone after a deployment). Then `navigator.start()` (returns the stop function), `markBusy(navigator)` and,
   when the app passed one, its progress indicator (`progressBar(options)` or its own: `(navigator) => stop`, E82). Failures (`exception`: offline, 5xx with the server's error page) are the adapter's to show;
   the page stays. `owner` is where the page's islands live: render them with `navigator.use(islands).region(url, { owner })` (the
   first page: `navigator.regionOwner`), each into an element of its own, from its `snapshot` — its fallback while
   `loading`, an `unauthorized` UI, an error UI with a retry (`reload()`), and its view otherwise, inside an error boundary
   of its own. `layers` are the layers over the page (E53), bottom first: render each in a frame over it (a modal `<dialog>`:
   focus kept inside and returned to the opener, Escape and the backdrop `layer.close()`, the page beneath inert and not
   scrolling), with its own page context so visits and forms inside go through `layer.visit()`; when only they changed,
   `page` is the page on screen (with `preserveState`) and must not render again. (`layers` is what the layers feature
   contributes to every render — the `extras` hook; empty without it.) The layer UI is a chunk of its own too (E71): give the
   navigator `loadLayers` that loads it with the core's `layers` (one round trip — React: the layer stack), use the same loader
   where a layer opens, and load it before rendering a document with `page.layers` (React: `createBespokeApp` and the SSR entry).
   Actions (E59): render `layer.view` (not `layer.page`) and a region's `snapshot.region` — they carry the optimistic patches —
   and pass `revalidateOnBack` to the navigator (the adapter knows the views: React reads `View.revalidateOnBack`).
   Instant visits (E64): `render(page, { placeholder: true })` shows the placeholder of `page.component`'s view (React:
   `View.placeholder`) with `page.props` inside that view's layouts — never the view itself, and the page context stays the page
   on screen; no placeholder → nothing changes; one that resolves after a later render started is dropped. Remembered state
   (E63): keep it with the entry of the level it renders in (`navigator.use(remember).of(owner.entry)`, a layer's `layer.entry`), keyed by
   the app (an island's apart). Forms without JavaScript (E64): `page.csrf` as `_token`, `_method` for PUT/PATCH/DELETE (the
   kernel spoofs the method from a POST body, never from the query).
   Asking (E64): pass `confirm` — a handler that shows the `ConfirmRequest` in the app's dialog (React: `createBespokeApp({ confirm:
   ConfirmDialog })`) and answers yes/no or the text typed; the core compares it. Flash (E60): show messages from
   `navigator.on('flash')`/`onFlash(key)` — they fire after the answer is on screen, once; render nothing of them from props.
   On the server, `page.flash` may be rendered for browsers without JavaScript (`<noscript>`).
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
   (`navigator.use(queryState)`, rendering `value(page)` — on the server from the page object alone; links to the page on
   screen leave its defaults out, `linkQuery`) — and for Wave 5b: islands (`<Island route query load poll fallback
   unauthorized>`, `useIsland<C>()` over `Region`), layers (`<Link layer>`, `useLayer<C>()`, a dialog frame), actions
   (`useAction(name)` over `navigator.use(actions)`, optimistic patches and `reloading` typed against the page, ghost rows from
   its `submissions()`), flash (`useFlash(key, …)`), state (`usePending`, `aria-current`/`data-current`/`data-pending`
   on links, `data-dirty` from `dirtyPaths`), the guard (`useBlocker`, a form's `guard` option over `navigator.use(guard)`), live
   validation (`liveValidationOnFirstUse` per form — the adapter keeps the errors), remembered state (`useRemember` over
   `navigator.use(remember)`), an uncontrolled form (`formObject`, `defaultFormEntries`, `restoreFormEntries`), instant links
   (`instant` → `visit({ instant })`) and a new-version notice (`navigator.newVersion`). **Form state stays per adapter**
   (values, errors, `processing`): the core gives it the requests, the validation, the guard and the memory.
7. **Its route sinks** (E57): every place where app code hands the adapter a route name (`<Link route>`, the function of
   `useRoute()`, `useForm(name, …)`, `useQueryState(name, …)`, `<Island route>`, `<Form route>`, `useAction(name)`,
   `usePending(name)`) is a row in `ROUTE_SINKS` of `@bespokecore/vite` (or `bespoke({ routeSinks })`). A layer link is `<Link
   route layer>` — `layer` is a flag, not a sink; a name that is only compared (`usePendingSubmissions(name)`) needs none.
   The client build ships only the names written out at a sink; a name built at runtime fails the build. Route names
   never come from props — the server sends URLs (`router.url()`).

Pages come from `virtual:bespoke/pages` (`bespoke({ pages })` in `@bespokecore/vite`, default `modules/*/views/**/*.tsx`),
language files from `virtual:bespoke/lang` and the route manifest from `virtual:bespoke/routes`; the adapter brings its framework's Vite plugin
(`plugins: [bespoke(), react()]`).

### Features

An app pays in the browser only for what it uses (Wave 5c, E70–E75). The navigator alone is the **fixed core**; everything
optional is a feature (`defineFeature`) that is attached where it is used — no app configuration, no list to keep in sync.
Nothing is attached by default (`NavigatorOptions.features` is empty). A feature comes in one of three ways:

| How | Features | Attached by (React) |
| --- | --- | --- |
| **Where it is used** — a static import of the hook or component that uses it, attached on its first use (`navigator.use`) | query state, remembered state, actions + submissions, the navigation guard, islands, the page's optimistic patches, `revalidateOnBack`, the progress bar (E82) | `useQueryState`; `useRemember`, `useForm({ remember })`, `<Form remember>`; `useAction`, `usePendingSubmissions`; `useBlocker`, `useForm({ guard })`, `<Form guard>`; `<Island>`, `useIsland`; `useRouter().optimistic`/`.reloading`; `resolveModulePages` (`ResolvePage.features`, attached by `<BespokeApp>`); `createBespokeApp({ progress: progressBar() })` |
| **Lazy, on first use** (E74) — a chunk of its own, fetched when a prop or an option asks for it (`navigator.load(loader)`) | live validation, prefetching, instant visits, the layers where they open, uploads (W6.9) | `useForm(…, { validate })` on a form's first change (what happens meanwhile is replayed); `<Link prefetch>`/`router.prefetch` with the first prefetch; a `<Link instant>` when it renders; a `<Link layer>` when it renders; a `<FileInput>` when it renders (`loadUploads`) |
| **Lazy, triggered by the server** (E71) — the core loads it itself, because an answer may need it whatever the client imported | the layers, live props (W6.10) | layers: an answer that is a layer (E53: any visit may get one), a layer's request, Back/Forward to a layer's entry — and the adapter before the first render of a deep link (`createBespokeApp`, the SSR entry); live props: a page, a layer or an island that follows a channel (`PageObject.live`) — and `useLiveUpdates()` where it renders |

The core itself loads uploads with progress (`FormData` with a progress listener, over XHR) with the first such upload — a
chunk that cannot load sends it with `fetch`, without progress. Polling (`createPoll`), `<Form>` and pagination are plain
modules, in an app when it imports them.

**Uploads (W6.9)** are a feature like these: `<FileInput field={form.field('avatar')} />` loads it where it renders. A chosen
file goes ahead of its form — a target from the form's own route (`x-bespoke-upload: <field>`: its middleware and `authorize`
run, its `upload()` rule sets the limit), then the bytes with progress (XHR) to that target — and the field holds an `Upload`:
`status`, `progress`, a `blob:` `preview`, `error`, `cancel()`. The form sends its token, never the file. The uploads under way
and their tokens live **only in the feature's slot of the document**: the `Upload` a form holds reads its token from there when
it is serialized (`toJSON`), so a 409 (signed out, a new build) aborts every upload and leaves no token anywhere — the `Upload`
on screen then sends `""`. It is a function object on purpose: remembered input (E63) leaves functions out, so an upload is
never remembered. Its state is on the value (`form.data.avatar?.progress`): `form.progress` stays the progress of a visit with
`FormData`.

**Live props (W6.10)** are a feature the server triggers, like the layers: a page object (a page, a layer's, an island's region
object) with `live` — the channels it follows, each signed for the session — makes the core attach `live` (its chunk is
loaded then; an app whose pages follow nothing never loads it). The feature opens **one** `EventSource` per document for every
channel on screen (`GET /_bespoke/live`, see the protocol), switches it when what is on screen changes, and turns each hint into
a partial reload of what follows the channel — hints that come in a burst (250 ms quiet, at most 2 s) into **one** reload per
page, layer or island (`navigator.reload`, `layer.reload`, `region.reload` with `only`). Every request of the document names
it (`x-bespoke-connection`: visits through the `start` hook, actions and live validations through the `send` event), so the
server leaves a tab out of the hints its own writes cause. While a guard holds (unsaved changes) nothing reloads:
`navigator.use(live).updates` (`pending`, `apply()`, `subscribe`; React: `useLiveUpdates()`). The connection rule (E104): always
connected, except a page loaded over HTTP/1.1 or an unknown protocol (`nextHopProtocol`) — then only while the tab is visible;
whenever a stream comes back, `hello` compares each channel's sequence with the last one seen and what moved reloads once. The
stream, the sequences and the hints waiting live **only in the feature's slot of the document**: a 409 closes the stream and
forgets them.

**The progress bar is opt-in (E82):** `createBespokeApp({ progress: progressBar({ delay: 250 }) })` — the starters (blank-app,
web-app, and so `make:auth`) pass it; an app that leaves it out carries none of its code. Without it, what every app has says
that a visit runs: `aria-busy="true"` on `<html>` (`markBusy`, always on), `data-pending` on the link being visited, `usePending()`,
the visit events (`router.on('start' | 'progress' | 'finish')`) and instant placeholders. An indicator of your own is a function of
the navigator that returns its stop — a few lines, or none at all with CSS on `aria-busy`:

```ts
// CSS only: html[aria-busy='true'] main { opacity: .6; transition: opacity .2s .25s }
const spinner: ProgressIndicator = (navigator) => {
  const offs = [
    navigator.on('start', (visit) => visit.async || document.body.classList.add('loading')),
    navigator.on('finish', (visit) => visit.async || document.body.classList.remove('loading')),
  ];
  return () => offs.forEach((off) => off());
};
createBespokeApp({ resolve, progress: spinner });
```

**Always in the core, and why.** What the server can send to any request is handled whatever the client imported, and every
security invariant is structural — no feature can forget it (E72, E36):

- the visit pipeline, Back/Forward, scroll restoration, the in-memory page cache (LRU) and the history writer, which writes
  positions only — never props (`host.history`, see the feature host above);
- the 409 of a document change (`version` may wait, `history` — signing in or out — never does): it leaves the document
  (`#leave`), empties **every** slot of every feature, aborts every request in the background **and the visit under way**, so
  nothing of the signed-in user lands afterwards;
- once props, flash messages (each once, by its id), deferred, merged and streamed props — protocol fields any answer may carry;
- a visit's own `confirm` (asked with no guard attached) and a visit's optimistic patches (of any target: the page's, a layer's,
  an island's);
- the small `RegionOwner` of each entry on screen (remembered state, layers and rendering need it without islands).

`security-matrix.test.ts` holds every feature — and the core alone (`features: []`) — to these rules: after a 409 (signed out,
a new build) and when memory lets go of an entry, no slot, no hook and no API hands out what the signed-in user saw, a visit or a
Back still under way does not land, and `history.state` never holds any of it; a page of another once scope drops the once props.

**What an adapter does with features** (React today, Vue next — E39, E73): it calls feature functions, never methods of the
navigator. In a composable or hook:

```ts
const regions = navigator.use(islands);                      // sync: attached on the first call, the same API after (React: useFeature(islands))
const region = regions.region(url, { owner, initial });
const live = liveValidationOnFirstUse(navigator, url, opts); // lazy: loads its chunk on the first change, replays what came meanwhile
void prefetchWith(navigator, url, { cacheFor });             // lazy: the first prefetch loads the code; then it prefetches at once
navigator.loaded(loadPrefetch)?.prefetch(url);               // sync, once a lazy feature is here — for what must happen in this task
await navigator.load(loadInstant);                           // async: fetch the chunk now (when a link that needs it renders)
```

- `navigator.load(loader)` fetches a feature's chunk once and attaches it; `navigator.loaded(loader)` hands it over synchronously
  once it is there (a press on a link must prefetch before the click's visit, not a task later).
- Layers: give the navigator `loadLayers` — a loader that brings the adapter's layer UI in the **same chunk graph** as the core's
  `layers` (React: `layer-stack.tsx` re-exports them; Vue: a module with the layer stack component that re-exports `layers`,
  loaded with `import()` and rendered with `defineAsyncComponent`). Use the same loader where layers open, and await it before
  hydrating a document with `page.layers` — attached before the navigator takes over the history, so the layers hydrate.
- A new feature: `defineFeature(name, setup, order?)`; keep state **only** in slots (`host.entry`, `host.document`), register
  history fields with `host.history.field`, add it to `ALL_FEATURES` of the security matrix and a row to the leak test (below).

**The size budget** (E75). `packages/react/size-budget.json` holds a limit per scenario, in KB gzip of the initial download,
measured in Vite's app mode against `dist/` (minified, production defines, React and i18n left out, and without Vite's preload
helper — the first `import()` of any client build brings it, so it is no framework code). The limits are where Wave 5c ended
(core 11.2, `emptyApp` 13.6, `minimalApp` 18.2, `blank-app` 14.1, `web-app` 22.6 KB gzip; the `everything` ceiling 31.1 since
E110 — Wave 6 added uploads and live props as lazy features, and the core's server-driven live trigger costs every app ≈ 40 B)
and only go down:

| Scenario | What |
| --- | --- |
| `core` | the client core as an adapter uses it: the navigator, the document, links, forms, routes, titles, messages |
| `emptyApp` | `createBespokeApp` alone — an app without a page |
| `minimalApp` | `createBespokeApp`, `Link`, `useForm`, `usePage`, `Head` |
| `everything` | all of `@bespokecore/react` — a ceiling, not a ratchet |
| `blank-app`, `web-app` (`appsGzipKB`) | the real apps' client builds: the marginal cost of core + adapter in the initial load (what the download loses without their bytes) |

- `bundle-size.test.ts` (part of `pnpm test`) builds the scenarios and fails when one grows over its limit — and when one is
  more than 0.3 KB under it, until the limit follows (`BESPOKE_SIZE_BUDGET=update` lowers limits in place, never raises them).
  Limits only go down: raising one is a decision on record (E78, E79, E81), not a fix. The same test is the **leak test**: every
  feature has markers (its modules) and must be in a bundle only with its own import — a lazy one only in a lazy chunk
  (`stillLeaking` is `[]` in every scenario).
- `pnpm size` attributes every byte of the scenarios and of the real apps to its module (source maps), prints the marginal cost
  of core + adapter, and checks the apps against `appsGzipKB`; `pnpm size web-app` lists every module. Both measure `dist/`:
  run `pnpm build` first.
- `bespoke()` splits an app's first download into two chunks — `vendor` (third-party packages) and `index` (the framework with the
  app's entry): `CLIENT_CHUNKS` of `@bespokecore/vite`, initial modules only, so what loads on first use stays in its own chunks.
  The scenarios are built the same way.

### Error codes

A mistake in app code (a hook outside its app, a page with a broken export, a route the browser does not know) throws an
explanation in development: what is wrong and how to fix it. A production build carries only a code and a name, such as
`[bespoke:R2] users/Show`, so the explanations cost no download (E80). Both start with the same code: run the app in
development to read the whole message, or look the code up here. The core and every adapter keep their explanations
behind an inline `process.env.NODE_ENV !== 'production'`, which the bundler replaces, so the production bundle drops the text.
Without a bundler that replaces it, `process` does not exist in the browser; React needs that replacement anyway.

What is not a code: refusals a production log needs to read (an action, a live validation or a region that would go to
another site), a missing or broken page object in the document, and every text a user sees (the leave and new-version
questions, the error pages).

| Code | Where | Meaning (the development message says more) |
|---|---|---|
| C1 | `resolveRoute` | A route name, but no route manifest was passed (`createBespokeApp({ routes })`). |
| C2 | `resolveRoute` | A route name the browser does not know (API, `.internal()` and `clientRoutes.except` routes never ship). |
| C3 | query state | Query state of a route used on the page of another route. |
| C4 | query state | Query state of a route without a query schema. |
| C5 | `createPoll` | A poll interval of 0 ms or less. |
| C6 | layers | A layer depth outside 1 to 10. |
| C7 | layers | Development only, a hint (`console.info`): the server answered with a layer (or Back/Forward went to one) before any code loaded the layers — they load now, one round trip. |
| C8 | layers | Development only, a warning: a deep link's document (`page.layers`), but the layers were not attached before the navigator took over the history — attach them before the first render. |
| R1 | pages | A page's `layout` is not a component or a list of them. |
| R2 | pages | No page of that name (no default export in `modules/<module>/views/…`). |
| R3 | pages | A page module without a default export. |
| R4 | pages | A page's `ssr` is not `true`, `false` or `'complete'`. |
| R5 | pages | A page's `placeholder` is not a component. |
| R6 | pages | A page's `revalidateOnBack` is not `true`, `false` or a list of prop names. |
| R7 | `useAction` | An action submitted while rendering on the server. |
| R8 | `reloading({ islands })` | An island route the browser does not know. |
| R9 | hooks | A BespokeCore hook outside `<BespokeApp>`. |
| R10 | `useFeature` | A client feature used while rendering on the server. |
| R11 | `useRouter` | A visit while rendering on the server. |
| R12 | i18n hooks | A translation hook without the app's messages (`createBespokeApp({ messages })`). |
| R13 | `<Head>` | `<Head>` inside an island (development only: production renders nothing). |
| R14 | layers, islands | An optimistic patch or reload while rendering on the server. |
| R15 | `useIsland` | `useIsland()` outside the view of an island. |
| R16 | `createBespokeApp`, `<BespokeApp>` | `progress` is not an indicator — since E82 it takes `progressBar({ delay })` (or the app's own); `{ delay }` and `false` are gone. |

## The protocol

What goes over the wire, in one place (constants in `@bespokecore/http/page`). Every page and island request of the core
carries `x-bespoke-version` (the build — a new one answers 409); actions and live validations do not (they are no pages: a new
build shows with the next page request, a poll or a visit). Every write carries `X-XSRF-TOKEN` from the `XSRF-TOKEN` cookie —
never a token from the URL.

| Request header | Sent by | Meaning |
| --- | --- | --- |
| `x-bespoke: true` | visits, reloads, prefetches, regions | answer with the page object as JSON (Inertia's `X-Inertia`) |
| `x-bespoke-partial-component` / `-data` / `-except` | partial reloads, deferred groups, polls | only these props of this component — the server computes only what it sends (E7) |
| `purpose: prefetch` | prefetches | no side effects (the server's `isPrefetch()`); a prefetch never takes a flash message |
| `x-bespoke-region: island \| layer` | regions (with `x-bespoke`) | an island's region object (E48), a layer's request (E53); an island route without it is a 404 |
| `x-bespoke-action: true` | actions (without `x-bespoke`) | answered with data, never a page (406); a redirect becomes `204` + `x-bespoke-redirect`; always `no-store` (E59) |
| `x-bespoke-validate: a,b` | live validation (the form's own method, URL and body) | run middleware, `authorize` and the schema, never the controller; answer `204`/`422` for these fields only (E62) |
| `x-bespoke-upload: avatar` | an upload's target (the form's own method and URL, `{ name, size, type }` as JSON) — and `bytes` on the request that sends the file | run middleware, bindings and `authorize`, never the controller; answer `{ token, upload: { method, url, fields? } }` from the field's `upload()` rule (404 without one, 422 too large); read-only like a live validation, errors as JSON (W6.9) |
| `x-bespoke-once: k1,k2` + `x-bespoke-once-scope` | page requests | the once props held (by key) under that scope — skipped by the server for the same scope only (E64) |
| `x-bespoke-connection: <id>` | every request of a document that follows live channels (visits, actions, live validations) | which tab sent it: a live hint its write causes reaches that tab with `only: []` (W6.10) |
| `Accept: text/event-stream` | the live stream (`EventSource`) | an event stream — read-only like an island: no session write, no cookie, no flash taken (W6.10) |

| Response header | Meaning |
| --- | --- |
| `x-bespoke: true` | the body is a page (or region) object |
| `409` + `x-bespoke-location` + `x-bespoke-reload: version \| history` | load that URL fully, every page in memory dropped (E36). Only exactly `version` (a new build, `CheckAssetVersion`) is cancelable — the `version` event; `history` (signing in or out, `ClientHistory.clear()` — it overwrites the reason on every 409 it makes) or no reason never is (E64) |
| `x-bespoke-region: island \| layer` | marks an island's region object or a layer's page object (and goes into `Vary`) |
| `204` + `x-bespoke-region-status: unauthorized \| forbidden` | an island that redirected / answered 401 or 423 / answered 403 — its fallback, never a navigation (E52); failures keep their status with `exception` |
| `x-bespoke-layer-close: true` | `closeLayer()` answering a layer's request: JSON `{ close: { layers, reload? }, flash? }` (E53) |
| `204` + `x-bespoke-redirect` | where an action's (or a live validation's) route redirected — reported, not followed |
| `x-bespoke-flash` | an action's flash messages, URI-encoded JSON (E60) |
| `x-bespoke-flash-waiting` | on a prefetch: messages wait for the page the user is shown — do not show this prefetch |
| `x-bespoke-validated: a,b` | on a live validation's `204`/`422`: the fields checked — a client trusts only an answer with it (a proxy's 422 shows nothing) |

**The live stream (W6.10, `@bespokecore/live`)**: `GET /_bespoke/live?connection=<id>&c=<token>.<channel>&…` — one per
document, for every channel its page, layers and islands follow (`PageObject.live`: `[{ channel, only?, token }]`, the token an
HMAC over the channel and a hash of the session id, E90). Answered `200` with `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-store, no-transform` and `X-Accel-Buffering: no`, or refused: `400` (no connection, no channel, too
many — `LIVE_MAX_CHANNELS`), `401` (no session), `403` (a token that does not fit: another channel, another session, one that
ended — no stream at all), `503` + `Retry-After` (`LIVE_MAX_STREAMS` reached, the backend down, the server closing). Its events:
`retry: <ms>` first; `hello` — `{ seq: { <channel>: n }, missed?: [<channel>] }` (each channel's sequence; `missed` after a
reconnect with `Last-Event-ID`); `refresh` — `{ channel, only, seq }`, a hint and never data (`only: null` — what each follower
names; `[]` — nothing: this tab caused it); `end` — `{}`, the session ended (signed in or out): do not reconnect; a comment line
(`: heartbeat`) every `LIVE_HEARTBEAT` seconds. Each `hello` and `refresh` carries `id:` — the sequences the stream has seen
(`users.7=4&dashboard.sign-ins=12`), what the browser sends back as `Last-Event-ID`.

**The upload endpoint (W6.9, `@bespokecore/storage`)**: `PUT /_bespoke/uploads/<id>?expires=…&signature=…` — the URL the target
answered with, signed for 15 minutes, in the `web` group. The body is the file's bytes. Answers `200` `{ size }`, or: `403` (a
signature that does not fit or expired), `404` (no such upload, another session's, or past its lifetime), `409` (its bytes were
sent already — one PUT per upload), `413` (more than the field allows — cut off in the stream, whatever `Content-Length` said;
nothing stays), `419` (no session), `400` (no body). Uploads to S3 go to the store itself (a presigned POST) instead.

**The page object** (`PageObject`): `component`, `props`, `url`, `version`; `locale`, `fallbackLocale` (W5); `deferredProps`,
`mergeProps`, `deepMergeProps`, `matchPropsOn`; and from Wave 5b `query` + `queryDefaults` (the query as the server parsed
it, E55 — the browser never parses a URL), `streamedProps` (deferred groups streamed in the document, E49), `layer`
(`{ key, base, once? }`, E53) and `layers` (a deep link's document), `flash` (`[{ id, key, data }]` — a protocol field,
not a prop, E60), `route` (the answering route's name for `activeMatch`, never an `.internal()` one), `onceProps` +
`onceScope` (E64), `csrf` (for forms without JavaScript), and from Wave 6 `live` (`[{ channel, only?, token }]`, the channels it
follows — W6.10; a page's own and the shared ones, a layer's and an island's their own). A region object (`RegionObject`) is a page object without
`locale`, `fallbackLocale`, `streamedProps`, `layer`, `layers` and `flash` — and without shared props.

**A history entry** (`HistoryState`) holds positions only, never props (E36): `component`, `url`, `key` (the entry's memory),
`scroll` and `scrollRegions` (named `regions` before W5b — still read), `layer` (`{ depth, below }`: the keys beneath a
layer's entry) and `index` (where it is in the tab's history — what lets the guard undo a Back).

**The server's side** (`@bespokecore/server`): the kernel answers islands and layers from the same routes — `dispatchIsland`
is what `resolveIsland` calls (a synthetic GET through the island route's middleware, read-only, the page's session as a
copy, `islandTimeout`), `dispatchLayerBase` resolves a layer's declared base for a deep link (the same way, a chain up to
`MAX_LAYER_DEPTH`; a base that turns the user away gives `layers/Backdrop`, E54). After the headers every request is
read-only (`ResponseLifecycle`); islands and live validations are read-only throughout.
