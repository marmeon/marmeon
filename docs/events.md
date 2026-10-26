# Events

## Introduction

An event says that something happened: a user registered, a note was published. The code where it happens dispatches the
event, and listeners in other modules react to it, without the first module knowing they exist. An event is a class, and its
class is its identity:

```ts title="modules/notes/events/NotePublished.ts"
import type { Row } from '@marmeon/database';

export class NotePublished {
  readonly #event = true;
  readonly note: Row<'notes'>;

  constructor(note: Row<'notes'>) {
    this.note = note;
  }
}
```

A controller or a service injects the `EventDispatcher` of `@marmeon/core` and dispatches it:

```ts
await this.#events.dispatch(new NotePublished(note));
```

Every listener of `NotePublished` has run before `dispatch()` resolves, and a [queued listener](#queued-listeners) has been
queued. The modules list their listeners, so the code that dispatches never names them.

## Defining events

`make:event` writes an event class into a module:

```sh
pnpm marmeon make:event NotePublished --module=notes
```

An event carries what its listeners need as fields, set in the constructor. The private field `readonly #event = true` has no
use at runtime. It is there for the type checker: TypeScript compares classes by their shape, so two events with the same fields,
`NotePublished { note }` and `NoteArchived { note }`, would be one type, and a listener of one would pass for the other. A private
field makes each class a type of its own. The dispatcher always matches by class, with or without it.

## Defining listeners

A listener is a class with `handle(event)`. `make:listener` writes one:

```sh
pnpm marmeon make:listener IndexNote --event=NotePublished --module=search
```

The generated file imports the event from the module's own `events/` folder. For an event of another module, import it from
that module's entry instead. The listener is built through the container for each dispatch, so its constructor gets what it
asks for:

```ts title="modules/search/listeners/IndexNote.ts"
import type { NotePublished } from '#modules/notes';
import { SearchIndex } from '../SearchIndex.ts';

export class IndexNote {
  readonly #index: SearchIndex;

  constructor(index: SearchIndex) {
    this.#index = index;
  }

  async handle(event: NotePublished): Promise<void> {
    await this.#index.add('notes', event.note.id, event.note.title);
  }
}
```

A listener may also be a function, `(event) => …`, for a few lines that need no services.

## Registering listeners

A module lists its listeners with `listen(Event, Listener)`. `make:listener` adds the entry and its imports. It takes the event from
the module's `events/` folder, or from the import `index.ts` already has for it, so an event of another module or package is
imported in `index.ts` first. When it finds the event in neither place it writes the listener and prints the lines to add:

```ts title="modules/search/index.ts"
import { defineModule, listen } from '@marmeon/core';
import { NotePublished } from '#modules/notes';
import { IndexNote } from './listeners/IndexNote.ts';

export default defineModule({
  name: 'search',
  listeners: [listen(NotePublished, IndexNote)],
});
```

The listener imports the event from `#modules/notes`, so the notes module exports it from its `index.ts`: an event other modules
listen to is part of a module's public API. `listen()` checks the pair when it compiles: a listener whose `handle()` takes another
event is a type error. The app's `defineApplication({ listeners: [...] })` takes app-wide listeners the same way.

A listener of a class also hears the classes that extend it. `listen(JobEvent, …)` hears every event of the queue, and
`listen(ScheduledTaskEvent, …)` every event of the scheduler.

## Dispatching events

`dispatch()` runs the listeners one after the other and awaits each: those of the event's class first, then those of the
classes it extends, each in the order they were registered, the app's own before the modules'. When one throws, the dispatch
stops there and the error reaches the caller, in a request the exception handler. The listeners after it do not run.

For all or nothing, dispatch inside a transaction. The listeners that run during the dispatch join it, and a rollback takes back
what they wrote. The starter kit deletes an account this way: its `AccountDeletion` dispatches `AccountDeleted` inside the
deletion's transaction, once per account, and other modules listen to clear what belongs to the account. The
[transactions](transactions.md#what-joins-a-transaction) page explains what joins a transaction.

The dispatcher belongs to the container that asked for it. In a request, the listeners are built in the request's scope and may
use its services, such as the request's `Translator`.

## Queued listeners

A listener with `static queue` does not run at the dispatch. The dispatch queues it as a job, and a worker runs it later. The
request stays fast, and a failure of the listener no longer fails the request: it fails the job, which retries as often as its
`tries` allow. The starter kit sends its verification
mail this way:

```ts title="modules/auth/listeners/SendEmailVerification.ts"
import type { Registered } from '@marmeon/auth';
import type { EventPayload } from '@marmeon/core';
import { UserRepository } from '../UserRepository.ts';
import { VerificationMailer } from '../verification.ts';

export class SendEmailVerification {
  /** Stable — queued jobs carry this name, never the class name. */
  static readonly listener = 'auth.send-email-verification';
  static readonly queue = { queue: 'mail', tries: 3, backoff: [10, 60] };

  readonly #users: UserRepository;
  readonly #mailer: VerificationMailer;

  constructor(users: UserRepository, mailer: VerificationMailer) {
    this.#users = users;
    this.#mailer = mailer;
  }

  async handle(payload: EventPayload<typeof Registered>): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user || user.email_verified_at !== null) return;
    await this.#mailer.send(user);
  }
}
```

A queued listener gets the event's **payload**, not the event: a worker in another process has no event object. So the event
says what of it is queued, with two more static fields:

```ts title="modules/notes/events/NotePublished.ts"
import type { Row } from '@marmeon/database';
import { rules as r } from '@marmeon/validation';

export class NotePublished {
  static readonly event = 'notes.published';
  static readonly schema = r.object({ noteId: r.integer() });
  readonly #event = true;
  readonly note: Row<'notes'>;

  constructor(note: Row<'notes'>) {
    this.note = note;
  }

  get noteId(): number {
    return this.note.id;
  }
}
```

- **`static event`** is the event's stable name, which the queue stores. Never the class name: renaming the class must not break
  the jobs that wait.
- **`static schema`** reads the event object itself and describes JSON: ids, not records, dates or maps. The payload is checked
  against it when the listener is queued and again before it runs. A record carried in a job would be stale by then. The
  listener reads it again, as it is now. The job that carries the payload is encrypted with `APP_KEY`.
- **`static listener`** on the listener is its stable name, like `'auth.send-email-verification'` (lowercase words, a `.` after
  the module). The queued job carries this name and a worker finds the listener by it within the event. Never the class name:
  renaming the class, or a minifier, must not break the jobs that wait. Two listeners of one event cannot share a name.
- **`static queue`** takes `queue`, `connection`, `delay`, `tries` and `backoff`. `delay` and `backoff` are seconds or a [`Duration`](time.md#spans-of-time); `backoff` is one value or a list with one per retry (`[10, { minutes: 1 }]`). Without `tries` a queued listener runs once.

`listen()` checks all of this when it compiles: an event without `static event` and `static schema`, a schema that is no JSON, a
schema that wants a field the event lacks, and a `handle()` that takes the event instead of `EventPayload<typeof Event>` are type
errors that say so.

A queued listener is queued at its place in the order, like any dispatch of a job. Inside a transaction it exists only once the
transaction commits, and never after a rollback: a registration that rolls back sends no mail. Queued listeners need
`@marmeon/queue`, which every new app has. An app without it fails at the start and names the package to install.

The start also checks the queued listeners: two events with one name, a listener without `static listener` or `handle()`, two
listeners of an event with one name or an unknown setting in `static queue` stop it. A worker finds a queued listener only by
its `static listener` within its event. A job that names a listener this app does not have is not run and no other listener
takes its place: it waits like any job this worker does not know, and lands in the failed jobs after six hours. Renaming the
string while jobs of it wait leaves them unrun, so keep it. A deploy that changes an event's schema holds the waiting jobs
whose payload no longer matches in the same way: another worker may still accept them, and the error names the fields, never
the values.

## The framework's events

The framework's packages dispatch events of their own, classes like any other:

| Package | Events |
| --- | --- |
| `@marmeon/auth` | The 19 events in the table below |
| `@marmeon/queue` | `JobQueued`, `JobProcessing`, `JobProcessed`, `JobReleased`, `JobFailed`, all extending `JobEvent` |
| `@marmeon/scheduler` | `ScheduledTaskStarting`, `ScheduledTaskFinished`, `ScheduledTaskFailed`, `ScheduledTaskSkipped`, all extending `ScheduledTaskEvent` |

The events of `@marmeon/auth`; the ones marked queueable can have a [queued listener](#queued-listeners):

| Event | Fires | Queueable |
| --- | --- | --- |
| `SignedIn` | `attempt()` (after the second factor if the account has one), `signIn()`, a sign-in by the remember-me cookie or with a passkey alone | yes |
| `SignedOut` | `signOut()` | no |
| `SignInFailed` | `attempt()` with an unknown identifier or a wrong password | no |
| `SignInLockedOut` | `attempt()` turns an attempt away, or an account takes no more password sign-ins for the day | no |
| `Registered` | Your registration, after it created the account (the app dispatches it) | yes |
| `PasswordChanged` | `updatePassword()` | no |
| `PasswordReset` | A reset with a link from the mail | no |
| `EmailChanged` | `EmailChange.confirm()`, and `EmailChange.request()` without private registration | no |
| `EverySessionEnded` | `AccountSessions.endEveryone()`, `auth:end-all-sessions` | yes |
| `RememberTokenReused` | A remember-me cookie that a rotation had replaced came back, or came with a validator that was never issued | yes |
| `TwoFactorEnabled` | A second factor was turned on | yes |
| `TwoFactorDisabled` | A second factor was turned off: by the user, the operator's reset or the password reset of an account with an unconfirmed address | yes |
| `RecoveryCodesGenerated` | The account's first second factor was turned on, or new recovery codes were asked for | yes |
| `RecoveryCodeUsed` | A recovery code signed in or stepped up | yes |
| `TwoFactorChallengeFailed` | A wrong second factor at sign-in, at a step-up or when confirming sudo mode with a passkey | yes |
| `PasskeyRegistered` | A passkey was added | yes |
| `PasskeyRemoved` | A passkey was removed, by the user or by the password reset of an account with an unconfirmed address | yes |
| `PasskeyCloneSuspected` | A passkey answered with a sign count that did not move forward | yes |
| `PasskeySignInFailed` | A passwordless sign-in failed against a passkey that exists | yes |

A queued listener gets the event's fields as JSON, with `userId` in place of `user` and `at` as an ISO-8601 string; the authentication, two-factor and passkeys pages list them. The six others (`SignedOut`, `SignInFailed`, `SignInLockedOut`, `PasswordChanged`, `PasswordReset`, `EmailChanged`) cannot be queued: their listeners run in the process that dispatched them.
`SignInFailed` carries what was typed as the identifier, never the password, for an audit log. The
[authentication](authentication.md#events), [two-factor authentication](two-factor-authentication.md#events) and [passkeys](passkeys.md#events)
pages describe each.

The events of the queue and the scheduler cannot be queued, since a queued listener of a job event would queue the next job. Their
listeners run where the event happens: in the worker, in the process that queued the job, or in the scheduler. An error of one is
logged and changes nothing about the job or the task:

```ts title="modules/system/listeners/AlertOnFailedTask.ts"
import { Logger, Redactor } from '@marmeon/core';
import type { ScheduledTaskFailed } from '@marmeon/scheduler';

export class AlertOnFailedTask {
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(logger: Logger, redactor: Redactor) {
    this.#logger = logger.child({ channel: 'alerts' });
    this.#redactor = redactor;
  }

  handle(event: ScheduledTaskFailed): void {
    const message = event.error instanceof Error ? event.error.message : String(event.error);
    this.#logger.error(`The scheduled task ${event.task} failed: ${this.#redactor.text(message)}`, { alert: true, task: event.task });
  }
}
```

In development, the [devtools](devtools.md) record every dispatch with the listeners it reached.

## Testing

Every test app records the events it dispatches in `app.events`. By default their listeners run as usual. `events: 'fake'` holds
back every listener, and a list of classes holds back only theirs:

```ts title="modules/notes/notes.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { IndexNote } from '../search/listeners/IndexNote.ts';
import { NotePublished } from './events/NotePublished.ts';

it('publishes a note', async () => {
  const app = await createTestApp(application, { database: 'refresh', events: [NotePublished] });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).post('/notes', { form: { title: 'Draft', body: '' } }).assertRedirect();
  app.events.assertDispatched(NotePublished, (event) => event.note.user_id === ada.id);
  app.events.assertListening(NotePublished, IndexNote);
});
```

A held-back event is recorded and nothing else: its listeners neither run nor are queued. `assertDispatchedTimes(Event, n)`,
`assertNotDispatched(Event)`, `assertNothingDispatched()` and `dispatched(Event)` check the rest. A match is a part of the event,
`{ note: … }`, or a function. The [fakes](fakes.md#events) page shows every fake of a test app.
