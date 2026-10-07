# @marmeon/log

The app's logger: [pino](https://getpino.io) behind the framework's `Logger` contract of `@marmeon/core` — pretty lines while
you develop, JSON lines for log shippers everywhere else. Every entry carries the request's id, or the job's or the scheduled
task's, and whatever the app's packages add (trace ids); secrets in the context are redacted by key before a line is written.

```ts
import { Logger } from '@marmeon/core';

// constructor(logger: Logger) — packages depend on the contract, never on pino
this.#logger.info('User signed in', { userId: user.id });          // message first, then the context — like Laravel
const log = this.#logger.child({ channel: 'billing' });             // bindings on every entry of the child
log.warn('Card declined', { invoiceId, attempt: 2 });
```

`marmeon discover` registers its `LogServiceProvider` through the `"marmeon"` field of its package.json; it binds `Logger` as a
singleton. Without the package the core's `ConsoleLogger` is used — one line per entry on stdout/stderr, the same context.

## Configuration

```sh
LOG_LEVEL=info      # trace | debug | info | warn | error | fatal | silent — default info
LOG_FORMAT=json     # pretty | json — default: pretty with NODE_ENV=development only, json everywhere else
```

The default is fail-closed (E139, E164): a worker started without `NODE_ENV`, a staging server and a test log JSON — only
`NODE_ENV=development` (what `marmeon dev` sets, or the app's `.env`, E170) logs pretty lines. `LogConfig` resolves them to
`{ level, format }`. **`pretty`** writes colored lines through `pino-pretty` (synchronously, without `pid` and `hostname`; loaded
only for a pretty logger — JSON logs never import it, E138); **`json`** one JSON object per line on stdout — pino's `level`
(30 = info), `time` (ms), `msg`, then the context, no `pid`/`hostname`. The web app's tests run with `LOG_LEVEL=silent`
(`.env.test`). `logger.enabled(level)` says whether an entry would go anywhere — written at this level, or seen on the `log`
channel (the devtools listen to every level): the kernel asks before it builds the request line and redacts its path, so
`silent` (or `warn`) costs no request anything (E187). On the `Logger` contract it is optional (`enabled?`): a logger of your
own without it counts as enabled, and so does the core's `ConsoleLogger`, which knows no `LOG_LEVEL`.

```json
{"level":30,"time":1759574400000,"channel":"http","requestId":"9f1c…","route":"users.show","ms":12,"msg":"GET /users/7 200"}
```

## The log context

Every entry gets what is running when it is written — nothing to pass by hand:

- **in a request:** `requestId` — the id the kernel answers with in `x-request-id`;
- **in a job attempt:** `job`, `jobId` and `attempt` (a job run inside a request — `sync` — has both);
- **in a scheduled run:** `task` (`session:prune`);
- **from the app's log context sources:** `LogContextSources` of `@marmeon/core` — one per app — adds fields to every entry;
  `@marmeon/otel` adds the active span's `trace_id` and `span_id`. A source runs for every entry: keep it cheap, return
  nothing when it has nothing to add, and remove it in your provider's `shutdown()`:

  ```ts
  const tenant = new AsyncLocalStorage<string>();   // set by the app's tenant middleware
  const off = app.container.make(LogContextSources).add(() => {
    const id = tenant.getStore();
    return id ? { tenant: id } : undefined;
  });
  // shutdown(): off();
  ```

A key a child logger is bound with already (the scheduler binds `task`) is written once, not twice.

## The request log line

The HTTP kernel of `@marmeon/server` writes one `info` entry per request on the child `{ channel: 'http' }`:
`GET /users/7 200` with `{ route: 'users.show', ms: 12 }` (`route` only for a named route) — plus the request's `requestId`, and
with `@marmeon/otel` the request span's `trace_id` and `span_id`. Paths only: the query string is not logged. See
[the request log line](../server/README.md#the-request-log-line); the health endpoints write none.

## Redaction

Before pino writes an entry, its context goes through `redact()` of `@marmeon/core` (re-exported here with
`REDACTED_KEYS`): every key that looks like a secret — `password`, `new_password`, `secret`, `token`, `authorization`, `cookie`,
`remember_web`, `api_key`, `signature` … — has its value replaced by `[redacted]`, in nested objects, lists, maps and sets too
(six levels deep; deeper is left out as `[…]`). The bindings of a child logger (`logger.child({ token })`) go through it as
well — pino writes them once, when the child is made. An error stays an error of its class (pino's `err` serializer still
knows it), with its message and stack masked as text, its own fields redacted by key and its causes alike. The console
fallback (`ConsoleLogger`, without this package) redacts the same way:

```ts
logger.info('Login failed', { email, password, headers: { authorization: 'Bearer …', accept: 'application/json' } });
// {"msg":"Login failed","email":"ada@example.com","password":"[redacted]","headers":{"authorization":"[redacted]","accept":"application/json"}}
```

**Messages are not scanned**: never put a secret into the message text (the request log line masks its path itself: a
sensitive route parameter or a token-like segment becomes `[redacted]`). The queue stores a failed job's error through
`redactText()` (passwords in SMTP errors) — see [redaction](../core/README.md#redaction-e125) for the `Redactor` the error page,
the devtools and telemetry use, which also scans text.

## The `log` channel (E118)

With the app (the provider passes it), every entry also goes to the `log` channel of
[`@marmeon/core/diagnostics`](../core/README.md#diagnostics-marmeoncorediagnostics-e118) while something listens — at
**any** level, before pino's level filter — as a `LogMessage` with `level`, `message`, `context` (the bindings of the logger and
all its parents, then the entry's context) and the `requestId`, `jobId` and `task` of what is running. The devtools
recorder and the development error page (the request's log entries) read it. Without a subscriber nothing is built; the channel
carries the context **raw** — whatever records or shows it redacts first. A subscriber of `log` must not log itself.

```ts
import { channels } from '@marmeon/core/diagnostics';

const off = channels.subscribe(app, 'log', (entry) => { … });   // only this app's entries; off() in shutdown()
```

## Testing

`createPinoLogger(config, destination?, app?)` builds the same logger on a stream of your own — to read the JSON lines in a test,
bind it in place of the app's ([@marmeon/testing](../testing/README.md)):

```ts
import { Writable } from 'node:stream';
import { Application, Logger } from '@marmeon/core';
import { createPinoLogger } from '@marmeon/log';
import { createTestApp } from '@marmeon/testing';

const lines: Record<string, unknown>[] = [];
const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(JSON.parse(String(chunk))), done()) });
const app = await createTestApp(application, {
  override: (container) => container.instance(Logger, createPinoLogger({ level: 'info', format: 'json' }, stream, container.make(Application))),
});
```

A destination replaces `pino-pretty`: the lines are JSON whatever `format` says. Without the `app`, entries carry no fields of
log context sources and go to no channel. To assert on log entries without parsing lines, subscribe to the `log` channel instead.
