# Real time: live hints

When something changes, the other tabs that show it should follow — another user added a link to a profile, a notification came,
an administrator removed a row. In Marmeon real time is **live hints** (E89): the server tells the tabs that follow a channel
*that* something changed — never *what* — and each tab reloads the affected props through the page's own route, as a partial reload,
with its middleware and policies. One Server-Sent-Events stream per tab carries the hints of every channel on screen.

This guide shows how to use it, what holds it in bounds, what it needs in production — and, honestly, what it is not. The reference:
[@marmeon/live](../packages/live/README.md).

## Following and hinting

```ts
// The page follows a channel; a hint reloads the props it names (typed: a name that is not a prop is a compile error).
return this.view('user-profile/Show', { profile, activity: defer(() => this.#activity.recent(user.id)) })
  .live(`users.${user.id}`, { only: ['profile', 'activity'] });

// Islands and layers the same way; shared props (the bell in every layout) from middleware:
shared.live(async () => {
  const user = await auth.user();
  return user ? notificationsChannel({ type: 'user', id: user.id }) : undefined;     // a guest follows nothing
}, { only: ['bell'] });

// Anywhere on the server — a controller, a job, a listener: the injected Broadcaster.
await this.#broadcast.refresh(`users.${user.id}`, { only: ['profile'] });
```

In the browser there is usually nothing to write: the client core reads the page's channels and follows them.
`useLiveUpdates()` says whether updates wait — they do while a form on screen has unsaved changes — and `apply()` loads them.
A notification sent `via()` `'live'` hints its recipient's channel by itself.

## Why hints, not data

- **One authorization path.** What a tab shows next comes from its own request — the same route, middleware, policies and props
  as any page load. A hint about something the user may no longer see reloads into a 403 or the login page, never into data. There
  is no second set of rules for "who may receive this event".
- **Signed subscriptions (E90).** `.live()` puts each channel into the page object with a token — an HMAC over the channel and the
  session, keyed from `APP_KEY`. Whoever may see the page may hear its hints; a channel rewritten (`users.1` → `users.2`), another
  session's token or one of a session that ended is refused with a 403, and a stream without a session with a 401.
- **After the commit (E107).** A `refresh()` inside a transaction goes out once it committed; a rollback sends nothing.
- **Not back to the tab that caused it.** Every request of a following tab names its document (`x-marmeon-connection`): the hint
  of its own write reloads nothing there (it shows its own answer).
- **Signing in or out ends the old session's streams**, in every process; the next page the tab asks for is the server's answer.
- **Read-only.** The stream (`GET /_marmeon/live`) never writes a session, a cookie or a flash message.

Reloads coalesce: hints are collected until 250 ms pass without one (at most 2 s), then **one** partial reload per page, island or
layer. A reload after a hint is a revalidation — it **replaces** `merge()`d props ([lists](lists.md#revalidations-replace-load-more-appends)).
While tab sync asks whether to keep a page after a sign-in or sign-out elsewhere, the stream is paused (no reconnect, no reload) until
a page of the new session is on screen.

## Limits

| | Default | Beyond it |
|---|---|---|
| `LIVE_MAX_STREAMS` — streams per **process** | 1000 | 503 + `Retry-After: 10` |
| `LIVE_MAX_STREAMS_PER_SESSION` — streams of one **session** per process | 16 | **429** + `Retry-After: 30`, a `warn` log line |
| `LIVE_MAX_CHANNELS` — channels per stream | 20 | 400 |

- **Per session (W9):** without it one user — or a script with their cookie — could take every stream of the process and leave live
  updates dead for everybody else. Sixteen tabs of one browser stay connected; the 17th is refused and tries again 30 s later. The
  key is the session (what the tokens are signed for), not the IP address: NAT and company networks would put many users together.
  Someone who mints a fresh session per request meets the process limit — a flood of connections belongs to the proxy's limits.
- **Atomic:** a stream takes its place in the counts before anything is awaited — fifty tabs opening at once never get past a limit.
- **Per process:** with `--workers=4` or four containers, a session may hold 16 streams in each.
- **Cost of a hint:** the hub indexes streams by channel — a hint on a channel one tab follows takes ~0.01 ms among 50 000 open
  streams; a hint every stream follows is one event per stream (≈ 55 ms for 50 000). Measure with `pnpm bench fanout`.

## More than one process

`LIVE_DRIVER=memory` (the default) reaches the streams of its own process only. Use **`LIVE_DRIVER=redis`**
([@marmeon/redis](../packages/redis/README.md)) as soon as there is more than one:

- **`marmeon start --workers=N` needs Redis.** With `memory` a worker refuses to start (`LiveSetupError`: "memory pub/sub never
  reaches the other workers — use LIVE_DRIVER=redis") and the cluster stops — a hint would have reached one worker's tabs only.
- **Queue workers and the scheduler** send hints too (a queued notification, a job): they publish, the web processes deliver — only
  through Redis.
- **Several containers or machines**: the same.

## Sequences and catching up

Every hint carries its channel's sequence; a stream says `hello` with each channel's sequence when it opens (and, on a reconnect with
`Last-Event-ID`, which ones moved). A channel that moved while the tab was away — a broken connection, a frozen or hidden tab, a
server restart — reloads **once**. Sequences live a day after a channel's last hint; a tab away longer reloads once.

**A counter that starts again never silences a stream.** When a channel's Redis key expired, was evicted or flushed, its counter
starts over at 1. A stream that already said `hello` delivers every hint whatever its number, and a reconnect whose `Last-Event-ID`
names another sequence than the channel's now (higher or lower) reloads that channel once. The memory backend forgets a channel a
day after its last hint, or beyond 10 000 channels, and counts on above every sequence it forgot. With Redis down, `refresh()` logs the lost hint (the change itself is committed) and new
streams answer 503; tabs that reconnect later catch up by sequence.

## Behind a proxy

- **HTTP/2 (or 3) to the browser.** Over HTTP/1.1 a browser opens six connections per host across all tabs: the client then keeps a
  stream only while its tab is visible. The Node development server speaks HTTP/1.1 — in development with many tabs that fallback
  is active. Behind Caddy, nginx with `http2 on;` or a cloud load balancer every tab stays connected.
- **Unbuffered and uncompressed.** The stream sends `X-Accel-Buffering: no` (nginx honours it) and `no-transform`; a proxy that
  compresses `text/event-stream` anyway holds hints back.
- **Idle timeouts longer than the heartbeat** (`LIVE_HEARTBEAT`, 20 s): nginx's `proxy_read_timeout` (the template: 75 s), an AWS
  load balancer's 60 s, Cloudflare's 100 s.
- **Keep-alive: the proxy closes first.** The app keeps idle connections `KEEP_ALIVE_TIMEOUT` (65 s) — above nginx's upstream
  `keepalive_timeout` (60 s in the template) and an AWS load balancer's 60 s; behind Google's load balancer (600 s) set it to 620.
  Otherwise a request now and then meets a closing connection: a 502, for a page as for a stream.

Proved in a browser behind `caddy:2` and behind nginx (the `make:docker --nginx` template), both over h2: two tabs connected, a hint
reaching both, the 17th stream of the session refused. The whole picture: [deployment](deployment.md#proxies-and-http2).

## Testing

```ts
const stream = await app.actingAs(ada).live(`/users/${ada.id}`);    // the page's channels, signed for this session
await stream.hello();
await app.actingAs(ada).withHeaders({ 'x-marmeon-connection': 'tab-a' }).post(`/users/${ada.id}/links`, { json });
await stream.waitFor(1);
expect(stream.hints).toEqual([{ channel: `users.${ada.id}`, only: ['profile'], seq: 1 }]);
app.broadcast.assertRefreshed(`users.${ada.id}`, { only: ['profile'] });
```

## What there is not

Real time in Marmeon is the hints above — and stays so until a better design is settled. **Not** part of the framework (E191,
in the backlog with their design notes):

- **Broadcasting over WebSockets** — no WebSocket server or client, no Pusher-compatible protocol, no driver for Pusher, Ably,
  Soketi or Reverb.
- **Data events** — a stream never carries data; a tab always reloads through its route.
- **Presence channels** — no "who is here" lists.
- **Client events** ("whisper", typing indicators) — tabs never send each other anything through the server.
- **Encrypted channels**, a Postgres `LISTEN/NOTIFY` backend, retrying a hint lost while Redis was down.

Channel tokens do not expire: a hint carries no data, every reload goes through the route's policy, and signing in or out ends the
streams.
