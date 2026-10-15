# Navigation & View Transitions

## Introduction

A Marmeon app moves between pages without loading a new document. A `<Link>` asks the server for the next page's props, the
browser swaps the page in place, and the layout around it stays:

```tsx title="modules/notes/views/Index.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';
import type { ListNotesController } from '../controllers/ListNotesController.ts';

export default function Index({ notes }: PageProps<ListNotesController>) {
  return (
    <main>
      <Head title="Notes" />
      <ul>
        {notes.map((note) => (
          <li key={note.id}>
            <Link route="notes.show" params={{ note: note.id }} prefetch>
              {note.title}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

Each visit writes a history entry, so Back and Forward work as in any website. The entry holds the URL and the scroll position,
never the page's data. This page covers links and visits, prefetching, the history, what happens to unsaved changes when the user
leaves, and how to animate page changes with view transitions.

## Links

### Links to routes

`<Link route>` takes a route name, its parameters and its query, all checked against `bootstrap/routes.ts`:

```tsx
<Link route="notes.show" params={{ note: note.id }}>{note.title}</Link>
<Link route="notes.index" query={{ sort: '-updated', page: 2 }}>Recently edited</Link>
<Link href="https://example.com/help">Help</Link>
```

A typo in the name, a missing parameter or a query field the route's query schema does not have is a compile error. A link to the
page on screen leaves out query fields that are at their default. `href` takes any URL instead, unchecked. A link opens normally
when it is not a plain left click, when it leads to another site, or when its `target` is not `_self`.

`<Link route>` takes only routes that the browser may know and that render a page. An island's route, an API route and an
`.internal()` one are compile errors. The [URL generation](urls.md#in-the-browser) page explains which routes the browser knows,
and `useRoute()` for a URL without a link.

### Links that send

A link to a route of another method, such as `POST` or `DELETE`, renders a `<button>` that sends the request with the CSRF
token. The button sits in a real `<form>`, so it also works without JavaScript and before the app has started:

```tsx
<Link route="auth.logout">Sign out</Link>
<Link route="notes.archive" params={{ note: note.id }} confirm={{ message: 'Archive this note?', destructive: true }}>
  Archive
</Link>
```

`method` and `data` set the method and the body of an `href` link. `confirm` asks first, through the app's dialog: a message, or
an object with `title`, `confirmLabel`, `destructive` and `prompt`, a text the user must type. A no sends nothing.

Without JavaScript the browser posts the form, as it does for a [form](forms.md#without-javascript): `PUT`, `PATCH` and `DELETE`
travel as a hidden `_method` field, the page's CSRF token as `_token`, and the strings and numbers of `data` as hidden fields.
The token goes only to this site: a link whose `href` the browser reads as another origin, such as one with a scheme or `//`, sends
none.
With JavaScript, every request of a visit, a reload, an action, an island or an upload's first step goes to this site's origin,
even from a page whose path starts with two slashes. An answer that comes from another origin, such as a redirect followed to
another site, is never read as a page: a visit, a reload or a layer loads that address in the browser, and a prefetch or a
background reload drops it. An upload's target route must be on this site; its second step may go to a presigned URL elsewhere.
Other values of `data` go along with JavaScript only. A link with `confirm` never sends without asking, so without JavaScript its
button does nothing. With JavaScript the click sends the request once, as a visit, and the browser does not post the form as well.

The form has the class `marmeon-link`, and `@marmeon/react/styles.css` lays it out as if it were not there, so the button flows
with the text around it. Without that stylesheet the form is a block of its own. Give the button its look through `className`.

A link that sends is a form in the markup, so it cannot sit where HTML allows no form: not in a `<p>`, a heading, a `<span>` or
another element that holds only text, and not in another form or `<Form>`. The browser would move it out of a `<p>` while it reads
the page, and the page would not hydrate. Put it in a `<div>`, a list item or a `<nav>` instead:

```tsx
<div role="note">
  Not confirmed yet. <Link route="auth.verification.send">Send the mail again</Link>
</div>
```

`assertHydrates()` in a [page test](testing-pages.md#server-rendering) fails on such markup.

### The current link

The link to the page on screen gets `aria-current="page"` and `data-current`, so assistive technology announces it and your
stylesheet can mark it. It is current when its URL is exactly the page's URL, with the query in any order. `activeMatch` makes it
current for more pages:

```tsx
<Link route="notes.index" activeMatch="notes.*">Notes</Link>
<Link route="auth.security" activeMatch={['auth.security', 'auth.tokens']}>Settings</Link>
```

`activeMatch` takes a route name, a prefix with `*`, `*` alone, or a list of them, checked against your routes. A link whose visit
is under way gets `data-pending`.

### Link options

| Prop | Effect |
| --- | --- |
| `replace` | Replaces the current history entry instead of adding one. |
| `preserveScroll` | Keeps the scroll position. By default a new page starts at the top. |
| `preserveState` | Keeps the page's component state when the same page comes back. |
| `preserveUrl` | Keeps the address bar's URL, for "load more". |
| `async` | Runs in the background: no progress bar, and it cancels no other visit. |
| `only`, `except`, `reset` | A partial reload of the page on screen. See [deferred props](deferred-props.md#partial-reloads). |
| `prefetch`, `cacheFor` | Fetches the page ahead. See [prefetching](#prefetching). |
| `instant` | Shows the target's placeholder at once. See [instant visits](#instant-visits). |
| `layer` | Opens the page as a dialog over this one. See [dialogs](dialogs.md). |
| `viewTransition` | Animates this page change. See [view transitions](#view-transitions). |
| `confirm` | Asks before the visit. |

## Visiting from code

`useRouter()` visits without a link:

```tsx title="modules/notes/views/Search.tsx"
import type { PageProps } from '@marmeon/http';
import { useRouter } from '@marmeon/react';
import { useEffect } from 'react';
import type { SearchNotesController } from '../controllers/SearchNotesController.ts';

export default function Search({ results }: PageProps<SearchNotesController>) {
  const router = useRouter<SearchNotesController>();
  useEffect(() => router.on('finish', () => document.getElementById('results')?.focus()), [router]);
  return (
    <main>
      <button type="button" onClick={() => void router.visit('/notes', { replace: true })}>All notes</button>
      <button type="button" onClick={() => void router.reload({ only: ['results'] })}>Refresh</button>
      <ul id="results" tabIndex={-1}>{results.map((note) => <li key={note.id}>{note.title}</li>)}</ul>
    </main>
  );
}
```

- **`visit(url, options)`** takes the link options above, plus `method`, `data` and `headers`. It resolves with the page, or with
  `undefined` when the visit did not land.
- **`reload(options)`** asks the server for the page on screen again, keeping the scroll position and the component state.
- **`prefetch(url)`** fetches a page ahead.
- **`on(event, listener)`** listens to every visit and returns the function that stops listening. The events are `start`,
  `progress`, `success`, `error` (the answer brought validation errors), `exception` (offline or a server error), `cancel`,
  `finish` and `version`.

Only `http:` and `https:` addresses are loaded. A `visit()`, a link click, an action's redirect and a `409` with
`x-marmeon-location` that name any other scheme, such as `javascript:`, `data:` or `blob:`, load nothing, however the scheme is
written (`JavaScript:`, a leading space, a tab inside it): the browser's URL parser decides, never the first characters. In
development the console says which scheme was refused. A `409` from signing in or out that names such an address still ends the
document: the page on screen loads again, so nothing of the signed-in user stays in memory. A link that sends to such an address
renders a button that submits nothing, in a form without an `action`. A GET `<Link>` renders the `href` you give it as an
anchor, and the browser decides what a click does there (React neutralises `javascript:` URLs, and browsers block top-level `data:`
navigation), so check an address a user wrote before you pass it on. Another `https:` site is loaded.

With the controller's type, `useRouter<SearchNotesController>()` checks the prop names of `only`, `except` and `reset`. A visit
also takes the callbacks `onStart`, `onProgress`, `onSuccess`, `onError`, `onException`, `onCancel` and `onFinish` for itself.

## Prefetching

A prefetched page shows at once when the user clicks:

```tsx
<Link route="notes.show" params={{ note: note.id }} prefetch>{note.title}</Link>
<Link route="notes.index" prefetch="mount" cacheFor={60_000}>Notes</Link>
```

`prefetch` or `prefetch="hover"` fetches the page when the pointer rests on the link for 75 milliseconds, or presses it.
`prefetch="mount"` fetches it as soon as the link renders, and `prefetch={['hover', 'mount']}` does both. The page is kept for
`cacheFor` milliseconds, 30 seconds by default.

A prefetch is an ordinary `GET` of the route: its middleware, its authorization and its controller run, before the user has
clicked, and maybe without a click ever following. The request carries the header `Purpose: prefetch`, so the server can tell
it apart. A `GET` route must therefore never change anything, such as counting a view, marking a message read or redeeming a link:
do that in a `POST`.

Only `GET` links to whole pages are prefetched. A link with `only` or `except`, a link that sends, an action and an island never
are. Any request that writes, and leaving the document, drops every prefetched page. A prefetch never takes a flash message: the
click asks the server, whose answer brings it. The prefetching code loads with the first prefetch, so an app without `prefetch`
never downloads it.

## Instant visits

An instant visit shows the target page's placeholder at once, inside the target's layouts, and the page when its answer lands.
The controller declares what a link hands the placeholder, and the view brings the placeholder:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  declare readonly instant: { title: string };

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

```tsx title="modules/notes/views/Show.tsx"
import type { PageProps } from '@marmeon/http';
import { Head, type Placeholder } from '@marmeon/react';
import type { ShowNoteController } from '../controllers/ShowNoteController.ts';

export default function Show({ note }: PageProps<ShowNoteController>) {
  return (
    <main>
      <Head title={note.title} />
      <h1>{note.title}</h1>
      <p>{note.body}</p>
    </main>
  );
}

function ShowPlaceholder({ title }: { title: string }) {
  return (
    <main aria-busy="true">
      <Head title={title} />
      <h1>{title}</h1>
      <p>Loading…</p>
    </main>
  );
}
Show.placeholder = ShowPlaceholder satisfies Placeholder<ShowNoteController>;
```

The link passes the values: `<Link route="notes.show" params={{ note: note.id }} instant={{ title: note.title }}>`. A controller
that declares `instant: {}` takes `instant` alone. A link with `instant` to a route whose controller declares nothing is a compile
error.

The placeholder never gets the page's props, only what the link handed it. The history entry is written when the page lands. A
visit that fails or is cancelled shows the page on screen again, and Back during the visit cancels it. A page fetched ahead shows
at once without a placeholder. The code loads when the first instant link renders.

Only a plain `GET` visit of a page shows a placeholder. A link with `only` or `except`, a link with `layer` and a visit in the
background go as usual, without one.

## Showing that a visit runs

A new app shows a thin bar at the top of the window for visits slower than 250 milliseconds. It is the `progress` option in
`bootstrap/client.tsx`:

```tsx
void createMarmeonApp({ resolve: resolvePage, title, routes, messages, progress: progressBar({ delay: 250 }) });
```

`progressBar()` takes `delay` and `color`, and the CSS variables `--marmeon-progress-color`, `--marmeon-progress-height` and
`--marmeon-progress-z-index` style it. Visits in the background never show it. Leave the option out, and the app carries none of
its code.

Without the bar, every app still knows that a visit runs. `<html>` gets `aria-busy="true"`, the link being visited gets
`data-pending`, and `usePending(name)` tells whether a route's visit or action is under way:

```tsx
const saving = usePending('notes.update', { delay: 'short' });
<button disabled={saving} data-pending={saving || undefined}>Save</button>
```

`delay: 'short'` waits 150 milliseconds before it says yes, so fast requests do not flicker. An indicator of your own is a
function of the visit events that returns its stop:

```ts title="bootstrap/spinner.ts"
import type { ProgressIndicator } from '@marmeon/react';

export const spinner: ProgressIndicator = (navigator) => {
  const stops = [
    navigator.on('start', (visit) => visit.async || document.body.classList.add('loading')),
    navigator.on('finish', (visit) => visit.async || document.body.classList.remove('loading')),
  ];
  return () => stops.forEach((stop) => stop());
};
```

Pass it as `progress: spinner`. CSS alone also works: `html[aria-busy='true'] main { opacity: 0.6 }`.

## Back and Forward

### What the history holds

A history entry holds the page's URL, its component's name, its scroll positions and a key. A dialog's entry adds its depth and
the keys of the entries beneath it, and every entry carries the session's epoch, an opaque value that
[tab sync](client-features.md#tab-sync) compares. It never holds the page's props.
The props of the last 20 pages live in the tab's memory, so Back shows them at once. Back to a page memory let go of, after a
reload or a session restore for example, asks the server again, through the route, its middleware and its policies.

So what a user saw never lands on disk: not in the history's state, not in the browser's storage. The pages of a signed-in user go
out with `Cache-Control: no-store`, so the browser's cache does not keep them either. A route that sets its own `Cache-Control`
keeps that header, and then the browser may keep the page. When the user signs out in another tab, every
tab lets go of what it kept. The [client features](client-features.md#every-feature-forgets-on-sign-out) page explains how.

Where the browser has the Navigation API, `history.state` is `null`. Read the URL from `location` or from `usePage().url`, and
keep state of your own with `useRemember()`. When another script, such as an analytics snippet, calls `history.replaceState()`,
it erases the entry's state. The app writes it again when the entry is left, so Back still finds it.

### Scroll positions

Back and Forward restore the scroll position of the window and of every element with the `scroll-region` attribute:

```tsx
<aside scroll-region="">…</aside>
```

A new page starts at the top, unless the visit has `preserveScroll`.

### Reloading on Back

Back shows the page from memory, exactly as it was. A page whose data changes often can ask for some props again in the
background:

```tsx
Show.revalidateOnBack = ['note'] as const satisfies RevalidateOnBack<ShowNoteController>;
```

`true` reloads every prop, a list reloads those props, and leaving it out reloads none. The page shows at once and the reload
follows without a progress bar. A layer and an island can declare it too.

### Remembered state

`useRemember()` is `useState` that survives Back and Forward:

```tsx
const [tab, setTab] = useRemember('note-tab', 'body');
```

The value belongs to the history entry, in memory only. A reload, signing in or out, a new build and a language switch start
over. A key named like a password is a compile error, and so is one named like a token, a secret or a card, unless you pass
`{ sensitive: true }`. Inside a remembered value, fields named like a password, a token, a secret or a card are left out at any
depth, and so are files. A form can remember its input the same way, which the [forms](forms.md#remembering-input) page shows.

### The Navigation API and the fallback

| Browser | How the app follows the history |
| --- | --- |
| Chrome and Edge 102+, Firefox 147+, Safari 26.2+ | The Navigation API, built into the app's code. |
| Older browsers, Safari before 26.2 included | The History API, through a small fallback that loads only there. |

With the Navigation API, the app handles only its own navigations: the visits it starts, and Back and Forward between its own
entries. A plain `<a href>`, a plain form, another site and an entry another script added stay the browser's. Entry keys survive a
reload and a session restore, so Back after a reload is still the app's navigation. The browser's loading indicator shows while
Back or Forward asks the server.

`createMarmeonApp()` loads the fallback only when `window.navigation` is missing, together with the first page. No other browser
downloads it.

## Leaving with unsaved changes

A navigation guard asks before the user leaves unsaved changes. A form turns it on with `guard`, and `useBlocker()` turns it on
for anything else:

```tsx
const form = useForm('notes.update', { note: note.id }, { title: note.title, body: note.body }, { guard: 'Discard your changes?' });
useBlocker({ when: drawing.length > 0, message: 'Discard your drawing?' });
```

While the guard holds, a visit elsewhere, Back, Forward and closing the dialog it is in ask first, through the app's confirm
dialog. Closing the tab and reloading get the browser's own question, whose words a page cannot choose. The form's own submit
passes its guard. Background requests never ask, and neither does a sign-in or sign-out, which always loads the page anew.

What a page may stop is limited on purpose, so that no page can trap its user:

- **Back after a recent click or key press** is cancelled. The address bar never changes, and Stay keeps everything.
- **Back without one**, such as a Back long after the last click or the second of two quick Backs, goes. The guard brings the user
  back to the entry they left at once and then asks. The address bar shows the other entry for a moment.
- **Leave** goes again, a moment later.
- **In the fallback**, the browser has always moved already. The guard goes back by the counted number of entries, asks, and goes
  again on Leave.

So two quick Backs escape the cancel, but never the question. Live updates wait while a guard holds, and a sign-out in another
tab asks before it reloads this one.

## A new version of the app

When the server runs a newer build than the tab, its answer to the next visit says so, and the browser loads the page as a whole
document. With unsaved changes on screen, it asks first. An app can postpone that load and show a notice instead:

```tsx title="layouts/NewVersionBanner.tsx"
import { useNewVersion, useRouter } from '@marmeon/react';
import { useEffect } from 'react';

export function NewVersionBanner() {
  const router = useRouter();
  useEffect(() => router.on('version', (event) => event.unsaved && event.preventDefault()), [router]);
  const waiting = useNewVersion();
  if (!waiting) return null;
  return (
    <p role="status">
      A new version is available. <button type="button" onClick={() => waiting.reload()}>Load it</button>
    </p>
  );
}
```

`event.preventDefault()` keeps the page. `useNewVersion()` then returns `{ location, reload() }`, and the user's next visit loads
the new version anyway. Signing in or out also loads a whole document, and that load cannot be postponed.

## View transitions

A page change can animate with the browser's view transitions. Nothing animates until you ask for it.

### Turning them on

```tsx
<Link route="notes.show" params={{ note: note.id }} viewTransition>{note.title}</Link>
router.visit('/notes', { viewTransition: { types: ['slide'] } });
```

`viewTransition` on a link or a visit animates that page change, and Back from the page it opened animates alike. For every page
change, pass the option to the app in `bootstrap/client.tsx`:

| `createMarmeonApp({ viewTransition })` | What runs |
| --- | --- |
| `true` or `{ types: ['slide'] }` | The browser's view transition around each page swap. The browser crossfades the page. |
| `'react'` | Each page change renders in a React transition. React's `<ViewTransition>` components in your views animate. |

With the app's option on, `viewTransition={false}` leaves one link out. The code loads before the first page change that asks for
it.

### Animating in your stylesheet

The page loads first, and only the swap runs in the transition. Each transition has a type: `forward` for a new entry, `replace`
for `replace: true`, `back` and `forward` for Back and Forward, plus the types you pass. Your stylesheet animates by type:

```css title="styles/app.css"
::view-transition-old(root) { animation: 150ms ease-in both fade-out; }
::view-transition-new(root) { animation: 220ms ease-out both slide-in; }
html:active-view-transition-type(back)::view-transition-new(root) { animation-name: slide-in-back; }

@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
```

The keyframes are yours, and the framework ships none. Name the elements that should move in the stylesheet, with
`view-transition-name`. Never set the name in a `style` attribute, because a strict Content-Security-Policy blocks it. The
[styling](styling.md#no-style-attributes) page explains why. A name per element, such as one per row of a list, is set through the
CSSOM, which the policy allows: `element.style.viewTransitionName = 'note-7'`.

### React's `<ViewTransition>`

With `viewTransition: 'react'`, React animates only what is inside a `<ViewTransition>`. Wrap the page in your layout to animate
it as a whole, and give elements shared between two pages the same name:

```tsx title="layouts/AppLayout.tsx"
import type { LayoutProps } from '@marmeon/react';
import { ViewTransition } from 'react';

export function AppLayout({ children }: LayoutProps) {
  return <ViewTransition name="page">{children}</ViewTransition>;
}
```

```tsx
<ViewTransition name={`cover-${note.id}`} share="cover">
  <img src={note.cover} alt="" className="cover" />
</ViewTransition>
```

Animate the `page` group with `::view-transition-old(page)` and `::view-transition-new(page)`. In this mode React keeps the old
page until the new one is ready instead of showing a loading fallback, waits briefly for a new image inside a `<ViewTransition>`,
and waits for an async action of React's that is under way. React sets each name through the CSSOM during the transition, and its
server markup carries no `style` attribute, so a strict policy blocks nothing of it. React animates only elements inside the
viewport, so a list item scrolled out of view has nothing to share.

React also animates streamed parts of a page that appear while a `<ViewTransition>` is on screen. Those animations do not ask the
app, so the reduced-motion rule above is what stops them.

### When nothing animates

These page changes run without a transition:

- The user prefers reduced motion. No transition starts at all, because a transition freezes the page until the swap.
- The tab is hidden.
- The browser has no view transitions with types: Chrome before 125, Safari before 18.2.
- A partial reload, "load more", a background request and a form that comes back with its errors. The page stays, so nothing
  changes pages.
- A dialog opening or closing. Its frame can animate itself in CSS.

The navigation guard asks before the visit starts, so a page change it stops starts no transition. A new visit ends an animation
that is still running. The transition code is a chunk of its own, loaded before the first page change that asks for one, so an app
that never animates never downloads it.

### Instant visits and shared elements

An instant visit shows the placeholder at once, without a transition, and the transition runs from the placeholder to the page.
An element shared by two pages has no partner in the placeholder, so it does not move. Leave `instant` off a link whose target
shares an element, and use `prefetch` there instead.

## Browser support

| | Safari 26.2+ | Safari 18.2 to 26.1 | Safari 18.0 and 18.1 | Safari before 18 |
| --- | --- | --- | --- | --- |
| History | The Navigation API | The fallback | The fallback | The fallback |
| Unsaved changes | Back cancelled after a recent click, else undone and asked | Undone, then asked | Undone, then asked | Undone, then asked |
| View transitions | With types | With types | None | None |

The app's tests cover both the Navigation API and the fallback, and Chrome is tested in a real browser. Safari's support is taken
from the specifications it implements and is not yet confirmed in Safari itself. Wherever Safari behaves differently, the
fallback's rule still holds: the guard goes back first and then asks.
