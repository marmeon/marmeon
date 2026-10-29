# File Storage

## Introduction

`@marmeon/storage` keeps files under keys on *disks*: a directory of the server, an S3 bucket, or memory in tests. Every disk has
the same methods, so code that writes an avatar does not care where it lands. A disk is **public** or **private**. The app serves
the files of a public disk, with headers that keep them from running as pages of your app. A private disk's files leave only
through signed links that expire.

Add the package to an app, in the version of its other framework packages:

```sh
pnpm add -E @marmeon/storage@<version of your app>
```

Then inject `Storage` and pick a disk. This controller writes a user's notes to the private `local` disk and sends the browser a
link to the file that works for five minutes:

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
    return this.redirect(await disk.temporaryUrl(key, { expiresIn: { minutes: 5 }, filename: 'my-notes.json' })).status(303);
  }
}
```

The package also takes **uploads**: a file goes to a private disk ahead of its form, and the form's request checks it. The
[uploads](#uploads) section explains them.

## Configuration

Without any configuration an app has three disks on the local file system:

| Disk | Directory | Visibility |
| --- | --- | --- |
| `local` | `storage/app/private` | Private. The default disk. |
| `public` | `storage/app/public` | Public, served under `/storage`. |
| `uploads` | `storage/app/uploads` | Private. Where uploads wait for their form. |

Disks of your own come from `defineStorage()`, a configuration you list in the app's `config`:

```ts title="config/storage.ts"
import { env } from '@marmeon/core';
import { defineStorage } from '@marmeon/storage';

export const AppStorage = defineStorage({
  env: env({
    S3_BUCKET: env.string().optional(),
    S3_REGION: env.string().optional(),
    S3_ENDPOINT: env.url().optional(),
  }),
  default: 'local',
  disks: (e) => ({
    local: { driver: 'local', root: 'storage/app/private' },
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
    uploads: { driver: 'local', root: 'storage/app/uploads' },
    s3: { driver: 's3', bucket: e.S3_BUCKET, region: e.S3_REGION, endpoint: e.S3_ENDPOINT },
  }),
});

declare module '@marmeon/storage' {
  interface StorageTypes {
    storage: typeof AppStorage;
  }
}
```

List it in `bootstrap/app.ts`, beside the app's other configuration: `config: [AppConfig, AppStorage]`. An app has one
`defineStorage()`. With `StorageTypes` declared, `storage.disk('pubic')` is a compile error that names the disks, and so is
`url()` on a private disk. `disk()` without a name is the default disk. An app with its own disks that takes uploads lists
`uploads` too, or the first upload fails with the line to add.

| Driver | Options, besides `visibility: 'private' \| 'public'` |
| --- | --- |
| `local` | `root`, relative to the app. `url` for a public disk: a path the app serves, such as `/storage`, or the absolute URL of a CDN in front of the directory. It must not lie under `/_marmeon/`: the app does not start (see [the framework's paths](routing.md#the-frameworks-paths)). |
| `s3` | `bucket`, `region`, `endpoint` for an S3-compatible store, `forcePathStyle`, `credentials`, `root` as a prefix in the bucket, `url` for a public disk. |
| `memory` | `url`. The files are gone with the process: for tests. |

Disks are private unless they say `visibility: 'public'`. Keep a local disk's `root` under `storage/`: it is the one directory
a production deployment lets the app write, and the [deployment](deployment.md#storage-and-a-read-only-file-system) page shows
how to keep it.

## Using a disk

| Method | What it does |
| --- | --- |
| `put(key, contents, { contentType }?)` | Writes a file, replacing one under the same key. `contents` is text, bytes, a `Blob` or `File`, or a stream. |
| `get(key)` | The file's bytes. |
| `text(key)` | The file as UTF-8 text. |
| `stream(key)` | The file as a stream, for large files. |
| `open(key)` | A stream with the file's size, time and content type. |
| `exists(key)` | Whether there is a file. |
| `delete(key)` | Removes the file, and says whether there was one. |
| `move(from, to)`, `copy(from, to)` | On the same disk, replacing the target. |
| `size(key)`, `mimeType(key)`, `lastModified(key)` | What they say. |
| `list(directory?, { recursive }?)` | The keys in a directory, sorted. |
| `url(key)` | The public URL of a file on a public disk. |
| `temporaryUrl(key, { expiresIn, filename?, base? })` | A signed link that expires. `expiresIn` is seconds, or a [`Duration`](time.md#spans-of-time) such as `{ minutes: 5 }`, and at most seven days on every disk. |

A `Disk` is given to your code by `storage.disk()`; it is not meant to be implemented, and a later release may add a member. A disk of your own implements `DiskDriver` ([disk drivers](#disk-drivers)).

A missing file throws `FileNotFoundError`. A reader never sees half a file: the local driver writes to a temporary file and
renames it into place. The content type comes from the key's extension on a local disk, and from what was stored on S3 and in
memory: `put()`'s `contentType` counts there only.

## Public and private files

`url()` is for public disks. `disk('public').url('avatars/7.webp')` is `/storage/avatars/7.webp`, and the app serves it on a
route of its own, outside every middleware group: no session, no cookies. A disk whose `url` is an absolute URL, a CDN, gets no
route.

`temporaryUrl()` works on every disk. For a local disk it is a path of the app,
`/_marmeon/storage/<disk>/<key>?expires=…&signature=…`, signed with a key derived from `APP_KEY`, and the signature covers the
path, the file name and the expiry. A changed or expired link answers 403. `base` makes it absolute, for a mail: pass the `url` of
the injected `AppConfig`, which is `APP_URL`. An S3
disk presigns a link to the bucket instead. A link lasts at most seven days on every disk (the limit of S3's presigned URLs); `expiresIn` beyond that throws a `RangeError`. For a link that lasts, serve the file through a route of your own with `serveFile()`.

Every file the app serves goes out with:

- `X-Content-Type-Options: nosniff`, so the browser never guesses HTML in a picture;
- `Content-Security-Policy: sandbox`, so a file that is shown anyway runs no script and gets no cookies;
- `Content-Disposition: attachment` for everything but PNG, JPEG, GIF, WebP and AVIF images. HTML, SVG, XML, PDF and text are
  downloaded, never shown on your app's origin.

A public file is sent with `Cache-Control: public, max-age=0, must-revalidate` and its `Last-Modified`, a temporary link with
`private, no-store`. A missing file and a refused key are the same 404, so nobody learns which files exist. To send a file from a
controller of your own, behind its own policy, use `serveFile()`, which the [responses](responses.md#downloads) page shows.

The start fails when a private local disk shares a directory with a public one, the same root or one inside the other, also
through a symlink: its files would be served as public. So does a private disk with a `url`, and on S3 a private and a public
disk in one bucket whose prefixes overlap.

## Keys

A key is a relative path of `/`-separated segments, such as `avatars/7.webp`. Two measures keep a key inside its disk:

1. **Every key is checked**, on every disk: no `.` or `..` segment, no leading `/` or drive letter, no backslash, no control
   character, no empty segment, at most 1024 bytes. A key that breaks a rule throws `InvalidKeyError`. Nothing is cleaned up,
   so `avatars/../secret.txt` is refused instead of reaching `secret.txt`.
2. **A local disk stays inside its root.** Each path is resolved, symlinks included, and must lie inside the root's real path.
   A symlink that leads out of the root is refused, for reads and for the directory a new file would go into. A symlink at the
   key itself is replaced on write, never written through.

Still, build keys from values you control, such as an id, rather than from a name a user typed.

## S3

An S3 disk needs the AWS SDK, which the app installs itself:

```sh
pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3
```

When the default disk or the uploads disk is on S3, the start checks that the SDK is installed and fails with this command if it
is not. A disk the app only names somewhere says so when it is first used, and so does a disk without a bucket, such as an unset
`S3_BUCKET`. Without `credentials` the SDK finds them itself: from the environment or the machine's role. With an `endpoint`, the
bucket goes into the path, which most S3-compatible stores expect.

A disk's visibility is the disk's, not the object's. A public S3 disk needs a bucket policy that makes its files readable, since
the disk sets no ACLs. `temporaryUrl()` presigns a download that is an attachment unless the file name is a raster image's, with
the content type of the file name's extension.

> [!WARNING]
> Files on S3 are served by the store, not by the app, so the headers of [public and private files](#public-and-private-files)
> do not apply. Keep the bucket on an origin of its own, never your app's domain: an HTML file there would run as a page of your
> app.

A stream of unknown length is read into memory before it is uploaded.

## Disk drivers

A package or an app can bring its own disk driver, for Google Cloud Storage or an FTP server say. Its provider lists it in
`static diskDrivers`, and a disk in `defineStorage()` names it with `driver`. The framework keeps visibility and signed links
for it as for the built-in disks, and gives its `temporaryUrl()` the expiry as `expiresInSeconds`, whole seconds, whatever span the app wrote. The [drivers](drivers.md#disk-drivers) page has the contract and what it guarantees.

## Uploads

A file from a user goes ahead of its form. The browser sends it while the user fills in the rest, with progress, and the form
then sends a token in the file's place:

1. **A target for the field.** The browser asks the form's own route for a target, with the file's name, size and type. The
   route's middleware, bindings and `authorize` run, so whoever may send the form may upload its files, and the field's `upload()`
   rule decides the limit. The controller does not run. A field without the rule is a 404, a file that is too large a 422.
2. **The bytes** stream onto the private `uploads` disk, never into memory, and are cut off at the size the browser announced (never
   above the rule's `maxBytes`), whatever its `Content-Length` says. A file that is cut off leaves nothing behind.
3. **The token in the form.** On submit, before the schema runs, the token is checked: its signature, the session it was made
   for, the route and the field, its expiry, and that it was not used yet. The file's type is read from its first bytes, never
   from its name or the type the browser sent (that one is sent, not trusted), and the rule checks the size and the type.

The controller gets a `TemporaryUpload` and stores it where it belongs. The [requests](requests.md#files) page shows the
controller, the [validation](validation.md#uploads) page the rule, and the [forms](forms.md#uploads) page the browser's side.

- **Once.** `store(disk, directory)` uses the token up and moves the file under a random name with the extension of its real
  type. Of two submits that race, exactly one stores the file, and the other gets a 422 at its field. A submit that fails on
  another field keeps the token usable.
- **An image's size.** `await upload.dimensions()` returns the `{ width, height }` of a PNG, JPEG, GIF, WebP or AVIF as a browser
  shows it, with an EXIF turn or an AVIF rotation applied. It reads only the first 256 KB (a ranged read on S3, pinned by the
  ETag like the type check) and decodes nothing; a file that is no image, or whose header is cut off or damaged, gives
  `undefined`. Call it before `store()`, which moves the file (afterwards it throws), and keep the size with the record. See
  [images](images.md#images-from-the-server).
- **A session.** An upload belongs to the session it was made in, and a request without one gets a 419. A guest's page keeps no
  session by itself, so a guest's page with an upload field calls `persist()` of the injected `Session` in its controller. The
  [session](session.md#when-a-session-is-kept) page explains why.
- **Never echoed.** A `TemporaryUpload` turns into nothing as JSON: old input after a failed submit, a log line and a JSON answer
  never hold the token or the file.
- **HTML, SVG and XML** are never accepted, whatever the rule's `mime` list says.
- **The types a rule can name** are those known by their first bytes: PNG, JPEG, GIF, WebP and AVIF images, PDF, ZIP, MP4 and MP3.
  Any other type in `mime` throws when the rule is built. A file of another format, such as CSV, counts as
  `application/octet-stream`, which only a rule without `mime` accepts.
- **A text file of any format.** `upload({ maxBytes, text: true })` takes a file such as a CSV that passes as text, by its first
  1 024 bytes: no signature known here (image, PDF, ZIP, MP4, MP3), no markup at the start (HTML, SVG, XML, in UTF-8 and UTF-16
  alike), and no `0x00` byte, which is how binary files and executables show. Behind a UTF-16 byte order mark text has NUL bytes, so
  there no 16-bit unit may be zero, and no known format may follow the mark. UTF-8 (with or without a BOM), Windows-1252 and UTF-16
  with a BOM pass; UTF-16 without a BOM does not. A long file that starts with nothing but blanks is refused, and an empty file
  counts as text. A script (shell, JavaScript, PostScript) is text too: the content is data, and it is as safe as the way it leaves
  the app. Serve it through `serveFile()` or `temporaryUrl()` (`nosniff`, `sandbox`, a download; see
  [public and private files](#public-and-private-files)); an app that shows or converts it another way escapes it, or decodes it
  strictly, itself. `text` and `mime` together are a type error: they are two statements about one file. The upload's `mime`
  stays `application/octet-stream` and `store()` names the file `….bin`.
- **One file per field.** A file belongs in a field of its own, in the body or in an object that is always there; the field
  itself may be `upload(…).nullable()`. A list of files, a file inside an optional or nullable object, in a union or in
  `.when()` fields stops the start when the routes load (error S2), and the message names the field. (A form without JavaScript is not
  supported either.)
  A schema built [per request](validation.md#a-schema-built-per-request) is read with the request instead: its unsupported shape answers 500 then.

On S3, the browser sends the file straight to the bucket with a presigned POST that limits its size. The bucket then needs CORS
for your app's origin, and the app one more package: `pnpm add @aws-sdk/s3-presigned-post@^3`.

A presigned POST can be used again until it expires, so a second POST could replace a file after its type was read. The check
therefore pins the object by its ETag: the first bytes are read only if the object still has it, and `store()` copies or reads
the file only if it still has it too. A file that changed in between is refused like one that never arrived (a 422 at its field). The store must honour conditional reads and copies (`If-Match`, `x-amz-copy-source-if-match`); AWS S3
does, and so does the S3-compatible store the tests run against.
Storing does not read the file into memory: on the same S3 store the bucket copies it, elsewhere it is streamed with its length.

### Reading an upload

`await upload.bytes()` returns the file as a `Uint8Array`, and `await upload.text()` as UTF-8 text with a
leading byte order mark removed. Neither uses the upload up: the file stays where it is and `store()` still works, so an import
can read, check and answer without keeping anything, and a corrected form can send the same token again. A second call reads
the file again. At most the checked `size` is read, so a file that grew meanwhile is not buffered, and on S3 the read is pinned by
the ETag like `store()`. A file that is gone, changed, shorter or longer than checked is a 422 at its field ("The file did not arrive"); so is
`text()` of bytes that are no UTF-8. For another encoding take `bytes()`, and for a CSV `readCsv()`
([importing a CSV file](tables.md#importing-a-csv-file)). The bytes sit in memory, so keep the rule's `maxBytes` as low as the
use needs. Like `dimensions()`, both throw after `store()`, which moves the file.

### An upload over several requests

A flow that spans requests (upload, preview, confirm) can hold the upload in the session instead of keeping a table of its own.
`await upload.keep({ scope: 'products-import', minutes: 30 })` returns the upload's `id`; put it where the next request finds it
(a flash message, a path). The next request injects `StagedUploads` and asks `await uploads.staged(id, 'products-import')`, which
returns the `TemporaryUpload` again (`bytes()`, `text()`, `store()`, `dimensions()` work as before) or `undefined`.

```ts
// the preview: read and show the file, then hold it
const id = await ctx.body.file.keep({ scope: 'products-import', minutes: 30 });
// the confirmation: a path parameter names it, the session decides whether it is this user's
const file = await this.#uploads.staged(ctx.params.import, 'products-import');
if (!file) abort(404);
```

- **Bound as before.** A kept upload still belongs to the session it was made in, and `staged()` takes that session from the
  request, never from the id. Another session, a request without one, another scope, a made-up id, a used or an expired upload
  are all the same `undefined`, so an id tells nobody anything. The scope (letters, digits, `.`, `-`, `_`, at most 100) names the
  flow; the token the form sent stops working once the upload is kept.
- **Not for ever.** `minutes` is 1 to 1 440. Holding an upload again restarts the wait, but never past 24 hours after it was
  made. Once the wait is over `staged()` finds nothing, and `uploads:prune` deletes the file and its row like any other expired
  upload.
- **Counted.** A kept upload is one of the session's open uploads (`UPLOADS_MAX_OPEN` and the byte limits) until it is used up,
  discarded or expired.
- **Pinned.** On S3 a presigned POST can send to the key again until it expires, so `keep()` pins the object the form's check saw
  (its ETag, kept with the scope) and `staged()` returns it only if it is still that object: a file replaced after the check, by
  another type or by anything else, is `undefined`. `staged()` also reads the type from the bytes again, and a file that is HTML,
  SVG or XML, or larger than the field allowed, is not returned. On a local disk the bytes arrive once, so there is nothing to swap.
- **Use it up or drop it.** `store()` uses a kept upload up like any other. `await upload.discard()` deletes the file and the row
  when the flow ends without storing it (`false` when it was used already).
- **A new session id drops it.** Whatever gives the session a new id — signing in or out, confirming the password, a second factor, a
  passkey — starts a new session scope, so a flow does not carry over: the uploads kept before expire on their own.

`keep()` throws a `TypeError` for a scope or minutes out of range and for an upload that was used or has expired.

### The uploads table

Uploads keep their tokens in a table, which the app creates once. The table is `temporary_uploads` (`UPLOADS_TABLE` of `@marmeon/storage`):

```sh
pnpm marmeon make:uploads-table
pnpm marmeon migrate
```

`/up/ready` checks the table's columns once the uploads are set up, which is when storage, http, database and encryption are all
loaded. An app that never made the table, because it uses storage for its disks alone, stays ready; an upload then says which
command makes the table.

`make:uploads-table` writes the migration into the `system` module, or the module `--module` names. It is `marmeon publish
@marmeon/storage`: when your app has the migration already, it writes nothing and ends with exit code 0. Like the cache, the table is
written on a connection of its own and never inside the app's transactions: a rollback after `store()` must not make a used token
usable again. On SQLite give it the cache's own file with `UPLOADS_CONNECTION`, as the
[cache](cache.md#the-database-driver-and-transactions) page explains. Postgres needs nothing.

The table has two indexes for the counts of open uploads. A table created before the limits lacks them, and one more migration
adds them. Name its file with the current timestamp, so it runs after the create migration. A table made by the current
`make:uploads-table` has the indexes already, and the migration then changes nothing:

```ts title="modules/system/migrations/2026_10_16_090000_index_temporary_uploads_table.ts"
import { defineMigration, sql } from '@marmeon/database';
import { uploadsTableConnection } from '@marmeon/storage';

export default defineMigration({
  connection: uploadsTableConnection,
  up: (schema) => {
    schema.raw(sql`create index if not exists temporary_uploads_expires_at_index on temporary_uploads (expires_at)`);
    schema.raw(sql`create index if not exists temporary_uploads_session_expires_at_index on temporary_uploads (session, expires_at)`);
  },
  down: (schema) => {
    schema.raw(sql`drop index if exists temporary_uploads_session_expires_at_index`);
    schema.raw(sql`drop index if exists temporary_uploads_expires_at_index`);
  },
});
```

| Variable | Default | Effect |
| --- | --- | --- |
| `UPLOADS_DISK` | `uploads` | The private disk where uploads wait. A public disk fails the start. |
| `UPLOADS_CONNECTION` | `default` | The database connection of the uploads table. |
| `UPLOADS_LIFETIME_MINUTES` | `120` | Minutes a token works after its target was handed out, at most 1440. |
| `UPLOADS_SEND_WITHIN_MINUTES` | `15` | Minutes the browser has to send the file to its target, at most 1440. |
| `UPLOADS_MAX_OPEN` | `20` | Open uploads one session may hold. |
| `UPLOADS_MAX_OPEN_MB` | `1024` | Megabytes the open uploads of one session may announce together. |
| `UPLOADS_MAX_OPEN_TOTAL_MB` | `10240` | Megabytes the open uploads of all sessions together may announce. `0` turns the limit off. |

An upload is open from its target until the form uses it up or its token expires. A target that would pass one of the three limits
gets a 429 with a `Retry-After` header (seconds until the first open upload that counts expires), and the browser shows the
message at the field. A guest session costs nothing to make, so the limit over all sessions is the one that keeps unsent files
from filling the disk: it turns "disk full" into "uploads refused" while the rest of the app keeps running. The browser announces
each file's size with its target, and the bytes are cut off there (a 413 above it), so the sums stay honest. Forms that take many
or large files in one session raise the first two. Every open upload counts for at least 64 KiB in the sums, so even empty files
run into the limits. A file larger than a limit could ever take gets a 422 with the real maximum, never a 429.

`uploads:prune` deletes every unused upload whose token has expired (`UPLOADS_LIFETIME_MINUTES`) and every upload made more than a day
ago, used or not: the rows first, then their files. `--hours` changes the age, and a value below `UPLOADS_LIFETIME_MINUTES` would delete uploads
whose form is still open, so it needs `--force`. An upload kept for a later request is spared while it waits, whatever `--hours` says. Unsent files stay on the disk until it runs, so schedule it every hour:

```ts title="modules/system/schedule.ts"
import { defineSchedule } from '@marmeon/scheduler';

export const schedule = defineSchedule((s) => {
  s.command('uploads:prune').hourly().withoutOverlapping().onOneServer();
});
```

With a local uploads disk on several servers, each server has its own files: run it on every server, without `onOneServer()`.

### Replacing a file

`store()` returns the key it chose, a random name, so keep that key in the record. Replacing a stored file touches two systems
that cannot commit together, a disk and the database. Order the work so that a failure leaves at most a stray file, never a
record that points at nothing. Only a connection lost during the commit itself can leave the record without its file: the server
may have committed while the app sees an error, and `afterRollback()` then deletes a file the committed row names. To rule that
out, leave the delete out of `afterRollback()` and clear stray files with `list()` from time to time.

1. Store the new file **before** the transaction, so the record never names a file that does not exist yet.
2. Inside the transaction, register `afterRollback()` to delete the new file, then write the new key.
3. Register `afterCommit()` to delete the old file, so it goes only once nothing points at it any more.

```ts title="modules/notes/NoteCovers.ts"
import { afterCommit, afterRollback, Connections } from '@marmeon/database';
import { Storage, type TemporaryUpload } from '@marmeon/storage';
import { NoteRepository } from './NoteRepository.ts';

export class NoteCovers {
  readonly #connections: Connections;
  readonly #notes: NoteRepository;
  readonly #storage: Storage;

  constructor(connections: Connections, notes: NoteRepository, storage: Storage) {
    this.#connections = connections;
    this.#notes = notes;
    this.#storage = storage;
  }

  async replace(noteId: number, upload: TemporaryUpload) {
    const disk = this.#storage.disk('public');
    const key = await upload.store(disk, 'covers');
    return this.#connections.transaction(async () => {
      await afterRollback(() => disk.delete(key).catch(() => false)); // the record never got the new file
      const note = await this.#notes.findOrFail(noteId); // a missing note throws, which rolls back
      await this.#notes.update(noteId, { cover_path: key });
      const old = note.cover_path;
      if (old) await afterCommit(() => disk.delete(old).catch(() => false)); // nothing points at it any more
      return key;
    });
  }
}
```

The `catch` keeps a failed delete from turning a committed replacement into an error: a stray file is all that is left, and
`list()` finds it. Throw, or return an `err()`, rather than returning plainly: a plain return commits, and `afterRollback()` would not delete the
new file (a stray, not a broken record). The [transactions](transactions.md#after-the-commit) page covers
both hooks.

### A file that is private until its record is published

A file on the `public` disk is reachable at `url()` the moment it is stored, and nothing checks who asks. A file that must wait
for its record, such as an attachment of a draft, therefore never goes onto a public disk before the publication. Store it on a
private disk, `local` for example. A private disk has no `url()` and no route but the signed one of `temporaryUrl()`, so the file has no address at all until your app
gives it one, and the start fails when a private disk shares a directory with a public one (see [public and private
files](#public-and-private-files)). Then choose how readers get the file:

- **Through your own route.** Its controller answers with `serveFile()` behind the policy, which lets the author in at any time
  and everyone else only once `published_at` is set. The [responses](responses.md#downloads) page shows the controller.
  Unpublishing only clears the column.
- **Through a signed link.** `temporaryUrl(key, { expiresIn: { minutes: 5 } })` makes a link that expires. Make it per request,
  after the policy said yes, and never store it. Whoever holds the link can use it until it expires, also after the
  note is unpublished.
- **By copying it to the public disk on publication.** The public copy exists from the commit on, so a draft's file is never
  public, and a transaction that rolls back publishes nothing:

```ts title="modules/notes/NotePublishing.ts"
import { afterCommit, Connections } from '@marmeon/database';
import { Storage } from '@marmeon/storage';
import { NoteRepository } from './NoteRepository.ts';

export class NotePublishing {
  readonly #connections: Connections;
  readonly #notes: NoteRepository;
  readonly #storage: Storage;

  constructor(connections: Connections, notes: NoteRepository, storage: Storage) {
    this.#connections = connections;
    this.#notes = notes;
    this.#storage = storage;
  }

  publish(noteId: number) {
    return this.#connections.transaction(async () => {
      const note = await this.#notes.findOrFail(noteId);
      const key = note.attachment_path;
      if (key) {
        const draft = this.#storage.disk('local');
        const live = this.#storage.disk('public');
        await afterCommit(async () => live.put(key, await draft.stream(key)));
      }
      return this.#notes.update(noteId, { published_at: new Date() });
    });
  }
}
```

A disk copies within itself only, so the file is streamed from one disk to the other. If the copy fails, `transaction()` throws
although the note is published; `put()` replaces a file under the same key, so publishing again is safe. Keep the draft's file
on the private disk if you may unpublish later. When the note is unpublished, delete the public copy in `afterCommit()` and do
not catch the error: a failed delete must show, so that the step can be repeated, since a URL somebody has seen stays reachable
until the copy is gone. Deleting such a record has to remove both copies ([files of deleted records](#files-of-deleted-records)).

### Files of deleted records

A file does not follow its record. When rows are deleted by a foreign key's `cascadeOnDelete()`, the database removes the child rows and
none of your code runs, so their files stay on the disk, public ones still reachable. Delete such a record through code that reads
its files' keys first and deletes the files with `afterCommit()`, as the listener of
[unconfirmed accounts](verification.md#unconfirmed-accounts) does for an avatar.

## Mail attachments

`diskAttachment(disk, key, { filename }?)` turns a file of a disk into an attachment for a mail. The [mail](mail.md#attachments)
page shows it.

## Testing

A test app replaces `Storage` with a fake: every configured disk becomes a memory disk with its name, visibility and URL. The
app's routes serve it, and temporary links are signed for real:

```ts title="modules/notes/download.test.ts"
import { createTestApp } from '@marmeon/testing';
import { it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '#modules/auth';

it('writes the notes to the private disk', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  await app.actingAs(ada).post('/notes/download').assertRedirect();
  app.storage.disk('local').assertExists(`exports/notes-${ada.id}.json`).assertCount(1);
});
```

`assertMissing(key)` and a check of the file's bytes complete the assertions, and `app.upload()` sends an upload through the real
target. `createTestApp(app, { storage: 'real' })` keeps the configured disks. The [fakes](fakes.md#storage) page covers them.
