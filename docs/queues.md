# Queues

## Introduction

Some work does not belong in a request: a mail to send, numbers to count again, a file to build. The queue keeps such work as a
**job** and a worker runs it later, in a process of its own, so the request answers at once. A job is a class with `handle()`,
built through the container like a controller, with a stable name and a schema for its payload:

```ts title="modules/auth/jobs/SendWelcomeMailJob.ts"
import { Translators } from '@marmeon/i18n';
import { Mailer } from '@marmeon/mail';
import type { JobContext, JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { AppConfig } from '../../../config/app.ts';
import { WelcomeMail } from '../mail/WelcomeMail.ts';
import { UserRepository } from '../UserRepository.ts';

export class SendWelcomeMailJob {
  static readonly job = 'auth.send-welcome-mail';
  static readonly schema = r.object({ userId: r.integer() });
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];
  static readonly timeout = 30;

  readonly #users: UserRepository;
  readonly #mailer: Mailer;
  readonly #translators: Translators;
  readonly #app: AppConfig;

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, app: AppConfig) {
    this.#users = users;
    this.#mailer = mailer;
    this.#translators = translators;
    this.#app = app;
  }

  async handle(payload: JobPayload<typeof SendWelcomeMailJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user) return job.discard('the account no longer exists');
    const link = new URL('/users/me', this.#app.url).href;
    await job.once(`welcome-mail:${user.id}`, () => this.#mailer.send(new WelcomeMail(user, link, this.#translators.for(user.locale))));
  }
}
```

Any code that injects the `Queue` dispatches it, here a listener of the `Registered` event:

```ts title="modules/auth/listeners/QueueWelcomeMail.ts"
import type { Registered } from '@marmeon/auth';
import { Queue } from '@marmeon/queue';
import { SendWelcomeMailJob } from '../jobs/SendWelcomeMailJob.ts';

export class QueueWelcomeMail {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    this.#queue = queue;
  }

  async handle(event: Registered): Promise<void> {
    await this.#queue.dispatch(SendWelcomeMailJob, { userId: event.user.id });
  }
}
```

The payload holds the account's id, never the account: the job reads the record as it is when it runs. A job runs outside any
request, so it takes its links from `APP_URL` and its language from the account. `marmeon dev` starts a worker next to the
server, so the job runs a moment later. Queued [listeners](events.md#queued-listeners), [mails](mail.md#sending-mails) and
[notifications](notifications.md#sending-notifications) are jobs of the same queue.

## What the queue promises

Read this part before you write a job. It decides how a job must be written.

### At least once

A job runs **at least once**. A worker can die after `handle()` did its work and before it reported the job done. The job then
comes back and runs again. Exactly once would need the other side, such as an SMTP server or a payment API, to take part. Write
`handle()` so that a second run does no harm: read the record again, check whether the work is done, then do it.

The queue gives you two tools for that:

- **`job.id`** stays the same over every attempt and every retry, also after `queue:retry`. Pass it to an API that takes an
  idempotency key.
- **`job.once(key, fn)`** runs `fn` unless it already ran for `key`. After `fn` succeeds, a marker for the key goes into the
  app's cache for a day, or for `{ for: seconds }`. A later attempt, a retry or another job with the same key skips it, and
  `once()` resolves `false`. Put an id into the key: `` `welcome-mail:${user.id}` ``.

`once()` makes repeats rare, not impossible: a worker that dies after `fn` and before the marker runs `fn` again. While one attempt
runs `fn` for a key, another attempt with the same key does not run it alongside. That attempt goes back to the queue for five
seconds and does not count, so it runs again also when the job has only one try. It runs `handle()` from the start each time,
every five seconds for as long as the other attempt holds the key, without using up a try. Put `job.once()` first in `handle()`,
or keep what runs before it safe to repeat.
`once()` needs `@marmeon/cache`, and with workers on several machines a cache they share: `database` or `redis`.

### Inside a transaction

A dispatch inside `connections.transaction()` belongs to the transaction. You write nothing extra:

| Connection | Inside a transaction |
| --- | --- |
| `database`, on the same database connection | The job is a row written in the transaction: there with the commit, gone with a rollback. |
| `redis`, `sync`, or `database` on another connection | Held until the outermost commit, dropped on a rollback. A `sync` job then runs after the commit, outside the transaction, and its error is thrown by the `transaction()` call. |

So a registration that rolls back sends no welcome mail, and a worker never reads an account that is not committed yet. A worker
runs every job **outside** any transaction, and so do the `sync` connection and the test fake. For a transaction you start
yourself with Kysely, `queue.using(trx).dispatch(…)` writes through it. The
[transactions](transactions.md#what-joins-a-transaction) page explains the transaction context.

### Secrets in payloads

The `jobs` and `failed_jobs` tables, and Redis, are a database: a reset link or a signed URL in a payload is a secret at rest.
Keep ids in a payload and read the rest in the job. When a payload must carry a secret, or personal data such as an address,
encrypt it:

```ts title="modules/auth/jobs/SendPasswordResetLinkJob.ts"
import { rules as r } from '@marmeon/validation';

export class SendPasswordResetLinkJob {
  static readonly job = 'auth.send-password-reset-link';
  static readonly schema = r.object({ email: r.string(), locale: r.string() });
  static readonly encrypted = true;

  async handle(): Promise<void> {
    // creates the token and queues the mail
  }
}
```

`static encrypted = true` encrypts the payload with the app's `APP_KEY`, and `APP_PREVIOUS_KEYS` still decrypt it. It needs
`@marmeon/encryption`, which every new app has; without it the start fails. A plain payload for an encrypted job is never run:
the job fails at once. The framework's own jobs are always encrypted: queued mails with their links, queued listeners and queued
notifications. The error text in `failed_jobs` and the worker's log lines are [redacted](logging.md#keeping-secrets-out-of-the-log)
like any log entry.

## Writing jobs

### Generating a job

`make:job` writes a job class with a stable name taken from the class name:

```sh
pnpm marmeon make:job SendInvoiceReminderJob --module=billing
```

The job lands in `modules/billing/jobs/SendInvoiceReminderJob.ts` with the name `billing.send-invoice-reminder`. A worker runs
only the jobs its app knows, so `make:job` adds the class to its module (`--no-register` prints the lines instead). The module ends up like this:

```ts title="modules/billing/index.ts"
import { defineModule } from '@marmeon/core';
import { SendInvoiceReminderJob } from './jobs/SendInvoiceReminderJob.ts';

export default defineModule({
  name: 'billing',
  jobs: [SendInvoiceReminderJob],
});
```

A dispatch of a job no module lists throws and says where to add it; `marmeon dev` and `marmeon build` warn about a job class
no module lists (see the [development server](console.md#the-development-server)). Two jobs with one name, or a name under `marmeon.`, which
belongs to the framework, stop the app at the start.

### The job class

| Static | Default | What it does |
| --- | --- | --- |
| `job` | required | The stable name the queue stores. Never derived from the class name, so renaming the class breaks no waiting job. |
| `schema` | required | The payload's schema. Checked at the dispatch and again before `handle()` runs. |
| `tries` | `1` | Attempts in all. `1` means no retry. |
| `backoff` | `0` | Seconds before the next attempt: one number, or one per retry, such as `[10, 60, 300]`. The last repeats. |
| `timeout` | `60` | Seconds an attempt may take before `job.signal` aborts. |
| `encrypted` | `false` | Encrypts the payload in the queue. |
| `middleware` | none | Job middleware that runs around each attempt. |

`handle(payload, job)` gets the output of the schema, typed with `JobPayload<typeof YourJob>`, and the `JobContext`: the job's
`id`, `name`, `attempt` from 1, `tries`, `queue`, `connection` and `signal`. A new instance is built for every attempt, in a
container scope of its own, so scoped services are fresh each time.

The payload is stored as JSON, and the schema must describe JSON. A schema with a `Date`, a `Map` or a record class is a compile
error at the dispatch, with this message:

```text
A job payload is stored as JSON — its schema must describe JSON (strings, numbers, booleans, null, arrays, plain objects); pass IDs, not records, Dates or Maps
```

A `handle()` whose payload type differs from the schema's output is a compile error too.

`tries` and `backoff` are stored with each job at its dispatch. A job that waits through a deploy keeps the policy it was
dispatched with, even when a worker of the new version does not know the class yet.

## Dispatching jobs

`dispatch()` checks the payload, queues the job and resolves with its id:

```ts title="modules/billing/controllers/SendRemindersController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Queue } from '@marmeon/queue';
import { SendInvoiceReminderJob } from '../jobs/SendInvoiceReminderJob.ts';

export class SendRemindersController extends Controller {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    super();
    this.#queue = queue;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    await this.#queue.dispatch(SendInvoiceReminderJob, { userId: ctx.user.id }, { delay: { minutes: 5 }, queue: 'mail' });
    return this.back();
  }
}
```

| Option | What it does |
| --- | --- |
| `delay` | A [`Duration`](time.md#spans-of-time), seconds or an object such as `{ minutes: 5 }`, before the job may run. |
| `queue` | The queue's name. Without it the connection's default queue, `default` unless configured. |
| `connection` | The queue connection. Without it `QUEUE_DRIVER`. |

`bulk([[Job, payload], [Job, payload]])` queues several jobs and resolves with their ids. Every payload is checked before the
first is queued, so one bad payload queues none. `size(queue?)` counts the jobs that wait or run on a queue.

## Running workers

`marmeon queue:work` takes jobs from the queue and runs them, one at a time, until it is stopped:

```sh
pnpm marmeon queue:work
```

Its first line says what it serves and which environment it assumed, such as `Processing jobs of the database connection: every
queue (oldest first) — in production (APP_ENV=production)`. On a server, set `NODE_ENV` in the worker's environment, not only in `.env`:
a worker that is `development` only because of the app's `.env` logs a warning and runs anyway. The
[configuration](configuration.md#where-node_env-comes-from) page explains where `NODE_ENV` comes from.

| Option | Default | What it does |
| --- | --- | --- |
| `--connection` | `QUEUE_DRIVER` | The connection to work on. |
| `--queue` | every queue | The queues to take, in strict order. |
| `--sleep` | `1` | Seconds to wait when no job is ready. |
| `--max-jobs` | none | Stop after this many attempts. |
| `--max-time` | none | Stop after this many seconds, after the running job. |
| `--stop-when-empty` | off | Stop as soon as no job is ready. |
| `--stop-timeout` | `10` | Seconds a running job may still take after a stop, or after its timeout. |

### Which queues a worker takes

Without `--queue`, a worker takes **every queue, fairly**. No queue waits for another to run empty, so a long `default` queue never
holds the mails back. The `database` driver takes the oldest due job of all queues in one statement. The `redis` driver takes the
queues in turn.

`--queue` narrows a worker down, in **strict order**:

```sh
pnpm marmeon queue:work --queue=mail,default
pnpm marmeon queue:work --queue=mail,*
```

The first worker takes a job of `mail` before any job of `default`, so `default` waits while `mail` has jobs. In a list, `*` stands
for every queue the list does not name, taken fairly at its place: the second worker takes `mail` first, then everything else.
`--queue=*` alone is the same as no `--queue`. For a priority that starves no queue, run two workers: one without `--queue` and
one with `--queue=mail`.

A worker with a list and no `*` looks at the other queues once a minute while it is idle. Jobs that are ready on a queue it does not
take, at two looks in a row, are named once in a warning, so they do not wait without a word. Code that runs a `Worker` of
`@marmeon/queue` itself sets the interval with `watchOtherQueues` in `worker.run({ … })`, in seconds, or turns the look off with
`false`.

### Timeouts and `retryAfterSeconds`

Node cannot stop a running promise from outside. A job's `timeout` is therefore enforced in two steps:

1. When the timeout passes, `job.signal` aborts. Pass it on, as in `fetch(url, { signal: job.signal })`, or check
   `job.signal.aborted` between steps.
2. A job that has not stopped `--stop-timeout` seconds later ends the **worker**, with exit code 70. A supervisor starts a new
   worker, and the job comes back after `retryAfterSeconds`.

`retryAfterSeconds`, 90 seconds by default, is how long a claimed job stays with its worker before another worker may take it again. It
must be longer than every job's `timeout` plus `--stop-timeout`, or a second worker would run a job the first one still runs.
`queue:work` checks every job of the app at its start and refuses to start with a message that names the jobs and what to change.

### Stopping a worker

On `SIGTERM` or `SIGINT` a worker takes no new job. The running job gets `--stop-timeout` seconds to finish, then it goes back to
the queue for another worker, and the worker ends with exit code 0. A second signal does not cut this short. A shutdown that hangs
anyway ends the process with exit code 1, `--stop-timeout` plus ten seconds after the signal. Give the supervisor a longer grace
period than `--stop-timeout`, and raise both together for long jobs.

`marmeon make:docker` writes the worker as a container and as a systemd unit that restart it whenever it ends. The
[deployment](deployment.md#roles-and-processes) page covers the roles. In development `marmeon dev` runs the worker for you, on
every queue, and restarts it when the code changes. It runs none with `QUEUE_DRIVER=sync`, where a job runs at its dispatch.

## Connections and drivers

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `QUEUE_DRIVER` | `database` | The default connection, named after its driver: `database`, `redis`, `sync` or the name of a driver a package brings. |
| `QUEUE_DATABASE_CONNECTION` | `default` | The database connection of the `jobs` table. |
| `QUEUE_DATABASE_QUEUE` | `default` | The default queue of the `database` connection. |
| `QUEUE_DATABASE_RETRY_AFTER_SECONDS` | `90` | Seconds before a claimed job of the `database` connection may be claimed again. |
| `QUEUE_REDIS_CONNECTION` | `default` | The Redis connection of the `redis` queue. |
| `QUEUE_REDIS_QUEUE` | `default` | The default queue of the `redis` connection. |
| `QUEUE_REDIS_RETRY_AFTER_SECONDS` | `90` | Seconds before a claimed job of the `redis` connection may be claimed again. |
| `QUEUE_FAILED_DRIVER` | `database` | Where failed jobs go: `database`, the `failed_jobs` table, `null`, which only logs them, or the name of a store a package brings. |
| `QUEUE_FAILED_CONNECTION` | `QUEUE_DATABASE_CONNECTION` | The database connection of `failed_jobs`. |

A connection the app does not configure, a driver name nobody brought, an unknown database or Redis connection or a missing driver
package stops the app at its start, with what to do.

### Drivers

| Driver | Where jobs wait | Use it for |
| --- | --- | --- |
| `database` | The `jobs` table. | The default. No extra service, and a dispatch is part of the app's transaction. |
| `redis` | Lists and sorted sets in Redis. | Many jobs, in an app that runs Redis anyway. |
| `sync` | Nowhere: `handle()` runs at the dispatch, in a scope of its own, and its error is the dispatch's. | Scripts, and tests that want the work done at once. |

Exactly one worker claims a job, also with many workers on Postgres or Redis. The `redis` driver needs `@marmeon/redis`, which
brings the Redis client. The [Redis](redis.md#which-connection-a-driver-uses) page covers its connection.

The `database` driver needs its tables, `jobs` and `failed_jobs`. A new app has them. Otherwise write the migration and run it:

```sh
pnpm marmeon make:queue-table
pnpm marmeon migrate
```

`make:queue-table` writes into the `system` module, or the module that `--module` names. It is `marmeon publish @marmeon/queue`:
when your app has the migration already, it writes nothing and ends with exit code 0. The migration runs on
`QUEUE_DATABASE_CONNECTION`, and the [migrations](migrations.md#the-frameworks-tables) page says what to do when `failed_jobs` goes
elsewhere.

### Queue drivers and failed-job stores

A package or an app can bring its own queue driver and failed-job store, such as one for SQS. Its provider lists them in
`static queueDrivers` and `static failedJobDrivers`, and `QUEUE_DRIVER` or `QUEUE_FAILED_DRIVER` selects them by name. The
[drivers](drivers.md#queue-drivers-and-failed-job-stores) page has the contract a driver keeps and what the framework does
without its optional members.

## Retries and failures

A job that throws is attempted again after its `backoff`, until it has used its `tries`. Then it **fails**: it goes to the failed
jobs, with its id, connection, queue, name, payload, the redacted error and the time. A job that fails for good is also handed to
the [error reporters](errors.md#reporting) of the app (`source` `job`), with its name, id, queue, connection and attempt, never
its payload. An attempt that will run again is only logged. A job that a reporter queued is logged but not reported when it fails,
so a reporter that queues an alert cannot start a loop.

A job can also end an attempt on its own:

| Call | What happens |
| --- | --- |
| `job.discard(reason)` | The job ends without a retry and without a failed entry. For a record that is gone. |
| `job.release(delay)` | The job goes back to the queue, to run again after `delay`, a [`Duration`](time.md#spans-of-time). The attempt counts, so a release on the last attempt fails the job. |
| `job.fail(reason)` | The job fails now, without further attempts. |

Some jobs can never succeed, and they fail at once, after one attempt:

- a payload that cannot be decrypted, or a plain payload for an encrypted job,
- a record that is no job record, has no version, or has a chain with a link the worker cannot read.

A job the worker cannot read, but a worker of another release perhaps can, does not fail: it waits. That is a record of a newer
version, a job whose name the worker does not know, and a payload the job's schema rejects, as after a deploy that widened it.
See [Deploying while jobs wait](#deploying-while-jobs-wait). A job claimed more often than its `tries`, because its worker died
each time, fails instead of coming back forever.

### Failed jobs

| Command | What it does |
| --- | --- |
| `queue:failed` | Lists the failed jobs, newest first, with their ids and errors. |
| `queue:retry <id…\|all>` | Puts failed jobs back on their queue, with the same id and their attempts from zero. |
| `queue:forget <id>` | Deletes one failed job. |
| `queue:flush` | Deletes every failed job. |
| `queue:prune-failed [--hours=168]` | Deletes failed jobs older than the given hours. |
| `queue:size [queue…] [--connection=…]` | Counts the jobs per queue. |

Schedule `queue:prune-failed`, as the [task scheduling](scheduling.md#housekeeping-commands) page shows.

### Deploying while jobs wait

Every job record carries a version, `v`, in the payload column, as every [stored format](releases.md#stored-and-wire-formats) carries one. A worker runs a record only when it understands all of it, and
it puts back what it does not:

| The record | What a worker does |
| --- | --- |
| Version newer than the worker reads | Never runs it, never reads more than its id, name and time. Puts it back untouched. |
| Names a job the worker does not know | Puts it back. A worker of the release that has the job takes it. |
| Payload the job's schema rejects | Puts it back. A newer release may have widened the schema, for example with a new enum member. |
| No version, or a version that is not a positive whole number | Fails it at once, with the reason. Its payload stays in the failed jobs for reading, and it never runs. |
| A chain with a link the worker cannot read | Fails the whole record at once. No part of the chain runs. |

A record that waits goes back with its attempt given back, so waiting does not use up its `tries`, and with a pause of a quarter
of the time it has been claimable, at least 15 seconds and at most five minutes. That time starts when the job could first run:
its dispatch, the end of its `delay`, its turn in a chain, or the moment `queue:retry` queued it again. The worker logs a warning
once per job and process, and sends `JobReleased` with `reason: 'unknown'`. Six hours on, a record nobody took fails, with the reason
and its payload. A record without a readable id or time, or with a time more than five minutes ahead of the worker's clock, cannot
be held and fails at once. Watch `queue:failed` after a deploy.

`queue:retry` refuses every failed job whose record this release cannot read at all, as one without a version, with a chain that has
a broken link, or that is no job record: queued again, it would fail the same way. Retry a job that failed because it waited too
long once a worker that can read it is running. The devtools show no payload for such a record, and no retry command.

The version only grows with a change that an older worker would misread, such as a field that restricts the job. Fields a worker
does not know are ignored, and a new one never takes anything away from a job. An `until` of a unique job that a worker does not
know is read as `done`: the lock is held longer, never shorter.

## Unique jobs

A unique job is queued once while one with the same key waits. A second dispatch does nothing and resolves `undefined` instead of an
id, so its type is `string | undefined`:

```ts title="modules/user-profile/listeners/RefreshMemberStats.ts"
import type { Registered } from '@marmeon/auth';
import { Queue } from '@marmeon/queue';
import { RebuildMemberStatsJob } from '../jobs/RebuildMemberStatsJob.ts';

export class RefreshMemberStats {
  readonly #queue: Queue;

  constructor(queue: Queue) {
    this.#queue = queue;
  }

  async handle(_event: Registered): Promise<void> {
    await this.#queue.dispatch(RebuildMemberStatsJob, {}, { unique: 'members', uniqueUntil: 'processing', uniqueFor: 600 });
  }
}
```

Ten registrations in a burst queue one rebuild. The key belongs to the job class: `stats:1` of one job does not block another job.
A lock in the app's cache holds the key. It is taken at the dispatch, outside any transaction, so every process sees it at once, and
it is freed again when the transaction around the dispatch rolls back. Otherwise it is freed:

- with `uniqueUntil: 'done'`, the default, when the job leaves the queue: processed, failed or discarded,
- with `uniqueUntil: 'processing'`, when a worker starts the job. A dispatch during the run queues the next one,
- at the latest after `uniqueFor` seconds, 3600 by default, so a lost job never blocks new ones.

A unique key keeps a second *dispatch* out, not a second *run* of the same job. Workers on several machines need a cache they
share: `CACHE_DRIVER=database` or `redis`. `bulk()` and `chain()` take no unique key, which is a type error.

## Chains

`chain()` queues jobs that run one after the other:

```ts
await this.#queue.chain([[ImportProfileJob, { id }], [RebuildStatsJob, { userId }]]);
```

The first job is queued now. Each next one is queued only once the one before succeeded, in the same step that marks it done. A
job that fails for good or discards itself ends the chain. Every payload is checked when the chain is dispatched, and `chain()`
resolves with the ids of all of them.

## Job middleware

Job middleware runs around each attempt. `withoutOverlapping()` lets no two attempts with the same key run at once, on any worker:

```ts title="modules/user-profile/jobs/RebuildMemberStatsJob.ts"
import { withoutOverlapping, type JobPayload } from '@marmeon/queue';
import { rules as r } from '@marmeon/validation';
import { MemberStats } from '../MemberStats.ts';

export class RebuildMemberStatsJob {
  static readonly job = 'user-profile.rebuild-member-stats';
  static readonly schema = r.object({});
  static readonly tries = 5;
  static readonly timeout = 30;
  static readonly middleware = [withoutOverlapping('member-stats', { releaseAfter: 5 })];

  readonly #stats: MemberStats;

  constructor(stats: MemberStats) {
    this.#stats = stats;
  }

  async handle(_payload: JobPayload<typeof RebuildMemberStatsJob>): Promise<void> {
    await this.#stats.rebuild();
  }
}
```

An attempt that finds the key taken does not run. It goes back to the queue for `releaseAfter` seconds, 5 by default. That counts
as an attempt, so a job with this middleware needs `tries`. The key can depend on the payload:
`` withoutOverlapping<typeof RebuildStatsJob>((payload) => `stats:${payload.userId}`) ``. The lock expires after `expiresAfter`
seconds, by default the connection's `retryAfterSeconds`. `shared: true` shares the key with other jobs.

A middleware of your own implements `handle(context, next)`. `context` holds the `payload`, the `job` context, the job's `timeout`,
the connection's `retryAfterSeconds` and `cache()`. Call `next()` to run the job, or end the attempt with `context.job.release()` or
`context.job.discard()`.

## Job events

Every step of a job is an event of the app's event dispatcher:

| Event | When | Fields besides `connection`, `queue`, `job` and `jobId` |
| --- | --- | --- |
| `JobQueued` | The job was queued, after the commit when it was dispatched in a transaction. | `delaySeconds` |
| `JobProcessing` | An attempt starts. | `attempt` |
| `JobProcessed` | An attempt ran to its end. | `attempt`, `ms`, `discarded` |
| `JobReleased` | An attempt ended and the job went back to the queue, to run again after `delaySeconds`. | `attempt`, `delaySeconds`, `reason`, `ms` |
| `JobFailed` | The job failed for good and is in the failed jobs now. The rest of its chain is dropped. | `attempt`, `error` |

`reason` says why a job went back:

| `reason` | Why |
| --- | --- |
| `error` | The attempt threw, and the job has tries left. |
| `job` | The job or a middleware asked for it, with `job.release()` or `withoutOverlapping()`. |
| `unknown` | The worker cannot read the job, as during a rolling deploy: a newer record version, no class for its name, or a payload its schema rejects. The attempt is given back. |
| `stopping` | The worker stops, and the running job goes back for another worker. |
| `busy` | `job.once()` found its key running in another attempt. The attempt is given back, so it does not use up a try. |

So a flaky job that succeeds on its second try sends `JobReleased` with `reason: 'error'` and then `JobProcessed`, never
`JobFailed`. Count retries on `JobReleased`, and alert on `JobFailed`.

All of them extend `JobEvent`, so `listen(JobEvent, …)` hears every one. A listener runs where the event happens, in the worker or
in the process that dispatched. Its error is logged and changes nothing about the job. Job events cannot have queued listeners,
because such a listener would queue a job whose events queue the next. This listener raises an alert for every failed job:

```ts title="modules/system/listeners/AlertOnFailedJob.ts"
import { Logger, Redactor } from '@marmeon/core';
import type { JobFailed } from '@marmeon/queue';

export class AlertOnFailedJob {
  readonly #logger: Logger;
  readonly #redactor: Redactor;

  constructor(logger: Logger, redactor: Redactor) {
    this.#logger = logger.child({ channel: 'alerts' });
    this.#redactor = redactor;
  }

  handle(event: JobFailed): void {
    this.#logger.error(`The job ${event.job} failed: ${this.#redactor.text(event.error.message)}`, { alert: true, jobId: event.jobId });
  }
}
```

The module registers it with `listeners: [listen(JobFailed, AlertOnFailedJob)]`. The error is the one the job threw, so mask it with
the app's `Redactor` before you log it: it may quote a secret or a cookie header. A job dispatched in a request remembers that request's id, and the
[observability](observability.md#following-a-request) page shows how traces follow a request into its jobs. The queue's driver is
one of the checks of `/up/ready`, which the [health](health.md#the-checks-of-the-packages) page covers.

## Testing

`createTestApp()` puts a fake queue in place. A dispatch is checked like a real one, against the schema and the transaction, and
recorded instead of queued. `app.queue.work()` then runs what was queued, in the test's process:

```ts title="modules/auth/welcome-mail.test.ts"
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { SendWelcomeMailJob } from './jobs/SendWelcomeMailJob.ts';
import { WelcomeMail } from './mail/WelcomeMail.ts';

it('queues the welcome mail and sends it when the job runs', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.post('/register', {
    form: { name: 'Katherine Johnson', email: 'kj@example.com', password: 'orbital mechanics', password_confirmation: 'orbital mechanics' },
  });

  app.queue.assertDispatchedTimes(SendWelcomeMailJob, 1);
  app.mail.assertNotSent(WelcomeMail);

  expect(await app.queue.work()).toMatchObject({ failed: 0 });
  app.mail.assertSent(WelcomeMail);
});
```

`createTestApp(application, { queue: 'real' })` keeps the configured queue instead. The [fakes](fakes.md#queue) page lists every
assertion of the fake.
