import { hkdfSync } from 'node:crypto';
import { Application, Clock, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { DEFAULT_STORAGE, isStorageDefinition, type StorageOptions } from './config.ts';
import type { Disk } from './disk.ts';
import { registerStorageRoutes } from './routes.ts';
import { StorageSetup } from './setup.ts';
import { checkStorage, Storage, StorageManager, visibilityOf } from './storage.ts';
import { StorageSetupError } from './errors.ts';
import { missingPackages, S3_INSTALL, S3_UPLOADS_INSTALL } from './drivers/s3.ts';
import { MakeUploadsTableCommand, PruneUploadsCommand } from './uploads/commands.ts';
import { UploadsConfig } from './uploads/config.ts';
import { registerUploads, UPLOADS_PREFIX } from './uploads/http.ts';
import { TemporaryUploads } from './uploads/service.ts';
import { TEMPORARY_PREFIX, NO_TEMPORARY_URLS, type TemporaryUrls } from './temporary.ts';
import { encodeKey } from './keys.ts';
import { secondsOf } from './contents.ts';

// Storage: disks — local (with a root jail), S3 (an optional peer) and memory (the fake) — behind one contract;
// public disks served with safe headers, private ones only through signed, expiring URLs.
export { defineStorage, DEFAULT_STORAGE, isStorageDefinition } from './config.ts';
export type {
  CheckDiskName,
  DefaultDiskName,
  DiskFor,
  DiskName,
  DiskNameInput,
  DiskOptions,
  LocalDiskOptions,
  MemoryDiskOptions,
  S3DiskOptions,
  StorageDefinition,
  StorageOptions,
  StorageTypes,
} from './config.ts';
export type { Disk, FileContents, ListOptions, OpenedFile, PrivateDisk, PublicDisk, PutOptions, TemporaryUrlOptions, Visibility } from './disk.ts';
export { FileNotFoundError, InvalidKeyError, StorageError, StorageSetupError } from './errors.ts';
export { basename, encodeKey, keyFromPath, MAX_KEY_BYTES, normalizeDirectory, normalizeKey } from './keys.ts';
export { contentDisposition, INLINE_TYPES, isInlineType, mimeTypeOf } from './mime.ts';
export { LocalDisk } from './drivers/local.ts';
export { MemoryDisk } from './drivers/memory.ts';
export type { ExpectedContents } from './drivers/memory.ts';
export { loadS3, missingPackages, S3_INSTALL, s3BaseUrl, S3Disk } from './drivers/s3.ts';
export type { ImportS3, S3Modules } from './drivers/s3.ts';
export { checkStorage, Storage, StorageManager, visibilityOf } from './storage.ts';
export type { StorageDependencies } from './storage.ts';
export { StorageFake } from './fake.ts';
export type { FakeDisk } from './fake.ts';
export { fileHeaders, serveFile } from './serve.ts';
export type { ServeOptions } from './serve.ts';
export { registerStorageRoutes, servedPublicDisks } from './routes.ts';
export { TEMPORARY_PREFIX } from './temporary.ts';
export type { TemporaryUrls } from './temporary.ts';
export { StorageSetup } from './setup.ts';

// Uploads: a target per route field, the bytes to a private disk, a token in the form, verified on submit.
export { upload, uploadFields, uploadRuleOf, formatBytes, UPLOAD_RULE } from './uploads/rule.ts';
export type { CheckUploadMime, UploadInput, UploadRule, UploadSchema } from './uploads/rule.ts';
export { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';
export type { UploadProblem, UploadSource } from './uploads/temporary-upload.ts';
export { sniff, isActiveType, ACTIVE_TYPES, SNIFF_BYTES, UPLOAD_TYPES } from './uploads/sniff.ts';
export type { ActiveType, Sniffed, UploadMime } from './uploads/sniff.ts';
export { TemporaryUploads, UPLOADS_TABLE, uploadError } from './uploads/service.ts';
export type { TargetRequest, UploadTarget, UploadsOptions } from './uploads/service.ts';
export { UploadsConfig } from './uploads/config.ts';
export { MakeUploadsTableCommand, PruneUploadsCommand, UPLOADS_MIGRATION, uploadsTableConnection } from './uploads/commands.ts';
export { UPLOADS_PREFIX } from './uploads/http.ts';
export { loadPresignedPost, S3_UPLOADS_INSTALL } from './drivers/s3.ts';

/**
 * A file of a disk as a mail attachment (`attachments()` of a mailable may be async):
 *
 * ```ts
 * async attachments() { return [await diskAttachment(this.#storage.disk('local'), `invoices/${id}.pdf`)]; }
 * ```
 *
 * A queued mail carries its attachments in the (encrypted) job — keep them small.
 */
export async function diskAttachment(disk: Disk, key: string, options: { filename?: string } = {}): Promise<{ filename: string; content: Uint8Array; contentType: string }> {
  const [content, contentType] = await Promise.all([disk.get(key), disk.mimeType(key)]);
  return { filename: options.filename ?? key.slice(key.lastIndexOf('/') + 1), content, contentType };
}

/** For messages of the database: who uses its infrastructure connection, and what to do on a shared SQLite file. */
const UPLOADS_INFRASTRUCTURE = {
  system: 'Temporary uploads (temporary_uploads)',
  remedy:
    'Give them their own SQLite file — the connection of the cache and sessions (UPLOADS_CONNECTION=system) — and `marmeon migrate` (the migration of ' +
    '`marmeon make:uploads-table` follows UPLOADS_CONNECTION), or store a file outside the transaction.',
};

/** The app's storage configuration: its `defineStorage(…)` (in the app's or a module's `config`), else the defaults. */
function storageOptions(container: Resolver): StorageOptions {
  const app = container.make(Application);
  const definitions = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isStorageDefinition);
  if (definitions.length > 1) throw new Error('The app has more than one defineStorage(…) in its config — keep one.');
  return definitions[0] ? container.make(definitions[0]) : DEFAULT_STORAGE;
}

/**
 * The disks the app is sure to use — the default disk and the uploads' (UPLOADS_DISK) — fail the start when they are on S3 and
 * the AWS SDK is missing (optional peers): the exact command at the start, not an error on the first request. Uploads on S3
 * go straight to the store (a presigned POST) and need `@aws-sdk/s3-presigned-post` too. Other S3 disks say it when first used.
 */
export function checkS3Sdk(options: StorageOptions, uploadsDisk: string, missing: (names: readonly string[]) => string[] = missingPackages): void {
  const used = [...new Set([options.default, uploadsDisk])].filter((name) => options.disks[name]?.driver === 's3');
  if (used.length === 0) return;
  if (missing(['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']).length > 0) {
    const what = used.map((name) => `"${name}"${name === options.default ? ' (the default disk)' : ' (UPLOADS_DISK)'}`).join(' and ');
    throw new StorageSetupError(`The disk ${what} is on S3, which needs the AWS SDK — not installed in this app: ${S3_INSTALL}`);
  }
  if (used.includes(uploadsDisk) && missing(['@aws-sdk/s3-presigned-post']).length > 0) {
    throw new StorageSetupError(`The disk "${uploadsDisk}" (UPLOADS_DISK) is on S3: uploads go straight to it and need @aws-sdk/s3-presigned-post — not installed in this app: ${S3_UPLOADS_INSTALL}`);
  }
}

/**
 * Registers `Storage` (the app's disks, built on first use), checks the configuration at startup (a private disk never
 * shares a directory with a public one), and — with @marmeon/http — signs temporary URLs with its `UrlSigner` and
 * serves public disks under their path (`/storage/…`) and temporary URLs under `/_marmeon/storage/…`, with safe headers.
 * Found by `marmeon discover`.
 */
export class StorageServiceProvider implements ServiceProvider {
  static config = [UploadsConfig];
  static commands = [MakeUploadsTableCommand, PruneUploadsCommand];

  #temporaryUrls: TemporaryUrls = NO_TEMPORARY_URLS;
  #manager: StorageManager | undefined;
  /** What uploads need from other packages — found while booting (http, database, encryption). */
  #uploads: Omit<ConstructorParameters<typeof TemporaryUploads>[0], 'disk' | 'clock' | 'lifetime' | 'sendWithin'> | undefined;

  register(container: Container): void {
    container.singleton(StorageSetup, (c) => ({
      options: storageOptions(c),
      dependencies: {
        root: c.make(Application).root,
        clock: c.make(Clock),
        // Resolved per call: @marmeon/http is looked for while booting.
        temporaryUrls: { sign: (disk, key, options) => this.#temporaryUrls.sign(disk, key, options) },
      },
    }));
    container.singleton(Storage, (c) => {
      const setup = c.make(StorageSetup);
      this.#manager = new StorageManager(setup.options, setup.dependencies);
      return this.#manager;
    });
    // Temporary uploads: built on first use — the disk looked up per use (the test fake replaces `Storage`).
    container.singleton(TemporaryUploads, (c) => {
      if (!this.#uploads) {
        throw new StorageSetupError('Uploads need @marmeon/http, @marmeon/database and @marmeon/encryption in the app (and their providers: marmeon discover).');
      }
      const config = c.make(UploadsConfig);
      return new TemporaryUploads({
        ...this.#uploads,
        disk: () => {
          const storage = c.make(Storage) as unknown as StorageManager;
          if (!storage.names.includes(config.disk)) {
            throw new StorageSetupError(
              `Uploads wait on the private disk "${config.disk}" (UPLOADS_DISK), which is not configured — add it to defineStorage(…): ${config.disk}: { driver: 'local', root: 'storage/app/uploads' }.`,
            );
          }
          return storage.named(config.disk);
        },
        clock: c.make(Clock),
        lifetime: config.lifetime * 60_000,
        sendWithin: config.sendWithin * 60,
      });
    });
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const { options } = container.make(StorageSetup);
    checkStorage(options, app.root);
    // Temporary uploads are anyone's files until a form checked them: never on a public disk.
    const uploads = container.make(UploadsConfig);
    const uploadDisk = options.disks[uploads.disk];
    if (uploadDisk && visibilityOf(uploadDisk) === 'public') {
      throw new StorageSetupError(`The disk "${uploads.disk}" holds temporary uploads (UPLOADS_DISK) but is public — files nobody checked yet would be served. Make it private.`);
    }
    checkS3Sdk(options, uploads.disk);

    let http: typeof import('@marmeon/http') | undefined;
    try {
      http = await import('@marmeon/http');
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    if (!http || !container.has(http.Router)) return;
    const signer = container.make(http.UrlSigner);
    this.#temporaryUrls = {
      sign: (disk, key, { expiresIn, filename, base }) =>
        signer.signedPath(`${TEMPORARY_PREFIX}/${encodeURIComponent(disk)}/${encodeKey(key)}`, {
          expiresIn: secondsOf(expiresIn),
          ...(filename === undefined ? {} : { query: { filename } }),
          ...(base === undefined ? {} : { base }),
        }),
    };
    registerStorageRoutes(http, container, options);

    const database = await import('@marmeon/database').catch(() => undefined);
    const encryption = await import('@marmeon/encryption').catch(() => undefined);
    if (database && encryption && container.has(database.Connections) && container.has(encryption.EncryptionConfig)) {
      const key = container.make(encryption.EncryptionConfig);
      const connections = container.make(database.Connections);
      this.#uploads = {
        // Infrastructure: never the app's transaction — a rollback after store() never makes a used token usable again.
        db: () => connections.infrastructure(uploads.connection, UPLOADS_INFRASTRUCTURE),
        keys: [key.key, ...key.previousKeys].map((secret) => new Uint8Array(hkdfSync('sha256', secret, new Uint8Array(0), 'marmeon:upload-token', 32))),
        receiveUrl: (id, expiresIn) => signer.signedPath(`${UPLOADS_PREFIX}/${id}`, { expiresIn }),
      };
      registerUploads(http, container, () => container.make(TemporaryUploads));
    }
  }

  async shutdown(): Promise<void> {
    await this.#manager?.close();
  }
}
