# Controllers

## Introduction

A controller answers the requests of one endpoint. It is a class with a single `handle()` method, and what it accepts and who may
call it is declared right next to it. One class per endpoint keeps each file small: the code that shows a note and the code that
updates it live apart, with their own dependencies.

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

A route points to the class: `Route.get('/notes/:note', ShowNoteController)`. The router builds the controller for each request
and calls `handle()` with the request's context. The [routing](routing.md#route-model-binding) page shows how `:note` becomes the
row.

## Writing controllers

### Creating a controller

`marmeon make:controller` writes a controller into a module's `controllers/` folder and prints the route to add:

```sh
pnpm marmeon make:controller ShowNote --module=notes --view
```

The name gets `Controller` appended when it does not end with it. The options choose what comes with it:

| Option | What it adds |
| --- | --- |
| `--view` | A page in the module's `views/` folder, and a controller that renders it. |
| `--request` | A request definition next to the controller. A name that starts with `Show`, `List`, `Index`, `Search`, `Get`, `Find` or `Browse` gets a query schema, any other name a body schema and a redirect back, so `--view` with it is refused. |
| `--force` | Overwrites a file that exists. |

The module must exist, and `make:module` creates it.

### Dependency injection

The container builds a controller for each request. Its constructor gets its dependencies injected, with no list to keep: the
types of its parameters are enough.

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class ListNotesController extends Controller {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const notes = await this.#notes.query().selectAll().where('user_id', '=', ctx.user.id).execute();
    return this.view('notes/Index', { notes });
  }
}
```

A controller extends `Controller`, so its constructor calls `super()` first. The controller lives in the request's scope, and so
does every scoped service it gets: the session, the signed-in user, the shared props. Nothing of them reaches another request. The
[service container](container.md#constructor-injection) page explains injection, and what to do with an interface.

### The context

`handle()` gets the request's context. Its type, `HttpContext<State, Params>`, says what the controller needs from its route: the
state that middleware added, such as `ctx.user` from `authenticate()`, and the path's parameters. A route that cannot provide
either is a compile error where the route is registered.

| Property | What it is |
| --- | --- |
| `ctx.request` | The raw `Request`. |
| `ctx.params` | The path's parameters, strings or bound records. |
| `ctx.query` | The query string, or the parsed query behind a query schema. |
| `ctx.input()` | The parsed body. |
| `ctx.cookies` | The request's cookies, and the ones to set. |
| `ctx.ip` | The client's address. |
| `ctx.expectsJson()` | Whether the client wants JSON rather than a page. |
| `ctx.route` | The route that matched. |

The [requests](requests.md) page explains each of them. A controller with a request definition reads its validated body from
`ctx.body` instead of `ctx.input()`.

## Requests

### Defining what a controller accepts

`defineRequest()` declares what an endpoint accepts: the schema of its body, the schema of its query, and who may call it. The
controller attaches it as `static request`, and `ContextOf` types its context:

```ts title="modules/notes/controllers/UpdateNoteController.ts"
import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UpdateNoteRequest = defineRequest({
  schema: r.object({
    title: r.string().trim().required().max(120),
    body: r.string().trim().max(10_000),
  }),
  messages: { 'title.required': 'notes.validation.title_required' },
  authorize: can(NotePolicy, 'update', 'note'),
});

export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, ctx.body);
    return this.redirect().route('notes.show', { note: ctx.params.note.id });
  }
}
```

`ctx.body` is the schema's output: `{ title: string; body: string }`, trimmed and checked. The route must bind `note`, or the
`authorize` check is a compile error where the controller is registered.

`ContextOf` takes the route's side of the context from the type of `authorize`. `can()` brings the signed-in user and the bound
record with it. A request without a check of its own adds what the controller needs to `handle`:
`handle(ctx: ContextOf<typeof Request> & Authenticated)`, or `handle(ctx: HttpContext<Authenticated>)` when there is no request.
The context's type belongs to `handle`, the decision to `authorize`: write `authorize: everyone` in the request, or call
`Route.authorize(everyone)` on the registrar, when anyone who reaches the route may call it.

| Option | What it does |
| --- | --- |
| `schema` | Validates the body. Invalid input never reaches the controller. |
| `query` | Parses the query string. An invalid field falls back to its default, never a 422. |
| `queryOptions` | `{ onInvalid: 'redirect' }` sends a `GET` with an invalid field to its clean URL. |
| `authorize` | Runs before validation. `false` answers 403. |
| `messages`, `attributes` | Your own words for the framework's validation messages, and for the fields' names. |
| `live` | Lets a live validation run a schema of another library. |

The [validation](validation.md) page covers the rules and messages, and the [requests](requests.md#query-schemas) page covers
query schemas. A `GET` route refuses a controller whose request has a body schema, since a `GET` has no body.

### The order of a request

The router runs a request in a fixed order, and builds the controller only when everything before it passed:

1. The middleware: global, the group's, the route's own. Authentication answers here, before a 404 could tell what exists.
2. The bindings. A missing record is a 404.
3. `authorize`: the registrar's (`Route.authorize(check)`), then the request's. A refusal is a 403.
4. The query, parsed by `query`. This never fails.
5. The body, validated by `schema`. Invalid input is a 422, or a redirect back to the form.
6. `handle(ctx)`, with `ctx.body` and the parsed `ctx.query`.

A controller never sees input that failed its schema, and its constructor never runs for a request it would refuse.

### Authorization

`authorize` gets the route's context and a `resolve` function that builds classes in the request's scope. `can()` of
`@marmeon/auth` asks a policy, with the record of a bound parameter:

```ts title="modules/notes/policies/NotePolicy.ts"
import type { AuthUser } from '@marmeon/auth';
import type { Row } from '@marmeon/database';

export class NotePolicy {
  update(user: AuthUser, note: Row<'notes'>) {
    return user.id === note.user_id;
  }
}
```

A refusal answers 403, "This action is unauthorized.", in the request's language. A policy that refuses with `deny('reason')`
shows its own reason instead. A policy's `denyAsNotFound()` answers 404, so the record's existence stays hidden. The
[authorization](authorization.md) page explains policies and the gate.

Every route has to say who may call it, in the request's `authorize` or on the registrar. A controller registered without a
decision stops the app from starting, and the message names the file and line of the route. A request that has no check of its
own and is open to anyone writes `authorize: everyone`. The [authorization](authorization.md#every-route-decides) page has the
rule.

### Types for the browser

A request's types travel to the views without its code:

| Type | What it is |
| --- | --- |
| `ContextOf<typeof UpdateNoteRequest>` | The controller's context: what `authorize` needs, plus `body` and the parsed `query`. |
| `FormOf<UpdateNoteController>` | What a form sends, the schema's input. `useForm()` types its fields with it. |
| `QueryOf<ListNotesController>` | The parsed query, with its defaults. |
| `PageProps<ShowNoteController>` | The props of the page the controller renders. |

`ContextOf` takes the request, the others take the controller class's type. A view imports the controller with `import type`, so
no server code reaches the browser.

## What a controller returns

`handle()` returns what the response becomes. The base class has a method for each kind:

| Return | Response |
| --- | --- |
| `this.view(name, props)` | A page: server-rendered HTML for a first visit, the page as JSON for a visit in the app. |
| `this.redirect(url)`, `this.redirect().route(name, params)`, `this.back()` | A redirect. |
| `this.json(data)` | JSON, typed for the action that calls it. |
| `this.island(name, props)` | A part of a page that loads by itself. `GET` routes only. |
| `this.closeLayer()` | Closes the dialog the request came from. |
| A `Response` | Goes out as it is. |
| A string, an object, `null` | HTML, JSON, or an empty 204. |

The [responses](responses.md) page covers each of them, with headers, cookies, flash messages and downloads.

### The helpers

The base class has these six helpers and no others: `view`, `island`, `json`, `redirect`, `back` and `closeLayer`. The list is fixed.
A method of your own on your controller, under any other name, never collides with a helper of a later version. What the framework
adds later comes as a function imported from `@marmeon/http`, as `view`, `json` and `island` already are, not as a method of
`Controller`.

## Work after the response

Some work does not need to hold up the response, such as a mail that is sent anyway. `AfterResponse` runs it once the response is
out:

```ts title="modules/notes/controllers/ShareNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { AfterResponse, Controller, type HttpContext } from '@marmeon/http';
import { NoteMailer } from '../NoteMailer.ts';

export class ShareNoteController extends Controller {
  readonly #afterResponse: AfterResponse;
  readonly #mailer: NoteMailer;

  constructor(afterResponse: AfterResponse, mailer: NoteMailer) {
    super();
    this.#afterResponse = afterResponse;
    this.#mailer = mailer;
  }

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    this.#afterResponse.defer(() => this.#mailer.sendShared(note));
    return this.back();
  }
}
```

Deferred work runs outside any open database transaction, one task after the other. An error is logged and never reaches the
client. A server that stops gracefully waits up to 8 seconds for deferred work. It is no queue all the same: work that takes
longer, or a process that crashes, loses it. Work that must not get lost belongs in a job, which the [queues](queues.md) page
explains. A request that only reads, such as an island's or a live validation, cannot defer work: it throws in development and
in tests, and is dropped everywhere else.

## Testing

`createTestApp` sends requests through the router, so a test checks the controller with its request, its middleware and its
bindings:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';
import type { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('refuses an empty title', async () => {
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Draft', body: '' });
  await app.actingAs(ada).expectingJson().put(`/notes/${note.id}`, { json: { title: ' ', body: '' } }).assertInvalid<UpdateNoteController>({ title: /required/ });
});
```

The [HTTP tests](http-tests.md) page covers requests and every assertion.
