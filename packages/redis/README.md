# @marmeon/redis

Redis connections (E87) — like database connections: lazy per name, closed on shutdown, injected where needed. The cache,
locks and rate limits (`CACHE_DRIVER=redis`), sessions (`SESSION_DRIVER=redis`), the queue (`QUEUE_CONNECTION=redis`) and live
props (`LIVE_DRIVER=redis`) build on it. **Redis is optional:** the defaults of every package work without it (`pnpm dev` and
`pnpm test` need no Redis); Valkey works the same.

```sh
pnpm add @marmeon/redis redis   # the official client (node-redis 5 or 6) is an optional peer
```

`marmeon discover` registers its `RedisServiceProvider` through the `"marmeon"` field of its package.json: `RedisConnections`
(a singleton), a readiness check, and closing every connection — duplicates included — on shutdown.

```ts
constructor(redis: RedisConnections) {
  this.#redis = redis.get();                                   // 'default' (REDIS_URL), or a named one: redis.get('queue')
}
await this.#redis.command(['SET', this.#redis.key('stats'), '42', 'EX', '60']);   // raw commands; key() adds the prefix

// A Lua script, atomic in Redis: defined once (module scope), run by hash — loaded when Redis does not know it (EVALSHA → EVAL).
const release = defineRedisScript('lock.release', `
  if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end
  return 0`);
await this.#redis.run(release, [this.#redis.key('lock:report')], [owner]);

// Pub/sub blocks a socket: subscribe on a duplicate (same Redis, same prefix, closed on shutdown too).
const off = await this.#redis.duplicate().subscribe(this.#redis.key('events'), (message) => …);
```

## Configuration

The default connection (`RedisConfig`, checked at the start like all configuration):

```sh
REDIS_URL=redis://127.0.0.1:6379    # the default; redis://[[user]:password@]host[:port][/db] — rediss:// for TLS
REDIS_PREFIX=myapp:                 # default: APP_NAME as a slug plus ":" (`My App` → `my-app:`) — two apps on one Redis never share a key
```

Another connection (a separate instance for the queue, say) is a config definition, validated at startup like all
configuration:

```ts
export const QueueRedis = defineRedisConnection('queue', {
  env: v.object({ QUEUE_REDIS_URL: v.string() }),
  resolve: (env) => ({ url: env.QUEUE_REDIS_URL, prefix: 'myapp:' }),
});
defineApplication({ config: [QueueRedis], … });
```

`default` is reserved for `REDIS_URL`. Each driver names the connection it uses — `default` unless set:

| Variable | Driver | Its README |
| -------- | ------ | ---------- |
| `CACHE_CONNECTION` | the cache, locks and rate limits (`CACHE_DRIVER=redis`) | [cache drivers](../cache/README.md#cache-drivers-cache_driver) |
| `SESSION_CONNECTION` | sessions (`SESSION_DRIVER=redis`) | [session drivers](../session/README.md#session-drivers) |
| `REDIS_QUEUE_CONNECTION` | the queue (`QUEUE_CONNECTION=redis`) | [connections and drivers](../queue/README.md#connections-and-drivers) |
| `LIVE_REDIS_CONNECTION` | live hints (`LIVE_DRIVER=redis`) | [configuration](../live/README.md#configuration) |

A driver whose connection name is unknown fails at the start; one whose package is missing says what to install.

## Behaviour you can rely on

- **Fails fast, never hangs a request.** node-redis would retry the first connect forever and queue commands while it is
  down; here the first connect fails at once (`connectTimeout` 5 s) with the URL (password masked) in the message, and while a
  lost connection reconnects (at most every 2 s) commands fail instead of waiting (`disableOfflineQueue`). A request with
  Redis down gets an error (500), not a hang. There is no fallback store — decide per app whether Redis is critical.
- **A missing client is a boot error** with the install command (`RedisSetupError`: "… pnpm add redis") — one line from the
  CLI, no stack trace. An unreachable Redis is noticed by the first command (the queue's worker checks at start).
- **Raw commands only** (`sendCommand`): node-redis' own types never reach the API, so apps without Redis compile, and a new major
  of the client changes one file (`src/connections.ts`). The peer range is `^5 || ^6`.
- **Keys are not prefixed for you** — commands are raw; name them with `connection.key(…)`. The framework's keys:
  `<prefix>cache:…` and `<prefix>lock:…` (cache, locks — a blocking route's `lock:session:<key>` too), `<prefix>session:<key>`
  (sessions: a hash of the payload `d` and its version `v`, written by one Lua script; `<key>` is the SHA-256 of the session id,
  never the id — E144, E145), `<prefix>queues:<queue>[:delayed|:reserved]`
  and the set `<prefix>queues` (queue), `<prefix>live:seq:<channel>` and the pub/sub channel `<prefix>live` (live).
  `cache:clear` deletes only `cache:` keys (`SCAN` + `UNLINK`), never `FLUSHDB`.
- **Readiness (E126):** `RedisHealthCheck` (registered by the provider for `/up/ready`) pings every connection **in use** — one a
  driver or the app asked for with `get()`. A configured connection nothing uses is not checked (`REDIS_URL` has a default; an
  app on the database drivers is not "not ready" for a Redis it never talks to). See [health checks](../core/README.md#health-checks-e126).
- **Time:** Redis TTLs follow Redis' clock, never the app's `Clock` — `app.travel()` in a test does not expire Redis keys.

## Not supported (yet)

Redis Cluster and Sentinel (only `createClient` with a URL; scripts touch several keys without hash tags), blocking pops for
the queue (the worker polls).

## Testing

`docker compose up -d` starts `marmeon-redis` on port 56379; `pnpm test:redis` runs the whole suite with
`MARMEON_TEST_REDIS_URL` — the Redis drivers of cache, locks, sessions, queue and live run against it (and are skipped
without it).
