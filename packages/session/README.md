# @marmeon/session

Sessions for Marmeon apps: an injectable session on file, database, Redis or memory stores, flash data and CSRF
protection.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

The `database` driver needs `@marmeon/database`, which a new app has, and the `redis` driver `@marmeon/redis`, which brings the
Redis client: `pnpm add -E @marmeon/redis@<version of your app>`. A driver whose package is missing stops the start with the command that installs it.

## Using the session

```ts title="modules/notes/controllers/ShowNoteController.ts"
import type { Authenticated } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, type HttpContext } from '@marmeon/http';
import { Session } from '@marmeon/session';

declare module '@marmeon/session' {
  interface SessionData {
    /** The notes this visitor opened last, newest first. */
    recentNotes: number[];
  }
}

export class ShowNoteController extends Controller {
  readonly #session: Session;

  constructor(session: Session) {
    super();
    this.#session = session;
  }

  handle(ctx: HttpContext<Authenticated, { note: Row<'notes'> }>) {
    const { note } = ctx.params;
    const recent = this.#session.get('recentNotes') ?? [];
    this.#session.put('recentNotes', [note.id, ...recent.filter((id) => id !== note.id)].slice(0, 5));
    return this.view('notes/Show', { note, recent });
  }
}
```

## Documentation

- [Session](https://marmeon.com/docs/session)
- [Session: drivers](https://marmeon.com/docs/session#drivers)
- [CSRF Protection](https://marmeon.com/docs/csrf)
- [Security: sessions and cookies](https://marmeon.com/docs/security#sessions-and-cookies)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
