# @marmeon/queue

Work that should not happen in the request (E83–E86, E98): **jobs** are injectable classes with `handle()` — like
controllers —, a stable name and a payload schema; drivers `sync`, `database` and `redis` behind one contract; a worker
with a scope per job, timeouts, retries, failed jobs and a clean shutdown; unique jobs, chains, job middleware, job events —
and a fake for tests. Queued listeners (`static queue`) and queued mails (`mailer.queue`,
[queued mails](../mail/README.md#queued-mails-e105)) are jobs of this package too.

`marmeon discover` registers its `QueueServiceProvider` like any installed package. The drivers' packages are optional peers,
checked at the start — not at the first dispatch: `database` (the default) needs [@marmeon/database](../database/README.md),
`redis` needs [@marmeon/redis](../redis/README.md), an encrypted job (and every queued listener)
[@marmeon/encryption](../encryption/README.md) with an `APP_KEY`; unique jobs, `job.once()` and `withoutOverlapping()` keep
their locks in the app's cache ([@marmeon/cache](../cache/README.md#locks-and-markers-of-the-queue)).

**Dependencies** ([the driver rule, E198](../../CONTRIBUTING.md#dependencies-of-drivers)): no third-party driver here — `QUEUE_CONNECTION=redis` needs only `@marmeon/redis` (it brings
the client: `pnpm add @marmeon/redis`).

```ts
// modules/auth/jobs/SendWelcomeMailJob.ts — and `jobs: [SendWelcomeMailJob]` in defineModule({ … })
export class SendWelcomeMailJob {
  static readonly job = 'auth.send-welcome-mail';                 // stable — what the queue stores, never the class name
  static readonly schema = v.object({ userId: v.number() });       // JSON, checked at the dispatch and before handle()
  static readonly tries = 5;
  static readonly backoff = [10, 60, 300];                         // seconds before each retry, the last repeats
  static readonly timeout = 30;                                    // then job.signal aborts

  constructor(users: UserRepository, mailer: Mailer, translators: Translators, app: AppConfig) { … }   // injected per attempt

  async handle(payload: JobPayload<typeof SendWelcomeMailJob>, job: JobContext): Promise<void> {
    const user = await this.#users.find(payload.userId);
    if (!user) return job.discard('the account no longer exists');  // no retry, no failed entry
    await job.once(`welcome-mail:${user.id}`, () =>                // once per account, also across retries (E85)
      this.#mailer.send(new WelcomeMail(user, new URL('/users/me', this.#app.url).href, this.#translators.for(user.locale))),
    );
  }
}

// anywhere — constructor(queue: Queue)
await this.#queue.dispatch(SendWelcomeMailJob, { userId: user.id }, { delay: { minutes: 1 }, queue: 'mail' });
await this.#queue.dispatch(SendWelcomeMailJob, { userId: 'x' });    // ✗ Type 'string' is not assignable to type 'number'.
```

```text
marmeon queue:work [--connection=database|redis] [--queue=mail,default|*] [--max-jobs=N] [--max-time=S] [--sleep=1] [--stop-timeout=10] [--stop-when-empty]
marmeon queue:failed | queue:retry <id…|all> | queue:forget <id> | queue:flush | queue:prune-failed [--hours=168]
marmeon queue:size [queue…] [--connection=database|redis]
marmeon make:queue-table [--module=system]
```

`marmeon make:job <Name> --module=<module>` ([marmeon](../cli/README.md)) writes a job class with a stable name and
prints the line for its module. `marmeon dev` starts a worker next to the server, on every queue (`--queue=*`,
`--stop-timeout=5`), and restarts it when code changes (E101) — not with `QUEUE_CONNECTION=sync`, where jobs run at the dispatch.

`queue:work` runs in the one Node process `marmeon` started (E159) — signals and its exit code reach the supervisor directly. Its
first line names the connection, the queues and the environment it assumed (E139): `Processing jobs of the database connection:
mail, default — in production (protected)`. A worker that is `development` only because the app's `.env` says so (E170) logs a
loud warning (`NODE_ENV=development comes from .env, not from the environment: …`) and runs anyway: on a server, set `NODE_ENV`
in the environment ([where it comes from](../core/README.md#the-environment-node_env)).

## Which queues a worker takes

Without `--queue` a worker takes only the connection's queue (`default`). The auth module of `make:auth` queues its mails on
`mail`, so a production worker runs with `--queue=mail,default` (the `make:docker` templates do). A worker that is idle looks at
the other queues once a minute: jobs ready on one of them at two looks in a row, and none of them running, are named once in a
warning — `Jobs are waiting on the "mail" queue …, which this worker does not take (it takes default)` — instead of waiting
without a word. `Worker#run({ watchOtherQueues })` sets the interval in seconds, `false` switches it off; with `--queue=*` there
is nothing to look for.

## Connections and drivers

### Configuration

```sh
QUEUE_CONNECTION=database       # database (default) | redis | sync
DB_QUEUE_CONNECTION=default     # the database connection of the jobs table
DB_QUEUE=default                # the default queue
DB_QUEUE_RETRY_AFTER=90         # seconds before a claimed job whose worker died is claimed again
REDIS_QUEUE_CONNECTION=default  # the Redis connection of the redis queue (REDIS_URL, @marmeon/redis + redis)
REDIS_QUEUE=default
REDIS_QUEUE_RETRY_AFTER=90
QUEUE_FAILED_DRIVER=database    # failed jobs: database (failed_jobs) | null (only logged)
QUEUE_FAILED_CONNECTION=…       # the database connection of failed_jobs (default: DB_QUEUE_CONNECTION)
```

`QueueConfig` is the package's config class (`config.default`, `config.connections`, `config.failed`). A connection name that
is not configured, an unknown database or Redis connection, a missing driver package: the start fails with what to do.

### Drivers

| Driver | Where jobs wait | Claim | Use it for |
| --- | --- | --- | --- |
| `database` | the `jobs` table (`marmeon make:queue-table`, E96) | one atomic statement: `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING` on Postgres; on SQLite one writing statement takes the lock before it reads | the default — no extra service, and a dispatch is part of the app's transaction |
| `redis` | `queues:<queue>` (a list), `…:delayed` and `…:reserved` (sorted sets by time) | one Lua script: move due and expired jobs, pop, count the attempt, reserve until `retryAfter` | many jobs, Redis anyway |
| `sync` | nowhere — `handle()` runs at the dispatch, in a scope of its own; its error is the dispatch's | — | scripts, and tests that want the work done at once |

Workers never decide by reading first: a job is claimed by exactly one worker (2 workers × 200 jobs, Postgres and Redis: none
twice — a test of the package). `queue:size` counts per queue; `--queue=*` finds every queue that holds jobs (at most once a second).
A driver may also split its count (`counts(queue)` → `{ ready, delayed, reserved }`: due, not yet due or released for later,
claimed by a worker) — all three drivers do; the devtools' queue view (`/_marmeon/devtools/queue`, development only —
[the pages](../devtools/README.md#the-pages-_marmeondevtools)) shows it.

## At-least-once: what the queue promises (E85)

A job runs **at least once**. A worker can die after `handle()` did its work and before the acknowledgement — then the job
comes back after `retryAfter` and runs again. That is the honest promise for SMTP, payment APIs and everything else outside
the database; "exactly once" would need the other side to cooperate. What the queue gives you for it:

- **`job.id`** is stable over every attempt and retry (also `queue:retry`): a key for the other side's idempotency
  (`Idempotency-Key` of an API).
- **`job.once(key, fn, { for })`** runs a side effect unless it already ran for `key`: a marker in the app's cache
  (`queue:once:<key>`, a day by default), a lock against a second attempt running `fn` at the same time. The gap stays and is
  documented: a worker that dies between `fn` and the marker runs `fn` again. Repeats become rare, not impossible.
- **Unique jobs** (below) keep a second *dispatch* out — not a second *run* of one job.
- **The database channel of notifications** stores the notification's id with the row: a repeated delivery finds it and stops.

Write `handle()` so that a repeat does no harm: read the record again, check whether the work is done, then do it.

### `retryAfter`, `timeout` and the worker's end

Node cannot stop a promise from outside. So a timeout is two lines of defence:

1. At `timeout` (seconds, default 60) `job.signal` aborts — pass it on (`fetch(url, { signal: job.signal })`) or check
   `signal.aborted` between steps.
2. A job that has not stopped `--stop-timeout` seconds later ends the **worker** (exit code 70, the process's own — no launcher
   in between). A supervisor (systemd, Docker, Kubernetes — `marmeon dev` itself in development) starts a new one; the job comes
   back after `retryAfter`.

**`retryAfter` must be longer than every job's `timeout` plus `--stop-timeout`** — otherwise a second worker claims a job that is
still running (Laravel's classic trap). `queue:work` checks every registered job at start and refuses with an explanation.

**SIGTERM/SIGINT:** no new claim; the running job may finish within `--stop-timeout` (default 10 s), else it is released for
another worker; exit 0. Later signals do not cut that short. The supervisor's grace period (Docker's `stop_grace_period`,
systemd's `TimeoutStopSec`, Kubernetes' `terminationGracePeriodSeconds`) must be longer than `--stop-timeout` — raise both
together for long jobs. `marmeon make:docker` writes both roles that way: a `worker` container with `restart: unless-stopped`
(exit 70 → a fresh worker, proved by `pnpm run ci`'s `image` part) and `deploy/systemd/worker.service` with `Restart=always`
([marmeon](../cli/README.md#production-files-makedocker-e141)).

## Transactions (E107, E109)

A dispatch inside `connections.transaction()` ([transactions](../database/README.md#transactions)) belongs to the
transaction — no `using(trx)` needed:

| Connection | Inside `transaction()` |
| --- | --- |
| `database` on the same database connection | a row written **in** the transaction — visible with the commit, gone with a rollback, atomic with your data |
| `redis`, `sync`, a `database` queue on another connection | held until the outermost commit (`afterCommit`), dropped on a rollback; a `sync` job then runs outside the transaction |
| `QueueFake` | recorded with the commit |

**Queued listeners** (`static queue` on a listener class, E86) are dispatched the same way — their job is a row in the
transaction on the database queue. There is **no `afterCommit` option** (E109): it is a type error ("afterCommit is always on:
queued listeners join the transaction (E107/E109) — remove it") and a boot error. A queued listener gets the event's payload —
`handle(payload: EventPayload<typeof Registered>)`, the output of the event's `static schema` —, never the event object: read
the records again in the worker.

A worker, a `sync` job and `app.queue.work()` run every job **outside** any transaction — the boundary is cut
(`outsideTransaction`), as for work after a response. `queue.using(trx)` stays for a transaction you control yourself.

## Secrets in payloads (E105)

The `jobs` and `failed_jobs` tables (and Redis) are a database: a reset link or a signed URL in a payload is a secret at rest.

- **`static encrypted = true`** encrypts the payload with the app's `Encrypter` (`APP_KEY`, previous keys still decrypt). A
  plaintext payload for an encrypted job is poison (failed at once), never run.
- The framework's own jobs are always encrypted: `marmeon.mail` (`mailer.queue`: the composed message with its links),
  `marmeon.listener` (queued listeners — the event belongs to the app), `marmeon.notification`.
- `failed_jobs.exception` and the worker's log lines go through the log's redaction (passwords in SMTP errors —
  [redaction](../core/README.md#redaction-e125)).
- Without encryption: IDs only — a test of the web app asserts that no reset token appears in `jobs`/`failed_jobs` in clear.

## Retries, failures, poison

- **`tries`** (default 1) and **`backoff`** (seconds, one value or one per retry) are stored with the job at the dispatch — a
  job the worker does not know yet (a rolling deploy) still retries by its own policy.
- `throw` → retry until `tries`, then **failed**: a row in `failed_jobs` (uuid = the job's id, connection, queue, name, payload,
  exception, failed_at) and a `JobFailed` event. `job.fail(reason)` fails at once, `job.release(delay)` puts it back (the attempt
  counts), `job.discard(reason)` ends it without a failed entry.
- **Poison fails at once**, after one attempt: a payload that no longer matches the schema after a deploy ("payload no longer
  matches the schema of auth.send-welcome-mail"), a payload that cannot be decrypted, no job record. A job name the worker does
  not know is released with backoff until its tries are used up (a rolling deploy), then failed.
- A job claimed more often than its `tries` (its worker died each time) fails instead of looping.
- `marmeon queue:retry <id|all>` puts failed jobs back (same id, attempts from zero); `queue:forget`, `queue:flush`,
  `queue:prune-failed --hours=168` (schedule it).

## Unique jobs, chains, middleware

```ts
await queue.dispatch(RebuildStatsJob, { userId }, { unique: `stats:${userId}`, uniqueFor: 600, uniqueUntil: 'processing' });
//   → the id, or undefined when one with this key waits (or runs) — the type says so: string | undefined
await queue.chain([[ImportProfileJob, { id }], [RebuildStatsJob, { userId }]]);   // the next only after the previous succeeded
static readonly middleware = [withoutOverlapping<typeof RebuildStatsJob>((p) => `stats:${p.userId}`, { releaseAfter: 30 })];
```

- **Unique:** a lock `queue:unique:<job>:<key>` in the app's cache (`cache.lock`, owner = the job's id), taken at the dispatch
  *outside* the transaction ([E108](../cache/README.md#database-its-own-connection-never-the-apps-transactions-e108): every
  process sees it at once), freed again by `afterRollback` if the transaction rolls back,
  by the worker when it starts the job (`uniqueUntil: 'processing'`) or when the job leaves the queue (`'done'`, the default:
  processed, failed, discarded), at the latest after `uniqueFor` (3600 s). Workers on several machines need a shared cache
  (`CACHE_DRIVER=database` or `redis`). `bulk()` and `chain()` take no unique key (a readable type error).
- **Chains** (E98): the rest of the chain travels in the job record; the next one is queued **with the acknowledgement** —
  database: one transaction, redis: one Lua script. A job that finally fails or discards ends the chain. Batches: not yet.
- **Job middleware** (`static middleware`, `handle(context, next)`): `withoutOverlapping(key, { releaseAfter = 5, expiresAfter =
  retryAfter, shared })` releases the job while another with the same key runs. A release counts as an attempt — jobs with it
  need `tries`; a release on the last attempt fails with that reason.

## Job events

`JobQueued` (after the commit), `JobProcessing`, `JobProcessed` (`ms`, `discarded`), `JobReleased` (`reason`), `JobFailed`
(`error`) — all `JobEvent`s: `listen(JobEvent, …)` hears every one. A listener's error is logged, never the job's. Job events
cannot be queued (a queued listener of a job event would make jobs whose events … — a loop; a readable type error).

**Where a job comes from (E131):** a job dispatched in a request carries the request's id in its record (`requestId`, also
without any subscriber) — and, when a tracer ([@marmeon/otel](../otel/README.md#what-it-records)) put one on the
`queue.dispatch` message, the trace context (`traceparent`). The [devtools](../devtools/README.md) and OpenTelemetry follow a
request into its jobs that way. For tools, the `queue.dispatch` and `queue.job` channels
([the channels](../core/README.md#the-channels), E118) trace every dispatch (`kind`, `jobs`,
`jobIds`, `queue`, `connection`, `delay`, `requestId`) and every attempt (`job`, `jobId`, `attempt`, `originRequestId`,
`traceparent`, `outcome`, `durationMs`, `error`); job events stay the app's interface.

**Readiness (E126):** the provider registers `QueueHealthCheck` for `/up/ready` ([health checks](../core/README.md#health-checks-e126))
— the default connection's driver answers (the size of its default queue; `sync` has nothing to reach).

## Testing

`createTestApp()` puts a **`QueueFake`** in place (`queue: 'fake'`, the default; `'real'` keeps the configured queue):
dispatches are checked like real ones (schema, unique locks in the test app's cache, transactions) and recorded.

```ts
app.queue.assertDispatched(SendWelcomeMailJob, { userId: ada.id });           // also a predicate, and { unique }
app.queue.assertDispatchedTimes(RebuildMemberStatsJob, 1).assertNotDispatched(OtherJob).assertNothingDispatched();
app.queue.assertChained([[ImportProfileJob, { id }], RebuildStatsJob]);
app.queue.assertListenerQueued(SendEmailVerification, { userId: ada.id });     // also assertListenerNotQueued
app.queue.dispatched(SendWelcomeMailJob);                                     // the recorded dispatches, to inspect
await app.queue.work();                                                       // runs what was queued — for real, in this process
await app.queue.failed();                                                     // what failed there
```

`app.queue.work()` builds each job in a scope, runs middleware, retries, chains and events — like a worker without the
process. Like the real queue, the fake traces a dispatch on `queue.dispatch` while something listens — a tracer's `traceparent`
reaches the recorded job, and `work()` runs it in the trace of the request that dispatched it (`@marmeon/otel`, E131).
The real worker is tested as a process too (`worker-processes.test.ts`: SIGKILL in the middle of a job, SIGTERM, a job
that ignores its signal, two workers × 200 jobs — on SQLite, Postgres and Redis).

## Upgrading from before Wave 6

The changes of Wave 6 for apps — queueable events, the `Login` fields, `afterCommit`, the test fakes, absolute links in mails,
the store contracts, the `Clock` — are in [UPGRADING.md](../../UPGRADING.md) ("Wave 6 — background services").
