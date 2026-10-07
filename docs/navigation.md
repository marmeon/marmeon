# Navigation, history and view transitions

A Marmeon app moves between pages without full loads: a link asks the server for the next page's props as JSON, the client
renders it and writes a history entry. This guide is about that history — how the client follows Back and Forward (through the
Navigation API, or the History fallback where a browser lacks it), what the navigation guard can and cannot stop, what is kept in
the browser's history and what never is — and about animating page changes with view transitions. The client core's README is the
reference: [the Navigation API](../packages/http/README.md#the-navigation-api-e184) and
[view transitions](../packages/http/README.md#view-transitions-e185); React's side: [links and navigation](../packages/react/README.md#links-and-navigation).

## What the history holds (E36)

**Never a page's data.** An entry holds its key, its URL and component, its scroll positions and the session's epoch (tab sync) —
nothing else. Props live in memory, per entry, for as long as the document lives; Back to an entry memory let go of (after a reload,
a session restore, a long session) asks the server again, through the route, its middleware and its policies. So what a user saw
is never on disk: not in `history.state`, not in session or local storage, and a signed-in page is `no-store` for the HTTP cache.

- **`history.state` is `null`** where the navigator uses the Navigation API: an entry's state is
  `navigation.currentEntry.getState()` — the positions above, nothing more. Code that read `history.state.url` reads `location`.
- Another script's `history.replaceState(…)` (an analytics snippet, a widget) erases that state; the navigator writes it again when
  the entry is left, so Back still finds it.
- Anything else in a state is dropped before it is written — in development it throws, so a client feature notices: a feature
  registers each position it adds (`host.history.field(name, check, value)`) and keeps what a page showed in memory.

## The Navigation API and the History fallback (E184)

| Browser | How the client follows the history |
| --- | --- |
| Chrome / Edge 102+, Firefox 147+, Safari 26.2+ | the **Navigation API** (`window.navigation`) — in the core, no extra code |
| Safari before 26.2 (iOS 18 included), older browsers | the **History fallback** — `pushState`/`popstate`, a chunk of its own (≈ 0.6 KB gzip) loaded only there |

With the Navigation API the navigator **intercepts its own navigations only**: a visit commits its entry with
`navigation.navigate(url, { state, info })` once the answer is there (the address bar never shows a page that has not landed), and
Back/Forward to one of its own entries is intercepted and shown from memory or asked of the server — the browser's loading indicator
shows meanwhile. Everything else stays the browser's: a plain `<a href>`, a plain form, another site, an entry of an earlier document,
an entry another script pushed. The `navigate` events of visits reach the app's own listeners too (`info` set, `navigationType`
`push`/`replace`) — a listener that intercepts every `navigate` leaves those alone.

Entry keys survive a reload and a session restore, so Back after a reload is still the app's own navigation (asked of the server,
no full load). Visits keep the app's own progress indicator; a navigation that starts before the answer (`precommitHandler`) is not
used.

`createMarmeonApp` loads the fallback only when `window.navigation` is missing, beside the first page's component — no first download
carries it. An adapter of your own does the same: `features: [await loadHistoryFallback()]` where `!window.navigation`
(development warns `[marmeon:C13]` when neither is there).

## The navigation guard and its limits

```tsx
const form = useForm('user-profile.update', { user: profile.id }, initial, { guard: t('unsaved') });   // while dirty
useBlocker({ when: dirty, message: t('unsaved') });                                                    // anything else
```

While a guard holds, leaving asks first — a visit, Back/Forward, closing its layer. What the browser lets a page stop is limited,
on purpose (a page must not trap its user), and the guard works within those limits:

- **Back with a fresh user activation** — a click or a key press shortly before, or Back from a script: the navigation is
  **cancelled**; the address bar never changes, the question comes, Stay keeps everything.
- **Back without an activation** — a Back a while after the last click, or **the second of two quick Backs** (the first used the
  activation up): the browser goes. The guard goes back at once to the entry it left — **by the browser's key**
  (`navigation.traverseTo(key)`), right after a reload or a session restore too — and then asks. The address bar shows the other
  entry for a moment. So **two quick Backs escape the cancel, never the guard.**
- **Leave** goes again — a task later (the browser refuses a traversal in the same task as a cancelled one).
- **Closing the tab or reloading** gets the browser's own question (`beforeunload`) — a page cannot word that one.
- **Layers** close by going back (`history.go(-n)`); the guard asks before a layer with unsaved changes closes.
- **The fallback** (no Navigation API): the browser has always moved when `popstate` fires; the guard goes back by the counted
  index (`history.go(-delta)`), asks, and goes again on Leave — the address bar always moves for a moment.

Live updates wait while a guard holds ([real time](realtime.md)); tab sync keeps a page with unsaved changes after a sign-out
elsewhere and asks.

## View transitions (E185)

A page change can animate — **only when the app asks** (E185, variant A): without the option nothing changes, not even how React
renders a page change.

```tsx
<Link route="user-profile.show" params={{ user: person.id }} viewTransition>…</Link>       // one link
router.visit('/people', { viewTransition: { types: ['slide'] } });                        // one visit, with a type of its own
createMarmeonApp({ /* … */, viewTransition: true });                                      // every page change: the core's
createMarmeonApp({ /* … */, viewTransition: 'react' });                                   // every page change: React 19.3's <ViewTransition>
```

**The core's** (`true`): the page is loaded first; then only its swap runs in `document.startViewTransition({ update, types })` — the
browser captures the old page, the update renders the new one, its history entry and scroll position follow at once. The browser
crossfades the two; the framework ships no animation.

**React's** (`'react'`): each page change renders in `startTransition` with its types added (`addTransitionType`); React starts the
transition for the views' `<ViewTransition>` components and the core starts none — **never two** for one page change. React animates
only what is inside a `<ViewTransition>`: wrap the page in the layout (`<ViewTransition name="page">{children}</ViewTransition>`). With
`'react'`, transition semantics apply: a page that suspends keeps the old one on screen until it is ready (instead of a fallback),
React waits briefly (up to ~0.8 s) for a new image inside a `<ViewTransition>`, and a page change waits for an async action of
React's under way.

**Types**, for `:active-view-transition-type()`: `forward` for a visit's new entry, `replace` for `replace: true`, `back`/`forward`
on Back/Forward — plus the app's own. Back from a page a visit entered with its own transition animates alike.

**What animates:** page changes — every visit that takes the page off the screen, every Back/Forward between pages. **Not:** a
partial reload, "load more", a request in the background, a form that comes back with its errors, a layer opening or closing
(its `<dialog>` animates in CSS). The guard asks before a visit starts — a page change it stops starts no transition. A new visit
skips an animation still running.

**Skipped** — the swap runs as without — under **`prefers-reduced-motion: reduce`** (no transition at all: a transition freezes the
page until the swap), in a hidden tab, and without the API. React reveals streamed Suspense boundaries in view transitions of its
own when a `<ViewTransition>` is on the page — those do not ask the navigator, so stop their animation in CSS (below).

### Recipes — in the stylesheet, nothing inline (CSP)

The core sets no `view-transition-name` and adds no `<style>`. Name and animate in the app's stylesheet; a `style` attribute in the
server's markup is what a strict `style-src` blocks. Per element (each row of a list its own name) set it through the CSSOM
(`element.style.viewTransitionName = …`), which a strict policy allows — React's `<ViewTransition name>` does exactly that during
the transition, and its server markup carries only `vt-name` attributes. From the web app's `styles/app.css` (linked from
`index.html`):

```css
/* The page (<ViewTransition name="page"> in the layout): forward it comes in from the right, Back from the left. */
html:active-view-transition-type(forward)::view-transition-old(page) { animation: 150ms ease-in both page-out-to-left; }
html:active-view-transition-type(forward)::view-transition-new(page) { animation: 220ms ease-out both page-in-from-right; }
html:active-view-transition-type(back)::view-transition-old(page) { animation: 150ms ease-in both page-out-to-right; }
html:active-view-transition-type(back)::view-transition-new(page) { animation: 220ms ease-out both page-in-from-left; }

/* A shared element — the avatar in the list and on the profile (<ViewTransition name={`avatar-${id}`} share="avatar">). */
::view-transition-group(.avatar) { animation-duration: 320ms; }

/* Reduced motion: the navigator starts none — this stops React's own Suspense reveals too. */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
```

With the core's mode name the root (`::view-transition-old(root)`) or elements of your own in the same way.

### Instant placeholders and shared elements

An instant visit (`<Link instant>`, E64) shows the target's placeholder at once — without a transition — and the transition runs
from the placeholder to the page. An element shared by two pages (the same `view-transition-name`, an avatar that moves from a list
into a profile) has no partner in the placeholder, so it does not move: **leave `instant` off a link whose target shares an element**
(the web app's person links prefetch but are not instant). React also animates only elements in the viewport — a list scrolled
away has nothing to share.

### Cost

The core's code is a chunk of its own (≈ 0.8 KB gzip), loaded before the first page change that asks for one; an app that never asks
carries only its loader.

## Safari

| | Safari 26.2+ | Safari 18.2 – 26.1 | Safari 18.0 / 18.1 | before 18 |
| --- | --- | --- | --- | --- |
| History | Navigation API (without `precommitHandler` — not used) | History fallback | History fallback | History fallback |
| Guard | cancels Back with an activation, else goes back by key | goes back by index, then asks | the same | the same |
| View transitions | yes, with types | yes, with types | **none** (the API without types — skipped, no error) | none |

What is proved where: the navigator's tests run on both paths (the Navigation API against a faithful fake, the fallback in
happy-dom), and Chrome is driven for real (cancelled and undone Backs with and without activation, Forward, reload, session restore,
the bfcache, view transitions with reduced motion). Safari's cancelable traversals, the `traverseTo` timing and its view transitions
follow the same specifications and are checked by hand before a release — if Safari behaves differently, the fallback rules above
(go back, then ask) still hold the guard.
