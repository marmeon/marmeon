# Health Checks

## Introduction

A load balancer or an orchestrator asks each instance of your app two questions: is the process alive, and may it get requests?
The app answers them on two endpoints, without any code of yours:

| Endpoint | Question | Answer |
| --- | --- | --- |
| `GET /up` | Liveness: is the process alive? | `200 OK` once the app booted. `503` once the server closes. |
| `GET /up/ready` | Readiness: can it serve? | `200 {"status":"ok"}` when every health check passes, else `503 {"status":"failing"}`. |

Readiness runs the health checks of the packages, such as the database and Redis, and your own. A check is a class with a name
and a `handle()` that throws when something is wrong:

```ts title="modules/system/health/StorageWritable.ts"
import type { HealthCheck } from '@marmeon/core';
import { Storage } from '@marmeon/storage';

export class StorageWritable implements HealthCheck {
  static check = 'storage';

  readonly #storage: Storage;

  constructor(storage: Storage) {
    this.#storage = storage;
  }

  async handle(): Promise<string> {
    const disk = this.#storage.disk('local');
    const key = `.health/${crypto.randomUUID()}`;
    await disk.put(key, 'ok');
    await disk.delete(key);
    return 'local';
  }
}
```

A full or read-only disk now makes `/up/ready` answer `503`, and the load balancer sends no more requests to this instance.

## Liveness and readiness

The two endpoints answer different questions on purpose:

- **`/up` checks nothing but the process.** A database outage must not get a healthy process restarted: a new process would not
  reach the database either. Point the orchestrator's liveness probe and Docker's `HEALTHCHECK` here.
- **`/up/ready` checks what the instance depends on.** When it fails, the instance stays up and gets no traffic until it passes
  again. Point the load balancer's health check and the readiness probe here.

`marmeon check` runs the same readiness checks as its `readiness` check; in CI without the services, pass `--skip=readiness` (on Postgres `--skip=readiness,db-types`, which also needs the server) and give it the app's `.env`. See [checking an app](check.md#the-app-checks).

```yaml
# Kubernetes
livenessProbe: { httpGet: { path: /up, port: 3000 } }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 5 }
env: [{ name: SHUTDOWN_DELAY, value: '5' }]
```

Both endpoints answer before anything else runs for a request: no middleware group, no session, no cookie, no CSRF check, no
request id and no log line. They are never recorded by the devtools nor traced by OpenTelemetry, so a probe every few seconds
fills neither. Every answer is `Cache-Control: no-store`, and `HEAD` works too.

## Writing a health check

A health check is an invokable class:

- `static check` is its name, which the development details show. Two checks with one name stop the start.
- `handle()` throws or rejects when the check fails. What it returns, a short note such as `local`, shows in the development
  details.
- Its dependencies arrive through the constructor, built in a scope of its own for each run.
- `static timeout` gives it more or less than the default of 2 seconds, in milliseconds. A check that takes longer fails as
  `timeout`.

A class without `static check` or without `handle()` does not compile where it is listed:

```text
Type 'typeof DiskSpace' is not assignable to type 'HealthCheckClass'.
  Property 'check' is missing in type 'typeof DiskSpace' but required in type '{ readonly check: string; readonly timeout?: number | undefined; }'.
```

A module lists its checks in its definition, and the app can list more in `bootstrap/app.ts` with `defineApplication({ health })`:

```ts title="modules/system/index.ts"
import { defineModule } from '@marmeon/core';
import { StorageWritable } from './health/StorageWritable.ts';

export default defineModule({
  name: 'system',
  health: [StorageWritable],
});
```

A package lists its checks as `static health` on its provider. The [package
development](package-development.md#the-service-provider) page shows it.

Keep a check cheap and about this instance: can it reach what it needs right now. A check of another service that is down for
every instance takes every instance out of the load balancer at once, which turns a partial outage into a full one.

## The checks of the packages

| Check | Package | What it does | Its note |
| --- | --- | --- | --- |
| `database` | `@marmeon/database` | `select 1` on every connection the app uses, through the pools requests use: `default`, the ones the cache, the sessions, the queue and notifications keep their tables on, and any other a query used. A connection nothing uses is never opened. | The connections' names. |
| `redis` | `@marmeon/redis` | `PING` on every Redis connection a driver uses. A configured connection nothing uses is not checked. | The connections, or `no connection in use`. |
| `cache` | `@marmeon/cache` | Adds a key and removes it again, through the configured store. | The driver. |
| `queue` | `@marmeon/queue` | Reads the size of the default connection's default queue. | The connection and how many jobs wait. |

The `database` check asks the connections the process has used so far. The packages' connections count from the start: the cache,
the sessions, the queue and notifications check theirs while the app boots. A connection that only a controller reaches counts from
its first query in this process. Until then a fresh instance answers ready while that database is down.

A check that fails names what failed, such as the database connection, in the development details.

## What the answer shows

In development, `/up/ready` lists every check with its status, its time in milliseconds, its note and its error:

```json
{
  "status": "ok",
  "checks": [
    { "name": "database", "status": "ok", "ms": 0.41, "note": "default" },
    { "name": "redis", "status": "ok", "ms": 0.02, "note": "no connection in use" },
    { "name": "cache", "status": "ok", "ms": 0.11, "note": "memory" },
    { "name": "queue", "status": "ok", "ms": 0.35, "note": "database, 0 waiting" },
    { "name": "storage", "status": "ok", "ms": 0.9, "note": "local" }
  ]
}
```

Notes and errors pass the app's redactor first. Everywhere else, the answer is the status only: what an app depends on, and how it
fails, is nobody's business outside.

## One run a second

The path is public, so anyone can send probes. The checks run at once, each with its own time limit, and their result answers
every probe for one second after it, failing results too. Probes that arrive while the checks run share that run. A flood of
probes therefore costs one run a second, not one per probe.

## During a deployment

When the server gets `SIGTERM`, readiness falls first:

1. `/up/ready` answers `503 {"status":"draining"}` at once. The cached result of a moment ago does not count.
2. `/up` stays `200`, and the server keeps answering requests for `SHUTDOWN_DELAY` seconds, so the load balancer has time to
   notice and send new requests elsewhere.
3. Then the server closes. Both endpoints answer `503` on connections that are still open, while the requests in flight finish
   and the work after their responses drains.

`SHUTDOWN_DELAY` is `0` by default. Set it, `5` is typical, behind a load balancer that learns about a stopping instance only from
its probes. The [deployment](deployment.md#health-checks) page shows the image's health check.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `HEALTH_PATH` | `/up` | Where liveness answers. Readiness answers below it: `HEALTH_PATH=/healthz` gives `/healthz` and `/healthz/ready`. `off` turns both off, and the image's `HEALTHCHECK` then checks nothing. |
| `SHUTDOWN_DELAY` | `0` | Seconds the server keeps answering after `SIGTERM`, while readiness already fails. At most 300. |

A route of the app on one of the two paths could never be reached, so it stops the start:

```text
The route "status" (GET /up) is where the health check answers — it would never be reached. Give the route another path, or move the health check: HEALTH_PATH=/healthz (or HEALTH_PATH=off).
```

A route with a parameter, such as `/:page`, never sees `up`, and needs no change.

## Testing

A test app answers the endpoints like the server. `debug: true` adds the details of each check:

```ts title="modules/system/health.test.ts"
import { Connections } from '@marmeon/database';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('runs the storage check', async () => {
  const app = await createTestApp(application, { database: 'refresh', debug: true });
  const ready = await app.get('/up/ready').assertOk().assertJson({ status: 'ok' });
  expect(ready.json<{ checks: { name: string }[] }>().checks.map((check) => check.name)).toContain('storage');
});

it('is not ready without its database, and still alive', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  await app.make(Connections).destroy();
  await app.get('/up/ready').assertStatus(503).assertExactJson({ status: 'failing' });
  await app.get('/up').assertOk();
});
```

The result of a run answers for a second by the app's clock, so a test that asks twice moves the clock in between with
`app.travel({ seconds: 2 })`.
