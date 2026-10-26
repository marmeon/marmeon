# Fakes

## Introduction

A test should not send mail, fill a real queue or write to S3. `createTestApp()` replaces those services with fakes: each one
records what the app asked of it, checks it as the real service would, and lets the test assert on it. The fakes are in place by
default, as soon as the app has the package:

| Fake | Replaces | Keep the real service with |
| --- | --- | --- |
| `app.mail` | The `Mailer`. Records mails instead of sending them. | `mail: 'real'` |
| `app.queue` | The `Queue`. Records jobs, and `work()` runs them. | `queue: 'real'` |
| `app.notifications` | `Notifications`. Records notifications, and `deliver()` delivers them. | `notifications: 'real'` |
| `app.storage` | `Storage`. Every disk lives in memory. | `storage: 'real'` |
| `app.events` | Nothing. Records every event; listeners still run unless you hold them back. | `events: 'real'`, the default |
| `app.broadcast` | Nothing. Records every live hint, which still reaches the streams. Needs `@marmeon/live`. | always in place |
| `app.schedule` | Nothing. Runs the schedule on the test's clock. Needs `@marmeon/scheduler`. | always in place |

A getter whose package the app lacks, or whose fake the test turned off, says so:

```text
app.queue needs @marmeon/queue in the app (and not createTestApp(…, { queue: 'real' })).
```

A test reaches the fakes through `app`. The classes behind the mail, queue, notifications, storage and schedule fakes (`MailFake`,
`QueueFake`, `NotificationFake`, `StorageFake`, `ScheduleTester`) are in the `/testing` subpath of their package, for the one who types a
variable with them: `import type { QueueFake } from '@marmeon/queue/testing'`. The same holds for `BroadcastTester` and `LiveStreamReader` (`@marmeon/live/testing`) and for `DevtoolsTester` (`import type { DevtoolsTester } from '@marmeon/devtools/testing'`). A `*Tester` drives or reads the real
service: `ScheduleTester`, `BroadcastTester` and `DevtoolsTester`.

The devtools record into memory with `devtools: true`, as the [devtools](devtools.md#testing) page shows, and the clock is the
subject of the [time](time.md) page.

## Mail

The mail fake composes every mail as the real mailer does, so a broken template, a relative link or an invalid address fails the
test. It keeps mails sent at once, with `mailer.send()`, apart from queued ones, with `mailer.queue()`:

```ts title="modules/auth/verification-mail.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { VerifyEmailMail } from './mail/VerifyEmailMail.ts';

it('mails the new account its verification link', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.post('/register', {
    form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' },
  });
  app.mail.assertNothingQueued();

  await app.queue.work();
  app.mail.assertQueued(VerifyEmailMail, (_mail, message) => message.to[0]!.address === 'kj@example.com');
  const [queued] = app.mail.queued(VerifyEmailMail);
  expect(queued!.message.text).toContain('/email/verify/');
});
```

The registration only queues a listener, so no mail exists until `work()` runs it. Each recorded mail comes with the mailable,
its composed message and, for a queued one, its queue options:

| Assertion | Passes when |
| --- | --- |
| `assertSent(Mail, filter)` | A mail of that class was sent, matching `filter(mail, message)` when given. |
| `assertSentCount(Mail, n)` | Exactly `n` of that class were sent. |
| `assertNotSent(Mail, filter)`, `assertNothingSent()` | None of that class, or no mail at all, was sent. |
| `assertQueued(Mail, filter)` | A mail of that class was queued, matching `filter(mail, message, options)` when given. |
| `assertQueuedCount(Mail, n)` | Exactly `n` of that class were queued. |
| `assertNotQueued(Mail, filter)`, `assertNothingQueued()` | None of that class, or no mail at all, was queued. |

`sent(Mail, filter)` and `queued(Mail, filter)` return the records themselves. `assertSent()` on a mail that was queued fails, and
its message says the mail was queued. The fake does not put queued mails on the queue: with `mail: 'real'` they go through the
queue and its `marmeon.mail` job like in production. The [mail](mail.md) page covers writing mails.

## Queue

The queue fake checks a dispatch as the real queue does, against the job's schema and the transaction around it, and records it
instead of queuing it. `app.queue.work()` then runs the jobs for real, in the test's process:

```ts title="modules/auth/password-reset.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';
import { SendPasswordResetLinkJob } from './jobs/SendPasswordResetLinkJob.ts';
import { ResetPasswordMail } from './mail/ResetPasswordMail.ts';

it('queues a job for every address, and mails only the known one', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.post('/forgot-password', { form: { email: ada.email } });
  await app.post('/forgot-password', { form: { email: 'nobody@example.com' } });

  app.queue.assertDispatchedTimes(SendPasswordResetLinkJob, 2);
  app.queue.assertDispatched(SendPasswordResetLinkJob, { email: ada.email });

  expect(await app.queue.work()).toMatchObject({ failed: 0 });
  app.mail.assertQueuedCount(ResetPasswordMail, 1);
});
```

`work()` runs every job that is due, with the container's injection, a scope per attempt, retries, chains, job middleware and job
events, and jobs that jobs dispatch. It resolves with what it did: `processed`, `failed`, `released`, and the `reason` it stopped.
`work({ queues: ['mail'], maxJobs: 1 })` runs only some queues, or only so many jobs. A job dispatched with a `delay`, or released
with a backoff, waits until the test's clock reaches it: `app.travel({ minutes: 5 })`, then `work()` again. Inside a transaction,
a dispatch is recorded with the commit, and a rollback records nothing.

| Assertion | Passes when |
| --- | --- |
| `assertDispatched(Job, match, { unique })` | The job was dispatched, matching a part of the payload or a function when given, with that unique key when given. |
| `assertDispatchedTimes(Job, n, match)` | It was dispatched exactly `n` times. |
| `assertNotDispatched(Job, match)`, `assertNothingDispatched()` | It was not dispatched, or nothing was. |
| `assertChained([JobA, [JobB, payload]])` | A chain of exactly these jobs was dispatched, in this order. |
| `assertListenerQueued(Listener, match)` | A [queued listener](events.md#queued-listeners) was queued. |
| `assertListenerNotQueued(Listener, match)` | It was not. |

`dispatched(Job, match)` returns the dispatches themselves, with their payload, id, queue, `delaySeconds` and unique key. `pending()` lists
the jobs still waiting, `failed()` the jobs `work()` recorded as failed, and `size(queue)` counts a queue. A unique job takes its
lock in the app's cache as on a real queue, so a second dispatch with the same key is not recorded until `work()` ran the first.
The [queues](queues.md) page covers jobs.

## Notifications

The notification fake checks a send as the real service does: the notification is registered, a resolver knows the recipient's
type, and the data matches the schema. It records the send, and `deliver()` delivers what was recorded through the app's
channels:

```ts title="modules/notes/share-notification.test.ts"
import { Inbox } from '@marmeon/notifications';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteFactory } from './factories/NoteFactory.ts';
import { NoteSharedNotification } from './notifications/NoteSharedNotification.ts';

it('notifies the person a note is shared with, once', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const bob = await app.factory(UserFactory).create({ email: 'bob@example.com' });
  const note = await app.factory(NoteFactory).create({ user_id: ada.id });
  await app.actingAs(ada).post(`/notes/${note.id}/share`, { form: { email: 'bob@example.com' } }).assertRedirect();

  app.notifications.assertSentTimes({ type: 'user', id: bob.id }, NoteSharedNotification, 1);
  app.notifications.assertNotSent({ type: 'user', id: ada.id }, NoteSharedNotification);
  await app.notifications.deliver();
  expect(await app.make(Inbox).count({ type: 'user', id: bob.id })).toBe(1);
});
```

| Assertion | Passes when |
| --- | --- |
| `assertSent(recipient, Notification, match)` | It was sent to the recipient, matching a part of the data or a function when given. |
| `assertSentTimes(recipient, Notification, n)` | It was sent to the recipient exactly `n` times. |
| `assertNotSent(recipient, Notification, match)`, `assertNothingSent()` | It was not sent to the recipient, or nothing was. |

A recipient is `{ type, id }`. `sent(Notification, recipient, match)` returns the records. The fake records `send()` and
`sendNow()` alike. `deliver()` delivers each recorded notification once, oldest first, as a worker would: the database channel
writes its row and the mail channel queues its mail on the mail fake. It resolves with each notification's id and outcome. Inside
a transaction a notification is recorded with the commit. With `notifications: 'real'`, `send()` queues a job, and
`app.queue.work()` delivers it. The [notifications](notifications.md) page covers notifications.

## Storage

The storage fake turns every configured disk into a disk in memory, with the disk's name, visibility and URL. Every test starts
with empty disks, the app's routes serve the files, and temporary links are signed for real:

```ts title="modules/notes/export.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteFactory } from './factories/NoteFactory.ts';

it('exports the notes as JSON to the private disk', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.factory(NoteFactory).create({ user_id: ada.id, title: 'Groceries' });
  await app.actingAs(ada).post('/notes/download').assertRedirect();

  const disk = app.storage.disk('local');
  disk.assertCount(1, 'exports');
  disk.assertExists(`exports/notes-${ada.id}.json`, (bytes) => new TextDecoder().decode(bytes).includes('"Groceries"'));
  app.storage.disk('public').assertCount(0);
});
```

| Assertion | Passes when |
| --- | --- |
| `assertExists(key, contents)` | The file exists, with these contents when given: text, bytes, or a function of the bytes. |
| `assertMissing(key)` | The file does not exist. |
| `assertCount(n, directory)` | The disk, or the directory and everything under it, holds exactly `n` files. |

`files()` lists every key on a disk. A disk name is checked by the compiler as in the app. `app.upload()` sends a file through
the real upload target onto the fake, as the [HTTP tests](http-tests.md#uploads) page shows. The [file storage](storage.md)
page covers disks.

> [!WARNING]
> With `storage: 'real'` the configured disks stay, and a test writes to and deletes from the real file system or bucket. Use it
> only with disks that `.env.test` points at a directory or a bucket for tests.

## Events

Every test app records the events it dispatches. Their listeners run as usual, unless the test holds them back: `events: 'fake'`
holds back every listener, and a list of event classes holds back the listeners of those classes and their subclasses. A
held-back event is recorded and nothing else, so its listeners neither run nor are queued:

```ts title="modules/auth/registered.test.ts"
import { Registered } from '@marmeon/auth';
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendEmailVerification } from './listeners/SendEmailVerification.ts';

it('announces a registration', async () => {
  const app = await createTestApp(application, { database: 'refresh', events: [Registered] });
  await app.post('/register', {
    form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' },
  });

  app.events.assertDispatched(Registered, (event) => event.user.email === 'kj@example.com');
  app.events.assertListening(Registered, SendEmailVerification);
  app.queue.assertListenerNotQueued(SendEmailVerification);
});
```

| Assertion | Passes when |
| --- | --- |
| `assertDispatched(Event, match)` | The event was dispatched, matching a part of its fields or a function when given. |
| `assertDispatchedTimes(Event, n, match)` | It was dispatched exactly `n` times. |
| `assertNotDispatched(Event, match)`, `assertNothingDispatched()` | It was not dispatched, or no event was. |
| `assertListening(Event, Listener)` | The listener is registered for the event, queued or not. |

`dispatched(Event, match)` returns the events themselves, oldest first. The dispatch assertions match subclasses of the class too.
The [events](events.md) page covers events and listeners.

## Live updates

Live hints go out in a test as in production: the streams a test opens receive them. `app.broadcast` records each hint once it
went out, after its transaction committed:

```ts title="modules/user-profile/links-live.test.ts"
import { UserFactory } from '#modules/auth';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('tells the other tabs on the profile, and only after a valid change', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const stream = await app.actingAs(ada).live(`/users/${ada.id}`);
  await stream.hello();

  await app.actingAs(ada).expectingJson().post(`/users/${ada.id}/links`, { json: { label: '', url: 'nope' } }).assertUnprocessable();
  app.broadcast.assertNothingRefreshed();

  await app.actingAs(ada).post(`/users/${ada.id}/links`, { json: { label: 'Blog', url: 'https://ada.example' } }).assertRedirect();
  app.broadcast.assertRefreshed(`users.${ada.id}`, { only: ['profile'], times: 1 });
  await stream.waitFor(1);
  expect(stream.hints).toEqual([{ channel: `users.${ada.id}`, only: ['profile'], seq: 1 }]);
});
```

`assertRefreshed(channel, { only, times })` passes when the channel was refreshed, with exactly those props and that many times
when given. `assertNotRefreshed(channel)` and `assertNothingRefreshed()` check the opposite, and `refreshed(channel)` returns the
records. `app.live(path)` opens the stream of the page at `path` as a tab does, signed for the view's session. `hello()` waits
for the stream's first message, `waitFor(n)` for `n` hints, and `hints` holds them. The [real-time updates](realtime.md) page
explains hints.

## The schedule

`app.schedule` runs the app's schedule on the test's clock:

```ts title="modules/auth/prune-tokens.test.ts"
import { AccessTokenStore } from '@marmeon/auth';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from './factories/UserFactory.ts';

it('prunes expired tokens at night and keeps valid ones', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  app.freeze(Date.parse('2026-10-04T12:00:00Z'));
  await app.make(AccessTokenStore).create(ada.id, 'one hour', { abilities: ['*'], expiresIn: { hours: 1 } });
  const valid = await app.make(AccessTokenStore).create(ada.id, 'a year', { abilities: ['*'], expiresIn: { days: 365 } });

  expect(app.schedule.due('2026-10-05T03:10:00Z')).toContain('auth:prune-tokens');
  const results = await app.schedule.run('2026-10-05T03:10:00Z');
  expect(results.find((result) => result.task === 'auth:prune-tokens')).toMatchObject({ outcome: 'ran' });
  expect((await app.make(AccessTokenStore).list(ada.id)).map((token) => token.id)).toEqual([valid.token.id]);
});
```

| Member | What it does |
| --- | --- |
| `tasks` | The names of every task. |
| `due(time)` | The names of the tasks due in that minute, by frequency and environment. Conditions are asked only when a task runs. |
| `run(time)` | Moves the clock to `time`, runs what is due and what was missed since the last `run()`, and resolves with the results. |
| `runTask(name)` | Runs one task now, as `marmeon schedule:test` does. |

A time is a `Date`, epoch milliseconds or an ISO string such as `'2026-10-04T03:10:00+02:00'`. Each result names its `task` and
its `outcome`: `ran`, `skipped` or `failed`. The [task scheduling](scheduling.md) page covers the schedule.
