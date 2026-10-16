# Request Lifecycle

## Introduction

You can build a Marmeon app without knowing what happens between a browser's request and your controller. Knowing it helps
when something does not behave as you expect: why a guest is sent to the sign-in page before a 404, why a form's controller never
runs when its input is wrong, or why a page shows its HTML before its data. This page follows a request from the moment the app
starts to the moment the browser shows the page.

In short: the app boots once per process. Then each request passes the global middleware, its route's middleware group and its
own middleware, its bound parameters, its authorization and its validation, and only then reaches the controller. The
controller's answer becomes a whole HTML document on a first visit, and the page's data as JSON when the browser is already
running the app:

```text
request → global middleware → group middleware → route middleware → bindings → authorize → validate → controller → response
```

## Starting the app

Before the first request, `marmeon start` or `marmeon dev` prepares the process once:

1. **The environment.** `marmeon` decides `NODE_ENV`: the process's own, else the one in `.env`, else the command's default. See
   [configuration](configuration.md#where-node_env-comes-from).
2. **The loader hook.** It adds the injection lists to your classes as Node loads them. In production it takes them from
   `marmeon build` instead of reading every file.
3. **The packages.** The app reads the list of installed packages, `.marmeon/manifest.json`, and with it their service providers.
   The list is written again by itself when the dependencies change.
4. **The configuration.** Every config definition of the app, its modules and its packages is checked at once. A missing or
   wrong variable stops the start here.
5. **Register.** Every service provider binds its services: the packages' first, then the app's, then each module's in the order
   of `modules`. The HTTP package loads each module's routes in this phase.
6. **Boot.** Once every provider has registered, every provider boots, in the same order. The middleware groups are completed
   here.
7. **Listen.** The server builds its kernel from the routes and listens. The start line names the environment and the number of
   routes and modules.

Steps 3 to 6 are `createApplication(definition, options)`, the same function every test calls through `createTestApp()`. The [service
providers](providers.md#register-and-boot) page explains the two phases, and the [modules](modules.md) page the definition they
read.

## A request on the server

A request then passes these stages, in this order:

| # | Stage | What happens |
| --- | --- | --- |
| 1 | The proxy headers | Behind a trusted proxy, the request takes its scheme and host from `X-Forwarded-Proto` and `X-Forwarded-Host`. A form's `_method` field turns a `POST` into a `PUT`, `PATCH` or `DELETE`. |
| 2 | Health checks | `/up` and `/up/ready` are answered here, before anything else runs: no middleware, no session, no log line. |
| 3 | The request's identity | The request gets an id, the client's `x-request-id` when it is a sane one. Every log entry written during the request carries it. |
| 4 | Assets | In production, `/assets/*` is served from the build, with the precompressed copy the browser accepts. |
| 5 | The route | The router matches method and path. A request no route matches still passes the global middleware, then ends in a 404. |
| 6 | A scope | The request gets a container scope of its own. Every controller, middleware and scoped service of this request is built in it, and nothing of it reaches another request. |
| 7 | Global middleware | The middleware of every request, such as your app's `SecurityHeaders` and its Content-Security-Policy. |
| 8 | Group middleware | The middleware of the route's group, `web` or `api`. |
| 9 | Route middleware | The route's own middleware, such as `authenticate()`, in the order you added it. |
| 10 | Bindings | Bound parameters are looked up, such as a note by its id. None found is a 404. |
| 11 | Authorization | The request's `authorize` runs. A refusal is a 403. |
| 12 | Validation | The query is parsed, and the body is checked against the request's schema. Invalid input is a 422, or a redirect back to the form. |
| 13 | The controller | The container builds the controller with its dependencies, and calls `handle()`. |
| 14 | The response | The controller's result becomes a response, and goes back out through the middleware, last added first. |
| 15 | After the response | Work deferred with `afterResponse.defer()` and the middleware's `terminate` hooks run once the response is out. |

An exception thrown at any stage goes to the app's exception handler, which turns it into the right error response: a page for a
browser, JSON for everyone else.

The order explains several rules of the framework. Bindings run after the middleware, so a guest is sent to the sign-in page
before a 404 could tell them which notes exist. Authorization and validation run before the controller is even built, so a
controller never sees input that failed its schema. And because each request has its own scope, a service that holds the
signed-in user can never leak into another request.

### The `web` group

A route of a module's `routes` file passes the `web` group. Its middleware runs in a fixed order, whatever order the packages
registered it in. Each package adds its part when the app has it installed, and this is the list of a new app:

| Order | Middleware | What it does |
| --- | --- | --- |
| 1 | `EncryptCookies` | Decrypts the incoming cookies and encrypts the outgoing ones. |
| 2 | `ClearClientHistory` | Tells the browser to drop the pages it keeps, when the user signs in or out. |
| 3 | `StartSession` | Loads the session, and saves it after the response. |
| 4 | `NoStoreWhenSignedIn` | Keeps the answers of a signed-in user out of every cache. |
| 5 | `SetLocale` | Picks the request's language. |
| 6 | `CheckAssetVersion` | Sends a tab of an older build to a full page load. |
| 7 | `VerifyCsrfToken` | Refuses a form from another site. |
| 8 | Shared props | Adds what every page gets, such as the signed-in user and the form errors. |
| 9 | Your own | The `web` middleware of `bootstrap/app.ts`. |

The `api` group has no middleware of its own: no cookies and no session. `pnpm marmeon route:list` shows the exact list of every
route. The [middleware](middleware.md#for-every-request-or-every-route-of-a-group) page explains the groups.

## From the controller to the browser

A controller that answers with a page names a view and hands it its props:

```ts title="modules/notes/controllers/ListNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';

export class ListNotesController extends Controller {
  handle(ctx: HttpContext<Authenticated>) {
    return this.view('notes/ListNotes', { author: ctx.user.name });
  }
}
```

What the server sends depends on who asks.

### The first visit

When the browser asks for the page itself, the server answers with a whole HTML document:

1. The server renders the page component, `modules/notes/views/ListNotes.tsx`, with its props into `index.html`. The page
   streams: the first part goes out as soon as it is ready, and parts that wait for data follow in the same response.
2. The document carries the page as data next to the markup: the component's name, its props and the URL.
3. In the browser, `bootstrap/client.tsx` reads that data, loads the page's component and the texts of its language, and
   hydrates the markup. From now on the browser runs the app.

A search engine or a link preview gets the whole page at once, without streaming.

### Every visit after it

A click on a `<Link>` or a form sent with `<Form>` does not load a new document. The browser asks for the same URL with the
header `x-marmeon: true`, and the server answers with the page as JSON: the component's name, its props and the URL. The browser
loads the component when it does not have it yet, swaps the page and writes the history entry. The history entry holds the URL
and the scroll position, never the page's data: Back and Forward take the page from memory or ask the server again.

When the server runs a newer build than the tab, it answers `409` with the URL instead, and the browser loads that URL as a whole
document. A visit never mixes an old browser bundle with a new server.

### Parts that load on their own

A page can hand some of its props over later. Deferred props are computed after the page's first part and streamed into the
same response, or fetched by the browser right after the page. An island is a part of the page with a route of its own, and a
layer is a page that opens above another one, such as a dialog. Each of them is a request through the same stages as above. The
[deferred props](deferred-props.md) and [dialogs](dialogs.md) pages explain them.

## Requests that only read

Some requests may read the session but never change it: an island's request, a live check of a form field, a request for an
upload's target or bytes, the live stream of a page, the tabs' question for the session's state, a layer's base page loaded for
a deep link, and the work that still runs after a streamed page's headers went out. They write no session, set no cookie and
defer no work. A write there throws in development and in tests, so the mistake shows where it is made. Everywhere else it is
dropped and logged.

## Jobs, tasks and commands

Not every unit of work is a request. A queue worker runs each attempt of a job in a container scope of its own, the scheduler
each task, and the `marmeon` command each command. Each of these processes boots the same app with the same providers. The
[context](context.md#the-current-unit-of-work) page shows how code finds out which unit of work it runs in.

## Stopping

On `SIGTERM`, the server leaves readiness, answers for `SHUTDOWN_DELAY` seconds, finishes the requests in flight and the work
after them, and then shuts the app down: every provider's `shutdown()` runs, in reverse order, and closes its pools and
connections. The [deployment](deployment.md#stopping-without-dropped-requests) page explains the stages.
