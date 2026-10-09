# @marmeon/session

Sessions for Marmeon apps: an injectable session on file, database, Redis, cookie or memory stores, flash data and CSRF
protection.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

The `database` driver needs `@marmeon/database`, which a new app has, and the `redis` driver `@marmeon/redis`, which brings the
Redis client: `pnpm add @marmeon/redis`. A driver whose package is missing stops the start with the command that installs it.

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

- [Session](https://github.com/marmeon/marmeon/blob/main/docs/session.md)
- [Session: drivers](https://github.com/marmeon/marmeon/blob/main/docs/session.md#drivers)
- [CSRF Protection](https://github.com/marmeon/marmeon/blob/main/docs/csrf.md)
- [Security: sessions and cookies](https://github.com/marmeon/marmeon/blob/main/docs/security.md#sessions-and-cookies)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
