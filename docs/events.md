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
imported in `index.ts` first. When it finds the event in neither place it writes nothing and exits with 1: create the event with
`make:event`, or import it in `index.ts`, and run the command again. The result:

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
what they wrote. The starter kit deletes an account this way: its `AccountDeletion` dispatches `AccountDeleting` and then
`AccountDeleted` inside the deletion's transaction, once per account: a module can refuse at the first and clears what belongs to
the account at the second. The
[transactions](transactions.md#what-joins-a-transaction) page explains what joins a transaction.

The dispatcher belongs to the container that asked for it. In a request, the listeners are built in the request's scope and may
use its services, such as the request's `Translator`.

### One event per batch

A dispatch costs a listener built through the container and whatever the listener does, for every listener of the event. An
import of a thousand rows that dispatches one event per row pays that a thousand times: a thousand listener objects and,
for a listener that writes, a thousand more statements. Dispatch one event that carries the rows instead, and let the listener
handle the batch in one go:

```ts title="modules/members/events/MembersImported.ts"
import type { Row } from '@marmeon/database';

export class MembersImported {
  readonly #event = true;
  readonly members: readonly Row<'members'>[];

  constructor(members: readonly Row<'members'>[]) {
    this.members = members;
  }
}
```

```ts title="modules/members/MemberImport.ts"
import { Connections } from '@marmeon/database';
import { EventDispatcher } from '@marmeon/core';
import { MemberRepository } from './MemberRepository.ts';
import { MembersImported } from './events/MembersImported.ts';

export class MemberImport {
  readonly #connections: Connections;
  readonly #members: MemberRepository;
  readonly #events: EventDispatcher;

  constructor(connections: Connections, members: MemberRepository, events: EventDispatcher) {
    this.#connections = connections;
    this.#members = members;
    this.#events = events;
  }

  run(rows: readonly { name: string; email: string }[]) {
    return this.#connections.transaction(async () => {
      const members = [];
      for (const row of rows) members.push(await this.#members.insert(row));
      await this.#events.dispatch(new MembersImported(members)); // once, whatever the number of rows
      return members;
    });
  }
}
```

The dispatch cost grows with the number of dispatches, not with the number of rows, so a batch of any size costs one
dispatch. What the listener itself writes still grows with the size of the batch, unless it writes the rows in one statement,
with the query builder's `insertInto(…).values([…])`. Keep a batch
bounded all the same: an event that holds a million rows holds them in memory until every listener is done. Cut a large import
into chunks and dispatch once per chunk. An event that a queued listener will take must stay small: its fields are written
into the job, see [queued listeners](#queued-listeners).

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
- **`static queue`** takes `queue`, `connection`, `delay`, `tries` and `backoff`. `delay` and `backoff` are seconds or a [`Duration`](time.md#spans-of-time); `backoff` is one value or a list with one per retry (`[10, { minutes: 1 }]`). Without `tries` a queued listener runs once. A queued listener has 60 seconds; for longer work, dispatch a job of its own with a `timeout`.

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

## An audit trail

An audit trail answers who changed what, and it has one rule: an entry exists exactly when its change does. The way to hold that
rule is a plain listener that writes the entry **in the transaction of the code that changed the data**. Outside a
transaction the change is already committed when the listener runs; dispatch inside one.

```ts title="modules/notes/NoteSharing.ts"
share(noteId: number, email: string, actorId: number | null) {
  return this.#connections.transaction(async () => {
    const share = await this.#shares.insert({ note_id: noteId, email });
    await this.#events.dispatch(new NoteShared(share, actorId)); // the audit listener writes its row in this transaction
    return share;
  });
}
```

`NoteShared` is an event like any other. Its fields are the new `share` row and the `actorId` of whoever did it, or `null`.
The code that dispatches knows the actor: the controller passes `(await auth.id()) ?? null` to `share()`, a command passes `null`, as `SignedIn` carries its
`ip` and `userAgent`; the listener does not inject `Auth`, which exists only inside a request. The listeners of `dispatch()` run inside that transaction and their repositories join it (see [what joins a
transaction](transactions.md#what-joins-a-transaction)). Both rows are committed together, and a rollback takes both back.
If the write of the entry fails, the dispatch throws and the change rolls back with it, so a change never goes unrecorded.

```ts title="modules/audit/listeners/RecordNoteShared.ts"
import type { NoteShared } from '#modules/notes';
import { ClientInfo } from '@marmeon/http';
import { AuditEntryRepository } from '../AuditEntryRepository.ts';

export class RecordNoteShared {
  readonly #entries: AuditEntryRepository;
  readonly #client: ClientInfo;

  constructor(entries: AuditEntryRepository, client: ClientInfo) {
    this.#entries = entries;
    this.#client = client;
  }

  async handle(event: NoteShared): Promise<void> {
    await this.#entries.insert({
      action: 'note.shared',
      subject_type: 'notes',
      subject_id: String(event.share.note_id),
      actor_id: event.actorId === null ? null : String(event.actorId),
      ip: this.#client.ip ?? null,
      user_agent: this.#client.userAgent?.slice(0, 512) ?? null, // the client chose it: cut it to the column
      meta: { email: event.share.email },
    });
  }
}
```

The listener is registered with `listen(NoteShared, RecordNoteShared)` like any other. Three details of the table matter:

- **No foreign key on the subject or the actor.** An entry about a deleted note or a deleted account must outlive both. Store
  the subject as a table name and a key, and the actor as a plain key column, in a table of its own:

  ```ts title="modules/audit/migrations/2026_01_01_000000_create_audit_entries_table.ts"
  schema.create('audit_entries', (table) => {
    table.id();
    table.string('action', 80);
    table.string('subject_type', 80);
    table.string('subject_id', 64);
    table.string('actor_id', 64).nullable();
    table.string('ip', 45).nullable();
    table.string('user_agent', 512).nullable();
    table.json('meta').nullable();
    table.timestamps();
    table.index(['subject_type', 'subject_id']);
  });
  ```

- **The actor and the client.** The event carries the actor. `ClientInfo` of `@marmeon/http` is bound in every scope and holds
  the request's `ip` and `userAgent`. Outside a request, in a command or a job, there is no user and both are undefined:
  store them as `null`, and let the entry's `action` say that a command did it. A test request has none
  either, unless it comes from `app.withIp(address)`, see [the client's address](requests.md#the-clients-address).
- **Client input never fails the change.** A value the client chose, such as the `User-Agent`, goes into the entry cut to its
  column (or into a `text` column). An insert that fails on a too long value rolls back the audited change with it, and
  any client could then block it.
- **Never a secret in `meta`.** The log redacts what it writes, a table does not. `meta` holds what the entry needs to read
  later (an email, a role, the old and the new value of a field), never a password, a token or a one-time code. When `meta` is
  built from input you do not control, pass it through the app's `Redactor` of `@marmeon/core`, `redactor.value(meta)`, which returns `unknown` (cast it to what the
  column takes) and masks every key
  the log masks (see [keeping secrets out of the log](logging.md#keeping-secrets-out-of-the-log)).

### Why not `afterCommit()`

`afterCommit()` runs after the transaction has committed, outside of it. An entry written there is no longer part of the change:
when the process ends between the commit and the write, or the write fails, the change stands and nothing records it, and the
caller only learns of it through the error of a transaction that did commit (see [after the
commit](transactions.md#after-the-commit)). That is the right place for a mail, which must not leave for data that was rolled
back, and the wrong one for an entry that must not be missing for data that was kept. For the same reason a
[queued listener](#queued-listeners) is no audit trail: a worker writes its entry later, after the commit and possibly never.

### A refused attempt

A change that fails rolls its transaction back, and the entry with it. A refusal before any transaction, a failed check or a
403, needs none of what follows: a plain insert writes the entry. To keep the entry of an attempt that fails inside a
transaction, the failed sign-in or the refused action, choose one of these:

- **Return the error with the entry.** Write the entry in the transaction and return `commitAnyway(err(…))`, which commits
  the transaction although the callback returns an `err` ([returning an err](transactions.md#returning-an-err)). Whatever else
  the transaction wrote commits too, so write nothing else before the refusal.
- **Catch, write after, throw again.** Let the transaction fail, catch the error, or take the `err` it returns, outside it, write the entry in a transaction of
  its own and throw the error again.
- **`outsideTransaction()`** keeps its write when the transaction rolls back ([outside the
  transaction](transactions.md#outside-the-transaction)). It works on Postgres only: on SQLite it fails at once with a
  `TransactionError`. A test's fixed connection throws it too, also on Postgres, so the tests that reach it use
  `database: 'isolated'` on Postgres.

### The diagnostics channel is no audit trail

The `event` channel of [observability](observability.md#events) reports every dispatch, whether or not the transaction around
it commits, and it keeps nothing. Use it to watch, never to prove.

### Every writing route has an entry

A route that changes data without an entry is a hole nobody sees. A test can name them: it lists the app's routes with
`route:list --json` and compares every route that writes with the actions the app audits.

```ts title="modules/audit/audit-coverage.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

/** The writing routes and the entry each one writes, or why it writes none. */
const AUDITED: Record<string, string> = {
  'notes.share': 'note.shared',
  'notes.destroy': 'note.deleted',
};
const NOT_AUDITED: Record<string, string> = {
  'session.store': 'a sign-in is recorded by the SignedIn listener',
};

it('audits every route that writes', async () => {
  const app = await createTestApp(application);
  const run = await app.command('route:list', { options: { json: true } });
  expect(run.code).toBe(0);
  const { routes } = JSON.parse(run.lines.join('\n')) as { routes: { methods: string[]; path: string; name: string | null; access: unknown }[] };

  const writing = routes
    .filter((route) => route.access !== 'framework' && route.methods.some((method) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)))
    .map((route) => route.name ?? `${route.methods.join('|')} ${route.path}`);

  const unknown = writing.filter((name) => !(name in AUDITED) && !(name in NOT_AUDITED));
  expect(unknown, 'a writing route with no audit entry and no reason').toEqual([]);
});
```

The filter reads the methods, so a `GET` route that writes, such as a signed link that confirms something, is not found by it:
name those routes in the test by hand. Each route in `AUDITED` also gets a test of its own that calls it and asserts that the entry is there, and one that makes the
change fail and asserts that it is not.

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
