# @marmeon/notifications

Notifications for Marmeon apps: classes that reach a recipient by mail, as a row of their inbox and live in their open tabs,
delivered by the queue.

## Installation

```sh
pnpm add -E @marmeon/notifications@<version of your app>
pnpm marmeon make:notifications-table
pnpm marmeon migrate
```

The mail channel uses `@marmeon/mail` and the deliveries the queue, `@marmeon/queue` — a new app has both. The live channel
needs `@marmeon/live`.

## Sending a notification

A notification is a class with a stable name, the schema of its data, the channels it takes (`via()`) and what it says on each;
the [notifications page](https://marmeon.com/docs/notifications#defining-notifications) shows
`NewSignInNotification` in full. Inject `Notifications` and send it to a recipient as data, a kind and an id:

```ts
await this.#notifications.send({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent });
```

`send()` checks the class, the recipient's kind and the data at once, then queues one encrypted job per recipient; a worker
delivers it.

## Documentation

- [Notifications](https://marmeon.com/docs/notifications)
- [Notifications: defining notifications](https://marmeon.com/docs/notifications#defining-notifications)
- [Notifications: the inbox](https://marmeon.com/docs/notifications#the-inbox)
- [Fakes: notifications](https://marmeon.com/docs/fakes#notifications)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
