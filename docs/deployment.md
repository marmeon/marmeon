# Deployment

## Introduction

A Marmeon app in production is one build and three roles: the web server, `marmeon start`; the queue worker,
`marmeon queue:work`; and the scheduler, `marmeon schedule:work`. Each role runs as a single Node process under a supervisor
that restarts it, each stops gracefully on `SIGTERM`, and each reads its settings from the real environment. The same image or
directory serves all three, started with another command:

```sh
marmeon start           # the web server
marmeon queue:work      # the queue worker
marmeon schedule:work   # the scheduler
```

`marmeon make:docker` writes the files for this: a Dockerfile, a Compose file with the three roles and, on request, a proxy in
front and systemd units for a server without Docker. This page explains those files, what each setting does in production, how
the app stops without dropping requests, and what changes with a proxy or more than one instance. A checklist ends the page.

## The short version

```sh
pnpm marmeon make:docker --caddy
```

This writes `Dockerfile`, `.dockerignore`, `compose.production.yaml` and `deploy/Caddyfile`. Copy the app to the server and put
its settings into `.env.production` next to the files:

```sh title=".env.production"
APP_NAME="My App"
APP_URL=https://example.com
APP_KEY=base64:…
MAIL_MAILER=smtp
MAIL_HOST=smtp.example.com
MAIL_USERNAME=…
MAIL_PASSWORD=…
MAIL_FROM_ADDRESS=hello@example.com
```

Then build the image, create the tables and start the services:

```sh
export APP_DOMAIN=example.com
docker compose -f compose.production.yaml build
docker compose -f compose.production.yaml run --rm web migrate --force
docker compose -f compose.production.yaml up -d
```

Caddy fetches a certificate for `APP_DOMAIN` and passes the requests to the web container. `pnpm marmeon key:generate --show`
prints a fresh key for `APP_KEY`. The files are yours from now on, and `make:docker --force` writes them anew.

## Building and starting

`marmeon build` prepares the app for production. In this order, it:

1. precomputes the injection lists of the app's classes,
2. writes the route types, `bootstrap/routes.ts` (and stops if the app cannot be registered, e.g. two commands with one name),
3. type-checks the app against them, so a renamed route or a missing view fails the build,
4. builds the browser's files into `dist/client/` and the server rendering into `dist/server/`,
5. writes a `.br` and a `.gz` copy next to every script, stylesheet and other text asset that gets smaller by it,
6. writes the list of installed packages, `.marmeon/manifest.json`.

Only `dist/client/assets/` is public. `dist/client/.vite/manifest.json` lists the source path of every page: the server reads it
at start and never serves it, and a CDN in front of the assets gets the `assets/` directory, not `.vite/`.

`--no-typecheck` skips the type check. The build needs no `.env` and no key: it loads the app without booting it, so no secret
can end up in `dist/`. The [configuration](configuration.md#configuration-and-the-build) page explains what that means for a
provider.

`marmeon start` serves the build. It runs with `NODE_ENV=production` unless the environment or `.env` sets another value, and it
never starts Vite, a worker or the scheduler. A `NODE_ENV` other than `development`, `test` or `production` stops it before
anything runs. Its start line names the environment, its `APP_ENV` and what it serves. In production it is the message of a JSON
log entry:

```text
Marmeon in production (APP_ENV=production) on http://localhost:3000 (the build; 54 routes, 7 modules, packages: …)
```

The app stays TypeScript in production. Node strips the types of the app's files, and the packages run their compiled `dist/`.

### One process

`marmeon start` is the server itself, with no launcher in front of it. A supervisor's `SIGTERM`, a worker's exit code and a
`NODE_OPTIONS` setting such as `--import ./bootstrap/telemetry.ts` all reach exactly one Node process.

Node as process 1 of a container ignores a signal it has no handler for yet, and it never reaps an orphaned child. So the image
of `make:docker` runs `marmeon` under `tini`, which passes signals on and ends with `marmeon`'s exit code. Docker's `--init`
and Compose's `init: true` are not needed.

## Roles and processes

| Role | Command | On `SIGTERM` |
| --- | --- | --- |
| web | `marmeon start` | Leaves readiness, answers for `SHUTDOWN_DELAY` seconds, then finishes the requests in flight and the work after them. |
| worker | `marmeon queue:work` | Takes no new job. The running one gets `--stop-timeout` seconds, 10 by default, then it goes back to the queue. |
| scheduler | `marmeon schedule:work` | Starts no new run. Runs still going get `--stop-timeout` seconds, 30 by default. |

Run one role per container, or per systemd unit: the same image, another command. The supervisor restarts each of them when it
ends. A worker ends with
exit code 70 on purpose when a job ignores its timeout, because Node cannot cancel a running promise, and the supervisor brings
a fresh one.

Scale the web role with more containers. Run as many workers as the queue needs, and one scheduler per deployment. With several
schedulers, a task marked `onOneServer()` runs on one of them only, as long as they share a cache.

A worker without `--queue` takes every queue, fairly, so a full `default` queue never holds the auth module's mails back.
`--queue=mail,default` narrows a worker to these queues in strict order, and `*` in the list stands for every queue it does not
name. The [queues](queues.md#which-queues-a-worker-takes) page explains the order.

### Several processes on one machine

On a machine with several cores, `--workers` runs several servers that share one port:

```sh
marmeon start --workers=4
```

The process you started passes `SIGTERM` and `SIGINT` on to each server. Each one drains like a single server, and the process
ends with 0 once all of them ended with 0. A server that ends while the others run is started again after a second. One that
ends before it listened, such as on a taken port, stops all of them with its exit code. `marmeon dev` refuses the option.

The servers share nothing in memory, so they need the same shared drivers as [more than one instance](#more-than-one-instance).
Live updates need `LIVE_DRIVER=redis`: with `memory` the start fails. The warnings of the start are said once, by the process you
started.

## The Docker image

`make:docker` writes the files for the image and for running it:

| Option | Adds |
| --- | --- |
| none | `Dockerfile`, `.dockerignore` and `compose.production.yaml` with the web, worker and scheduler services. |
| `--caddy` | A Caddy service in front, with its `deploy/Caddyfile`. With `--systemd`, the `deploy/Caddyfile` only, for a Caddy on the host. |
| `--nginx` | An nginx service and its `deploy/nginx.conf` instead. With `--systemd`, the `deploy/nginx.conf` only, for an nginx on the host. You provide the certificates, see [nginx](#nginx). |
| `--systemd` | Units for the three roles in `deploy/systemd/`, for running without Docker. A proxy is then for the host. |
| `--force` | Overwrites files that exist. Without it, the command stops. |

`--caddy` and `--nginx` together stop the command: choose one proxy.

The Dockerfile has two stages, both on `node:26-slim`:

1. **build** installs every dependency, runs `marmeon build`, then keeps the production dependencies alone and runs
   `marmeon discover` for exactly these. With a `pnpm-lock.yaml` it installs pnpm at the version `package.json` pins; with a
   `package-lock.json` it uses `npm ci`.
2. **run** copies the app, owned by root and readable for everyone, makes `storage/` the only folder the user `node` may write,
   and sets `NODE_ENV=production`, `HOST=0.0.0.0` and `PORT=3000`. A health check fetches `/up` with Node's own `fetch`.

`marmeon` is a dependency of the app, not a dev dependency, because `start`, `queue:work`, `schedule:work` and `migrate` run on
the server. TypeScript, Vite and pnpm stay in the build stage.

### No `.env` in the image

`.dockerignore` keeps every `.env*` file out of the build. The settings come from the environment when the container runs:
`env_file: .env.production` in Compose, a Kubernetes Secret, or `docker run --env-file`.

> [!WARNING]
> Never deploy a developer's `.env`. Its `NODE_ENV=development` would turn on the error page with source code, the devtools and
> the other development tools. The app logs a loud warning when that happens, but it still starts.

### Storage and a read-only file system

`storage/` is a volume: sessions and cache of the `file` drivers, the files of the local disks, the SQLite database and Node's
compile cache. A container's own files are gone with the container. The first container on a new volume starts a little slower,
and every later one reuses the compile cache.

`marmeon start` keeps the compile cache in `storage/framework/compile-cache/`. Node's own `NODE_COMPILE_CACHE` names another
directory, and `NODE_DISABLE_COMPILE_CACHE=1` turns it off. A directory that cannot be written is no error: the app starts without
the cache.

The image also runs on a read-only root file system, such as `docker run --read-only --tmpfs /tmp -v app-storage:/app/storage`.
The build wrote everything into `.marmeon/` already, so nothing is written next to the code.

## Drivers: what an app installs

A new app needs nothing more for SQLite, files, the database queue and the log mailer. Other drivers need their library:

| For | Install |
| --- | --- |
| Redis for the cache, sessions, the queue or live updates | `pnpm add @marmeon/redis`. It brings the `redis` client. |
| SMTP, `MAIL_MAILER=smtp` | Nothing: `@marmeon/mail` brings `nodemailer`. |
| Postgres, `DB_CONNECTION=pgsql` | `pnpm add pg@^8` |
| An S3 disk | `pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3` |
| Direct uploads to S3 | also `pnpm add @aws-sdk/s3-presigned-post@^3` |
| MJML mail templates | `pnpm add mjml@^5`. A new app has it. |
| OpenTelemetry | `pnpm add @opentelemetry/api@^1.9.0` and an SDK. See [observability](observability.md#installation). |

Install drivers as `dependencies`, not `devDependencies`: the image's production install keeps only those. Where a driver is
surely needed, the start fails and names the command, such as a Redis driver without `@marmeon/redis` or a default disk on S3
without its library. `pg` and an S3 disk the app only names are reported on first use, so the deployment's `migrate --force`
finds a missing `pg` before any request does.

## Configuration

The settings a server needs, beyond those of each feature:

| Variable | Default | Effect |
| --- | --- | --- |
| `NODE_ENV` | `production` in the image | Set it in the real environment. `development`, `test` or `production`; any other value stops the start. |
| `APP_ENV` | `production` | The environment's name: `staging`, `production` or one of your own. Shown in the start line, the logs and the traces, and it selects the scheduled tasks (`.environments('staging')`). It never weakens a protection or enables a development tool. |
| `APP_KEY` | none | The key from `marmeon key:generate --show`. The same on every instance, and a secret. |
| `APP_PREVIOUS_KEYS` | empty | Former keys while you rotate, comma-separated. |
| `APP_URL` | none | `https://…`. Cookies get `Secure` from it unless `SESSION_SECURE_COOKIE` says otherwise, and a protected app on `http://` warns at every start. Browsers ignore the `Clear-Site-Data` of a sign-out outside secure contexts (HTTPS, `http://localhost`), so a server on plain HTTP leaves the browser's storage in place after a sign-out. |
| `HOST` | `127.0.0.1` | `0.0.0.0` in a container or where another machine reaches the app; the default behind a proxy on the same machine. |
| `PORT` | `3000` | `0` takes a free port, and the start line names it. |
| `TRUSTED_PROXIES` | none | The proxy's addresses or ranges. See [proxies](#proxies-and-http2). |
| `SHUTDOWN_DELAY` | `0` | Seconds of requests after `SIGTERM`, at most 300. About 5 behind a load balancer that learns from its probes. |
| `KEEP_ALIVE_TIMEOUT` | `65` | Seconds an idle connection stays open. Longer than the proxy keeps its own. |
| `DB_CONNECTION` | `sqlite` | `pgsql` for Postgres, with `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD`, or the whole address in `DB_URL`, which then wins. See [database](database.md#configuration). |
| `MAIL_MAILER` | `log` | `smtp` in production, with `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD` and `MAIL_FROM_ADDRESS`. |
| `ASSET_VERSION` | the build's | Tabs of an older version load the page fully on their next visit. Set it to the git commit, for example. |

### `HOST`

Without `HOST`, the server listens on `127.0.0.1`: this machine only. The generated image sets `HOST=0.0.0.0`. A platform that
runs `marmeon start` without the generated image (a buildpack), or a load balancer on another host, needs `HOST=0.0.0.0`; the
failure is a refused connection or a failing health check. Behind a proxy on the same machine the default is what you want.

There is a second reason to set it. macOS and some other systems let a server on every interface start beside another program
that already holds the same port on `127.0.0.1` alone. Both run, and requests to `127.0.0.1` reach the other program. The start
checks for this and warns, beginning with `Another program holds 127.0.0.1:3000`. The check runs only when the server listens
on every interface: `0.0.0.0` or `::`. On `127.0.0.1`, the default, a port another program holds there stops the start instead. A program on `::` or `::1` with the same port does not: the start then warns, beginning with `Another program holds [::1]:3000`, and names `127.0.0.1` in the start line, because `localhost` may reach that program.

### Rotating `APP_KEY`

Generate a new key, move the current one into `APP_PREVIOUS_KEYS`, and deploy every instance with both. Sessions, encrypted
cookies and signed links made with the old key keep working. Remove the old key once the longest session or signed link has
expired. Replacing the key without this step signs everybody out and breaks every signed link. The
[encryption](encryption.md#rotating-the-key) page explains the keys.

### Mail

The default `MAIL_MAILER=log` sends nothing. It writes every mail, reset and confirmation links included, into the log, and a
protected app warns about it at every start. Production needs `smtp`, and queued mails then go out through a worker.

SMTP is encrypted or fails: `MAIL_SECURE=true` on port 465, or STARTTLS on the default port 587. `MAIL_REQUIRE_TLS=false` turns
the STARTTLS requirement off. Use it only for a relay without TLS on the same machine.

### Staging

A staging server is a production server with another name. Run it with `NODE_ENV=production` and name it with `APP_ENV`:

```sh title=".env.production"
NODE_ENV=production
APP_ENV=staging
APP_URL=https://staging.example.com
```

It gets every protection of production and the production builds of the framework and of React: a server error reaches the
visitor as the plain error page, and a part of a page that fails after the first part streams in goes to the browser as a short
code, without its message or stack. The development routes answer 404, and `migrate` asks for `--force`. The start line reads
`production (APP_ENV=staging)`, every JSON log entry carries `"appEnv":"staging"`, and every span the framework records carries
`deployment.environment.name`.

`NODE_ENV=staging` does not start: the start error names the two variables to set instead. Build the image once, with the
Dockerfile's `NODE_ENV=production`, and run the same image as staging and as production with a different `APP_ENV`. `marmeon
build` builds the browser's files for production under every `NODE_ENV` but `development`.

## Stopping without dropped requests

On `SIGTERM`, the web server:

1. **Leaves readiness.** `/up/ready` answers `503` with `{"status":"draining"}` at once, while `/up` stays `200`.
2. **Keeps answering for `SHUTDOWN_DELAY` seconds.** Every response carries `Connection: close`, so the client's next request
   opens a new connection, which the load balancer gives to another instance.
3. **Drains.** Live streams end first, and their tabs connect to another server. No new connection is taken, the requests in
   flight finish, and then the work they deferred until after their response, such as a mail. The process exits at the latest
   10 seconds after the delay.

`SIGINT`, such as Ctrl+C, skips the delay. Give the supervisor time for all of it:

| Supervisor | Setting | Its default | The templates |
| --- | --- | --- | --- |
| Docker and Compose | `stop_grace_period`, `docker stop -t` | 10 s | web 20 s, worker 30 s, scheduler 45 s |
| systemd | `TimeoutStopSec` | 90 s | web and worker 30 s, scheduler 45 s |
| Kubernetes | `terminationGracePeriodSeconds` | 30 s | |

The delay exists because a load balancer learns late that an instance stops. Kubernetes removes a terminating pod from its
endpoints at the same moment it sends `SIGTERM`, and the proxies notice a moment later. A load balancer that knows only its
probes needs at least one probe interval. `SHUTDOWN_DELAY=5` covers both, without a `preStop` hook:

```yaml
# Kubernetes: the container of a Deployment
livenessProbe:  { httpGet: { path: /up, port: 3000 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 5 }
env:
  - { name: SHUTDOWN_DELAY, value: '5' }
terminationGracePeriodSeconds: 30   # more than SHUTDOWN_DELAY + 10 s
```

Use the delay or a `preStop` hook, not both.

## Health checks

`GET /up` is the liveness check: `200` once the app booted, `503` while it closes. It checks nothing else, because a database
outage must not get healthy processes restarted. The image's `HEALTHCHECK` uses it. `GET /up/ready` is the readiness check: it
runs every health check of the app and its packages, such as the database and Redis, and answers `200` or `503`.

`HEALTH_PATH` moves both, and `HEALTH_PATH=off` turns them off. The image's `HEALTHCHECK` follows `PORT` and `HEALTH_PATH`. With
`HEALTH_PATH=off`, it checks nothing and the web container counts as healthy; your orchestrator then needs another way to see the
app. Worker and scheduler containers have no HTTP server, so the Compose file turns their health check
off. The [health checks](health.md) page explains both endpoints and your own checks.

## Proxies and HTTP/2

### Live updates need HTTP/2

A live stream holds a connection open for each tab. Over HTTP/1.1 a browser opens at most 6 connections per host, across all
its tabs, so a seventh tab with a stream would hang every further request. The client notices HTTP/1.1 and keeps a stream only
while its tab is visible. Over HTTP/2 every tab keeps its stream.

Terminate TLS with HTTP/2 at the proxy. The app itself speaks HTTP/1.1 to the proxy, which is fine. The
[real-time updates](realtime.md#behind-a-proxy) page covers the streams.

### Caddy

`--caddy` is the recommended proxy. Caddy fetches its certificates, speaks HTTP/1.1, HTTP/2 and HTTP/3, and passes event streams
on without buffering them. It sets `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` itself and drops a client's own,
unless you configure `trusted_proxies` in Caddy.

### nginx

nginx needs your certificates. Put `fullchain.pem` and `privkey.pem` into `deploy/certs/`, which Compose mounts into the nginx
container, and replace `example.com` in `deploy/nginx.conf` with your domain: it is the `server_name` of both server blocks. With
`--systemd`, nginx runs on the host and the configuration points to the certificates of certbot instead.

The template turns `http2 on`, sets the forwarded headers itself instead of passing a client's on, and waits up to 75 seconds
between two reads of a response, longer than the live heartbeat of 20 seconds. The app turns nginx's buffering off for each live
stream with `X-Accel-Buffering: no`.

### Keep-alive to the app

A proxy that reuses its connections to the app must close an idle one before the app does. Otherwise it now and then sends a
request on a connection the app is just closing, and the browser gets a `502`. The app keeps an idle connection for
`KEEP_ALIVE_TIMEOUT` seconds, 65 by default. The nginx template keeps up to 16 idle connections and closes them after 60
seconds, and an AWS load balancer also closes after 60. Behind a proxy that keeps them longer, such as Google's load balancer
with 600 seconds, set `KEEP_ALIVE_TIMEOUT=620`.

### Other proxies

Check that a proxy speaks HTTP/2 to the browser and passes responses on without buffering them. Some proxies buffer by default
or end a response after a fixed time, so test live updates behind them before you rely on them. A proxy that probes the app
should probe `/up/ready` when you set `SHUTDOWN_DELAY`, so it notices a stopping instance.

### Trusted proxies

By default, the app believes no `X-Forwarded-*` header. The client's address is the peer's, and the URL is what the peer asked
for. `TRUSTED_PROXIES` names the proxies whose headers count: then the client's address in rate limits and logs comes from
`X-Forwarded-For`, and the request's URL takes its scheme and host from `X-Forwarded-Proto` and `X-Forwarded-Host`. The CSRF
check compares a form's origin with that URL.

| Where the proxy is | `TRUSTED_PROXIES` |
| --- | --- |
| Caddy in the same Compose network, the web container publishes no port | `*`, as the template sets it |
| On the same machine | `127.0.0.1` |
| An ingress in a cluster | its range, such as `10.0.0.0/8` |
| A CDN in front of nginx | both ranges. With `*`, the app would take the CDN's address for the client's. |

`*` trusts the direct peer only: whoever connects is the proxy, and the client's address is the last entry that proxy added.
A value that is no address, range or `*` stops the start.

> [!WARNING]
> Never set `TRUSTED_PROXIES=*` on a port anybody can reach: every client would then be the trusted proxy, and could choose its
> own address and the URL the app sees. Let the proxy set the forwarded headers rather than pass on a client's.

### Compression

`marmeon build` compresses the assets once, and the server sends the `.br` or `.gz` copy with a cache time of a year. Pages and
JSON are not compressed. A compressed response that carries a secret, such as the CSRF token, next to text an attacker controls
leaks the secret byte by byte. Leave the proxy's compression off for them too. The templates do.

## Traces

With [OpenTelemetry](observability.md#a-callers-traceparent), every request from outside starts a trace of its own, and a caller's
`traceparent` header becomes a link of it. Anyone can send that header, so taking it as the parent would let a client choose the
trace its requests land in. Set `OTEL_TRUST_TRACEPARENT=true` only behind an edge that sets or strips the header itself, such as
an API gateway or a service mesh. A trusted proxy is no such edge by itself: Caddy and nginx pass the header on.

## More than one instance

With more than one web container, `--workers`, or containers on more than one machine, everything shared must live in a shared
store:

| What | Not | Use |
| --- | --- | --- |
| Sessions, `SESSION_DRIVER` | `memory`, or `file` across machines | `redis`, `database` |
| Cache, rate limits and locks, `CACHE_DRIVER` | `memory`, or `file` across machines | `redis`, `database` |
| Queue, `QUEUE_CONNECTION` | `sync` for real work, or `database` on SQLite across machines | `redis`, or `database` on Postgres |
| Live updates, `LIVE_DRIVER` | `memory` | `redis` |
| Database | SQLite across machines | Postgres |
| Uploads and files | the local disks across machines | an S3 disk |

On one machine, the Compose file shares one `storage` volume between web, worker and scheduler, so SQLite and the `file` drivers
work there. Limits on live streams count per process: with four servers, a session may hold its limit of streams in each.

## Without Docker: systemd

`pnpm marmeon make:docker --systemd` writes `deploy/systemd/web.service`, `worker.service` and `scheduler.service`. They expect
the app in `/srv/<name>`, run it as the user `<name>`, and read its settings from `/etc/<name>/env`, a file with mode `600`.
Copy them to `/etc/systemd/system/<name>-web.service`, `<name>-worker.service` and `<name>-scheduler.service`.

Build where the app runs, or copy a build there:

```sh
pnpm install --frozen-lockfile
pnpm marmeon build
pnpm install --prod --frozen-lockfile
pnpm marmeon discover
systemctl restart <name>-web <name>-worker <name>-scheduler
```

The units restart always, a worker's exit code 70 included, and give each role 30 seconds to stop. They protect the system: the
app's folder is read-only except `storage/`. The web server listens on `127.0.0.1` and trusts the proxy on the same machine.
Node must be on the service's `PATH`, so install it as a system package rather than through a version manager.

## One server with Compose

A single server with Docker Compose is enough for many apps. A few things matter there beyond the template:

- **A firewall in front of the server, not on it.** Docker publishes ports through its own packet filter rules, past `ufw` and
  `firewalld`, so a firewall on the host does not protect a published port. Use your provider's firewall, and let in SSH, 80,
  443 over TCP and 443 over UDP for HTTP/3.
- **IPv6 on the Compose network.** Without it, Docker hands a visitor's IPv6 connection to Caddy through a proxy process of its
  own, and every IPv6 visitor arrives with the same address, which then shares one rate limit.
- **Explicit ranges instead of `*`.** Give the Compose network fixed subnets and list them in `TRUSTED_PROXIES`.
- **A tag per build.** Name each image after its commit, so an earlier version starts again without a build.

## Checklist

- `NODE_ENV=production` in the real environment, and no developer's `.env` on the server.
- `APP_KEY` set, and the same on every instance. `APP_URL` starts with `https://`.
- `marmeon migrate --force` once per deployment, for example in a one-off container.
- The proxy speaks HTTP/2 to browsers, does not buffer event streams and sets `X-Forwarded-*`. `TRUSTED_PROXIES` names it.
- `HOST=0.0.0.0` where another machine reaches the app directly. `KEEP_ALIVE_TIMEOUT` above the proxy's idle timeout to the app.
- `MAIL_MAILER=smtp`.
- Web, worker and scheduler each under a supervisor that restarts them, with grace periods longer than the drain.
- A worker takes every queue the app uses: one without `--queue` does, and a `--queue` list names every queue or holds a `*`.
- The drivers the settings name are installed as `dependencies`.
- Staging is not public and holds no real data, because it shows server errors.
- HSTS once the site answers over HTTPS only: the switch in `middleware/SecurityHeaders.ts`.
- `SHUTDOWN_DELAY` of about 5 behind a probing load balancer or in Kubernetes.
- More than one instance or `--workers`: shared drivers for sessions, cache, queue, live updates and files, and Postgres instead
  of SQLite.
- `storage/` on a volume.

The [security](security.md#your-checklist) page has the rest of the list.
