# @marmeon/redis

Redis connections for Marmeon apps: the driver behind a Redis cache, sessions, queue and live updates. Valkey works the same way.

## Installation

```sh
pnpm add @marmeon/redis
```

The package brings the Redis client, `redis`, as a dependency, so an app installs nothing else. Without it, a Redis driver stops
the start and names this command.

## Choosing Redis

```sh title=".env"
REDIS_URL=redis://127.0.0.1:6379
CACHE_DRIVER=redis
SESSION_DRIVER=redis
QUEUE_DRIVER=redis
LIVE_DRIVER=redis
```

Redis is optional: every package works without it, and `pnpm dev` and `pnpm test` need none.

## Documentation

- [Redis](https://marmeon.com/docs/redis)
- [Redis: which connection a driver uses](https://marmeon.com/docs/redis#which-connection-a-driver-uses)
- [Redis: when Redis is down](https://marmeon.com/docs/redis#when-redis-is-down)
- [Deployment: more than one instance](https://marmeon.com/docs/deployment#more-than-one-instance)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
