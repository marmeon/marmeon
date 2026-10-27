# Logging

## Introduction

A service logs through the `Logger` of `@marmeon/core`. It gets the logger injected, writes a message, and adds what else matters
as a context object:

```ts title="modules/notes/NoteImporter.ts"
import { Logger } from '@marmeon/core';

export class NoteImporter {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async import(userId: number, rows: readonly string[]): Promise<void> {
    this.#logger.info('Notes imported', { userId, count: rows.length });
  }
}
```

While you develop, the entry is a colored line in your terminal. On a server it is a line of JSON for a log shipper. Every entry
carries the id of the request it was written in, or the job's or the scheduled task's, and keys that look like a secret are
masked before the line is written.

## Writing log entries

`Logger` has a method per level, each with the message first and an optional context: `debug()`, `info()`, `warn()` and
`error()`. Keep the message fixed and put the values into the context, so a log shipper can group and search the entries.

`child(bindings)` returns a logger that adds its bindings to every entry:

```ts
const log = this.#logger.child({ channel: 'billing' });
log.warn('Card declined', { invoiceId: 7, attempt: 2 });
```

`enabled(level)` tells whether an entry at that level goes anywhere. Ask it before you build a context that costs something to
compute. It is optional on the contract: a logger without it counts as enabled.

Your code depends on the `Logger` token, never on a logging library. `@marmeon/log`, which every new app has, binds it to a logger
built on pino. Without the package, a minimal console logger writes one line per entry with the same context.

Run with `--json`, a `marmeon` command sends every line of `@marmeon/log` and of the console logger to stderr, so stdout holds the document only. A logger of your own decides where it writes.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | The lowest level written: `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |
| `LOG_FORMAT` | `pretty` with `NODE_ENV=development`, else `json` | `pretty` for people, `json` for log shippers. |

The default format fails closed. Only `NODE_ENV=development`, which `marmeon dev` and a new app's `.env` set, gives pretty lines.
Production, a staging server among them, a worker started without `NODE_ENV` and a test log JSON. A new app's `.env.test` sets `LOG_LEVEL=silent`, so tests
write nothing.

A JSON line holds pino's numeric level, the time in milliseconds, the environment's name as `appEnv`, then the context, and the
message as `msg`:

```json
{"level":30,"time":1759574400000,"appEnv":"staging","channel":"http","requestId":"9f1c…","route":"notes.show","ms":12,"msg":"GET /notes/7 200"}
```

`appEnv` is `APP_ENV`, or the name that goes with `NODE_ENV` when it is not set: `production`, `local` or `testing`. A log shipper
that collects several environments tells them apart by it. The
[configuration](configuration.md#app_env-the-environments-name) page explains the name.

The levels are numbers: 20 for `debug`, 30 for `info`, 40 for `warn`, 50 for `error`. The framework writes entries from `debug` to `error`; `trace` and `fatal` are for loggers of your own. Neither format writes the process id or the
host name.

### The fields of a JSON line

These field names and their meaning are [public API](releases.md#what-is-public-api); a new field is not a break, and the text of a
message is not part of it.

| Field | Meaning |
| --- | --- |
| `level` | Pino's number for the level. |
| `time` | When the entry was written, in epoch milliseconds. |
| `msg` | The message. |
| `appEnv` | The environment's name, see above. Absent when the app has none. |
| `requestId` | The id of the request the entry was written in, the one `x-request-id` carries. |
| `job`, `jobId`, `attempt` | The job that was running, its id and its attempt. |
| `task` | The scheduled task that was running. |
| `trace_id`, `span_id`, `trace_flags` | The active span, with `@marmeon/otel`: its W3C trace flags as two hex digits (`01` = sampled). |
| `err` | An error the app logs as `{ err: error }`: `type`, `message` and `stack`. The fields the framework writes for its own errors (`exception`, `stack` and sometimes `message`) are not part of the frozen set yet. |

The fields keep the framework's values: a key of the context you pass to a log call that names one of them (every field of the table except `err`) is written as `context.<key>`. Data you log, such as a webhook payload, cannot forge a level or a request id that way. The bindings of a child logger are not renamed.

## The log context

Every entry gets the context of what is running when it is written, with nothing to pass by hand:

| Running | Fields |
| --- | --- |
| A request | `requestId`: the id the response carries in `x-request-id`. |
| A job | `job`, `jobId` and `attempt`. A job that runs inside a request has the request's id too. |
| A scheduled task | `task`, such as `session:prune`. |

Your app can add fields to every entry with a log context source, and the OpenTelemetry package adds the active span's `trace_id`,
`span_id` and `trace_flags` the same way. The [context](context.md#adding-fields-to-every-log-entry) page shows how. A key that a child logger
is bound with already is written once, not twice.

## The request log line

The server writes one `info` entry per request, on the channel `http`: `GET /notes/7 200`, with the route's name and the time it
took in milliseconds. A route without a name has no `route` field. The line holds the path only, never the query string, and a
route parameter that looks like a secret, such as the token of `/reset-password/:token`, is masked. The health endpoints write no
line.

The line is built only when it goes somewhere. With `LOG_LEVEL=warn` or `silent`, a request costs nothing for it.

## Keeping secrets out of the log

Before an entry is written, its context passes the app's `Redactor`. Every key that contains `pass`, `secret`, `token`,
`authorization`, `cookie`, `remember`, `apikey` with or without a `-` or `_`, `signature`, `credential`, `private_key`, `app_key`,
`encryption_key`, `session_id`, `jwt`, `dsn`, `recovery`, `cvv`, `cvc`, `card_number`, `mfa_code`, `two_factor_code`,
`verification_code` or `sms_code`, in any case, has its value replaced by `[redacted]`, the `REDACTED` constant of `@marmeon/core`, which a test compares with. So do keys that start with `otp` or
`totp`, have it after a `-` or `_`, or at a camel-case boundary (`otp_code`, `totpCode`, `userOtp`), and the keys that are exactly
`code`, `auth` or `x-auth`. So `password`, `new_password`, `privateKey` and `api_key` are masked, and so is a harmless
`passport`. The `code` of an error (`ECONNREFUSED`) stays, because it says what failed, and so do names such as `status_code`
and `footprint`. The names that packages
and your providers add with `addKeys()`, such as the name of the session cookie, are masked the same way:

```ts
logger.info('Login failed', { email, password, headers: { authorization: 'Bearer …', accept: 'application/json' } });
// {"msg":"Login failed","email":"ada@example.com","password":"[redacted]","headers":{"authorization":"[redacted]","accept":"application/json"}}
```

- Nested objects, lists, maps and sets are redacted too, down to six levels. Anything deeper is written as `[…]`.
- A child logger's bindings pass the redaction as well.
- An error is written as its `type`, `message` and `stack` under any key and at any depth, not only under `err`. The message
  and the stack name its causes, after `: ` and `caused by:`, and are masked as text. Its own fields are redacted by key, and
  the errors of an `AggregateError` go to `aggregateErrors`.
- A `URL` or `URLSearchParams` is written as text, masked: neither a `?token=` nor a token in the path survives. So is a string
  under any key that starts like a URL (`postgres://user:password@host/db?password=…`): the password of the URL and the values of
  sensitive query parameters go. The password goes to the last `@` before the query string, so one with a raw `@` or `/`
  (`app:p@ss/w0rd@db`) is masked whole, and so is it in the addresses `db:show` and the connection errors print. A raw `?` or
  `#` still ends it, as it ends the URL for every parser: percent-encode it.
- The console logger, which is used without `@marmeon/log`, writes every control and format character of a line as an escape: a line
  break in a message or a value (a decoded `%0A` in a route parameter) comes out as `\n`, so it cannot forge a line of its own.
  The pretty format of `@marmeon/log` does the same for the message and the stacks of errors. JSON lines escape it by themselves.
  A logger of your own that writes lines can call `escapeControls(line)` from `@marmeon/core` for the same escaping.

> [!WARNING]
> Only keys are checked. The message and the strings in a context are written as they are, so never put a secret into either.
> The exceptions are a string that holds a URL (`scheme://…`), whose password and the values of sensitive query parameters are masked,
> and the matches of [your own patterns](#patterns-of-your-own).
> Never turn an error into a string before you log it: `{ exception: String(error) }` is a string, and a connection URL with its
> password in the error's message goes out as it is. Log the error itself: `logger.error('Import failed', { err: error })`.

When you must log text that may hold a secret, mask it with the app's `Redactor`: take it in your constructor and call its
`text()` method. It takes out the values of sensitive keys such as `token=…`, bearer credentials, passwords in URLs, password
hashes, API tokens, JWTs, the `APP_KEY` form
(`base64:` and 32 bytes) and keys of well-known services by their prefix (`ghp_…`, `glpat-…`, `sk_live_…`, `whsec_…`, `npm_…`,
`AIza…`, `xoxb-…`, `AKIA…`). It also takes out the values of the names packages add, such as the session cookie's.
Words and path segments of 32 or more characters are masked when they look like a random token: mixed case, a digit and few
separators — not a slug, a UUID or a name in camel case (a pagination cursor like `?cursor=eyJ…` shows as `[redacted]` too). So a foreign error message that quotes a secret is masked too. The limits: a
hex secret without a key in front of it stays visible (a digest or a trace id is no secret), so do secrets under 32 characters
without a known prefix, and standard base64 with `+` or `/` is masked only in pieces of 32 or more characters. In text, `code`
counts as a name only in a query parameter (`?code=…`) or a JSON key (`"code":…`), and a private key in
PEM form is removed whole. `redactText()` of `@marmeon/core` does the same with the core's list alone, for code that runs without an app: the
names and patterns your app adds need the app's `Redactor`.

Every error entry of the framework passes the app's `Redactor` as text: the log line of a server error, server rendering,
islands, work after the response, scheduled tasks, live updates, session clean-up, the listeners of job events, failed jobs, and lost
database and Redis connections.
A failed job's text in `failed_jobs` is cut at 64 KB.

### Patterns of your own

A secret in a format only your app knows, such as the key of a partner or an IBAN, is in no list of the core. Name the format once in
`bootstrap/app.ts`, together with the field names the core does not know:

```ts title="bootstrap/app.ts"
export default defineApplication({
  root: import.meta.dirname,
  redact: {
    keys: ['iban'],
    patterns: [/\bacme_live_[A-Za-z0-9]{32}\b/],
  },
});
```

Every redactor of the app has them from the start: the log, failed jobs, the development error page, the devtools, the traces of
the OpenTelemetry package, the live updates, and the report of `marmeon check` for an app that could not start. A package adds the
same from a provider's `boot()` with `app.container.make(Redactor).addKeys(…)` and `.addPatterns(…)`.

- The whole match becomes `[redacted]`. A match of length 0 (a lookaround alone) changes nothing.
- A pattern works on every string the redactor sees: text, the values of a context, headers, queries, the text of a stored error.
  Unlike the core's own patterns, it also works on the plain strings of a log context. It does not work on the message: that is
  code, and data belongs in the context. Your patterns add to the core's lists; the core's cannot be shortened.
- Whether a pattern has `g` makes no difference, and neither does the `lastIndex` of your object: the redactor keeps its own copy.
- A pattern runs on text of attackers' choosing (a path, a body), so a pattern that can stall the match stops the start with
  `K15`: one that is sticky (`y`), one that matches the empty string (`/a*/`), one with a back-reference (`\1`, `\k<name>`), and a
  repeated group that holds a repeat without limit (`(a+)+`, `(\w+\s?)*`, `(a+){3}`). The message names the pattern and the reason.
- A pattern runs on every string the app logs, including input from requests, so write it to match in linear time: prefer a fixed length or a bounded repeat (`[a-z0-9]{24}`, `{1,64}`) and a literal prefix or a `\b` anchor over an open `+` or `*`, and keep repeats over the same characters apart. The check is a safety net, not a proof: a repeated alternation with overlap such as `(a|a)*`, and adjacent repeats over the same characters such as `\w+\w+\w+x`, pass it and can still be slow.

### What the framework shows elsewhere

The development error page, the devtools and the traces of the OpenTelemetry package show far more than a log line: headers,
request bodies, queries, payloads of jobs. They pass the same `Redactor` as the log, and use more of it:

- **By key**, at any depth, with the same list and the names packages add, such as the name of the session cookie.
- **In every string**, as `redactText()` does, with the added names' values too.
- **Queries** on a table with secret columns show none of their parameters.
- **Encrypted payloads**, such as a job marked as encrypted, show as `[encrypted]`.
- **Paths and URLs** by their route: the values of sensitive route parameters are replaced.
- **Files and bytes** only by their size. Every string is cut at 64 KB, and so is a recorded entry as a whole.

Your own code can use it, say for a page of your own that shows recorded data:

```ts title="modules/system/AuditTrail.ts"
import { Redactor } from '@marmeon/core';

export class AuditTrail {
  readonly #redactor: Redactor;

  constructor(redactor: Redactor) {
    this.#redactor = redactor;
  }

  describe(request: Request, body: Record<string, unknown>): unknown {
    return { url: this.#redactor.url(request.url), headers: this.#redactor.headers(request.headers), body: this.#redactor.value(body) };
  }
}
```

The redaction is a safety net, not a guarantee: a secret quoted in free text under a harmless name still shows.

## Testing

A new app's tests write no log. To read the lines in a test, build the same logger on a stream of your own and bind it in place of
the app's:

```ts title="modules/notes/logging.test.ts"
import { Writable } from 'node:stream';
import { Application, Logger } from '@marmeon/core';
import { createPinoLogger } from '@marmeon/log';
import { createTestApp } from '@marmeon/testing';
import { expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';

it('logs one line per request', async () => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({ write: (chunk, _encoding, done) => (lines.push(JSON.parse(String(chunk))), done()) });
  const app = await createTestApp(application, {
    override: (container) => container.instance(Logger, createPinoLogger({ level: 'info', format: 'json' }, { destination: stream, app: container.make(Application) })),
  });
  await app.get('/nothing-here').assertNotFound();
  expect(lines.some((line) => line.channel === 'http')).toBe(true);
});
```

A stream of your own always gets JSON, whatever `format` says. A logger with its own `destination` keeps writing to it, also under `--json`. Without the `Application`, the entries carry no fields of the app's
log context sources. To assert on entries without parsing lines, listen on the `log` channel instead, which the
[observability](observability.md#the-log-channel) page explains.
