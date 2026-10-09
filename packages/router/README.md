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

- [Routing](https://github.com/marmeon/marmeon/blob/main/docs/routing.md)
- [Routing: route model binding](https://github.com/marmeon/marmeon/blob/main/docs/routing.md#route-model-binding)
- [Middleware](https://github.com/marmeon/marmeon/blob/main/docs/middleware.md)
- [Controllers](https://github.com/marmeon/marmeon/blob/main/docs/controllers.md)
- [Requests](https://github.com/marmeon/marmeon/blob/main/docs/requests.md)
- [URL Generation](https://github.com/marmeon/marmeon/blob/main/docs/urls.md)
- [HTTP Tests](https://github.com/marmeon/marmeon/blob/main/docs/http-tests.md)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
