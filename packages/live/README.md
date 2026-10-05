# @bespokecore/live

Live props (W6.10, E89, E90, E104): a page, an island or a layer **follows a channel**; when something changes, the server
**hints** that channel — never data — and every tab that follows it reloads what changed through the page's own route, as
a partial reload. One Server-Sent-Events stream per tab carries the hints of every channel on screen. This package is the
server side; the browser side is the `live` feature of the client core ([features](../http/README.md#features)).

`bespoke discover` registers its `LiveServiceProvider` like any installed package. It signs with the app's `APP_KEY`
([@bespokecore/encryption](../encryption/README.md)) and registers its stream in the `web` group;
[@bespokecore/redis](../redis/README.md) (for `LIVE_DRIVER=redis`), [@bespokecore/session](../session/README.md) (streams end
with their session) and [@bespokecore/notifications](../notifications/README.md) (the [`live` channel](#notifications-the-live-channel))
are optional peers.

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
  session's cookie they open nothing. A page that signs a channel keeps its session — also a guest's, who otherwise gets none
  (E143: a new session is kept only when something needs it, [`session.persist()`](../session/README.md#new-sessions-are-only-kept-when-used));
  an island cannot (it is read-only and starts no session): a guest without a session gets the island without the
  subscription — no hints, never an error — until a page keeps a session. A route without a session (outside the `web` group)
  cannot sign one (an error that says so), and a stream without a session is refused (401).
- **After the commit (E107).** `refresh()` inside `connections.transaction(…)` ([transactions](../database/README.md#transactions))
  goes out once it committed (`afterCommit`); a rollback sends nothing. The other tab never reloads what is not there yet.
- **Not to the tab that caused it.** Every request of a tab that follows live hints names its document
  (`x-bespoke-connection`); the hint of a write it caused reaches it with `only: []` — nothing to reload (it shows its own
  answer), only the sequence moves on. Outside a request (a job, a command) every tab hears it.
- **Signing in or out ends the streams of the old session** — in every process (pub/sub): they get `end` and close; the browser
  does not reconnect. The next page the tab asks for is the server's answer to that (`/login`).
- **Read-only.** The stream's path (`GET /_bespoke/live`) is read-only by itself — with `Accept: text/event-stream` or without
  (a script, a proxy that drops the header): the kernel never saves its session, sets no cookie, takes no flash message — like an
  island.

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
- **Server shutdown** closes every stream (`startServer().close()` would wait for them otherwise) — also one whose request was
  on its way when the server began closing (refused with 503); the browsers reconnect to the next server and catch up.
- **Paused while the session changed in another tab**: with [tab sync](../http/README.md#tab-sync-w8-step-8) a tab that keeps its page
  (unsaved changes) after a sign-in or sign-out elsewhere closes its stream, does not reconnect and reloads nothing until a page
  of the new session is on screen — the old stream's tokens are the old session's, and a reload would show the new one's data in
  the old page.
- **Only while the navigator runs**: the stream opens once `navigator.start()` took over the history and closes on `stop()` —
  with every listener on `document`/`window`; a second navigator (React builds one after a hydration mismatch) opens none.

## Limits

| | Default | Beyond |
|---|---|---|
| `LIVE_MAX_STREAMS` — streams per **process** | 1000 | 503 + `Retry-After: 10` |
| `LIVE_MAX_STREAMS_PER_SESSION` — streams of one **session** per process (its tabs) | 16 | 429 + `Retry-After: 30`, a `warn` log line |
| `LIVE_MAX_CHANNELS` — channels per stream | 20 | 400 |

- **Per session**: without it, one user (or a script with their cookie) could take every stream of the process and leave live
  updates dead for everyone else. Sixteen tabs of one browser stay connected; the 17th tab's `EventSource` is refused and the
  client tries again 30 s later (it gets a place once another tab closes). The key is the session's **scope** — what the
  tokens are signed for; a stream without a session is refused (401) before any count, so a guest streams only with the session
  a page kept for them (E143). Someone who mints new sessions (a fresh cookie per request) is held by the process limit, not
  this one — like any other flood of connections, that belongs in front of the app (the proxy's connection limits).
- **Atomic**: a stream takes its place in the counts before `open()` waits for anything (the backend's sequences) — fifty tabs
  opening at once never get past a limit.
- **Per process**: the counts are each process's. With `--workers=4` or four containers, a session may hold 16 streams in each.
- **A hint costs its followers**: the hub keeps an index `channel → streams` (and `session → streams` for the end of a session) —
  a hint on a channel one tab follows takes ~0.01 ms among 50 000 open streams (`pnpm bench fanout`; before the index 4–5 ms); a
  hint every stream follows is one event per stream (≈ 55 ms for 50 000).

### Behind a proxy

- Speak **h2 (or h3) to the browser** — nginx `listen 443 ssl; http2 on;`, Caddy by default, Cloudflare and AWS ALB by default —, so
  every tab may stay connected; the app behind it may speak HTTP/1.1.
- Let the stream through **unbuffered and uncompressed**: the app sends `X-Accel-Buffering: no` (nginx honours it per response) and
  `no-transform`; a proxy that compresses `text/event-stream` anyway holds hints back until a buffer fills.
- **Idle timeouts longer than `LIVE_HEARTBEAT`** (nginx `proxy_read_timeout`, ALB idle timeout, Cloudflare's 100 s) — the
  heartbeat is what keeps an idle stream open.
- Count connections: each open tab holds one stream (one socket through the proxy); `LIVE_MAX_STREAMS` caps them per process,
  `LIVE_MAX_STREAMS_PER_SESSION` per session.
- **Keep-alive to the app**: the proxy must close an idle connection to the app before the app does — the app keeps them 65 s
  (`KEEP_ALIVE_TIMEOUT`, [server](../server/README.md)); nginx's upstream `keepalive_timeout` (60 s, set in the `make:docker --nginx`
  template), an AWS load balancer's idle timeout (60 s) are shorter. Behind a proxy that keeps them longer (Google's load
  balancer: 600 s), raise `KEEP_ALIVE_TIMEOUT` above it — otherwise a request now and then meets a closing connection (a 502).

## Configuration

```sh
LIVE_DRIVER=memory            # memory: one process | redis: every process hears every hint (E87, E89)
LIVE_REDIS_CONNECTION=default # the Redis connection of the redis driver
LIVE_HEARTBEAT=20             # seconds between heartbeats
LIVE_RETRY=3000               # ms before a browser reconnects a broken stream
LIVE_MAX_STREAMS=1000         # open streams per process (beyond: 503 + Retry-After)
LIVE_MAX_STREAMS_PER_SESSION=16 # open streams of one session per process (beyond: 429 + Retry-After)
LIVE_MAX_CHANNELS=20          # channels per stream (one page, its islands and layers)
```

`LiveConfig` is the package's config class; it checks the ranges at the start (`LIVE_HEARTBEAT` 1–300, `LIVE_RETRY` 100–600000,
`LIVE_MAX_CHANNELS` at most 200). `LIVE_DRIVER=redis` without `@bespokecore/redis` and its provider, or with an unknown
`LIVE_REDIS_CONNECTION`, fails the start; a missing `APP_KEY` does too.

**`memory` reaches the streams of its own process only.** A hint sent by a queue worker — the notifications' `live` channel,
a queued listener, a job — needs `redis`: the worker publishes, the web processes deliver. **`bespoke start --workers=N` needs
`redis` too**: with `memory` a worker does not start (`LiveSetupError`: "memory pub/sub never reaches the other workers — use
LIVE_DRIVER=redis"), and the cluster stops — a hint would reach one worker's tabs only, and a tab that reconnects to another
worker would compare its sequences with another counter. The memory backend forgets a channel's sequence a day after its last
hint and beyond 10 000 channels (the one hinted longest ago first), like Redis's TTL — a forgotten channel counts on above every
sequence it forgot, so an open stream never takes its next hint for an old one. With Redis down, `refresh()` logs
the lost hint (the change itself is committed) and new streams answer 503; tabs that reconnect later catch up by sequence.
Sequences live a day after a channel's last hint (`<prefix>live:seq:<channel>`); a tab away longer reloads once. A counter that
starts again — its key expired, was evicted or flushed — never silences a stream: after `hello` every hint is told whatever its
sequence (only the hints that came while `hello` was prepared and that it counted are left out), and a reconnect whose
`Last-Event-ID` names another sequence than the channel's now — higher or lower — reloads that channel once.

**Observation (E118):** each hint going out (after its commit) is a message on the `live.refresh` channel
([the channels](../core/README.md#the-channels)) — the [devtools](../devtools/README.md) record it as a `live` entry,
[@bespokecore/otel](../otel/README.md#what-it-records) as a `live refresh` span.

## Notifications: the `live` channel

With [@bespokecore/notifications](../notifications/README.md#channels) installed, `via()` may return `'live'`: once the delivery's
transaction committed (its `database` row first), the recipient's channel `notificationsChannel(recipient)`
(`notifications.<type>.<id>`) is refreshed — without `only`: each follower reloads what it follows the channel for (the bell
`['bell']`, the list `['notifications']`).

```ts
via(user: User) { return ['database', 'live', 'mail'] as const; }
```

## Testing

With [@bespokecore/testing](../testing/README.md), hints are sent as in production — the streams of `app.live()` get them — and recorded in
`app.broadcast`:

```ts
const ada$ = app.actingAs(ada);                              // one browser, one session
const stream = await ada$.live(`/users/${ada.id}`);          // the page's channels, signed for this session
await stream.hello();                                        // { seq: { 'users.7': 0, … } }
await app.actingAs(ada).withHeaders({ 'x-bespoke-connection': 'tab-a' }).post(`/users/${ada.id}/links`, { json });
await stream.waitFor(1);
expect(stream.hints).toEqual([{ channel: `users.${ada.id}`, only: ['profile'], seq: 1 }]);
app.broadcast.assertRefreshed(`users.${ada.id}`, { only: ['profile'] });   // also assertNotRefreshed, assertNothingRefreshed
```

`app.live(subscriptions)` takes the `live` of an island's region object too. `stream.status`, `stream.events`, `stream.heartbeats`,
`stream.ended`, `stream.closed` (a promise), `stream.close()`; `app.broadcast.refreshed(channel?)` lists what was refreshed.

## Not yet

**Broadcasting over WebSockets** — data events, presence channels, client events, a Pusher-compatible protocol — is not part of
BespokeCore: it is in the backlog until its design is settled (E191). Live props are hints over Server-Sent Events, and stay so.
A Postgres `LISTEN/NOTIFY` backend is noted for later. A hint sent while Redis is unreachable is not retried. Channel tokens do
not expire (a hint carries no data, and the reload goes through the route's policy; signing in or out ends the streams).
