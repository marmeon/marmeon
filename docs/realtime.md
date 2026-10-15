# Real-time Updates

## Introduction

When something changes, the other tabs that show it should follow: another user added a link to a profile, a notification
arrived, an administrator removed a row. A page **follows a channel**, and when something changes the server sends the channel a
**hint**. Every tab that follows the channel then reloads the props it named, through the page's own route, as a partial reload.
A hint says *that* something changed, never *what*: the data always comes from the route, its middleware and its policies.

Install the package first:

```sh
pnpm add @marmeon/live
```

A page follows a channel with `.live()`:

```ts title="modules/user-profile/controllers/ShowUserProfileController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import type { Profile } from '../ProfileDirectory.ts';

export class ShowUserProfileController extends Controller {
  handle(ctx: HttpContext<Authenticated, { user: Profile }>) {
    const { id, name, bio, links } = ctx.params.user;
    return this.view('user-profile/Show', { profile: { id, name, bio, links } }).live(`users.${id}`, { only: ['profile'] });
  }
}
```

A write hints the channel with the injected `Broadcaster`:

```ts title="modules/user-profile/controllers/AddProfileLinkController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Broadcaster } from '@marmeon/live';
import { rules as r } from '@marmeon/validation';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const AddProfileLinkRequest = defineRequest({
  schema: r.object({ label: r.string().trim().required().max(60), url: r.string().trim().required().url().max(2048) }),
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class AddProfileLinkController extends Controller {
  static request = AddProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #broadcast: Broadcaster;

  constructor(links: ProfileLinkRepository, broadcast: Broadcaster) {
    super();
    this.#links = links;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof AddProfileLinkRequest>) {
    await this.#links.insert({ user_id: ctx.params.user.id, ...ctx.body });
    await this.#broadcast.refresh(`users.${ctx.params.user.id}`, { only: ['profile'] });
    return this.redirect().route('user-profile.show', { user: ctx.params.user.id });
  }
}
```

Every other tab on that profile reloads its `profile` prop. In the browser there is nothing to write: the client reads the page's
channels and follows them over one Server-Sent Events stream per tab, which carries the hints of every channel on screen.

## Following a channel

`.live(channel, { only })` works on a page, a layer and an island alike. `only` names the props a hint reloads, and a name that is
not a prop is a compile error:

```text
'avtar' is not a prop of this page — its props: activity, profile, …
```

A channel's name is made of letters, digits, `_`, `-`, `.` and `:`, at most 200 characters, such as `users.7` or `team:4.tasks`.
Anything else throws. The name travels in the page, so keep secrets out of it.

What a hint reloads depends on both sides. A tab reloads the props that the page's `only` and the hint's `only` both name. A hint
without `only` reloads every prop the page names, and a page without `only` reloads what the hint names, or all of its props. A
reload after a hint replaces [merged props](deferred-props.md#merged-props) instead of appending to them.

### Shared props

A prop that every page's layout shows, such as the count of unread notifications, follows a channel from the middleware that
shares it. `SharedData.live()` takes the channel, or a function of the request that says which:

```ts title="middleware/ShareAppProps.ts"
import { Auth } from '@marmeon/auth';
import { SharedData, type HttpContext, type Next } from '@marmeon/http';
import { notificationsChannel } from '@marmeon/live';
import { Inbox } from '@marmeon/notifications';

declare module '@marmeon/http/page' {
  interface SharedProps {
    bell?: { unread: number } | null;
  }
}

export class ShareAppProps {
  readonly #shared: SharedData;
  readonly #auth: Auth;
  readonly #inbox: Inbox;

  constructor(shared: SharedData, auth: Auth, inbox: Inbox) {
    this.#shared = shared;
    this.#auth = auth;
    this.#inbox = inbox;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    this.#shared
      .share('bell', async () => {
        const user = await this.#auth.user();
        return user ? { unread: await this.#inbox.count({ type: 'user', id: user.id }) } : null;
      })
      .live(
        async () => {
          const user = await this.#auth.user();
          return user ? notificationsChannel({ type: 'user', id: user.id }) : undefined;
        },
        { only: ['bell'] },
      );
    return next();
  }
}
```

A guest follows nothing, because the function returns `undefined`. The function runs only when a page renders, and a shared
channel goes into pages only, never into an island or a layer, which show no layout. A notification sent through the
[live channel](notifications.md#the-live-channel) hints `notificationsChannel(recipient)` by itself.

## Sending hints

`broadcast.refresh(channel, { only })` works anywhere on the server: in a controller, a listener or a job.

- **After the commit.** Inside a transaction the hint goes out once the transaction committed, and a rollback sends nothing. A tab
  never reloads data that is not there yet.
- **Not back to the tab that caused it.** Every request of a tab that follows a channel names its document in the
  `x-marmeon-connection` header. The hint of its own write reaches that tab with nothing to reload, since it shows the server's
  answer already. A hint sent from a job or a command reaches every tab.
- **Gathered.** A tab collects hints until 250 milliseconds pass without one, at most 2 seconds after the first, and then makes
  **one** partial reload per page, island or layer.

With Redis down, `refresh()` logs the lost hint and does not retry it. The change itself is committed. New streams answer `503`
with `Retry-After: 5` meanwhile, and tabs that connect again later catch up.

## Why hints, not data

- **One authorization path.** What a tab shows next comes from its own request: the same route, middleware, policies and props as
  any page load. A hint about something the user may no longer see reloads into a 403 or the login page, never into data.
- **Signed subscriptions.** `.live()` puts each channel into the page with a token: an HMAC over the channel and the session,
  keyed from `APP_KEY`, so whoever may see the page may hear its hints. The stream refuses a channel that was rewritten, such as
  `users.1` to `users.2`, and a token of another session or of one that ended, with a 403. A stream without a session gets a 401.
  The tokens travel in the stream's URL, because `EventSource` sends no headers of its own, so they show in a proxy's access log.
  They are bound to the session and open nothing without its cookie.
- **Sessions.** A page that signs a channel keeps the session it was signed for, also a guest's. An island cannot start a session,
  so a guest without one gets the island without its subscription, and no error. A route without a session, such as one of the
  `api` group, cannot sign a channel and throws.
- **Signing in or out ends the streams** of the old session, in every process. The tab does not connect again, and the next page
  it asks for shows the new session.
- **A stream checks its sign-in** when it opens, which includes every reconnect, if `@marmeon/auth` is installed. A browser whose
  sign-in ended elsewhere (signed out by `AccountSessions.end()`, a new password, an ended sign-in) gets an `end` event instead of
  a stream and does not connect again until the next page it loads, even though its session may still be in the store. A guest's stream is unchanged. An app with its own authentication binds its own `LiveAudience`. A stream
  that is already open is not closed by this; it ends with its next connection.
- **Read-only.** The stream at `GET /_marmeon/live` never writes the session, sets no cookie and takes no flash message.

> [!NOTE]
> Channel tokens do not expire while their session lives. A user who loses access to a channel keeps hearing *that* it changed,
> its name and when, until the session ends. Every reload this causes meets the route's policy, so no data reaches them.

## Unsaved changes

While a form on screen has unsaved changes and guards them, no hint reloads anything. The updates wait, and `useLiveUpdates()`
tells the page:

```tsx title="modules/user-profile/views/Edit.tsx"
import { useLiveUpdates } from '@marmeon/react';

export default function Edit() {
  const updates = useLiveUpdates();
  return (
    <section>
      {updates.pending && (
        <p role="status">
          This profile changed in another tab. <button type="button" onClick={updates.apply}>Load the changes</button>
        </p>
      )}
    </section>
  );
}
```

`apply()` loads them. The [forms](forms.md#unsaved-changes) page shows the guard. While [tab sync](client-features.md#tab-sync)
asks whether to keep a page after a sign-in or sign-out in another tab, the stream pauses until a page of the new session is on
screen.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `LIVE_DRIVER` | `memory` | How hints travel: `memory` within one process, `redis` to every process. |
| `LIVE_REDIS_CONNECTION` | `default` | The Redis connection of the `redis` driver. |
| `LIVE_HEARTBEAT` | `20` | Seconds between heartbeats on an idle stream, from 1 to 300. |
| `LIVE_RETRY` | `3000` | Milliseconds before a browser opens a broken stream again, from 100 to 600000. |
| `LIVE_MAX_STREAMS` | `1000` | Open streams per process. Beyond it, `503` with `Retry-After: 10`. |
| `LIVE_MAX_STREAMS_PER_SESSION` | `16` | Open streams of one session per process. Beyond it, `429` with `Retry-After: 30` and a warning in the log. |
| `LIVE_MAX_CHANNELS` | `20` | Channels per stream, at most 200. Beyond it, `400`. |

The app fails at the start without an `APP_KEY`, with `LIVE_DRIVER=redis` but no `@marmeon/redis`, with a Redis client that does
not load, or with an unknown Redis connection. It does not connect to Redis at the start: an unreachable server shows with the
first hint.

### Limits

The limit per session keeps one user, or a script with their cookie, from taking every stream of the process. Sixteen tabs of one
browser stay connected, and the seventeenth tries again 30 seconds later. The key is the session, not the address, because many
users of one company share an address. Someone who makes a fresh session for every request meets the limit per process; a flood of
connections belongs to the limits of your proxy.

A stream takes its place in the counts before it waits for anything, so fifty tabs that open at once never get past a limit. The
counts are each process's own: with four processes, a session may hold 16 streams in each.

## More than one process

`LIVE_DRIVER=memory` reaches the streams of its own process only. Use `LIVE_DRIVER=redis` as soon as there is more than one:

- **`marmeon start --workers`** fails at the start with `memory`, with a `LiveSetupError`: "memory pub/sub never reaches the
  other workers — use LIVE_DRIVER=redis". A hint would reach the tabs of one server only.
- **Queue workers and the scheduler** send hints too, such as a queued notification. They publish, and the web processes deliver.
  That works only through Redis.
- **Several containers or machines** need it for the same reason.

`@marmeon/redis` brings the Redis client, and the [Redis](redis.md#which-connection-a-driver-uses) page covers its connection.

## Catching up

Every hint carries its channel's sequence number. When a stream opens it says each channel's number, and the tab compares. A
channel that moved while the tab was away reloads **once**, however many hints it missed: after a broken connection, a frozen tab
or a restart of the server. Sequence numbers live a day after a channel's last hint, so a tab away longer reloads once anyway. The
`memory` driver also forgets the channels hinted longest ago beyond 10 000, and counts on above every number it forgot.

A number that starts again, because its Redis key expired or was flushed, never silences a stream: an open stream delivers every
hint whatever its number, and a reconnect that finds another number than it knew reloads that channel once. When the server stops,
it closes every stream, and the browsers connect to the next server and catch up.

## Behind a proxy

A stream holds a connection open for each tab. Over HTTP/1.1 a browser opens at most six connections per host, so on such a page
the client keeps a stream only while its tab is visible. The development server speaks HTTP/1.1, so in development with many tabs
this fallback is active. Behind a proxy that speaks HTTP/2 to the browser, every tab stays connected.

The stream sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-store, no-transform`, and the app never compresses it. A
proxy that buffers or compresses `text/event-stream` holds hints back. Its idle timeout must be longer than `LIVE_HEARTBEAT`. The
[deployment](deployment.md#live-updates-need-http2) page shows the settings for Caddy, nginx and other proxies.

## What there is not

Real-time updates are the hints on this page. These are not part of the framework:

- **Broadcasting over WebSockets:** no WebSocket server or client, no Pusher-compatible protocol, no driver for a hosted service.
- **Data events:** a stream never carries data. A tab always reloads through its route.
- **Presence channels:** no list of who is on a page.
- **Client events:** tabs never send each other anything through the server.
- **Encrypted channels**, a Postgres `LISTEN/NOTIFY` driver, and a retry for a hint lost while Redis was down.

## Testing

In a test, hints go out as in production, and `app.broadcast` records them. `app.live(path)` opens the stream of a page, signed for
the test's session:

```ts title="modules/user-profile/live.test.ts"
import { UserRepository, type User } from '#modules/auth';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('a link added in one tab reloads the profile in another', async () => {
  const app = await createTestApp(application, { database: 'refresh', seed: true });
  const [ada] = (await app.make(UserRepository).query().selectAll().orderBy('id').execute()) as User[];
  const stream = await app.actingAs(ada!).live(`/users/${ada!.id}`);
  await stream.hello();

  await app.actingAs(ada!).post(`/users/${ada!.id}/links`, { json: { label: 'Blog', url: 'https://ada.example' } });

  await stream.waitFor(1);
  expect(stream.hints).toEqual([{ channel: `users.${ada!.id}`, only: ['profile'], seq: 1 }]);
  app.broadcast.assertRefreshed(`users.${ada!.id}`, { only: ['profile'] });
});
```

The [fakes](fakes.md#live-updates) page lists the other assertions.
