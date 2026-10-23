# Redis

## Introduction

[Redis](https://redis.io) is an in-memory store that several processes and machines can share. Marmeon can keep its cache, locks
and rate limits there, its sessions, its queue and the hints of live updates. Redis is optional: every package works without it by
default, and `pnpm dev` and `pnpm test` need no Redis. [Valkey](https://valkey.io) works the same way.

```sh
pnpm add @marmeon/redis
```

The package brings the Redis client, so an app installs nothing else. Then choose Redis per driver in `.env`:

```sh
REDIS_URL=redis://127.0.0.1:6379
CACHE_DRIVER=redis
SESSION_DRIVER=redis
QUEUE_DRIVER=redis
LIVE_DRIVER=redis
```

A Redis driver without the package stops the app at the start and names the command:

```text
[marmeon:S1] CACHE_DRIVER=redis needs @marmeon/redis, which is not installed in this app: pnpm add @marmeon/redis
```

The [cache](cache.md#drivers), [session](session.md#drivers), [queues](queues.md#drivers) and
[real-time updates](realtime.md#more-than-one-process) pages explain what each driver keeps in Redis.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `REDIS_URL` | `redis://127.0.0.1:6379` | The server: `redis://[[user]:password@]host[:port][/db]`, or `rediss://` for TLS. |
| `REDIS_PREFIX` | the app's name as a slug, and `:` | Put in front of every key and channel, so two apps on one Redis never share a key. `My App` becomes `my-app:`. |

`REDIS_URL` must start with `redis://` or `rediss://`, or the app does not start. The prefix comes from `APP_NAME`, and
`marmeon:` when the name is not set. Leave `REDIS_PREFIX` out for that default; an empty `REDIS_PREFIX=` counts as not set too.
A prefix you set is used as you write it, so end it with the colon yourself: `REDIS_PREFIX=notes-app:`.

Redis holds sessions, queued jobs and locks. Keep it off the public network, give it a password in the URL, and use `rediss://`
whenever the connection leaves a private network.

### Which connection a driver uses

Each driver names the Redis connection it uses, `default` unless you set another:

| Variable | Default | For |
| --- | --- | --- |
| `CACHE_CONNECTION` | `default` | The cache, locks and rate limits, with `CACHE_DRIVER=redis`. |
| `SESSION_CONNECTION` | `default` | Sessions, with `SESSION_DRIVER=redis`. |
| `QUEUE_REDIS_CONNECTION` | `default` | The queue, with `QUEUE_DRIVER=redis`. |
| `LIVE_CONNECTION` | `default` | Live updates, with `LIVE_DRIVER=redis`. |

`CACHE_CONNECTION` and `SESSION_CONNECTION` name a database connection instead when their driver is `database`. A driver whose
connection does not exist stops the app at the start, with the names it knows.

### More connections

Another Redis, a separate instance for the queue for example, is a definition with a name. It reads its own variables, which are
checked at the start like all [configuration](configuration.md):

```ts title="config/redis.ts"
import { env } from '@marmeon/core';
import { defineRedisConnection } from '@marmeon/redis';

export const QueueRedis = defineRedisConnection('queue', {
  env: env({ QUEUE_REDIS_URL: env.url({ protocols: ['redis', 'rediss'] }) }),
  resolve: (e) => ({ url: e.QUEUE_REDIS_URL, prefix: 'notes-app:' }),
});
```

List it in `config` of `defineApplication()` in `bootstrap/app.ts`, and point the queue at it with `QUEUE_REDIS_CONNECTION=queue`.
`resolve` returns the URL and the prefix. `default` is the name of the connection of `REDIS_URL`, and
`defineRedisConnection('default', …)` throws.

## Using Redis yourself

`RedisConnections` gives you a connection by name. It connects on its first command:

```ts title="modules/notes/NoteViews.ts"
import { defineRedisScript, RedisConnections, type RedisConnection } from '@marmeon/redis';

// Defined once, at module scope. Redis runs it atomically.
const countOnce = defineRedisScript(
  'notes.count-view',
  `if redis.call('set', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return redis.call('incr', KEYS[2]) end
   return tonumber(redis.call('get', KEYS[2]) or '0')`,
);

export class NoteViews {
  readonly #redis: RedisConnection;

  constructor(redis: RedisConnections) {
    this.#redis = redis.get();
  }

  count(noteId: number, viewerId: number): Promise<number> {
    const keys = [this.#redis.key(`notes:viewed:${noteId}:${viewerId}`), this.#redis.key(`notes:views:${noteId}`)];
    return this.#redis.run<number>(countOnce, keys, [3600]);
  }

  async total(noteId: number): Promise<number> {
    return Number((await this.#redis.command<string | null>(['GET', this.#redis.key(`notes:views:${noteId}`)])) ?? 0);
  }
}
```

| Member | What it does |
| --- | --- |
| `redis.get(name?)` | The connection by name, `default` without one. An unknown name throws with the known ones. |
| `connection.command(args)` | Any Redis command, raw: `['SET', key, value, 'EX', 60]`. Numbers are sent as strings. |
| `connection.key(name)` | The key with the connection's prefix: `key('notes:views:7')` is `my-app:notes:views:7`. |
| `connection.run(script, keys, args)` | Runs a script of `defineRedisScript(name, lua)` by its hash, and sends the script itself only when Redis does not know it yet, after a restart for example. |
| `connection.duplicate()` | A second connection to the same Redis, with the same prefix. |
| `connection.subscribe(channel, listener)` | Listens on a channel and resolves with a function that stops listening. |

Commands are raw, so **keys are not prefixed for you**: name every key with `key()`. A connection that subscribes runs no other
commands, so subscribe on a `duplicate()`:

```ts
const unsubscribe = await this.#redis.duplicate().subscribe(this.#redis.key('notes:events'), (message) => this.#onEvent(message));
```

Every connection closes when the app shuts down, duplicates included.

## When Redis is down

- **Requests fail, they do not hang.** The first connection gives up after five seconds, with the address in the message and the
  password masked. While a lost connection reconnects, at most every two seconds, commands fail at once instead of waiting in a
  queue. A request with Redis down gets an error, a 500. When a working connection drops, the log says so with a warning.
- **There is no fallback store.** Decide per app whether Redis is critical, and watch it with the readiness check.

The cache, sessions, the queue and live updates load the client when the app starts, so a broken install stops the start. An
unreachable Redis is noticed by the first command. A queue worker that cannot reach Redis, when it starts or later, stops with the
error, so run it under a supervisor that starts it again.

## The keys the framework writes

| Key | Written by |
| --- | --- |
| `<prefix>cache:…` | The cache and rate limits. |
| `<prefix>lock:…` | Locks, and the locks of routes that `block()` their session. |
| `<prefix>session:<key>` | Sessions. `<key>` is the SHA-256 of the session's id, never the id. |
| `<prefix>queues:<queue>`, with `:delayed` and `:reserved`, and the set `<prefix>queues` | The queue. |
| `<prefix>live:seq:<channel>`, and the channel `<prefix>live` | Live updates. |

`marmeon cache:clear` deletes only the cache's own keys, and never empties the whole Redis database: sessions, the queue and locks
may live in the same one.

## Readiness

The readiness check, `/up/ready`, sends `PING` to every Redis connection the app uses: one that a driver or your code asked for. A
configured connection that nothing uses is not checked, since `REDIS_URL` has a default and an app on the database drivers never
talks to it. The [health checks](health.md#liveness-and-readiness) page explains readiness.

## Time

A key's expiry follows the clock of the Redis server, never the app's clock. `app.travel()` in a test therefore does not expire
Redis keys. The [time](time.md) page explains the test clock.

## What is not supported

Redis Cluster and Sentinel are not supported: a connection is one server at one URL, and the framework's scripts touch several
keys without hash tags. The queue's worker polls Redis and uses no blocking pops.
