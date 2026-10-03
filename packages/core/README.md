# @bespokecore/core

The application kernel: the service container with constructor injection (generated `static inject` lists, no
decorators), providers, configuration, events, the clock, the request/job context and the ambient transaction context.
Every other package builds on it. This README covers its observation points, redaction, error solutions and what the
container's errors and warnings mean; the rest follows with the docs app.

## Diagnostics: `@bespokecore/core/diagnostics` (E118)

The framework reports what it does on `node:diagnostics_channel` **TracingChannels** — the channel kind the Node ecosystem
(undici, fastify, node-redis, …) uses. The error page, the devtools recorder, the debug bar, `Server-Timing` and
`@bespokecore/otel` subscribe to them; apps keep using events (job events, scheduler events) for their own reactions.

```ts
import { channels } from '@bespokecore/core/diagnostics';

// in a provider's boot(app):
this.#off = channels.subscribe(app, 'db.query', {
  start: (query) => { … },                                    // before (db.query: once it ended — Kysely reports afterwards)
  end: (query) => console.log(query.sql, query.durationMs, query.requestId ?? query.jobId),   // after, ok or failed
  error: (query) => { … },                                    // failed (before end), with query.error
});
channels.subscribe(app, 'log', (entry) => { … });             // a plain channel: one handler
// in its shutdown(): this.#off();
```

- **Nothing is built without a subscriber:** every place that publishes asks `hasSubscribers` first. `channels.built(app)`
  counts the messages built for an app (0 while nobody listens — the tests prove it).
- **Every message names its app** (`message.app`): `channels.subscribe(app, …)` passes on only that app's messages — two
  apps in one process (parallel tests, a worker beside a server) never see each other's. A subscription is the
  subscriber's: `off()` ends it, a provider calls it in `shutdown()`. The channels themselves are Node's, process-wide —
  the only shared part.
- **Raw values:** queries carry their parameters, log entries their context, exceptions the error. Whatever records or
  shows them redacts first (E125); `db.query`'s `secret` says when a statement touches secret columns.
- **A subscriber that throws** is reported as a process warning (`BespokeDiagnosticsWarning`); the operation goes on. A
  `log` subscriber must not log itself.
- **Types:** `ChannelMessage<'db.query'>` is `DbQueryMessage`, and so on; a wrong field or channel name is a compile
  error (`Property 'route' does not exist on type 'DbQueryMessage'.`, `Argument of type '"db.querry"' is not assignable
  to parameter of type 'ChannelName'.`).

### The channels

Node names the traced ones `tracing:bespoke:<name>:{start,end,asyncStart,asyncEnd,error}`; the plain ones `bespoke:<name>`.

| Channel | Where | Message (besides `app`, `startedAt`, `requestId?`, `jobId?`, `task?`, `durationMs`, `error`) |
|---|---|---|
| `http.request` | the kernel, per request (also an island or a layer's base resolved in-process) | `HttpRequestMessage`: `method`, `path`, `region`, `inProcess`, `route` (name), `routePath` (pattern), `controller`, `status` |
| `db.query` | every statement of every connection | `DbQueryMessage`: `connection`, `sql`, `parameters` (raw), `secret` |
| `queue.dispatch` | `queue.dispatch()`, `bulk()`, `chain()` | `QueueDispatchMessage`: `kind`, `jobs`, `jobIds`, `connection`, `queue`, `delay`, `unique`, `traceparent` (a tracer sets it) |
| `queue.job` | each attempt (worker, `sync`, `app.queue.work()`) | `QueueJobMessage`: `job`, `jobId`, `queue`, `connection`, `attempt`, `originRequestId`, `traceparent`, `outcome` |
| `schedule.task` | each run of a scheduled task | `ScheduleTaskMessage`: `task`, `minute`, `reason`, `outcome`, `skipped` |
| `mail.send` | `mailer.send()`, `mailer.queue()`, the worker sending a queued mail | `MailSendMessage`: `mailable`, `mode` (`send`/`queue`/`worker`), `to`, `subject` |
| `notification.send` | `notifications.send()` (queued), each delivery | `NotificationSendMessage`: `notification`, `id`, `recipient`, `queued`, `channels`, `outcome` |
| `live.refresh` | a live hint going out (after its commit) | `LiveRefreshMessage`: `channel`, `only` |
| `render.ssr` | server rendering of a document, until its shell | `SsrRenderMessage`: `component`, `complete` (a crawler), `streamed` |
| `log` *(plain)* | every log entry, any level (before the logger's level filter) | `LogMessage`: `level`, `message`, `context` (bindings + context) |
| `exception` *(plain)* | an error a request ends in, on its way to the `ExceptionHandler` | `ExceptionMessage`: `error`, `status`, `method`, `path` |

- **Correlation (E131):** `requestId` is the request's `x-request-id` (the kernel answers with it); a job dispatched in a
  request keeps it as `originRequestId`. Queries, mails, notifications and log entries carry the `requestId` or `jobId` of
  where they happen.
- **Trace context:** a tracer binds its context store to a channel (`channels.tracing('http.request').start.bindStore(…)`);
  operations run inside `start.runStores`, so spans nest. On `queue.dispatch` it sets `message.traceparent` in `start` —
  the job stores it, its `queue.job` message carries it to the worker. A raw subscriber hears every app: compare
  `message.app` itself.
- **Publishing (packages):** `messageBase(app)` (the common fields — counts as a message built), `trace(channel, message,
  fn, finish?)` (start → end → error → asyncStart → asyncEnd, `durationMs` set first) and `publishEnded(channel, message)`
  for an operation that already ended. Always behind `channel.hasSubscribers`.

## Configuration

Packages, modules and the app declare their environment as config definitions (`defineConfig(name, { env, resolve })`,
validated with any Standard Schema). The app validates **all** of them before anything registers: a missing or invalid
variable stops the start with one `ConfigError` that lists every problem (`• encryption: APP_KEY — Missing — run "bespoke
key:generate"`). Variables come from `.env`, then `.env.{NODE_ENV}` (`.env.test`) on top, then the real environment, which
wins. `bespoke` prints how to fix it below the error (the solutions, E130).

## Constructor injection

App code gets its `static inject` lists from the injection transform (the loader of `bespoke dev`/`start`, the `bespoke()`
Vite plugin for Vitest and SSR); packages get them from `bespoke package:build`. A parameter is injectable when its type is a
class or a token that exists at runtime (a value import — not `import type` — or a declaration in the module). Interfaces are
injected through a token of the same name: `export const Mailer = token<Mailer>('Mailer')`. A class that declares its own
`static inject` is left alone.

**Defaulted and optional parameters end the list** — JavaScript's default applies. When such a parameter has an injectable
type (`clock: Clock = new SystemClock()`), the container would never inject it: a provider's or a test's binding never
reaches the class. The transform marks the class, and the container reports it **once per class when it first builds it**
(E128) — a warning, never an error:

```text
[warn] Injection: PruneTokensJob (modules/auth/jobs/PruneTokensJob.ts:5): the parameter "clock: Clock = new SystemClock()" is
defaulted, so the container never injects Clock — its default is always used, also when a provider or a test binds another
Clock. Remove the default to have it injected, or write `static inject = [...]` to make the choice explicit.
```

The log line is written in development (`NODE_ENV=development`); `container.warnings` keeps them for the development error
page, and `container.onWarning(listener)` hears them. A tree's `parent?: Self` is no dependency and gets no warning.

## The container's errors

A `ContainerError` says why (`reason`), what (`key`) and who asked (`path`, `neededBy`):

| `reason` | Means | The fix |
|---|---|---|
| `unbound` | An interface's token has no binding. | Bind it in a provider's `register()` (`container.singleton(Mailer, SmtpMailer)`), or install the package that does (`bespoke discover`). |
| `scoped` | A per-request (scoped) service resolved outside a scope — or by a singleton, which would keep the first request's. | Resolve it from the request's scope (inject it into a controller, middleware, listener); a singleton that needs it becomes scoped too. |
| `no-injection-list` | A class with constructor parameters but no list — `injection` says what the transform could not inject (a number, a type-only import, a missing annotation). | Inject classes and tokens; primitives come from a config object. |
| `circular` | `A → B → A`. | Move what both need into a third class, or pass one of them per call. |

## Redaction (E125)

`Redactor` (one per app: `app.container.make(Redactor)`) is the one place that decides what of a value may be shown or
recorded — the development error page and its Markdown copy now, the devtools recorder and telemetry spans later. It is on
by default, also locally:

- **by key**, at any depth: `REDACTED_KEYS` (passwords, tokens, secrets, cookies, `authorization`, signatures — so also
  `set-cookie`, `x-xsrf-token`, `_token`) and the names packages add — the session's cookie name (`addKeys`);
- **in text** (`redactText`): values of sensitive keys (`password=…`, `"token":"…"`, `?signature=…`), bearer credentials,
  URL passwords, password hashes (`$argon2id$…`, `$scrypt$…`) and API tokens (`bc_12|…`, any prefix), plus the added names'
  values (`bespoke_session=…`);
- **statements** that touch a table with secret columns (`DbQueryMessage.secret`) show none of their parameters;
- **files and bytes** only by their size; every string is cut at 64 KB.

```ts
const redactor = app.container.make(Redactor);
redactor.value({ email, password, avatar });   // { email, password: '[redacted]', avatar: '[file me.png, 5120 bytes, image/png]' }
redactor.headers(request.headers);             // cookie, authorization, x-xsrf-token → '[redacted]'
redactor.query(message);                       // { sql, parameters } — all '[redacted]' when message.secret
```

A safety net, not a guarantee: a secret quoted in free text under a harmless name still shows. Never put secrets into
messages.

## Solutions (E130)

The development error page shows **solutions** for errors it knows: a title, a text, a command to copy and a README anchor.
They are **text only** — no endpoint runs anything (Ignition's runnable solutions were CVE-2021-3129). A package lists its
solutions on its provider; an app can do the same:

```ts
import { defineSolutions } from '@bespokecore/core';

export class PaymentsServiceProvider {
  static solutions = defineSolutions([
    {
      for: PaymentError,                                  // the class (and its subclasses)
      when: (e) => e.code === 'declined',                  // optional: narrows it — `e` is a PaymentError
      solve: (e, { app }) => ({ title: 'Use a test card', text: '…', command: 'bespoke payments:cards', docs: 'README.md#cards' }),
    },
  ]);
}
```

`solve` may look things up (the database's solution asks the migrator for pending migrations) and may return nothing.
`ErrorSolutions` (`app.container.make(ErrorSolutions)`) holds every provider's solutions, then the core's, and `find(error,
{ app })` looks through the error and its causes. The core brings solutions for the container's errors, the injection
transform and invalid configuration; the packages add theirs (`http`: an undefined route name with "did you mean", a missing
view R2; `database`: a missing table and the pending migrations; `encryption`: a missing `APP_KEY`). `bespoke` prints them
too when the app cannot start.
