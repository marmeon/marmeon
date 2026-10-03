# @bespokecore/live

Live props (W6.10, E89, E90, E104): a page, an island or a layer **follows a channel**; when something changes, the server
**hints** that channel — never data — and every tab that follows it reloads what changed through the page's own route, as
a partial reload. One Server-Sent-Events stream per tab carries the hints of every channel on screen.

```ts
// A page, an island, a layer — the same API (regions, E50). `only`: the props a hint reloads (typed: a name that is not one of
// the page's props is a compile error — "'avtar' is not a prop of this page — its props: activity, profile, …").
return this.view('user-profile/Show', { profile, activity: defer(() => this.#activity.recent(user.id)) })
  .live(`users.${user.id}`, { only: ['profile', 'activity'] });
return this.island('dashboard/RecentSignIns', { entries }).live('dashboard.sign-ins');

// Shared props (the bell in every layout): from middleware, for every page the request renders.
shared.live(async () => {
  const user = await auth.user();
  return user ? notificationsChannel({ type: 'user', id: user.id }) : undefined;     // a guest follows nothing
}, { only: ['bell'] });

// Anywhere on the server — a controller, a job, a listener: the injected Broadcaster.
await this.#broadcast.refresh(`users.${user.id}`, { only: ['profile'] });
```

```tsx
// Usually nothing in the browser: the client core sees `PageObject.live` and follows those channels by itself.
const updates = useLiveUpdates();   // { pending, apply() } — while a form on screen has unsaved changes, reloads wait
```

## The guarantees

- **A hint, never data.** The stream carries `{ channel, only, seq }` and nothing else (a test holds every hint to that
  schema). What a tab shows next comes from its own request — the route's middleware, policies and props decide, as for any
  partial reload. A hint for something the user may no longer see reloads into a 403 or the login page, never into data.
- **Signed by the answer that declares it (E90).** `.live()` puts the channel into the page object with a token: an HMAC over
  the channel and a hash of the session's id, keyed from `APP_KEY` (HKDF, context `live`; `APP_PREVIOUS_KEYS` still verify).
  Whoever may see the page may hear its hints — the same policy, in one place. The stream (`GET /_bespoke/live`) refuses any
  token that does not fit — a channel rewritten (`users.1` → `users.2`), a token of another session or of one that ended — with
  a 403 and no stream at all. The tokens travel in the stream's query (`EventSource` sends no headers of its own): without the
  session's cookie they open nothing.
- **After the commit (E107).** `refresh()` inside `connections.transaction(…)` goes out once it committed (`afterCommit`); a
  rollback sends nothing. The other tab never reloads what is not there yet.
- **Not to the tab that caused it.** Every request of a tab that follows live hints names its document
  (`x-bespoke-connection`); the hint of a write it caused reaches it with `only: []` — nothing to reload (it shows its own
  answer), only the sequence moves on. Outside a request (a job, a command) every tab hears it.
- **Signing in or out ends the streams of the old session** — in every process (pub/sub): they get `end` and close; the browser
  does not reconnect. The next page the tab asks for is the server's answer to that (`/login`).
- **Read-only.** The stream is an event stream (`Accept: text/event-stream`): the kernel never saves its session, sets no
  cookie, takes no flash message — like an island.

## Robust streams (E104)

- **Always connected**, also in a background tab — **except** a page loaded over HTTP/1.1 (or an unknown protocol:
  `performance.getEntriesByType('navigation')[0].nextHopProtocol`), where a browser allows six connections per host: then the
  stream is closed while the tab is hidden and opened again when it is shown. **The Node development server speaks HTTP/1.1
  only (no TLS): in development with many tabs the fallback is active.** Behind nginx, Caddy, Cloudflare or a load balancer
  the browser speaks h2/h3 to the proxy, and every tab stays connected.
- **Heartbeats**: a comment line every `LIVE_HEARTBEAT` seconds (default 20) on an idle stream — proxies and load balancers
  close connections that stay silent. Keep it under every idle timeout on the way (nginx `proxy_read_timeout` 60 s by default,
  AWS ALB 60 s, Cloudflare 100 s).
- **No buffering, no transformation**: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-store, no-transform`,
  `X-Accel-Buffering: no` (nginx then streams this response without `proxy_buffering off`), never compressed by the app.
- **Catching up**: `retry:` (`LIVE_RETRY` ms) and an event id per hint; whenever a stream opens it says `hello` with each
  channel's sequence (and, on a reconnect with `Last-Event-ID`, which ones moved). A channel whose sequence moved since the tab
  last saw it — a broken connection, a frozen tab (`resume`, `pageshow`), a hidden one over HTTP/1.1 — reloads **once**: the
  union of what its followers name, one partial reload per page, island or layer.
- **Bursts**: hints are collected until 250 ms pass without one (at most 2 s after the first) — then **one** partial reload per
  target, however many hints came.
- **Unsaved changes**: while a guard holds (`useForm(…, { guard })`, `useBlocker`), nothing reloads; `useLiveUpdates()` says
  updates are pending, `apply()` loads them (or the next render after the guard lets go).
- **Server shutdown** closes every stream (`startServer().close()` would wait for them otherwise); the browsers reconnect to
  the next server and catch up.

## Configuration

```sh
LIVE_DRIVER=memory            # memory: one process | redis: every process hears every hint (E87, E89)
LIVE_REDIS_CONNECTION=default # the Redis connection of the redis driver
LIVE_HEARTBEAT=20             # seconds between heartbeats
LIVE_RETRY=3000               # ms before a browser reconnects a broken stream
LIVE_MAX_STREAMS=1000         # open streams per process (beyond: 503 + Retry-After)
LIVE_MAX_CHANNELS=20          # channels per stream
```

**`memory` reaches the streams of its own process only.** A hint sent by a queue worker — the notifications' `live` channel,
a queued listener, a job — needs `redis`: the worker publishes, the web processes deliver. With Redis down, `refresh()` logs
the lost hint (the change itself is committed) and new streams answer 503; tabs that reconnect later catch up by sequence.
Sequences live a day after a channel's last hint (`<prefix>live:seq:<channel>`); a tab away longer reloads once.

## Notifications: the `live` channel

With `@bespokecore/notifications` installed, `via()` may return `'live'`: once the delivery's transaction committed (its
`database` row first), the recipient's channel `notificationsChannel(recipient)` (`notifications.<type>.<id>`) is refreshed —
without `only`: each follower reloads what it follows the channel for (the bell `['bell']`, the list `['notifications']`).

```ts
via(user: User) { return ['database', 'live', 'mail'] as const; }
```

## Testing

```ts
const ada$ = app.actingAs(ada);                              // one browser, one session
const stream = await ada$.live(`/users/${ada.id}`);          // the page's channels, signed for this session
await stream.hello();                                        // { seq: { 'users.7': 0, … } }
await app.actingAs(ada).withHeaders({ 'x-bespoke-connection': 'tab-a' }).post(`/users/${ada.id}/links`, { json });
await stream.waitFor(1);
expect(stream.hints).toEqual([{ channel: `users.${ada.id}`, only: ['profile'], seq: 1 }]);
app.broadcast.assertRefreshed(`users.${ada.id}`, { only: ['profile'] });   // also assertNotRefreshed, assertNothingRefreshed
```

`app.live(subscriptions)` takes the `live` of an island's region object too. `stream.events`, `stream.heartbeats`,
`stream.closed`, `stream.close()`.

## Not yet

WebSockets and presence channels (W8.4) — the hint protocol stays; a Postgres `LISTEN/NOTIFY` backend (Merkposten). A hint sent
while Redis is unreachable is not retried.
