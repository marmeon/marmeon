# @marmeon/cache

The cache, rate limits (`RateLimiter`, `throttle()`) and locks (`cache.lock()`) — injected like any service. The queue's unique
jobs and `job.once` markers, the scheduler's locks, the session's `block()` locks and the limit on live validations are kept
here too.

```ts
constructor(cache: Cache, limiter: RateLimiter) { … }
await this.#cache.remember(`stats:${id}`, 600, () => this.#stats.compute(id));
if (!(await this.#limiter.attempt(`password-check:${userId}`, 5, 60))) abort(429);
await this.#cache.lock(`report:${id}`, 60).block(5, () => this.#reports.build(id));
```

`add`, `increment` and `lock` are atomic in every store (E103): counting and deciding is one step of the store — one SQL
statement, a Lua script or `SET NX`, a per-key guard file — so concurrent requests in any number of processes never get past a
limit together. (The `file` store takes over a guard older than 2 s, left by a crashed process: one that stalls longer than that
inside its few-microsecond step loses its exclusivity.)

`marmeon discover` registers its `CacheServiceProvider` through the `"marmeon"` field of its package.json: the `Cache` of
`CACHE_DRIVER` and the `RateLimiter` (singletons), the live-validation limit in the global middleware stack, a readiness check,
and `make:cache-table`, `cache:prune` and `cache:clear` (when `marmeon` is installed). The `database` and `redis` drivers
need their packages — optional peers; a missing one fails the start with what to install (`CacheSetupError`: "CACHE_DRIVER=redis
needs @marmeon/redis, which is not installed in this app: pnpm add @marmeon/redis redis").

**Readiness (E126):** the provider registers `CacheHealthCheck` for `/up/ready` — the store of `CACHE_DRIVER` takes a new key
(`add`) and lets it go (`forget`); the database store writes on its infrastructure connection (E108), as the cache always does.
See [health checks](../core/README.md#health-checks-e126).

## Configuration

```sh
CACHE_DRIVER=file                    # file (default) | database | redis | memory
CACHE_CONNECTION=default             # database/redis: which database or Redis connection (default: default)
CACHE_PATH=storage/framework/cache   # file: where entries live, relative to the app root (default)
CACHE_PREFIX=                        # prepended to every key and lock — apps sharing a store stay apart (default: none)
```

`CacheConfig` (`config.driver`, `config.connection`, `config.path`, `config.prefix`) is the package's config class. The web app
runs `CACHE_DRIVER=database` with `CACHE_CONNECTION=system` (a SQLite file of its own), its `.env.test` `CACHE_DRIVER=memory`.

## Cache drivers (`CACHE_DRIVER`)

| Driver     | Where the data lives                                                              | Use it for                                    |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `file`     | a file per key (`CACHE_PATH`) — the default                                       | one server                                    |
| `database` | rows in `cache` and `cache_locks` (`marmeon make:cache-table`, `CACHE_CONNECTION`) | several processes or servers                  |
| `redis`    | `<REDIS_PREFIX>cache:<key>` and `<REDIS_PREFIX>lock:<name>` ([@marmeon/redis](../redis/README.md) + `redis`, `CACHE_CONNECTION`) | several servers, Redis anyway |
| `memory`   | the process                                                                       | tests                                         |

### `database`: its own connection, never the app's transactions (E108)

A rate-limit counter or a lock must not be part of the app's transaction: a failed login counted inside a transaction
that rolls back would be uncounted (a throttle bypass), and a lock would stay invisible to other processes until the
commit. So the database store writes through `connections.infrastructure()`
([infrastructure connections](../database/README.md#infrastructure-connections-e108)) — never the ambient transaction.
(Laravel's database cache uses the app's connection by default and joins its transactions.)

| Database | What the store gets | Inside an open app transaction |
| -------- | ------------------- | ------------------------------ |
| Postgres | a small pool of its own to the same database (`DB_INFRA_POOL_MAX`, default 4) — nothing to configure | works; a hit or a lock survives the rollback and is visible at once |
| SQLite with a file of its own (`CACHE_CONNECTION=system`, a `defineConnection('system', …)` for e.g. `storage/system.sqlite`) | that file | works; survives the rollback |
| SQLite, the app's own file (`CACHE_CONNECTION=default`) | the file's one connection, shared | throws `InfrastructureTransactionError` — configure a file of its own, or use Redis. Never a silent join. Outside transactions (the normal case) it works as before |

A second connection to the app's own SQLite file cannot help: it would wait for the open transaction's write lock —
forever, if the transaction waits for the cache.

```sh
marmeon make:cache-table   # modules/system/migrations/…_create_cache_table.ts (E96: the tables are the app's; --module=<name> for another)
marmeon migrate            # creates them on CACHE_CONNECTION
```

The migration follows the cache: `connection: cacheTablesConnection` puts the tables on `CACHE_CONNECTION` (with the
database driver; otherwise on `default`) — see [migrations on another connection](../database/README.md#migrations-on-another-connection).

## The cache

`get(key)`, `put(key, value, ttlSeconds?)` (without a TTL it never expires), `add` (only if absent — of two at once, one wins),
`has`, `forget`, `increment(key, by = 1, ttlSeconds?)` (atomic; a new key gets the TTL, an existing one keeps its expiry),
`remember(key, ttlSeconds, compute)` (not a lock: two misses at once both compute), `ttl(key)`, `flush()` (locks stay),
`prune()`. Values must survive `JSON.stringify` — a `Date` comes back as a string. Expiry follows the app's `Clock` (E97), so
`app.travel()` in a test moves it — except on Redis, whose TTLs follow Redis' clock.

## Locks

```ts
const lock = this.#cache.lock(`avatar:${user.id}`, 10);   // held 10 s at most — a crashed holder cannot block forever
if (!(await lock.get())) abort(423);
try { … } finally { await lock.release(); }                // frees it only if this lock still holds it

await this.#cache.lock('report', 60).block(5, () => build());   // waits up to 5 s (polled every 250 ms), then LockTimeoutError
await this.#cache.lock('report', 60).get(() => build());        // once: the callback's result, or false when it was taken
```

The owner token is random per lock object; `cache.lock(name, seconds, owner)` restores a lock taken elsewhere (another request,
a job) to release it. `forceRelease()` frees it whoever holds it, `owned()` says whether this owner holds it now.

### Undoing a lock with the transaction

A lock taken for work that is part of a transaction — a unique job whose row is in it — must be released if the
transaction rolls back: `afterRollback(() => lock.release())` (from `@marmeon/database`,
[the rules](../database/README.md#the-rules)) runs right after the rollback and never after a commit.
The queue does exactly this for unique jobs (`queue.dispatch(Job, payload, { unique })`): lock, then `afterRollback`, then the
dispatch.

### Locks and markers of the queue

`@marmeon/queue` keeps three things in this cache: the locks of unique jobs (`queue:unique:<job>:<key>`, owner = the
job's id, so the worker that finishes the job frees it), the locks of the `withoutOverlapping` job middleware
(`queue:overlap:…`) and the markers of `job.once` (`queue:once:<key>`, kept a day by default). With workers on several
machines the cache must be shared: `database` or `redis` — `file` and `memory` lock only one machine (one process). See
[unique jobs, chains, middleware](../queue/README.md#unique-jobs-chains-middleware).

### Locks of the session

A route that `block()`s ([@marmeon/session](../session/README.md#blocking-routes-block), E145) runs its requests one at a
time per session through a lock of this cache: `session:<key>` — the session's store key (the SHA-256 of its id, never the id),
held for the route's `lockSeconds`, waited for with `block(waitSeconds)` (then **423**). Without this package such a route
answers 500 naming it. With several processes or servers the cache must be shared (`database` or `redis`) — `file` locks one
machine, `memory` one process.

### Locks of the scheduler

The scheduler ([@marmeon/scheduler](../scheduler/README.md)) keeps its locks here too: `schedule:<task>:<minute>` for
`onOneServer()` (an hour), `schedule:overlap:<task>` for `withoutOverlapping()`, and its last tick (`schedule:last-tick`,
`schedule:last-tick:<host>`) for catching up missed runs. With `file` or `memory` these locks hold on one machine (`file`) or in
one process (`memory`) only: since E123 `schedule:work` and `schedule:run` **start anyway and warn** (and `schedule:list` shows
the warning) — right for a single scheduler. With more than one scheduler instance use `database` or `redis`.

## Rate limits

`RateLimiter` counts attempts in the cache: `hit(key, decaySeconds)` (the new count), `attempt(key, max, decaySeconds)` (counts
and decides in one atomic step), `attempts`, `tooManyAttempts`, `availableIn` (seconds), `clear`. Named limiters are defined in
a provider's `boot` and applied to routes with `throttle(name)`:

```ts
// modules/auth/AuthServiceProvider.ts
const limiter = app.container.make(RateLimiter);
limiter.for('register', (ctx) => Limit.perMinute(10).by(ctx.ip ?? 'unknown'));

// modules/auth/routes.ts
guests.middleware(throttle('register')).post('/register', RegisterController).name('auth.register.store');
```

- **`Limit`:** `perSecond(n)`, `perMinute(n)`, `perHour(n)`, `perDay(n)` (each with an optional multiple: `perMinute(5, 10)`),
  `.by(key)`, `Limit.none()`. A limiter may return several limits — each counts on its own.
- **`ctx.ip`** is the client's address — behind a proxy only when the proxy is in `TRUSTED_PROXIES`
  ([behind a proxy](../server/README.md#behind-a-proxy-e162)); otherwise every visitor shares the proxy's address, and its limit.
- **Answers:** a used-up limit is a `429` with `Retry-After` and `X-RateLimit-*` headers (the message is the translated
  `marmeon.errors.throttled`); passing responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A limiter that is not
  defined throws on the first request.
- **Live validations (E62):** a field checked on blur is held to the route's limit but does not count against it. They have a
  limit of their own in the global stack — `live-validation`, 30 a minute per route and client address (`LimitLiveValidation`);
  `limiter.for('live-validation', (ctx) => Limit.perMinute(60).by(ctx.ip ?? ''))` changes it, `Limit.none()` turns it off.

## Expired entries: `cache:prune`, emptying: `cache:clear`

Expired entries and locks stay in `memory`, `file` and `database` stores until they are read or overwritten.
`marmeon cache:prune` deletes them (each in one statement or under its guard — a live one is never touched); Redis expires
keys itself. Schedule it: `s.command('cache:prune').hourlyAt(25).withoutOverlapping().onOneServer()` (the web app's
`modules/system/schedule.ts`). `marmeon cache:clear` empties the cache — every entry, never a lock: rate-limit windows,
`job.once` markers and the scheduler's last tick are gone too (after `migrate:fresh`, when ids start over and old markers would
match new records). On Redis it deletes only the `cache:` keys (`SCAN` + `UNLINK`), never `FLUSHDB`.

## Testing

Tests usually run `CACHE_DRIVER=memory` (the web app's `.env.test`). The cache, locks and rate limits read the time through the
app's `Clock`: with `@marmeon/testing`, `app.travel({ minutes: 1 })` lets a rate-limit window pass without waiting.
`pnpm test:redis` runs the store tests against Redis too ([testing](../redis/README.md#testing)).
