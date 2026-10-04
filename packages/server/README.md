# @bespokecore/server

The HTTP server of a BespokeCore app: the kernel (Hono for matching, the BespokeCore router for the typed pipeline), server
rendering through Vite in development and through the build in production, islands and layers resolved in-process, the health
endpoints and `startServer()` with a graceful drain. `bespoke dev` and `bespoke start` run it
([@bespokecore/cli](../cli/README.md#commands)); an app rarely calls it itself. Its `ServerServiceProvider` is found by
`bespoke discover`. Vite is an optional peer: `bespoke dev` and `bespoke build` need it (`pnpm add -D vite @bespokecore/vite`),
a production server never loads it. Routes, controllers and responses are [@bespokecore/router](../router/README.md) and
[@bespokecore/http](../http/README.md); what goes over the wire is [the protocol](../http/README.md#the-protocol).

## Configuration

`ServerConfig` (`static config` of the provider) — every variable is optional:

| Variable | Default | What |
| --- | --- | --- |
| `PORT` | `3000` | the port `startServer()` listens on |
| `MAX_BODY_SIZE` | `8m` | the largest request body: bytes, or `512k`, `8m`, `1g` |
| `TRUSTED_PROXIES` | — | proxies whose `X-Forwarded-For` is believed, comma-separated IPs, or `*` behind the app's own proxy only; without it the client's address is the peer's |
| `ASSET_VERSION` | the build's | the asset version a new deployment answers 409 for — e.g. the git commit; in production by default a hash of the built `index.html` |
| `SSR_ENABLED` | `true` | `false`: no server rendering, the browser renders every page (one page: `Page.ssr = false`) |
| `HEALTH_PATH` | `/up` | where the health endpoints answer (readiness below it); `off`: none ([Health](#health-e126)) |
| `NODE_ENV` | — | `development` turns on the error page, `Server-Timing` and `DevDocument` — nothing else does (E115) |

## The kernel

`createHttpKernel(app, options?)` turns the app's routes into a Hono app — what `startServer()` serves and what tests call
in-process (`createTestApp`, [@bespokecore/testing](../testing/README.md)). Per request:

- **a container scope of its own** — controllers and middleware are built from it, so scoped services live as long as the
  request; the request id (`x-request-id`: the client's when it is a sane one, else generated) is set as the request context
  and answered in the response header;
- **method spoofing** (E64): a form's POST with `_method=PUT|PATCH|DELETE` in its body is routed as that method — never from the
  query, never to GET;
- **the body** is read once, by its route, up to `MAX_BODY_SIZE`;
- **errors** — thrown, `abort()`ed or an unknown path — go through the app's `ExceptionHandler` (`@bespokecore/http`); an
  unknown path still passes the global middleware first;
- **read-only requests:** an island's, a live validation, an upload's target, an event stream and a layer's base resolved for
  its deep link change no session, cookie or work after the response; nor does any request once its headers are out (a
  streamed page's deferred props). A write there throws outside production and is dropped and logged in production;
- **after the response:** `afterResponse.defer(…)` work and `terminate` hooks run once the response is out, outside of any
  transaction (E107);
- **islands and layers** are resolved in-process while a page renders: a GET of the island's URL through its own route's
  middleware and authorization, with the page request's cookies (10 s limit, then the island's error); a layer's base the same
  way for a deep link ([The protocol](../http/README.md#the-protocol));
- **in production**, `/assets/*` is served from `dist/client`.

**Server rendering:** a page renders on the server until its shell, then streams (islands and deferred props into the same
response, E49); crawlers and link previews get the whole page at once. When the shell cannot render, the document goes out
without markup and the browser renders the page — what an adapter's SSR entry does is in
[What an adapter provides](../http/README.md#what-an-adapter-provides).

## `startServer` and the drain

```ts
const server = await startServer({ app });   // port: ServerConfig.port; mode: development only when NODE_ENV=development
// …
await server.close();                         // on SIGINT/SIGTERM — bespoke dev and start do this themselves
await app.shutdown();
```

- **development** (`mode: 'development'`; the default only with `NODE_ENV=development`, E115 — never "anything but production"):
  the app's Vite in middleware mode — HMR, source modules, `/__open-in-editor`, the SSR entry of the `bespoke()` plugin
  (`bootstrap/ssr.tsx`). Without Vite or without the plugin it fails with a `ViteSetupError` that says what to install. `bespoke
  dev` sets `NODE_ENV=development` when it is unset; with another `NODE_ENV` (`staging`, `test`) it serves the build and says so;
- **production** (the default with any other `NODE_ENV`, also none): the built `dist/client/index.html` and
  `dist/server/ssr.js`, loaded once; without them the start fails with "No production build in dist/client — run bespoke
  build first."

`close()` stops gracefully (E102): live streams end first (a tab connects to the next server), no new connections, idle
keep-alive connections close, requests in flight finish, then the work they deferred until after their response — at most
`drainTimeoutMs` (8 s) — before the caller shuts the app down and its pools close. `bespoke` exits after 10 s at the latest.
From the moment it closes, `/up` and `/up/ready` answer 503.

## Health (E126)

Two endpoints for load balancers and orchestrators, answered by the kernel **before anything else** runs for a request: no
middleware of any group (no session, no cookie, no CSRF), no request id, no log line, no `http.request` message — so neither a
span (`@bespokecore/otel`) nor a devtools entry. Responses are `Cache-Control: no-store`; `HEAD` works too.

| | Answers | Checks |
|---|---|---|
| `GET /up` — liveness | `200 OK` once the app booted; `503` from the moment the server closes (the drain of E102) | nothing else — a database outage must not get a healthy process restarted |
| `GET /up/ready` — readiness | `200 {"status":"ok"}`; `503 {"status":"failing"}`; `503 {"status":"draining"}` while the server closes | every `HealthCheck` ([core](../core/README.md#health-checks-e126): database, redis, cache, queue and the app's own), at once, each with its time limit (2 s) |

```yaml
# Kubernetes
livenessProbe:  { httpGet: { path: /up, port: 3000 } }
readinessProbe: { httpGet: { path: /up/ready, port: 3000 }, periodSeconds: 10 }
```

- **Details only in development** (`ServerConfig.debug`, `NODE_ENV=development`): then `/up/ready` names each check with its
  status (`ok`, `failing`, `timeout`), time in ms, note (`default, system`, `database, 3 waiting`) and error — redacted (E125).
  Elsewhere the answer is the status only: what an app depends on and how it fails is nobody's business outside.
- **One run at a time:** probes arriving while the checks run share that run — a burst of probes is one `select 1`.
- **Readiness falls first:** a deployment's `SIGTERM` closes the server — from then on both answer 503 on connections still
  open, while requests in flight finish and work after the response drains.
- **The checks' own queries leave no span** (a statement outside every span is not traced) — the probes do not flood a trace
  backend.
- **Where:** `HEALTH_PATH` moves them (`/healthz` → `/healthz`, `/healthz/ready`); `HEALTH_PATH=off` turns them off. A route of
  the app on one of the two paths fails the start — it could never be reached: `The route "status" (GET /up) is where the health
  check answers (E126) — it would never be reached. Give the route another path, or move the health check: HEALTH_PATH=/healthz
  (or HEALTH_PATH=off).` (A route with a parameter, `/:page`, simply never sees `up`.)

## The request log line

Every request writes one entry on the `http` channel — `GET /users/7 200` with `{ requestId, route: 'users.show', ms }`
(`route` only for a named route). The kernel answers with the request's id (`x-request-id`, taken from the request when it
is a sane one, else generated); every log entry of the request carries it — and, with `@bespokecore/otel`, the request span's
`trace_id` and `span_id` (the line is written inside the span). Its path is redacted (E125): a sensitive route parameter
(`/reset-password/:token`) and a token-like segment of a path without a route become `[redacted]`.

## Observation (E118)

The kernel traces each request on the `http.request` channel of `@bespokecore/core/diagnostics` — method, path, URL and
headers (raw), route name and pattern, controller, status, duration, where the response sends the browser (`location`: a
redirect's target or the protocol's 409 reload, with its `reload` reason) — and sends the error a request ends in to `exception`;
server rendering goes to `render.ssr`. Without a subscriber none of it is built. The channels and their messages:
[Diagnostics](../core/README.md#diagnostics-bespokecorecorediagnostics-e118); the spans made of them:
[@bespokecore/otel](../otel/README.md). The health endpoints are not traced.

## `Server-Timing` (E129) — development only

With `NODE_ENV=development` (`bespoke dev` sets it when it is unset) every response says what its request spent:

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

With `NODE_ENV=development` (`bespoke dev`), a page request that fails with a 5xx gets the **development error page** instead
of the app's `errors/Error` view:

- **head:** status, error class, message (and causes), the request and its route — and the **solutions** (E130): what to do,
  why, a command to copy, the README to read;
- **stack:** the app's frames first, each with its code (±8 lines, the throwing line marked) and an *open in editor* link
  (Vite's `/__open-in-editor`); Node runs the TypeScript as written and the injection transform keeps every line, so the
  line is the line that threw;
- **request** (method, URL, headers, query, body), **route** (name, pattern, controller, middleware, parameters), the
  request's **queries** (up to 100, with their duration) and **log** entries, **injection warnings** (E128), the
  **environment** (Node, `NODE_ENV`, the BespokeCore packages);
- **Copy as Markdown:** the same report as Markdown, for an issue or a chat (no source code, only where the frames are).

Everything on it — page and Markdown — passes the app's `Redactor` first (E125): cookies, `Authorization`, passwords,
tokens, hashes and the parameters of statements on secret columns never show.

It is one self-contained HTML document — its own CSS (light and dark), no React, no Vite, no app code — so it renders when
the views or server rendering are what broke. A client-side visit (`x-bespoke`) gets it as HTML too; the visit dialog
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
Tests ask for it with `createTestApp(app, { debug: true })` ([@bespokecore/testing](../testing/README.md#createtestappapp-options)).
