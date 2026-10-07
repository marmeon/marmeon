# @marmeon/storage

Disks (E91): files under keys — on the local file system, in S3 (or an S3-compatible store) or in memory — behind one
contract. Public disks are served by the app with safe headers; **private disks are never public**: their files leave only
through signed URLs that expire. On top of the disks: [uploads](#uploads) — a file goes ahead of its form, onto a private
disk, and the form's request checks it.

`marmeon discover` registers its `StorageServiceProvider` like any installed package. What it serves needs
[@marmeon/http](../http/README.md) (public disks, temporary URLs); uploads also need `@marmeon/database` and
[@marmeon/encryption](../encryption/README.md); S3 needs the AWS SDK (optional peers, [below](#s3)).

```ts
// config/storage.ts — listed in the app's `config` (defineApplication({ config: [AppConfig, AppStorage] }))
export const AppStorage = defineStorage({
  env: v.object({ S3_BUCKET: v.optional(v.string()), S3_REGION: v.optional(v.string()), S3_ENDPOINT: v.optional(v.string()) }),
  default: 'local',
  disks: (env) => ({
    local: { driver: 'local', root: 'storage/app/private' },                                       // private (default)
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
    uploads: { driver: 'local', root: 'storage/app/uploads' },                                     // where uploads wait (UPLOADS_DISK)
    s3: { driver: 's3', bucket: env.S3_BUCKET, region: env.S3_REGION, endpoint: env.S3_ENDPOINT },
  }),
});
declare module '@marmeon/storage' { interface StorageTypes { storage: typeof AppStorage } }
// → storage.disk('pubic') and storage.disk('local').url(…) are type errors

// anywhere — constructor(storage: Storage)
const disk = this.#storage.disk('public');
await disk.put('avatars/7.webp', file, { contentType: 'image/webp' });   // text, bytes, Blob/File, web or Node stream
disk.url('avatars/7.webp');                                               // → /storage/avatars/7.webp
const url = await this.#storage.disk('local').temporaryUrl('exports/7.json', { expiresIn: { minutes: 5 }, filename: 'my-data.json' });
return this.redirect(url, 303);                                           // local: a signed app route; S3: a presigned GET
```

## Configuration

**Disks:** `defineStorage({ env?, default, disks })` is the config class — in the app's `config` (or a module's; one per app).
Without one the app has Laravel's two disks, `local` (private, `storage/app/private`) and `public` (`storage/app/public` under
`/storage`), plus `uploads` (private, `storage/app/uploads`). An app that defines its own disks and takes uploads lists
`uploads` too — otherwise the first upload fails with the line to add.

| Driver | Options (besides `visibility: 'private' \| 'public'`, default `private`) |
|---|---|
| `local` | `root` (relative to the app root, created on first use — keep it under `storage/`, the one directory a production deployment lets the app write: a volume owned by `node` in `make:docker`'s image, `ReadWritePaths` in its systemd units), `url` (public disks: a path the app serves, or an absolute URL — a CDN) |
| `s3` | `bucket`, `region`, `endpoint` (S3-compatible stores), `forcePathStyle` (default `true` with an `endpoint`), `credentials` (else the SDK's chain), `root` (a prefix in the bucket), `url` (public disks; default endpoint/bucket) |
| `memory` | `url` — gone with the process; tests and throwaway setups |

**Uploads** (`UploadsConfig`):

```sh
UPLOADS_DISK=uploads          # the private disk uploads wait on until a form stores them (a public one fails the start)
UPLOADS_CONNECTION=default    # the database connection of temporary_uploads — never in the app's transactions (E108)
UPLOADS_LIFETIME=120          # minutes a token works after its target was handed out (at most 1440)
UPLOADS_SEND_WITHIN=15        # minutes the browser has to send the file to its target
```

## The contract

`put`, `get` (bytes), `text`, `stream`, `open` (stream + size + time + type), `exists`, `delete` (→ whether there was a
file), `move`, `copy`, `size`, `mimeType`, `lastModified`, `list(directory, { recursive })`, `url`, `temporaryUrl`. A missing
file throws `FileNotFoundError`. `diskAttachment(disk, key)` turns a file into a mail attachment
([attachments](../mail/README.md#attachments)). With `StorageTypes` registered, `url()` on a private disk is a type error that
names `temporaryUrl()`.

## Keys — two measures against path traversal

1. **Every key is checked** on every disk (`normalizeKey`): relative `/`-separated segments; no `..` or `.` segment, no
   absolute path or drive letter, no backslash, no NUL or other control character, no empty segment, ≤ 1024 bytes. Nothing is
   "cleaned up" — a key that would need it is refused, so `avatars/../secret.txt` never reaches `secret.txt`.
2. **The local driver's root jail:** each path is resolved with `realpath` and must lie inside the root's real path — a
   symlink that leads out of the root is refused for reads *and* for the directory a new file would be written into
   (checked segment by segment before anything is created). Reads open the checked path with `O_NOFOLLOW`; writes go to a
   temporary file in the checked directory (`O_EXCL`) and are renamed into place — a symlink at the key is replaced, never
   written through, and readers never see half a file. Symlinks inside the root are followed. What remains is a race on a
   directory between its check and its use, which needs someone who can already create symlinks inside the root.

S3 keys are checked too: some S3-compatible stores map keys onto paths.

## Serving

- **Public local (or memory) disks** whose `url` is a path get a route `GET {url}/<key>` — outside every middleware group
  (no session, no cookies). An absolute `url` (a CDN) gets none.
- **Temporary URLs** of local and memory disks: `GET /_marmeon/storage/<disk>/<key>?expires=…&signature=…`, signed by `UrlSigner` of
  [@marmeon/http](../http/README.md) (its own key from `APP_KEY`; path, `filename` and expiry signed; the time from the app's
  `Clock`), behind `signed()` — tampered or expired: 403. Works for public and private disks; S3 disks presign instead.
- Every file goes out with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and — for everything but
  raster images (PNG, JPEG, GIF, WebP, AVIF) — `Content-Disposition: attachment`. HTML, SVG (it can carry script), XML, PDF
  and text are downloads, never pages on the app's origin. Public files: `Cache-Control: public, max-age=0,
  must-revalidate` with `Last-Modified`/304; temporary URLs: `private, no-store`.
- A refused key and a missing file are the same 404. The content type comes from the extension (local) or what was
  stored (S3, memory) — a disk does not inspect bytes; uploads do (their type by magic bytes, see Uploads).
- At startup a **private local disk that shares a directory with a public one** (the same root, or one inside the other,
  also through symlinks) fails the boot: its files would be served as public. So does a private disk with a `url`.

## S3

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are optional peers — loaded on first use, with an install message
if missing (`pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`). A disk without a bucket (an unset `S3_BUCKET`)
fails on first use, not at startup. With an `endpoint`, the bucket goes into the path and the SDK's newer default checksums
are only sent when required (S3-compatible stores). Visibility is the disk's, not the object's: a public S3 disk needs a
bucket policy that makes it readable — the disk sets no ACLs. `temporaryUrl()` presigns a GET with
`response-content-disposition` (attachment unless the file's name — `filename`, else the key — has a raster image's extension;
the stored `Content-Type` goes out as it is). The store serves these files itself: the headers of [Serving](#serving)
(`nosniff`, `sandbox`) are the app's and do not apply — keep the bucket on an origin of its own, never the app's. Streams of
unknown length are read into memory before the `PutObject` (multipart uploads: later).

The S3 tests run against an S3-compatible container: `docker compose up -d` (service `s3`, SeaweedFS on 56333 — MinIO's
community edition is archived and LocalStack's image needs an account token), then `pnpm test:s3`. They are not part of
`pnpm test`.

## Uploads

Livewire's three steps (W6.9), with what the route already knows deciding everything:

1. **A target for the field.** The browser asks the form's own route — its method and URL, with `x-marmeon-upload: avatar` and
   `{ name, size, type }` — for a target. The route's middleware, bindings and `authorize` run (whoever may send the form may
   upload its files — no second policy); its controller does not. The field's `upload()` rule in the request schema decides the
   limit (no such rule: 404; a file the browser says is too large: 422). The answer is a token `tu_<id>.<hmac>` and where the
   bytes go: a signed URL of the app (`PUT /_marmeon/uploads/<id>`, 15 minutes) or — when the uploads disk is S3 — a
   **presigned POST** with `content-length-range` (the store refuses one byte more; the bucket needs CORS for the app's origin,
   and `pnpm add @aws-sdk/s3-presigned-post`). A target belongs to a **session** — without one it is a 419. A guest's page keeps
   none by itself (E143), so a guest's page with an upload field keeps it: the injected `Session`'s `persist()` in its
   controller ([new sessions](../session/README.md#new-sessions-are-only-kept-when-used)).
2. **The bytes**, with progress — streamed onto the private `uploads` disk (`UPLOADS_DISK`), cut off after `maxBytes` whatever
   `Content-Length` said (413, and nothing stays: the disk writes a temporary file and renames it only when complete). Never
   through `ctx.input()`/`MAX_BODY_SIZE`, never in memory.
3. **The token in the form.** On submit, before the schema runs, the token is verified — its signature, the **session** it was
   made for (a hash of the session id), the route and field, its expiry (`UPLOADS_LIFETIME`, 2 hours), that it was not used —
   and the file's type is read from its **first bytes** (never the name or the `Content-Type` the browser sent). The rule then
   checks the size and the type; HTML, SVG and XML are never accepted, whatever `mime` says.

```ts
export const UpdateAvatarRequest = defineRequest({
  schema: v.object({ avatar: upload({ maxBytes: 2_000_000, mime: ['image/png', 'image/jpeg', 'image/webp'] }) }),
  authorize: can(ProfilePolicy, 'update', 'user'),
});
// ctx.body.avatar is a TemporaryUpload — `store()` uses the token up (once) and moves the file:
const path = await ctx.body.avatar.store(this.#storage.disk('public'), 'avatars'); // 'avatars/<26 random chars>.png'
```

- **Once:** `store()` marks the token used with one `UPDATE … WHERE consumed_at IS NULL` — of two submits racing, exactly one
  stores the file; the other is a 422 of its field. A failed submit keeps the token usable (fix another field, send again).
- **Infrastructure ([E108](../database/README.md#infrastructure-connections-e108)):** the table `temporary_uploads`
  (`marmeon make:uploads-table [--module=system]`, E96) is written on its own connection
  (`UPLOADS_CONNECTION`), never in the app's transaction — a rollback never makes a used token usable again. With SQLite give it
  the file of the cache and sessions (`system`); on Postgres it opens its small pool by itself.
- **Never echoed:** a `TemporaryUpload` serializes to nothing — old input after a failed submit, logs and JSON never hold the
  token or the file.
- **Housekeeping:** `marmeon uploads:prune [--hours=24]` deletes uploads made more than a day ago — the rows first (one
  statement), then their files. Schedule it hourly (`s.command('uploads:prune').hourly().withoutOverlapping().onOneServer()` —
  [@marmeon/scheduler](../scheduler/README.md); with a local uploads disk on several servers, on each, without `onOneServer()`).
- **Not yet:** lists of files (`v.array(upload(…))`) and a `<Form>` without JavaScript (it would post the file itself — refused).

The browser side is the `uploads` feature of `@marmeon/http/client` ([features](../http/README.md#features)) and `<FileInput
field={form.field('avatar')} />` of [@marmeon/react](../react/README.md). Tests: `app.upload(route, field, file, params)`
(below).

## Testing

`createTestApp` ([@marmeon/testing](../testing/README.md)) replaces `Storage` with a `StorageFake` (`storage: 'fake'`, the
default): every configured disk is a memory disk with its name, visibility and URL — the app's routes serve it, temporary URLs are
signed for real. Assertions:

```ts
app.storage.disk('local').assertExists(`exports/user-${ada.id}.json`).assertCount(1);
app.storage.disk('public').assertExists('avatars/7.webp', (bytes, file) => file.contentType === 'image/webp');
app.storage.disk('public').assertMissing('avatars/old.webp');
```

`createTestApp(app, { storage: 'real' })` keeps the configured disks.

Uploads go through the real target and the real receiving route, onto the fake `uploads` disk — `app.upload()` returns the
token the form sends. The upload belongs to the view's session: send the form through the same view.

```ts
const ada$ = app.actingAs(ada);
const token = await ada$.upload('user-profile.avatar.update', 'avatar', new File([png], 'me.png'), { user: ada.id });
app.storage.disk('uploads').assertCount(1);
await ada$.expectingJson().put(`/users/${ada.id}/avatar`, { json: { avatar: token } }).assertRedirect();
app.storage.disk('public').assertCount(1);
```
