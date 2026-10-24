import { randomUUID } from 'node:crypto';
import { constants, createWriteStream, mkdirSync, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Disk, FileContents, ListOptions, OpenedFile, TemporaryUrlOptions, Visibility } from '../disk.ts';
import { forDriver, toReadable } from '../contents.ts';
import { FileNotFoundError, InvalidKeyError, StorageError } from '../errors.ts';
import { basename, encodeKey, normalizeDirectory, normalizeKey } from '../keys.ts';
import { mimeTypeOf } from '../mime.ts';
import type { TemporaryUrls } from '../temporary.ts';

/** Temporary files of a write in progress — renamed into place when complete, never listed. */
const TEMP_PREFIX = '.marmeon-tmp-';

export interface LocalDiskConfig {
  readonly name: string;
  /** Absolute path of the root directory. */
  readonly root: string;
  readonly visibility: Visibility;
  readonly url?: string | undefined;
  readonly temporaryUrls: TemporaryUrls;
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Files in a directory, kept inside the root by two independent measures: the key check ({@link normalizeKey}) and a root
 * jail — every path is resolved by `realpath` and must lie inside the root's real path, so a symlink out of the root (to a
 * file, or to a directory a new file would go into) is refused. Reads open the resolved path with `O_NOFOLLOW`, so no symlink
 * is swapped in after the check; writes go to a temporary file in the checked directory (`O_EXCL`) and are renamed into
 * place, which replaces a link instead of writing through it. Symlinks inside the root are followed; a race on a
 * *directory* between check and use stays open to someone who can already create symlinks inside the root.
 */
export class LocalDisk implements Disk {
  readonly name: string;
  readonly visibility: Visibility;
  readonly #root: string;
  readonly #url: string | undefined;
  readonly #temporaryUrls: TemporaryUrls;
  #real: string | undefined;

  constructor(config: LocalDiskConfig) {
    this.name = config.name;
    this.visibility = config.visibility;
    this.#root = config.root;
    this.#url = config.url?.replace(/\/+$/, '');
    this.#temporaryUrls = config.temporaryUrls;
  }

  /** The root's real path — created on first use. */
  get root(): string {
    if (this.#real === undefined) {
      mkdirSync(this.#root, { recursive: true });
      this.#real = realpathSync(this.#root);
    }
    return this.#real;
  }

  async put(key: string, contents: FileContents): Promise<void> {
    normalizeKey(key);
    const directory = await this.#directoryFor(key, { create: true });
    const temporary = join(directory, `${TEMP_PREFIX}${randomUUID()}`);
    try {
      // 'wx' = O_CREAT | O_EXCL: fails on an existing name — a symlink included, so it never writes through one.
      await pipeline(toReadable(contents), createWriteStream(temporary, { flags: 'wx', mode: 0o644 }));
      // The directory may have been swapped since it was checked: check it again right before the rename.
      this.#inside(await realpath(directory), key);
      await rename(temporary, join(directory, basename(key)));
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    const handle = await this.#openFile(key);
    try {
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  }

  async text(key: string): Promise<string> {
    return new TextDecoder().decode(await this.get(key));
  }

  async stream(key: string): Promise<ReadableStream<Uint8Array>> {
    return (await this.open(key)).body;
  }

  async open(key: string): Promise<OpenedFile> {
    const handle = await this.#openFile(key);
    try {
      const stats = await handle.stat();
      const body = Readable.toWeb(handle.createReadStream({ autoClose: true })) as unknown as ReadableStream<Uint8Array>;
      return { body, size: stats.size, lastModified: stats.mtime, contentType: mimeTypeOf(key) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(await this.#existing(key))).isFile();
    } catch (error) {
      if (error instanceof FileNotFoundError || isMissing(error)) return false;
      throw error;
    }
  }

  async delete(key: string): Promise<boolean> {
    normalizeKey(key);
    let directory: string;
    try {
      directory = await this.#directoryFor(key, { create: false });
    } catch (error) {
      if (error instanceof FileNotFoundError) return false;
      throw error;
    }
    const path = join(directory, basename(key));
    try {
      if ((await lstat(path)).isDirectory()) return false;
      await unlink(path); // a symlink is removed itself, never its target
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async move(from: string, to: string): Promise<void> {
    const source = await this.#existing(from);
    normalizeKey(to);
    const directory = await this.#directoryFor(to, { create: true });
    await rename(source, join(directory, basename(to)));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.put(to, await this.stream(from));
  }

  async size(key: string): Promise<number> {
    return (await this.#stat(key)).size;
  }

  async mimeType(key: string): Promise<string> {
    await this.#stat(key);
    return mimeTypeOf(key);
  }

  async lastModified(key: string): Promise<Date> {
    return (await this.#stat(key)).mtime;
  }

  async list(directory = '', options: ListOptions = {}): Promise<string[]> {
    const prefix = normalizeDirectory(directory);
    let start: string;
    try {
      start = prefix === '' ? this.root : this.#inside(await realpath(join(this.root, prefix)), prefix);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const keys: string[] = [];
    const visited = new Set<string>();
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      if (visited.has(dir)) return; // a symlink loop
      visited.add(dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(TEMP_PREFIX)) continue;
        const key = keyPrefix === '' ? entry.name : `${keyPrefix}/${entry.name}`;
        let isFile = entry.isFile();
        let isDirectory = entry.isDirectory();
        let path = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            path = await realpath(path);
          } catch {
            continue; // dangling
          }
          if (!this.#contains(path)) continue; // leads out of the root: not this disk's file
          const stats = await stat(path);
          isFile = stats.isFile();
          isDirectory = stats.isDirectory();
        }
        try {
          normalizeKey(key);
        } catch {
          continue; // a name no key can address (a backslash, a control character)
        }
        if (isFile) keys.push(key);
        else if (isDirectory && options.recursive) await walk(path, key);
      }
    };
    try {
      await walk(start, prefix);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return keys.sort();
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
    return this.#temporaryUrls.sign(this.name, normalizeKey(key), forDriver(options));
  }

  /** Whether a real path lies inside the root. */
  #contains(real: string): boolean {
    const root = this.root;
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  }

  /** `real` when it lies inside the root — else the key is refused. */
  #inside(real: string, key: string): string {
    if (!this.#contains(real)) throw new InvalidKeyError(key, `it leads out of the root of the disk "${this.name}" (a symlink)`);
    return real;
  }

  /** The real path of an existing key, checked to lie inside the root. */
  async #existing(key: string): Promise<string> {
    normalizeKey(key);
    try {
      return this.#inside(await realpath(join(this.root, key)), key);
    } catch (error) {
      if (isMissing(error)) throw new FileNotFoundError(this.name, key);
      throw error;
    }
  }

  async #stat(key: string) {
    const stats = await stat(await this.#existing(key)).catch((error: unknown) => {
      throw isMissing(error) ? new FileNotFoundError(this.name, key) : error;
    });
    if (!stats.isFile()) throw new FileNotFoundError(this.name, key);
    return stats;
  }

  /** Opens an existing file: the checked real path, with `O_NOFOLLOW` — no symlink swapped in after the check. */
  async #openFile(key: string) {
    const real = await this.#existing(key);
    let handle;
    try {
      handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (isMissing(error)) throw new FileNotFoundError(this.name, key);
      if (code === 'ELOOP' || code === 'EMLINK') throw new InvalidKeyError(key, 'it became a symlink while it was opened');
      throw error;
    }
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      throw new FileNotFoundError(this.name, key);
    }
    return handle;
  }

  /**
   * The real path of the directory a key's file lives in, checked segment by segment: each existing one must resolve
   * inside the root (a symlinked directory that leads out is refused *before* anything is created through it); missing
   * ones are created (`create`) or end in {@link FileNotFoundError}.
   */
  async #directoryFor(key: string, { create }: { create: boolean }): Promise<string> {
    let current = this.root;
    const segments = dirname(key) === '.' ? [] : dirname(key).split('/');
    for (const segment of segments) {
      const next = join(current, segment);
      let stats;
      try {
        stats = await lstat(next);
      } catch (error) {
        if (!isMissing(error)) throw error;
        if (!create) throw new FileNotFoundError(this.name, key);
        try {
          await mkdir(next, { mode: 0o755 });
        } catch (mkdirError) {
          if ((mkdirError as { code?: unknown }).code !== 'EEXIST') throw mkdirError;
        }
        stats = await lstat(next);
      }
      if (stats.isSymbolicLink()) {
        current = this.#inside(await realpath(next), key);
        if (!(await stat(current)).isDirectory()) throw new StorageError(`"${key}": "${segment}" is a file, not a directory, on the disk "${this.name}".`);
      } else if (stats.isDirectory()) {
        current = next;
      } else {
        throw new StorageError(`"${key}": "${segment}" is a file, not a directory, on the disk "${this.name}".`);
      }
    }
    return current;
  }
}
