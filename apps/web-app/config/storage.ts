import { env } from '@marmeon/core';
import { defineStorage } from '@marmeon/storage';

/**
 * The app's disks. `local` is private — its files only ever leave through a signed, expiring URL (`temporaryUrl()`,
 * e.g. the data export on the security page); `public` is served under `/storage` with safe headers (raster images
 * inline, everything else as a download) — the avatars; `uploads` is private too: where an upload waits for its form. `s3` is
 * there for S3 or an S3-compatible store — it needs the S3_* variables (.env.example) and
 * `pnpm add @aws-sdk/client-s3@^3 @aws-sdk/s3-request-presigner@^3`; nothing uses it until then.
 */
export const AppStorage = defineStorage({
  env: env({
    S3_BUCKET: env.string().optional(),
    S3_REGION: env.string().optional(),
    S3_ENDPOINT: env.url().optional(),
    S3_ACCESS_KEY_ID: env.string().optional(),
    S3_SECRET_ACCESS_KEY: env.string().optional(),
  }),
  default: 'local',
  disks: (e) => ({
    local: { driver: 'local', root: 'storage/app/private' },
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
    // Uploads wait here (UPLOADS_DISK) until a form checked and stored them — the avatar, then, on `public`. Private, and
    // outside the public root (a startup error otherwise): nothing anyone uploaded is served before its form accepted it.
    uploads: { driver: 'local', root: 'storage/app/uploads' },
    // A disk of a driver the app brings itself (modules/system/ScratchDiskServiceProvider.ts): files in memory, at most `capacity`.
    scratch: { driver: 'scratch', capacity: 100 },
    s3: {
      driver: 's3',
      bucket: e.S3_BUCKET,
      region: e.S3_REGION,
      endpoint: e.S3_ENDPOINT,
      credentials: e.S3_ACCESS_KEY_ID && e.S3_SECRET_ACCESS_KEY ? { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY } : undefined,
    },
  }),
});

// Disk names and their visibility as types: `storage.disk('pubic')` and `storage.disk('local').url(…)` are type errors.
declare module '@marmeon/storage' {
  interface StorageTypes {
    storage: typeof AppStorage;
  }
}
