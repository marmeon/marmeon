# @marmeon/live

Live updates for Marmeon apps: a page follows a channel, and when the server hints a change, every tab that shows it reloads
the props it named through the page's own route.

## Installation

```sh
pnpm add @marmeon/live
```

`LIVE_DRIVER=memory`, the default, carries hints within one process. More than one process needs `LIVE_DRIVER=redis` and
`@marmeon/redis`, which brings the Redis client: `pnpm add @marmeon/redis`.

## Following a channel

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

A write hints the channel with the injected `Broadcaster` — inside a transaction, once it commits:

```ts
await this.#broadcast.refresh(`users.${ctx.params.user.id}`, { only: ['profile'] });
```

A hint says *that* something changed, never *what*: the data always comes from the route, its middleware and its policies.

## Documentation

- [Real-time Updates](https://github.com/marmeon/marmeon/blob/main/docs/realtime.md)
- [Real-time Updates: sending hints](https://github.com/marmeon/marmeon/blob/main/docs/realtime.md#sending-hints)
- [Real-time Updates: more than one process](https://github.com/marmeon/marmeon/blob/main/docs/realtime.md#more-than-one-process)
- [Notifications: the live channel](https://github.com/marmeon/marmeon/blob/main/docs/notifications.md#the-live-channel)
- [Fakes: live updates](https://github.com/marmeon/marmeon/blob/main/docs/fakes.md#live-updates)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
