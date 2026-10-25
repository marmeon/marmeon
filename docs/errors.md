# Error Handling

## Introduction

An error thrown anywhere in a request, in a middleware, a binding or a controller, ends in the app's exception handler. The kernel logs
the error when it is a bug, and the handler turns it into the right answer: an error page for a browser, JSON for every other client. To stop a
request with a status of your choice, call `abort()`:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { abort, Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    if (ctx.params.note.archived_at !== null) abort(410, 'This note was archived.');
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

In development, a server error shows the development error page with the stack, the request and suggested solutions. In
production, the visitor sees the app's error page, and the log gets the details.

## Throwing HTTP errors

`abort(status, message?, headers?)` throws an `HttpError` and never returns. It works in a controller, a middleware, a binder and a
policy alike:

```ts
abort(404);
abort(403, 'Only the author may edit this note.');
abort(503, 'Down for maintenance.', { 'retry-after': '120' });
```

The message of an `HttpError` is meant for the client: the error page and the JSON answer show it. Without a message, the client
sees the status text, `Not Found` for a 404, in the request's language. A message may be a translation key, such as
`abort(403, 'notes.errors.not_yours')`, and the exception handler shows its text when the key exists.

`new HttpError(status, message, headers)` is the same error as a value, for code that builds it before it throws.

Some errors come with the framework:

| Error | Status | Thrown by |
| --- | --- | --- |
| `ValidationError` | 422 | A request's schema, or `throw new ValidationError({ title: ['…'] }, input)` in a controller. |
| `HttpError(403)` | 403 | A request's `authorize` that returns `false`. |
| `AuthorizationError` | 403, or 404 | A policy that says no, through `can()` or the gate. `denyAsNotFound()` makes it a 404. |
| `HttpError(404)` | 404 | A route that matches nothing, a binding that finds no record. |
| `HttpError(419)` | 419 | A form that fails the [CSRF](csrf.md) check by its token. |
| `HttpError(413)` | 413 | A body over `SERVER_MAX_BODY_MB`. |

A `ValidationError` thrown by your controller answers like a failed schema: the form goes back with the errors, and a JSON client
gets a 422.

## What the client sees

The exception handler decides by what the request asks for:

- **A page**, for a browser's request or a visit inside the app, renders the view `errors/Error` with the status. Its title is the
  status text, and its message is the `HttpError`'s message.
- **Anything else** gets JSON with the status: `{ "message": "Not Found" }`.
- **A validation error** goes back to the form with the errors and the input, or answers a JSON client with a 422 and
  `{ message, errors }`.

Because the answer depends on the request's headers, every error answer carries `Vary` for the ones it was chosen by (`Accept`
and `X-Marmeon`, and `X-Requested-With` for a validation error), so a shared cache keeps the page and the JSON apart. A `Vary` an
`HttpError` brings itself is kept; these are added to it.

Any error that is not an `HttpError` is a 500. Its own message never reaches the client in production: the page and the JSON say
`Server Error`, so a database error cannot show its query. The headers of an `HttpError` go out with the answer, so a 503 carries
its `Retry-After`.

An error becomes a response at the layer that threw it, so the middleware around it still runs. An error page carries the same
security headers and cookies as every other page.

### Your own error page

Until your app brings its own, a built-in error page shows the status, the title and the message. Yours replaces it as the view
`errors/Error`, which is the file `modules/errors/views/Error.tsx`:

```tsx title="modules/errors/views/Error.tsx"
import type { ErrorPageProps } from '@marmeon/http';
import { Head, Link } from '@marmeon/react';

export default function Error({ status, title, message }: ErrorPageProps) {
  return (
    <main>
      <Head title={title} />
      <p>{status}</p>
      <h1>{title}</h1>
      {message !== title && <p>{message}</p>}
      <Link href="/">Back to the start page</Link>
    </main>
  );
}
```

The page renders inside your default layout. A request that matches no route passes no group's middleware, so its 404 page has
no shared props: declare them optional, and let the layout render without them. `ErrorPageProps` also has `exception`, which holds
the error's name, message and stack only in development.

#### A page per status

A view named for a status comes before `errors/Error`: with `modules/errors/views/404.tsx`, a 404 shows that page, and every other
status still shows `errors/Error` (or the built-in page). The view takes the same `ErrorPageProps`. Only the exact status counts,
there are no patterns such as `4xx`. The server and the browser choose alike, so the page hydrates, and the page object still
says `errors/Error`: tests and `PageInfo.component` see no change. What follows the view's name does change: the default layout
of your app, `layout(name)`, is asked with `errors/404`, not with `errors/Error`. The same goes for an error while a page renders
(status 500, `errors/500`) and for the dialog that shows a 5xx over the page.

## Results

An exception is for what should not happen: a bug, a lost connection, a request that stops with a status. An outcome that
belongs to the work is a `Result` instead, such as an invitation that expired or an address another account has taken. The
caller sees it in the return type and has to handle it, and nothing is thrown or logged.

`ok(value)` and `err(error)` of `@marmeon/core` make the two sides. A `Result<T, E>` is plain data, `{ ok: true, value }` or
`{ ok: false, error }`. The error names its case in `kind`, with what the caller needs next to it. `err()` keeps the kind as a
literal and gives the rest its usual types, so `err({ kind: 'invalid', fields: ['email'] })` fits a declared `fields: string[]`:

```ts
accept(tokenHash: string, userId: number): Promise<Result<Member, { kind: 'expired' } | { kind: 'already-member'; teamId: number }>>
```

Inside, `return err({ kind: 'expired' })` ends with an error and `return ok(member)` with the value. `ok()` without a value is
for work that only succeeds or fails. The caller narrows the result over `ok`, then switches over `error.kind`:

```ts title="modules/teams/controllers/AcceptInvitationController.ts"
import type { Authenticated } from '@marmeon/auth';
import { abort, Controller, type HttpContext } from '@marmeon/http';
import { invitationTokenHash } from '../invitation-token.ts';
import { Invitations } from '../Invitations.ts';

export class AcceptInvitationController extends Controller {
  readonly #invitations: Invitations;

  constructor(invitations: Invitations) {
    super();
    this.#invitations = invitations;
  }

  async handle(ctx: HttpContext<Authenticated, { token: string }>) {
    const accepted = await this.#invitations.accept(invitationTokenHash(ctx.params.token), ctx.user.id);
    if (!accepted.ok) {
      switch (accepted.error.kind) {
        case 'expired':
          return abort(410, 'This invitation has expired.');
        case 'already-member':
          return this.redirect(`/teams/${accepted.error.teamId}`);
        default:
          return accepted.error satisfies never;
      }
    }
    return this.redirect(`/teams/${accepted.value.team_id}`);
  }
}
```

The `default` makes the switch exhaustive. It suits your own results and the framework's results listed
[below](#results-the-framework-returns), whose kinds are closed. When `accept()` gains a kind, the controller stops compiling
until it handles the new one:

```text
Type '{ kind: "banned"; }' does not satisfy the expected type 'never'.
```

A function with a declared return type needs no `default`: a missing case leaves its end reachable, and the compiler says so.
HTTP stays with exceptions: `findOrFail()` answers 404 by throwing, and `abort()` stops a request. Returned from the callback of
a transaction, an `err` rolls the transaction back, as the [transactions](transactions.md#returning-an-err) page explains.

### Results the framework returns

| API | `err` kinds | Page |
| --- | --- | --- |
| `repository.tryInsert()` | `duplicate` | [Queries](queries.md#writing) |
| `repository.tryUpdate()` | `duplicate`, `missing` | [Queries](queries.md#writing) |
| `auth.attempt()` | `invalid-credentials`, `two-factor-required`, `throttled` | [Authentication](authentication.md#signing-in) |
| `twoFactor.challenge()` | `no-challenge`, `expired`, `invalid-code`, `throttled` | [Two-factor authentication](two-factor-authentication.md#the-sign-in) |
| `twoFactor.confirm()` | `not-started`, `invalid-password`, `invalid-code`, `throttled` | [Two-factor authentication](two-factor-authentication.md#setting-up) |
| `SignInStore.consume()` | `invalid`, `stolen` | [Authentication](authentication.md#remember-me) |
| `AccountSessions.end()` | `missing` | [Authentication](authentication.md#ending-every-session-of-a-user) |
| `PasswordBroker.createToken()` | `unavailable` | [Password reset](passwords.md#asking-for-a-link) |
| `PasswordBroker.reset()` | `invalid-token` | [Password reset](passwords.md#resetting-the-password) |
| `PasswordResetTokenStore.create()` | `throttled` | [Password reset](passwords.md#a-store-of-your-own) |
| `PasswordResetTokenStore.consume()` | `invalid-token` | [Password reset](passwords.md#a-store-of-your-own) |
| `lock.get(callback)` | `locked` | [Cache](cache.md#locks) |

These `err` kinds are closed: a new kind comes only with a new method, never as a new member of an existing one. That is why an
exhaustive `switch` over them with `satisfies never` keeps compiling across minor versions. Other unions are open, as
[when a union grows](releases.md#when-a-union-grows) explains.

`SignInStore` and `PasswordResetTokenStore` are the contracts a store of your own implements, so the table lists the kinds
each has to return. A `get(callback)` whose callback returns a `Result` gives a nested one: the lock's `ok` holds the callback's
result. An exception from the callback is rethrown, not turned into an `err`.

Some of these `err`s must survive the transaction they are returned from, because the work behind them is a protective one. They
are made with [`commitAnyway()`](transactions.md#returning-an-err), and a store of your own does the same:

- `SignInStore.consume()` for `stolen` (all of the user's sign-ins are deleted, their tokens with them) and for `invalid` on an expired
  token (the token is taken off its sign-in).
- `PasswordResetTokenStore.consume()` and, through it, `PasswordBroker.reset()` for `invalid-token` on an expired token (the token
  is deleted). `reset()` also commits the `invalid-token` of an account that is gone, so that the token stays used up.

Every other `err` above commits nothing and rolls an enclosing transaction back when its callback returns it.

Where a kind would tell whether an account exists, it is left out on purpose. `attempt()` answers `invalid-credentials` for an
unknown identifier, a wrong password and an account without a password alike; `two-factor-required` is answered only after the
password was right. `reset()` answers `invalid-token` for an unknown
address and for a wrong, used or expired token. `createToken()` answers `unavailable` for an address without an account and for one
whose last link went out moments ago. Do not add kinds of your own that tell these apart.

Two calls are not `Result`s because nothing failed: a unique job that is already queued or running makes `dispatch()` return `undefined`, and
`job.once()` returns `false` when the work already ran. Yes-or-no questions, such as `lock.get()` without a callback
and `auth.check()`, stay `boolean`.

## Reporting

Every server error is logged at the `error` level: its message and its stack, masked as text by the app's `Redactor`, so a token, a
password in a connection string or the value of the session cookie does not reach the log. An `HttpError` with a status below 500 is
not reported: a 404 or a 403 is an answer, not a bug.

To send errors elsewhere as well, such as to an error tracker, write an error reporter. A provider brings it with
`static errorReporters`, next to its other statics, and the container builds it once:

```ts title="modules/system/TrackerReporter.ts"
import type { ErrorReport, ErrorReporter } from '@marmeon/core';
import { ErrorTracker } from './ErrorTracker.ts';

export class TrackerReporter implements ErrorReporter {
  readonly #tracker: ErrorTracker;

  constructor(tracker: ErrorTracker) {
    this.#tracker = tracker;
  }

  async report({ error, source, context }: ErrorReport): Promise<void> {
    // The report is frozen: a SDK that wants to change what it gets, or keep it, takes a copy.
    const copy = Object.assign(new Error(error.message), { ...error });
    await this.#tracker.capture(copy, { source, ...context });
  }

  // Optional: called when the app shuts down, to send what is still buffered.
  flush(): Promise<void> {
    return this.#tracker.flush();
  }
}
```

```ts title="modules/system/SystemServiceProvider.ts"
import type { ServiceProvider } from '@marmeon/core';
import { TrackerReporter } from './TrackerReporter.ts';

export class SystemServiceProvider implements ServiceProvider {
  static errorReporters = [TrackerReporter];
}
```

The Redactor masks secrets it recognises, not every value: an error whose message quotes data, such as a schema's `received "…"`,
reaches the reporter with it. Only a job's payload mismatch is reduced to its field names.

A reporter never sees the error itself. It gets an `ErrorReport` with the **masked view** only:

- `error.name` (the class name when it is an identifier, else `Error`), `error.message` and `error.stack`, each passed through the
  app's `Redactor`, so a connection URL, a token or the session cookie an error quotes is gone;
- `error.code` and `error.status`, when the error has them, and `error.cause`, masked the same way, at most five levels deep. A cause
  that leads back to an error already shown ends the chain;
- `source` and a `context` of masked texts, by what failed:

  | `source` | When | `context` |
  | --- | --- | --- |
  | `request` | A request ends in a server error, or work of a request that runs after its response fails (see below) | `method`, `route` (the route's name, empty when it has none), `path` (without its query, the segments of sensitive route parameters masked); `phase` for work after the response: `deferred`, `after-response` or `terminate` |
  | `job` | A job has failed for good: its last attempt, or an attempt that cannot be repeated (`job.fail()`, a payload that cannot run). Attempts that run again are only logged. | `job` (its name), `jobId`, `queue`, `connection`, `attempt`. Never the payload; a payload that no longer matches its schema is reported by the names of its fields, not the values the schema quotes |
  | `schedule` | A scheduled task throws | `task` (its name) |
  | `command` | A `marmeon` command ends with an error | `command` (its name). Never the arguments: they can carry secrets |

Every process that boots the app builds its reporters: each `marmeon` command and each worker too. A timer or a socket that the constructor opens needs `unref()` or a stop in `flush()`, or the process never ends; a heavy connection is better opened lazily, on the first `report()`.

The original error object, its own fields and the request are not part of it. The report is frozen, down to each cause, so one reporter
cannot change what the next one sees.

A reporter is built once, when the app boots, and runs outside any database transaction. If it cannot be built, the app does not start (`K12`): a wrong DSN must not turn reporting off unnoticed. A reporter cannot hold a request up or take the app down, as long as it does its work in the promise it returns; work it keeps running in the background itself (its memory, its concurrency, rejections nobody handles) is its own business:

- A request never waits for a reporter. The report is handed over after the log line, and what the reporter does with it happens on its own. A call that takes longer than 10 seconds counts as failed (a warning) but keeps its place until it really ends. A reporter whose calls never end gets no further reports until the app restarts.
- One that throws or rejects costs a warning in the log, once per report, and the other reporters still run. What a reporter throws is
  not reported again, and neither is an error that a reporter reports itself: that would be a loop.
- Each reporter has at most 100 reports open at a time. One that hangs fills its own limit and does not slow the others; its
  further reports are dropped (they are still logged), with one warning, and a line with the number of dropped reports follows in the log, at most once a minute,
  also while a flood goes on.
- When the app shuts down, `flush()` of each reporter is called before the providers shut down, while the open reports finish, and the
  shutdown waits at most 2 seconds for all of it. A reporter that is still busy then loses its reports and the shutdown goes on, with a warning.

Server errors of requests, jobs that failed for good, scheduled tasks and commands reach the reporters. So do the errors of work
that a request leaves for after its response: a deferred group that fails while the page streams (`phase: 'deferred'`; the browser
then loads the group itself, and a second failure there is a request error of its own), an `afterResponse.defer()` task
(`'after-response'`) and a `terminate` hook (`'terminate'`). They are reports of the request they belong to, so a reporter groups
them by `route` as before; they carry the same facts and nothing else, never the request's body, cookies or headers nor the props themselves; what an error's message quotes is masked like any request error's (see above).
The reporters are flushed when the app shuts down, after the server has finished this work (it waits at most 8 seconds for it; a report of work still running then may be lost). A deferred group that only takes too
long is logged, not reported. These are logged but not
reported: errors of server rendering, errors at shutdown, a job that ignores its timeout and ends its worker (it runs again after `retryAfterSeconds`), a job that was queued by an error reporter (see below), a job on the `sync`
connection (its error reaches whoever dispatched it, who reports it as their own), a command that is called wrong (exit code 2) or
ends with an exit code but no error, and a prompt that was cancelled. To report an error you caught yourself, for example when a
`catch` still answers 200, ask the app for the service:

```ts
app.container.make(ErrorReports).report(error, { source: 'request' });
```

A reporter that queues a job, say one that sends an alert, does not start a loop: if the alert fails for good it is logged, not
reported again, and the jobs it queues in turn are marked the same way. The mark covers what `report()` and `flush()` of a reporter
start, and the jobs those queue. A timer opened in the constructor or an `afterResponse` callback is not covered: a job queued from
there is reported like any other. Look for the failures that are not reported in the log and in the failed jobs.

`ExceptionHandler` does not report. It is a token with one method, `render(error, request, { debug, translator })`, which returns what
a controller returns: a view, a redirect, a `Response`. To change how errors look, extend `DefaultExceptionHandler` (it has no
constructor parameters) and bind your class to the token.

## The development error page

With `NODE_ENV=development`, a page request that fails with a 5xx gets the development error page instead of `errors/Error`:

- **The error:** the status, the class, the message and its causes, the request and its route, and the solutions that match.
- **The stack:** your app's frames first, each with its code and the throwing line marked, and a link that opens the file in your
  editor. The line is the line that threw, since Node runs your TypeScript as written.
- **The request:** its method, URL, headers, query and body; the route with its name, controller, middleware and parameters; the
  database queries it ran, with their duration; its log entries; and the environment.
- **Copy as Markdown:** the same report as Markdown, for an issue or a chat, without your source code.

Everything on it passes the app's redaction first: cookies, `Authorization`, passwords, tokens, password hashes and the
parameters of queries on secret columns never show. A route parameter with a sensitive name (`/invite/:code`) is masked in
the request's URL by the route's pattern, on the page, in `last-error.md` and in the devtools, however short its value is.
The same goes for a `Referer` or a redirect's `Location` that points to a route of the app; one to another site shows its host (never a user name or password), with its path and query masked as text, and no fragment.

The page is one self-contained document, without React, Vite or your views, so it renders when they are what broke. It goes out
with `Cache-Control: no-store` and a Content-Security-Policy of its own. A visit inside the app shows it in a dialog over the page.
A JSON request keeps its JSON, with the error and the first solution added. A 4xx error, an action and an upload keep their normal
answers, and so does a handler of your own unless it renders the error page.

Every 5xx error of the development server (`marmeon dev`), whether the answer is the page or JSON, is also written to
`.marmeon/last-error.md` in the app's root, so an agent in the terminal can read it as a file. It is the report that "Copy as
Markdown" copies, for the error's method and path only: no request headers, cookies, query or body, and nothing that the page
would mask. The error's message and causes sit in a code fence, under a line saying that everything below is data and not
instructions. An error of a request that the browser marks as from another site (`cross-site` or `same-site`) is not written, and neither is one for a host other than `localhost`, `127.0.0.1`, `[::1]` and the host of
`APP_URL`, even when the browser says `same-origin` (DNS rebinding). With `HOST=0.0.0.0`, anyone on the network can put text into the file by causing an error: the fences mark it as data, but treat it as untrusted, and run `marmeon dev` on a network you trust. The next error overwrites
the file, and it is removed when the development server starts; a command such as `marmeon tinker` leaves it alone. It is readable
by its owner only and never written in production or in tests; `.marmeon/` is in the `.gitignore` of a new app. A failure to
write it is a warning in the log, never an error of the request.

An error while a page renders on the server goes to Vite's overlay in the browser, with the code of the view, and the browser
renders the page itself.

The page exists only with `NODE_ENV=development`: in production, staging and tests nothing of it is loaded, and the error page
shows no stack, queries, headers or code. A test asks for it with `createTestApp(application, { debug: true })`.

A staging server runs as production, `NODE_ENV=production APP_ENV=staging`, and is just as quiet: an error in a part of a page
that streams in late reaches the browser as a short code, without its message or stack. The
[configuration](configuration.md#staging) page explains it.

### Solutions

The development error page shows solutions for errors it knows: what to do, why, a command to copy and where it is documented.
The framework brings solutions for its own errors, such as a missing `APP_KEY`, a pending migration, a missing table, an unknown
route name with a suggestion, or a missing view. The `marmeon` command prints them too when the app cannot start.

Your app can add its own. A service provider lists them in `static solutions`:

```ts title="modules/billing/BillingServiceProvider.ts"
import { defineSolutions, type ServiceProvider } from '@marmeon/core';
import { PaymentError } from './PaymentError.ts';

export class BillingServiceProvider implements ServiceProvider {
  static solutions = defineSolutions([
    {
      for: PaymentError,
      when: (error) => error.code === 'declined',
      solve: () => ({
        title: 'Use a test card',
        text: 'The payment provider declines real cards in its test mode.',
        command: 'pnpm marmeon billing:test-cards',
        docs: 'https://wiki.example.com/billing#test-cards',
      }),
    },
  ]);
}
```

`for` names the error's class, and its subclasses match too. `when` narrows it, and `solve` may look things up, or return nothing
after all. The error's causes are searched as well. Solutions are text only: nothing on the page runs a command or calls an
endpoint, since a page that runs code would be a way into your machine.

A provider that brings only solutions is fine; one with no method and no static list at all is refused at start-up. The
[service providers](providers.md#register-and-boot) page explains the rule.

### Server error codes

An error the framework raises at start-up, in the development server or in a command starts its message with a code in square
brackets, such as `[marmeon:K6] Invalid configuration — the application cannot start`. The code stays in logs, in `cause` chains
and across processes (a worker, a command), so one search finds the row below. The development error page, its Markdown and the
`marmeon` command show it next to the solution. It appears only where developers and agents read: never in a response to a
browser in production.

A solution can be tied to a code with `code` in its definition. It then matches only an error with exactly that code, on the same
level of the `cause` chain. `errorCodeOf(error)` from `@marmeon/core` returns an error's code, so your own reporter can tag it.

A letter names the area, a number is given once and never reused. A code that is gone stays in the table as retired. The browser's
codes, `C` and `R`, are listed under [Error codes](#error-codes) below.

| Letter | Area |
| --- | --- |
| K | Start-up: application, container, configuration, discovery, commands |
| H | HTTP: routes, requests, pages, the page protocol, Vite |
| D | Data: connections, migrations, guards, generated types |
| A | Sign-in and sessions |
| Q | Background work: queues, schedules, mail, notifications |
| S | Services: cache, storage, redis, translations, logs, telemetry, validation |

| Code | Package | Meaning |
| --- | --- | --- |
| K1 | `core` | Nothing is bound for a token or an interface, or an abstract store class (`SessionStore`, `AccessTokenStore`, …) was built itself because no store is bound. [The container's errors](container.md#the-containers-errors) |
| K2 | `core` | A scoped service was resolved outside a scope, or by a singleton. [The container's errors](container.md#the-containers-errors) |
| K3 | `core` | A class takes constructor arguments but has no injection list, also when discovery could not resolve a parameter because its type is imported from outside the package. [Constructor injection](container.md#constructor-injection) |
| K4 | `core` | Classes that need each other to be built. [The container's errors](container.md#the-containers-errors) |
| K5 | `core` | The injection transform cannot derive a list from a constructor, or cannot embed it into compiled output. [Constructor injection](container.md#constructor-injection) |
| K6 | `core` | The configuration or `NODE_ENV` is invalid, so the app cannot start. [When a value is wrong](configuration.md#when-a-value-is-wrong) |
| K7 | `core` | Discovery of a package's providers or injections failed, or the `"marmeon"` field of a package in `package.json` has a key that is not known, is no object, or holds a wrong `providers`, `browser` or `experimental`; a `package.json` that is no JSON object is the same. So is a `main`, `types` or `exports` entry that lies outside the package (also through a symlink), or an `exports` nested deeper than 32 levels. So is a `.d.ts` that re-exports from a file outside its package, or re-exports nested deeper than 64 levels. Fix the package: an app that depends on a package it does not control can patch it (`pnpm patch <package>`) or replace it (`overrides` in `package.json`) until the package is fixed. [Discovery](modules.md#discovery), [the field](package-development.md#the-marmeon-field) |
| K8 | `cli` | A command name is taken twice or is one marmeon answers itself (`list`, `help`), or a command declares the option `--no-interaction`. [Writing commands](console.md#writing-commands), [Asking a question](console.md#asking-a-question) |
| K9 | `core` | A class is listed as a service provider but has no hook and no static. [Register and boot](providers.md#register-and-boot) |
| K10 | `core` | A definition carries a boot option (`env`, `phase`, `container`, `override`); they belong to `createApplication(definition, options)` and `createTestApp()`. [Creating the test app](testing.md#creating-the-test-app) |
| K11 | `marmeon` | A check cannot be registered: its `static check` is not kebab-case, it has no `static phase`, or its name is one of `marmeon`'s own or taken by another class. [Checks](package-development.md#checks) |
| K12 | `core` | An error reporter of a provider's `static errorReporters` could not be built, so the app does not start. [What a provider brings](providers.md#what-a-provider-brings-besides-code) |
| H1 | `server` | A request of the page protocol named another version, or none, and was answered with `409` before any route ran. [A tab of another protocol version](navigation.md#a-tab-of-another-protocol-version) |
| H2 | `marmeon` | `bootstrap/routes.ts` was generated by another version of Marmeon: `marmeon route:types --check` and `marmeon check` name it, and `marmeon route:types` writes it again; a file of a newer version needs `@marmeon/*` updated. [Typed route names](routing.md#typed-route-names) |
| H3 | `router` | Routes that do not say who may call them, so the app cannot start. [Every route decides](authorization.md#every-route-decides) |
| H4 | `router`, `http` | A route name that no route has, in `route()`, `redirect().route()` or a signed URL. [URLs for named routes](urls.md#urls-for-named-routes) |
| H5 | `server` | Vite, `@marmeon/vite` or the `marmeon()` plugin is missing, so `marmeon dev` and `marmeon build` cannot start. [When the plugin is missing](vite.md#when-the-plugin-is-missing) |
| H6 | `http` | A write in a read-only request, such as an island: thrown in development and tests, dropped in production. [How islands load](deferred-props.md#how-islands-load) |
| H7 | `live` | Live updates are not set up: `LIVE_DRIVER=redis` without `@marmeon/redis`, or the memory driver under `--workers`. [More than one process](realtime.md#more-than-one-process) |
| H8 | `router` | A middleware passed a key to `next()` that the context has already: one of the framework (`request`, `params`, `route`, `query`, `cookies`, `ip`, `body`, …), one an earlier middleware set (`user` after `authenticate()`) or a name every object has (`then`, `toJSON`, `constructor`). Extending the context with a new key works, replacing a key does not. Also at start: two middleware of one route declare the same key in `adds`. [Adding to the context](middleware.md#adding-to-the-context) |
| H9 | `server` | Routes under a locale cannot work: no locales are bound (`Route.localized()` needs `@marmeon/i18n`), a route that is not localized starts with a locale of the app, another route answers the URL without the locale, or the app has no locales or one that is not letters and digits joined by hyphens. [Routes under a locale](routing.md#routes-under-a-locale) |
| H10 | `router`, `server` | A route marked with `.sitemap()` cannot be listed: it is not a `GET` route, is `.internal()` or an API route, sits behind a middleware that adds `user` or does not say `authorize(everyone)`, is localized, has parameters but no `sitemap()` method on its controller, or `APP_URL` is not an `http` or `https` address. Also the warning that a sitemap was cut at 50 000 URLs. [Sitemap and robots.txt](seo.md#sitemap-and-robotstxt) |
| D1 | `database` | The database's record of migrations (`migrations`) or the migration lock (`migration_lock`) has other columns than this release reads, or there is no record next to tables of the app (a `MigrationStateError`, `newer` or `unmigrated`; `marmeon migrate` writes it for your own database), or a connection is set to `managed: false` and Marmeon migrates it (`unmanaged`). Every query on the connection fails. [How the migrator keeps track](migrations.md#how-the-migrator-keeps-track) |
| D2 | `database` | The database lacks migrations the code has (a `MigrationStateError`, `pending`): the app started before `marmeon migrate`, or after a rollback (a process that was ready before it keeps its schema until it restarts). Every query on the connection fails and `/up/ready` is red until the migrations ran; the app answers within a second of `marmeon migrate`, with no restart. The record in the form Marmeon 0.3 wrote, without a checksum per migration, is refused the same way until `marmeon migrate` carried it over. [Migrating a running app](migrations.md#migrating-a-running-app), [How the migrator keeps track](migrations.md#how-the-migrator-keeps-track) |
| D3 | `database` | The database does not fit the schema the migrations describe after a migration or a `down()`: a table or column the migrations say is there is gone (raw SQL renamed or dropped it), so the migration was rolled back. Use `schema.alter()` and `schema.rename()`. Also: the migrations run in an order their names do not give, and it changes a table; rename the pending migration. [What `migrate` checks](migrations.md#what-migrate-checks-after-each-migration) |
| D4 | `database` | A migration changed `migrations` or `migration_lock`, which belong to the migrator, or a `schema.data()` step changed the schema. [How the migrator keeps track](migrations.md#how-the-migrator-keeps-track), [Changing the data](migrations.md#changing-the-data) |
| D5 | `database` | A name that Postgres would cut at 63 bytes without a word: an index a migration creates, or the new name of an index, constraint or sequence when a table is renamed with `indexes: true`. Pass the index a name: in a new migration one of your own, in an existing one the name Postgres stored (`select indexname from pg_indexes where tablename = '…'`), so that a later `dropIndex` finds it. [Migrations](migrations.md#indexes) |
| D6 | `database` | The framework's tables lack what the installed release needs (a column, or a table): a migration is missing. Run `marmeon publish`, which copies the migrations of your packages into the app, then `marmeon migrate`. [Publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package) |
| D7 | `database` | `bootstrap/database.d.ts` was generated by another version of Marmeon: `marmeon db:types` writes it again; a file of a newer version needs `@marmeon/*` updated. [Table types](queries.md#table-types) |
| D8 | `database` | The migration lock is held by another process and `--wait` ran out. Wait for it, or raise `--wait`. [One migration at a time](migrations.md#one-migration-at-a-time) |
| D9 | `database` | A secret column would leave the database: a query selects it without `secret()`, reads a whole row of its table, a finder compares it, or a relation would load it. [Secret columns](migrations.md#secret-columns) |
| D10 | `database` | The secret guard cannot check a construct (an unknown statement, a function name that is no identifier, raw SQL in `FROM`, names that differ only in case) and refuses it. [Secret columns](migrations.md#secret-columns) |
| D11 | `database` | There is no connection to the database: it is not configured, its SQLite directory is missing, or it could not be opened. [Configuration](database.md#configuration) |
| D12 | `database` | A query that the schema resolver cannot rewrite: a soft delete with parts an update cannot keep (`orderBy`, `limit`, a join, an alias, a second table), a relation or count name the query selects already, or a plugin that changed the tables a statement writes. [Module boundaries](queries.md#module-boundaries) |
| D13 | `database` | A seeder or a module that is not there. [Running seeders](seeding.md#running-seeders) |
| D14 | `database` | A migration file is placed wrongly: its directory is missing, its name is not `<timestamp>_<name>.ts`, it has no `export default defineMigration(…)`, its `up()` or `down()` returns a promise (they build a plan and are not `async`), there are more than 2000 entries below the migrations directory of a module, or it runs on a connection that is not configured. It is also the error when a migration file changed while `migrate` read it: nothing ran, so run the command again. [Migration structure](migrations.md#migration-structure) |
| D15 | `database` | Two migrations have the same name. [Migration structure](migrations.md#migration-structure) |
| D16 | `database` | A migration cannot be rolled back: its file is gone, or it has no `down()`. [Running migrations](migrations.md#running-migrations) |
| D17 | `database` | A package listed an invalid `static migrationUpgrades` entry. The code is retired: a package appends migrations now instead. [Publishing the migrations of a package](migrations.md#publishing-the-migrations-of-a-package) |
| D18 | `database` | A `schema.alter()` that SQLite cannot do in place: making a column NOT NULL or nullable (`table.notNull()`, `table.nullable()`), or adding a column with a generated UUIDv7 default. [Changing the data](migrations.md#changing-the-data), [UUID keys](migrations.md#uuid-keys) |
| D19 | `database` | A migration's plan cannot be described: it creates a table name a second time without dropping it, adds a column the table has already, or changes a table or column (`schema.alter()`, `schema.rename()`, `renameColumn()`, `notNull()`, `nullable()`, an index) that no migration created with the blueprint. Also: a change of a column that was retired (only `dropColumn()` works), and `retire()` of a primary key, of a column of a timestamps or soft-delete mark, of one a foreign key references, of a `NOT NULL` column without a default, or of a column with a fixed default that is in a unique index; and a foreign key (`constrained()`) that points at a retired column. Create it with `schema.create()`; a change in raw SQL keeps no secret, soft-delete or timestamps mark. [What the migrations describe](migrations.md#what-the-migrations-describe), [retiring a column](migrations.md#retiring-a-column) |
| D20 | `database` | A module reads its migrations from a place your repository does not hold: a directory in `node_modules` (by its real path, so a symlink into it counts too), or one outside the app and its workspace. This applies to the directory, each file and every entry below it. An update of the package could change a migration your database has run, and nothing would show in your app's history. Move the files, with the same names, into a module of your app. Packages of your own monorepo, with the lockfile and `pnpm-workspace.yaml` or `workspaces` in its root, are fine. [Migrations from a package](migrations.md#migrations-from-a-package) |
| D21 | `database` | A package declares the migrations it ships wrongly. Either the `static migrations` of a service provider is no object with only `from` and `module`, or `from` is no `file:` URL (or has a host, query or fragment). Or two providers declare migrations for one package, or `module` is no kebab-case name. Or `from` does not exist, is no directory, is the package itself or leads out of the package (by a symlink, or into a `node_modules` inside it). Or a file in it leads out of the package or is no regular file, a `.ts` file is not named `<timestamp>_<name>.ts`, the same name stands under two timestamps, there are more than 100 files, a file is unreadable, larger than 1 MiB, not UTF-8 or has no default export, or the directory holds no migration. Fix the declaration. [Declaring the migrations a package ships](package-development.md#declaring-the-migrations-a-package-ships) |
| A1 | `auth` | Passkeys cannot be used: `APP_URL` or the passkey variables name no safe relying party. [Requirements](passkeys.md#requirements) |
| A2 | `auth` | The hasher is set up with values it refuses, is given a password it will not hash (malformed, over the length limit), or asks for argon2id on a Node without `crypto.argon2`. [Limits](hashing.md#limits) |
| A3 | `session` | Sessions are not set up: a driver whose package or provider is missing. [Drivers](session.md#drivers) |
| A4 | `encryption` | A payload did not decrypt: changed, from another key or for another context. [Encrypting and decrypting](encryption.md#encrypting-and-decrypting) |
| A5 | `auth` | A `UserProvider` breaks its contract: `updatePasswordHash()` or `updateSessionKey()` does not answer with a boolean (or `updatePasswordHash()` answers `false` without `expected`), `updateSessionKey()` / `updateEverySessionKey()` is missing (JavaScript, a cast), `updateSessionKey(id, k, k)` is refused for the stored key, a new key is not handed back by `findById()` (also the one a new password passes to `updatePasswordHash()` as `sessionKey`), `findForSignIn()` and `findById()` disagree on `sessionKey`, a provider still has the old method name `findForLogin()` instead of `findForSignIn()`, or `updateEverySessionKey()` returns no count or no `sampleId`. [The user type](authentication.md#the-user-type-and-where-users-come-from), [for your own user provider](authentication.md#for-your-own-user-provider) |
| A6 | `auth` | A store or hasher breaks its contract (JavaScript, a cast; TypeScript refuses to compile most of it): a `PasswordResetTokenStore` without `forgetEveryone()`, an `AccessTokenStore` without `revokeEveryone()`, an `EmailChangeStore` without `forget()` or `forgetEveryone()` (found before anything is written or ended), a `SignInStore` without `endAll()`, `dropToken()` or `endEveryone()` (found before anything is ended), a source of `TwoFactorState` without `factors()`, `enabledSince()` or `removeAll()` (found when `combineFactors()` is called and before a reset token is spent), or a `Hasher` without `failureFloorMs()` or with one that answers anything but a finite number of milliseconds, 0 or more. [What your app implements](authentication.md#what-your-app-implements), [hashing](hashing.md#making-and-checking-hashes) |
| A7 | `auth` | Signing in needs a rate limiter and none is bound: the provider of `@marmeon/cache` is not registered, while a `UserProvider` is bound. [How password checks are counted](authentication.md#how-password-checks-are-counted) |
| Q1 | `queue` | A job record has no version (it was queued by an earlier release) and is moved to the failed jobs. [Deploying while jobs wait](queues.md#deploying-while-jobs-wait) |
| Q2 | `queue` | A job no worker could read within six hours is moved to the failed jobs. [Deploying while jobs wait](queues.md#deploying-while-jobs-wait) |
| Q3 | `queue` | A queued listener has no `static listener`, the stable name its jobs carry. [Queued listeners](events.md#queued-listeners) |
| Q4 | `queue` | Queues are not set up: a job class or a queued listener without what it needs (an event without `static event` and `static schema`, a setting it does not take), a connection or driver that is missing or breaks its contract, or a retry window a job outgrows. [Connections and drivers](queues.md#connections-and-drivers) |
| Q5 | `scheduler` | A schedule cannot start: a cron expression, time, time zone or task name that is invalid, a task without a frequency, or a package or provider the scheduler needs missing. [Frequencies](scheduling.md#frequencies) |
| Q6 | `notifications` | Notifications are not set up: a class without a name, schema or `via()`, a name or channel taken twice, or a package or provider missing. [Defining notifications](notifications.md#defining-notifications) |
| Q7 | `mail` | An MJML template is invalid, or the `mjml` package is not installed. [Writing mails](mail.md#writing-mails) |
| Q8 | `mail` | The mail driver cannot be set up: `MAIL_DRIVER` names a transport nobody brought, or a provider's factory returns something without `send()`. [Mail transports](drivers.md#mail-transports) |
| S1 | `cache` | The cache is not set up: a driver's package or provider is missing, the driver is unknown, or a custom driver breaks its contract. [Drivers](cache.md#drivers) |
| S2 | `storage` | Storage is not set up: a disk, its driver, its visibility or its URL is configured wrongly, or the AWS SDK or another package is missing, or a body schema holds an `upload()` in a list, a union, an optional object or `.when()` fields. [Configuration](storage.md#configuration), [Uploads](storage.md#uploads) |
| S3 | `storage` | A storage key a disk refuses: `..`, an absolute path, a backslash, a control character or a symlink out of the disk's root. [Keys](storage.md#keys) |
| S4 | `otel` | The OpenTelemetry API is not installed, or is not version 1. [Installation](observability.md#installation) |
| S5 | `i18n` | A message with a syntax error, such as an unclosed placeholder. [Messages](localization.md#messages) |

## Errors in the browser

What the browser does when something fails:

- **An error while a page renders** shows the app's `errors/Error` page (or `errors/500`, if there is one) inside its layouts, with details in development only. A
  layout that throws shows the page without layouts. The next visit tries again. A layout with `error` shows the failure of what
  is below it itself, inside the layout, with a `retry()` for a button: [When a page fails](pages.md#when-a-page-fails).
- **A failed visit** keeps the page and whatever was typed into it. A server that cannot be reached shows a notice, and a 5xx shows
  the server's error page in a dialog over the page.
- **An island** fails on its own and shows its error, while the rest of the page stays.

The code that shows a failure loads when a failure happens, never with the first download. When it cannot load, a 5xx shows the
notice of an unreachable server, and a page that threw shows nothing in its place: a failure never takes the app down.

### Error codes

A mistake in your app's code, such as a hook outside the app, a page without a default export or a route the browser does not
know, throws an explanation in development: what is wrong and how to fix it. A production build carries only a code and a name,
such as `[marmeon:R2] users/Show`, so the explanations cost no download. Both start with the same code. Run the app in development
to read the whole message, or look the code up here.

The explanation comes only with `NODE_ENV` set to `development` or `test`. A build or a server in production, a staging server
included, gets the code alone.

| Code | Where | Meaning |
| --- | --- | --- |
| C1 | `resolveRoute` | A route name, but the app passed no route manifest. |
| C2 | `resolveRoute` | A route name the browser does not know. API routes, `.internal()` routes and `clientRoutes.except` never ship. |
| C3 | query state | The query state of a route, used on the page of another route. |
| C4 | query state | The query state of a route without a query schema. |
| C5 | `createPoll` | A poll interval of 0 ms or less. |
| C6 | layers | A layer depth outside 1 to 10. |
| C7 | layers | A hint in development: the server answered with a layer before any code loaded the layers. They load now. |
| C8 | layers | A warning in development: a deep link's document has layers, but they were not attached before the first render. |
| C9 | tables | A sort by a column the table does not offer as sortable. |
| C10 | tables | A filter the table does not offer, a value that is none of a select filter's options, or a search without a searchable column. |
| C11 | tables | A page the table does not have, a page size it does not offer, or a next page where there is none. |
| C12 | tables | A row action, a bulk action or an export the table does not offer to this user. |
| C13 | the navigator | A warning in development: the browser has no Navigation API, and the history fallback was not attached. |
| C14 | the navigator | A warning in development: a plain `GET` visit took more than a second with no placeholder and nothing fetched ahead — once per route and document. |
| R1 | pages | A page's `layout` is not a component or a list of them. |
| R2 | pages | No page of that name: no default export in `modules/<module>/views/…`. |
| R3 | pages | A page module without a default export. |
| R4 | pages | A page's `ssr` is not `true`, `false` or `'complete'`. |
| R5 | pages | A page's `placeholder` is not a component. |
| R6 | pages | A page's `revalidateOnBack` is not `true`, `false` or a list of prop names. |
| R7 | `useAction` | An action submitted while rendering on the server. |
| R8 | `reloading({ islands })` | An island route the browser does not know. |
| R9 | hooks | A hook of the framework outside the app `createMarmeonApp()` renders. |
| R10 | `useFeature` | A client feature used while rendering on the server. |
| R11 | `useRouter` | A visit while rendering on the server. |
| R12 | translation hooks | A translation hook without the app's messages. |
| R13 | `<Head>` | `<Head>` inside an island. In production it renders nothing. |
| R14 | layers, islands | An optimistic update or a reload while rendering on the server. |
| R15 | `useIsland` | `useIsland()` outside the view of an island. |
| R16 | `createMarmeonApp` | `progress` is not an indicator: pass `progressBar({ delay })` or your own. |
| R17 | `<Pagination>` | A warning: the page's query schema has no field for the page number, so the links would lead to the first page. |
| R18 | `useTable` | A table changed while rendering on the server. |
| R19 | layouts | A layout's `error` that is no component. |

Texts a user sees are never codes: the error pages, the questions before leaving a page. Neither are refusals a production log
needs to read, such as a request that would go to another site.

## Testing

A test asserts the status, and the page or JSON that came with it:

```ts title="modules/notes/errors.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import { NoteRepository } from './NoteRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('answers 410 for an archived note', async () => {
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Old', body: '', archived_at: new Date().toISOString() });
  await app.actingAs(ada).expectingJson().get(`/notes/${note.id}`).assertStatus(410).assertJson({ message: 'This note was archived.' });
});
```

`assertNotFound()`, `assertForbidden()` and `assertUnprocessable()` check the common statuses. The [HTTP
tests](http-tests.md#status) page covers every assertion.
