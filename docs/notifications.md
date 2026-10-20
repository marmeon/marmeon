# Notifications

## Introduction

A notification tells a user that something happened: a sign-in from a new browser, a note shared with them. It may reach them
by mail, in a list inside the app, and live in their open tabs. `@marmeon/notifications` makes each notification a class: a
stable name, the schema of its data, the channels it takes and what it says on each. You send it to a recipient as data, a kind
and an id, and a worker delivers it.

Add the package and the table its database channel writes:

```sh
pnpm add @marmeon/notifications
pnpm marmeon make:notifications-table
pnpm marmeon migrate
```

A notification that tells a user about every sign-in with a password. Its mail class, `NewSignInMail`, and `describeBrowser()`,
which names the browser of a user agent, are the app's own files:

```ts title="modules/auth/notifications/NewSignInNotification.ts"
import type { Translator } from '@marmeon/i18n';
import type { DatabaseInput, Notification, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { NewSignInMail } from '../mail/NewSignInMail.ts';
import type { User } from '../users.ts';
import { describeBrowser } from './browser.ts';

export class NewSignInNotification implements Notification<'user'> {
  static readonly notification = 'auth.new-sign-in';
  static readonly schema = r.object({ at: r.isoTimestamp(), ip: r.string().nullable(), agent: r.string().nullable() });
  static readonly database = r.object({ at: r.string(), ip: r.string().nullable(), browser: r.string().nullable() });
  static readonly queue = { queue: 'mail' };

  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    this.#app = app;
  }

  via(user: User) {
    return user.email_verified_at !== null ? (['database', 'live', 'mail'] as const) : (['database', 'live'] as const);
  }

  toDatabase(data: NotificationData<typeof NewSignInNotification>): DatabaseInput<typeof NewSignInNotification> {
    return { at: data.at, ip: data.ip, browser: describeBrowser(data.agent) };
  }

  toMail(user: User, data: NotificationData<typeof NewSignInNotification>, t: Translator) {
    const url = new URL('/settings/security', this.#app.url).href;
    return new NewSignInMail(user, { at: data.at, ip: data.ip, browser: describeBrowser(data.agent) }, url, t);
  }
}
```

Every user gets it in the app's list and live in their open tabs. The mail goes only to a confirmed address, since an
unconfirmed one may not even be the user's. Sending it takes the recipient, the class and the data:

```ts
await this.#notifications.send({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent });
```

## Defining notifications

`make:notification` writes a notification class into a module and adds it to the module's `notifications` (`--no-register` prints the lines instead):

```sh
pnpm marmeon make:notification NoteShared --module=notes
```

This one tells a user that a note was shared with them. The data is the note's id:

```ts title="modules/notes/notifications/NoteSharedNotification.ts"
import type { DatabaseInput, Notification, NotificationData } from '@marmeon/notifications';
import { rules as r } from '@marmeon/validation';

export class NoteSharedNotification implements Notification<'user'> {
  static readonly notification = 'notes.note-shared';
  static readonly schema = r.object({ noteId: r.integer() });
  static readonly database = r.object({ noteId: r.integer() });

  via() {
    return ['database'] as const;
  }

  toDatabase(data: NotificationData<typeof NoteSharedNotification>): DatabaseInput<typeof NoteSharedNotification> {
    return { noteId: data.noteId };
  }
}
```

- **`static notification`** is the stable name that the queue and the table store. Never the class name: renaming the class must
  not break what waits in the queue or lies in the table.
- **`static schema`** describes the data a notification is sent with, as JSON: ids, not records. The data is checked when it is
  sent and again before it is delivered.
- **`via(recipient, data)`** returns the channels for this recipient, and may be `async`.
- **A method per channel**: `toDatabase()` for `database` and `toMail()` for `mail`.
- **`static database`** checks what the database channel stores. Only the fields it describes are kept.
- **`static queue`** picks the queue, `connection`, `delay`, `tries` and `backoff` of the notification's job. Its mail goes to
  the same queue and connection, with the mail's own retries. Without `tries` the job tries three times, 10 seconds and then a
  minute apart.

The class is built through the container for each delivery, so its constructor gets what it asks for. A module lists its
notifications, and only a listed notification can be sent:

```ts
export default defineModule({ name: 'notes', routes, notifications: [NoteSharedNotification] });
```

`marmeon dev` and `marmeon build` warn about a notification class that no module lists (see the [development server](console.md#the-development-server)).

`implements Notification<'user'>` checks `via()` and the channel methods where the class is written. Where a notification is
sent, the compiler checks the rest: a kind of recipient the app does not have, an id of the wrong type, data the schema does not
take, a channel the app does not have or a channel without its method, and a field of `toDatabase()` that `static database` does
not describe. Each error says what is wrong.

## Recipients

A kind of recipient is declared once, and the module that owns it says how a delivery finds it again. A worker never gets a
record carried in a job, which would be stale by then: it gets the kind and the id, and reads the recipient as it is now.

```ts title="modules/auth/UserRecipients.ts"
import type { RecipientResolver } from '@marmeon/notifications';
import { UserRepository } from './UserRepository.ts';
import type { User } from './users.ts';

declare module '@marmeon/notifications' {
  interface NotificationRecipients {
    user: User;
  }
}

export class UserRecipients implements RecipientResolver<'user'> {
  readonly #users: UserRepository;

  constructor(users: UserRepository) {
    this.#users = users;
  }

  find(id: number): Promise<User | undefined> {
    return this.#users.find(id);
  }

  locale(user: User): string | null {
    return user.locale;
  }
}
```

The auth module lists it: `defineModule({ name: 'auth', recipients: { user: UserRecipients }, … })`. `find()` returning nothing
drops the notification: the account is gone. `locale()` decides the language of the notification's mail, through
`Translators.for()`, and without it the mail speaks `APP_LOCALE`. The
[localization](localization.md#translators-any-language-anywhere) page explains why the recipient's language counts, never the
request's.

The start fails for two notifications with one name, a class without `static notification`, two resolvers for one kind of
recipient, or an unknown connection.

## Sending notifications

Inject `Notifications`:

| Method | What it does |
| --- | --- |
| `send(recipient, Notification, data, { delay }?)` | Checks now, and queues one job per recipient. |
| `sendNow(recipient, Notification, data)` | Delivers in the calling process. |

`send()` takes one recipient or a list. It checks the class, the kinds of recipient and the data at once, so a mistake fails
where it was made, and then queues one job per recipient. The job is encrypted, since a notification's data is the app's. Inside a
transaction it is queued with the commit, and a rollback sends nothing.

`sendNow()` is for code that already runs in a worker, such as a job or a queued listener: a second job would only add a hop.
The sign-in notification above is sent by a queued listener of the `Login` event of `@marmeon/auth`:

```ts title="modules/auth/listeners/NotifyAboutNewSignIn.ts"
import type { Login } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { Notifications } from '@marmeon/notifications';
import { NewSignInNotification } from '../notifications/NewSignInNotification.ts';

export class NotifyAboutNewSignIn {
  static readonly queue = {};

  readonly #notifications: Notifications;

  constructor(notifications: Notifications) {
    this.#notifications = notifications;
  }

  async handle(payload: EventPayload<typeof Login>): Promise<void> {
    if (payload.via !== 'attempt') return;
    await this.#notifications.sendNow({ type: 'user', id: payload.userId as number }, NewSignInNotification, { at: payload.at, ip: payload.ip, agent: payload.userAgent });
  }
}
```

A delivery, in a worker or by `sendNow()`, finds the recipient again, asks `via()`, picks the recipient's language and runs the
channels in **one transaction** of the notifications' connection: the `database` row first, the other channels after it. The
notification's id is the row's id. A job that runs again after a delivery that committed finds the row and stops, so nothing is
delivered twice. Without the `database` channel, a repeated job can send again. On a queue other than the database's, a crash
right after the commit can lose a mail that waited for it.

After a deploy, data that no longer matches the schema fails its job at once, without retries that cannot succeed. A notification
the worker does not know, renamed or from a newer version during a rolling deploy, retries by its tries. A channel the app does
not have fails at once.

## Channels

### The database channel

`toDatabase(data, recipient)` returns what the row keeps, and `static database` checks it: a field the schema does not describe
stays out. The [inbox](#the-inbox) reads the rows back, and `notificationData(row, NewSignInNotification)` gives a row's data
typed, or `undefined` for a row of another kind or one a deploy changed.

### The mail channel

`toMail(recipient, data, t)` returns a mail, and `t` speaks the **recipient's** language. The mail is queued on the
notification's queue: composed now and sent by a mail job with its own retries, so a mail server that is down never repeats the
row or another channel. The channel needs `@marmeon/mail` and a queue. The [mail](mail.md) page covers mails.

### The live channel

With `@marmeon/live` installed, `via()` may return `'live'`. Once the delivery committed, the recipient's open tabs hear a hint
on `notificationsChannel(recipient)`, and what follows that channel, such as a bell, reloads. A hint from a worker reaches the
web servers only with `LIVE_DRIVER=redis`. The [real-time updates](realtime.md#sending-hints) page explains hints.

### A channel of your own

A channel is a class with `deliver(delivery)`. Add its name to `NotificationChannelMap`, with what a notification needs for it,
and register it when your provider boots. The app lists the provider, as the [service providers](providers.md) page shows:

```ts title="modules/sms/SmsServiceProvider.ts"
import type { Application, ServiceProvider } from '@marmeon/core';
import { NotificationChannels } from '@marmeon/notifications';
import { SmsChannel } from './SmsChannel.ts';

declare module '@marmeon/notifications' {
  interface NotificationChannelMap {
    sms: { toSms(recipient: any, data: any): string };
  }
}

export class SmsServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(NotificationChannels).add('sms', (container) => container.make(SmsChannel));
  }
}
```

`deliver()` gets the notification's id, its instance, the recipient's record, the data, a translator in the recipient's language
and the queue to use. It runs inside the delivery's transaction: what it writes or queues commits with the row. A channel that
talks to the outside world queues a job of its own, so a retry repeats only that, and work that must wait for the commit goes
through `afterCommit()`.

> [!WARNING]
> A push message passes the push service of the browser's vendor and shows on a lock screen. A push channel of your own should send
> a generic text, such as "You have a new notification", never the notification's content: the details load after the click,
> behind the sign-in, from the inbox.

## The Inbox

The `Inbox` reads and changes a recipient's notifications, and every method takes **whose**:

| Method | What it does |
| --- | --- |
| `count(recipient)` | How many are unread: the bell's number. |
| `unread(recipient, { limit = 20 }?)` | The unread ones, newest first. |
| `latest(recipient, { limit = 50 }?)` | The latest, read or not. |
| `page(recipient, { cursor?, perPage = 20, encrypter })` | A page for "load more", newest first, at most 500. |
| `markRead(recipient, id)`, `delete(recipient, id)` | One notification. `false` when the recipient has none with this id. |
| `markAllRead(recipient)`, `deleteAll(recipient)` | All of them, and how many. |

`unread()` and `latest()` return rows with `id`, `type`, `data`, `readAt` and `createdAt`, the times as ISO strings. `page()`
returns them as `data`, with `meta.nextCursor` for the next page.

Every statement carries the recipient, so an id of somebody else's notification finds nothing and changes nothing. Answer 404
for it, as for an id that does not exist:

```ts title="modules/notifications/controllers/MarkNotificationReadController.ts"
import type { Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { Inbox } from '@marmeon/notifications';

export class MarkNotificationReadController extends Controller {
  readonly #inbox: Inbox;

  constructor(inbox: Inbox) {
    super();
    this.#inbox = inbox;
  }

  async handle(ctx: HttpContext<Authenticated, { notification: string }>) {
    if (!(await this.#inbox.markRead({ type: 'user', id: ctx.user.id }, ctx.params.notification))) abort(404);
    return this.json({ read: ctx.params.notification });
  }
}
```

Take the recipient from who is signed in, never from the request's input. An id that is no UUID is refused before any query.
`page()` encrypts its cursor with the app's key and binds it to the recipient: inject the `Encrypter` and pass it. A forged
cursor, or one of another recipient's list, answers 400.

## The notifications table

`make:notifications-table` writes the migration into the `system` module, or the module `--module` names. It is `marmeon publish
@marmeon/notifications`: when your app has the migration already, it writes nothing and ends with exit code 0. The migration runs on
`NOTIFICATIONS_CONNECTION`. The table is `notifications` and holds `id`, `recipient_type`, `recipient_id`, `type`, `data`, `read_at` and `created_at`.

| Variable | Default | Effect |
| --- | --- | --- |
| `NOTIFICATIONS_CONNECTION` | `default` | The database connection of the `notifications` table. |

Notifications are the app's own data. Unlike the cache, they join the app's transactions on their connection. A listener of the
starter kit's `AccountDeleted` event can delete a user's notifications with `deleteAll()` inside the deletion's transaction.

`notifications:prune` deletes, in one statement, the notifications read more than 30 days ago. `--days` changes the age, and
unread ones go only with `--unread-days`. Schedule it:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('notifications:prune', ['--days=30']).daily().at('03:30').withoutOverlapping().onOneServer();
});
```

## Testing

A test app replaces `Notifications` with a fake. A send is checked as for real and recorded, and `deliver()` delivers what was
recorded, the rows and the queued mails included. The test below posts to a share route of the notes module, whose controller
sends `NoteSharedNotification` with the note's id to the user with the posted address:

```ts title="modules/notes/share-notification.test.ts"
import { Inbox } from '@marmeon/notifications';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteRepository } from './NoteRepository.ts';
import { NoteSharedNotification } from './notifications/NoteSharedNotification.ts';

it('notifies the person a note is shared with', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const bob = await app.factory(UserFactory).create({ email: 'bob@example.com' });
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Groceries', body: '' });
  await app.actingAs(ada).post(`/notes/${note.id}/share`, { form: { email: 'bob@example.com' } }).assertRedirect();
  app.notifications.assertSent({ type: 'user', id: bob.id }, NoteSharedNotification, { noteId: note.id });
  await app.notifications.deliver();
  expect(await app.make(Inbox).count({ type: 'user', id: bob.id })).toBe(1);
});
```

`assertSentTimes`, `assertNotSent` and `assertNothingSent` check the rest. `createTestApp(app, { notifications: 'real' })` keeps the
real service, and then `app.queue.work()` runs the jobs. The [fakes](fakes.md#notifications) page covers every fake.
