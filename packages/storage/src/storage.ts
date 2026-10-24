import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { token, type Clock, type Resolver } from '@marmeon/core';
import type { CheckDiskName, DefaultDiskName, DiskDriverFactory, DiskFor, DiskNameInput, DiskOptions, StorageOptions } from './config.ts';
import type { Disk, DiskDriver, FileContents, ListOptions, OpenedFile, PutOptions, TemporaryUrlOptions, Visibility } from './disk.ts';
import { forDriver } from './contents.ts';
import { normalizeDirectory, normalizeKey } from './keys.ts';
import { LocalDisk } from './drivers/local.ts';
import { MemoryDisk } from './drivers/memory.ts';
import { S3Disk, s3BaseUrl } from './drivers/s3.ts';
import { didYouMean, StorageError, StorageSetupError } from './errors.ts';
import type { TemporaryUrls } from './temporary.ts';
import { withCode } from '@marmeon/core/internal';

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
  /** The disk drivers that providers bring, by name (`static diskDrivers`). */
  readonly drivers?: ReadonlyMap<string, DiskDriverFactory>;
  /** What a provider's disk driver reads its own configuration from. */
  readonly container?: Resolver;
}

/** The names the framework's own disks answer to — a provider cannot bring a driver under one of them. */
export const BUILT_IN_DISK_DRIVERS = ['local', 's3', 'memory'] as const;

/** Every function a driver's disk must have: a key per member of {@link DiskDriver}, so a new member cannot be forgotten here. */
const DISK_MEMBERS = Object.keys({
  put: true, get: true, text: true, stream: true, open: true, exists: true, delete: true, move: true, copy: true,
  size: true, mimeType: true, lastModified: true, list: true, url: true, temporaryUrl: true,
} satisfies Record<Exclude<keyof DiskDriver, 'name' | 'visibility' | 'close'>, true>) as readonly (keyof DiskDriver)[];

/**
 * A disk of a provider's driver, as the app gets it: every key is checked here ({@link normalizeKey}) before the driver sees it,
 * `url()` of a private disk is refused here and never reaches the driver, `name` and `visibility` are the configured ones, and a
 * `temporaryUrl()` of a private disk that comes back empty is refused. The driver's disk is held privately and each member
 * delegated, so nothing depends on what kind of object the driver returned.
 */
class GuardedDisk implements Disk {
  // Private fields with getters: an assignment to `visibility` (a plain field would take it) never unlocks `url()`.
  readonly #name: string;
  readonly #visibility: Visibility;
  readonly #disk: DiskDriver;

  get name(): string {
    return this.#name;
  }

  get visibility(): Visibility {
    return this.#visibility;
  }

  constructor(name: string, visibility: Visibility, made: unknown) {
    const disk = made as Partial<DiskDriver> | null | undefined;
    const missing = DISK_MEMBERS.filter((member) => typeof disk?.[member] !== 'function');
    if (typeof disk !== 'object' || disk === null || missing.length > 0) {
      throw new StorageSetupError(withCode('S2', `The driver of the disk "${name}" must return a DiskDriver with ${DISK_MEMBERS.join(', ')}, name and visibility${missing.length > 0 ? ` — missing: ${missing.join(', ')}` : ''}.`));
    }
    if (disk.name !== name) {
      throw new StorageSetupError(withCode('S2', `The driver of the disk "${name}" returned a disk named "${String(disk.name)}" — name must be the disk's name from the configuration.`));
    }
    if (disk.visibility !== visibility) {
      throw new StorageSetupError(withCode('S2', `The disk "${name}" is ${visibility} in the configuration, but its driver returned a ${String(disk.visibility)} disk — it must keep the configured visibility.`));
    }
    this.#name = name;
    this.#visibility = visibility;
    this.#disk = disk as unknown as DiskDriver;
  }

  async put(key: string, contents: FileContents, options?: PutOptions): Promise<void> {
    return this.#disk.put(normalizeKey(key), contents, options);
  }
  async get(key: string): Promise<Uint8Array> {
    return this.#disk.get(normalizeKey(key));
  }
  async text(key: string): Promise<string> {
    return this.#disk.text(normalizeKey(key));
  }
  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    return this.#disk.stream(normalizeKey(key));
  }
  async open(key: string): Promise<OpenedFile> {
    return this.#disk.open(normalizeKey(key));
  }
  async exists(key: string): Promise<boolean> {
    return this.#disk.exists(normalizeKey(key));
  }
  async delete(key: string): Promise<boolean> {
    return this.#disk.delete(normalizeKey(key));
  }
  async move(from: string, to: string): Promise<void> {
    return this.#disk.move(normalizeKey(from), normalizeKey(to));
  }
  async copy(from: string, to: string): Promise<void> {
    return this.#disk.copy(normalizeKey(from), normalizeKey(to));
  }
  async size(key: string): Promise<number> {
    return this.#disk.size(normalizeKey(key));
  }
  async mimeType(key: string): Promise<string> {
    return this.#disk.mimeType(normalizeKey(key));
  }
  async lastModified(key: string): Promise<Date> {
    return this.#disk.lastModified(normalizeKey(key));
  }
  async list(directory = '', options?: ListOptions): Promise<string[]> {
    return this.#disk.list(normalizeDirectory(directory), options);
  }

  url(key: string): string {
    const checked = normalizeKey(key);
    if (this.#visibility === 'private') {
      throw new StorageError(`The disk "${this.#name}" is private: its files have no public URL — use temporaryUrl(key, { expiresIn }).`);
    }
    return this.#disk.url(checked);
  }

  async temporaryUrl(key: string, options: TemporaryUrlOptions): Promise<string> {
    const url = await this.#disk.temporaryUrl(normalizeKey(key), forDriver(options));
    if (typeof url !== 'string' || url === '') throw new StorageError(`The driver of the disk "${this.name}" returned no URL from temporaryUrl().`);
    return url;
  }

  async close(): Promise<void> {
    await this.#disk.close?.();
  }
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
 * Checks the configuration at startup: the default disk exists, every driver is known (built in, or one of `drivers` — the names
 * providers bring), a private disk has no `url`, a public local disk's `url` is a path or an absolute URL — and **no private local disk shares a directory with a public
 * one** (the same root, or one inside the other): its files would be served under the public disk's URL.
 */
export function checkStorage(options: StorageOptions, appRoot: string, drivers: Iterable<string> = []): void {
  const known = [...BUILT_IN_DISK_DRIVERS, ...drivers];
  const names = Object.keys(options.disks);
  if (names.length === 0) throw new StorageSetupError(withCode('S2', 'The storage configuration has no disks.'));
  if (!Object.hasOwn(options.disks, options.default)) {
    throw new StorageSetupError(withCode('S2', `The default disk "${options.default}" is not configured — the disks: ${names.join(', ')}.${didYouMean(options.default, names)}`));
  }
  for (const [name, disk] of Object.entries(options.disks)) {
    if (!known.includes(disk.driver)) {
      throw new StorageSetupError(withCode('S2', `The disk "${name}" has an unknown driver "${String(disk.driver)}" — the drivers: ${known.join(', ')}.${didYouMean(String(disk.driver), known)}`));
    }
    if (disk.visibility !== undefined && disk.visibility !== 'public' && disk.visibility !== 'private') {
      throw new StorageSetupError(withCode('S2', `The disk "${name}" has an unknown visibility "${String(disk.visibility)}" — public or private.`));
    }
    if (visibilityOf(disk) === 'private' && disk.url !== undefined) {
      throw new StorageSetupError(
        withCode(
          'S2',
          `The disk "${name}" is private but has a url — private files are never public: remove url (and use temporaryUrl()), or make the disk public.`,
        ),
      );
    }
    if (disk.url !== undefined && (disk.driver === 'local' || disk.driver === 'memory') && !disk.url.startsWith('/') && !/^https?:\/\//.test(disk.url)) {
      throw new StorageSetupError(withCode('S2', `The url of the disk "${name}" must be a path ("/storage") or an absolute URL, not "${disk.url}".`));
    }
    if (disk.driver === 'local' && (typeof disk.root !== 'string' || disk.root === '')) throw new StorageSetupError(withCode('S2', `The local disk "${name}" needs a root directory.`));
  }
  const local = Object.entries(options.disks).flatMap(([name, disk]) =>
    disk.driver === 'local' ? [{ name, visibility: visibilityOf(disk), root: realOrSelf(localRoot(appRoot, disk.root)) }] : [],
  );
  for (const open of local.filter((disk) => disk.visibility === 'public')) {
    for (const closed of local.filter((disk) => disk.visibility === 'private')) {
      if (nests(open.root, closed.root)) {
        throw new StorageSetupError(
          withCode(
            'S2',
            `The private disk "${closed.name}" and the public disk "${open.name}" share a directory (${closed.root} / ${open.root}) — private files would be served as public. Give them separate directories.`,
          ),
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
          withCode(
            'S2',
            `The private disk "${closed.name}" and the public disk "${open.name}" share a prefix of one bucket ("${closed.root}" / "${open.root}") — private files would be served as public. Give them separate prefixes (root) or buckets.`,
          ),
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

  /**
   * Builds every disk of a driver a provider brought, so that a factory's error — and a disk that breaks the contract — stops
   * the start instead of the first request.
   */
  verify(): void {
    for (const [name, options] of Object.entries(this.#options.disks)) {
      if (!(BUILT_IN_DISK_DRIVERS as readonly string[]).includes(options.driver)) this.named(name);
    }
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
    const { clock, temporaryUrls, root } = this.#dependencies;
    const visibility = visibilityOf(options);
    switch (options.driver) {
      case 'local':
        return new LocalDisk({ name, root: localRoot(root, options.root), visibility, url: options.url, temporaryUrls });
      case 'memory':
        return new MemoryDisk({ name, visibility, url: options.url, temporaryUrls, clock });
      case 's3':
        return new S3Disk({ name, options, visibility, clock });
      default:
        return this.#custom(name, options);
    }
  }

  /** The disk a provider's driver makes. `verify()` builds every one at the start, so a failing factory never runs again later. */
  #custom(name: string, options: DiskOptions): Disk {
    const { drivers, container, root } = this.#dependencies;
    const driver = String(options.driver);
    const factory = drivers?.get(driver);
    if (!factory || !container) {
      throw new StorageSetupError(withCode('S2', `The disk "${name}" has an unknown driver "${driver}" — the drivers: ${[...BUILT_IN_DISK_DRIVERS, ...(drivers?.keys() ?? [])].join(', ')}.`));
    }
    return new GuardedDisk(name, visibilityOf(options), factory(options, { name, root, container }));
  }

  /** Builds a memory disk like the configured one — for the fake. */
  protected memory(name: string, options: DiskOptions): Disk {
    const { clock, temporaryUrls } = this.#dependencies;
    const visibility = visibilityOf(options);
    const url = options.driver === 's3' ? (visibility === 'public' && options.bucket ? s3BaseUrl(options) : undefined) : options.url;
    return new MemoryDisk({ name, visibility, url, temporaryUrls, clock });
  }

  /** Closes every built disk that has a `close()` (S3 clients, a driver's connections). */
  async close(): Promise<void> {
    await Promise.all([...this.#disks.values()].map((disk) => disk.close?.()));
  }
}
