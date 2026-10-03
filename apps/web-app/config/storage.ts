import { defineStorage } from '@bespokecore/storage';
import * as v from 'valibot';

/**
 * The app's disks (E91). `local` is private — its files only ever leave through a signed, expiring URL (`temporaryUrl()`,
 * e.g. the data export on the security page); `public` is served under `/storage` with safe headers (raster images
 * inline, everything else as a download). `s3` is there for S3 or an S3-compatible store — it needs the S3_* variables
 * (.env.example) and `pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`; nothing uses it until then.
 */
export const AppStorage = defineStorage({
  env: v.object({
    S3_BUCKET: v.optional(v.pipe(v.string(), v.nonEmpty())),
    S3_REGION: v.optional(v.string()),
    S3_ENDPOINT: v.optional(v.pipe(v.string(), v.url())),
    S3_ACCESS_KEY_ID: v.optional(v.string()),
    S3_SECRET_ACCESS_KEY: v.optional(v.string()),
  }),
  default: 'local',
  disks: (env) => ({
    local: { driver: 'local', root: 'storage/app/private' },
    public: { driver: 'local', root: 'storage/app/public', visibility: 'public', url: '/storage' },
    s3: {
      driver: 's3',
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      credentials: env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
    },
  }),
});

// Disk names and their visibility as types: `storage.disk('pubic')` and `storage.disk('local').url(…)` are type errors.
declare module '@bespokecore/storage' {
  interface StorageTypes {
    storage: typeof AppStorage;
  }
}
