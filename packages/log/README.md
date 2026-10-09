# @marmeon/log

The logger of Marmeon apps: pino behind the core's `Logger` contract — readable in development, JSON lines in production, with
the request's and the job's context in every entry and secrets redacted.

## Installation

Part of every new Marmeon app: `pnpm create marmeon` installs it.

## Writing log entries

```ts title="modules/notes/NoteImporter.ts"
import { Logger } from '@marmeon/core';

export class NoteImporter {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  async import(userId: number, rows: readonly string[]): Promise<void> {
    this.#logger.info('Notes imported', { userId, count: rows.length });
  }
}
```

Keep the message fixed and put the values into the context, so a log shipper can group and search the entries.

## Documentation

- [Logging](https://github.com/marmeon/marmeon/blob/main/docs/logging.md)
- [Logging: keeping secrets out of the log](https://github.com/marmeon/marmeon/blob/main/docs/logging.md#keeping-secrets-out-of-the-log)
- [Observability: the log channel](https://github.com/marmeon/marmeon/blob/main/docs/observability.md#the-log-channel)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
