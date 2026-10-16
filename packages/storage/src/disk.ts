import type { Readable } from 'node:stream';
import type { Duration } from '@marmeon/core';

/** Who may read a disk's files: `public` — anyone with the URL (`disk.url()`); `private` — only through `temporaryUrl()`. */
export type Visibility = 'public' | 'private';

/** What `put()` takes: text (UTF-8), bytes, a web or Node stream, or a `Blob`/`File`. */
export type FileContents = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array> | Readable;

export interface PutOptions {
  /** The content type to store with the file (S3, memory). Default: by the key's extension. */
  readonly contentType?: string;
}

export interface ListOptions {
  /** Files in subdirectories too (default `false`: only the directory's own files). */
  readonly recursive?: boolean;
}

export interface TemporaryUrlOptions {
  /** How long the URL works: seconds, or a duration (`{ minutes: 5 }`). */
  readonly expiresIn: number | Duration;
  /** The file name the browser saves it as (default: the key's last segment). */
  readonly filename?: string;
  /** Local disks: prepended to the path (`APP_URL`) — an absolute link, e.g. for a mail. S3 URLs are always absolute. */
  readonly base?: string;
}

/** A file opened for reading — what a disk's routes send. */
export interface OpenedFile {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
  readonly lastModified: Date;
  readonly contentType: string;
}

/**
 * A disk: files under keys (`avatars/7.webp`), on the local file system, in S3 or in memory. Every key is checked
 * ({@link normalizeKey}): no `..`, no absolute path, no backslash, no NUL. Reading a missing file throws
 * `FileNotFoundError`. See `docs/storage.md#using-a-disk`.
 *
 * A package or an app brings a disk of its own (`static diskDrivers`, `docs/drivers.md#disk-drivers`) by implementing every
 * member below except `close`. The framework checks every key ({@link normalizeKey}) before the driver sees it, refuses a disk
 * whose `visibility` is not the configured one and never calls `url()` of a private disk on the driver.
 */
export interface Disk {
  /** The disk's name in the configuration. */
  readonly name: string;
  readonly visibility: Visibility;

  /** Writes a file, replacing one under the same key. Readers never see half a file. */
  put(key: string, contents: FileContents, options?: PutOptions): Promise<void>;
  /** The file's bytes. */
  get(key: string): Promise<Uint8Array>;
  /** The file as UTF-8 text. */
  text(key: string): Promise<string>;
  /** The file as a stream — for large files. */
  stream(key: string): Promise<ReadableStream<Uint8Array>>;
  /** The file opened for reading, with its size, time and content type (one look at the file). */
  open(key: string): Promise<OpenedFile>;
  exists(key: string): Promise<boolean>;
  /** Removes a file; `false` when there was none. */
  delete(key: string): Promise<boolean>;
  /** Moves a file on this disk (replacing the target). */
  move(from: string, to: string): Promise<void>;
  /** Copies a file on this disk (replacing the target). */
  copy(from: string, to: string): Promise<void>;
  /** Size in bytes. */
  size(key: string): Promise<number>;
  /** The content type: stored with the file (S3, memory) or by its extension (local). */
  mimeType(key: string): Promise<string>;
  lastModified(key: string): Promise<Date>;
  /** The keys of the files in a directory (`''`: the root), sorted; with `{ recursive: true }` those below it too. */
  list(directory?: string, options?: ListOptions): Promise<string[]>;
  /** The file's public URL — for public disks; a private disk throws (use {@link temporaryUrl}). */
  url(key: string): string;
  /**
   * A URL that works until it expires — for private files: signed by the app (`UrlSigner`, local and memory disks) or
   * presigned (S3). Served as a download unless it is a raster image. A driver of your own signs it and lets it expire: the
   * URL is the only way to a private file, so one that anybody can open for ever makes the file public.
   */
  temporaryUrl(key: string, options: TemporaryUrlOptions): Promise<string>;
  /** Releases what the disk holds open (a client, a connection) when the app shuts down. Without it there is nothing to release. */
  close?(): Promise<void>;
}

/** A public disk: `url()` works. */
export type PublicDisk = Disk;

/** A private disk: its files have no public URL — `url()` is a type error that says what to use instead. */
export type PrivateDisk = Omit<Disk, 'url'> & {
  url(key: 'url() is for public disks — this disk is private: use temporaryUrl(key, { expiresIn })'): never;
};
