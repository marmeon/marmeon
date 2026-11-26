# Routes & Middleware

## Introduction

A package adds middleware and routes to every app that installs it. This page continues the `RequestLogServiceProvider` of [Package Development: Getting Started](package-development.md#the-service-provider) with a middleware, a route and the hooks of the router.

## Middleware

`router.middleware.append(group, Middleware, priority)` adds a middleware to the global stack, `GLOBAL`, or to a group such as
`web` or `api`. The priority places it among the framework's middleware, lower first. Your app's own middleware has `app`, 1000.
The [middleware](middleware.md#the-order) page lists every priority, and `MiddlewarePriority` of `@marmeon/router` holds them.

Add middleware in `boot()`, as the provider of [Package Development: Getting Started](package-development.md#the-service-provider) does. A middleware in the global stack runs for every request of every app that
installs the package, also for paths without a route, so keep it cheap.

## Routes

`router.load({ group, prefix }, routes)` loads a route file into a group. The same provider, with a page of its own:

```ts title="src/RequestLogServiceProvider.ts"
import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { defineRoutes, everyone, Router } from '@marmeon/http';
import { GLOBAL } from '@marmeon/router';
import { RequestLogConfig } from './RequestLogConfig.ts';
import { RequestLog } from './RequestLog.ts';
import { PruneRequestLogCommand } from './PruneRequestLogCommand.ts';
import { RecordRequest } from './RecordRequest.ts';
import { ShowRequestLogController } from './ShowRequestLogController.ts';

export class RequestLogServiceProvider implements ServiceProvider {
  static config = [RequestLogConfig];
  static commands = [PruneRequestLogCommand];

  register(container: Container): void {
    container.singleton(RequestLog);
    container.make(Router).load(
      { group: 'web', prefix: '/request-log' },
      defineRoutes((Route) => {
        // The page is open to anyone by this package's design, so it says so.
        Route.authorize(everyone).get('/', ShowRequestLogController).name('request-log.index');
      }),
    );
  }

  boot(app: Application): void {
    app.container.make(Router).middleware.append(GLOBAL, RecordRequest, 50);
  }

  async shutdown(app: Application): Promise<void> {
    await app.container.make(RequestLog).flush();
  }
}
```

Load named routes in `register()`. `marmeon build` writes the app's route types from an app that registers and boots nothing, so
routes loaded in `boot()` serve requests but are not in `bootstrap/routes.ts`. Loading a route builds nothing, and the `Router`
is bound by `@marmeon/http`, whose provider registers before yours when your package depends on it. Routes without a name may load
in `boot()`. Prefix the paths and the names with the package's name, and protect a route the way an app would, with its own
middleware such as `authenticate()`. The prefix `/_marmeon/` belongs to the framework: a package route there stops the app at
start (see [the framework's paths](routing.md#the-frameworks-paths)). A package route says who may call it like an app's: with
`can(…)` or a check of your own through `Route.authorize(…)` or the request's `authorize`, or with `everyone` when anyone may. The
`@marmeon/*/internal` subpaths are how the framework's own packages mark theirs as the framework's, they are not API and outside semver, so they can change in any release, and a route
loaded with their marker outside `/_marmeon/` is refused at load; `pnpm check:source` refuses importing them outside the
framework's own sources.

A package that ships test doubles for its users' tests puts them in a `./testing` subpath of their own (`@marmeon/core/testing`
holds `TestClock` and `EventFake`), not in its main entry: the main entry stays what an app's code imports, and a bundle of the
app never contains a fake. Name the fakes `*Fake`, document them on [the fakes page](fakes.md) and export the types their
methods name from the same subpath.

### Hooks of the router

Two hooks let a package take part in every request. Add them in `boot()`:

| Hook | What it does |
| --- | --- |
| `router.beforeValidation(hook)` | Runs before every body schema, after the request's `authorize`, for a submit and a live validation alike. It may replace input values: the storage package puts a verified upload in place of its token. |
| `router.intercept({ claims, answer })` | Answers the requests it claims in the route's place, after the route's middleware, bindings and `authorize`. The controller is never built. A claimed request that is a live validation too answers 400: `throttle()` lets a live validation through without counting it. The storage package answers its upload requests this way. |

A hook runs for every route of every app that installs the package, so keep it narrow: claim requests by a header of your own, and
leave everything else alone.
