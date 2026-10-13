# @marmeon/cache

The cache of Marmeon apps, with atomic locks and rate limits — on files, the database, Redis or memory, behind one contract.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

The `file` and `memory` drivers need nothing more. `CACHE_DRIVER=database` needs `@marmeon/database`, which a new app has, and
`CACHE_DRIVER=redis` needs `@marmeon/redis`, which brings the Redis client: `pnpm add @marmeon/redis`. A missing package stops the
start and names the command.

## A first cached value

```ts title="modules/notes/controllers/ShowNoteStatsController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Cache } from '@marmeon/cache';
import { Controller, type HttpContext } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';

export class ShowNoteStatsController extends Controller {
  readonly #cache: Cache;
  readonly #notes: NoteRepository;

  constructor(cache: Cache, notes: NoteRepository) {
    super();
    this.#cache = cache;
    this.#notes = notes;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const stats = await this.#cache.remember(`notes:stats:${ctx.user.id}`, 600, () => this.#notes.statsFor(ctx.user.id));
    return this.view('notes/Stats', { stats });
  }
}
```

## Documentation

- [Cache](https://marmeon.com/docs/cache)
- [Cache: locks](https://marmeon.com/docs/cache#locks)
- [Rate Limiting](https://marmeon.com/docs/rate-limiting)
- [Redis](https://marmeon.com/docs/redis)
- [Cache: testing](https://marmeon.com/docs/cache#testing)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
