---
name: marmeon-page
description: Build a page in a Marmeon app — a controller with typed props, a React view, a form with validation errors that also works without JavaScript, an island that loads by itself, and a decision on every route. Use it when the task says "add a page", "add a form", "show a list on a page", "add a panel" or "make this part load separately", or when a form shows no errors or posts nowhere.
metadata:
  marmeon-skill: "1"
---
<!-- Managed by marmeon agents:install — edits are replaced; copy the folder under another name to keep your own. -->

In this skill, `docs/<page>.md` means `node_modules/marmeon/docs/<page>.md`, the guide of the installed version.

# Build a page with a form and an island

A page is a controller that names a view and hands it props, a view that takes its types from the controller, and routes that say
who may call them. A form is a route with a request schema; an island is a `GET` route of its own that the page embeds. The module
itself (folder, migration, policy, repository) is the job of `marmeon-feature-module`; the tests are the job of `marmeon-testing`.
If the marmeon MCP server is connected, its `routes` tool shows what the app already serves, so you do not add a second page for a path.

## Generate the parts

```sh
pnpm exec marmeon make:controller ShowNotes --module=notes --view --request   # the page and its view; the request holds the query
pnpm exec marmeon make:controller StoreNote --module=notes --request          # the form's route: a name that writes redirects
pnpm exec marmeon make:controller ShowRecentNotes --module=notes --view --request   # the island's controller and view, to be changed below
pnpm exec marmeon route:types                                                  # after adding the routes below: writes bootstrap/routes.ts, so <Form route>, <Island route> know the names
```

- A generator writes no route. Add each to `routes.ts` with a name (`.name('index')`) and a decision, then run `marmeon route:types`;
  a view or a route the types do not know yet is a compile error.
- A name that starts with `Show`, `List`, `Index`, `Search`, `Get`, `Find`, `Browse`, `Create` or `New` reads (its request has a
  `query` schema); any other name writes and redirects, and `--view` with `--request` on it is refused. `Create…` is the page of a form.
- The island needs four edits to the generated files: the controller answers `this.island(…)` instead of `this.view(…)`, its query
  lists the fields (`limit: r.integer().between(1, 20).default(5)`), `handle` takes `ContextOf<typeof Request> & Authenticated` (from
  `@marmeon/auth`) to read `ctx.user`, and the view takes `IslandProps<…>` instead of `PageProps<…>`.

## The page

```tsx
import type { PageProps } from '@marmeon/http';
import { Head } from '@marmeon/react';
import type { ShowNotesController } from '../controllers/ShowNotesController.ts';

export default function ShowNotes({ total }: PageProps<ShowNotesController>) { … }
```

- The view is `modules/<module>/views/<Name>.tsx`; its name in the controller is `<module>/<Name>` (`docs/pages.md#where-pages-live`).
  The props are what `this.view('notes/ShowNotes', { total })` passes, typed by `PageProps<Controller>`, plus the shared props
  (`docs/pages.md#props`). Props travel as JSON: a `Date` arrives as a string.
- A view imports its controller with `import type`, never as a value, and takes values only from the browser entries such as
  `@marmeon/react`. A repository, a job or another server module as a value fails the build (`docs/pages.md#what-a-page-may-import`).
- Send what the page shows and no more: props are part of the page's HTML and JSON.
- Put the user's own rows through their repository (`where('user_id', …)`), as `marmeon-feature-module` says.

## The form

The request holds the schema, and the schema holds the only fields the controller may write:

```ts
export const StoreNoteRequest = defineRequest({
  schema: r.object({ title: r.string().trim().required().max(120) }), // `import { rules as r } from '@marmeon/validation'`
});
// handle(ctx: ContextOf<typeof StoreNoteRequest> & Authenticated):
await this.#notes.insert({ user_id: ctx.user.id, title: ctx.body.title }); // the owner from the session, a field named; never ctx.body whole
return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: 'Note saved.' });
```

- `ctx.body` is the schema's output; `handle()` never runs for input that failed (`docs/validation.md#from-schema-to-handler`).
  A page's form goes back to the page with the errors and the typed input; a JSON client or an action gets a 422.
- In the view, `<Form route="notes.store" resetOnSuccess>` reads its fields from inputs: `{...form.field('title')}` on the input,
  `form.error('title')` for the message, `form.processing` on the button. The field names are checked against the schema
  (`docs/forms.md#forms-without-state`). It renders a real `<form>` and posts without JavaScript (`docs/forms.md#without-javascript`).
- Without JavaScript a failed post loads the page again, and `form.field()` does not refill the inputs. The page's controller
  passes the flashed input on (`old: this.#session.old() as { title?: string }`, `Session` from `@marmeon/session` in its
  constructor), and the input takes `defaultValue={old.title}`. Passwords and other secrets are never flashed (`docs/session.md#flash-data`).
- `<Form validate>` checks fields live (`docs/forms.md#validating-while-typing`). Use `useForm('notes.store', { title: '' })` when the
  view needs the fields in state or a file upload; it needs JavaScript. A route with parameters also takes `{ params: { note: note.id } }` (`docs/forms.md#fields-and-errors`).
- A message after success is `.flash('toast', …)`; a layout shows it with `useFlash('toast', …)` (`docs/pages.md#flash-messages`).
  A field name or a route name that does not exist is a compile error, and so is a flash key once the app declares `interface FlashData`: read the error, do not cast it away.
- A form on a public page, for people who are not signed in: follow `marmeon docs recipe-public-form`.

## Every route decides

The page, the form's route and the island's route each say who may call them: `authorize` in the request, or `Route.authorize(…)`
on the registrar. A route that says nothing does not start, and `marmeon route:types` and `marmeon build` fail and list it
(`docs/authorization.md#every-route-decides`).

```ts
const mine = Route.prefix('/notes').middleware(authenticate()).authorize(everyone).name('notes.');
mine.get('/', ShowNotesController).name('index');
mine.post('/', StoreNoteController).name('store');
mine.get('/islands/recent', ShowRecentNotesController).name('recent');
```

- `everyone` is right only when it is the whole truth: here every signed-in user may see and save their own notes. A route
  that takes a record from the path (`/notes/:note`) binds it and asks a policy, in the request or on the registrar
  (`docs/authorization.md#a-request-or-a-registrar`); see `marmeon-feature-module`.
- `abilities(…)` or `authenticate()` alone is not a decision. Do not add `everyone` to a route you have not thought about.
- `marmeon route:list` prints the `ACCESS` of each route; read the new lines.

## CSRF

Nothing to do for your own pages: `<Form>`, `useForm()` and actions send the token and the browser's headers by themselves, and
the `web` group refuses a post from another site (`docs/csrf.md#forms-and-javascript`). Never add `csrfExcept` for a form, and never
exempt a route to make a test pass. A script or mobile client that posts has no browser: `docs/csrf.md#clients-without-a-browser`.
A live validation or an upload's target is checked like the form's own request; an island only reads and passes
(`docs/csrf.md#live-validation-uploads-and-islands`).

## The island

An island is the view of another route, so it has its own controller, middleware and decision, and one island can sit on several pages.

```ts
return this.island('notes/ShowRecentNotes', { notes: await this.#notes.recent(ctx.user.id, ctx.query.limit) });
```

```tsx
<Island route="notes.recent" query={{ limit: 3 }} fallback={<p aria-busy="true">Loading…</p>} unauthorized={<p>Sign in to see your notes.</p>} />
```

- The route is a `GET` route (a compile error on any other method), and its controller calls `this.island()` (or `island()` imported from
  `@marmeon/http`, not re-exported through a module of the app) in its own class: a closure, or an island built by a function outside the class, is no island route and answers 404. Opened directly, visited, linked or prefetched it is a 404 before its
  middleware runs, so a guest is not sent to the login: it answers an island's request only, and a controller that answers a page or an
  island by branch becomes two routes (`docs/deferred-props.md#the-islands-route`).
- Embed it with `<Island route>` and a literal route name; `query` is typed by the island's query schema. Use `fallback` for the
  wait and `unauthorized` for a redirect, a 401 or a 403 of the island's route; `error` for a failure
  (`docs/deferred-props.md#embedding-an-island`). `href` is the second way, for an island the server chooses: build it with `router.url()` from a
  route name the server picks, never from the request or stored content. The server answers an island's request only for a route
  whose controller calls `this.island()`; any other route is refused before its middleware runs. That keeps a wrong `href` from
  running a page, but a `href` that names another island still loads it with the visitor's cookies
  (`docs/deferred-props.md#islands-the-server-chooses`). `marmeon route:list` marks island routes `(island)`.
- The island's view takes `IslandProps<Controller>`, and `useIsland<Controller>()` reloads it. It has no shared props of its own, but
  `usePage()` is the page's. A `<Head>` inside it throws in development (`docs/deferred-props.md#inside-an-island`).
- An island only reads. A write to the session, a cookie, a flash message or work after the response throws in development and tests
  and is dropped in production: do the write in the page's controller or in an action (`docs/deferred-props.md#how-islands-load`).
  An action from inside an island: `docs/actions.md#in-a-dialog-or-an-island`.
- The `unauthorized` prop only shows what a refusal leaves. What the island may show is decided by its own route.

## Test it

Write the tests as `marmeon-testing` teaches, and for this page at least:

- the page, `navigating().get(…).assertPage<Controller>(…)`, and the island, `island('notes.recent').assertIsland<Controller>(…)`,
  with `assertIslandStatus('unauthorized')` for a guest (`docs/testing-pages.md#asserting-a-page`, `docs/testing-pages.md#islands`);
- the form: valid input saves the row and redirects, empty input gives `assertInvalid(['title'])` and saves nothing
  (`docs/http-tests.md#validation`);
- a guest is sent to sign in on the page and the form, and a stranger is refused on every route that takes a record
  (`docs/authorization.md#testing`).

## Before you hand it back

1. `marmeon route:types`, then `marmeon check` (or the `check` MCP tool) is green; `marmeon route:list` shows the access you meant.
2. The tests of the module pass, and a test goes red when you break the code once (a looser schema, a route opened to a guest).
3. No `csrfExcept`, no island `href` built from the request or from stored content, no `ctx.body` written whole, no `import` of a controller as a value in a view.
