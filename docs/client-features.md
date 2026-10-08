# Client Features & Tab Sync

## Introduction

The browser side of a Marmeon app is a small core plus features. The core visits pages and follows the history. Everything else,
such as dialogs, actions, prefetching or live validation, is a feature that the app downloads only when a page uses it. You do not
list features anywhere: the hook or component that needs one brings it.

`useFeature()` gives a component a feature's API. The client hook API is one, for a rule of your own around every visit:

```tsx title="layouts/AdminGuard.tsx"
import { hooks } from '@marmeon/http/client';
import { useFeature } from '@marmeon/react';
import { useEffect, useState } from 'react';

/** Rendered in the browser only: on the server there is no navigator to attach a feature to. */
export function AdminGuard({ allowed }: { allowed: boolean }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <CancelAdminVisits allowed={allowed} /> : null;
}

function CancelAdminVisits({ allowed }: { allowed: boolean }) {
  const api = useFeature(hooks);
  useEffect(
    () =>
      api.on('before', (event) => {
        if (!allowed && new URL(event.url).pathname.startsWith('/admin')) event.cancel();
      }),
    [api, allowed],
  );
  return null;
}
```

This page lists which features load when, explains the hook API, and covers tab sync, the feature that keeps the tabs of one
browser in step when the user signs in or out.

## What loads when

A feature arrives in one of four ways:

| When | Features |
| --- | --- |
| With the code that uses it | Query state, remembered state, actions and ghost rows, the navigation guard, islands, reloads on Back, the progress bar, the hook API, table selection. |
| On first use, as a chunk of its own | Live validation, prefetching, instant visits, dialogs, uploads, optimistic patches, view transitions. |
| With the first page, by default | Tab sync, and the History fallback where the browser has no Navigation API. |
| When the server's answer needs it | Dialogs that the server opens, and live updates of a page that follows a channel. |

A chunk that loads on first use is fetched when its hook or component first renders or is first called. Prefetching, for example,
loads while the pointer rests on the first link with `prefetch`, before the click. Live validation loads with a form's first change,
and what happens meanwhile is replayed. So an app that never uses a feature never downloads it, and a page that uses it pays only a
moment's wait the first time.

Some parts are always there, because the server may send them to any request: visits, Back and Forward, scroll positions, the
pages kept in memory, flash messages, once props, deferred and merged props, and the full reload when the user signs in or out.

## Every feature forgets on sign-out

A feature keeps what came from the server or the user in memory only, in places the core empties itself. When the user signs in or
out, or a new build loads, the browser leaves the document, and every feature's memory goes with it, together with every request
still under way. When the tab's memory lets go of a page, that page's data goes from every feature too. No feature can forget to
clear something, and none writes a page's data to the history or to the browser's storage.

## The client hook API

`useFeature(hooks)` listens to every visit of the app:

```tsx
const api = useFeature(hooks);
useEffect(() => api.on('invalid', (event) => console.table(event.errors)), [api]);
```

| Event | When | What the listener gets |
| --- | --- | --- |
| `before` | Before a visit sends its request, after its own `confirm` and before the guard asks. | `url`, `method`, `options`, `layer`, `cancel()`, `cancelled` |
| `invalid` | A visit's answer brought validation errors. | `errors`, `url`, `method`, `name` |

`event.cancel()` in `before` stops the visit: nothing is sent and no visit event fires. Every visit passes `before`: a link, a form,
`router.visit()`, a reload, a poll and a dialog's visit. Back and Forward, prefetches, deferred props, islands and actions are not
visits and pass neither event. An action's validation errors come with its own result.

`on()` returns the function that stops listening. `useFeature()` works only in a component that renders in the browser, because
there is no navigator on the server, and on the server it throws. Render such a component once the page has mounted, as
`AdminGuard` above does. The hook API suits analytics, an error tracker or a rule of your own.

## Tab sync

### What it does

A user has the app open in three tabs and signs out in one. Without tab sync, the other two would keep showing what the user saw,
and keep it in memory, until their next request. Tab sync is on by default, so every tab lets go:

1. Each page carries the session's epoch, an opaque value that changes when someone signs in or out, the session is renewed, or
   the language changes. Flash messages and other writes leave it alone.
2. A tab whose epoch changes tells the other tabs of the browser through a `BroadcastChannel`. The message holds the epoch and
   nothing else: no props, no ids, no tokens.
3. A tab that hears of another epoch asks the server for the current one. So does a tab that becomes visible again, or comes back
   from the browser's back-forward cache, because it may have missed the message. That request only reads: it starts no session and
   sets no cookie.
4. When the epoch really differs, the tab leaves its document, empties every feature and loads the page again. The server then
   shows what this browser may see now: the sign-in page, or the page in the new language.

A tab with unsaved changes stays. It drops what it fetched ahead and, once it is visible, asks the user whether to load the page
again. The question goes to the app's confirm dialog as a `leave` request with `reason: 'session'`, which the
[dialogs](dialogs.md#asking-the-user) page shows how to word. Live updates pause meanwhile.

Every history entry remembers the epoch it was written under. Back or Forward to an entry of another epoch loads the page from the
server, never from memory. Flash messages stay with the tab whose request flashed them, so a poll in another tab never takes them.

### Listening to it

`useFeature(tabSync)` hears a change before the tab lets go of what it keeps. Like every `useFeature()`, it belongs in a component
that renders in the browser only:

```tsx title="layouts/SessionWatch.tsx"
import { tabSync } from '@marmeon/http/client';
import { useFeature } from '@marmeon/react';
import { useEffect } from 'react';

export function SessionWatch() {
  const sync = useFeature(tabSync);
  useEffect(() => sync.on('epoch', ({ origin }) => console.info('The session changed, noticed by', origin)), [sync]);
  return null;
}
```

`origin` is `self`, `tab` or `server`, depending on who noticed. `sync.epoch` is the tab's epoch, and `sync.check()` asks the
server now.

### The browser's storage on sign-out

Signing out with `Auth.logout()` also answers with `Clear-Site-Data: "cache", "storage"`. In every tab, the browser drops the
site's HTTP cache, `localStorage`, `sessionStorage`, IndexedDB and service workers. Cookies stay, so the new session survives.
Browsers honour the header only over HTTPS, so a server without TLS keeps the cache after a sign-out.

An app that keeps something in the browser's storage on purpose, across a sign-out, takes the storage part back after `logout()`:

```ts title="modules/auth/controllers/LogoutController.ts"
import { Auth } from '@marmeon/auth';
import { ClientHistory, Controller } from '@marmeon/http';

export class LogoutController extends Controller {
  readonly #auth: Auth;
  readonly #history: ClientHistory;

  constructor(auth: Auth, history: ClientHistory) {
    super();
    this.#auth = auth;
    this.#history = history;
  }

  async handle() {
    await this.#auth.logout();
    this.#history.clear({ siteData: ['cache'] });
    return this.redirect().route('auth.login');
  }
}
```

`siteData: false` sends no header at all. Data that must survive a sign-out in every tab is safer on the server.

### Turning it off

```tsx
void createMarmeonApp({ resolve: resolvePage, title, routes, messages, tabSync: false });
```

> [!WARNING]
> Without tab sync, a tab keeps showing what the signed-out user saw, and keeps it in memory, until its next request. Back in that
> tab may show pages from memory. Turn it off only when the app has no signed-in pages.

Without `BroadcastChannel`, in an old browser, a tab still checks when it becomes visible.
