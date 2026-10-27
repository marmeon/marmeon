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
MAIL_DRIVER=smtp
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
3. writes the schema the migrations describe, `.marmeon/schema.json` (and stops if a migration's plan cannot be projected, e.g. two migrations creating one table),
4. type-checks the app against them, so a renamed route or a missing view fails the build,
5. builds the browser's files into `dist/client/` and the server rendering into `dist/server/`,
6. writes a `.br` and a `.gz` copy next to every script, stylesheet and other text asset that gets smaller by it,
7. writes the list of installed packages, `.marmeon/manifest.json`.

`marmeon build` also warns about every import of a framework internal (`@marmeon/*/internal`) in your code, and builds anyway; [`marmeon check`](check.md#imports-of-framework-internals) fails on them.

`.marmeon/schema.json` holds the projection of all migration files with the SHA-256 of each and the version of `@marmeon/database`. The build
always computes it from the migrations, whatever file is there, and writes it over; a directory that cannot be written is no failure. Code that
asks the migrator for the projection uses the file only if every migration file is the one it was computed from, and otherwise computes it
itself. See [What the migrations describe](migrations.md#what-the-migrations-describe).

Only `dist/client/assets/` is public. `dist/client/.vite/manifest.json` lists the source path of every page: the server reads it
at start and never serves it, and a CDN in front of the assets gets the `assets/` directory, not `.vite/`.

`--no-typecheck` skips the type check. The build needs no `.env` and no key: it loads the app without booting it, so no secret
can end up in `dist/`. The [configuration](configuration.md#configuration-and-the-build) page explains what that means for a
provider.

`marmeon start` serves the build. It runs with `NODE_ENV=production` unless the environment sets another value, and it
never starts Vite, a worker or the scheduler. A `NODE_ENV` other than `development`, `test` or `production` stops it before
anything runs. Its start line names the environment, its `APP_ENV` and what it serves. In production it is the message of a JSON
log entry:

```text
Marmeon in production (APP_ENV=production) on http://localhost:3000 (the build; 54 routes, 7 modules, packages: …)
```

A `NODE_ENV=development` or `NODE_ENV=test` that comes from `.env` alone is for `marmeon dev`, and `marmeon start` and `marmeon serve`
refuse it with `marmeon start runs in production`: the build is the production server, wherever it runs. To try the build on your
machine run `NODE_ENV=production marmeon start`; `.env.production` is read then, besides `.env`.

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
| web | `marmeon start` | Leaves readiness, answers for the seconds in `SERVER_SHUTDOWN_DELAY_SECONDS`, then finishes the requests in flight and the work after them. |
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
> the other development tools. `marmeon start` refuses to run when `development` or `test` comes from `.env` alone; the
> worker and the scheduler log a loud warning but still start.

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
| SMTP, `MAIL_DRIVER=smtp` | Nothing: `@marmeon/mail` brings `nodemailer`. |
| Postgres, `DB_DRIVER=pgsql` | `pnpm add pg@^8` |
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
| `SERVER_TRUSTED_PROXIES` | none | The proxy's addresses or ranges. See [proxies](#proxies-and-http2). |
| `SERVER_SHUTDOWN_DELAY_SECONDS` | `0` | Seconds of requests after `SIGTERM`, at most 300. About 5 behind a load balancer that learns from its probes. |
| `SERVER_KEEP_ALIVE_TIMEOUT_SECONDS` | `65` | Seconds an idle connection stays open. Longer than the proxy keeps its own. |
| `DB_DRIVER` | `sqlite` | `pgsql` for Postgres, with `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD`, or the whole address in `DB_URL`, which then wins. See [database](database.md#configuration). |
| `MAIL_DRIVER` | `log` | `smtp` in production, with `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD` and `MAIL_FROM_ADDRESS`. |
| `SERVER_ASSET_VERSION` | the build's | Tabs of an older version load the page fully on their next visit. Set it to the git commit, for example. |

### `HOST`

Without `HOST`, the server listens on `127.0.0.1`: this machine only. The generated image sets `HOST=0.0.0.0`. A platform that
runs `marmeon start` without the generated image (a buildpack), or a load balancer on another host, needs `HOST=0.0.0.0`; the
failure is a refused connection or a failing health check. Behind a proxy on the same machine the default is what you want.

There is a second reason to set it. macOS and some other systems let a server on every interface start beside another program
that already holds the same port on `127.0.0.1` alone. Both run, and requests to `127.0.0.1` reach the other program. The start
checks for this and warns, beginning with `Another program holds 127.0.0.1:3000`. The check runs only when the server listens
on every interface: `0.0.0.0` or `::`. On `127.0.0.1`, the default, a port another program holds there stops the start instead. A program on `::` or `::1` with the same port does not: the start then warns, beginning with `Another program holds [::1]:3000`, and names `127.0.0.1` in the start line, because `localhost` may reach that program.

### Rotating `APP_KEY`

Generate a new key, move the current one into `APP_PREVIOUS_KEYS`, and deploy every instance with both. On more than one server,
rotate in two deploys: first add the new key to `APP_PREVIOUS_KEYS` everywhere, then make it `APP_KEY`. Sessions, encrypted
cookies and signed links made with the old key keep working. Remove the old key once the longest session or signed link has
expired, queued and failed jobs are gone, and the two-factor secrets are encrypted again (at their next use; a warning names a user
whose secret is still under a removed key). Replacing the key without this step signs everybody out and breaks every signed link. The
[encryption](encryption.md#rotating-the-key) page explains the keys.

### Mail

The default `MAIL_DRIVER=log` sends nothing. It writes every mail, reset and confirmation links included, into the log, and a
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
2. **Keeps answering for the seconds in `SERVER_SHUTDOWN_DELAY_SECONDS`.** Every response carries `Connection: close`, so the client's next request
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
probes needs at least one probe interval. `SERVER_SHUTDOWN_DELAY_SECONDS=5` covers both, without a `preStop` hook:

```yaml
# Kubernetes: the container of a Deployment
livenessProbe:  { httpGet: { path: /up, port: 3000 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 5 }
env:
  - { name: SERVER_SHUTDOWN_DELAY_SECONDS, value: '5' }
terminationGracePeriodSeconds: 30   # more than SERVER_SHUTDOWN_DELAY_SECONDS + 10 s
```

Use the delay or a `preStop` hook, not both.

## Health checks

`GET /up` is the liveness check: `200` once the app booted, `503` while it closes. It checks nothing else, because a database
outage must not get healthy processes restarted. The image's `HEALTHCHECK` uses it. `GET /up/ready` is the readiness check: it
runs every health check of the app and its packages, such as the database and Redis, and answers `200` or `503`.

`SERVER_HEALTH_PATH` moves both, and `SERVER_HEALTH_PATH=off` turns them off. The image's `HEALTHCHECK` follows `PORT` and `SERVER_HEALTH_PATH`. With
`SERVER_HEALTH_PATH=off`, it checks nothing and the web container counts as healthy; your orchestrator then needs another way to see the
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
`SERVER_KEEP_ALIVE_TIMEOUT_SECONDS`, 65 by default. The nginx template keeps up to 16 idle connections and closes them after 60
seconds, and an AWS load balancer also closes after 60. Behind a proxy that keeps them longer, such as Google's load balancer
with 600 seconds, set `SERVER_KEEP_ALIVE_TIMEOUT_SECONDS=620`.

### Other proxies

Check that a proxy speaks HTTP/2 to the browser and passes responses on without buffering them. Some proxies buffer by default
or end a response after a fixed time, so test live updates behind them before you rely on them. A proxy that probes the app
should probe `/up/ready` when you set `SERVER_SHUTDOWN_DELAY_SECONDS`, so it notices a stopping instance.

### Trusted proxies

By default, the app believes no `X-Forwarded-*` header. The client's address is the peer's, and the URL is what the peer asked
for. `SERVER_TRUSTED_PROXIES` names the proxies whose headers count: then the client's address in rate limits and logs comes from
`X-Forwarded-For`, and the request's URL takes its scheme and host from `X-Forwarded-Proto` and `X-Forwarded-Host`. The CSRF
check compares a form's origin with that URL.

The peer's address is the socket's. An adapter that runs the kernel outside `startServer()` passes it as
`kernel.fetch(request, { remoteAddress })`, taken from the socket and never from a header.

| Where the proxy is | `SERVER_TRUSTED_PROXIES` |
| --- | --- |
| Caddy in the same Compose network, the web container publishes no port | `*`, as the template sets it |
| On the same machine | `127.0.0.1` |
| An ingress in a cluster | its range, such as `10.0.0.0/8` |
| A CDN in front of nginx | both ranges. With `*`, the app would take the CDN's address for the client's. |

`*` trusts the direct peer only: whoever connects is the proxy, and the client's address is the last entry that proxy added.
A value that is no address, range or `*` stops the start, and so does a range of every address (`0.0.0.0/0`, `::/0`, or
`::ffff:0.0.0.0/96`, which holds all of IPv4): write `*` if every peer is your proxy.

> [!WARNING]
> Never set `SERVER_TRUSTED_PROXIES=*` on a port anybody can reach: every client would then be the trusted proxy, and could choose its
> own address and the URL the app sees. Let the proxy set the forwarded headers rather than pass on a client's.

### Compression

`marmeon build` compresses the assets once, and the server sends the `.br` or `.gz` copy with a cache time of a year. Pages and
JSON are not compressed. A compressed response that carries a secret, such as the CSRF token, next to text an attacker controls
leaks the secret byte by byte. Leave the proxy's compression off for them too. The templates do.

## Traces

With [OpenTelemetry](observability.md#a-callers-traceparent), every request from outside starts a trace of its own, and a caller's
`traceparent` header becomes a link of it. Anyone can send that header, so taking it as the parent would let a client choose the
trace its requests land in. Set `MARMEON_OTEL_TRUST_TRACEPARENT=true` only behind an edge that sets or strips the header itself, such as
an API gateway or a service mesh. A trusted proxy is no such edge by itself: Caddy and nginx pass the header on.

## More than one instance

With more than one web container, `--workers`, or containers on more than one machine, everything shared must live in a shared
store:

| What | Not | Use |
| --- | --- | --- |
| Sessions, `SESSION_DRIVER` | `memory`, or `file` across machines | `redis`, `database` |
| Cache, rate limits and locks, `CACHE_DRIVER` | `memory`, or `file` across machines | `redis`, `database` |
| Queue, `QUEUE_DRIVER` | `sync` for real work, or `database` on SQLite across machines | `redis`, or `database` on Postgres |
| Live updates, `LIVE_DRIVER` | `memory` | `redis` |
| Database | SQLite across machines | Postgres |
| Uploads and files | the local disks across machines | an S3 disk |

Jobs that wait while you deploy are held, not lost: a worker puts back a job it cannot read yet, and a newer worker takes it.
[Deploying while jobs wait](queues.md#deploying-while-jobs-wait) says how long and what to watch.

On one machine, the Compose file shares one `storage` volume between web, worker and scheduler, so SQLite and the `file` drivers
work there. Limits on live streams count per process: with four servers, a session may hold its limit of streams in each.

## A mixed fleet during a deploy

While a rolling deploy replaces the instances, a tab can reach an instance of another build than the one that served its page.
Two checks answer such a request with `409` and the URL to load, and the tab then loads that URL as a whole document from whichever
instance the proxy picks:

- **The protocol version.** Every request of the client carries `x-marmeon: 1`. An instance that does not speak that version
  refuses the request before any middleware or controller runs, whatever the method, a form post and an action included. This
  matters only while the version differs between the builds, which it does when a release changes the page protocol.
- **The asset version.** A visit (a `GET`) of a tab that runs other JavaScript than the instance serves gets the same answer, since
  the old chunks may be gone. A form post is never refused for this alone, so a user does not lose a form because of a new build.

The `409` is `no-store` and varies on `x-marmeon`, so a cache in front of the app keeps neither. A tab with unsaved changes asks
before it loads; one that sent a form, an action or a live validation loses what it typed and had not sent. A client that is not
the app's own and sends `x-marmeon` headers by hand has to send the version too. See
[a tab of another protocol version](navigation.md#a-tab-of-another-protocol-version).

Nothing in the proxy needs to change: no sticky sessions, no routing by version. The framework sets no `Cache-Control` on a
document, so the browser asks again. A page the app caches publicly (`max-age`) can still be served from the browser's cache
after the reload, with the old build's script names; keep such caches short, or send `no-cache` on documents.

Sessions are marked with the format they were written in ([What a session stores](session.md#what-a-session-stores)). While two
versions of your app run side by side, a session written by the newer one is a guest's to the older one, which leaves it as it
is. After the upgrade from a release that did not mark sessions, every user is signed out once: sessions of the old release carry
no format and are dropped. That upgrade is [not a rolling one](#the-upgrade-that-stops-every-process).

While traffic moves between old and new nodes during a rollout, every visit on an old node is a remember-me sign-in for a user who
has the cookie: the token rotates and a `SignedIn` event fires. Users without remember-me are guests there.

### What else a mixed fleet does

Every stored format carries a mark, and a node reads only the versions it knows ([the list](releases.md#stored-and-wire-formats)).
With old and new nodes side by side, from the release that marks them on:

- **Jobs** that an older worker cannot read (a newer record, a job it does not have, a payload its schema rejects) are put back with
  their attempt given back and run on a newer worker. After six hours they fail with the reason and leave the queue. Keep a worker of the newer release
  running until the queue has drained ([deploying while jobs wait](queues.md#deploying-while-jobs-wait)). A queued listener is found
  by its `static listener` name, so renaming its class changes nothing for jobs that wait.
- **Live streams** open with a version in the query. A tab of the release before sends none and gets `204`: it stops its live updates
  until its next visit reloads it ([a stream of another version](realtime.md#a-stream-of-another-version)).
- **Live hints** between nodes carry a version. Hints published by a node of the release before are ignored by a new one, and the
  other way round, so during the rollout a hint can miss tabs on the other side (a tab catches up when its stream reconnects). An end
  that is lost is bounded by `LIVE_MAX_STREAM_SECONDS`.
- **The database** is shared, and a release that changes a table changes it for every node. Run `marmeon migrate --force` first, then
  roll the nodes. A migration that drops or renames a column or table breaks the previous release's `selectAll()`, `returningAll()`,
  relations and finders on that table for the rollout: stop its processes before `migrate`
  ([deploying new migrations](migrations.md#deploying-new-migrations)). A node whose code has migrations the database lacks (it started before
  `marmeon migrate` finished) fails every query and fails readiness until they ran, within a second of it. An older node that finds more
  migrations in the database than its code has keeps running with the schema it knows: its `selectAll()` names only the columns it knows
  and hides the secret ones it knows ([how the migrator keeps track](migrations.md#how-the-migrator-keeps-track)). Update a node
  whose record of migrations is newer than it reads: it fails every query and fails readiness. Two nodes that run
  `marmeon migrate` at once are safe: one waits for the other ([one migration at a time](migrations.md#one-migration-at-a-time)).

A release that changes a format after 1.0 writes the new version only once the readers of the release before read it
([the rules](releases.md#stored-and-wire-formats)). Until then, read the [upgrade guide](../UPGRADING.md) of a release before you roll it.

## The upgrade that stops every process

The first release that marks the formats above cannot run next to the one before it: it renames the cookies, changes the form of API tokens and
reads no record of the old release. Upgrade to it with every process of the old release stopped.
The steps below are the order; the [upgrade guide](../UPGRADING.md) names the version.

1. **Before, while the old release runs.**
   - Plan to issue every API token again, and tell whoever uses one (integrations, scripts, clients).
   - Let the queue run empty: `marmeon queue:work --stop-when-empty`, then `marmeon queue:size` shows 0 for every queue, delayed jobs
     included. Look at `marmeon queue:failed`, and retry or give up what is in it.
   - Tell your users that they sign in again, and pick a quiet hour.
2. **In development.** Run `marmeon db:types` and `marmeon route:types`, and commit what they write. An app from 0.3 has no automatic way to the tables of the starter kit and to `sign_ins`; see the [upgrade guide](../UPGRADING.md). With a user table of your own, fill its `NULL` session keys with random values in a migration of your own. A database with tables of its
   own that never ran `marmeon migrate` keeps them: `migrate` writes its record of migrations and runs the migrations, and the
   tables it did not make stay unknown to Marmeon, unguarded ([how the app knows its schema](migrations.md#how-the-app-knows-its-schema)).
3. **Stop every process of the old release**, on every machine: web, workers, the scheduler, cron jobs, and every CI or release job
   that runs `marmeon`. None of them may run after step 4 begins.
4. **Deploy the new release, run `marmeon migrate --force`, then
   [`marmeon auth:end-all-sessions --force --keep-reset-tokens`](authentication.md#ending-every-session-of-every-account), then start
   it.** `migrate` runs the migrations of your app. The second command deletes the
   sign-ins (and with them the remember-me tokens), revokes the API tokens that are left and rotates the session keys, so nothing of the old
   release signs anyone in. It needs `UserProvider.updateEverySessionKey()`, which the starter kit's provider has; a provider of your
   own implements it first ([for your own user provider](authentication.md#for-your-own-user-provider)). Without `--keep-reset-tokens` it deletes the reset links too. `/up/ready` turns green when the tables and
   their columns are as the code needs them, and says what is missing when they are not ([health checks](health.md#liveness-and-readiness)).
5. **After the start.** Issue the API tokens again and hand them out.

**What is lost.**

- Every sign-in and every "keep me signed in" token: `auth:end-all-sessions` deletes the sign-ins, and the remember-me tokens live on
  those rows. Sessions of the old release carry no format and are dropped, and the cookies of the old release have other names
  ([the `__Host-` prefix](session.md#the-__host--prefix)), so remember-me signs nobody in. Users sign in again, with their second
  factor where they have one.
- Every API token. Their form is no longer valid, no code reads it, and `auth:end-all-sessions` revokes them
  ([API tokens](api-tokens.md#the-token-format)).
- What an open tab had typed and not sent. A tab of the old release gets the `409` on its next request and loads the page anew.
- Jobs of the old release that did not run, queued listeners included. Delayed ones fail as soon as they are due. Each fails with
  its reason, its payload stays readable in `queue:failed`, and none can be retried. Jobs that had failed before stay there and cannot
  be retried either.

**What stays.** Every other table with its rows: users, passwords, second factors and recovery codes, passkeys, reset links (with `--keep-reset-tokens`), uploads,
notifications and the cache. The sign-in rows are deleted.

A process of the old release that you forgot keeps running against the database, with the secret columns its own tables
(`table_owners`, `secret_columns`, `schema_markers`, which `migrate` leaves in place) name: a column that a new migration marks
`.secret()` is not hidden from it. Drop those three tables by hand once no process of the old release runs
([the three tables](migrations.md#how-the-migrator-keeps-track)). **Redis notices nothing.**
Queue, sessions, cache and live updates on Redis are shared by a forgotten old process and a new one without any error, so step 3
means every process.

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
- **Explicit ranges instead of `*`.** Give the Compose network fixed subnets and list them in `SERVER_TRUSTED_PROXIES`.
- **A tag per build.** Name each image after its commit, so an earlier version starts again without a build.

## Checklist

- `NODE_ENV=production` in the real environment, and no developer's `.env` on the server (`marmeon start` refuses a `NODE_ENV=development` that comes from `.env`).
- `APP_KEY` set, and the same on every instance. `APP_URL` starts with `https://`.
- `marmeon migrate --force` once per deployment, for example in a one-off container. The release that first marks the stored
  formats needs [every old process stopped](#the-upgrade-that-stops-every-process) first.
- The proxy speaks HTTP/2 to browsers, does not buffer event streams and sets `X-Forwarded-*`. `SERVER_TRUSTED_PROXIES` names it.
- `HOST=0.0.0.0` where another machine reaches the app directly. `SERVER_KEEP_ALIVE_TIMEOUT_SECONDS` above the proxy's idle timeout to the app.
- `MAIL_DRIVER=smtp`.
- Web, worker and scheduler each under a supervisor that restarts them, with grace periods longer than the drain.
- A worker takes every queue the app uses: one without `--queue` does, and a `--queue` list names every queue or holds a `*`.
- The drivers the settings name are installed as `dependencies`.
- Staging is not public and holds no real data, because it shows server errors.
- HSTS once the site answers over HTTPS only: the `hsts` option of `securityHeaders()` in `bootstrap/app.ts`. Before going live,
  `marmeon check --only=boot,hsts` with the production environment tells you whether the app sends it
  ([the check](check.md#hsts); `--skip=hsts` where your proxy sets the header).
- `SERVER_SHUTDOWN_DELAY_SECONDS` of about 5 behind a probing load balancer or in Kubernetes.
- More than one instance or `--workers`: shared drivers for sessions, cache, queue, live updates and files, and Postgres instead
  of SQLite.
- `storage/` on a volume.

The [security](security.md#your-checklist) page has the rest of the list.
