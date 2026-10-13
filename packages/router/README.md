# @marmeon/router

The typed router of Marmeon apps: routes and named routes, invokable controllers with their request definitions, route model
binding, middleware, URLs and cookies.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

Apps import its everyday names from `@marmeon/http`, which re-exports them: `defineRoutes`, `defineRequest`, `defineMiddleware`,
`Router`, `HttpContext`, `ContextOf` and more. What `@marmeon/http` does not re-export, such as `GLOBAL`, comes from here.

## A route file

```ts title="modules/notes/routes.ts"
import { defineRoutes } from '@marmeon/http';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { ShowNoteController } from './controllers/ShowNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';

export default defineRoutes((Route) => {
  Route.get('/notes', ListNotesController).name('notes.index');
  Route.post('/notes', StoreNoteController).name('notes.store');
  Route.get('/notes/:note', ShowNoteController).name('notes.show');
});
```

The module lists the file as `routes` in its definition. Route names are typed: a link or redirect to a name that does not exist
is a compile error.

## Documentation

- [Routing](https://marmeon.com/docs/routing)
- [Routing: route model binding](https://marmeon.com/docs/routing#route-model-binding)
- [Middleware](https://marmeon.com/docs/middleware)
- [Controllers](https://marmeon.com/docs/controllers)
- [Requests](https://marmeon.com/docs/requests)
- [URL Generation](https://marmeon.com/docs/urls)
- [HTTP Tests](https://marmeon.com/docs/http-tests)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
