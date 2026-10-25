import type { Resolver } from '@marmeon/core';
import { UrlSigner } from '@marmeon/http';
import {
  FileNotFoundError,
  normalizeKey,
  type DiskDriver,
  type DiskDriverFactory,
  type FileContents,
  type OpenedFile,
  type PutOptions,
  type DiskDriverTemporaryUrlOptions,
  type Visibility,
} from '@marmeon/storage';

// The options of the disks with `driver: 'scratch'` — defineStorage() checks them (a missing `capacity` is a type error).
declare module '@marmeon/storage' {
  interface DiskDrivers {
    scratch: { readonly capacity: number };
  }
}

interface Entry {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly lastModified: Date;
}

/** Files in this process's memory, at most `capacity` of them — what a disk driver of your own has to do, in the smallest form. */
class ScratchDisk implements DiskDriver {
  readonly name: string;
  readonly visibility: Visibility;
  readonly #files = new Map<string, Entry>();
  readonly #capacity: number;
  readonly #container: Resolver;

  constructor(name: string, visibility: Visibility, capacity: number, container: Resolver) {
    this.name = name;
    this.visibility = visibility;
    this.#capacity = capacity;
    this.#container = container;
  }

  /** The framework checks keys before they get here; a disk that is also used directly (a test) checks them the same way. */
  #key(key: string): string {
    return normalizeKey(key);
  }

  #file(key: string): Entry {
    const file = this.#files.get(this.#key(key));
    if (!file) throw new FileNotFoundError(this.name, key);
    return file;
  }

  async put(key: string, contents: FileContents, options: PutOptions = {}): Promise<void> {
    const checked = this.#key(key);
    if (!this.#files.has(checked) && this.#files.size >= this.#capacity) throw new Error(`The scratch disk "${this.name}" holds ${this.#capacity} files at most.`);
    const bytes = new Uint8Array(await new Response(contents as BodyInit).arrayBuffer());
    this.#files.set(checked, { bytes, contentType: options.contentType ?? 'application/octet-stream', lastModified: new Date() });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(this.#file(key).bytes);
  }

  async text(key: string): Promise<string> {
    return new TextDecoder().decode(this.#file(key).bytes);
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    return new Response(new Uint8Array(this.#file(key).bytes)).body!;
  }

  async open(key: string): Promise<OpenedFile> {
    const file = this.#file(key);
    return { body: await this.stream(key), size: file.bytes.byteLength, lastModified: file.lastModified, contentType: file.contentType };
  }

  async exists(key: string): Promise<boolean> {
    return this.#files.has(this.#key(key));
  }

  async delete(key: string): Promise<boolean> {
    return this.#files.delete(this.#key(key));
  }

  async move(from: string, to: string): Promise<void> {
    await this.copy(from, to);
    this.#files.delete(from);
  }

  async copy(from: string, to: string): Promise<void> {
    const file = this.#file(from);
    this.#files.set(this.#key(to), file);
  }

  async size(key: string): Promise<number> {
    return this.#file(key).bytes.byteLength;
  }

  async mimeType(key: string): Promise<string> {
    return this.#file(key).contentType;
  }

  async lastModified(key: string): Promise<Date> {
    return this.#file(key).lastModified;
  }

  async list(directory = ''): Promise<string[]> {
    return [...this.#files.keys()].filter((key) => key.startsWith(directory === '' ? '' : `${directory}/`)).sort();
  }

  /** The framework never asks a private disk for this. */
  url(key: string): string {
    return `/scratch/${this.name}/${this.#key(key)}`;
  }

  /** Signed and expiring — the only way to a private file. Nothing serves the path: the URL shows what the contract asks for. */
  async temporaryUrl(key: string, { expiresInSeconds }: DiskDriverTemporaryUrlOptions): Promise<string> {
    return this.#container.make(UrlSigner).signedPath(`/scratch/${this.name}/${this.#key(key)}`, { expiresIn: expiresInSeconds });
  }
}

const scratch: DiskDriverFactory<{ capacity: number; visibility?: Visibility }> = ({ capacity, visibility }, { name, container }) =>
  new ScratchDisk(name, visibility ?? 'private', capacity, container);

/** A disk driver of the app's own, `driver: 'scratch'` in config/storage.ts — a package brings its drivers the same way (docs/drivers.md#bringing-a-driver). */
export class ScratchDiskServiceProvider {
  static diskDrivers = { scratch };
}
