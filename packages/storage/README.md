# @marmeon/storage

File storage for Marmeon apps: disks on the local file system, S3 or memory behind one contract, public and private files,
signed URLs and uploads.

## Installation

```sh
pnpm add @marmeon/storage
```

The local and memory disks need nothing more. An S3 disk needs the AWS SDK, optional peers the app installs as dependencies:
`pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3`, and for uploads straight to S3 also
`pnpm add @aws-sdk/s3-presigned-post@^3`. A default disk on S3 without them stops the start with that command.

## Writing a file

```ts title="modules/notes/controllers/DownloadMyNotesController.ts"
import type { Authenticated } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { Storage } from '@marmeon/storage';
import { NoteRepository } from '../NoteRepository.ts';

export class DownloadMyNotesController extends Controller {
  readonly #notes: NoteRepository;
  readonly #storage: Storage;

  constructor(notes: NoteRepository, storage: Storage) {
    super();
    this.#notes = notes;
    this.#storage = storage;
  }

  async handle(ctx: HttpContext<Authenticated>) {
    const notes = await this.#notes.query().select(['title', 'body']).where('user_id', '=', ctx.user.id).execute();
    const disk = this.#storage.disk('local');
    const key = `exports/notes-${ctx.user.id}.json`;
    await disk.put(key, JSON.stringify(notes, null, 2));
    return this.redirect(await disk.temporaryUrl(key, { expiresIn: { minutes: 5 }, filename: 'my-notes.json' }), 303);
  }
}
```

## Documentation

- [File Storage](https://github.com/marmeon/marmeon/blob/main/docs/storage.md)
- [File Storage: S3](https://github.com/marmeon/marmeon/blob/main/docs/storage.md#s3)
- [File Storage: uploads](https://github.com/marmeon/marmeon/blob/main/docs/storage.md#uploads)
- [Forms: uploads](https://github.com/marmeon/marmeon/blob/main/docs/forms.md#uploads)
- [Fakes: storage](https://github.com/marmeon/marmeon/blob/main/docs/fakes.md#storage)

MIT · part of [Marmeon](https://github.com/marmeon/marmeon)
