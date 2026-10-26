import { hkdfSync } from 'node:crypto';
import type { ProviderMigrations } from '@marmeon/database';
import { Application, Clock, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { collectDrivers } from '@marmeon/core/internal';
import type { CommandClass } from 'marmeon';
import { DEFAULT_STORAGE, isStorageDefinition, type DiskDriverFactory, type StorageOptions } from './config.ts';
import type { Disk } from './disk.ts';
import { loadHttpModules } from './http-modules.ts';
import { registerStorageRoutes } from './routes.ts';
import { StorageSetup } from './setup.ts';
import { BUILT_IN_DISK_DRIVERS, checkStorage, Storage, StorageManager, visibilityOf } from './storage.ts';
import { StorageSetupError } from './errors.ts';
import { checkS3Sdk } from './drivers/s3.ts';
import { MakeUploadsTableCommand, PruneUploadsCommand } from './uploads/commands.ts';
import { UploadsConfig } from './uploads/config.ts';
import { registerUploads, UPLOADS_PREFIX } from './uploads/http.ts';
import { TemporaryUploads, UPLOADS_COLUMNS, UPLOADS_TABLE } from './uploads/service.ts';
import { TEMPORARY_PREFIX, NO_TEMPORARY_URLS, type TemporaryUrls } from './temporary.ts';
import { encodeKey } from './keys.ts';
import { withCode } from '@marmeon/core/internal';

// Storage: disks — local (with a root jail), S3 (an optional peer) and memory (the fake) — behind one contract;
// public disks served with safe headers, private ones only through signed, expiring URLs.
export { defineStorage } from './config.ts';
export type {
  CheckDiskName,
  DefaultDiskName,
  DiskFor,
  DiskName,
  DiskDriverContext,
  DiskDriverFactory,
  DiskDrivers,
  DiskNameInput,
  DiskOptions,
  LocalDiskOptions,
  MemoryDiskOptions,
  S3DiskOptions,
  StorageDefinition,
  StorageOptions,
  StorageTypes,
} from './config.ts';
export type { Disk, DiskDriver, DiskDriverTemporaryUrlOptions, FileContents, ListOptions, OpenedFile, PrivateDisk, PublicDisk, PutOptions, TemporaryUrlOptions, Visibility } from './disk.ts';
export { FileNotFoundError, InvalidKeyError, StorageError, StorageSetupError } from './errors.ts';
export { Storage } from './storage.ts';
export { serveFile } from './serve.ts';
export type { ServeFileOptions } from './serve.ts';
export type { TemporaryUrls } from './temporary.ts';
export { normalizeDirectory, normalizeKey } from './keys.ts';

// Uploads: a target per route field, the bytes to a private disk, a token in the form, verified on submit.
export { upload } from './uploads/rule.ts';
export type { CheckUploadMime, UploadInput, UploadRule, UploadSchema } from './uploads/rule.ts';
export { RejectedUpload, TemporaryUpload } from './uploads/temporary-upload.ts';
export type { UploadProblem } from './uploads/temporary-upload.ts';
export { UPLOAD_TYPES } from './uploads/sniff.ts';
export type { UploadMime } from './uploads/sniff.ts';
export { UPLOADS_TABLE } from './uploads/service.ts';
export { UploadsConfig } from './uploads/config.ts';
export { uploadsTableConnection } from './uploads/commands.ts';

declare module '@marmeon/core' {
  interface ServiceProviderClass {
    /**
     * Disk drivers this provider brings, by name — a disk with `driver: '<name>'` uses one. A built-in name (`local`, `s3`,
     * `memory`) or a name another provider brings stops the start. See `docs/drivers.md#disk-drivers`.
     */
    readonly diskDrivers?: Readonly<Record<string, DiskDriverFactory>>;
  }
}

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
  const definitions = [...(app.definition.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isStorageDefinition);
  if (definitions.length > 1) throw new Error('The app has more than one defineStorage(…) in its config — keep one.');
  return definitions[0] ? container.make(definitions[0]) : DEFAULT_STORAGE;
}

/**
 * Registers `Storage` (the app's disks, built on first use), checks the configuration at startup (a private disk never
 * shares a directory with a public one), and — with @marmeon/http — signs temporary URLs with its `UrlSigner` and
 * serves public disks under their path (`/storage/…`) and temporary URLs under `/_marmeon/storage/…`, with safe headers.
 * Found by `marmeon discover`.
 */
export class StorageServiceProvider implements ServiceProvider {
  static config = [UploadsConfig];
  static commands: readonly CommandClass[] = [MakeUploadsTableCommand, PruneUploadsCommand];
  /** The migrations for the uploads table, which `marmeon publish` and the `make:*-table` command copy into the app. */
  static migrations = { from: new URL('../stubs/migrations', import.meta.url), module: 'system' } satisfies ProviderMigrations;

  #temporaryUrls: TemporaryUrls = NO_TEMPORARY_URLS;
  #manager: StorageManager | undefined;
  /** What uploads need from other packages — found while booting (http, database, encryption). */
  #uploads: Omit<ConstructorParameters<typeof TemporaryUploads>[0], 'disk' | 'clock' | 'lifetimeMilliseconds' | 'sendWithinSeconds' | 'maxOpen' | 'maxOpenBytes' | 'maxOpenTotalBytes'> | undefined;

  register(container: Container): void {
    container.singleton(StorageSetup, (c) => ({
      options: storageOptions(c),
      dependencies: {
        root: c.make(Application).root,
        clock: c.make(Clock),
        // Resolved per call: @marmeon/http is looked for while booting.
        temporaryUrls: { sign: (disk, key, options) => this.#temporaryUrls.sign(disk, key, options) },
        // A built-in name, a name twice or a malformed one stops the start here.
        drivers: collectDrivers<DiskDriverFactory>(c.make(Application).providers, 'diskDrivers', BUILT_IN_DISK_DRIVERS, 'disk driver'),
        container: c,
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
        throw new StorageSetupError(withCode('S2', 'Uploads need @marmeon/http, @marmeon/database and @marmeon/encryption in the app (and their providers: marmeon discover).'));
      }
      const config = c.make(UploadsConfig);
      return new TemporaryUploads({
        ...this.#uploads,
        disk: () => {
          const storage = c.make(Storage) as unknown as StorageManager;
          if (!storage.names.includes(config.disk)) {
            throw new StorageSetupError(
              withCode(
                'S2',
                `Uploads wait on the private disk "${config.disk}" (UPLOADS_DISK), which is not configured — add it to defineStorage(…): ${config.disk}: { driver: 'local', root: 'storage/app/uploads' }.`,
              ),
            );
          }
          return storage.named(config.disk);
        },
        clock: c.make(Clock),
        lifetimeMilliseconds: config.lifetimeMinutes * 60_000,
        sendWithinSeconds: config.sendWithinMinutes * 60,
        maxOpen: config.maxOpen,
        maxOpenBytes: config.maxOpenBytes,
        maxOpenTotalBytes: config.maxOpenTotalBytes,
      });
    });
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const { options, dependencies } = container.make(StorageSetup);
    checkStorage(options, app.root, dependencies.drivers?.keys());
    // A driver of a provider is built now: its factory's errors stop the start, not the first request.
    const storage = container.make(Storage);
    if (storage instanceof StorageManager) storage.verify();
    // Temporary uploads are anyone's files until a form checked them: never on a public disk.
    const uploads = container.make(UploadsConfig);
    const uploadDisk = options.disks[uploads.disk];
    if (uploadDisk && visibilityOf(uploadDisk) === 'public') {
      throw new StorageSetupError(withCode('S2', `The disk "${uploads.disk}" holds temporary uploads (UPLOADS_DISK) but is public — files nobody checked yet would be served. Make it private.`));
    }
    checkS3Sdk(options, uploads.disk);

    let http: typeof import('@marmeon/http') | undefined;
    let page: typeof import('@marmeon/http/protocol') | undefined;
    let internal: typeof import('@marmeon/http/internal') | undefined;
    try {
      ({ http, page, internal } = await loadHttpModules());
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    if (!http || !page || !internal || !container.has(http.Router)) return;
    const signer = container.make(http.UrlSigner);
    this.#temporaryUrls = {
      sign: (disk, key, { expiresInSeconds, filename, base }) =>
        signer.signedPath(`${TEMPORARY_PREFIX}/${encodeURIComponent(disk)}/${encodeKey(key)}`, {
          expiresIn: expiresInSeconds,
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
        receiveUrl: (id, expiresInSeconds) => signer.signedPath(`${UPLOADS_PREFIX}/${id}`, { expiresIn: expiresInSeconds }),
      };
      // /up/ready is red when the table lacks a column the service writes; an app that made no table has no uploads to keep.
      const { SchemaRequirements } = await import('@marmeon/database');
      container.make(SchemaRequirements).require({ connection: uploads.connection, table: UPLOADS_TABLE, columns: UPLOADS_COLUMNS, whenPresent: true });
      registerUploads(http, internal, page.UPLOAD_HEADER, container, () => container.make(TemporaryUploads));
    }
  }

  async shutdown(): Promise<void> {
    await this.#manager?.close();
  }
}
