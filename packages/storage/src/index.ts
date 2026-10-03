import { Application, Clock, type Container, type Resolver, type ServiceProvider } from '@bespokecore/core';
import { DEFAULT_STORAGE, isStorageDefinition, type StorageOptions } from './config.ts';
import type { Disk } from './disk.ts';
import { registerStorageRoutes } from './routes.ts';
import { StorageSetup } from './setup.ts';
import { checkStorage, Storage, StorageManager } from './storage.ts';
import { TEMPORARY_PREFIX, NO_TEMPORARY_URLS, type TemporaryUrls } from './temporary.ts';
import { encodeKey } from './keys.ts';
import { secondsOf } from './contents.ts';

// Storage (E91): disks — local (with a root jail), S3 (an optional peer) and memory (the fake) — behind one contract;
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
export { loadS3, S3_INSTALL, s3BaseUrl, S3Disk } from './drivers/s3.ts';
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

/** The app's storage configuration: its `defineStorage(…)` (in the app's or a module's `config`), else the defaults. */
function storageOptions(container: Resolver): StorageOptions {
  const app = container.make(Application);
  const definitions = [...(app.options.config ?? []), ...app.modules.flatMap((module) => module.config ?? [])].filter(isStorageDefinition);
  if (definitions.length > 1) throw new Error('The app has more than one defineStorage(…) in its config — keep one.');
  return definitions[0] ? container.make(definitions[0]) : DEFAULT_STORAGE;
}

/**
 * Registers `Storage` (the app's disks, built on first use), checks the configuration at startup (a private disk never
 * shares a directory with a public one), and — with @bespokecore/http — signs temporary URLs with its `UrlSigner` and
 * serves public disks under their path (`/storage/…`) and temporary URLs under `/_bespoke/storage/…`, with safe headers.
 * Found by `bespoke discover`.
 */
export class StorageServiceProvider implements ServiceProvider {
  #temporaryUrls: TemporaryUrls = NO_TEMPORARY_URLS;
  #manager: StorageManager | undefined;

  register(container: Container): void {
    container.singleton(StorageSetup, (c) => ({
      options: storageOptions(c),
      dependencies: {
        root: c.make(Application).root,
        clock: c.make(Clock),
        // Resolved per call: @bespokecore/http is looked for while booting.
        temporaryUrls: { sign: (disk, key, options) => this.#temporaryUrls.sign(disk, key, options) },
      },
    }));
    container.singleton(Storage, (c) => {
      const setup = c.make(StorageSetup);
      this.#manager = new StorageManager(setup.options, setup.dependencies);
      return this.#manager;
    });
  }

  async boot(app: Application): Promise<void> {
    const { container } = app;
    const { options } = container.make(StorageSetup);
    checkStorage(options, app.root);

    let http: typeof import('@bespokecore/http') | undefined;
    try {
      http = await import('@bespokecore/http');
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
  }

  async shutdown(): Promise<void> {
    await this.#manager?.close();
  }
}
