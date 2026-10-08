# @marmeon/server

The HTTP server of a Marmeon app: the kernel (Hono for matching, the Marmeon router for the typed pipeline), server
rendering through Vite in development and through the build in production, islands and layers resolved in-process, the health
endpoints and `startServer()` with a graceful drain. `marmeon dev` and `marmeon start` run it
([marmeon](../cli/README.md#commands)); an app rarely calls it itself. Its `ServerServiceProvider` is found by
`marmeon discover`. Vite is an optional peer: `marmeon dev` and `marmeon build` need it (`pnpm add -D vite@^8 @marmeon/vite`),
a production server never loads it. Routes, controllers and responses are [@marmeon/router](../router/README.md) and
[@marmeon/http](../http/README.md); what goes over the wire is [the protocol](../http/README.md#the-protocol).

**Dependencies** ([the driver rule, E198](../../CONTRIBUTING.md#dependencies-of-drivers)): Vite stays a **peer** — the app's own Vite (its plugins, its config) is the one the server runs;
a dependency would bring a second.

## Configuration

`ServerConfig` (`static config` of the provider) — every variable is optional:

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | `3000` | the port `startServer()` listens on; `0` asks the system for a free one (the start line names it) |
| `HOST` | every interface | the interface it listens on — `127.0.0.1` behind a proxy on the same machine, `0.0.0.0` in a container (E162) |
| `MAX_BODY_SIZE` | `8m` | the largest request body: bytes, or `512k`, `8m`, `1g` |
| `TRUSTED_PROXIES` | — | the app's proxies: addresses or ranges, comma-separated (`127.0.0.1,10.0.0.0/8,fd00::/8`), or `*` behind the app's own proxy only; only from these `X-Forwarded-*` count ([Behind a proxy](#behind-a-proxy-e162)); anything else fails the start |
| `ASSET_VERSION` | the build's | the asset version a new deployment answers 409 for — e.g. the git commit; in production by default a hash of the built `index.html` |
| `SSR_ENABLED` | `true` | `false`: no server rendering, the browser renders every page (one page: `Page.ssr = false`) |
| `HEALTH_PATH` | `/up` | where the health endpoints answer (readiness below it); `off`: none ([Health](#health-e126)) |
| `SHUTDOWN_DELAY` | `0` | seconds the server keeps answering after SIGTERM with `/up/ready` at 503, before it closes (E163, [the drain](#startserver-and-the-drain)) — 5 behind a load balancer that learns from its probes; at most 300 |
| `KEEP_ALIVE_TIMEOUT` | `65` | seconds an idle keep-alive connection stays open — longer than the proxy in front keeps its own to the app (nginx's upstream `keepalive_timeout` 60 s, an AWS load balancer 60 s), so the proxy closes first ([Behind a proxy](#behind-a-proxy-e162)); 1–3600. The headers of a request may take a second longer (at least 60 s, at most the 300 s of a whole request) |
| `NODE_ENV` | — | `development` turns on the error page, `Server-Timing` and `DevDocument` — nothing else does (E115); every value but `development` and `test`, none included, is protected (E139, [The environment](../core/README.md#the-environment-node_env)) |

## The kernel

`createHttpKernel(app, options?)` turns the app's routes into a Hono app — what `startServer()` serves and what tests call
in-process (`createTestApp`, [@marmeon/testing](../testing/README.md)). Per request:

- **a container scope of its own** — controllers and middleware are built from it, so scoped services live as long as the
  request; the request id (`x-request-id`: the client's when it is a sane one, else generated) is set as the request context
  and answered in the response header. The scope holds the request's `CookieJar` (with the app's `CookieDefaults` — `Secure`
  from `APP_URL` with `@marmeon/session`, E162), its `RequestNonce` (the CSP nonce, made only when a document needs it,
  E147), `IncomingRequest` and `RequestInfo` (`{ ip, userAgent }`, E169 — [who sent it](../http/README.md#registration-and-configuration));
- **method spoofing** (E64): a form's POST with `_method=PUT|PATCH|DELETE` in its body is routed as that method — never from the
  query, never to GET;
- **the body** is read once, by its route, up to `MAX_BODY_SIZE`;
- **errors** — thrown, `abort()`ed or an unknown path — go through the app's `ExceptionHandler` (`@marmeon/http`); an
  unknown path still passes the global middleware first;
- **read-only requests:** an island's, a live validation, an upload's target, an event stream, the tabs' `GET /_marmeon/session`
  ([tab sync](../http/README.md#tab-sync-w8-step-8)) and a layer's base resolved for its deep link change no session, cookie or
  work after the response; nor does any request once its headers are out (a streamed page's deferred props). A write there
  throws with `NODE_ENV=development` and `test` (the mistake shows where it is made) and is dropped and logged everywhere else —
  production, staging, no `NODE_ENV` (E164);
- **one copy at most:** the kernel's own headers (`x-request-id`, `Server-Timing`) go onto the response in place when the request
  owns it, else onto one copy ([`editableResponse`](../router/README.md#adding-headers-to-the-response--editableresponse));
- **after the response:** `afterResponse.defer(…)` work and `terminate` hooks run once the response is out, outside of any
  transaction (E107);
- **islands and layers** are resolved in-process while a page renders: a GET of the island's URL through its own route's
  middleware and authorization, with the page request's cookies (10 s limit, then the island's error); a layer's base the same
  way for a deep link ([The protocol](../http/README.md#the-protocol));
- **in production**, `/assets/*` is served from `dist/client` — kept a year (`Cache-Control: public, max-age=31536000,
  immutable`: Vite names every file by its hash), as the `.br` (else `.gz`) `marmeon build` wrote next to it when
  `Accept-Encoding` names it, with the original `Content-Type` and `Vary: Accept-Encoding` (E162). **Nothing is compressed per
  request** — documents never: compressing a page that carries a secret (the CSRF token) next to reflected input leaks the
  secret byte by byte (BREACH). Compressing responses is the proxy's business, if anybody's.
- **documents get the response's CSP nonce** when the app sends a policy (`contentSecurityPolicy()`, E147): the template's
  placeholder (`CSP_NONCE_PLACEHOLDER`, from Vite's `html.cspNonce`) becomes the nonce, React's streamed scripts carry it —
  [Content-Security-Policy](../http/README.md#content-security-policy-e147).

**Server rendering:** a page renders on the server until its shell, then streams (islands and deferred props into the same
response, E49); crawlers and link previews get the whole page at once. When the shell cannot render, the document goes out
without markup and the browser renders the page — what an adapter's SSR entry does is in
[What an adapter provides](../http/README.md#what-an-adapter-provides).

## `startServer` and the drain

```ts
const server = await startServer({ app });   // port, host: ServerConfig (PORT, HOST); mode: development only when NODE_ENV=development
// …
await server.close();                         // on SIGTERM — marmeon dev and start do this themselves
await server.close({ immediately: true });    // without SHUTDOWN_DELAY (marmeon does this on SIGINT, Ctrl+C)
await app.shutdown();
```

`startServer(options)` takes `app` and, all optional: `port` and `host` (`ServerConfig`: `PORT`, `HOST`), `mode`
(`'development'` | `'production'`), `ssrEntry` (development: the SSR entry relative to the root, default the `marmeon()`
plugin's), `drainTimeoutMs` (8000), `shutdownDelayMs` (`SHUTDOWN_DELAY`) and `keepAliveTimeoutMs` (`KEEP_ALIVE_TIMEOUT`; the
server's `headersTimeout` is a second longer, between 60 s and 300 s). It resolves with a `RunningServer` — `{ server, port,
close(options?) }`, `server` being Node's `http.Server`; it rejects with Node's error when it cannot listen (`EADDRINUSE`). On every
interface (no `host`, `::`, `0.0.0.0`) with a fixed port it first looks whether another program holds `127.0.0.1:<port>` — macOS lets
both listen, and requests to 127.0.0.1 would reach that program — and logs a warning if so (`heldOnLoopback(port, host)`; a cluster's
primary asks once for its workers).

- **development** (`mode: 'development'`; the default only with `NODE_ENV=development`, E115 — never "anything but production"):
  the app's Vite in middleware mode — HMR, source modules, `/__open-in-editor`, the SSR entry of the `marmeon()` plugin
  (`bootstrap/ssr.tsx`). Without Vite or without the plugin it fails with a `ViteSetupError` that says what to install. `marmeon
  dev` sets `NODE_ENV=development` when it is unset; with another `NODE_ENV` (`staging`, `test`) it serves the build and says so;
- **production** (the default with any other `NODE_ENV`, also none — on `staging` React still renders with its development build,
  which shows a late server error's message and stack to the visitor: [deployment](../../docs/deployment.md#configuration)): the
  built `dist/client/index.html` and
  `dist/server/ssr.js`, loaded once; without them the start fails with "No production build in dist/client — run marmeon
  build first."

The start line names the environment and what is served (E139): `Marmeon in staging (protected) on http://localhost:3000
(the build; 54 routes, 7 modules, packages: …)` — `in development … (Vite's dev server; …)` with `marmeon dev`, `in unset NODE_ENV
(protected, like production)` without one, `(from .env)` when `.env` named it (E170). The host is the one listened on (`HOST`;
`localhost` for every interface), the port the one it got (`PORT=0`: the system's choice; `RunningServer.port` says it too).
`marmeon start` runs the server in the process it was started in — no launcher child, the signals reach it directly
([One process](../cli/README.md#one-process-e159)).

`close()` stops gracefully. First, **readiness falls** (E163): `/up/ready` answers `503 {"status":"draining"}` at once, and for
`SHUTDOWN_DELAY` seconds (`shutdownDelayMs`, default 0) the server keeps answering every request — each response with `Connection:
close`, so a client's next request opens a new connection, which the load balancer, told by the failing probe, gives to another
instance; `/up` stays 200. Then the drain (E102): live streams end first (a tab connects to the next server), no new
connections, idle keep-alive connections close, requests in flight finish, then the work they deferred until after their
response — at most `drainTimeoutMs` (8 s) — before the caller shuts the app down and its pools close. `/up` answers 503 from
the moment the drain begins (after the delay), on connections still open. `marmeon` exits after 10 s (plus the delay) at the latest; it installs its signal handlers before the server
listens, so a SIGTERM during the start is answered once it listens (Node's default would end the process without a drain — and
Node as PID 1 would ignore it).

Why a delay, when Kubernetes takes a terminating pod out of its endpoints by itself: that happens **at the same time** as the
SIGTERM, and kube-proxies, ingress controllers and external load balancers learn about it a moment later — requests keep coming
for a few seconds. A load balancer that knows only its probes (kamal-proxy, Traefik, a cloud load balancer polling `/up/ready`)
needs at least one probe interval. `SHUTDOWN_DELAY` covers both without a `preStop` hook; Kubernetes' `terminationGracePeriodSeconds`
(30 s) must exceed the delay plus the drain (≈ 10 s). `marmeon start --workers=N` (E140, [marmeon](../cli/README.md#several-processes---workers-e140))
runs one such server per worker process; each drains on its own.

## Start in production (E138, E161)

`marmeon start` until the first `GET /up` answers 200 — the web app (54 routes, 7 modules, 20 packages), Node 26.10 on an Apple
laptop, measured with `pnpm bench boot --app apps/web-app` (median of 7, alternating with the build before Wave 8 step 3):

| | Start → `/up` 200 | Modules loaded |
| --- | --- | --- |
| before (every app module parsed by oxc at start, pino-pretty and tinker always loaded, no compile cache) | 382 ms | 997 |
| injection lists from `marmeon build`, lazy imports, no compile cache (`NODE_DISABLE_COMPILE_CACHE=1`) | ≈ 333 ms | 940 |
| **with Node's compile cache (the default)** | **271 ms** | 940 |

Where the time goes now (CPU samples of one profiled start, 324 ms with the profiler's overhead):

| Part | Share | What |
| --- | --- | --- |
| module loader | 48 % | resolving ~940 imports: `stat`, the search for `package.json` scopes, `realpath`, builtins, the loader's jobs |
| compile | 18 % | V8 compiling the modules — from the compile cache's code cache where it is valid |
| reading sources | 12 % | the files of the modules (kysely alone has 257) |
| type stripping | 10 % | the app's ~120 `.ts` modules (the app stays TypeScript, E138); served from the compile cache when unchanged |
| module evaluation, other | 7 % | top-level code of the modules |
| injection lists | 1 % | the SHA-256 of each app module and the precomputed insertions — before: 5–16 %, the oxc analysis |
| boot, routes, server, discovery | 2 % | `createApplication` with every provider (3 ms), the route registration (≈ 1 ms), the renderer and the listener (3 ms), the discovery manifest (1.5 ms) |

**What is precomputed or cached:**

- **The injection lists** (`.marmeon/injections.json`, written by `marmeon build`): the start applies them to every unchanged
  module and never loads oxc-parser; a changed or unknown module is analysed and the app logs "Build artifacts are stale"
  once ([@marmeon/core](../core/README.md#precomputed-lists-in-production-e138)).
- **The discovery manifest** (`.marmeon/manifest.json`, E160).
- **Node's compile cache** — `storage/framework/compile-cache` of the app (Node's `NODE_COMPILE_CACHE` instead, when set;
  `NODE_DISABLE_COMPILE_CACHE=1`: off). It holds the type-stripped source and V8's code cache of every module. With the injection
  hook in front, Node keys an entry by the module's URL and accepts it only when a checksum of the source it is about to compile
  matches — the source **after** the hook. A module that changed (its list with it) misses, is compiled afresh and its entry
  rewritten; an old list can never come back from the cache (a test changes a constructor without building and starts twice).
  The cache is written once the server listens (and again at exit). A directory that cannot be created or written is no error:
  Node reports it and the start runs uncached. The first start fills it. In the Docker image of `marmeon make:docker` it lives in
  the `storage/` volume: the first container on a fresh volume starts ≈ 90 ms slower (measured: ≈ 490 vs ≈ 400 ms from the
  container's start to the start line), every later one is warm — also after a deployment, for every module that did not change.
  A cache baked into the image would not help: Node uses a cache directory only when it can write it (a read-only one ran
  slower than none), and the root file system may be read-only.
- **Lazy imports:** oxc-parser (only when a module must be analysed), pino-pretty (only for pretty logs), the tinker REPL.

**What is deliberately not cached:**

- **The configuration** (E161): every start resolves it from the environment and `.env` — secrets never end up in a build
  artifact, and a changed variable needs a restart, not a rebuild. It costs well under the 3 ms of `createApplication`.
- **The routes** (E161): registering the web app's 54 routes takes about 1 ms — a route manifest would pay off only above 20 ms.
- **The app as JavaScript** (E138): no compiled copy of the app, one code path; type stripping stays and is mostly served from
  the compile cache.
- **The modules themselves:** loading them (resolve, read, compile) is now most of the start; kysely brings 257 of the 940. Only a
  bundle would cut that, and bundling was rejected (E138: discovery, dynamic imports and native packages break too easily).

## The request path (E136, E154)

What one request costs the server — measured with `pnpm bench login` / `pnpm bench people` (the web app in-process, SQLite in
memory, `SESSION_DRIVER=memory`, `SESSION_ENCRYPT=false`, the requests through the kernel as a browser sends them; median of 6
alternating runs, each the median of 3 × 10 000 requests) on an Apple M1 Pro (16 GB), Node 26.10, after Wave 8 step 9:

| Request | µs per request | without Wave 8's measures | before Wave 7 (`f785159`) |
| --- | --- | --- | --- |
| JSON visit of `/login` with a guest session — **the budget** | **≈ 117** | ≈ 115 | ≈ 141 |
| JSON visit of `/login` without a cookie (no session since W8 step 6) | ≈ 87 | ≈ 85 | ≈ 112 (a session per request) |
| the `/login` document (HTML, CSP nonce) | ≈ 120 | ≈ 117 (without the CSP) | — |
| JSON visit of `/people` signed in (session, auth, queries, shared props) | ≈ 336 | ≈ 332 | ≈ 362 |

Wave 8's security measures cost (each switched off on its own, `--without <measure>`, plus a measurement of the code alone): the
session id's hash ≈ 0.3 µs per request with a cookie (`crypto.hash`), the Fetch Metadata stage nothing on a GET (it checks unsafe
methods only; ≈ 0.4 µs per POST — the token comparison it replaces for browsers cost ≈ 1.3), the CSP ≈ 1.5 µs per request (its
middleware) and ≈ 3 µs per document (the nonce, the header), the tab-sync epoch ≈ 0.9 µs per page (a memoized HMAC).
`SESSION_ENCRYPT=true` adds ≈ 9 µs to a request with a session (≈ 18 for `/people`): one decryption, one encryption.

Where the time went before step 9, and what took it back (CPU profiles, `pnpm bench login --profile --base f785159`): the cookie
encryption through WebCrypto (≈ 18 µs per call, three calls per page: now `node:crypto`, see
[@marmeon/encryption](../encryption/README.md#the-encrypter)), four or five copies of every response (now at most one,
[`editableResponse`](../router/README.md#adding-headers-to-the-response--editableresponse)), the middleware list sorted per
request (now once per route), allocations in the container's lookups of what a scope already holds, the cookie headers
serialized twice, the request translator's construction. Without the encryption change the rest alone is level with `f785159`
(−1 % for `/login`, −1 % for `/people`, both within the noise of ±3–5 %).

## Behind a proxy (E162)

By default the server believes no `X-Forwarded-*` header: `ctx.ip` is the peer's address and the URL is what the peer asked
for. With `TRUSTED_PROXIES` (addresses or CIDR ranges, `*` for "the direct peer is our proxy", E172):

- **`ctx.ip`** is the right-most `X-Forwarded-For` entry that is not a trusted proxy — what a client wrote on the left counts
  only once every hop to its right is trusted (rate limits, logs, islands use it). With `*` only the direct peer is trusted
  (E172, Laravel's and Symfony's `*`): `ctx.ip` is the right-most entry — the address that peer saw;
- **the request's URL** takes `X-Forwarded-Proto` (`http`/`https`) and `X-Forwarded-Host` from a trusted peer — of a list the
  right-most value, which the nearest proxy added; an invalid value is ignored. So the CSRF origin check, an island's origin,
  the asset version's reload URL and `ctx.request.url` see `https://example.com/…`, not `http://10.0.0.5:3000/…`;
- `Forwarded` (RFC 7239) and `X-Forwarded-Port` are not read — Caddy, nginx, Traefik and the cloud load balancers send
  `X-Forwarded-*` (a port belongs into `X-Forwarded-Host`).

Configure the proxy to **set** these headers (Caddy does by itself; nginx: `proxy_set_header X-Forwarded-Proto $scheme;` and
`X-Forwarded-For $remote_addr`, as the `make:docker --nginx` template does) — a proxy that passes a client's own headers on
unchanged makes them the client's word. `*` suits a proxy that is the only way in (a Compose network, a platform's router);
two proxies in a row — a CDN in front of nginx — need their ranges, or the app takes the CDN's address. Prefer explicit
addresses or ranges where you know them. Cookies get `Secure` from `APP_URL`, not from the request (`SESSION_SECURE_COOKIE`,
[@marmeon/session](../session/README.md#configuration)).

**Keep-alive (W9 step 4).** A proxy that reuses its connections to the app (nginx `upstream { keepalive 16; }`, every cloud load
balancer) must close an idle one **before** the app does — the other way round it now and then sends a request on a connection the
app is just closing, and the browser gets a 502. Node's own default is 5 s; the server keeps idle connections `KEEP_ALIVE_TIMEOUT`
seconds (65), above nginx's upstream `keepalive_timeout` (60 s, written into the `make:docker --nginx` template) and an AWS load
balancer's idle timeout (60 s). Behind a proxy with a longer one (Google's load balancer: 600 s) set it higher (`KEEP_ALIVE_TIMEOUT=620`).

## Health (E126)

Two endpoints for load balancers and orchestrators, answered by the kernel **before anything else** runs for a request: no
middleware of any group (no session, no cookie, no CSRF), no request id, no log line, no `http.request` message — so neither a
span (`@marmeon/otel`) nor a devtools entry. Responses are `Cache-Control: no-store`; `HEAD` works too.

| | Answers | Checks |
|---|---|---|
| `GET /up` — liveness | `200 OK` once the app booted; `503` from the moment the server closes (the drain of E102) | nothing else — a database outage must not get a healthy process restarted |
| `GET /up/ready` — readiness | `200 {"status":"ok"}`; `503 {"status":"failing"}`; `503 {"status":"draining"}` from SIGTERM on (also during `SHUTDOWN_DELAY`) | every `HealthCheck` ([core](../core/README.md#health-checks-e126): database, redis, cache, queue and the app's own), at once, each with its time limit (2 s); the result is kept for 1 s |

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /up, port: 3000 } }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 5 }
env: [{ name: SHUTDOWN_DELAY, value: '5' }]     # instead of a preStop sleep; terminationGracePeriodSeconds (30) > 5 + 10
```

- **Details only in development** (`ServerConfig.debug`, `NODE_ENV=development`): then `/up/ready` names each check with its
  status (`ok`, `failing`, `timeout`), time in ms, note (`default, system`, `database, 3 waiting`) and error — redacted (E125).
  Elsewhere the answer is the status only: what an app depends on and how it fails is nobody's business outside.
- **One run a second** (E163): probes arriving while the checks run share that run, and its result answers every probe for one
  second after it — failing results too (the app's `Clock`). The path is public: a flood of probes costs one `select 1` a
  second, not one each.
- **Readiness falls first:** a deployment's `SIGTERM` takes `/up/ready` to 503 at once — the cached "ok" of a moment ago does
  not count — while `/up` stays 200 and requests are answered for `SHUTDOWN_DELAY` seconds; then the server closes, and both
  answer 503 on connections still open while requests in flight finish and work after the response drains.
- **The checks' own queries leave no span** (a statement outside every span is not traced) — the probes do not flood a trace
  backend.
- **Where:** `HEALTH_PATH` moves them (`/healthz` → `/healthz`, `/healthz/ready`); `HEALTH_PATH=off` turns them off. A route of
  the app on one of the two paths fails the start — it could never be reached: `The route "status" (GET /up) is where the health
  check answers (E126) — it would never be reached. Give the route another path, or move the health check: HEALTH_PATH=/healthz
  (or HEALTH_PATH=off).` (A route with a parameter, `/:page`, simply never sees `up`.)

## The request log line

Every request writes one entry on the `http` channel — `GET /users/7 200` with `{ requestId, route: 'users.show', ms }`
(`route` only for a named route). It is built only when it goes somewhere: the kernel asks `logger.enabled?.('info')` first
(E187) — with `LOG_LEVEL=silent` or `warn` neither the line nor its redacted path is made. The kernel answers with the request's id (`x-request-id`, taken from the request when it
is a sane one, else generated); every log entry of the request carries it — and, with `@marmeon/otel`, the request span's
`trace_id` and `span_id` (the line is written inside the span). Its path is redacted (E125): a sensitive route parameter
(`/reset-password/:token`) and a token-like segment of a path without a route become `[redacted]`.

## Observation (E118)

The kernel traces each request on the `http.request` channel of `@marmeon/core/diagnostics` — method, path, URL and
headers (raw), route name and pattern, controller, status, duration, where the response sends the browser (`location`: a
redirect's target or the protocol's 409 reload, with its `reload` reason) — and sends the error a request ends in to `exception`;
server rendering goes to `render.ssr`. Without a subscriber none of it is built. The channels and their messages:
[Diagnostics](../core/README.md#diagnostics-marmeoncorediagnostics-e118); the spans made of them:
[@marmeon/otel](../otel/README.md). The health endpoints are not traced.

## `Server-Timing` (E129) — development only

With `NODE_ENV=development` (`marmeon dev` sets it when it is unset) every response says what its request spent:

```text
Server-Timing: app;dur=18.4;desc="App", db;dur=3.1;desc="4 queries", ssr;dur=9.7;desc="SSR"
```

`app` is the request until its response (for a streamed page: until the shell), `db` the time of its queries and how many,
`ssr` server rendering until the shell (only when the page rendered on the server). The browser's network panel shows it
per request (Timing tab). It is **only** on with `NODE_ENV=development` — not in tests, not in staging, never in production
(E115: development tools check for development, never for "not production"). Its provider (`ServerServiceProvider`)
listens to `db.query` and `render.ssr` from its boot to its shutdown; elsewhere the channels keep no subscriber and no
header is set.

## The development document (`DevDocument`) — development only

With `NODE_ENV=development` the `ServerServiceProvider` binds a `DevDocument`: HTML that packages add to every document the Vite
dev renderer serves — before `</body>` (outside the app's root: hydration never sees it), or with `at: 'head'` before `</head>`
(ahead of the app's entry: a module script there runs first). No client chunk carries it. Markup may be made per document: a
function gets the request it renders for (`{ requestId }`). The devtools hang [their in-page bar](../devtools/README.md#the-in-page-bar)
here: the module script of the bar, served by Vite, and the document's request id.

```ts
if (app.container.has(DevDocument)) {
  app.container.make(DevDocument).add(({ requestId }) => `<meta name="x-dev" content="${escapeHtml(requestId ?? '')}">`, { at: 'head' });
}
```

The production renderer never reads it, and it is not bound elsewhere. Only trusted markup of a package — what comes from the
request (its id may be the client's own `x-request-id`) is escaped.

## Error page (E119) — development only

With `NODE_ENV=development` (`marmeon dev`), a page request that fails with a 5xx gets the **development error page** instead
of the app's `errors/Error` view:

- **head:** status, error class, message (and causes), the request and its route — and the **solutions** (E130): what to do,
  why, a command to copy, the README to read;
- **stack:** the app's frames first, each with its code (±8 lines, the throwing line marked) and an *open in editor* link
  (Vite's `/__open-in-editor`); Node runs the TypeScript as written and the injection transform keeps every line, so the
  line is the line that threw;
- **request** (method, URL, headers, query, body), **route** (name, pattern, controller, middleware, parameters), the
  request's **queries** (up to 100, with their duration) and **log** entries, **injection warnings** (E128), the
  **environment** (Node, `NODE_ENV`, the Marmeon packages);
- **Copy as Markdown:** the same report as Markdown, for an issue or a chat (no source code, only where the frames are).

Everything on it — page and Markdown — passes the app's `Redactor` first (E125): cookies, `Authorization`, passwords,
tokens, hashes and the parameters of statements on secret columns never show.

It is one self-contained HTML document — its own CSS (light and dark), no React, no Vite, no app code — so it renders when
the views or server rendering are what broke. It goes out with `Cache-Control: no-store`, `X-Robots-Tag: noindex` and a
`Content-Security-Policy` of its own (`default-src 'none'`, its inline style and script by hash, `frame-ancestors 'self'`),
which an app's `contentSecurityPolicy()` leaves alone. A client-side visit (`x-marmeon`) gets it as HTML too; the visit dialog
(`VisitFailure`) shows it in its sandboxed frame. The frame runs no scripts (`sandbox=""`, unchanged): there the Markdown is a
text field to select, and the editor links work through a named frame inside the page. A JSON request keeps `{ message,
exception }` and gets the first `solution` beside them. 4xx errors, actions, islands and uploads keep their answers; an app's
own `ExceptionHandler` keeps its own answer unless it renders the error page.

**Server-rendering errors** still fall back to rendering in the browser — and, in development, go to **Vite's overlay** with
the code frame of the view (mapped to the source by `ssrFixStacktrace`) and their solutions: to the tabs connected now
(`hot.send`) and into the failed document itself (Vite keeps an error for a tab only while no tab is connected).

**Only in development** (E115): the gate is `ServerConfig.debug` — `NODE_ENV === 'development'`, never "not production". In
production, staging or tests nothing of it is loaded (the kernel `import()`s the page's code only in debug mode), the
request recorder is not bound and subscribes to nothing, and the error page shows neither stack nor queries, headers or code.
Tests ask for it with `createTestApp(app, { debug: true })` ([@marmeon/testing](../testing/README.md#createtestappapp-options)).
