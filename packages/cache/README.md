# @bespokecore/cache

The cache, rate limits (`RateLimiter`, `throttle()`) and locks (`cache.lock()`) — injected like any service:

```ts
constructor(cache: Cache, limiter: RateLimiter) { … }
await this.#cache.remember(`stats:${id}`, 600, () => this.#stats.compute(id));
if (!(await this.#limiter.attempt(`login:${email}`, 5, 60))) abort(429);
await this.#cache.lock(`report:${id}`, 60).block(5, () => this.#reports.build(id));
```

`add`, `increment` and `lock` are atomic in every store (E103): counting and deciding is one step of the store, so
concurrent requests in any number of processes never get past a limit together.

**Readiness (E126):** the provider registers `CacheHealthCheck` for `/up/ready` — the store of `CACHE_DRIVER` takes a new key
(`add`) and lets it go (`forget`); the database store writes on its infrastructure connection (E108), as the cache always does.

## Cache drivers (`CACHE_DRIVER`)

| Driver     | Where the data lives                                                              | Use it for                                    |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `file`     | a file per key (`CACHE_PATH`) — the default                                       | one server                                    |
| `database` | rows in `cache` and `cache_locks` (`bespoke make:cache-table`, `CACHE_CONNECTION`) | several processes or servers                  |
| `redis`    | `<REDIS_PREFIX>cache:<key>` (`@bespokecore/redis` + `redis`, `CACHE_CONNECTION`)   | several servers, Redis anyway                 |
| `memory`   | the process                                                                       | tests                                         |

### `database`: its own connection, never the app's transactions (E108)

A rate-limit counter or a lock must not be part of the app's transaction: a failed login counted inside a transaction
that rolls back would be uncounted (a throttle bypass), and a lock would stay invisible to other processes until the
commit. So the database store writes through `connections.infrastructure()` (see `packages/database/README.md`) — never
the ambient transaction. (Laravel's database cache uses the app's connection by default and joins its transactions.)

| Database | What the store gets | Inside an open app transaction |
| -------- | ------------------- | ------------------------------ |
| Postgres | a small pool of its own to the same database (`DB_INFRA_POOL_MAX`, default 4) — nothing to configure | works; a hit or a lock survives the rollback and is visible at once |
| SQLite with a file of its own (`CACHE_CONNECTION=system`, a `defineConnection('system', …)` for e.g. `storage/system.sqlite`) | that file | works; survives the rollback |
| SQLite, the app's own file (`CACHE_CONNECTION=default`) | the file's one connection, shared | throws `InfrastructureTransactionError` — configure a file of its own, or use Redis. Never a silent join. Outside transactions (the normal case) it works as before |

A second connection to the app's own SQLite file cannot help: it would wait for the open transaction's write lock —
forever, if the transaction waits for the cache.

```sh
bespoke make:cache-table   # modules/system/migrations/…_create_cache_table.ts (E96: the tables are the app's)
bespoke migrate            # creates them on CACHE_CONNECTION
```

The migration follows the cache: `connection: cacheTablesConnection` puts the tables on `CACHE_CONNECTION` (with the
database driver; otherwise on `default`).

### Undoing a lock with the transaction

A lock taken for work that is part of a transaction — a unique job whose row is in it — must be released if the
transaction rolls back: `afterRollback(() => lock.release())` (from `@bespokecore/database`) runs right after the rollback
and never after a commit.
The queue does exactly this for unique jobs (`queue.dispatch(Job, payload, { unique })`, W6 step 4): lock, then
`afterRollback`, then the dispatch.

### Locks and markers of the queue

`@bespokecore/queue` keeps three things in this cache: the locks of unique jobs (`queue:unique:<job>:<key>`, owner = the
job's id, so the worker that finishes the job frees it), the locks of the `withoutOverlapping` job middleware
(`queue:overlap:…`) and the markers of `job.once` (`queue:once:<key>`, kept a day by default). With workers on several
machines the cache must be shared: `database` or `redis` — `file` and `memory` lock only one machine (one process).

The scheduler (`@bespokecore/scheduler`) keeps its locks here too: `schedule:<task>:<minute>` for `onOneServer()` (an hour),
`schedule:overlap:<task>` for `withoutOverlapping()`, and its last tick (`schedule:last-tick`, `schedule:last-tick:<host>`) for
catching up missed runs. `onOneServer()` with `file` or `memory` is refused when the scheduler starts.

### Expired entries: `cache:prune`, emptying: `cache:clear`

Expired entries and locks stay in `memory`, `file` and `database` stores until they are read or overwritten.
`bespoke cache:prune` deletes them (each in one statement or under its guard — a live one is never touched); Redis expires
keys itself. Schedule it: `s.command('cache:prune').hourly()`. `bespoke cache:clear` empties the cache — every entry, never
a lock: rate-limit windows, `job.once` markers and the scheduler's last tick are gone too (after `migrate:fresh`, when ids
start over and old markers would match new records).
