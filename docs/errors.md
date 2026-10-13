# Error Handling

## Introduction

An error thrown anywhere in a request, in a middleware, a binding or a controller, ends in the app's exception handler. It logs
the error when it is a bug, and turns it into the right answer: an error page for a browser, JSON for every other client. To stop a
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
| `HttpError(413)` | 413 | A body over `MAX_BODY_SIZE`. |

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

The `default` makes the switch exhaustive. When `accept()` gains a kind, the controller stops compiling until it handles the
new one:

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
| `auth.attempt()` | `invalid-credentials`, `two-factor-required` | [Authentication](authentication.md#signing-in) |
| `twoFactor.challenge()` | `no-challenge`, `expired`, `invalid-code`, `throttled` | [Two-factor authentication](two-factor-authentication.md#the-sign-in) |
| `twoFactor.confirm()` | `not-started`, `invalid-code`, `throttled` | [Two-factor authentication](two-factor-authentication.md#setting-up) |
| `RememberTokenStore.consume()` | `invalid`, `stolen` | [Authentication](authentication.md#remember-me) |
| `PasswordBroker.createToken()` | `unavailable` | [Password reset](passwords.md#asking-for-a-link) |
| `PasswordBroker.reset()` | `invalid-token` | [Password reset](passwords.md#resetting-the-password) |
| `PasswordResetTokenStore.create()` | `throttled` | [Password reset](passwords.md#a-store-of-your-own) |
| `PasswordResetTokenStore.consume()` | `invalid-token` | [Password reset](passwords.md#a-store-of-your-own) |
| `lock.get(callback)` | `locked` | [Cache](cache.md#locks) |

`RememberTokenStore` and `PasswordResetTokenStore` are the contracts a store of your own implements, so the table lists the kinds
each has to return. A `get(callback)` whose callback returns a `Result` gives a nested one: the lock's `ok` holds the callback's
result. An exception from the callback is rethrown, not turned into an `err`.

Some of these `err`s must survive the transaction they are returned from, because the work behind them is a protective one. They
are made with [`commitAnyway()`](transactions.md#returning-an-err), and a store of your own does the same:

- `RememberTokenStore.consume()` for `stolen` (all of the user's remember-me tokens are revoked) and for `invalid` on an expired
  token (the token is deleted).
- `PasswordResetTokenStore.consume()` and, through it, `PasswordBroker.reset()` for `invalid-token` on an expired token (the token
  is deleted). `reset()` also commits the `invalid-token` of an account that is gone, so that the token stays used up.

Every other `err` above commits nothing and rolls an enclosing transaction back when its callback returns it.

Where a kind would tell whether an account exists, it is left out on purpose. `attempt()` answers `invalid-credentials` for an
unknown identifier, a wrong password and an account without a password alike; `two-factor-required` is answered only after the
password was right. `reset()` answers `invalid-token` for an unknown
address and for a wrong, used or expired token. `createToken()` answers `unavailable` for an address without an account and for one
whose last link went out moments ago. Do not add kinds of your own that tell these apart.

Two calls are not `Result`s because nothing failed: a unique job that is already queued or running makes `dispatch()` return `undefined`, and
`job.once()` returns `false` when the work already ran. Yes-or-no questions, such as `lock.get()` without a callback,
`auth.check()` and `auth.confirmPassword()`, stay `boolean`.

## Reporting

The exception handler's `report()` logs every server error at the `error` level: its message and its stack, masked as text by the
app's `Redactor`, so a token, a password in a connection string or the value of the session cookie does not reach the log. An `HttpError` with a status below 500 is not
reported: a 404 or a 403 is an answer, not a bug.

To send errors elsewhere as well, such as to an error tracker, extend the default handler and bind yours in a service provider:

```ts title="modules/system/ReportingExceptionHandler.ts"
import { Logger, Redactor } from '@marmeon/core';
import { DefaultExceptionHandler, HttpError } from '@marmeon/http';
import { ErrorTracker } from './ErrorTracker.ts';

export class ReportingExceptionHandler extends DefaultExceptionHandler {
  readonly #tracker: ErrorTracker;

  constructor(logger: Logger, redactor: Redactor, tracker: ErrorTracker) {
    super(logger, redactor);
    this.#tracker = tracker;
  }

  override report(error: unknown): void {
    super.report(error);
    if (!(error instanceof HttpError && error.status < 500)) this.#tracker.capture(error);
  }
}
```

```ts title="modules/system/SystemServiceProvider.ts"
import type { Container, ServiceProvider } from '@marmeon/core';
import { ExceptionHandler } from '@marmeon/http';
import { ReportingExceptionHandler } from './ReportingExceptionHandler.ts';

export class SystemServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(ExceptionHandler, ReportingExceptionHandler);
  }
}
```

`ExceptionHandler` is a token with two methods: `report(error)` and `render(error, request, { debug, translator })`. A handler of
your own may answer differently too. `render()` returns what a controller returns: a view, a redirect, a `Response`.

## The development error page

With `NODE_ENV=development`, a page request that fails with a 5xx gets the development error page instead of `errors/Error`:

- **The error:** the status, the class, the message and its causes, the request and its route, and the solutions that match.
- **The stack:** your app's frames first, each with its code and the throwing line marked, and a link that opens the file in your
  editor. The line is the line that threw, since Node runs your TypeScript as written.
- **The request:** its method, URL, headers, query and body; the route with its name, controller, middleware and parameters; the
  database queries it ran, with their duration; its log entries; and the environment.
- **Copy as Markdown:** the same report as Markdown, for an issue or a chat, without your source code.

Everything on it passes the app's redaction first: cookies, `Authorization`, passwords, tokens, password hashes and the
parameters of queries on secret columns never show.

The page is one self-contained document, without React, Vite or your views, so it renders when they are what broke. It goes out
with `Cache-Control: no-store` and a Content-Security-Policy of its own. A visit inside the app shows it in a dialog over the page.
A JSON request keeps its JSON, with the error and the first solution added. A 4xx error, an action and an upload keep their normal
answers, and so does a handler of your own unless it renders the error page.

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

## Errors in the browser

What the browser does when something fails:

- **An error while a page renders** shows the app's `errors/Error` page inside its layouts, with details in development only. A
  layout that throws shows the page without layouts. The next visit tries again.
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
| R1 | pages | A page's `layout` is not a component or a list of them. |
| R2 | pages | No page of that name: no default export in `modules/<module>/views/…`. |
| R3 | pages | A page module without a default export. |
| R4 | pages | A page's `ssr` is not `true`, `false` or `'complete'`. |
| R5 | pages | A page's `placeholder` is not a component. |
| R6 | pages | A page's `revalidateOnBack` is not `true`, `false` or a list of prop names. |
| R7 | `useAction` | An action submitted while rendering on the server. |
| R8 | `reloading({ islands })` | An island route the browser does not know. |
| R9 | hooks | A hook of the framework outside `<MarmeonApp>`. |
| R10 | `useFeature` | A client feature used while rendering on the server. |
| R11 | `useRouter` | A visit while rendering on the server. |
| R12 | translation hooks | A translation hook without the app's messages. |
| R13 | `<Head>` | `<Head>` inside an island. In production it renders nothing. |
| R14 | layers, islands | An optimistic update or a reload while rendering on the server. |
| R15 | `useIsland` | `useIsland()` outside the view of an island. |
| R16 | `createMarmeonApp` | `progress` is not an indicator: pass `progressBar({ delay })` or your own. |
| R17 | `<Pagination>` | A warning: the page's query schema has no field for the page number, so the links would lead to the first page. |
| R18 | `useTable` | A table changed while rendering on the server. |

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
