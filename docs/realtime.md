# Real-time Updates

## Introduction

When something changes, the other tabs that show it should follow: another user added a link to a profile, a notification
arrived, an administrator removed a row. A page **follows a channel**, and when something changes the server sends the channel a
**hint**. Every tab that follows the channel then reloads the props it named, through the page's own route, as a partial reload.
A hint says *that* something changed, never *what*: the data always comes from the route, its middleware and its policies.

Install the package first, in the version of the app's other framework packages:

```sh
pnpm add -E @marmeon/live@<version of your app>
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
- **Once per transaction.** Equal hints (the same channel and `only`, leaving out the same tab) sent in one transaction go out
  once after its commit, however many rows a loop changed: the channel's sequence goes up by one. Hints that differ in channel
  or props stay apart. The hint of a savepoint that rolled back is dropped, and it does not keep an equal hint outside the
  savepoint from going out. Outside a transaction every `refresh()` goes out at once.
- **Not back to the tab that caused it.** Every request of a tab that follows a channel names its document in the
  `x-marmeon-connection` header. The hint of its own write reaches that tab with nothing to reload, since it shows the server's
  answer already. A hint sent from a job or a command reaches every tab.
- **Gathered.** A tab collects hints until 250 milliseconds pass without one, at most 2 seconds after the first, and then makes
  **one** partial reload per page, island or layer.

`Broadcaster` is given to your code, not meant to be implemented: a later release may add a member.

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
  a stream and does not connect again until the next page it loads, even though its session may still be in the store. A guest's stream is unchanged. An app with its own authentication binds its own `LiveAudience`.
- **Ending an account's sign-ins closes its open streams** at once, in every process: `AccountSessions.end()`, a new password (a
  change or a reset by link), signing out the other devices, `updateSessionKey()`, ending a sign-in from the list, a copied
  remember-me cookie that was used, deleting the account (`UserSessions.end()`); `endEveryone()` closes every account's. The streams close without `end`
  and ask their browsers to connect again after one to ten seconds; each browser is then checked as above, so the ones still signed in
  keep their stream (the device that changed the password included) and the others get `end`. A guest's stream is never closed this way.
  Streams are filed under a scope keyed from `APP_KEY`, so what the live backend carries (Redis included) names no account to
  someone who only reads it. During a rotation of `APP_KEY` (the new key first, the old one in `APP_PREVIOUS_KEYS`) a stream is filed
  and an end is announced under every key the process knows, so an end announced by a process still on the old key closes the
  streams of one on the new key, and the other way round. The backend itself is trusted: whoever can publish to it can close streams. Every stream also closes after
  `LIVE_MAX_STREAM_SECONDS` (15 minutes) and is checked again, which bounds every ending that was not announced. With
  `LIVE_DRIVER=memory` a command in the console reaches no running server: its streams close at the latest by then.
  The announcement is internal to `@marmeon/auth` and `@marmeon/session`: an app with its own `LiveAudience` gets the streams'
  lifetime and the check at every connection, not the immediate close.
- **Read-only.** The stream at `GET /_marmeon/live` never writes the session, sets no cookie and takes no flash message.

> [!NOTE]
> Channel tokens do not expire while their session lives. Without a `LiveAuthorizer`, a user who loses access to a channel keeps
> hearing *that* it changed, its name, when, and the sequence numbers of its hints, until the session ends. Every reload this
> causes meets the route's policy, so no data reaches them. [Who may follow a channel](#who-may-follow-a-channel) ends it.

## Who may follow a channel

A token proves that a page was signed for the session, not that the session may still hear the channel. A module lists
`liveAuthorizers`, and the stream asks every one of them about each channel at each connection, which includes every reconnect and
comes after the tokens and the sign-in check:

```ts title="modules/teams/TeamsLiveAuthorizer.ts"
import { Auth } from '@marmeon/auth';
import type { HttpContext, LiveAuthorizer } from '@marmeon/http';
import { TeamMembers } from './TeamMembers.ts';

export class TeamsLiveAuthorizer implements LiveAuthorizer {
  readonly #auth: Auth;
  readonly #members: TeamMembers;

  constructor(auth: Auth, members: TeamMembers) {
    this.#auth = auth;
    this.#members = members;
  }

  async allows(channel: string, _ctx: HttpContext): Promise<boolean> {
    const team = /^team\.(\d+)$/.exec(channel)?.[1];
    if (team === undefined) return true; // not a channel this authorizer decides
    const user = await this.#auth.user();
    return user !== undefined && (await this.#members.has(Number(team), user.id));
  }
}
```

```ts title="modules/teams/index.ts"
export default defineModule({ name: 'teams', liveAuthorizers: [TeamsLiveAuthorizer] });
```

- **Every authorizer must say `true`.** The authorizers of all modules are asked, so each one answers `true` for the channels it
  does not decide, and a channel stays only if none of them objects. The class is built for each request, with its dependencies.
- **Only `true` keeps a channel.** Every other answer leaves it out of the stream: the stream opens for the channels that remain,
  and its `hello` names only those. If none remain, the answer is a `403`.
- **A throw is a `503`** with `Retry-After: 5` and no stream, logged at most once a minute. The tab connects again by itself.
- **It takes effect at the next connection.** A removed member keeps the stream that is open until it closes, which is after
  `LIVE_MAX_STREAM_SECONDS` (15 minutes) at the latest, and then hears nothing more. It does not close open streams at once. The
  hint carries no data, and the reload meets the route's policy.
- **Not asked** for a channel whose token is wrong, nor for a stream whose sign-in has ended.
- **Without any** nothing changes: a signed channel is the session's to follow.

Another way needs no authorizer: a channel for each membership, such as `memberships.<id>`, that your code refreshes only for
current memberships. A removed member's tab still holds a valid token, but nothing is sent on that channel for them any more, so
they hear no hints and no new sequence numbers. It costs one hint per member and change.

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
| `LIVE_DRIVER` | `memory` | How hints travel: `memory` within one process, `database` through a table of the app's database, `redis` to every process. |
| `LIVE_CONNECTION` | `default` | The database or Redis connection of the `database` and `redis` drivers. |
| `LIVE_POLL_MILLISECONDS` | `500` | How often the `database` driver looks for hints of other processes, from 50 to 10000. |
| `LIVE_HEARTBEAT_SECONDS` | `20` | Seconds between heartbeats on an idle stream, from 1 to 300. |
| `LIVE_RETRY_MILLISECONDS` | `3000` | Milliseconds before a browser opens a broken stream again, from 100 to 600000. |
| `LIVE_MAX_STREAMS` | `1000` | Open streams per process. Beyond it, `503` with `Retry-After: 10`. |
| `LIVE_MAX_STREAMS_PER_SESSION` | `16` | Open streams of one session per process. Beyond it, `429` with `Retry-After: 30` and a warning in the log. |
| `LIVE_MAX_STREAM_SECONDS` | `900` | How long a stream lives at most, from 30 to 86400. It then closes (up to a quarter earlier, by chance) and its browser connects again and is checked. |
| `LIVE_MAX_CHANNELS` | `20` | Channels per stream, at most 200. Beyond it, `400`. |

The app fails at the start without an `APP_KEY`, with `LIVE_DRIVER=redis` but no `@marmeon/redis`, with a Redis client that does
not load, or with an unknown Redis connection. It fails likewise with `LIVE_DRIVER=database` but no `@marmeon/database` (or its
provider), or with an unknown database connection. It does not connect to Redis at the start: an unreachable server shows with the
first hint.

The `database` driver needs its table. Without it the app starts, but `/up/ready` and `marmeon check` (readiness) are red and say
`marmeon make:live-table && marmeon migrate`. They are red as well for a `live_hints` table whose `id` does not count up for good
(`AUTOINCREMENT` on SQLite, an identity or serial column on Postgres): a table made by hand with a plain `integer primary key` would hand out
the id of a deleted row again, and a process would skip the new hint. Create the table again from the migration of the command.

### Limits

The limit per session keeps one user, or a script with their cookie, from taking every stream of the process. Sixteen tabs of one
browser stay connected, and the seventeenth tries again 30 seconds later. The key is the session, not the address, because many
users of one company share an address. Someone who makes a fresh session for every request meets the limit per process; a flood of
connections belongs to the limits of your proxy.

A stream takes its place in the counts before it waits for anything, so fifty tabs that open at once never get past a limit. The
counts are each process's own: with four processes, a session may hold 16 streams in each.

## More than one process

`LIVE_DRIVER=memory` reaches the streams of its own process only. Choose `database` or `redis` as soon as there is more than one:

- **`marmeon start --workers`** fails at the start with `memory`, with a `LiveSetupError`: "memory pub/sub never reaches the
  other workers — use LIVE_DRIVER=database … or LIVE_DRIVER=redis". A hint would reach the tabs of one server only. `database` and
  `redis` start.
- **Queue workers and the scheduler** send hints too, such as a queued notification. They publish, and the web processes deliver.
  That works through `database` or `redis`. With `memory` such a process has no stream to deliver to, so its hint reaches no web
  process and is lost. It logs one warning, at its first hint: set `LIVE_DRIVER=database` or `redis`. In development and tests,
  where one process serves everything, there is no warning, and neither in a process that handles requests, whichever server it uses.
- **Several containers or machines** need one of them for the same reason.

### The database driver

`LIVE_DRIVER=database` carries the hints in a table of the app's database, `live_hints`. Create it once:

```sh
pnpm marmeon make:live-table
pnpm marmeon migrate
```

The command writes the migration into `modules/system` (`--module=<name>` picks another module), like the tables of the
[queue](queues.md) and the [sessions](session.md#the-database-driver). The table is the app's, and `marmeon db:types` sees it.
A row holds a channel and the names of the props to reload (or the scope of a session that ended), never data. Each process writes
a row when it sends a hint, and polls the table every `LIVE_POLL_MILLISECONDS` for the rows of the others, so:

- **In the process that sends a hint** its streams hear it at once. **In every other process** a hint arrives within the poll
  interval (500 milliseconds by default), and so does the end of a session. Lower the interval for a faster reaction at the price of
  more queries. They are per process, not per stream: a poll reads the new rows, and one that finds none also reads the table's id
  counter, which takes two small queries on SQLite and one on Postgres.
- **On SQLite**, every process of **one machine** shares the file: `marmeon start --workers`, `marmeon queue:work` and the
  scheduler. The file is written in WAL mode, and a poll only reads. Give the hints a SQLite file of their own with
  `LIVE_CONNECTION=system`, as [the database page](database.md#infrastructure-connections) describes for the other drivers.
  SQLite cannot reach another machine.
- **On Postgres**, processes on **several machines** share the database. Hints use the small pool for infrastructure
  (`DB_INFRA_POOL_MAX`) and never join a transaction of your code. A serverless Postgres that sleeps when idle stays awake
  while a process polls it: use `redis` or `memory` there.
- A hint is written after the transaction that caused it committed, like with Redis. A rollback sends nothing.
- Each polling process deletes the rows nobody needs: those of ended sessions after five minutes, rows a newer hint of their
  channel replaced after five minutes, everything after a day. There is no command to run.

While polls fail, such as when the database is down, the streams stay open, the failure is logged, and the process catches up when
polling works again. The end of a session (signed out) or of an account's sign-ins, announced meanwhile, reaches the
streams of a process whose polls failed for more than five minutes only when the stream's maximum time (`LIVE_MAX_STREAM_SECONDS`)
runs out and its browser is checked again, the same as during a Redis outage.

### The Redis driver

Choose `LIVE_DRIVER=redis` for many machines, a high volume of hints or the lowest latency: Redis delivers to every process at
once and needs no table. `@marmeon/redis` brings the Redis client, and the [Redis](redis.md#which-connection-a-driver-uses) page
covers its connection.

A server subscribes to the backend before its port accepts connections (for up to five seconds, then it starts anyway), so a stream never misses the end of its session. An app that serves through its own server built on `createHttpKernel`, not `startServer`, has its first streams connect once more after the start.

## Catching up

Every hint carries its channel's sequence number. When a stream opens it says each channel's number, and the tab compares. A
channel that moved while the tab was away reloads **once**, however many hints it missed: after a broken connection, a frozen tab
or a restart of the server. Sequence numbers live a day after a channel's last hint, so a tab away longer reloads once anyway. With
the `database` driver a channel's number is the id of its last row in `live_hints`; it rises across channels and skips numbers,
which is all a tab compares. The `memory` driver also forgets the channels hinted longest ago beyond 10 000, and counts on above every number it forgot.

A number that starts again, because its Redis key expired or was flushed, never silences a stream: an open stream delivers every
hint whatever its number, and a reconnect that finds another number than it knew reloads that channel once. When the server stops,
it closes every stream, and the browsers connect to the next server and catch up.

## A stream of another version

The tab opens its stream with `v=1` in the query (`GET /_marmeon/live?v=1&connection=…&c=…`), and the frames of the stream and
the messages between processes are fixed with that version. The server answers a request whose `v` is missing, is another one, or
is given twice with `204` and no stream, before it reads a token or asks who the session is. The browser
stops its own reconnecting after a `204`, so a tab left open across a deploy that changed the version stops its live updates. The
tab asks again every 30 seconds and gets the same cheap `204` (the session is read, no stream opens) until its next visit meets
the new build's asset-version `409` and reloads ([a new version of the app](navigation.md#a-new-version-of-the-app)). The mark is
part of the [list of formats](releases.md#stored-and-wire-formats); an app does nothing for it.

## Behind a proxy

A stream holds a connection open for each tab. Over HTTP/1.1 a browser opens at most six connections per host, so on such a page
the client keeps a stream only while its tab is visible. The development server speaks HTTP/1.1, so in development with many tabs
this fallback is active. Behind a proxy that speaks HTTP/2 to the browser, every tab stays connected.

The stream sends `X-Accel-Buffering: no` and `Cache-Control: no-cache, no-store, no-transform`, and the app never compresses it. A
proxy that buffers or compresses `text/event-stream` holds hints back. Its idle timeout must be longer than `LIVE_HEARTBEAT_SECONDS`. The
[deployment](deployment.md#live-updates-need-http2) page shows the settings for Caddy, nginx and other proxies.

## What there is not

Real-time updates are the hints on this page. These are not part of the framework:

- **Broadcasting over WebSockets:** no WebSocket server or client, no Pusher-compatible protocol, no driver for a hosted service.
- **Data events:** a stream never carries data. A tab always reloads through its route.
- **Presence channels:** no list of who is on a page.
- **Client events:** tabs never send each other anything through the server.
- **Encrypted channels**, a `LISTEN/NOTIFY` wake-up for the `database` driver, and a retry for a hint lost while Redis was down.

## Testing

In a test, hints go out as in production, and `app.broadcast` records them. `app.live(path)` opens the stream of a page, signed for
the test's session (`BroadcastTester` and `LiveStreamReader`, to type a variable, come from `@marmeon/live/testing`):

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
