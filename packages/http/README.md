# @marmeon/http

HTTP for Marmeon apps: controllers, pages and their props, redirects, signed URLs, cookies, the Content-Security-Policy and the
UI-free client core every visit in the browser goes through.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

Apps import the router's everyday names from here too: `defineRoutes`, `defineRequest`, `HttpContext`, `ContextOf` and more.

## A controller and its page

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';

export class ShowNoteController extends Controller {
  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    if (ctx.params.note.user_id !== ctx.user.id) return this.redirect().route('notes.index');
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
```

The page `modules/notes/views/Show.tsx` gets its props typed from the controller: `PageProps<ShowNoteController>`.

## Documentation

- [Controllers](https://marmeon.com/docs/controllers)
- [Responses](https://marmeon.com/docs/responses)
- [Pages & Layouts](https://marmeon.com/docs/pages)
- [URL Generation](https://marmeon.com/docs/urls)
- [Content Security Policy](https://marmeon.com/docs/csp)
- [Request Lifecycle](https://marmeon.com/docs/lifecycle)
- [Client Features & Tab Sync](https://marmeon.com/docs/client-features)
- [Error Handling: error codes](https://marmeon.com/docs/errors#error-codes)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
