# @bespokecore/notifications

Notifications (E92): a class per notification — a stable name, the schema of its data, `via()` for its channels and a
`to…()` per channel —, sent to **recipients as data** (`{ type: 'user', id }`), delivered by a worker through the
channels `mail` and `database`, read back from an **Inbox that is always bound to its recipient**. The channel contract is
open: `live` comes with `@bespokecore/live` (W6 step 10), Web Push with `@bespokecore/pwa` (W8.6, E93).

```ts
// modules/auth/notifications/NewSignInNotification.ts — and `notifications: [NewSignInNotification]` in defineModule
export class NewSignInNotification implements Notification<'user'> {
  static readonly notification = 'auth.new-sign-in';                    // what the queue and the table store — never the class name
  static readonly schema = v.object({ at: v.string(), ip: v.nullable(v.string()), agent: v.nullable(v.string()) });
  static readonly database = v.object({ at: v.string(), ip: v.nullable(v.string()), browser: v.nullable(v.string()) });
  static readonly queue = { queue: 'mail' };                            // its job — and its mail — on the `mail` queue

  constructor(app: AppConfig) { … }                                     // built per delivery through the container

  via(user: User) { return user.email_verified_at ? (['database', 'mail'] as const) : (['database'] as const); }
  toDatabase(data: NotificationData<typeof NewSignInNotification>): DatabaseInput<typeof NewSignInNotification> { … }
  toMail(user: User, data: NotificationData<typeof NewSignInNotification>, t: Translator) { return new NewSignInMail(…, t); }
}

// Recipients as data (declaration merging) and, in the module that owns them, how they are found again:
declare module '@bespokecore/notifications' { interface NotificationRecipients { user: User } }
defineModule({ name: 'auth', recipients: { user: UserRecipients } });   // find(id), locale(user)

await this.#notifications.send({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent });     // queued (default)
await this.#notifications.sendNow({ type: 'user', id: user.id }, NewSignInNotification, { at, ip, agent });  // here and now

const me = { type: 'user', id: ctx.user.id } as const;
await this.#inbox.count(me);                                           // the bell
if (!(await this.#inbox.markRead(me, ctx.params.notification))) abort(404);   // someone else's id: 404, nothing changed
```

```text
bespoke make:notifications-table [--module=system] | notifications:prune [--days=30] [--unread-days=N]
```

## Sending

- **`send(recipient | recipients, Notification, data)`** checks now — the class is registered (`notifications: [...]` of a
  module), a module finds the kind of recipient (`recipients: { user: … }`), the data matches `static schema` — and queues
  one **`bespoke.notification`** job per recipient (encrypted, E105; three tries, or `static queue.tries`). Inside
  `connections.transaction()` it is queued with the commit (E107) — on the database queue it is a row in the transaction.
- **`sendNow(…)`** delivers in the calling process (a job, a queued listener — already in a worker). Inside a transaction
  the delivery is part of it.
- **Delivery** (worker or `sendNow`): the recipient's record by its resolver (gone: dropped), `via(record, data)`, the
  recipient's language (`locale()` of the resolver → `Translators.for`), then **one transaction** of the notifications'
  connection: the `database` row first, the other channels after it. The notification's id (a UUID) is the row's: a job
  that runs again after a committed delivery (at-least-once, E85) finds it and stops — nothing twice. (Without the
  database channel a repeat can send again; with a non-database queue a crash right after the commit can lose the queued
  mail.)
- **After a deploy:** data that no longer matches the schema fails the job at once (no retries that cannot succeed); a
  notification the worker does not know (renamed, or a rolling deploy) retries by its tries; a channel the app does not
  have fails at once.

## Channels

- **`database`** — `toDatabase(data, recipient)`, checked by **`static database`**: only what the schema lets through is
  stored (a field it does not know stays out — and is a type error where the notification is sent).
  `notificationData(row, NewSignInNotification)` reads a row back typed (undefined for a row a deploy changed).
- **`mail`** — `toMail(recipient, data, t)` with `t` in the **recipient's** language (never the request's); the mail is
  **queued** (`mailer.queue`, E105) on the notification's queue: composed now, sent by `bespoke.mail` with its own
  retries — a mail server that is down never repeats the row or another channel. Needs `@bespokecore/mail` (and a queue).
- **Your own** (`live` in W6 step 10, Web Push in W8.6): add the name and what a notification needs for it to
  `interface NotificationChannelMap`, and register the channel at boot:

  ```ts
  declare module '@bespokecore/notifications' { interface NotificationChannelMap { live: {} } }
  container.make(NotificationChannels).add('live', (scope) => new LiveChannel(scope.make(Broadcaster)));
  ```

  A channel's `deliver(delivery)` runs inside the delivery's transaction: what it writes or queues commits with the
  row; something that waits for the commit uses `afterCommit(fn)`. A channel that talks to the outside world (a push
  service) queues a job of its own, so a retry repeats only that.

### Web Push (E93): generic payloads

A push message goes through the browser vendor's push service and shows on a **lock screen**. The Web Push channel
(W8.6, with `@bespokecore/pwa`) therefore sends a **generic** text by default — "You have a new notification" —, never the
notification's content: the details load after the click, behind authentication, from the inbox. Opting into more text is
per notification and explicit.

## The Inbox — always bound to the recipient

Every method takes **whose** notifications it reads or changes — `unread(r)`, `latest(r)`, `count(r)`, `markRead(r, id)`,
`markAllRead(r)` — and every statement carries `recipient_type`/`recipient_id`: an id of somebody else's notification
finds nothing (`markRead` → `false` → the controller answers 404). Ids that are no UUID are refused before any query.
The recipient comes from who is signed in, never from the request's input.

## The table (E96)

`bespoke make:notifications-table` writes the migration into an app module (`system` by default): `id` (uuid),
`recipient_type`, `recipient_id`, `type`, `data` (json), `read_at`, `created_at`. `NOTIFICATIONS_CONNECTION` (default
`default`) is an app connection — notifications are the app's data and join its transactions (unlike the cache, E108).
`bespoke notifications:prune` deletes, in one statement, notifications read more than `--days` (30) ago — unread ones
only with `--unread-days`:

```ts
s.command('notifications:prune', ['--days=30']).daily().at('03:30').withoutOverlapping().onOneServer();
```

## Testing

`createTestApp()` puts a **`NotificationFake`** in place (`notifications: 'fake'`, the default): sends are checked as for
real and recorded — `app.notifications.assertSent({ type: 'user', id }, NewSignInNotification, { ip })`,
`assertSentTimes`, `assertNotSent`, `assertNothingSent`, `sent(…)`; `await app.notifications.deliver()` delivers them for
real (rows, queued mails). `notifications: 'real'` keeps the real one: `send` then queues on the `QueueFake`, and
`app.queue.work()` delivers.

## Type checks

Where a notification is sent: an unknown kind of recipient or a wrong id type, data the schema does not take, `via()`
for another kind of recipient, a channel the app does not have, a channel without its method, `toDatabase()` returning a
field `static database` does not have, data that is no JSON, a class without `static notification` — each a readable
error (message-as-type), e.g. *"Property ''via() returns a channel this app does not have'' is missing in type 'typeof
Texted'"*. `implements Notification<'user'>` checks `via()` where the class is written.
