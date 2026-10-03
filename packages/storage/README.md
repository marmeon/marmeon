# @bespokecore/storage

Disks (E91): files under keys — on the local file system, in S3 (or an S3-compatible store) or in memory — behind one
contract. Public disks are served by the app with safe headers; **private disks are never public**: their files leave only
through signed URLs that expire.

```ts
// config/storage.ts — listed in the app's `config`
export const AppStorage = defineStorage({
  env: v.object({ S3_BUCKET: v.optional(v.string()), S3_REGION: v.optional(v.string()), S3_ENDPOINT: v.optional(v.string()) }),
  default: 'local',
  disks: (env) => ({
    local: { driver: 'local', root: 'storage/app/private' },                                       // private (default)
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
    s3: { driver: 's3', bucket: env.S3_BUCKET, region: env.S3_REGION, endpoint: env.S3_ENDPOINT },
  }),
});
declare module '@bespokecore/storage' { interface StorageTypes { storage: typeof AppStorage } }

// anywhere — constructor(storage: Storage)
const disk = this.#storage.disk('public');
await disk.put('avatars/7.webp', file, { contentType: 'image/webp' });   // text, bytes, Blob/File, web or Node stream
disk.url('avatars/7.webp');                                               // → /storage/avatars/7.webp
const url = await this.#storage.disk('local').temporaryUrl('exports/7.json', { expiresIn: { minutes: 5 }, filename: 'my-data.json' });
return this.redirect(url, 303);                                           // local: a signed app route; S3: a presigned GET
```

Without a `defineStorage(…)` the app has Laravel's two disks: `local` (private, `storage/app/private`) and `public`
(`storage/app/public` under `/storage`).

## The contract

`put`, `get` (bytes), `text`, `stream`, `open` (stream + size + time + type), `exists`, `delete` (→ whether there was a
file), `move`, `copy`, `size`, `mimeType`, `lastModified`, `list(directory, { recursive })`, `url`, `temporaryUrl`. A missing
file throws `FileNotFoundError`. `diskAttachment(disk, key)` turns a file into a mail attachment.

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
- **Temporary URLs** of local and memory disks: `GET /_bespoke/storage/<disk>/<key>?expires=…&signature=…`, signed by
  `UrlSigner` of @bespokecore/http (its own key from `APP_KEY`; path, `filename` and expiry signed; the time from the app's
  `Clock`), behind `signed()` — tampered or expired: 403. Works for public and private disks; S3 disks presign instead.
- Every file goes out with `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox` and — for everything but
  raster images (PNG, JPEG, GIF, WebP, AVIF) — `Content-Disposition: attachment`. HTML, SVG (it can carry script), XML, PDF
  and text are downloads, never pages on the app's origin. Public files: `Cache-Control: public, max-age=0,
  must-revalidate` with `Last-Modified`/304; temporary URLs: `private, no-store`.
- A refused key and a missing file are the same 404. The content type comes from the extension (local) or what was
  stored (S3, memory) — this package does not inspect bytes; uploads check magic bytes (W6 step 9).
- At startup a **private local disk that shares a directory with a public one** (the same root, or one inside the other,
  also through symlinks) fails the boot: its files would be served as public. So does a private disk with a `url`.

## S3

`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` are optional peers — loaded on first use, with an install message
if missing (`pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`). A disk without a bucket (an unset `S3_BUCKET`)
fails on first use, not at startup. With an `endpoint`, the bucket goes into the path and the SDK's newer default checksums
are only sent when required (S3-compatible stores). Visibility is the disk's, not the object's: a public S3 disk needs a
bucket policy that makes it readable — the disk sets no ACLs. `temporaryUrl()` presigns a GET with
`response-content-disposition` (attachment unless a raster image). Streams of unknown length are read into memory before
the `PutObject` (multipart uploads: later).

The S3 tests run against an S3-compatible container: `docker compose up -d` (service `s3`, SeaweedFS on 56333 — MinIO's
community edition is archived and LocalStack's image needs an account token), then `pnpm test:s3`. They are not part of
`pnpm test`.

## Testing

`createTestApp` replaces `Storage` with a `StorageFake` (`storage: 'fake'`, the default): every configured disk is a memory
disk with its name, visibility and URL — the app's routes serve it, temporary URLs are signed for real. Assertions:

```ts
app.storage.disk('local').assertExists(`exports/user-${ada.id}.json`).assertCount(1);
app.storage.disk('public').assertExists('avatars/7.webp', (bytes, file) => file.contentType === 'image/webp');
app.storage.disk('public').assertMissing('avatars/old.webp');
```

`createTestApp(app, { storage: 'real' })` keeps the configured disks.
