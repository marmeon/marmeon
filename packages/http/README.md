# @marmeon/http

HTTP for Marmeon apps: controllers, views and page props (`view()`, `optional()`, `defer()`, `merge()` …), redirects,
signed URLs, encrypted cookies and the client history (`ClientHistory`). Three entry points:

| Import | Runs in | What |
| --- | --- | --- |
| `@marmeon/http` | server | everything above; the provider is found by `marmeon discover` |
| `@marmeon/http/page` | server **and** browser | the page contract: `PageObject`, the protocol headers, `SsrRender`, `Views`/`Routes` types |
| `@marmeon/http/client` | browser (and the SSR entry) | the UI-free client core every UI adapter builds on (E39) |

`page` and `client` never import server code: a test bundles both for the browser and fails on any module outside
`src/client/`, `src/page.ts` and the router's URL builder, and on any Node built-in or npm package
(`src/client/browser-safe.test.ts`). The package compiles with the DOM library for `client/`; server code must not use it.

Routes, middleware and the typed pipeline are [@marmeon/router](../router/README.md); the server that runs them is
[@marmeon/server](../server/README.md); the React adapter on top of the client core is
[@marmeon/react](../react/README.md).

## Registration and configuration

`HttpServiceProvider` is found by `marmeon discover`. It has no environment variables of its own — it needs the `Encrypter`
of [@marmeon/encryption](../encryption/README.md) (`APP_KEY`; the start fails without it) for its encrypted cookies. It
registers the `Router`, sets up the `web` and `api` middleware groups and loads every module's `routes` (group `web`) and
`apiRoutes` (group `api`, under `/api`):

```ts
defineApplication({
  middleware: { global: [SecurityHeaders], web: [ShareAppProps] },   // after the framework's own, per group
  clientRoutes: { except: ['admin.*'] },                             // which named routes the browser may learn
});
```

**Who sent the request** (E169): `RequestInfo` — `{ ip, userAgent }`, the address through `TRUSTED_PROXIES` like `ctx.ip` —
is bound per request by the server kernel, for services that have no `ctx` (`Auth` puts it into the `Login` event); outside a
request both are `undefined`. `IncomingRequest` is the request itself (headers a service needs).

**For middleware and packages** it re-exports from the router `editableResponse` / `ownResponse` (a header added in place or to
one copy per request — [Adding headers](../router/README.md#adding-headers-to-the-response--editableresponse)) and
`RequestNonce`, and holds the `CookieDefaults` token: what every cookie of a request gets unless its `set` says otherwise —
bound by [@marmeon/session](../session/README.md#configuration) (`Secure` from `SESSION_SECURE_COOKIE`, which follows
`APP_URL`, E162), handed to each request's jar by the kernel.

Both options, the groups and the order of the framework's middleware (`EncryptCookies` → `ClearClientHistory` → `StartSession`
→ … → `VerifyCsrfToken` → the app's): [@marmeon/router](../router/README.md#configuration),
[Groups and priorities](../router/README.md#groups-and-priorities). Its solutions (E130) — an undefined route name with "did
you mean", a missing view (R2) — show on the development error page.

## Content-Security-Policy (E147)

`contentSecurityPolicy(options?)` sends a policy with every **document** the app renders — opt-in, with a strict default; the
web app and the starter's shell (`apps/blank-app`, the base of `create-marmeon`) turn it on, and `marmeon make:auth` names it
for an app whose `bootstrap/app.ts` does not:

```ts
import { contentSecurityPolicy, NONCE } from '@marmeon/http';

defineApplication({ middleware: { global: [SecurityHeaders, contentSecurityPolicy()] } });
// script-src 'nonce-…' 'strict-dynamic'; object-src 'none'; base-uri 'self'

contentSecurityPolicy({ imgSrc: ["'self'", 'data:'], frameAncestors: ["'none'"] });       // more directives (camel-cased)
contentSecurityPolicy({ styleSrc: ["'self'", NONCE] });                                    // the nonce in another directive
contentSecurityPolicy({ baseUri: false, reportOnly: true, reportUri: ['/csp-reports'] });  // a default left out; report only
```

- **One nonce per response** (16 random bytes), made only when a document is rendered — and then everywhere it is needed: on
  `index.html`'s script, style and preload tags (the `marmeon()` Vite plugin sets Vite's `html.cspNonce` to a placeholder the
  server fills in), on React's streamed scripts that reveal Suspense boundaries and its `<style>` tags
  (`renderToReadableStream({ nonce })`, `SsrRenderOptions.nonce`), on a `<Head>`'s scripts and styles, on the development
  document's scripts (the devtools' bar, Vite's error overlay). `'strict-dynamic'` lets the entry load its chunks. HTML an app
  writes itself takes `ctx.nonce()` (`<script nonce="${ctx.nonce()}">`). Without the middleware, documents carry no nonce.
- **Only documents** get the header — HTML or XHTML (`text/html`, `application/xhtml+xml`, in any letter case); a JSON visit (`x-marmeon`), an island, an action or an API answer neither needs nor
  makes a nonce. A response with a policy of its own keeps it: the devtools' pages and the development error page (their inline
  code by hash), the mail preview, a file served from a disk (`sandbox`).
- **Development is not relaxed**: HMR, React Refresh, the devtools' bar and the overlay run under the same policy as production,
  so a violation shows where it is made.
- **Not with a shared cache:** a page cached publicly (`Cache-Control: public` or `s-maxage`, e.g. `cacheControl('public, …')`)
  with a nonce is logged once — a CDN would hand the same nonce to everybody, which a script injected into the page could
  reuse. Keep such pages private, or out of the policy.
- The client code needs nothing: data travels in `<script type="application/json">` (inert, no nonce), the progress bar and the
  dialogs style through CSSOM properties (not blocked by `style-src`); React's inline `style` props become attributes that
  need `'unsafe-inline'` only if you add a `styleSrc` (or `styleSrcAttr`) directive.

## The client core and the adapter contract

A UI adapter ([@marmeon/react](../react/README.md) today, a Vue adapter later) is a **rendering layer**. Everything else —
the protocol, the history, caching, background requests — is in `@marmeon/http/client`, uses DOM APIs where it must, and
knows no UI framework. `src/client/adapter.test.ts` is the proof: a complete adapter in plain DOM (it renders a page as its
component name and props in text) visits, goes back and forward, loads deferred props, reloads partially and follows a 409 — and
drives everything Wave 5b added: islands (loaded by the client, and hydrated from the SSR stream's data block without a
request), layers (Back closes, Forward opens from memory), an action with an optimistic patch and its rollback, a flash message
fired once, the navigation guard (a visit and a Back held), live validation, an instant visit's placeholder, remembered state
and a postponed new build — and two tabs of one browser, each a plain-DOM adapter, where signing out in one makes the other let
go of what it shows (tab sync) — with no UI framework anywhere. What a Vue adapter adds is components and composables; the mechanics
are here.

### What the core provides

| Export | What it does |
| --- | --- |
| `Navigator` | Visits (`visit`, `reload`), their events (`on('start' \| 'progress' \| 'success' \| 'error' \| 'exception' \| 'cancel' \| 'finish')` and per-visit `onX` callbacks, E44), the `x-marmeon` request headers (asset version, XSRF from the `XSRF-TOKEN` cookie, partial reloads), JSON or multipart bodies (upload progress via XHR — its code loads with the first such upload), 409 + `x-marmeon-location` → full page load and every kept page dropped, history entries **without props** plus an in-memory page cache (E36, refetch on a miss), Back/Forward, bfcache, scroll restoration (window and `[scroll-region]`), deferred props loaded per group after every show, `merge`/`deepMerge`/`matchOn`, `async` and `preserveUrl` visits |
| `mergePage` | A partial reload's props merged into the page (what the navigator does) — `reset` names props to replace, `true` all it brought |
| `NavigatorWindow.navigation`, `loadHistoryFallback` | The history through the Navigation API where the browser has it (E184, [The Navigation API](#the-navigation-api-e184)) — without it, the History fallback (a chunk of its own: `loadHistoryFallback()`, passed with `NavigatorOptions.features` before the navigator writes its first entry; development warns `[marmeon:C13]` when it is missing) |
| `navigator.use(feature)`, `defineFeature(name, setup, order?)`, `slot(name, create, clear?)`, `FeatureHost` | The feature host (Wave 5c, E70/E73): a feature's `setup(host)` runs once per navigator — the first `use` — and returns what adapters use of it (React: `useFeature(feature)`). It hooks into the pipeline (`host.on('visit' \| 'start' \| 'response' \| 'place' \| 'paint' \| 'navigate' \| 'popState' \| 'swap' \| …)`; `navigate` sees a Back/Forward of the Navigation API before the navigator intercepts it, `swap` may take a page's swap, as view transitions do; in the features' `order` — whenever each was attached — then attach order; the first result wins; events all run) and keeps what came from the server or the user **only in slots**: `host.entry(slot, key)` per history entry, `host.document(slot)` per document. The core empties them itself — an entry's when memory lets go of it (LRU eviction, another page replacing it, a layer forgotten), all of them when the document is left (every 409) — so a feature cannot leak data past a sign-out by forgetting to clear it (`security-matrix.test.ts` checks every feature × every such event). A history entry's state (the Navigation API's — `history.state` only in the History fallback) is written only by `host.history`, which refuses anything but positions (`component`, `url`, `key`, `scroll`, `scrollRegions` and fields a feature registers with `host.history.field(name, check, value?)`, e.g. a layer's depth and keys — with `value`, what the writer writes into every entry, e.g. tab sync's epoch: nothing wraps the writer): it throws in development and leaves the field out in production (E36). Since Wave 5c no feature is attached by default (`NavigatorOptions.features`): each is attached where it is used (`navigator.use`), or loads on first use (`navigator.load(loader)`, E74: live validation, prefetching, instant visits) — and the core loads the layers itself when the server answers with one (E71, below) |
| `navigator.use(islands).region(url, { owner, initial })` → `Region` | A region (E50) — an island (E48), a feature attached where an island renders (React: `<Island>`): the view of another route with its own region object (`RegionObject`: component, props, URL, query), loaded with `x-marmeon-region: island` (never following a redirect), `load()`/`reload({ query, only, except, reset })`, its deferred props, a `snapshot` (`loading \| ready \| unauthorized \| forbidden \| exception`, `pending`, `failure`) and `subscribe`. One per URL and owner (identical islands share one request); a newer request of a region aborts its older one. Its failures are its own — a redirect/401/403 is `unauthorized`/`forbidden`, never a page navigation (E52) — except a 409: the whole page loads again. Never prefetched |
| `regionInitial(result)` | What a region starts with when the server resolved it while rendering the page (E49): the `RegionResult` it streamed into the island's boundary (`<script type="application/json">`) → `navigator.use(islands).region(url, { owner, initial })` — `ready` with its region object, `unauthorized`/`forbidden` (no data), `exception` (shown, not kept), or nothing (`browser`: the region loads itself). No request |
| `navigator.receiveStreamed(group, result \| null)` | A deferred group of the first page that the server streamed with the document (`PageObject.streamedProps`, E49): the navigator does not ask for it, lands it once the document has finished streaming (`DOMContentLoaded` — an update earlier would make React render a still-streaming island in the browser), and asks for it after all when it gets `null` |
| `RegionOwner` | The core's owner of an entry on screen (`render` hands it over, `navigator.regionOwner` for the first page; a layer has its own): its `entry` key (what the entry's components keep: islands in the slot `REGIONS`, remembered state), `back` (shown by Back/Forward: what views declare reloads, E58), the islands on screen (`live`). In memory only — Back/Forward shows islands without a request, `history.state` never holds them (E36). Closed (requests aborted, nothing lands, `live` emptied) when the entry leaves the screen or the document is left |
| `navigator.layers` → `Layer[]` | Layers (E53) — a region with a history entry over the page: a page object whose `layer` (`{ key, base, once? }`) says so. `visit(url, { layer: true })` (header `x-marmeon-region: layer`) — and any visit answered with a layer — opens one over what is on screen (stacked, up to `MAX_LAYER_DEPTH`; beyond, it is shown as a page); a history entry of its own (`HistoryState.layer = { depth, below }`: keys only, E36). `layer.visit/reload/close/onClose`, `page` + `subscribe`, `owner` (its islands): an answer with the same key replaces it in place (validation errors), another key stacks, `LAYER_CLOSE_HEADER` (`closeLayer()`) closes it and reloads what stays (the page first). Back closes the top one from memory — the page is not rendered again, its deferred props and islands are not asked again; `close()` is Back when it was pushed over what is beneath (and forgets it: Forward asks the server), else the entry is replaced. A deep link's document brings `page.layers`. `once` layers (an action's answer) are forgotten when they leave the screen, and what stays reloads. Sign-out/409 drops them with the pages. **Loaded on demand (E71):** the layers (`navigator.use(layers)`, the stack is their API and each layer's host) are a chunk of their own — the core loads it (`loadLayers`, or the adapter's `NavigatorOptions.loadLayers`) when an answer is a layer, a layer's request is sent, or Back/Forward goes to a layer's entry and nothing loaded them before (development: `[marmeon:C7]` on the console when nothing here asked for a layer). Meanwhile the answer is held by its visit alone — not shown as a page, not dropped; a newer visit or Back cancels it, a 409 leaves nothing of it; a chunk that cannot load is a full load of the URL. An adapter loads them where layers open (`<Link layer>`: `navigator.load(…)` when it renders) and **before the first render of a deep link** (`page.layers`): attached before the navigator takes over the history, so the layers hydrate with the server's markup |
| `navigator.use(queryState).create(options)` → `QueryState` | Typed URL state (E55), a feature (in an app only when it uses it): `value(page)` is the page's query as the server parsed it (`PageObject.query` + `queryDefaults` — the browser never parses a URL) or what is being typed (`draft`); `set(patch \| fn)` changes it at once and visits the page's URL after `debounce` ms (partial with `only`, `reset` = `only` by default, `history: 'push' \| 'replace'`, state and scroll kept); the draft gives way when the page changes otherwise (Back/Forward, a link). `navigator.subscribe(listener)` follows the page on screen |
| `navigator.use(selection).of(table, entry)` → `Selection` | Row selection (W9 step 6), a feature (attached where a table is used — `useTable`): the keys a table's rows ticked, or "every matching row" (a flag — a bulk action sends the table's state, never keys), per history entry in the slot `SELECTIONS` — emptied with the entry and when the document is left; `keys`, `matching`, `has(key)`, `set(keys, selected, among?)`, `selectMatching()`, `retain(keys)`, `clear()`, `subscribe`, `version`. Memory only (E36) |
| `navigator.use(actions).run(url, options)` → `ActionOutcome` | Actions (E59), a feature (attached where it is used — `useAction`): requests that do not navigate — no history entry, nothing in the page cache, no progress bar, no events. `x-marmeon-action` + `Accept: application/json`, XSRF for writes, `redirect: 'manual'`, `cache: 'no-store'`; the server answers data (`this.json()`), 422 with field errors, or `204` + `x-marmeon-redirect` for a redirect (reported, not followed; `onRedirect: 'visit'` follows). Ends `data \| redirect \| invalid \| exception \| cancelled` — never rejects, never retries (401/419 after signing out are an `exception`). Calls run side by side; `key` makes a newer one cancel the older; `signal` aborts. A 409 + location (signed out through it) leaves the document |
| `{ target: navigator.use(optimistic).target(entry), patch }` (the page on screen: `.page`), `layer.optimistic`, `region.optimistic` → `OptimisticUpdate` | Model 1 (E59) — the `optimistic` feature holds the pages' patches (attached where a page's patch is made — React: `router.optimistic`): a patch of the props of the page on screen (its history entry), a layer or a region — shown at once **over** the props in memory (`layer.view`, `region.snapshot.region`, the page handed to `render`), never written into them: the page cache and `history.state` never hold it. Rolled back when the action (or a form's visit: `visit({ optimistic })` — the core applies those, of any target) fails; a patch is a function of the props beneath it, so several on one list compose and a failure takes only its own out |
| `{ target: navigator.use(optimistic).page, spec }`, `layer.reloading`, `region.reloading` → `Reloading` | What an action reloads once it succeeded (`only`/`except`/all), in the background, **replacing** what it brings — merged props too (`ReloadSpec.reset`, default all; `[]` merges, see [Merged props](#merged-props-revalidations-replace-load-more-appends-w9)): its patches on that target go in the same update the server's props land in; reloads of one target replace each other (an older answer never lands last); a patch on a target that does not reload becomes its state |
| `navigator.use(actions).submissions()` → `Submissions` (`list` + `subscribe`) | Model 2 (E59): actions and route forms (`visit({ name })`) under way, with their input — ghost rows, listed from when the feature is attached (where they are shown) until their reloads have landed |
| `navigator.use(liveValidation).validate(url, request)` / `.form(url, options)` → `LiveValidation`; `liveValidationOnFirstUse(navigator, url, options)`, `navigator.load(loadLiveValidation)` | Live validation (E62), a feature loaded on first use (E74: its code is a chunk of its own — `liveValidationOnFirstUse` fetches it on a form's first change and replays what happened meanwhile; `cancel()`/`reset()` before then forget it): the form's own request (method, URL, body, XSRF) plus `x-marmeon-validate: name,email` — the server runs middleware, `authorize` and the schema, never the controller, and answers `204` or `422` (both with `x-marmeon-validated`) with the named fields' errors; anything else is an `exception` (a redirect, 403, 419, 429). Password fields (`/password/i`) and files are never sent. `LiveValidation` per form: `changed(field)` (touched; `on: 'change'` or a field showing an error checks after `debounce`), `blurred(field)` (checks the touched fields when this one was touched), `validate()`, `validating(field)`/`pending` + `subscribe`, `cancel()` (on submit), `reset()`; a newer check aborts the older, a field typed over drops its stale result. The adapter keeps the errors (`onResult`) |
| `navigator.on('flash', listener)`, `navigator.onFlash(key, listener)` — `FlashChannel` | Flash messages (E60, E67): every answer the user is shown may bring some — `PageObject.flash` (a page, a partial reload incl. polls and deferred groups, a layer), the `{ close, flash }` body of a layer's close, an action's `x-marmeon-flash` header. Each fires **once, by its id**, after what it came with is on screen: never again for a partial reload that delivers it again, Back/Forward or a page from memory (the core keeps no message with a page, none in `history.state`); the same message flashed twice has two ids. A message nobody listens to yet waits for the first listener of its key (the first page's). A prefetch answered `x-marmeon-flash-waiting` is not shown: the click asks the server, whose answer delivers them |
| `navigator.visiting` + `subscribeVisiting`, `isPending(name)`, `isCurrentLink(page, href, activeMatch)`, `matchesRouteName`, `dirtyPaths(initial, current)`/`isDirtyPath`, `markBusy(navigator)` | State for the UI (E64): the foreground visit under way (URL, method, route name), whether a route's visit or action is under way (`isPending`: the visit, and what a feature reports through its `pending` hook), whether a link is current (exactly the same URL — path and query in any order — or `activeMatch` against `PageObject.route`, `*` as wildcard), the leaves that differ between a form's start and now, and `aria-busy` on `<html>` while a visit runs (`markBusy`). The adapter renders them as `aria-current="page"` + `data-current`, `data-pending`, `data-dirty` |
| `navigator.use(guard).add(guard)` → lift, `isGuarded()` | The navigation guard (E64), a feature (attached where a component guards — `useBlocker`, a form's `guard`; a visit's own `confirm` is the core's, asked without it): while a `NavigationGuard` is registered (and `active()`), a visit that would take its level (the page, or its `layer`) off the screen asks first; Back/Forward is cancelled where the browser lets it (the `navigate` event, [The Navigation API](#the-navigation-api-e184)) and otherwise goes back at once to the entry it left (by the browser's key), asks, and goes again on "leave" (the History fallback: `history.go(-delta)` from its counted `index`); closing a layer asks; closing the tab or reloading gets the browser's own question (`beforeunload`). A form passes its own guard when it is sent (`ignoreGuards`). Background requests (partial reloads, polls, deferred, a reload of the same page) never ask, and a 409 that is not `version` (signing in or out) never asks and is never stopped |
| `navigator.confirm(confirm)`, `NavigatorOptions.confirm` (`ConfirmHandler`), `confirmRequest`, `accepted`, `nativeConfirm` | Asking the user (E64): `confirm` of a visit, an action or a form, and the guard's question (`kind: 'leave'`). The adapter's handler shows a `ConfirmRequest` (message, title, labels, `destructive`, `prompt` for type-to-confirm) and answers `true`/`false` — or the text typed; **the core** decides: a type-to-confirm question is a yes only for exactly that text. Without a handler: the browser's `confirm()`/`prompt()`; without those, a confirmation is a no and a guard lets go |
| `NavigatorOptions.revalidateOnBack(component)` + `navigator.use(revalidateOnBack)` | E58, a feature (React: `resolveModulePages` brings it and `<MarmeonApp>` attaches it — `ResolvePage.features`): what a view declares to reload when Back/Forward shows it from memory (`true` or prop names) — the page, a layer Forward opens again, an island of a restored entry (`RegionOwner({ onBack })`): shown at once, then reloaded in the background (no events, no progress bar). Never on a first load, a visit or a refetch |
| `navigator.use(remember).of(owner.entry)` → `Remembered`, `rememberable(value, include)` | Remembered state (E63), a feature (attached where a component remembers): per history entry (a page's owner, a layer's `layer.owner`: their `entry`) — the entry's slot `REMEMBERED`, next to its islands — **memory only**, never `history.state` or storage. Gone with the entry (evicted, a layer closed for good) and with the document (every 409, a reload — and another tab's sign-in, sign-out or language switch: [tab sync](#tab-sync-w8-step-8)). `rememberable` leaves out fields named like a password (always), a token, a secret or a card (`include` lets those in) and files, at any depth |
| once props (automatic) | E64: page objects with `onceProps` (+ `onceScope`) are kept by the navigator (`OnceStore`); every page request names what it holds (`x-marmeon-once`, `x-marmeon-once-scope`), the server skips those and the navigator puts them back before `render`. A page of another scope drops them; every 409 clears them |
| `visit(url, { viewTransition })`, `NavigatorOptions.viewTransition`, `loadViewTransitions` | View transitions (E185, [View transitions](#view-transitions-e185)): `document.startViewTransition` around the swap of a page, with its direction as a type (`forward`, `back`, `replace`) and the app's own (`{ types: ['slide'] }`) — per visit, or for every page change; skipped under `prefers-reduced-motion: reduce`, in a hidden tab and without the API. A chunk of its own the navigator loads before the first page change that asks for one; `'adapter'`: the adapter starts them (React's `<ViewTransition>`) |
| `visit(url, { instant: { component, props } })`, `navigator.load(loadInstant)` | Instant visits (E64), a feature loaded where an instant link renders (E74: a chunk of its own — a visit before it is there goes without its placeholder): `render(page, { placeholder: true })` with `{ component, props }` = the target view and what the link hands its placeholder — shown at once, the page when its answer lands; the history entry is pushed only then. Failed or cancelled: the page on screen again (scroll kept); Back during it cancels it; a page fetched ahead shows at once instead |
| `on('version', event)`, `newVersion` + `subscribeNewVersion`, `reloadForNewVersion()` | The asset-version 409 (E64, `x-marmeon-reload: version` — exactly that value): `event.preventDefault()` keeps the page (`newVersion` says where the full load waits; the user's next GET visit makes it); without it, unsaved changes nobody agreed to leave ask first (`event.unsaved`). Every other 409 (`history`: signing in or out, or no reason) is never cancelable and never asks |
| `formObject(entries)`, `defaultFormEntries(form)`, `formEntries(form)`, `restoreFormEntries(form, entries, names)`, `fieldPath(name)` | Uncontrolled forms (E64, `<Form>`): the data the server builds from a form's entries (bracket notation), where a form starts (its controls' defaults — "dirty"), its entries now, remembered entries put back, `links[0][url]` → `links.0.url` |
| `queryUrl`, `pageQuery`, `withoutDefaults`, `linkQuery`, `assertQueryPage` | Query helpers: a URL without the defaults, the page's query with them, a link's query for the page on screen, the "only on its route's page" check |
| `progressBar(options)` → `ProgressIndicator`, `showProgress(navigator, options)` | The progress bar (E82, opt-in): plain DOM, inline CSS-variable styles (CSP-safe), not for `async` requests, only for visits slower than `delay` (250 ms). `progressBar` is what an adapter takes (React: `createMarmeonApp({ progress: progressBar({ delay: 250 }) })`); an app without it carries none of its code |
| `createPoll(run, interval, options)` | Polling, paused while the tab is hidden |
| `tabSync`, `loadTabSync()`, `isTabSyncMessage`, `DEFAULT_SESSION_CHANGED_MESSAGE` | Tab sync (W8 step 8, E148/E149): the session's epoch between the tabs of a browser — `BroadcastChannel` hints, the server asked on `visibilitychange`/`pageshow`, a tab of another epoch leaves its document; `navigator.use(tabSync)` → `{ epoch, on('epoch', …), check() }`. A default of `createMarmeonApp` ([Tab sync](#tab-sync-w8-step-8)) |
| `readInitialPage()`, `rootElement(id)`, `hasServerMarkup(root)` | The hydration entry's first steps: the page from `#marmeon-page`, the root (also while streaming), hydrate or render |
| `loadPageMessages(page, messages)`, `pageLocale(page, messages)` | The page's messages in its `locale`, falling back to the server's `fallbackLocale` (`APP_FALLBACK_LOCALE`, sent with every page) — any loader with `fallback` and `load(locale, { fallback })`, e.g. `createMessageLoader` of `@marmeon/i18n/messages`. Load them before a page renders, in the browser and the SSR entry |
| `resolveRoute(manifest, name, params, query)` | A named route's URL and method from the manifest (`virtual:marmeon/routes`) |
| `prefetchWith(navigator, url, options)`; `navigator.load(loadPrefetch)` → `Prefetches` (`prefetch(url, options)`); `navigator.loaded(loader)` | Prefetching, a feature loaded with the first prefetch (E74: its code is a chunk of its own, fetched while the pointer rests on the link — before the click): GET only, `Purpose: prefetch`, `cacheFor`; a visit of the URL takes the page (or waits for its request); a write (a non-GET visit) drops every prefetched page, and so does leaving the document. A chunk that cannot load prefetches nothing. Once loaded, `navigator.loaded(loader)` hands a lazily loaded feature over at once: a press on a link prefetches before its click's visit, not a task later |
| `visitUrlOf(click, href, target)`, `prefetchTriggers`, `prefetchUrlOf`, `HOVER_PREFETCH_DELAY` | Which link clicks become visits (plain left clicks, same origin, no other `target`) and when links prefetch |
| `firstErrors(page)` | The first validation message per field (forms) |
| `TitleRegistry`, `defaultTitle` | The document title from the mounted head components — the last one wins, none → `template('')` |
| `isDevelopment()` | `process.env.NODE_ENV !== 'production'`, as bundlers replace it |

### Merged props: revalidations replace, load more appends (W9)

A prop the server marks `merge()` or `deepMerge()` is merged into what the page has on a partial reload — arrays appended
(matched on `matchOn` keys: an item with a known key takes the old one's place), objects merged one level (`merge`) or all the way
(`deepMerge`), and a paginator's `data` appended with the new `meta` (`merge({ data, meta }).matchOn('data.id')`). A key may be a
path into the items (`matchOn('user.id')`). What a page says about merging (`mergeProps`, `deepMergeProps`, `matchPropsOn`) is the
latest answer's for the props it brought — it never piles up over reloads.

Whether a reload merges depends on **where it comes from**, never on what it looks like (E183):

- **"Load more"** — a visit or reload with `data`/`query` (`<Link query={{ cursor }} only={['people']} preserveUrl>`,
  `reload({ data: { cursor }, only })`) — appends.
- **A revalidation** — an action's reload (`router.reloading({ only })`, `reconcile`), a live hint's, `revalidateOnBack` — replaces
  what it brings (`reset`): the server's answer is the state now, so a row deleted meanwhile is gone. A list that had loaded more
  starts over at its first page. `reloading({ only, reset: [] })` merges instead (appends, as before Wave 9); `reset: ['a']`
  replaces only `a`.
- A visit can say so itself: `reset: ['people']` replaces (a new sort or filter is another list).

A list in a GET's `data` is the key repeated (`reload({ data: { role: ['admin', 'owner'] } })` → `?role=admin&role=owner`) — what a
query schema reads as a list, and what `toSearchParams` writes; the key's earlier values in the URL are replaced.

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
   where a layer opens, and load it before rendering a document with `page.layers` (React: `createMarmeonApp` and the SSR entry).
   Actions (E59): render `layer.view` (not `layer.page`) and a region's `snapshot.region` — they carry the optimistic patches —
   and pass `revalidateOnBack` to the navigator (the adapter knows the views: React reads `View.revalidateOnBack`).
   Instant visits (E64): `render(page, { placeholder: true })` shows the placeholder of `page.component`'s view (React:
   `View.placeholder`) with `page.props` inside that view's layouts — never the view itself, and the page context stays the page
   on screen; no placeholder → nothing changes; one that resolves after a later render started is dropped. View transitions
   (E185): an adapter that starts them itself (`NavigatorOptions.viewTransition: 'adapter'`, React 19.3's `<ViewTransition>`) gets
   `render(page, { transition: types })` for a page change — render it in its transition with these types (React: `startTransition`
   + `addTransitionType`) and resolve, as always, once it is committed; any other adapter ignores it (the core starts the
   transition around the render then). Remembered state
   (E63): keep it with the entry of the level it renders in (`navigator.use(remember).of(owner.entry)`, a layer's `layer.entry`), keyed by
   the app (an island's apart). Forms without JavaScript (E64): `_method` for PUT/PATCH/DELETE (the kernel spoofs the method
   from a POST body, never from the query) and, when the page has one, `page.csrf` as `_token` — a browser's plain post passes
   by Fetch Metadata or `Origin` anyway (E143); the token is for a client that sends neither, and a guest's page has none.
   Asking (E64): pass `confirm` — a handler that shows the `ConfirmRequest` in the app's dialog (React: `createMarmeonApp({ confirm:
   ConfirmDialog })`) and answers yes/no or the text typed; the core compares it. Flash (E60): show messages from
   `navigator.on('flash')`/`onFlash(key)` — they fire after the answer is on screen, once; render nothing of them from props.
   On the server, `page.flash` may be rendered for browsers without JavaScript (`<noscript>`).
2. **Persistent layouts** (E35): `Page.layout = Layout | [Outer, Inner] | null`, a default per app; the same layout at the
   same depth stays mounted across visits. Error boundaries inside them (a page that throws shows the error page).
3. **Head management**: a head component that sets the title through a `TitleRegistry` and adds/removes its tags in the
   browser; on the server it records title and tags so the SSR entry returns them as `head`.
4. **The SSR renderer**: the app's `bootstrap/ssr.tsx` exports `render: SsrRender` (from `@marmeon/http/page`):
   `(page, { complete, onError, onWarning, signal, resolveIsland, resolveDeferred }) => Promise<{ html: string | ReadableStream<Uint8Array>; head?: string; streamedProps?: string[] }>`.
   It gets the page as the browser does (JSON values only), resolves with the shell (or, with `complete`, the whole page —
   bots), returns `html: ''` for pages that do not render on the server (`Page.ssr = false`), and **rejects** when the
   shell cannot render — the server then sends the document without markup and the browser renders the page. The server
   puts `head` into `<!--app-head-->`, `html` into `<!--app-html-->` and the page object into `<script id="marmeon-page">`.
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
5. **The hydration entry**: the app's `bootstrap/client.tsx` (injected into `index.html` by `marmeon()`): `readInitialPage()`,
   resolve the component and the messages of the page's locale **before** hydrating (so the markup matches), then hydrate
   `rootElement('app')` when `hasServerMarkup(root)`, else render into it. Where the browser has no Navigation API
   (`!window.navigation`: Safari before 26.2), load the History fallback in the same round trip and give it to the navigator from
   the start (`features: [await loadHistoryFallback()]` — React: `createMarmeonApp` does; E184).
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
   `usePending(name)`) is a row in `ROUTE_SINKS` of `@marmeon/vite` (or `marmeon({ routeSinks })` —
   [The route manifest](../vite/README.md#the-route-manifest-e57)). A layer link is `<Link
   route layer>` — `layer` is a flag, not a sink; a name that is only compared (`usePendingSubmissions(name)`) needs none.
   The client build ships only the names written out at a sink; a name built at runtime fails the build. Route names
   never come from props — the server sends URLs (`router.url()`).

Pages come from `virtual:marmeon/pages` (`marmeon({ pages })`, default `modules/*/views/**/*.tsx` —
[Virtual modules](../vite/README.md#virtual-modules)),
language files from `virtual:marmeon/lang` and the route manifest from `virtual:marmeon/routes`; the adapter brings its framework's Vite plugin
(`plugins: [marmeon(), react()]`).

### The Navigation API (E184)

Where the browser has it (Chrome 102+, Firefox 147+, Safari 26.2+), the navigator writes and follows the history through the
[Navigation API](https://developer.mozilla.org/docs/Web/API/Navigation_API) — `window.navigation`, no polyfill; elsewhere through
the History fallback (below) — the guide: [navigation, history and view transitions](../../docs/navigation.md). What changes for
an app:

- **Its own navigations only.** A visit commits its entry with `navigation.navigate(url, { state, history, info })` — the `info`
  marks it as the navigator's — once the answer is there (as before: the URL never shows a page that has not landed); the
  `navigate` event is intercepted (`scroll: 'manual'`, `focusReset: 'manual'`: scroll restoration and focus stay the navigator's
  and the adapter's), nothing loads. Back/Forward to one of its own entries (the same document, a state of its own) is
  intercepted too, and shown from memory or asked of the server. **Everything else stays the browser's:** a plain `<a href>`, a
  plain form, another site, an entry of an earlier document, an entry without the navigator's state (a fragment's, another
  script's `pushState`, one an older client wrote with the History API — never shown from what it holds). The `navigate` events
  of visits are visible to the app's own listeners (`info` set, `navigationType` `push`/`replace`).
- **`history.state` is `null`.** An entry's state is the Navigation API's (`navigation.currentEntry.getState()`) — positions only
  (E36), like before. Another script's `history.replaceState(…)` erases it: the navigator writes it again when the entry is left
  (Back, Forward, a visit), so Back to it still finds it.
- **The browser's loading indicator** shows while a Back/Forward runs (`navigation.transition`) — long only when the server is
  asked (an entry not in memory: after a reload, a session restore, a page memory let go of). Visits keep the app's own progress
  indicator: they commit after their answer (a navigation started before it — `precommitHandler` — is not built: it does not fit
  the budget, E186).
- **The guard** (E64, `navigator.use(guard)`): Back/Forward with unsaved changes is **cancelled** where the browser lets it — the
  same document, with a fresh user activation (a click or a key press shortly before), or from a script — and the URL never
  changes. Without an activation (the browser's Back after a while, **two Backs in a row**: the first uses the activation up) the
  browser goes, and the guard goes back at once to the entry it left (`navigation.traverseTo(key)`: the browser's key, right after
  a reload or a session restore too — no counted index), then asks; Leave goes again. So two quick Backs escape the cancel, never
  the guard; the address bar shows the other entry for a moment. Closing the tab or reloading still gets the browser's own
  question (`beforeunload`).
- **Layers** close by going back (`history.go(-n)`), as before — on both ways the traversal is the layers' own.

**The History fallback** (Safari before 26.2, browsers without `window.navigation`): the navigator writes `history.state` with
`pushState`/`replaceState` and follows `popstate`, counting every entry it writes (`index`); the guard undoes a Back the browser
already did with `history.go(-delta)`. It is a chunk of its own (`features/history-fallback.ts`, ≈ 0.6 KB gzip): an adapter loads it
only without the Navigation API, before the navigator writes its first entry (`loadHistoryFallback`, React: `createMarmeonApp`) —
never in a first download (the leak test). Without it and without the API the navigator still writes its entries with the History
API (development: `[marmeon:C13]`), but nothing follows Back/Forward. Old entries with whole pages (a client before E36) are asked
of the server there, never shown.

### View transitions (E185)

A page change can animate: `visit(url, { viewTransition: true })` (React: `<Link viewTransition>`, `router.visit(url, { viewTransition:
true })`), or every page change — `NavigatorOptions.viewTransition` (React: `createMarmeonApp({ viewTransition: true })`). The page is
loaded first; then only its **swap** runs in `document.startViewTransition({ update, types })`: the browser captures the old page,
the update renders the new one, and its history entry and its scroll position follow at once (after `updateCallbackDone`, before the
browser captures the new state — the new page is never shown at the old one's scroll, the old one never at the new one's). The
browser crossfades the two — its default; the framework ships no animation of its own.

- **Types**, for `:active-view-transition-type()` in the app's CSS: `forward` (a visit's new entry), `replace` (`replace: true`, a
  redirect back to the same URL), `back` and `forward` on Back/Forward — plus the app's own: `viewTransition: { types: ['slide'] }`.
  Back from a page a visit entered with its own transition (and Forward to it) animates alike, with its types.
- **What animates:** with the app's option, every visit that takes the page off the screen and every Back/Forward between pages — not
  a partial reload, "load more", a request in the background, a form that comes back with its errors (the page keeps its state);
  `viewTransition: false` leaves one out. A layer opening, closing or coming back by Back/Forward is no page change (its frame — a
  `<dialog>` — animates itself in CSS); a page change that takes the layers off the screen is.
- **Skipped** — the swap runs as without — when the user prefers reduced motion (`prefers-reduced-motion: reduce`: no transition at
  all, not just no animation — a transition freezes the page until the swap), in a hidden tab, and without the API (Chrome before
  111, Safari before 18, or without types — Chrome before 125, Safari before 18.2: none either).
- **Before it:** the navigation guard (E64) asks before the visit starts — a page change it stops starts no transition. A new
  visit skips the animation still running (`skipTransition()`): the page it showed is in place already.
- **Instant visits** (E64): the placeholder takes the page's place at once, without a transition; the transition runs from it to
  the page. An element shared by two pages (the same `view-transition-name`) moves only between pages — leave `instant` off a link
  whose target shares one.
- **Never two.** An adapter that starts transitions itself (`viewTransition: 'adapter'` — React 19.3's `<ViewTransition>`:
  `createMarmeonApp({ viewTransition: 'react' })`) gets the types with the render (`RenderOptions.transition`); the core calls no
  `startViewTransition` then. And without it, an adapter renders a page change as a plain update — React starts none beside the
  core's.
- **CSP:** nothing inline. The core sets no `view-transition-name` and adds no `<style>`; name elements in the app's stylesheet —
  or, per element (a list where each row has its own name), through the CSSOM (`element.style.viewTransitionName = …`, which a
  strict `style-src` allows; React's `<ViewTransition name>` does that during the transition). A `style` attribute in the server's
  markup is what a strict `style-src` blocks.

A recipe — the page sliding by direction, in the app's stylesheet with keyframes of its own (the web app's `styles/app.css` does the
same for the `page` group of its React views — `viewTransition: 'react'`, a `<ViewTransition name="page">` in its layout):

```css
::view-transition-old(root) { animation: 150ms ease-in both slide-out; }
::view-transition-new(root) { animation: 220ms ease-out both slide-in; }
html:active-view-transition-type(back)::view-transition-old(root) { animation-name: slide-out-back; }
html:active-view-transition-type(back)::view-transition-new(root) { animation-name: slide-in-back; }
```

The code is a chunk of its own (`features/view-transitions.ts`, ≈ 0.8 KB gzip): the navigator loads it before the first page change
that asks for one; an app that never asks carries only its loader (the leak test).

### Features

An app pays in the browser only for what it uses (Wave 5c, E70–E75). The navigator alone is the **fixed core**; everything
optional is a feature (`defineFeature`) that is attached where it is used — no app configuration, no list to keep in sync.
Nothing is attached by default (`NavigatorOptions.features` is empty). A feature comes in one of three ways:

| How | Features | Attached by (React) |
| --- | --- | --- |
| **Where it is used** — a static import of the hook or component that uses it, attached on its first use (`navigator.use`) | query state, remembered state, actions + submissions, the navigation guard, islands, `revalidateOnBack`, the progress bar (E82), the client hook API (E132), row selection (W9) | `useQueryState`; `useRemember`, `useForm({ remember })`, `<Form remember>`; `useAction`, `usePendingSubmissions`; `useBlocker`, `useForm({ guard })`, `<Form guard>`; `<Island>`, `useIsland`; `resolveModulePages` (`ResolvePage.features`, attached by `<MarmeonApp>`); `createMarmeonApp({ progress: progressBar() })`; `useFeature(hooks)`; `useTable` (`@marmeon/react/table` — its actions load with a table's first run) |
| **Lazy, on first use** (E74) — a chunk of its own, fetched when a prop or an option asks for it (`navigator.load(loader)`) | live validation, prefetching, instant visits, the layers where they open, uploads (W6.9), the page's optimistic patches (W9: `loadOptimistic`), view transitions (W9, E185: the navigator loads them before the first page change that asks for one) | `useForm(…, { validate })` on a form's first change (what happens meanwhile is replayed); `useRouter().optimistic`/`.reloading` on the first call (`laterTarget` holds what is asked until the chunk is there); `<Link prefetch>`/`router.prefetch` with the first prefetch; a `<Link instant>` when it renders; a `<Link layer>` when it renders; a `<FileInput>` when it renders (`loadUploads`); view transitions: the navigator itself, before the first page change a visit, a `<Link viewTransition>` or `createMarmeonApp({ viewTransition })` asks for |
| **Lazy, by default** (E149) — `createMarmeonApp` loads it beside the first page, before hydrating, and attaches it from the start | tab sync (W8 step 8); the History fallback (W9, E184 — only without the Navigation API) | `createMarmeonApp` (`tabSync: false` leaves tab sync out — [Tab sync](#tab-sync-w8-step-8); the fallback: `!window.navigation` — [The Navigation API](#the-navigation-api-e184)) |
| **Lazy, triggered by the server** (E71) — the core loads it itself, because an answer may need it whatever the client imported | the layers, live props (W6.10) | layers: an answer that is a layer (E53: any visit may get one), a layer's request, Back/Forward to a layer's entry — and the adapter before the first render of a deep link (`createMarmeonApp`, the SSR entry); live props: a page, a layer or an island that follows a channel (`PageObject.live`) — and `useLiveUpdates()` where it renders |

The core itself loads uploads with progress (`FormData` with a progress listener, over XHR) with the first such upload — a
chunk that cannot load sends it with `fetch`, without progress. Polling (`createPoll`), `<Form>` and pagination are plain
modules, in an app when it imports them.

**Uploads (W6.9)** are a feature like these: `<FileInput field={form.field('avatar')} />` loads it where it renders. A chosen
file goes ahead of its form — a target from the form's own route (`x-marmeon-upload: <field>`: its middleware and `authorize`
run, its `upload()` rule sets the limit), then the bytes with progress (XHR) to that target — and the field holds an `Upload`:
`status`, `progress`, a `blob:` `preview`, `error`, `cancel()`. The form sends its token, never the file. The uploads under way
and their tokens live **only in the feature's slot of the document**: the `Upload` a form holds reads its token from there when
it is serialized (`toJSON`), so a 409 (signed out, a new build) aborts every upload and leaves no token anywhere — the `Upload`
on screen then sends `""`. It is a function object on purpose: remembered input (E63) leaves functions out, so an upload is
never remembered. Its state is on the value (`form.data.avatar?.progress`): `form.progress` stays the progress of a visit with
`FormData`.

**Live props (W6.10, [@marmeon/live](../live/README.md))** are a feature the server triggers, like the layers: a page object
(a page, a layer's, an island's region object) with `live` — the channels it follows, each signed for the session — makes the
core attach `live` (its chunk is loaded then; an app whose pages follow nothing never loads it). The feature opens **one**
`EventSource` per document for every channel on screen (`GET /_marmeon/live`, see the protocol), switches it when what is on
screen changes, and turns each hint into a partial reload of what follows the channel — hints that come in a burst (250 ms
quiet, at most 2 s) into **one** reload per page, layer or island (`navigator.reload`, `layer.reload`, `region.reload` with
`only` and `reset`: a hint is news, so what it reloads replaces merged props — see [Merged props](#merged-props-revalidations-replace-load-more-appends-w9)). Every request of the document names it (`x-marmeon-connection`: visits through the `start` hook, actions and live
validations through the `send` event), so the server leaves a tab out of the hints its own writes cause. While a guard holds
(unsaved changes) nothing reloads: `navigator.use(live).updates` (`pending`, `apply()`, `subscribe`; React: `useLiveUpdates()`).
The connection rule (E104): always connected, except a page loaded over HTTP/1.1 or an unknown protocol (`nextHopProtocol`) —
then only while the tab is visible ([Robust streams](../live/README.md#robust-streams-e104)); whenever a stream comes back,
`hello` compares each channel's sequence with the last one seen and what moved reloads once. The stream, the sequences and the
hints waiting live **only in the feature's slot of the document**: a 409 closes the stream and forgets them.

**The client hook API (E132)** is a feature too — the core's budget does not hold even two events, and no limit is raised for
them: `navigator.use(hooks)` (React: `useFeature(hooks)`, in a component that renders in the browser). Typed events across every
visit, for analytics, an error tracker or a rule of the app's own:

```ts
const api = navigator.use(hooks);
const stop = api.on('before', (event) => {               // every visit (visit, reload, a link, a form, a poll, a layer's) —
  if (new URL(event.url).pathname.startsWith('/admin')) event.cancel();   // after its own `confirm`, before the guard asks and
});                                                       // before its request: cancelled, nothing is sent, no event fires
api.on('invalid', (event) => console.table(event.errors)); // a visit's answer with validation errors: { errors, url, method, name }
```

`before` gets `{ url, method, options, layer, cancel(), cancelled }` (the options are read-only); Back/Forward, prefetches, deferred
props, islands and actions are no visits and pass no `before`. `invalid` is the visits' `error` event as an object; an action's 422
comes with its outcome (`useAction`). Listeners are wiring, never data — the feature keeps nothing an event carried.

**Development hooks (W7 step 9).** [The in-page bar](../devtools/README.md#the-in-page-bar) of `@marmeon/devtools` attaches
the `devtools` feature (exported here, used by nothing else) through `globalThis.__MARMEON_DEVTOOLS_HOOK__`, which its client
sets before the app starts. The core and the React adapter call that hook only under an inline
`process.env.NODE_ENV !== 'production'` — when a navigator is made, when optimistic patches are applied, shown, folded in or
taken out, and for hydration errors — so a production build drops the calls (the leak test checks no chunk names the hook, and
the budgets are unchanged). What the feature records stays in slots of the document (E36).

**The progress bar is opt-in (E82):** `createMarmeonApp({ progress: progressBar({ delay: 250 }) })` — the starters (blank-app,
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
createMarmeonApp({ resolve, progress: spinner });
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
helper — the first `import()` of any client build brings it, so it is no framework code). Wave 9 set every limit once to the
measured size + 0.5 KB (E186) — the reserve stays: a saving lowers a limit to the new size + 0.5, extra cost eats the reserve and is
never refilled. The limits now (KB gzip): core 11.57, `emptyApp` 14.08, `minimalApp` 18.61, `table` 17.46, `blank-app` 14.57,
`web-app` 22.82 and `docs` 17.48 (both lowered by the Navigation API step), the `everything` ceiling 31.62. They only go down:

| Scenario | What |
| --- | --- |
| `core` | the client core as an adapter uses it: the navigator, the document, links, forms, routes, titles, messages |
| `emptyApp` | `createMarmeonApp` alone — an app without a page |
| `minimalApp` | `createMarmeonApp`, `Link`, `useForm`, `usePage`, `Head` |
| `everything` | all of `@marmeon/react` — its main entry (subpaths with optional peers are not part of it); a ceiling, not a ratchet |
| `table` | `createMarmeonApp` and `useTable` (`@marmeon/react/table`, W9 step 6) — its limit from its first measurement (E186) |
| `blank-app`, `web-app`, `docs` (`appsGzipKB`) | the real apps' client builds: the marginal cost of core + adapter in the initial load (what the download loses without their bytes) |

- `bundle-size.test.ts` (part of `pnpm test`) builds the scenarios and fails when one grows over its limit — and when one is
  more than 0.6 KB under it, until the limit follows (`MARMEON_SIZE_BUDGET=update` lowers limits in place to the measured
  size + 0.5 KB, never raises them). Limits only go down: raising one is a decision on record (E78, E79, E81, E186), not a fix.
  The same test is the **leak test**: every feature has markers (its modules) and must be in a bundle only with its own
  import — a lazy one only in a lazy chunk (`stillLeaking` is `[]` in every scenario).
- `pnpm size` attributes every byte of the scenarios and of the real apps to its module (source maps), prints the marginal cost
  of core + adapter, and checks the apps against `appsGzipKB`; `pnpm size web-app` lists every module. Both measure `dist/`:
  run `pnpm build` first.
- `marmeon()` splits an app's first download into two chunks — `vendor` (third-party packages) and `index` (the framework with the
  app's entry): `CLIENT_CHUNKS` of `@marmeon/vite`, initial modules only, so what loads on first use stays in its own chunks.
  The scenarios are built the same way.

### Tab sync (W8 step 8)

E148, E149, E165 — closes E66. Tab sync is the feature `createMarmeonApp` attaches by default (`tabSync`, a chunk
of its own the adapter loads beside the first page). Without it, a tab kept what it showed — pages in memory, islands, pages
fetched ahead, once props, remembered input — after another tab of the browser signed out, until its own next request; the 409 of
a sign-out reaches only the tab that made it. With it:

- **The session's epoch.** Every page object carries `epoch` (`PageObject.epoch`): an HMAC — keyed from `APP_KEY` (HKDF,
  `session-epoch`) — over the session's generation (`PageSession.generation()`: the session's scope and the user's id, for a
  signed-in user; nothing for a guest), and the locale. Opaque: it changes when someone signs in or out, the session is
  regenerated or the language changes, and stays the same for flash messages and every other write. A guest's failed sign-in
  (a session for its errors) changes nothing.
- **A hint between tabs.** A tab posts `{ v: 1, epoch }` on a `BroadcastChannel` (`marmeon`) when it starts and when an answer
  of its own brings a new epoch (a sign-in by the remember-me cookie). Nothing else is ever posted — no props, ids or tokens; a
  message of any other shape is ignored without a request. The sender never hears its own message.
- **The server's word.** A tab that hears another epoch than its own asks `GET /_marmeon/session` → `{ "epoch": "…" }`
  (`no-store`, read-only: it starts no session, writes none, extends none, takes no flash message, sets no cookie). So does a tab
  that becomes visible again (`visibilitychange` — a hidden or frozen tab may have missed the message) or comes back from the
  back/forward cache (`pageshow` with `persisted`). Only an epoch that differs there changes anything: a stale tab's message
  reloads nobody.
- **Then it lets go.** The tab leaves its document — the core's `leave`, as for a 409: every slot of every feature emptied,
  every request aborted, the live stream closed — and loads the page again; the server shows what this browser may see now (the
  login page, the new language). `navigator.use(tabSync).on('epoch', ({ previous, next, origin: 'self' | 'tab' | 'server' }) =>
  …)` hears it first (E132's hook API as the feature's own; React: `useFeature(tabSync)`).
- **Unsaved changes stay.** With a navigation guard holding (a dirty form), the page stays: pages fetched ahead are dropped, and
  the user is asked — once the tab is visible — whether to load it again (a `leave` request with `reason: 'session'` to the
  app's confirm dialog, `DEFAULT_SESSION_CHANGED_MESSAGE` by default). No, and the next answer of the server takes the new epoch
  over; Back or Forward meanwhile loads from the server. Meanwhile the live stream ([live props](../live/README.md#robust-streams-e104)) is paused — no
  stream, no reconnect, no reload — until a page of the new epoch is on screen (the event `stale` of the feature host: `true`
  when the page stays, `false` once the new epoch landed).
- **History.** Every entry holds the epoch it was written under (its state's `epoch`: a field with a value —
  `host.history.field('epoch', check, value)`, the writer asks for it with every entry it writes; a position, never data — E36).
  Back or Forward to an entry of another epoch loads the page from the server, never from memory.
- **Flash messages stay with their tab.** Every request of a tab names its document (`x-marmeon-document`, random per
  document); the server binds a flash message to the document whose request flashed it, and another tab's request — a poll, a
  visit — leaves it waiting (E165). A request naming none (the full page load after a 409) takes every message.
- **On sign-out the browser's storage goes too.** `Auth.logout()` answers with `Clear-Site-Data: "cache", "storage"`: the site's
  HTTP cache, `localStorage`, `sessionStorage`, IndexedDB and service workers, in every tab (`ClientHistory.clear({ siteData })`
  — `['cache']` for the cache alone, `false` for none; never `"cookies"` or `"executionContexts"`). Remembered input (E63) never
  is in storage — it is memory, emptied by tab sync; what an app keeps in storage itself is gone after a sign-out (take it back
  with `history.clear({ siteData: ['cache'] })` after `logout()`), and an app that must not lose it across tabs keeps it on the
  server.

**Opting out** — `createMarmeonApp({ tabSync: false })` — brings back the known risk E66: a tab shows (and keeps in memory) what
the signed-out user saw until its next request; Back in it may show pages from memory. Without `BroadcastChannel` (an old browser)
a tab still checks when it becomes visible.

### Error codes

A mistake in app code (a hook outside its app, a page with a broken export, a route the browser does not know) throws an
explanation in development: what is wrong and how to fix it. A production build carries only a code and a name, such as
`[marmeon:R2] users/Show`, so the explanations cost no download (E80). Both start with the same code: run the app in
development to read the whole message, or look the code up here. The core and every adapter keep their explanations
behind an inline `process.env.NODE_ENV !== 'production'`, which the bundler replaces, so the production bundle drops the text.
Without a bundler that replaces it, `process` does not exist in the browser; React needs that replacement anyway.

What is not a code: refusals a production log needs to read (an action, a live validation or a region that would go to
another site), a missing or broken page object in the document, and every text a user sees (the leave and new-version
questions, the error pages).

| Code | Where | Meaning (the development message says more) |
|---|---|---|
| C1 | `resolveRoute` | A route name, but no route manifest was passed (`createMarmeonApp({ routes })`). |
| C2 | `resolveRoute` | A route name the browser does not know (API, `.internal()` and `clientRoutes.except` routes never ship). |
| C3 | query state | Query state of a route used on the page of another route. |
| C4 | query state | Query state of a route without a query schema. |
| C5 | `createPoll` | A poll interval of 0 ms or less. |
| C6 | layers | A layer depth outside 1 to 10. |
| C7 | layers | Development only, a hint (`console.info`): the server answered with a layer (or Back/Forward went to one) before any code loaded the layers — they load now, one round trip. |
| C8 | layers | Development only, a warning: a deep link's document (`page.layers`), but the layers were not attached before the navigator took over the history — attach them before the first render. |
| C9 | tables (`@marmeon/table/client`) | A sort by a column the table's props do not offer as sortable (a database column, a hidden or an unsortable one). |
| C10 | tables | A filter the props do not offer, a select filter's value that is none of its options, or a search of a table without a searchable column. |
| C11 | tables | A page the table does not have, a page size not among its `perPageOptions`, or a next page where there is none. |
| C12 | tables | A row action, a bulk action or an export the props do not offer to this user. |
| C13 | the navigator | Development only, a warning: the browser has no Navigation API, and the History fallback was not attached before the navigator was made — it writes entries, but nothing follows Back/Forward. Pass it with the features: `features: [await loadHistoryFallback()]` (createMarmeonApp does). |
| R1 | pages | A page's `layout` is not a component or a list of them. |
| R2 | pages | No page of that name (no default export in `modules/<module>/views/…`). |
| R3 | pages | A page module without a default export. |
| R4 | pages | A page's `ssr` is not `true`, `false` or `'complete'`. |
| R5 | pages | A page's `placeholder` is not a component. |
| R6 | pages | A page's `revalidateOnBack` is not `true`, `false` or a list of prop names. |
| R7 | `useAction` | An action submitted while rendering on the server. |
| R8 | `reloading({ islands })` | An island route the browser does not know. |
| R9 | hooks | A Marmeon hook outside `<MarmeonApp>`. |
| R10 | `useFeature` | A client feature used while rendering on the server. |
| R11 | `useRouter` | A visit while rendering on the server. |
| R12 | i18n hooks | A translation hook without the app's messages (`createMarmeonApp({ messages })`). |
| R13 | `<Head>` | `<Head>` inside an island (development only: production renders nothing). |
| R14 | layers, islands | An optimistic patch or reload while rendering on the server. |
| R15 | `useIsland` | `useIsland()` outside the view of an island. |
| R16 | `createMarmeonApp`, `<MarmeonApp>` | `progress` is not an indicator — since E82 it takes `progressBar({ delay })` (or the app's own); `{ delay }` and `false` are gone. |
| R17 | `<Pagination>` (a warning) | The page's query schema has no field for the page (`param`, default `page`) — its links would lead to the first page: spread `pageQuery()` into the route's query schema. |
| R18 | `useTable` | A table changed (sorted, selected, run) while rendering on the server — it renders from the props there, changes happen in the browser. |

## The protocol

What goes over the wire, in one place (constants in `@marmeon/http/page`). Every page and island request of the core
carries `x-marmeon-version` (the build — a new one answers 409); actions and live validations do not (they are no pages: a new
build shows with the next page request, a poll or a visit). Every write carries `X-XSRF-TOKEN` from the `XSRF-TOKEN` cookie when
the session has one (a guest without a session has none and needs none: the browser's `Sec-Fetch-Site`/`Origin` decide, E143) —
never a token from the URL (CSRF: [@marmeon/session](../session/README.md#csrf-protection)).

| Request header | Sent by | Meaning |
| --- | --- | --- |
| `x-marmeon: true` | visits, reloads, prefetches, regions | answer with the page object as JSON (Inertia's `X-Inertia`) |
| `x-marmeon-partial-component` / `-data` / `-except` | partial reloads, deferred groups, polls | only these props of this component — the server computes only what it sends (E7) |
| `purpose: prefetch` | prefetches | no side effects (the server's `isPrefetch()`); a prefetch never takes a flash message |
| `x-marmeon-region: island \| layer` | regions (with `x-marmeon`) | an island's region object (E48), a layer's request (E53); an island route without it is a 404 |
| `x-marmeon-action: true` | actions (without `x-marmeon`) | answered with data, never a page (406); a redirect becomes `204` + `x-marmeon-redirect`; always `no-store` (E59) |
| `x-marmeon-validate: a,b` | live validation (the form's own method, URL and body) | run middleware, `authorize` and the schema, never the controller; answer `204`/`422` for these fields only (E62) |
| `x-marmeon-upload: avatar` | an upload's target (the form's own method and URL, `{ name, size, type }` as JSON) — and `bytes` on the request that sends the file | run middleware, bindings and `authorize`, never the controller; answer `{ token, upload: { method, url, fields? } }` from the field's `upload()` rule (404 without one, 422 too large); read-only like a live validation, errors as JSON (W6.9) |
| `x-marmeon-once: k1,k2` + `x-marmeon-once-scope` | page requests | the once props held (by key) under that scope — skipped by the server for the same scope only (E64) |
| `x-marmeon-connection: <id>` | every request of a document that follows live channels (visits, actions, live validations) | which tab sent it: a live hint its write causes reaches that tab with `only: []` (W6.10) |
| `x-marmeon-document: <id>` | every request of a document with tab sync (visits, actions, live validations) | which document sent it: a flash message its request flashes waits for that document (or a full page load), never another tab's request (E165) |
| `Accept: text/event-stream` | the live stream (`EventSource`) | an event stream — read-only like an island: no session write, no cookie, no flash taken (W6.10); `GET /_marmeon/live` is read-only by its path too, with or without the header (W9) |

| Response header | Meaning |
| --- | --- |
| `x-marmeon: true` | the body is a page (or region) object |
| `409` + `x-marmeon-location` + `x-marmeon-reload: version \| history` | load that URL fully, every page in memory dropped (E36). Only exactly `version` (a new build, `CheckAssetVersion`) is cancelable — the `version` event; `history` (signing in or out, `ClientHistory.clear()` — it overwrites the reason on every 409 it makes) or no reason never is (E64) |
| `x-marmeon-region: island \| layer` | marks an island's region object or a layer's page object (and goes into `Vary`) |
| `204` + `x-marmeon-region-status: unauthorized \| forbidden` | an island that redirected / answered 401 or 423 / answered 403 — its fallback, never a navigation (E52); failures keep their status with `exception` |
| `x-marmeon-layer-close: true` | `closeLayer()` answering a layer's request: JSON `{ close: { layers, reload? }, flash? }` (E53) |
| `204` + `x-marmeon-redirect` | where an action's (or a live validation's) route redirected — reported, not followed |
| `x-marmeon-flash` | an action's flash messages, URI-encoded JSON (E60) |
| `x-marmeon-flash-waiting` | on a prefetch: messages wait for the page the user is shown — do not show this prefetch |
| `x-marmeon-validated: a,b` | on a live validation's `204`/`422`: the fields checked — a client trusts only an answer with it (a proxy's 422 shows nothing) |
| `Clear-Site-Data: "cache", "storage"` | on sign-out (`ClientHistory.clear({ siteData })`, E165): the site's HTTP cache and storage go, in every tab; `"cache"` alone for a language switch |

**The live stream (W6.10, [@marmeon/live](../live/README.md#configuration))**:
`GET /_marmeon/live?connection=<id>&c=<token>.<channel>&…` — one per document, for every channel its page, layers and islands
follow (`PageObject.live`: `[{ channel, only?, token }]`, the token an HMAC over the channel and a hash of the session id, E90).
Answered `200` with `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-store, no-transform` and
`X-Accel-Buffering: no`, or refused: `400` (no connection, no channel, too many — `LIVE_MAX_CHANNELS`), `401` (no session),
`403` (a token that does not fit: another channel, another session, one that ended — no stream at all), `429` + `Retry-After: 30`
(the session holds `LIVE_MAX_STREAMS_PER_SESSION` streams in this process already, default 16 — W9), `503` + `Retry-After`
(`LIVE_MAX_STREAMS` reached, the backend down, the server closing — a stream asked for while it closes never holds the shutdown).
The process's and the session's counts are taken atomically; a refused stream is asked for again after 30 s
(`LIVE_RETRY_REFUSED`). Its events: `retry: <ms>` first; `hello` —
`{ seq: { <channel>: n }, missed?: [<channel>] }` (each channel's sequence; `missed` after a reconnect with `Last-Event-ID`);
`refresh` — `{ channel, only, seq }`, a hint and never data (`only: null` — what each follower names; `[]` — nothing: this tab
caused it); `end` — `{}`, the session ended (signed in or out): do not reconnect; a comment line (`: heartbeat`) every
`LIVE_HEARTBEAT` seconds. Each `hello` and `refresh` carries `id:` — the sequences the stream has seen
(`users.7=4&dashboard.sign-ins=12`), what the browser sends back as `Last-Event-ID`.

**The session's epoch (W8 step 8, [Tab sync](#tab-sync-w8-step-8))**: `GET /_marmeon/session` → `200` `{ "epoch": "…" }` with
`Cache-Control: no-store`, in the `web` group, read-only (no session started, written or extended, no cookie, no flash message
taken). The tabs' channel: `BroadcastChannel('marmeon')`, messages exactly `{ v: 1, epoch }`.

**The upload endpoint (W6.9, [@marmeon/storage](../storage/README.md#uploads))**:
`PUT /_marmeon/uploads/<id>?expires=…&signature=…` — the URL the target answered with, signed for 15 minutes, in the `web`
group. The body is the file's bytes. Answers `200` `{ size }`, or: `403` (a signature that does not fit or expired), `404` (no
such upload, another session's, or past its lifetime), `409` (its bytes were sent already — one PUT per upload), `413` (more
than the field allows — cut off in the stream, whatever `Content-Length` said; nothing stays), `419` (no session), `400` (no
body). Uploads to S3 go to the store itself (a presigned POST) instead.

**The page object** (`PageObject`): `component`, `props`, `url`, `version`; `locale`, `fallbackLocale` (W5); `deferredProps`,
`mergeProps`, `deepMergeProps`, `matchPropsOn`; and from Wave 5b `query` + `queryDefaults` (the query as the server parsed
it, E55 — the browser never parses a URL), `streamedProps` (deferred groups streamed in the document, E49), `layer`
(`{ key, base, once? }`, E53) and `layers` (a deep link's document), `flash` (`[{ id, key, data }]` — a protocol field,
not a prop, E60), `route` (the answering route's name for `activeMatch`, never an `.internal()` one), `onceProps` +
`onceScope` (E64), `csrf` (for forms without JavaScript — only with a session: a guest's page has none and needs none, E143),
from Wave 6 `live` (`[{ channel, only?, token }]`, the channels it
follows — W6.10; a page's own and the shared ones, a layer's and an island's their own), and from Wave 8 `epoch` (the session's
epoch, opaque — tab sync). A region object (`RegionObject`) is a page object without
`locale`, `fallbackLocale`, `streamedProps`, `layer`, `layers` and `flash` — and without shared props.

**A history entry** (`HistoryState`) holds positions only, never props (E36): `component`, `url`, `key` (the entry's memory),
`scroll` and `scrollRegions` (named `regions` before W5b — still read), `layer` (`{ depth, below }`: the keys beneath a
layer's entry), `epoch` (the session's epoch it was written under — tab sync) and, in the History fallback only, `index` (where it
is in the tab's history — what lets the guard undo a Back there). With the Navigation API it is the entry's state
(`navigation.currentEntry.getState()`, written with `navigation.navigate(url, { state, info })` and `updateCurrentEntry`) and
`history.state` stays `null`; without it, `history.state` (E184).

**The server's side** ([@marmeon/server](../server/README.md#the-kernel)): the kernel answers islands and layers from the
same routes — `dispatchIsland` is what `resolveIsland` calls (a synthetic GET through the island route's middleware, read-only,
the page's session as a copy, `islandTimeout`), `dispatchLayerBase` resolves a layer's declared base for a deep link (the same
way, a chain up to `MAX_LAYER_DEPTH`; a base that turns the user away gives `layers/Backdrop`, E54). After the headers every
request is read-only (`ResponseLifecycle`); islands, live validations, uploads' targets, event streams and `/_marmeon/session`
are read-only throughout.
