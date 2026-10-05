# @bespokecore/react

The React adapter: components, hooks, layouts, error boundaries and `<Head>` — a **rendering layer** on the UI-free client
core `@bespokecore/http/client` (E39). Visits, the history, caching, prefetching, polling, islands, layers, actions and the
progress bar are the core's; this package renders them in React's idiom. What the core does and what an adapter owes it is
in [@bespokecore/http: the client core and the adapter contract](../http/README.md#the-client-core-and-the-adapter-contract),
what goes over the wire in [the protocol](../http/README.md#the-protocol) — this README is the React side.

```tsx
// modules/user-profile/views/People.tsx — the page `user-profile/People`, props typed by its controller
export default function People({ people }: PageProps<ListPeopleController>) {
  const t = useTranslation('user-profile');
  const [query, setQuery] = useQueryState('user-profile.people', { only: ['people'], debounce: 300, history: 'replace' });
  return (
    <main>
      <Head title={t('people.title')} />
      <input type="search" value={query.q} onChange={(event) => setQuery({ q: event.target.value })} />
      {people.data.map((person) => (
        <Link key={person.id} route="user-profile.show" params={{ user: person.id }} prefetch instant={{ name: person.name }}>
          {person.name}
        </Link>
      ))}
      <Island route="dashboard.sign-ins" query={{ limit: 3, range: 'all' }} fallback={<p aria-busy="true">…</p>} />
    </main>
  );
}
```

| Import | Runs in | What |
| --- | --- | --- |
| `@bespokecore/react` | browser and the SSR entry | `createBespokeApp`, components and hooks, `progressBar` |
| `@bespokecore/react/server` | server (the SSR entry) | `createSsrRenderer` — so `react-dom/server` never ends up in the client bundle |

## Installation

```sh
pnpm add @bespokecore/react react react-dom
```

- **Peers:** `react` and `react-dom` 19 come from the app. `@bespokecore/i18n` is an optional peer — needed only for
  `useTranslation`/`useLocale` (an app that does not translate gets neither it nor its session through discovery).
- **No provider:** `"bespoke": { "browser": ["src/**"] }` marks every source as browser code — discovery registers nothing
  for it, and `bespoke package:build` embeds no injection lists into it (E76). A test bundles the package for the browser and
  fails on any module outside its own sources, the client core, `@bespokecore/http/page` and `@bespokecore/router/url`, and on
  any npm package but React.
- **Vite:** the adapter brings React's plugin next to [@bespokecore/vite](../vite/README.md#virtual-modules)'s:
  `plugins: [bespoke(), react()]`. `bespoke()` serves the pages (`virtual:bespoke/pages`), the language files
  (`virtual:bespoke/lang`) and the browser's route manifest (`virtual:bespoke/routes`), adds `bootstrap/client.tsx` to
  `index.html` and builds `bootstrap/ssr.tsx`.

## Configuration

No environment variable and no config class: an app's React setup is its two entries and what they share. Both take the
same values — keep them in one place, as the web app does in `bootstrap/` — or the server's markup will not match:

```ts
// bootstrap/pages.ts — every modules/<module>/views/** component, code-split per page
export const resolvePage = resolveModulePages(pages);                 // pages from 'virtual:bespoke/pages'
// bootstrap/layouts.ts
export const layout: DefaultLayout = () => AppLayout;                // pages without their own `layout`
export { LayerFrame as layer } from '../layouts/LayerFrame.tsx';     // the frame around every layer
// bootstrap/head.ts
export const title: TitleTemplate = (page) => (page ? `${page} — BespokeCore` : 'BespokeCore');
// bootstrap/i18n.ts
export const messages = createMessageLoader(lang);                   // lang from 'virtual:bespoke/lang'
```

```tsx
// bootstrap/client.tsx
void createBespokeApp({ resolve: resolvePage, title, routes, layout, layer, messages, progress: progressBar({ delay: 250 }), confirm: Confirm });

// bootstrap/ssr.tsx
export const render = createSsrRenderer(resolvePage, { title, routes, layout, layer, messages });
```

| Option | Client | SSR | What |
| --- | --- | --- | --- |
| `resolve` | ✓ | ✓ (first argument) | page name → component — `resolveModulePages(pages)` |
| `routes` | ✓ | ✓ | `routes` of `virtual:bespoke/routes`: what `<Link route>`, `useRoute()` and `useForm(name, …)` resolve |
| `layout` | ✓ | ✓ | the default layout per page name (E35) |
| `title` | ✓ | ✓ | the title template: a page's `<Head title>` → the document title; default `defaultTitle` |
| `messages` | ✓ | ✓ | the language files; only the page's locale is loaded, before it renders |
| `layer` | ✓ | ✓ | the frame around every layer (E53); default `LayerDialog` |
| `progress` | ✓ | | a visit indicator (E82, opt-in): `progressBar({ delay: 250 })` or the app's own; none by default |
| `confirm` | ✓ | | the dialog that asks (E64): `ConfirmDialog` or the app's own; default the browser's `confirm()`/`prompt()` |
| `tabSync` | ✓ | | tab sync (W8 step 8, E149) — on by default; `false` leaves it out (the known risk E66: a tab keeps what it showed after a sign-out in another tab) |
| `rootId` | ✓ | | the element the server rendered into; default `app` |
| `onRecoverableError` | ✓ | | errors React recovered from while hydrating; default: the console, and in development the page's name and a notice on the page |

Whether the server renders at all is the server's: `SSR_ENABLED=false` of [@bespokecore/server](../server/README.md#configuration) sends
every page without markup.

## The entries

- **`createBespokeApp(options)`** reads the page object from the document and resolves, **before** hydrating, the page's
  component, the messages of its locale and — for a deep link with layers — the layer stack and the layers' views, so the
  first render matches the server's HTML — and, beside them, **tab sync** (E149): a chunk of its own, attached to the navigator
  from the start, so no other tab's sign-out is missed ([Tab sync](../http/README.md#tab-sync-w8-step-8); `tabSync: false` leaves
  it out). With server markup it hydrates, without (SSR failed, `ssr = false`) it renders.
  A hydration mismatch is reported to the console; in development with the page's name and a dismissible notice on the page.
- **`createSsrRenderer(resolve, options)`** returns the `SsrRender` the server calls per page. Pages stream
  (`renderToReadableStream`): the promise resolves with the shell and its `<Head>` content, Suspense boundaries follow in the
  stream. Islands and deferred props are resolved in-process and streamed into the same response (E49). A bot, or a page with
  `ssr = 'complete'`, gets the whole page at once; `ssr = false` renders no markup. An error in the shell rejects (the server
  sends the page without markup); an error in a boundary is reported, and the browser renders that boundary. A `<Head>` inside
  a boundary that streams after the head was sent is a warning in development.
  Under the app's Content-Security-Policy (E147) the server passes the response's nonce (`SsrRenderOptions.nonce`): React's
  inline scripts that reveal streamed boundaries (`$RC`) and its `<style>` tags carry it (`renderToReadableStream({ nonce: {
  script, style } })`), and so do a `<Head>`'s `<script>` and `<style>` children — without it, a strict policy would block the
  reveal and the boundaries would wait for hydration ([Content-Security-Policy](../http/README.md#content-security-policy-e147)).

## Pages and layouts

`resolveModulePages(pages)` maps `modules/user-profile/views/Show.tsx` to the page `user-profile/Show` — the name a controller
passes to `this.view()`. A page is the module's default export; its props are its controller's (`PageProps<Controller>` of
[@bespokecore/http](../http/README.md)). What a view declares, as statics:

```tsx
Show.layout = [AppLayout, SettingsLayout] satisfies PageLayout;       // outermost first; `null`: none, not even the default
Show.ssr = 'complete';                                               // true (default, streamed) | 'complete' | false
Show.revalidateOnBack = ['activity'] as const satisfies RevalidateOnBack<ShowUserProfileController>;   // E58
Show.placeholder = ShowPlaceholder satisfies Placeholder<ShowUserProfileController>;               // E64, instant visits
Edit.layer = 'slideover';                                           // as a layer: 'modal' (default), 'slideover' or a frame
```

- **Layouts persist** (E35): a layout the next page has too, at the same depth, stays mounted — its state and scroll survive
  the visit. A layout is `({ children }: LayoutProps) => …` and reads shared props with `usePage()`.
- **Shared props are missing on a 404 without a route.** A path no route matches passes no group's middleware — no session is
  started for it (a bot's scan creates none) and nothing is shared — yet the error page renders inside the default layout. Declare
  what the `web` group shares as optional and let the layout render without it (the web app and the `make:auth` templates do):

  ```tsx
  declare module '@bespokecore/http/page' {
    interface SharedProps {
      auth?: { user: { id: number; name: string } | null };   // optional: absent on the 404 of a path without a route
      locales?: readonly string[];
    }
  }

  const { auth, locales } = usePage().props;
  const user = auth?.user ?? null;                            // a guest's header on that 404
  {locales && <LanguageSwitcher locales={locales} />}
  ```
- **`revalidateOnBack`** — `true`, prop names, or none (default): what reloads in the background when Back/Forward shows the
  view from memory. `resolveModulePages` brings the feature (`ResolvePage.features`); `<BespokeApp>` attaches it.
- **`placeholder`** — what an instant visit shows at once, inside the target's layouts, with what the link hands it — typed
  by the controller's `declare readonly instant: { name: string }` (`{}` for nothing); never the page's props.
- **Built in until the app brings its own:** `errors/Error` (`ErrorPage`; the app's is `modules/errors/views/Error.tsx`) and
  `layers/Backdrop` (`Backdrop`, under a layer whose base is not shown, E54).
- Mistakes (a broken `layout`, `ssr`, `placeholder` or `revalidateOnBack`, a missing page or default export) throw with a code
  (`R1`–`R6`): see [error codes](../http/README.md#error-codes).

## Links and navigation

```tsx
<Link route="user-profile.show" params={{ user: profile.id }} query={{ tab: 'links' }} prefetch>Profile</Link>
<Link route="user-profile.edit" params={{ user: profile.id }} layer prefetch>Edit</Link>            {/* a layer, E53 */}
<Link route="user-profile.people" activeMatch="user-profile.people" instant>People</Link>           {/* current for any query */}
<Link route="auth.logout">Sign out</Link>                                                            {/* a POST: a <button> */}
<Link href="/lab/streaming" preserveScroll>Lab</Link>                                              {/* any URL, unchecked */}
```

- **Typed** against `bootstrap/routes.ts` (`bespoke route:types`): the name (an island route, an API route or an `.internal()`
  one is a compile error), the parameters (required when the path has required ones), `query` by the route's query schema
  (E55 — for the page on screen, fields at their default are left out), `only`/`except`/`reset` by the props of the route's
  page, `layer` only for routes whose controller answers `.layer({ base })`, `instant` by the target controller's `instant`.
- **Options:** `replace`, `preserveScroll`, `preserveState`, `preserveUrl` ("load more"), `async` (in the background),
  `confirm` (a message, or `{ message, title, confirmLabel, destructive, prompt }`: a no sends nothing), `only`, `except`,
  `reset`. A route of another method renders a `<button>` (`method`, `data`); actions are never prefetched.
- **Prefetching:** `prefetch` (`true`/`'hover'` — the pointer rests 75 ms or presses — `'mount'`, or both) and `cacheFor`
  (ms, default 30 000). Its code loads with the first prefetch.
- **State:** the link to the page on screen gets `aria-current="page"` and `data-current` — with `activeMatch` (a name,
  `user-profile.*`, `*`, or a list) for every page of those routes; the link being visited gets `data-pending`.
- **`useRouter<Controller>()`** — `visit(url, options)`, `reload({ only: ['stats'] })` (prop names checked), `prefetch(url)`,
  `on('start' | 'progress' | 'success' | 'error' | 'exception' | 'cancel' | 'finish' | 'version', listener)` (returns the stop
  function), and for actions `optimistic(patch)` / `reloading({ only, except, reset, islands })`.
- **`usePage()`** — the page object (`component`, `props` with the shared ones typed by `interface SharedProps`, `url`,
  `locale`, `flash` …); inside a layer, the layer's. **`useRoute()`** — `route('user-profile.show', { user: 7 })` → a URL.
- **`usePending(name, { delay: 'short' })`** — a visit or action of that route under way. **`useBlocker({ when, message })`**
  — the navigation guard (E64). **`useNewVersion()`** — a new build whose full load was postponed: `{ location, reload() }`.

## Forms

```tsx
// By route name (E40): method, URL and fields from the route — its request schema's input type
const form = useForm('user-profile.update', { user: profile.id }, { name: profile.name, bio: profile.bio }, { guard: t('unsaved'), validate: true, remember: true });
<input value={form.data.name} onChange={(e) => form.set('name', e.target.value)} onBlur={() => form.validate('name')} aria-invalid={!!form.errors.name} />
<button disabled={form.processing || !form.isDirty()} onClick={() => void form.submit()}>Save</button>
```

- **State:** `data`, `set`, `setData`, `errors` (the first message per field), `hasErrors`, `clearErrors`, `processing`,
  `progress` (an upload), `wasSuccessful`, `recentlySuccessful` (2 s), `isDirty(path?)`, `dirty` (the paths that differ),
  `reset(...fields)`; `submit(options)` with `onSuccess`, `onError(errors)`, `onFinish` and the visit options.
- **`guard`** (E64): while dirty, leaving asks first — a visit, Back/Forward, closing its layer; the tab gets the browser's
  question. **`validate`** (E62): `true` or `{ on: 'blur' | 'change', debounce, fields }` — fields are checked against the
  server's schema (`form.validate(field)`, `form.validating(field)`); password fields are never sent. **`remember`** (E63):
  the input survives Back/Forward, in memory only; passwords, token-, secret- and card-like fields and files are never kept.
- **By controller**, to any URL: `useForm<UpdateUserProfileController>(initial)` then `form.put(url)`.
- **`<Form route>`** — uncontrolled (E64): fields are named inputs read from the DOM, `form.field('abilities[]')` checks a
  name and gives `aria-invalid`; without JavaScript a real form with `_method` — and `_token` when the page has one (with a
  session; a browser's plain post passes by Fetch Metadata or `Origin` anyway, E143). `confirm`, `validate`,
  `guard`, `remember`, `resetOnSuccess`; a GET route's form writes its query.

```tsx
<Form route="auth.tokens.store" resetOnSuccess>
  {(form) => (
    <>
      <input {...form.field('name')} /> {form.error('name')}
      <input type="checkbox" {...form.field('abilities[]')} value="users:read" />
      <button disabled={form.processing}>Create</button>
    </>
  )}
</Form>
```

- **Uploads** (W6.9): `<FileInput field={form.field('avatar')} accept="image/png,image/jpeg,image/webp" />` uploads a chosen
  file at once; the field holds the `Upload` (`uploading`, `progress`, `preview`, `error`, `cancel()`) and the form sends its
  token. `useUpload(field)` for a drop zone of your own.
- **Asking:** `ConfirmDialog` (a native modal `<dialog>`, type-to-confirm) with the app's labels — `confirmLabel`,
  `cancelLabel`, `leaveLabel`, `stayLabel`, `promptLabel` — passed as `createBespokeApp({ confirm })`.

## Actions

Requests that do not navigate (E59), typed by the route — the body by its request schema, the result by what its controller
returns:

```tsx
const router = useRouter<ShowUserProfileController>();
const remove = useAction('user-profile.links.destroy');
await remove.submit({
  params: { user: profile.id, link: id },
  confirm: { message: t('show.remove_confirm', { label }), destructive: true },
  optimistic: router.optimistic((props) => ({ profile: { ...props.profile, links: props.profile.links.filter((link) => link.id !== id) } })),
  reload: router.reloading({ only: ['profile'] }),
});
const adding = usePendingSubmissions('user-profile.links.store');      // ghost rows: { id, input, method, url }
```

`submit` resolves with `{ ok, kind: 'data' | 'redirect' | 'invalid' | 'exception' | 'cancelled' }` and never rejects; `pending`,
`errors`, `exception`, `data`, `result`, `cancel()`. A `key` makes a newer call cancel the older; `onRedirect: 'visit'` follows a
redirect. Patches are typed against the page's props (a prop it does not have is named) and rolled back unless the call succeeds.
What `reloading` brings **replaces** what the page has — also a `merge()`d list that loaded more (Wave 9, E183): a row the action
deleted is gone, the list starts over at its first page. `reloading({ only: ['people'], reset: [] })` merges instead; "load more"
(`<Link query={{ cursor }} only={['people']} preserveUrl>`, `reload({ data: { cursor }, only })`) always appends. See
[Merged props](../http/README.md#merged-props-revalidations-replace-load-more-appends-w9).

## Props that arrive later

```tsx
<Deferred<ShowUserProfileController> data="activity" fallback={<p aria-busy="true">…</p>}>{() => <Activity items={activity!} />}</Deferred>
<WhenVisible<ShowUserProfileController> data="stats" buffer={100} fallback={<p aria-busy="true">…</p>}>{() => <Stats stats={stats!} />}</WhenVisible>
usePoll<ShowUserProfileController>(15_000, { only: ['activity'] });     // in the background, paused while the tab is hidden
```

- **`<Deferred data>`** — the fallback until the `defer()` props are there (also in the server's HTML).
- **`<WhenVisible>`** — loads `data` (or `params`, a whole reload) once scrolled into view; `always` for infinite scroll with
  `merge()` props; `buffer` in pixels; `as` the watched element.
- **`usePoll(interval, reloadOptions, { keepAlive, autoStart })`** — returns `{ start, stop }`.
- **`useQueryState(name, { only, debounce, history, reset })`** — typed URL state (E55): the page's query as the server parsed
  it, and a setter that changes it at once and visits after `debounce` ms. Only on that route's page; a route without a query
  schema is a compile error. A `set()` before the hook's effect ran (a child's effect on mount) is made once it has.
- **`<Pagination meta={…} window={2} param="page" labels={…} />`** — links to the pages of `paginate()`'s `meta`, built from the
  page's parsed query (E55: the route's schema with `pageQuery()` of `@bespokecore/database` — the search, the sort and the page
  size stay, the defaults stay out; never by parsing the address). Its texts are English; the page's language comes from the
  app's messages through `labels` (`{ navigation, previous, next, page: (n) => … }` from `useTranslation`, E38) — best in a small
  wrapper of the app, as the web app's `layouts/Pagination.tsx`. A query schema without the page's field warns in development (R17).
- **`useLiveUpdates()`** — live props (W6.10) reload by themselves; while a guard holds (a dirty form) they wait:
  `{ pending, apply() }`.
- **`useRemember(key, initial)`** — `useState` that survives Back/Forward (E63), per history entry, in memory only.

## Islands

A part of the page that is the view of another route (E48) — its own controller, middleware, authorization and query:

```tsx
<Island route="dashboard.sign-ins" query={{ limit: 5 }} fallback={<Skeleton />} />
<Island route="dashboard.activity" load="visible" poll={15_000} fallback={<Skeleton />} />
<Island route="dashboard.members" fallback={<Skeleton />} unauthorized={<p>Verify your address to see this.</p>} />
```

Props: `route` (an island route — its controller answers `this.island(…)`), `params`, `query`, `fallback`, `unauthorized`
(a redirect, 401 or 403 of its route — the page never navigates, E52), `error` (a node or `(retry) => node`), `load`
(`'eager'` | `'visible'`), `buffer`, `poll`, `keepAlive`, `as`. On a full load the server streams it with the page (E49); after a
visit it loads in the browser. Inside its view, **`useIsland<Controller>()`** gives `props`, `query`, `status`, `pending`,
`failure`, `reload({ query, only, except, reset })` (the query typed by its schema), `optimistic` and `reloading`. An island
cannot change the document head: `<Head>` inside one throws in development and renders nothing in production.

## Layers

A route whose controller answers `this.view(…).layer({ base: 'user-profile.show', params })` opens over the page on screen with
`<Link route layer>` — a modal or a slide-over with a history entry of its own: Back closes it, a deep link shows it over its base.
Forms inside submit as the layer; `closeLayer()` on the server closes it and reloads what is beneath.

```tsx
const layer = useLayer<EditUserProfileController>();     // isLayer, depth, isTop, key, once, close({ reload }), onClose(listener)
{layer.isLayer ? <button onClick={() => void layer.close()}>Cancel</button> : <Link route="user-profile.show" params={{ user }}>Cancel</Link>}
```

The frame is `LayerDialog` by default — a native modal `<dialog>`: focus kept inside and returned to the opener, Escape and the
backdrop close it, the page beneath inert. Wrap it for the app's label (`<LayerDialog {...props} closeLabel={t('close')} />`) and
pass it as `layer`; a view's own `layer` static wins. The layer stack is a chunk of its own, loaded where a layer link renders or
when the server answers with a layer (E71).

## Flash messages, head and translations

- **`useFlash('toast', (toast, { id }) => …)`** — every flash message of that key exactly once (E60), typed by the app's
  `interface FlashData`; in the browser only — on the server `usePage().flash` is what a `<noscript>` may show.
- **`<Head title>`** with `<meta>`/`<link>` children — rendered into the document head on the server, kept current on visits;
  the title goes through the app's `title` template (`(page) => …`, `page` undefined when no `<Head>` sets one).
- **`useTranslation('user-profile')`** — the messages of a namespace (a module, or `app` for `lang/`) in the page's locale,
  keys and placeholders checked: `t('people.last_seen', { when })`, `t.format.relative(iso, now)`, `t.format.date(…)`.
  **`useLocale()`** — `{ locale, format }`. Both need `createBespokeApp({ messages })` and [@bespokecore/i18n](../i18n/README.md#in-the-browser).

## Progress, errors and failures

- **The progress bar is opt-in (E82):** `createBespokeApp({ progress: progressBar({ delay: 250 }) })` — only visits slower
  than `delay`. Without it nothing of its code ships; `aria-busy` on `<html>`, `data-pending` and `usePending()` are there
  either way, and an indicator of your own is a function of the navigator (see [features](../http/README.md#features)).
- **An error while rendering** a page shows the app's `errors/Error` page inside its layouts (details only in development);
  a layout that throws shows it without layouts. The next visit tries again. A placeholder that throws shows nothing.
- **A failed visit** keeps the page and what was typed: offline is a notice, a 5xx the server's error page in a dialog over it.
  An island fails on its own (its `error`).
- **Codes, not explanations:** a production build throws `[bespoke:R2] users/Show`; development the whole explanation. The
  table of codes is [in @bespokecore/http](../http/README.md#error-codes).

## Client features

`useFeature(feature)` attaches a feature of the client core to the app's navigator on first use and returns its API — in a
component that renders in the browser (there is no navigator on the server):

```tsx
const api = useFeature(hooks);                                   // import { hooks } from '@bespokecore/http/client'
useEffect(() => api.on('before', (event) => { if (new URL(event.url).pathname === '/admin') event.cancel(); }), [api]);
```

Tab sync is attached by `createBespokeApp` already; `useFeature(tabSync)` returns its API — `on('epoch', ({ previous, next, origin
}) => …)` before a tab lets go of what it keeps (E132's hook API), `epoch`, `check()`. Its unsaved-changes question comes to the
app's confirm dialog as a `leave` request with `reason: 'session'` — the web app's `layouts/Confirm.tsx` words it in the page's
language.

The hooks and components above attach theirs the same way — an app pays only for what it uses. Which feature comes with which
hook, and which load lazily: [features](../http/README.md#features).

## The size budget (E75)

`size-budget.json` holds a limit per scenario in KB gzip of the initial download (`core`, `emptyApp`, `minimalApp`, the
`everything` ceiling, and the real apps' marginal cost in `appsGzipKB`), with the history of every change in its `$comment`.

- `bundle-size.test.ts` (part of `pnpm test`) builds the scenarios and fails when one grows over its limit — and when one is
  more than 0.6 KB under it, until the limit follows: `BESPOKE_SIZE_BUDGET=update` lowers a limit to the measured size + 0.5 KB
  and never raises one (E186: since Wave 9 every limit keeps that 0.5 KB reserve — a saving lowers the limit, extra cost eats the
  reserve, and it is never refilled). **Limits only go down;** raising one is a decision on record, not a fix.
- The same test is the **leak test**: a feature is in a bundle only with its own import, a lazy one only in a lazy chunk
  (`stillLeaking` is empty everywhere); no devtools code and no injection metadata ship; a production bundle carries codes,
  not explanations.
- `pnpm size` attributes every byte to its module and checks the apps against `appsGzipKB`; `pnpm size web-app` lists every
  module. Both measure `dist/` — run `pnpm build` first.

What each scenario holds and how they are measured: [features](../http/README.md#features).

## Testing

Pages are tested through the whole app with `createTestApp` of [@bespokecore/testing](../testing/README.md#server-rendering) — props typed by the controller:

```ts
await app.actingAs(ada).navigating().get('/people?q=TUR').assertPage<ListPeopleController>('user-profile/People', (props) => {
  expect(props.people.data.map((person) => person.name)).toEqual(['Alan Turing']);
});
```

With `createTestApp(application, { ssr: true })` pages render on the server through the app's Vite setup (every page complete,
islands included) — `assertSee(text)`, `assertServerRendered()`, `assertHydrates()` (rendered again from its JSON, the markup
must match); `ssr: 'stream'` renders as for a browser, `app.stream(path)` gives the raw response.
