import { AssertionError } from 'node:assert';
import type { Clock } from '@bespokecore/core';
import type { Disk, FileContents, ListOptions, OpenedFile, PutOptions, TemporaryUrlOptions, Visibility } from '../disk.ts';
import { bytesStream, toBytes } from '../contents.ts';
import { FileNotFoundError, StorageError } from '../errors.ts';
import { encodeKey, normalizeDirectory, normalizeKey } from '../keys.ts';
import { mimeTypeOf } from '../mime.ts';
import type { TemporaryUrls } from '../temporary.ts';

interface StoredFile {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly lastModified: number;
}

export interface MemoryDiskConfig {
  readonly name: string;
  readonly visibility: Visibility;
  readonly url?: string | undefined;
  readonly temporaryUrls: TemporaryUrls;
  readonly clock: Clock;
}

/** What a file must be for {@link MemoryDisk.assertExists}: its text, its bytes, or a check. */
export type ExpectedContents = string | Uint8Array | ((contents: Uint8Array, file: { contentType: string }) => boolean);

/**
 * Files in memory (E91) — the disk of the storage fake (`app.storage.disk('public')` in tests), with the same key checks
 * as every disk and the same URLs (a public disk's `url()`, signed `temporaryUrl()`s the app's routes serve). Its
 * assertions: `assertExists(key, contents?)`, `assertMissing(key)`, `assertCount(n, directory?)`.
 */
export class MemoryDisk implements Disk {
  readonly name: string;
  readonly visibility: Visibility;
  readonly #files = new Map<string, StoredFile>();
  readonly #url: string | undefined;
  readonly #temporaryUrls: TemporaryUrls;
  readonly #clock: Clock;

  constructor(config: MemoryDiskConfig) {
    this.name = config.name;
    this.visibility = config.visibility;
    this.#url = config.url?.replace(/\/+$/, '');
    this.#temporaryUrls = config.temporaryUrls;
    this.#clock = config.clock;
  }

  async put(key: string, contents: FileContents, options: PutOptions = {}): Promise<void> {
    normalizeKey(key);
    const bytes = await toBytes(contents);
    this.#files.set(key, { bytes, contentType: options.contentType ?? mimeTypeOf(key), lastModified: this.#clock.now() });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(this.#file(key).bytes);
  }

  async text(key: string): Promise<string> {
    return new TextDecoder().decode(this.#file(key).bytes);
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    return bytesStream(new Uint8Array(this.#file(key).bytes));
  }

  async open(key: string): Promise<OpenedFile> {
    const file = this.#file(key);
    return { body: bytesStream(new Uint8Array(file.bytes)), size: file.bytes.byteLength, lastModified: new Date(file.lastModified), contentType: file.contentType };
  }

  async exists(key: string): Promise<boolean> {
    return this.#files.has(normalizeKey(key));
  }

  async delete(key: string): Promise<boolean> {
    return this.#files.delete(normalizeKey(key));
  }

  async move(from: string, to: string): Promise<void> {
    const file = this.#file(from);
    normalizeKey(to);
    this.#files.delete(from);
    this.#files.set(to, file);
  }

  async copy(from: string, to: string): Promise<void> {
    const file = this.#file(from);
    normalizeKey(to);
    this.#files.set(to, { ...file, bytes: new Uint8Array(file.bytes), lastModified: this.#clock.now() });
  }

  async size(key: string): Promise<number> {
    return this.#file(key).bytes.byteLength;
  }

  async mimeType(key: string): Promise<string> {
    return this.#file(key).contentType;
  }

  async lastModified(key: string): Promise<Date> {
    return new Date(this.#file(key).lastModified);
  }

  async list(directory = '', options: ListOptions = {}): Promise<string[]> {
    return this.#list(normalizeDirectory(directory), options.recursive ?? false);
  }

  url(key: string): string {
    normalizeKey(key);
    if (this.visibility !== 'public') {
      throw new StorageError(`The disk "${this.name}" is private: its files have no public URL — use temporaryUrl(key, { expiresIn }).`);
    }
    if (this.#url === undefined) throw new StorageError(`The disk "${this.name}" has no url in its configuration.`);
    return `${this.#url}/${encodeKey(key)}`;
  }

  async temporaryUrl(key: string, options: TemporaryUrlOptions): Promise<string> {
    return this.#temporaryUrls.sign(this.name, normalizeKey(key), options);
  }

  /** Every key on the disk, sorted. */
  files(): string[] {
    return [...this.#files.keys()].sort();
  }

  /** Fails unless `key` exists — and, if given, has these contents (text, bytes or a check). */
  assertExists(key: string, contents?: ExpectedContents): this {
    const file = this.#files.get(normalizeKey(key));
    if (!file) throw new AssertionError({ message: `Expected "${key}" on the disk "${this.name}". It has: ${this.files().join(', ') || 'nothing'}.` });
    if (contents === undefined) return this;
    const matches =
      typeof contents === 'function'
        ? contents(new Uint8Array(file.bytes), { contentType: file.contentType })
        : Buffer.from(file.bytes).equals(typeof contents === 'string' ? Buffer.from(contents, 'utf8') : Buffer.from(contents));
    if (!matches) {
      throw new AssertionError({
        message: `"${key}" on the disk "${this.name}" has other contents than expected.`,
        ...(typeof contents === 'string' ? { actual: new TextDecoder().decode(file.bytes), expected: contents } : {}),
      });
    }
    return this;
  }

  /** Fails if `key` exists. */
  assertMissing(key: string): this {
    if (this.#files.has(normalizeKey(key))) throw new AssertionError({ message: `Expected no "${key}" on the disk "${this.name}".` });
    return this;
  }

  /** Fails unless the directory (default: the whole disk, recursively) holds exactly `count` files. */
  assertCount(count: number, directory?: string): this {
    const keys = directory === undefined ? this.files() : this.#list(normalizeDirectory(directory), true);
    if (keys.length !== count) {
      throw new AssertionError({ message: `Expected ${count} file(s) on the disk "${this.name}"${directory === undefined ? '' : ` in "${directory}"`}, found ${keys.length}: ${keys.join(', ') || 'none'}.`, actual: keys.length, expected: count });
    }
    return this;
  }

  #list(prefix: string, recursive: boolean): string[] {
    const start = prefix === '' ? '' : `${prefix}/`;
    return this.files().filter((key) => key.startsWith(start) && (recursive || !key.slice(start.length).includes('/')));
  }

  #file(key: string): StoredFile {
    const file = this.#files.get(normalizeKey(key));
    if (!file) throw new FileNotFoundError(this.name, key);
    return file;
  }
}
