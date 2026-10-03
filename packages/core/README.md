# @bespokecore/core

The application kernel: the service container with constructor injection (generated `static inject` lists, no
decorators), providers, configuration, events, the clock, the request/job context and the ambient transaction context.
Every other package builds on it. This README covers its observation points so far; the rest follows with the docs app.

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
