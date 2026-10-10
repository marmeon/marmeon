import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { token, type Clock } from '@marmeon/core';
import type { CheckDiskName, DefaultDiskName, DiskFor, DiskNameInput, DiskOptions, StorageOptions } from './config.ts';
import type { Disk, Visibility } from './disk.ts';
import { LocalDisk } from './drivers/local.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk, s3BaseUrl, type ImportS3 } from './drivers/s3.ts';
import { didYouMean, StorageError, StorageSetupError } from './errors.ts';
import type { TemporaryUrls } from './temporary.ts';

/**
 * The app's disks, injected as `Storage`: `storage.disk('public')` (typed by the app's `StorageTypes`, so a wrong name is a
 * type error), or `storage.disk()` for the default disk.
 */
export interface Storage {
  /** The disk `name` — built on first use (default: the configured default disk). */
  disk<const N extends DiskNameInput = DefaultDiskName>(name?: CheckDiskName<N>): DiskFor<N>;
  /** The configured disks' names. */
  readonly names: readonly string[];
}
export const Storage = token<Storage>('Storage');

export interface StorageDependencies {
  /** The app root — relative local roots are relative to it. */
  readonly root: string;
  readonly clock: Clock;
  readonly temporaryUrls: TemporaryUrls;
  /** How the AWS SDK is imported (tests). */
  readonly loadS3?: ImportS3;
}

/** A disk's visibility, `private` unless configured `public`. */
export function visibilityOf(options: DiskOptions): Visibility {
  return options.visibility === 'public' ? 'public' : 'private';
}

/** The absolute root of a local disk. */
export function localRoot(appRoot: string, root: string): string {
  return isAbsolute(root) ? root : resolve(appRoot, root);
}

/** A path's real path when it exists (symlinked roots compare by where they lead), else the path itself. */
function realOrSelf(path: string): string {
  return existsSync(path) ? realpathSync(path) : path;
}

function nests(a: string, b: string): boolean {
  const withSep = (path: string) => (path.endsWith(sep) ? path : path + sep);
  return a === b || a.startsWith(withSep(b)) || b.startsWith(withSep(a));
}

/**
 * Checks the configuration at startup: the default disk exists, every driver is known, a private disk has no `url`, a
 * public local disk's `url` is a path or an absolute URL — and **no private local disk shares a directory with a public
 * one** (the same root, or one inside the other): its files would be served under the public disk's URL.
 */
export function checkStorage(options: StorageOptions, appRoot: string): void {
  const names = Object.keys(options.disks);
  if (names.length === 0) throw new StorageSetupError('The storage configuration has no disks.');
  if (!Object.hasOwn(options.disks, options.default)) {
    throw new StorageSetupError(`The default disk "${options.default}" is not configured — the disks: ${names.join(', ')}.${didYouMean(options.default, names)}`);
  }
  for (const [name, disk] of Object.entries(options.disks)) {
    if (!['local', 's3', 'memory'].includes(disk.driver)) {
      throw new StorageSetupError(`The disk "${name}" has an unknown driver "${String(disk.driver)}" — local, s3 or memory.`);
    }
    if (disk.visibility !== undefined && disk.visibility !== 'public' && disk.visibility !== 'private') {
      throw new StorageSetupError(`The disk "${name}" has an unknown visibility "${String(disk.visibility)}" — public or private.`);
    }
    if (visibilityOf(disk) === 'private' && disk.url !== undefined) {
      throw new StorageSetupError(
        `The disk "${name}" is private but has a url — private files are never public: remove url (and use temporaryUrl()), or make the disk public.`,
      );
    }
    if (disk.url !== undefined && disk.driver !== 's3' && !disk.url.startsWith('/') && !/^https?:\/\//.test(disk.url)) {
      throw new StorageSetupError(`The url of the disk "${name}" must be a path ("/storage") or an absolute URL, not "${disk.url}".`);
    }
    if (disk.driver === 'local' && (typeof disk.root !== 'string' || disk.root === '')) throw new StorageSetupError(`The local disk "${name}" needs a root directory.`);
  }
  const local = Object.entries(options.disks).flatMap(([name, disk]) =>
    disk.driver === 'local' ? [{ name, visibility: visibilityOf(disk), root: realOrSelf(localRoot(appRoot, disk.root)) }] : [],
  );
  for (const open of local.filter((disk) => disk.visibility === 'public')) {
    for (const closed of local.filter((disk) => disk.visibility === 'private')) {
      if (nests(open.root, closed.root)) {
        throw new StorageSetupError(
          `The private disk "${closed.name}" and the public disk "${open.name}" share a directory (${closed.root} / ${open.root}) — private files would be served as public. Give them separate directories.`,
        );
      }
    }
  }
  // The same on S3: one bucket (on one endpoint), the prefix of one inside the other's — the public one's URLs (and the bucket policy
  // that makes them public) reach the private files.
  const buckets = Object.entries(options.disks).flatMap(([name, disk]) =>
    disk.driver === 's3' && disk.bucket ? [{ name, visibility: visibilityOf(disk), at: `${disk.endpoint ?? ''} ${disk.bucket}`, root: (disk.root ?? '').replace(/^\/+|\/+$/g, '') }] : [],
  );
  for (const open of buckets.filter((disk) => disk.visibility === 'public')) {
    for (const closed of buckets.filter((disk) => disk.visibility === 'private' && disk.at === open.at)) {
      if (open.root === '' || closed.root === '' || nests(`${open.root}/`, `${closed.root}/`)) {
        throw new StorageSetupError(
          `The private disk "${closed.name}" and the public disk "${open.name}" share a prefix of one bucket ("${closed.root}" / "${open.root}") — private files would be served as public. Give them separate prefixes (root) or buckets.`,
        );
      }
    }
  }
}

/** The `Storage` of the app: builds each disk on first use from its configuration. */
export class StorageManager implements Storage {
  readonly #options: StorageOptions;
  readonly #dependencies: StorageDependencies;
  readonly #disks = new Map<string, Disk>();

  constructor(options: StorageOptions, dependencies: StorageDependencies) {
    this.#options = options;
    this.#dependencies = dependencies;
  }

  get names(): readonly string[] {
    return Object.keys(this.#options.disks);
  }

  get defaultDisk(): string {
    return this.#options.default;
  }

  disk<const N extends DiskNameInput = DefaultDiskName>(name?: CheckDiskName<N>): DiskFor<N> {
    return this.named((name as string | undefined) ?? this.#options.default) as DiskFor<N>;
  }

  /** The disk `name`, untyped — for names from configuration or the URL (an unknown one throws {@link StorageError}). */
  named(name: string): Disk {
    let disk = this.#disks.get(name);
    if (!disk) {
      disk = this.build(name, this.options(name));
      this.#disks.set(name, disk);
    }
    return disk;
  }

  /** The configuration of the disk `name` — or a {@link StorageError} with the known names. */
  options(name: string): DiskOptions {
    if (!Object.hasOwn(this.#options.disks, name)) {
      throw new StorageError(`No disk "${name}" — the disks: ${this.names.join(', ')}.${didYouMean(name, this.names)}`);
    }
    return this.#options.disks[name]!;
  }

  /** Builds a disk from its configuration (the fake builds memory disks instead). */
  protected build(name: string, options: DiskOptions): Disk {
    const { clock, temporaryUrls, root, loadS3 } = this.#dependencies;
    const visibility = visibilityOf(options);
    switch (options.driver) {
      case 'local':
        return new LocalDisk({ name, root: localRoot(root, options.root), visibility, url: options.url, temporaryUrls });
      case 'memory':
        return new MemoryDisk({ name, visibility, url: options.url, temporaryUrls, clock });
      case 's3':
        return new S3Disk({ name, options, visibility, clock, ...(loadS3 ? { load: loadS3 } : {}) });
    }
  }

  /** Builds a memory disk like the configured one — for the fake. */
  protected memory(name: string, options: DiskOptions): MemoryDisk {
    const { clock, temporaryUrls } = this.#dependencies;
    const visibility = visibilityOf(options);
    const url = options.driver === 's3' ? (visibility === 'public' && options.bucket ? s3BaseUrl(options) : undefined) : options.url;
    return new MemoryDisk({ name, visibility, url, temporaryUrls, clock });
  }

  /** Closes what the disks hold open (S3 clients). */
  async close(): Promise<void> {
    await Promise.all([...this.#disks.values()].map((disk) => (disk instanceof S3Disk ? disk.close() : undefined)));
  }
}
