# Cache

## Introduction

Some answers take long to compute and change rarely: the numbers of a dashboard, a feed from another service. The cache keeps
such a value under a key for a while, so the next request reads it instead of computing it again. Inject the `Cache` of
`@marmeon/cache`, which every new app has:

```ts title="modules/notes/controllers/ShowNoteStatsController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Cache } from '@marmeon/cache';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class ShowNoteStatsController extends Controller {
  readonly #cache: Cache;
  readonly #notes: NoteRepository;

  constructor(cache: Cache, notes: NoteRepository) {
    super();
    this.#cache = cache;
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const stats = await this.#cache.remember(`notes:stats:${ctx.user.id}`, 600, () => this.#notes.statsFor(ctx.user.id));
    return this.view('notes/Stats', { stats });
  }
}
```

`remember()` returns the cached value, or computes it, stores it for 600 seconds and returns it. The same cache keeps the
framework's rate limits and locks, and the [rate limiting](rate-limiting.md) page covers the limits.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `CACHE_DRIVER` | `file` | Where entries live: `file`, `database`, `redis`, `memory` or a driver a package brings. |
| `CACHE_CONNECTION` | `default` | The database or Redis connection of the `database` and `redis` drivers. |
| `CACHE_PATH` | `storage/framework/cache` | Where the `file` driver keeps entries, relative to the app. |
| `CACHE_PREFIX` | empty | Put in front of every key and lock. It separates keys, not stores: see below. |

A new app's `.env.test` sets `CACHE_DRIVER=memory`.

`CACHE_PREFIX` keeps the keys of two apps apart, but `marmeon cache:clear` empties the whole store, not the prefix: on the `file`
and `database` drivers every entry, rate-limit counters and `job.once` markers of the other app included. Locks stay. So give each
app a store of its own: its own `CACHE_PATH` with the `file` driver, its own database (`CACHE_CONNECTION`) with the `database`
driver, and with `redis` its own `REDIS_PREFIX`, which `cache:clear` stays within.

## Drivers

| Driver | Where the data lives | Use it for |
| --- | --- | --- |
| `file` | A file per key, in `CACHE_PATH`. | One server. |
| `database` | Rows of the `cache` and `cache_locks` tables. | Several processes or servers. |
| `redis` | Keys `<REDIS_PREFIX>cache:<key>` and `<REDIS_PREFIX>lock:<name>`. | Several servers that run Redis anyway. |
| `memory` | The process. Gone when it stops. | Tests. |

The `database` driver needs `@marmeon/database` and the `redis` driver `@marmeon/redis`, which brings the Redis client. Without
the package the app fails at the start and names it: `CACHE_DRIVER=redis needs @marmeon/redis, which is not installed in this
app: pnpm add -E @marmeon/redis@<version of your app>`. The [Redis](redis.md#which-connection-a-driver-uses) page covers its connection.

The `database` driver needs its tables once:

```sh
pnpm marmeon make:cache-table
pnpm marmeon migrate
```

`make:cache-table` writes the migration into the `system` module, or the module that `--module` names. It is `marmeon publish
@marmeon/cache`: when your app has the migration already, it writes nothing and ends with exit code 0. The migration creates the
tables on the cache's connection, `CACHE_CONNECTION`. See [the framework's tables](migrations.md#the-frameworks-tables).

### Cache drivers

A package or an app can bring a cache driver of its own, such as one for DynamoDB. Its provider lists it in `static cacheDrivers`,
and `CACHE_DRIVER` selects it by name. A driver is a pair of a store and a lock store; the [drivers](drivers.md#cache-drivers)
page has what each must guarantee.

### The database driver and transactions

The `database` driver never writes inside the app's transactions. A failed sign-in counted inside a transaction that rolls back
would be uncounted, and a rate limit would let the next guess through. A lock taken inside one would stay invisible to other
processes until the commit. So the cache writes on a connection of its own:

| Database | What the cache gets | Inside an open transaction |
| --- | --- | --- |
| Postgres | A small pool of its own to the same database, `DB_INFRA_POOL_MAX` connections, 4 by default. | Works. A count or a lock survives a rollback and is visible at once. |
| SQLite, a file of its own | That file. | Works, and survives a rollback. |
| SQLite, the app's own file | The file's one connection. | Throws `InfrastructureTransactionError`. |

A SQLite file has one writer. A second connection to the app's file would wait for the open transaction, forever if the
transaction waits for the cache. So on SQLite give the cache its own file: a second connection in `config/database.ts`, such as
`system` for `storage/system.sqlite`, and `CACHE_CONNECTION=system`. Outside a transaction, the normal case, the app's own file
works too. The [database](database.md#more-connections) page shows how to define a connection.

## Using the cache

| Method | What it does |
| --- | --- |
| `get(key)` | The value, or `undefined`. |
| `put(key, value, ttl?)` | Stores a value. Without a time it never expires. `ttl` is seconds, or a [`Duration`](time.md#spans-of-time) such as `{ minutes: 5 }`. |
| `add(key, value, ttl?)` | Stores the value only when the key is free, and says whether it did. |
| `has(key)` | Whether the key holds a value. |
| `forget(key)` | Removes the key. |
| `increment(key, by = 1, ttl?)` | Adds a whole number and returns the result. |
| `remember(key, ttl, compute)` | The value, or `compute()` stored and returned. |
| `ttlSeconds(key)` | Seconds until the key expires, or `undefined`. |
| `flush()` | Removes every entry. Locks stay. |

Values are stored as JSON, so they must survive `JSON.stringify()`: a `Date` comes back as a string. Expiry follows the app's
clock, so `app.travel()` in a test moves it, except on Redis, whose keys expire by Redis' own clock.

`add()` and `increment()` are atomic in every store, and across processes in the `file`, `database` and `redis` stores. Of two
`add()` calls at once, exactly one stores its value. Two processes that count at once never lose a count. A new key of
`increment()` gets the time to live, and an existing one keeps its expiry, so a window does not start over with every hit.

`remember()` is no lock: when two requests miss at once, both compute the value. When the work must run only once, take a lock.

## Locks

A lock lets one process do a piece of work while others wait or give up. It is held for a span of time at most (seconds, or a [`Duration`](time.md#spans-of-time)), so a holder
that crashes cannot block it forever:

```ts title="modules/notes/controllers/ExportNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Cache } from '@marmeon/cache';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { NoteExports } from '../NoteExports.ts';

export class ExportNotesController extends Controller {
  readonly #cache: Cache;
  readonly #exports: NoteExports;

  constructor(cache: Cache, exports: NoteExports) {
    super();
    this.#cache = cache;
    this.#exports = exports;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const lock = this.#cache.lock(`notes:export:${ctx.user.id}`, 60);
    if (!(await lock.get())) abort(423);
    try {
      await this.#exports.build(ctx.user.id);
    } finally {
      await lock.release();
    }
    return this.back();
  }
}
```

- **`get()`** tries once and says whether it took the lock. `get(callback)` runs the callback while holding it, releases it
  and returns `ok(result)`, or `err({ kind: 'locked' })` without calling it when someone else holds the lock — a
  [`Result`](errors.md#results), so a callback that returns `false` is not mistaken for a taken lock. Returned from a
  `transaction()` callback, `locked` rolls the transaction back ([transactions](transactions.md#returning-an-err)).
- **`block(wait, callback)`** waits up to `wait` (seconds, or a `Duration`) for the lock, trying every 250 milliseconds, runs the
  callback while holding it, releases the lock and returns `ok(result)`. A lock that stays held gives `err({ kind: 'timeout' })`
  and the callback never runs. Returned from a `transaction()` callback, `timeout` rolls the transaction back
  ([transactions](transactions.md#returning-an-err)). Without a callback `block()` throws a `TypeError`: to try once, use `get()`.
- **`release()`** frees the lock only while this lock object holds it. A lock that expired and was taken by another stays
  theirs.
- **`forceRelease()`** frees it, whoever holds it. **`owned()`** says whether this object holds it now.

Each lock object has a random owner token. `cache.lock(name, ttl, owner)` makes an object with a known owner, so a job can
release a lock that a request took, given the lock's `owner`. The time to live must be positive.

```ts
const exported = await this.#cache.lock('report', 60).get(() => this.#exports.build(ctx.user.id));
if (!exported.ok) abort(423);
```

A lock taken for work inside a transaction must go when the transaction rolls back. `afterRollback(() => lock.release())` of
`@marmeon/database` does that, and the [transactions](transactions.md#after-a-rollback) page explains it.

> [!WARNING]
> The `file` driver locks only one machine, and `memory` only one process. With several servers, or a worker on another machine,
> use `database` or `redis`, or two processes take the same lock.

## What else the cache holds

The framework keeps its own counters and locks in the same cache:

| What | Keys | Read more |
| --- | --- | --- |
| Rate limits | The counters of `throttle()` and the `RateLimiter`. | [Rate limiting](rate-limiting.md#where-the-counts-live) |
| Live validations | Their own limit, 30 a minute per route and address. | [Validation](validation.md#live-validation) |
| Unique jobs, `withoutOverlapping` and `job.once` | `queue:unique:…`, `queue:overlap:…`, `queue:once:…`, `queue:once-lock:…` | [Queues](queues.md#unique-jobs) |
| Routes that `block()` | `session:<key>`, the session's store key, never its id. | [Session](session.md#requests-that-must-not-overlap) |
| `onOneServer()`, `withoutOverlapping()` and missed runs of the scheduler | `schedule:…` | [Task scheduling](scheduling.md#several-servers-and-long-runs) |

So the warning above holds for all of them: with more than one server, the cache must be one they share.

## Expired entries and clearing

The `file` and `database` stores keep an expired entry until it is read or overwritten. The `memory` store also clears expired
entries and locks as it writes, a few at a time, because `cache:prune` in the scheduler's process cannot reach a web process's
memory. `cache:prune` deletes expired entries and locks, and never touches one that is still valid. Redis expires keys by
itself, and the command says so. Schedule it in a module's schedule, which counts once the module lists it as `schedule` in its
definition, as the [task scheduling](scheduling.md#defining-tasks) page shows:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer();
});
```

`cache:clear` empties the cache: every entry, never a lock. Rate-limit windows, the queue's `job.once` markers and the scheduler's
record of its last run go too. Clear it after `migrate:fresh`, when ids start over and an old marker would match a new record. On
Redis it deletes only the keys of the cache, never the whole database.

## Testing

Tests usually run on `CACHE_DRIVER=memory`, which `.env.test` sets. The cache, its locks and the rate limits read the time from
the app's clock: `app.travel({ minutes: 1 })` lets an entry expire or a rate-limit window pass without waiting. The
[time](time.md) page covers the clock in tests.
