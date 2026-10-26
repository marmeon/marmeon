# Routing

## Introduction

A route connects an HTTP method and a path to the code that answers it. A module keeps its routes in its own `routes.ts`, and
each route usually points to an invokable controller: a class with a single `handle()` method.

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { NotePolicy } from './policies/NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';

export default defineRoutes((Route) => {
  const signedIn = Route.middleware(authenticate());

  // Every signed-in user may call these two: they read and write only the user's own notes.
  const mine = signedIn.authorize(everyone);
  mine.get('/notes', ListNotesController).name('notes.index');
  mine.post('/notes', StoreNoteController).name('notes.store');

  // A note named in the path is somebody's: the policy decides whether it is the signed-in user's.
  signedIn.bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note')).get('/notes/:note', ShowNoteController).name('notes.show');
});
```

Every route says who may call it, or the app does not start. Here a registrar says it with `authorize(everyone)` and another with
a policy; a check of your own says it otherwise. The [authorization](authorization.md#every-route-decides) page has the rule. The
other examples on this page show the routing, and they sit in a registrar that has a decision, or leave it out where it is not the
topic.

Routes are typed from end to end. The path's parameters become typed properties of the controller's context, route names are
checked wherever you link to a route, and a route that cannot work, such as a binding without its parameter, is a compile error.

## Basic routes

### Route files

`defineRoutes()` declares a route file without registering anything. The module lists the file in its definition, and the app
loads it when it starts:

```ts title="modules/notes/index.ts"
import { defineModule } from '@marmeon/core';
import routes from './routes.ts';

export default defineModule({
  name: 'notes',
  routes,
});
```

`marmeon make:module notes` writes both files for you. The app loads a module only when it is listed in `modules` of
`bootstrap/app.ts`, and `make:module` adds it there (last, as routes match in module order). A module can list two route files, and each one is
loaded into its own middleware group:

| Module key | Group | Prefix | What the group does |
| --- | --- | --- | --- |
| `routes` | `web` | none | Encrypted cookies, the session, CSRF protection, the visitor's language. For pages and forms. |
| `apiRoutes` | `api` | `/api` | Nothing by itself: no cookies and no session. For clients that send an [API token](api-tokens.md). |

Routes load in the order of `modules: [...]` in `bootstrap/app.ts`, and within a file from top to bottom.

### Available methods

The registrar has a method for each HTTP verb:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { DeleteNoteController } from './controllers/DeleteNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { PinNoteController } from './controllers/PinNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';
import { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NotePolicy } from './policies/NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Root) => {
  const signedIn = Root.middleware(authenticate());
  const mine = signedIn.authorize(everyone); // the user's own notes
  mine.get('/notes', ListNotesController);
  mine.post('/notes', StoreNoteController);

  const note = signedIn.bind('note', NoteRepository);
  note.authorize(can(NotePolicy, 'update', 'note')).put('/notes/:note', UpdateNoteController);
  note.authorize(can(NotePolicy, 'update', 'note')).patch('/notes/:note/pin', PinNoteController);
  note.authorize(can(NotePolicy, 'delete', 'note')).delete('/notes/:note', DeleteNoteController);
});
```

`Route.options()` registers an `OPTIONS` route the same way. A `get` route answers `HEAD` requests too.
`Route.match(['GET', 'POST'], path, action)` registers several methods at once, and `Route.any(path, action)` registers `GET`,
`POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS`.

A plain HTML form can only send `GET` and `POST`. For a `PUT`, `PATCH` or `DELETE` route it posts a `_method` field, and the
request is routed as that method. The `<Form>` component writes the field for you. The [forms](forms.md#without-javascript) page
shows it.

A `GET` request has no body, so a `get` route refuses a controller whose request validates one. The compiler says why:

```text
a GET request has no body — validate its URL with `query` (defineRequest({ query }))
```

Validate the query string instead. The [requests](requests.md#query-schemas) page explains query schemas. The other way round, a
route of any other method refuses a controller that answers with an island, because an island only reads. The [deferred
props](deferred-props.md#islands) page explains islands.

### Closures

A route can also answer with a function. It gets the same context a controller gets:

```ts title="modules/status/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';

export default defineRoutes((Root) => {
  const Route = Root.authorize(everyone); // a closure has no request, so the registrar decides
  Route.get('/ping', () => 'pong');
  Route.get('/version', () => ({ version: '1.4.0' }));
});
```

A string becomes a text response, an `html` template (from `@marmeon/core`) an HTML one, an object or an array becomes JSON, and `null` or `undefined` becomes an empty `204`. A
`Response` you return goes out as it is. Closures suit tiny answers. Anything with dependencies, validation or a page belongs in
a controller, which the container builds for each request. The [controllers](controllers.md) page covers them.

## Route parameters

### Required parameters

A segment that starts with a colon is a parameter. Its value arrives in `ctx.params`, always as a string:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ShowRevisionController } from './controllers/ShowRevisionController.ts';
import { NotePolicy } from './policies/NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate())
    .bind('note', NoteRepository)
    .authorize(can(NotePolicy, 'view', 'note'))
    .get('/notes/:note/revisions/:revision', ShowRevisionController)
    .name('notes.revisions.show');
});
```

```ts title="modules/notes/controllers/ShowRevisionController.ts"
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowRevisionController extends Controller {
  handle(ctx: HttpContext<{}, { note: Row<'notes'>; revision: string }>) {
    return this.view('notes/Revision', { note: ctx.params.note.id, revision: ctx.params.revision });
  }
}
```

The route checks the controller against its path. A controller that expects a parameter the path does not have is a compile
error.

### Optional parameters

A question mark makes the last parameter optional. The route then matches with and without it, and the parameter's type is
`string | undefined`:

```ts
Route.get('/notes/archive/:year/:month?', (ctx) => ({ year: ctx.params.year, month: ctx.params.month ?? null }));
```

`/notes/archive/2026` and `/notes/archive/2026/10` both reach this route.

### Constraints

A regular expression in braces after the name restricts what the parameter matches. A path whose value does not fit does not
match the route at all:

```ts
Route.get('/notes/:note{[0-9]+}', ShowNoteController).name('notes.show');
```

`/notes/42` reaches the controller. `/notes/latest` does not match this route, so another route can take it, or the request
ends in a 404.

A constraint with alternatives, such as `/notes/:note{new|edit}`, matches as a whole: `/notes/edit` reaches the route,
`/notes/editor` and `/notes/xedit` do not.

### Route order

When two routes match the same path, the one registered first answers. Register fixed paths before the parameters that would
also match them:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListDraftsController } from './controllers/ListDraftsController.ts';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NotePolicy } from './policies/NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Root) => {
  const signedIn = Root.middleware(authenticate());
  signedIn.authorize(everyone).get('/notes/drafts', ListDraftsController).name('notes.drafts'); // the user's own drafts
  signedIn.bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note')).get('/notes/:note', ShowNoteController).name('notes.show');
});
```

In the other order, `/notes/drafts` would reach `ShowNoteController` with `drafts` as the note. A trailing slash makes a
different path: `/notes/` does not match `/notes`.

## Named routes

A name gives a route an identity that does not change when its path does. Links, redirects and forms refer to routes by name:

```ts
Route.get('/notes/:note', ShowNoteController).name('notes.show');
```

Names are unique. A name used twice stops the app at start-up and names both routes:

```text
Route name [notes.show] is used twice: GET /notes/:note and GET /n/:note.
```

A route without a name still answers requests. Nothing can link to it by name, though, and the browser never learns about it.

### Generating URLs

Inside a controller's `handle()`, redirect to a named route with its parameters:

```ts
return this.redirect().route('notes.show', { note: note.id });
```

The `Router` builds a URL anywhere on the server. Inject it like any other service:

```ts title="modules/notes/NoteLinks.ts"
import { Router } from '@marmeon/http';

export class NoteLinks {
  readonly #router: Router;

  constructor(router: Router) {
    this.#router = router;
  }

  share(id: number): string {
    return this.#router.url('notes.show', { note: id }, { ref: 'share' }); // /notes/7?ref=share
  }
}
```

The third argument is the query string. A parameter the path does not take goes into the query string as well. In the browser,
`<Link route="notes.show" params={{ note: 7 }}>` and `useRoute()` build the same URLs. The [URL
generation](urls.md#in-the-browser) page covers signed URLs and the details.

### Typed route names

`marmeon route:types` writes `bootstrap/routes.ts`. The file declares every named route of the app with its method, path and
controller, and every view. Every API that takes a route name is checked against it. A wrong name is a compile error with a
suggestion:

```text
'notes.indx' is not a route name — did you mean notes.index?
```

A missing required parameter is a compile error too. `marmeon dev` keeps the file current while you work, and `marmeon build`
writes it before it builds. In CI, `marmeon route:types --check` fails when someone changed a route or a view and did not
regenerate the file. Commit `bootstrap/routes.ts` with your routes.

The file's third line, `// @marmeon-format 1`, names its format. A file without it, or with an older number, was generated by another version of Marmeon: `--check` says so instead of "out of date", and you run `marmeon route:types` and commit the file. A file with a newer number comes from a newer Marmeon: `--check` fails with "update @marmeon/*", and no command writes over the file.

`route:types` reads the routes without booting the app, so it needs no `.env` and no key. It sees the route files of your
modules. A route that a service provider registers in its `boot()` method serves requests but is not in the file.

### Routes in the sitemap

Call `.sitemap()` on a `GET` page anyone may open, and `/sitemap.xml` lists it. A route with parameters needs a `sitemap()` method
on its controller that returns its pages:

```ts
about.get('/about', ShowAboutController).name('index').sitemap();
```

The [search engines](seo.md#sitemap-and-robotstxt) page shows the method, the limits and what stops the start.

### Routes the browser never learns

By default, the browser can look up the named routes of the `web` group, so `<Link>` and `useRoute()` work without the server.
A client build ships only the names its code actually uses. Call `.internal()` on a route the browser has no business knowing:

```ts title="modules/auth/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone, signed } from '@marmeon/http';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate())
    .middleware(signed())
    .authorize(everyone) // the controller verifies the signed-in user's own address
    .get('/email/verify/:id/:hash', VerifyEmailController)
    .name('auth.verification.verify')
    .internal();
});
```

This is the link the server signs and mails to a new user. The browser never sees its name or its pattern, and naming it in
client code is a compile error:

```text
'auth.verification.verify' is not sent to the browser — API routes, .internal() routes and clientRoutes.except stay on the server
```

`Route.internal()` on a registrar makes every route registered through it internal. API routes stay on the server too, and
`clientRoutes.except` in `defineApplication()` keeps more names out by pattern. The [URL
generation](urls.md#which-routes-the-browser-knows) page explains both.

## Route groups

Every attribute call on the registrar returns a new registrar. Routes registered through it share the attribute, and the
original stays unchanged. Keep the registrar in a constant and register through it:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { DeleteNoteController } from './controllers/DeleteNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NotePolicy } from './policies/NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).name('notes.');
  const note = notes.bind('note', NoteRepository);

  notes.authorize(everyone).get('/', ListNotesController).name('index'); // GET /notes, notes.index
  note.authorize(can(NotePolicy, 'view', 'note')).get('/:note', ShowNoteController).name('show'); // GET /notes/:note, notes.show
  note.authorize(can(NotePolicy, 'delete', 'note')).delete('/:note', DeleteNoteController).name('destroy'); // DELETE /notes/:note, notes.destroy
});
```

The attributes combine in any order:

| Method | Effect |
| --- | --- |
| `prefix(path)` | Puts `path` in front of every route's path. Parameters in the prefix reach every route's context. |
| `name(prefix)` | Puts `prefix` in front of every route's name: `name('show')` under `name('notes.')` is `notes.show`. |
| `middleware(m)` | Adds a middleware to every route. Call it once per middleware: more than one argument to `Route.middleware()` or `Route.authorize()` is a `TypeError`, so chain the calls. |
| `bind(param, binder)` | Resolves a parameter to a record for every route. See [route model binding](#route-model-binding). |
| `authorize(check)` | Asks `check` before any route answers. See [below](#asking-who-may-call-a-group). |
| `internal()` | Keeps every route out of the browser. See [above](#routes-the-browser-never-learns). |
| `localized()` | Puts every route under `/:locale`, limited to the app's locales. Call it first. See [routes under a locale](#routes-under-a-locale). |
| `group(callback)` | Calls `callback` with the registrar, to write a block of routes with the same attributes. |

`group()` reads well when a block of routes shares its attributes:

```ts
Route.prefix('/teams/:team').name('teams.').middleware(authenticate()).authorize((ctx) => ctx.user.teamIds.includes(ctx.params.team)).group((Route) => {
  Route.get('/notes', (ctx) => `The notes of ${ctx.params.team}`).name('notes.index'); // GET /teams/:team/notes
});
```

### Asking who may call a group

`authorize(check)` declares a check for every route of the registrar. It gets the route's context, with the records the registrar
binds, and a `resolve` function. `false` answers 403, and the check may throw its own `HttpError`. It runs after the bindings and
before everything else a route does: the request's `authorize`, the validation (a live validation included), an interceptor
such as a file upload, and the handler.

```ts title="modules/admin/routes.ts"
export default defineRoutes((Route) => {
  const admin = Route.prefix('/admin').middleware(authenticate()).authorize((ctx) => ctx.user.isAdmin);

  admin.get('/users', ListUsersController).name('admin.users.index');
  admin.delete('/users/:user', DeleteUserController).name('admin.users.destroy');
});
```

Bindings run before the registrar's check. A check that ignores the record therefore answers 404 for an id that does not exist
and 403 for one that does, which tells a caller which ids exist. Where ids must not be enumerable, use `can(...)` with a policy
that answers `denyAsNotFound()`.

A registrar that never registers a route makes `load()` fail: `Route.authorize(check);` on a line of its own would throw the
check away, and `const dev = Route.authorize(check); if (flag) dev.get(…)` fails whenever `flag` is false. Put the condition
around the whole `Route.authorize(check)…` call instead.

Checks add up: a group inside `admin` can call `authorize` again, and a request has to pass the registrar's checks and then its
own `authorize`. A later check never opens what an earlier one closed. `everyone`, exported by `@marmeon/http`, is the check that
says yes to anyone its middleware lets through: `Route.authorize(everyone)`. See [authorization](authorization.md#every-route-decides).

### Middleware

Middleware runs before the controller and can answer instead of it. A route runs the global middleware first, then its group's
middleware, then its own, in the order you added them. A middleware listed twice runs once, at its first place.

Middleware can also add to the context. `authenticate()` adds the signed-in user, and the route's types know it:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class ListNotesController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    return this.view('notes/Index', { author: ctx.user.name });
  }
}
```

Registered on a route without `authenticate()`, this controller is a compile error: it asks for `ctx.user`, and nothing on
that route provides it. The [middleware](middleware.md) page shows how to write your own and how the groups are ordered.

> [!NOTE]
> `authenticate()` lets in every signed-in account, also one whose address is not confirmed yet. Add `verified()` of
> `@marmeon/auth` after it where a page needs a confirmed address. With the starter kit's private registration that is every
> page of your own: the [starter kit](starter-kit.md#your-own-pages) page explains why.

## Routes under a locale

`Route.localized()` puts every route of the registrar under `/:locale`, so a page has one URL per language:

```ts title="modules/about/routes.ts"
export default defineRoutes((Route) => {
  const about = Route.localized().authorize(everyone).prefix('/about');

  about.get('/', AboutController).name('about'); // GET /en/about, GET /de/about
  about.get('/features/:feature', FeatureController).name('about.feature'); // GET /de/about/features/:feature
});
```

`locale` is a parameter of every route of the registrar: `ctx.params.locale` is a `string`. When the app starts, the
server limits the segment to the locales of the app, in the spelling the app gives them (`en|de|de-AT`). `/fr/about` and
`/DE/about` answer 404, with no redirect: a page and a language share one URL.

Call `localized()` first. The locale is the first segment of the path, so it throws a `TypeError` after `prefix()`, a second
time, and inside `load({ prefix })`.

The same page without the locale, `/about`, answers every `GET` and `HEAD` request with a `302` to the visitor's preferred
language, such as `/de/about`. The route builds the target from its own pattern and the parameters that matched, and the query
string stays as it came. The response carries `Cache-Control: private, no-store` and `Vary: accept-language, cookie`, because
the session and the language header decide where it leads. A route of another method has no such URL.

The start stops, and names both routes, when:

- no locales are bound: `Route.localized()` needs `@marmeon/i18n`;
- a route that is not localized starts with a locale of the app (`/de/impressum`), in any case: the URL would have two
  owners;
- another route of the app answers the URL without the locale: a `GET /` next to a localized `/`;
- the app supports no locale, or one that is not letters and digits joined by hyphens (`de-AT`): it cannot stand in a URL.

`marmeon route:types` needs no locales: it writes `localized: true` and the path with `/:locale` in front. The
[localization](localization.md#the-locale-in-the-url) page covers the languages themselves: which locale a request speaks, and
the `alternates` of a page.

## Route model binding

A route usually loads a record by the id in its path, and answers 404 when there is none. A binding does that before the
controller is built. `bind()` names the parameter and the class that resolves it:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';
import { NotePolicy } from './NotePolicy.ts';

export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).name('notes.');

  notes.bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note')).get('/:note', ShowNoteController).name('show');
});
```

The controller gets the row instead of the string:

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

Bindings run after the route's middleware and before its request's `authorize` check. A guest is sent to the login before a 404
could tell them which notes exist, and the authorization can look at the record. Several bindings run in the order you declared
them. An optional parameter that is absent stays absent.

A binding needs its parameter in the path. Without it, the route is a compile error:

```text
Route.bind('note') needs a :note parameter in the path
```

> [!WARNING]
> A binding finds the record. It does not decide who may see it. A route that binds a record must ask a policy, as above, or the
> binding must be scoped to an owner or marked public: a route that lets `everyone` call it and binds a record by any key does
> not start, and the message names `{ public: true }` as the way out for records that are public by design
> ([a binding everyone may use](#a-binding-everyone-may-use)). See [every route decides](authorization.md#every-route-decides).

### Binding a repository

Every [repository](queries.md) is a binder. It looks the value up in its `id` column:

```ts title="modules/notes/NoteRepository.ts"
import { Repository } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;
}
```

The route parameter is looked up in the table's primary key. An integer key accepts digits only, up to 15 of them. `/notes/abc` is
a 404 without a query to the database. A table with a [UUID primary key](migrations.md#uuid-keys) takes UUIDs instead: anything
else is a 404 without a query, and a UUID in capitals finds its row. Any other column takes at most 255 characters. A table
without a single-column primary key cannot be bound without a `routeKey`. A route key of a timestamp, boolean, JSON or decimal
column is refused with a `TypeError` that names the column until you set a `routeKeyPattern`: a value that is not one of those would
make Postgres throw. To look records up by another column, set `routeKey`, and
`routeKeyPattern` for the values it accepts. A `routeKey` that names a `uuid` column, such as `public_id`, needs no pattern:

```ts title="modules/notes/NoteRepository.ts"
import { Repository } from '@marmeon/database';

export class NoteRepository extends Repository<'notes'> {
  static table = 'notes' as const;
  static routeKey = 'slug';
  static routeKeyPattern = /^[a-z0-9-]{1,80}$/;
}
```

### Scoped bindings

A record that belongs to another record is looked up within its parent. Pass `scopedBy` with the parent's parameter:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { AttachmentRepository } from './AttachmentRepository.ts';
import { ShowAttachmentController } from './controllers/ShowAttachmentController.ts';
import { NotePolicy } from './NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  const note = Route.prefix('/notes').middleware(authenticate()).name('notes.').bind('note', NoteRepository).authorize(can(NotePolicy, 'view', 'note'));
  const attachment = note.bind('attachment', AttachmentRepository, { scopedBy: 'note' });

  attachment.get('/:note/attachments/:attachment', ShowAttachmentController).name('attachments.show');
});
```

The attachment is looked up with `note_id` equal to the column of the note that the foreign key references, its primary key (a `slug`
if that is the note's key). A `column` that is no foreign key is a `TypeError` when the route is called: there is no parent column to compare with. An attachment of another note answers 404, so a
changed id in the URL cannot reach somebody else's attachment. The column defaults to the parent's name with `_id`. Pass
`column` when yours is called differently: `{ scopedBy: 'note', column: 'parent_note_id' }`. A `column` without `scopedBy` is a
compile error, and refused when the routes load: it would look the attachment up without its note. Only a binder that says it
scopes takes `scopedBy`: a repository does, a binder of your own declares it ([Your own binder](#your-own-binder)).

### A binding everyone may use

A binding finds any record by its key. When that is the point, because the page shows a profile every visitor may see, say so with
`public`:

```ts title="modules/user-profile/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';
import { ShowProfileController } from './controllers/ShowProfileController.ts';
import { ProfileDirectory } from './ProfileDirectory.ts';

export default defineRoutes((Route) => {
  Route.authorize(everyone)
    .bind('user', ProfileDirectory, { public: true })
    .get('/people/:user', ShowProfileController)
    .name('profiles.show');
});
```

A route that lets `everyone` call it and binds a record without `scopedBy` or `public` is reported by the router, because anyone
could read any record by changing the id. `public` excuses routes that only read (GET, HEAD); a route that changes data and lets everyone call it needs a real check. A
binding scoped by a public one is open too, and says so with its own `public: true`: `{ scopedBy: 'team', public: true }` means
public within its parent.

A page for a public record often takes a query as well: `/rooms/:room?day=2026-10-01`. A request with a query schema types
`ctx.query`, and `ContextOf` types the route's side of the context from the request's `authorize`. A request that has none
leaves `ctx.params` empty, so `handle` names the bound record itself, with an intersection of `params`:

```ts title="modules/rooms/controllers/ShowRoomController.ts"
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ShowRoomRequest = defineRequest({
  query: r.query({ day: r.string().default('') }),
});

export class ShowRoomController extends Controller {
  static request = ShowRoomRequest;

  handle(ctx: ContextOf<typeof ShowRoomRequest> & { readonly params: { room: Row<'rooms'> } }) {
    return this.view('rooms/Show', { room: { id: ctx.params.room.id, name: ctx.params.room.name }, day: ctx.query.day });
  }
}
```

The route supplies the decision (`Route.authorize(everyone)` and `{ public: true }`, as in [records nobody owns](authorization.md#records-nobody-owns)), and the compiler checks that it binds
`room`. Do not write `ContextOf<typeof ShowRoomRequest> & HttpContext<object, { room: Row<'rooms'> }>`: `HttpContext` brings the
raw `query` of the URL, which cannot be combined with the parsed one. A request whose `authorize` is `can(RoomPolicy, 'view', 'room')`
needs none of this, because `can()` brings the bound record into `ContextOf` by itself.

### Loading relations with the record

`with` names [relations](queries.md#relations) a repository loads with the record, in the same query:

```ts title="modules/notes/routes.ts"
import { authenticate, can } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NotePolicy } from './NotePolicy.ts';
import { NoteRepository } from './NoteRepository.ts';

export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).name('notes.');

  notes.bind('note', NoteRepository, { with: ['tags'] }).authorize(can(NotePolicy, 'view', 'note')).get('/:note', ShowNoteController).name('show');
});
```

The relations come as `with()` loads them: every column but the secret ones, and no soft-deleted rows. The names are those of the
table's relations, so a wrong one is a compile error, and the bound value's type has the ones you name:

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { RowWith } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: RowWith<'notes', 'tags'> }>) {
    return this.view('notes/Show', { note: ctx.params.note, tags: ctx.params.note.tags });
  }
}
```

`RowWith<'notes', 'tags'>` is the row of `notes` with `tags` loaded, the same type `findOrFail(id, { with: ['tags'] })`
returns. A scoped binding takes `with` too: `{ scopedBy: 'note', with: ['uploader'] }`. The names come from your routes, never
from the request.

### Your own binder

Any class with a `resolveRouteBinding(value)` method can bind a parameter. It returns the record, or `undefined` for a 404. The
container builds it for each request, so its constructor gets its dependencies injected:

```ts title="modules/notes/PublishedNotes.ts"
import type { Row } from '@marmeon/database';
import type { RouteBinder } from '@marmeon/http';
import { NoteRepository } from './NoteRepository.ts';

/** `/p/:note` — a published note by its slug, or a 404. */
export class PublishedNotes implements RouteBinder<Row<'notes'>> {
  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    this.#notes = notes;
  }

  resolveRouteBinding(slug: string) {
    return this.#notes.query().selectAll().where('slug', '=', slug).where('published_at', 'is not', null).executeTakeFirst();
  }
}
```

```ts title="modules/notes/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';
import { ShowPublishedNoteController } from './controllers/ShowPublishedNoteController.ts';
import { PublishedNotes } from './PublishedNotes.ts';

export default defineRoutes((Route) => {
  // PublishedNotes finds published notes only, so every visitor may read what it finds.
  Route.authorize(everyone).bind('note', PublishedNotes, { public: true }).get('/p/:note', ShowPublishedNoteController).name('notes.published');
});
```

The second argument of `resolveRouteBinding` carries the request's context, for a scoped binding the parent, and in `with` the names
the route asks to load. `bind()` accepts `with` for a binder that declares what it loads in a `routeBindingWith` property, as a
repository does; for any other binder it is a compile error.

A binder you use with `scopedBy` must look the record up within its parent, so it says so: `static readonly routeBindingScoped = true`
and it reads `binding.scope`. A binder without the mark is a compile error with `scopedBy`, and an app that gets past the types stops
at start with `H11`, because a binder that ignores the scope would hand out a record of another parent. A repository carries the mark, and so does every subclass: one that overrides `resolveRouteBinding` passes `binding` on
(`super.resolveRouteBinding(value, binding)`) or reads `binding.scope` itself.
When the parent is missing from the request the router answers 404 and does not call the binder.

```ts title="modules/notes/NoteAttachments.ts"
import type { Row } from '@marmeon/database';
import type { RouteBinder, RouteBindingContext } from '@marmeon/http';
import { AttachmentRepository } from './AttachmentRepository.ts';

/** `/notes/:note/:attachment` — an attachment of the note bound before, or a 404. */
export class NoteAttachments implements RouteBinder<Row<'attachments'>> {
  static readonly routeBindingScoped = true;

  readonly #attachments: AttachmentRepository;

  constructor(attachments: AttachmentRepository) {
    this.#attachments = attachments;
  }

  resolveRouteBinding(id: string, binding: RouteBindingContext) {
    const note = binding.scope?.parent as Row<'notes'> | undefined;
    if (!note) return undefined;
    if (!/^\d{1,15}$/.test(id)) return undefined;
    return this.#attachments.query().selectAll().where('id', '=', Number(id)).where('note_id', '=', note.id).executeTakeFirst();
  }
}
```

```ts
Route.authorize(can(NotePolicy, 'view', 'note')).bind('note', NoteRepository).bind('attachment', NoteAttachments, { scopedBy: 'note' });
```

## API routes

A module's `apiRoutes` file is loaded into the `api` group, under `/api`. The group starts no session and sets no cookie, so
these routes have no CSRF check either. Clients authenticate with a token instead:

```ts title="modules/notes/api-routes.ts"
import { abilities, authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { ListNotesApiController } from './controllers/ListNotesApiController.ts';

export default defineRoutes((Route) => {
  // `abilities()` limits which tokens get in; it does not say who may call, so the route still decides.
  Route.middleware(authenticate('api')).middleware(abilities('notes:read')).authorize(everyone).get('/notes', ListNotesApiController).name('api.notes.index');
});
```

This route answers `GET /api/notes`. The [API tokens](api-tokens.md) page explains how tokens and abilities work.

## One request at a time

Some routes read the session, decide on it and write it back. Two such requests at once could overwrite each other.
`.block()` runs the requests of one session on this route one after another:

```ts title="modules/auth/routes.ts"
import { authenticate } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).authorize(everyone).put('/settings/password', UpdatePasswordController).name('auth.password.update').block();
});
```

A second request waits up to 10 seconds for the first one, then answers `423`. `.block(lock, wait)` changes both
times. Each is seconds, or a [`Duration`](time.md#spans-of-time) such as `{ seconds: 5 }`. The lock needs the cache's atomic locks. The [session](session.md#requests-that-must-not-overlap) page explains when a
route needs it.

## When no route matches

A request that matches no route still passes the global middleware, so it gets the security headers like any other response. It
then ends in a 404. A browser gets the app's error page, `errors/Error`, and every other client gets JSON with the status text
in the visitor's language:

```json
{ "message": "Not Found" }
```

There is no fallback route. A controller answers 404 itself with `abort(404)`, and a binding does when it finds nothing. The
[error handling](errors.md#your-own-error-page) page shows how to change the error page.

## The framework's paths

Every path under `/_marmeon/` belongs to the framework. `/_marmeon/session` (how open tabs learn that the session changed)
is always there. The packages add theirs: `/_marmeon/live` with `@marmeon/live`, `/_marmeon/uploads` and `/_marmeon/storage`
with `@marmeon/storage` (uploads only once configured); in development there are also `/_marmeon/devtools` and
`/_marmeon/mail`. These paths take precedence over a wildcard or parameter route of your app, such as `/:page{.+}`, and a path under the prefix that no framework route answers ends in a 404 before any route, controller or
middleware group of your app runs (only the global middleware does), whatever the case of its letters and with its letters percent-encoded (`%5F`). A wildcard of your app that answered such a path before now gets a 404 there. A route of your app or of a package that lies under that prefix, whether you write
the path out or build it with a `prefix`, would inherit the framework's special treatment or take a path the framework may need. So the app does not
start: the error names the method and the path. Give your routes a prefix of your own, such as `/_playground` below.

## Development-only routes

Some routes are for your own browser while you develop: the devtools at `/_marmeon/devtools` and the mail previews at
`/_marmeon/mail`. The framework registers them only in development. In addition, each one sits behind a guard,
`devOnly()`, that you can put in front of a route of your own. It takes the hosts to answer, and `devHosts()` builds them from
`APP_URL`. Read `APP_URL` from the app's configuration, which a middleware gets injected:

```ts title="modules/playground/DevelopmentOnly.ts"
import { devHosts, devOnly } from '@marmeon/core/dev';
import type { EmptyObject, HttpContext, Next } from '@marmeon/http';
import { AppConfig } from '../../config/app.ts';

export class DevelopmentOnly {
  readonly #guard: (ctx: HttpContext, next: Next<EmptyObject>) => Promise<Response>;

  constructor(app: AppConfig) {
    // localhost, 127.0.0.1 and [::1], and the host of APP_URL.
    this.#guard = devOnly(devHosts(app.url), (_ctx: HttpContext, next: Next<EmptyObject>) => next());
  }

  handle(ctx: HttpContext, next: Next<EmptyObject>): Promise<Response> {
    return this.#guard(ctx, next);
  }
}
```

```ts title="modules/playground/routes.ts"
import { defineRoutes, everyone } from '@marmeon/http';
import { ShowPlaygroundController } from './controllers/ShowPlaygroundController.ts';
import { DevelopmentOnly } from './DevelopmentOnly.ts';

export default defineRoutes((Route) => {
  Route.middleware(DevelopmentOnly).authorize(everyone).get('/_playground', ShowPlaygroundController);
});
```

The guard asks on every request. Unless `NODE_ENV` is `development` or `test`, it answers 404, so the route stays shut on a
staging or production server even though it is registered there. In development it answers only requests for the loopback
names and the hosts you pass, and gives every other host a 403. Its answers are never cached and never shared with another
origin.

The host check stops DNS rebinding. A page on another site can point its own domain at `127.0.0.1` and then read your
development server as if it were its own. A request for a host the guard does not know never reaches the handler.

To apply the same rule to a bare `Host` value outside `devOnly()`, ask `hostNameAllowed(host, devHosts(app.url))` from
`@marmeon/core/dev`: it ignores the port and rejects look-alike names, userinfo and a smuggled path.

> [!NOTE]
> Apart from `NODE_ENV`, values from `.env` reach the app's configuration, not `process.env`. A guard built in a route file from
> `process.env.APP_URL` misses an `APP_URL` of `.env` and answers the loopback names alone.

`devOnly()` also wraps a closure directly, with the hosts it should answer: `devOnly(devHosts(undefined), () => new Response('pong'))`
answers the loopback names. The
[security](security.md#the-environment-decides-and-fails-closed) page lists every protection that depends on `NODE_ENV`.

## Listing routes

`marmeon route:list` prints every registered route in a table:

```sh
pnpm marmeon route:list
```

It shows each route's method, path, name, group, the middleware in the order it runs, who may call it, and the controller, or
`Closure`. The `ACCESS` column lists the checks a request passes, joined by `+`: `everyone`, `can ProfilePolicy.update(user)`
for a policy (the parameter it asks about in brackets, `(…)` for a function, none for an ability without a resource), and
`check` for a function of your own. `none` marks a route that does not say who may call it; `framework` marks the framework's
own routes, which guard themselves. A route that binds a record with `{ public: true }` names the parameter after its checks:
`everyone (public: user)`. The last line counts the routes. The list includes the
framework's own routes, so it also answers which middleware a request really passes.

`--json` prints the same as a [machine-readable document](console.md#machine-readable-output): `format`, `routes` (each with
`methods`, `path`, `name`, `group`, `middleware`, `access`, `publicBindings` and `action`; `access` is a list of checks, or
`"framework"` or `"none"`; `publicBindings` lists the parameters bound with `{ public: true }`, `[]` for none) and `warnings`.

## Testing

`createTestApp` sends requests through the whole app, with its middleware and bindings:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('answers 404 for a note that does not exist', async () => {
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).get('/notes/999').assertNotFound();
});
```

The [HTTP tests](http-tests.md) page covers requests, sessions and every assertion.
