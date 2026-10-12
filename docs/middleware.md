# Middleware

## Introduction

Middleware runs around a route's controller. It can look at the request before the controller runs, answer instead of it, add
values the controller reads, and change the response on its way out. Signing in, sessions, CSRF protection and security headers
are all middleware.

A middleware is a class with a `handle(ctx, next)` method. `next()` runs the rest of the request and returns its response:

```ts title="middleware/ResponseTime.ts"
import { editableResponse, type HttpContext, type Next } from '@marmeon/http';

export class ResponseTime {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const started = performance.now();
    const response = editableResponse(await next());
    response.headers.set('x-response-time', `${(performance.now() - started).toFixed(1)}ms`);
    return response;
  }
}
```

Code before `await next()` runs on the way in, code after it on the way out. Register the class in `bootstrap/app.ts`, and every
response of the app carries the header.

## Defining middleware

### Middleware classes

`marmeon make:middleware` writes a class into a module's `middleware/` folder:

```sh
pnpm marmeon make:middleware RequireBetaAccess --module=notes
```

The container builds a middleware class for each request, so its constructor gets its dependencies injected like a controller's.
To refuse a request, return a response of your own or throw, and the controller never runs:

```ts title="modules/notes/middleware/RequireBetaAccess.ts"
import type { Authenticated } from '@marmeon/auth';
import { abort, type HttpContext, type Next } from '@marmeon/http';
import { BetaTesters } from '../BetaTesters.ts';

export class RequireBetaAccess {
  readonly #testers: BetaTesters;

  constructor(testers: BetaTesters) {
    this.#testers = testers;
  }

  async handle(ctx: HttpContext<Authenticated>, next: Next<{}>) {
    if (!(await this.#testers.includes(ctx.user.id))) abort(403, 'The notes are in beta.');
    return next();
  }
}
```

`abort()` throws an error with a status, and the app's exception handler turns it into the error page or JSON. A middleware calls
`next()` at most once. A second call rejects with `Middleware "…" called next() more than once.`

### Middleware objects

`defineMiddleware()` declares a middleware as a plain object with a name and a function. It suits a small check that needs no
services, since nothing is injected into it:

```ts title="modules/notes/middleware/jsonOnly.ts"
import { addVary, defineMiddleware, editableResponse, EXPECTS_JSON_VARY } from '@marmeon/http';

export const jsonOnly = defineMiddleware('jsonOnly', async (ctx, next) => {
  if (!ctx.expectsJson()) {
    return new Response('This endpoint answers JSON only.', { status: 406, headers: addVary(undefined, EXPECTS_JSON_VARY) });
  }
  const response = editableResponse(await next());
  response.headers.set('vary', addVary({ vary: response.headers.get('vary') ?? '' }, EXPECTS_JSON_VARY).vary);
  return response;
});
```

The name shows in `marmeon route:list` and on the development error page.

An answer that depends on `ctx.expectsJson()` names the headers it reads in `Vary`, on every branch, as `jsonOnly` does:
route responses get a `Cache-Control`, and a shared cache must not hand one variant to the other client. `addVary()` appends to
a `Vary` that is already there, and leaves `*` as it is.

## Adding to the context

What a middleware passes to `next()` becomes part of the context of everything after it: later middleware and the controller.
The type parameter of `Next` declares it, and the route's types carry it on:

```ts title="modules/notes/middleware/ApiVersion.ts"
import type { HttpContext, Next } from '@marmeon/http';

/** Adds `ctx.apiVersion`: 2 when the client asks for it, else 1. */
export class ApiVersion {
  handle(ctx: HttpContext, next: Next<{ apiVersion: 1 | 2 }>) {
    return next({ apiVersion: ctx.request.headers.get('x-api-version') === '2' ? 2 : 1 });
  }
}
```

A controller on a route with this middleware asks for the value in its context type:

```ts title="modules/notes/controllers/ListNotesApiController.ts"
import { Controller, type HttpContext } from '@marmeon/http';

export class ListNotesApiController extends Controller {
  handle(ctx: HttpContext<{ apiVersion: 1 | 2 }>) {
    return this.json({ version: ctx.apiVersion, notes: [] });
  }
}
```

Register the same controller on a route without `ApiVersion`, and the route is a compile error: the controller needs
`apiVersion`, and nothing on that route provides it. A context is copied for each layer, never changed in place, so a
middleware only sees what came before it.

A middleware can also require values. The first type parameter of `defineMiddleware` is what it adds, the second what it needs.
This one needs the signed-in user of `authenticate()`, and adds nothing:

```ts title="modules/notes/middleware/requireAdmin.ts"
import type { Authenticated } from '@marmeon/auth';
import { abort, defineMiddleware, type EmptyObject } from '@marmeon/http';

const ADMINS = new Set(['ada@example.com']);

export const requireAdmin = defineMiddleware<EmptyObject, Authenticated>('requireAdmin', (ctx, next) => {
  if (!ADMINS.has(ctx.user.email)) abort(403);
  return next();
});
```

`Route.middleware(requireAdmin)` without `authenticate()` before it does not compile. A class says the same with the type of its
`handle()` parameter, as `RequireBetaAccess` above does with `HttpContext<Authenticated>`.

## Registering middleware

### On routes

`Route.middleware()` adds a middleware to the routes registered through the registrar it returns. Call it once per middleware,
in the order they should run:

```ts title="modules/notes/routes.ts"
import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { RequireBetaAccess } from './middleware/RequireBetaAccess.ts';

export default defineRoutes((Route) => {
  Route.middleware(authenticate()).middleware(verified()).middleware(RequireBetaAccess).get('/notes', ListNotesController).name('notes.index');
});
```

Only middleware added this way adds to the types of a route's context. The [route groups](routing.md#route-groups) section of the
routing page shows how to share middleware between routes.

### For every request, or every route of a group

The `middleware` option of `defineApplication()` adds middleware to the global stack and to the two route groups:

```ts title="bootstrap/app.ts"
import { join } from 'node:path';
import { defineApplication } from '@marmeon/core';
import { contentSecurityPolicy } from '@marmeon/http';
import system from '#modules/system';
import { AppConfig } from '../config/app.ts';
import { ResponseTime } from '../middleware/ResponseTime.ts';
import { SecurityHeaders } from '../middleware/SecurityHeaders.ts';

export default defineApplication({
  root: join(import.meta.dirname, '..'),
  config: [AppConfig],
  modules: [system],
  middleware: {
    global: [SecurityHeaders, contentSecurityPolicy(), ResponseTime],
    web: [],
    api: [],
  },
});
```

| Key | Runs for |
| --- | --- |
| `global` | Every request, also one that matches no route and ends in a 404. |
| `web` | The routes of every module's `routes` file. |
| `api` | The routes of every module's `apiRoutes` file. |

These lists add nothing to a controller's types: a value that a `web` middleware passes to `next()` reaches the context at run
time, but the route does not know about it. Put middleware that controllers read from on the routes themselves. Middleware in
these lists suits work every response needs: headers, logging, shared page props.

### Listed twice

A middleware listed twice for a route, say once in its group and once on the route, runs once, at its first place. Middleware
counts as the same when it is the same value. `authenticate()` and the other factories of the framework return a new class on
every call, so keep a factory's result in a constant when you add it in more than one place.

## The order

A route runs the global middleware first, then its group's, then its own in the order you added it. Requests that match no route
pass the global middleware and then end in a 404.

Inside the global stack and each group, the framework sorts middleware by priority, lower first. Packages add their middleware
while the app boots, in any order, and the priority puts it in its place. Your own middleware has the priority `app`, so it runs
after the framework's:

| Priority | Value | Middleware | Group |
| --- | --- | --- | --- |
| `encryptCookies` | 100 | `EncryptCookies` | `web` |
| `clearClientHistory` | 150 | `ClearClientHistory` | `web` |
| `startSession` | 200 | `StartSession` | `web` |
| `preventCaching` | 210 | `NoStoreWhenSignedIn` | `web` |
| `setLocale` | 220 | `SetLocale` | `web` |
| `checkAssetVersion` | 250 | `CheckAssetVersion` | `web` |
| `verifyCsrfToken` | 300 | `VerifyCsrfToken` | `web` |
| `shareProps` | 400 | `ShareErrorsFromSession` | `web` |
| `app` | 1000 | Your own, from `defineApplication()` | any |
| `limitLiveValidation` | 1100 | `LimitLiveValidation` | global |

Each package adds its part only when the app has it installed. The [request lifecycle](lifecycle.md#the-web-group) page explains
what each of them does. `pnpm marmeon route:list` shows the middleware every route really runs, in order.

A package or a service provider of your own adds middleware with a priority of its choice. This one puts `ResponseTime` first in
the global stack, so it measures everything after it. The name of the global stack, `GLOBAL`, and the priorities of the table,
`MiddlewarePriority`, come from `@marmeon/router`:

```ts title="modules/system/SystemServiceProvider.ts"
import type { Application, ServiceProvider } from '@marmeon/core';
import { Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { ResponseTime } from '../../middleware/ResponseTime.ts';

export class SystemServiceProvider implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, ResponseTime, 0);
  }
}
```

`router.middleware.remove(group, middleware)` takes one out again. Middleware with equal priorities keeps the order it was added
in.

## Changing the response

A response may not be the request's own to change. A controller can return the same `Response` object to every request, and the
headers of some responses, such as those of `Response.redirect()`, cannot change at all. `editableResponse()` hands you a response
whose headers you may set:

```ts title="middleware/SecurityHeaders.ts"
import { editableResponse, type HttpContext, type Next } from '@marmeon/http';

export class SecurityHeaders {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const secured = editableResponse(await next());
    secured.headers.set('x-content-type-options', 'nosniff');
    secured.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    secured.headers.set('x-frame-options', 'DENY');
    return secured;
  }
}
```

When the framework made the response for this request, such as a page, a redirect, JSON from `this.json()` or an error page,
`editableResponse()` returns it as it is. Any other response is copied once, and the copy belongs to the request from then on. So
however many middleware add headers, a response is copied at most once.

> [!WARNING]
> Never set a header or a cookie on a response you did not get from `editableResponse()`. A constant response that a controller
> hands out to every request would carry the header, or the cookie of one visitor, to the next.

A package that builds a response for each request marks it with `ownResponse(response)`, so middleware can change it without a
copy. Never mark a response that could be handed out twice.

## Errors in middleware

An error thrown in a middleware becomes a response at that layer: the exception handler renders it, and the middleware outside of
it still runs on the way out. So a 403 from `RequireBetaAccess` still passes the session, the cookies and `SecurityHeaders`, and
the error page carries the same headers as every other page.

## After the response

A middleware class may have a `terminate(ctx, response)` method. It runs after the response has been handed to the client, so the
client does not wait for it:

```ts title="middleware/CountResponses.ts"
import type { HttpContext, Next } from '@marmeon/http';
import { Metrics } from '../modules/system/Metrics.ts';

export class CountResponses {
  readonly #metrics: Metrics;

  constructor(metrics: Metrics) {
    this.#metrics = metrics;
  }

  handle(_ctx: HttpContext, next: Next<{}>) {
    return next();
  }

  terminate(_ctx: HttpContext, response: Response) {
    this.#metrics.count(`http.${response.status}`);
  }
}
```

An error in `terminate` is logged and never reaches the client. The hook runs outside any open database transaction. For work a
controller wants to do after its response, such as sending a mail, the [controllers](controllers.md#work-after-the-response) page
shows `AfterResponse`.

## Middleware of the framework

These middleware come with the framework's packages. Add them to routes with `Route.middleware()`:

| Middleware | Package | What it does |
| --- | --- | --- |
| `authenticate()` | `@marmeon/auth` | Only signed-in users. Adds `ctx.user`. A guest is sent to the login page, a JSON client gets 401. |
| `authenticate('api')` | `@marmeon/auth` | Only requests with a valid API token. Adds `ctx.user` and `ctx.token`. |
| `guest(home)` | `@marmeon/auth` | Only guests. A signed-in user is sent to `home`, by default `/`. |
| `verified()` | `@marmeon/auth` | Only users with a confirmed address. Needs `authenticate()` before it. |
| `confirmedPassword()` | `@marmeon/auth` | Asks for the password again unless the user confirmed it within the last 15 minutes. |
| `abilities(...names)` | `@marmeon/auth` | The API token must grant every ability. Needs `authenticate('api')` before it. |
| `throttle(name)` | `@marmeon/cache` | A rate limit of a named limiter. Answers 429 once it is used up. |
| `signed()` | `@marmeon/http` | Only URLs with a valid signature. Answers 403 otherwise. |
| `cacheControl(value)` | `@marmeon/http` | Sets `Cache-Control` on responses that do not set it themselves. |

The [authentication](authentication.md), [API tokens](api-tokens.md), [rate limiting](rate-limiting.md),
[URL generation](urls.md) and [responses](responses.md#headers) pages explain them in detail.

`devOnly(hosts, handler)` of `@marmeon/core/dev` is no middleware of its own: it wraps a middleware's `handle` or a route's
closure, and answers only with `NODE_ENV` `development` or `test`, and only for the hosts in `hosts`. `devHosts()` builds that set
with the loopback names. The routing page covers [development-only routes](routing.md#development-only-routes).

## Testing

`createTestApp` sends requests through the whole app, with the global, group and route middleware:

```ts title="modules/notes/notes.test.ts"
import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, it } from 'vitest';
import application from '../../bootstrap/app.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
});

it('sends a guest to the login page', async () => {
  await app.get('/notes').assertRedirect('/login');
});
```

The [HTTP tests](http-tests.md) page covers requests and their assertions.
