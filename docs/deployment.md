# Deploying a BespokeCore app

A BespokeCore app in production is **one image (or one directory) and three roles**: the web server (`bespoke start`), the
queue worker (`bespoke queue:work`) and the scheduler (`bespoke schedule:work`). Each runs as a single Node process, each stops
gracefully on SIGTERM, and each reads its configuration from the environment. This guide covers the Docker template, the process
model, stopping without dropped requests, proxies (and why live updates need HTTP/2), what changes with more than one instance,
mail, keys, systemd and Kubernetes.

## The short version

```sh
bespoke make:docker --caddy          # Dockerfile, .dockerignore, compose.production.yaml, deploy/Caddyfile
# on the server, next to the files:   .env.production with APP_KEY, APP_URL=https://…, MAIL_*, DB_* …
APP_DOMAIN=example.com docker compose -f compose.production.yaml up -d --build
docker compose -f compose.production.yaml run --rm web migrate --force
```

`make:docker` writes the files once; they are yours afterwards (`--force` writes them anew). Without `--caddy` the web
container publishes port 3000; `--nginx` puts nginx in front instead; `--systemd` adds units for running without Docker.

## Roles and processes (E140)

| Role | Command | Restart | Stops on SIGTERM |
| --- | --- | --- | --- |
| web | `bespoke start` | always (unless stopped) | readiness 503, `SHUTDOWN_DELAY`, then the drain: requests in flight and the work after them (≤ 10 s) |
| worker | `bespoke queue:work --queue=mail,default` | always — a job past its timeout ends the worker with **exit code 70** on purpose | no new job; the running one gets `--stop-timeout` (10 s), else it is released |
| scheduler | `bespoke schedule:work` | always | no new tick; runs get `--stop-timeout` |

- **One role per container** (or per systemd unit) is the model: the same image, another command. Scale the web role with more
  containers, or on a machine with several cores with `bespoke start --workers=N` (`node:cluster`: one port, N servers, the
  primary passes signals on, each worker drains, exit 0 when all exited 0). Run **one scheduler** per deployment (or per server
  with `onOneServer()` tasks and a shared cache) and as many workers as the queue needs.
- **The worker's queues:** without `--queue` a worker takes only `default` — the auth module's mails wait on `mail`. Name every
  queue the app uses, in priority order (`--queue=mail,default`), or `--queue=*`. An idle worker names a queue nobody takes in a
  warning (`Jobs are waiting on the "mail" queue …`) once it saw jobs ready there twice in a row.
- **Boot warnings once:** with `--workers=N` the primary says the boot's warnings (log mailer, cookies without `Secure`, stale
  build artifacts); the workers keep theirs to themselves.
- **One process:** `bespoke start` *is* the server — no launcher in front — so the supervisor's SIGTERM, a worker's exit code and
  `NODE_OPTIONS='--import ./bootstrap/telemetry.ts'` reach exactly one Node process.
- **An init process:** Node as PID 1 reaps no zombies, and the kernel drops a signal to PID 1 that has no handler yet — a
  SIGTERM in the few hundred milliseconds of the boot would be lost (the container then waits for SIGKILL). Compose's
  `init: true` (the template sets it) or `docker run --init` put one in front. Kubernetes does not; there the handlers, installed
  before the server listens, cover everything after the boot — add `tini` to the image if that window or child processes
  matter to you.

## The image (E141)

The Dockerfile of `make:docker`, stage by stage:

1. **build** — `node:26-slim` (Debian, glibc: native packages such as oxc, rolldown and lightningcss work as on a laptop); pnpm
   pinned from the app's `packageManager` and installed with `npm i -g` (Node ships no Corepack since 25; an app with
   `package-lock.json` gets `npm ci` instead); the manifests first, then `install --frozen-lockfile` with a BuildKit cache mount,
   so code changes do not reinstall; then the app and **`bespoke build`**: the injection lists, route types, the type check,
   the client and SSR bundles, the precompressed assets, the discovery manifest; then a **fresh production install** (only
   `dependencies` — `bespoke` is one) and `bespoke discover` for exactly these packages.
2. **run** — `node:26-slim` again (the same Node, so the compile cache and native packages match), the app copied in owned by
   root and readable for everyone, `storage/` owned by `node`, `USER node`, `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3000`, a
   `HEALTHCHECK` with Node's own `fetch` on `/up` (no curl), `ENTRYPOINT ["bespoke"]`, `CMD ["start"]`. Worker and scheduler run
   the same image with another command.

**Build-time configuration.** `bespoke build` boots the app once (to write the route types), so the configuration must be
valid at build time: the build copies `.env.example` to `.env` and uses a throwaway `APP_KEY` — both are deleted in the same
step; the image has neither. A setting that must be valid but has no default in `.env.example` goes into the build stage as
`ARG`/`ENV`. Nothing secret is needed to build.

**No `.env` in the image.** `.dockerignore` keeps every `.env*` out of the build context (only `.env.example`, for the build).
The configuration comes from the environment when the container runs — `env_file: .env.production` in Compose, a Kubernetes
`Secret`, `--env-file`. Never deploy a developer's `.env`: with `NODE_ENV=development` in it the app would run the development
tools (E170; it says so loudly in its log).

**`storage/` is a volume** — sessions and cache of the `file` drivers, uploads of the local disks, the SQLite database, Node's
compile cache. The container's own files are gone with the container.

**Read-only root file system** works (`docker run --read-only --tmpfs /tmp -v …:/app/storage`): the build artifacts in
`.bespoke/` are complete, so nothing is written next to the code (E160); a missing or stale one would only log a warning.

**Size.** The image of the blank app with the auth module (`make:auth`) is about **320 MB** — `node:26-slim` alone is 271 MB; the
app's production `node_modules` are 97 MB (with npm 157 MB). The build stage carries TypeScript, Vite and pnpm; the final stage
does not. `pnpm run ci` builds and runs this image (`image`) and reports its size.

**Compile cache.** `bespoke start` keeps Node's compile cache in `storage/framework/compile-cache`: the first container on a new
volume starts about 90 ms slower, every later one — also after a deployment, for each unchanged module — uses it. It is not baked
into the image: Node uses a cache directory only when it can write to it.

## Configuration

| Variable | In production |
| --- | --- |
| `NODE_ENV` | `production` (set by the image; `staging` is protected the same way, E139) |
| `APP_KEY` | the key from `bespoke key:generate --show` — the same on every instance; a secret |
| `APP_PREVIOUS_KEYS` | when you rotate: the old key(s), comma-separated — sessions, encrypted cookies and signed links made with them keep working until they expire |
| `APP_URL` | `https://…` — cookies get `Secure` from it (E162); a protected app on `http://` logs a warning at boot. Over plain HTTP browsers also ignore the `Clear-Site-Data` of a sign-out (secure origins only): a staging box without TLS keeps its HTTP cache after a sign-out |
| `HOST`, `PORT` | `0.0.0.0` / `3000` in a container; `127.0.0.1` behind a proxy on the same machine (`PORT=0` takes a free port — the start line names it) |
| `TRUSTED_PROXIES` | the proxy's addresses or ranges (`10.0.0.0/8`), or `*` when only your proxy can reach the app and it replaces `X-Forwarded-For` (Caddy, the `--nginx` template) — see [Proxies](#proxies-and-http2) |
| `SHUTDOWN_DELAY` | `5` behind a load balancer that learns from its probes — see [Stopping](#stopping-without-dropped-requests) |
| `MAIL_MAILER` | `smtp` (with `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS`; `pnpm add nodemailer`) |

**Rotating `APP_KEY`:** generate a new key, move the current one into `APP_PREVIOUS_KEYS`, deploy every instance with both;
remove the old key once the longest-lived session or signed link has expired. Replacing the key without that signs everybody out
and breaks every signed link.

**Mail (E135):** the default `MAIL_MAILER=log` sends nothing — it writes each mail, password-reset and verification links
included, into the log. A protected app warns about it at boot. Production needs `smtp`; queued mails then go out through the
worker (`--queue=mail,default`).

## Stopping without dropped requests

On SIGTERM the web server:

1. **takes itself out of readiness** — `/up/ready` answers `503 {"status":"draining"}` at once (`/up`, liveness, stays 200);
2. **keeps answering for `SHUTDOWN_DELAY` seconds** (default 0; E163) — every response with `Connection: close`, so the client's
   next request opens a new connection, which the load balancer gives to another instance;
3. **drains** (E102) — live streams end (the tabs reconnect elsewhere), no new connections, requests in flight finish, then the
   work deferred until after the response (a reset mail) — at most 10 s — and the process exits with 0.

SIGINT (Ctrl+C) skips the delay. Give the supervisor time for all of it:

| Supervisor | Setting | Default | Needs |
| --- | --- | --- | --- |
| Docker / Compose | `stop_grace_period` / `docker stop -t` | 10 s | web: `SHUTDOWN_DELAY` + 10 s (template: 20 s); worker: `--stop-timeout` + margin (30 s) |
| systemd | `TimeoutStopSec` | 90 s | the same (template: 30 s) |
| Kubernetes | `terminationGracePeriodSeconds` | 30 s | the same; `preStop` time counts into it |

**Why the delay?** Kubernetes removes a terminating pod from its endpoints *at the same time* as it sends SIGTERM; kube-proxy,
ingress controllers and external load balancers notice a moment later, and requests keep arriving for a few seconds. A load
balancer that knows only its probes (kamal-proxy, Traefik, a cloud load balancer polling `/up/ready`) needs at least one probe
interval. The usual Kubernetes answer is a `preStop` hook (`sleep 5`, natively `lifecycle.preStop.sleep` since 1.34) —
`SHUTDOWN_DELAY=5` does the same inside the app, without a hook, and works for Compose, systemd and every load balancer. Use one
of the two, not both.

## Health checks (E126)

- `GET /up` — liveness: 200 once booted, 503 while the server closes. Checks nothing else: a database outage must not get
  healthy processes restarted. The image's `HEALTHCHECK` uses it (it follows `PORT` and `HEALTH_PATH`; with `HEALTH_PATH=off`
  remove it). Worker and scheduler containers have no HTTP server — the template turns their health check off.
- `GET /up/ready` — readiness: every health check (database, Redis, cache, queue, the app's own), 200 or 503, `draining` from
  SIGTERM on. The result is kept for one second, so a flood of probes runs the checks once a second. Details (which check, how
  long, why) only with `NODE_ENV=development`.

```yaml
# Kubernetes (Deployment, container spec)
livenessProbe:  { httpGet: { path: /up, port: 3000 }, periodSeconds: 10 }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 5 }
env:
  - { name: SHUTDOWN_DELAY, value: '5' }
terminationGracePeriodSeconds: 30   # > SHUTDOWN_DELAY + 10 s drain
```

## Proxies and HTTP/2

**Live updates need HTTP/2 at the browser.** Live streams (`useLive`, Server-Sent Events) hold a connection open per tab. Over
HTTP/1.1 a browser opens at most **6 connections per host — across all tabs** — so the seventh tab with a stream would hang
every further request. The client notices HTTP/1.1 (`nextHopProtocol`) and keeps a stream only while its tab is visible (E104);
over HTTP/2 (typically 100 streams per connection) every tab keeps its stream. Terminate TLS with HTTP/2 at the proxy — the app
itself speaks HTTP/1.1 to the proxy, which is fine.

Proved in the browser (Wave 8 step 5): the web app behind `caddy:2` with `tls internal`, seven tabs on `/dashboard` — over h2
all seven `nextHopProtocol: h2` with an open stream each; the same setup forced to h1 — the six hidden tabs closed their streams,
the visible one kept its own.

**Caddy** (`--caddy`, the recommendation): automatic certificates, HTTP/1.1, 2 and 3 by default, and it flushes
`text/event-stream` responses by itself. It sets `X-Forwarded-For/-Proto/-Host` and ignores a client's own (unless you configure
`trusted_proxies` in Caddy). `stream_close_delay` keeps streams open through a config reload for a while.

**nginx** (`--nginx`): `http2 on;` on the TLS server; `proxy_buffering` is on by default, the app turns it off per response with
`X-Accel-Buffering: no` for live streams; `proxy_read_timeout` (60 s default) must be longer than the live heartbeat (20 s,
`LIVE_HEARTBEAT`) — the template sets 75 s; `proxy_http_version 1.1` with `Connection ""` for keep-alive to the app (the default
from nginx 1.29.7 on); **set** the forwarded headers (`X-Forwarded-Proto $scheme`, `X-Forwarded-Host $host`,
`X-Forwarded-For $remote_addr` — replaced, not appended to the client's list). HTTP/3 in nginx is still experimental.

**kamal-proxy, Traefik, PaaS routers:** check that they do not buffer responses (Traefik flushes streams; kamal-proxy buffers by
default and has a 30 s response timeout — test live updates there before relying on them) and that they speak HTTP/2 to the
browser. kamal-proxy probes `/up` once a second: with `SHUTDOWN_DELAY` point it at `/up/ready` so it notices a stopping
container.

**`TRUSTED_PROXIES`** (E162): only from these addresses do `X-Forwarded-For` (the client's address for rate limits, logs and
`RequestInfo`) and `X-Forwarded-Proto`/`-Host` (the request's URL: `https://example.com/…` — the app's own origin for the CSRF check, besides `APP_URL`'s) count. Without it the headers are
ignored. Behind Compose's Caddy, where the web container publishes no port, `*` is right (the template sets it); with a
proxy on the host, `127.0.0.1`; in a cluster, the ingress' range (`10.0.0.0/8`). A proxy that forwards a client's
`X-Forwarded-*` unchanged makes them the client's word — let the proxy set them. `*` trusts every entry of `X-Forwarded-For`, so
`ctx.ip` becomes its left-most one: right behind Caddy and the `--nginx` template, which replace the header, but not behind a
proxy that appends the client's address to what the client sent (nginx's `$proxy_add_x_forwarded_for`) — there name the proxy's
address or the Compose network's subnet (as the docs below do), so the right-most entry, the one the proxy added, counts.

**Compression:** the assets arrive precompressed (`.br`/`.gz` from `bespoke build`, `immutable` for a year); documents and JSON
are not compressed by the app — a compressed response that carries a secret (the CSRF token) is what BREACH reads. Leave the
proxy's compression off for them too (the templates do).

## More than one instance

With more than one web container (or `--workers`), or with containers on more than one machine, everything shared must live in
a shared store:

| What | Not | Use |
| --- | --- | --- |
| Sessions (`SESSION_DRIVER`) | `file` on several machines, `memory` | `redis`, `database` (or `cookie`) |
| Cache, rate limits, locks (`CACHE_DRIVER`) | `file` on several machines, `memory` | `redis`, `database` |
| Queue (`QUEUE_CONNECTION`) | `sync` for real work; `database` on SQLite across machines | `redis`, `database` on Postgres |
| Live (`LIVE_DRIVER`) | `memory` (a broadcast reaches only its own process) | `redis` |
| Database | SQLite across machines | Postgres |
| Uploads | the local disks on several machines | an S3 disk ([@bespokecore/storage](../packages/storage/README.md)) |

On one machine the Compose template shares one `storage` volume between web, worker and scheduler — SQLite and the `file`
drivers work there (one kernel, one file system). `onOneServer()` scheduler tasks need a cache every scheduler shares.

## Without Docker: systemd

`bespoke make:docker --systemd` writes `deploy/systemd/{web,worker,scheduler}.service` for an app in `/srv/<name>`, run as the
user `<name>`, configured from `/etc/<name>/env` (`chmod 600`). Deploy by building there (or copying a build): `pnpm install
--frozen-lockfile && bespoke build && pnpm install --prod --frozen-lockfile`, then `systemctl restart <name>-web <name>-worker
<name>-scheduler`. The units restart always (a worker's exit 70 included), send SIGTERM with `TimeoutStopSec` above the drain,
and protect the system (`ProtectSystem=strict`, only `storage/` writable). The web server listens on `127.0.0.1` and trusts the
proxy on the same machine (`--caddy`/`--nginx` with `--systemd` write the proxy configuration for the host). Node must be on the
service's `PATH` (a system package, not nvm).

## One server with Compose: the docs as an example

The docs of this repository are deployed this way (E142): `apps/docs/Dockerfile` (the monorepo variant of the template, built
from the repository's root) and `deploy/docs/compose.yaml` with a `Caddyfile` — two containers on one VPS. What they show
beyond the template:

- **A firewall in front of the server, not on it.** Docker publishes ports through its own iptables rules, past `ufw` and
  `firewalld` — a host firewall does not protect a published port. Use the provider's firewall (Hetzner Cloud Firewall, a security
  group): SSH, 80, 443/TCP and 443/UDP (HTTP/3) in, nothing else.
- **`TRUSTED_PROXIES` as the network's range** instead of `*`: the Compose file gives the network fixed subnets and trusts exactly
  those — only Caddy shares the network with the app. **IPv6 on that network** (`enable_ipv6`): without it Docker hands a visitor's
  IPv6 connection to Caddy through a proxy process, and every IPv6 visitor arrives with the gateway's address (one rate limit for
  all of them).
- **Read-only:** `read_only: true` with a `tmpfs` for `/tmp` and the `storage` volume — the image carries its discovery manifest
  (E160), nothing else is written.
- **Compression of pages that carry no secret:** the docs have no session, no CSRF token and no cookie, so Caddy's `encode` is safe
  there (and turns 190 KB pages into 40 KB). An app with sign-in keeps documents uncompressed.
- **A tag per build for the way back:** `image: bespokecore-docs:${DOCS_TAG:-latest}` — `DOCS_TAG=$(git rev-parse --short HEAD)
  docker compose up -d --build` builds and starts a named version; an earlier tag still on the machine starts again without a
  build.

## Checklist

- [ ] `NODE_ENV=production` (image) — no developer `.env` on the server; `APP_KEY` set, the same everywhere; `APP_URL` is `https://`
- [ ] `bespoke migrate --force` once per deployment (a one-off container: `docker compose run --rm web migrate --force`)
- [ ] the proxy speaks HTTP/2 to browsers, does not buffer event streams, sets `X-Forwarded-*`; `TRUSTED_PROXIES` names it
- [ ] `MAIL_MAILER=smtp`
- [ ] web, worker and scheduler each under a supervisor that restarts them; grace periods longer than the drain
- [ ] the worker takes every queue the app uses (`--queue=mail,default`, or `--queue=*`)
- [ ] HSTS once the site is HTTPS only (the app's `SecurityHeaders` switch or the proxy); the rest of the list: [security](security.md#your-checklist)
- [ ] `SHUTDOWN_DELAY` (≈ 5) behind a probing load balancer or in Kubernetes
- [ ] more than one instance: shared drivers for sessions, cache, queue, live and uploads; Postgres instead of SQLite
- [ ] `storage/` on a volume
