import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnyEntry } from './entry.ts';
import { limitOf, matchesHead, type DevtoolsStore, type EntryHead, type EntryQuery, type EntryTail, type PruneResult, type StoreUsage } from './store.ts';

export interface FileStoreOptions {
  /** The directory — absolute; `storage/framework/devtools` of the app by default. */
  readonly directory: string;
  /** The most the files may take together (default 50 MB): the oldest go first. */
  readonly maxBytes?: number;
  /** Entries older than this are not read and their files go (default 24 hours). */
  readonly maxAgeHours?: number;
  /** The time (tests move it). */
  readonly now?: () => number;
  /** A write or read that failed — the entries are lost, nothing else happens. Default: one process warning per kind of failure. */
  readonly onError?: (error: unknown, during: 'write' | 'read' | 'prune') => void;
}

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_MAX_AGE_HOURS = 24;

/** Where an entry is: its file and its line's bytes. */
interface Indexed extends EntryHead {
  readonly file: string;
  readonly offset: number;
  readonly length: number;
  /** In the order this store found it — the cursor of `since()`. */
  readonly seq: number;
}

/** The file this process writes to now. */
interface Segment {
  readonly path: string;
  readonly name: string;
  readonly hour: string;
  bytes: number;
}

/** How far a file was read, and which file it was (a file of the same name written anew starts over). */
interface FileState {
  offset: number;
  ino: number;
}

/**
 * Entries as NDJSON files — one line per entry, shared by every process of the app (server, worker, scheduler):
 *
 * - **Writing:** one file per process and hour (`<YYYYMMDDHH>-<pid>-<random>-<n>.ndjson`, UTC), so no two processes ever
 *   append to the same file; a batch is one append. A file holds at most a tenth of `maxBytes` — then the next one starts.
 *   Writes are queued one after the other; a failure is reported and the entries are lost (never the request).
 * - **Ring:** after a write that may have taken the files over `maxBytes`, and when an hour begins, the files of hours older
 *   than `maxAgeHours` and then the oldest ones go until the rest fits.
 * - **Reading:** an index in memory (id, type, time, batch, request, job, tags and where the line is) over every file in the
 *   directory, brought up to date before each read by reading what was appended since — whole lines only, so a line another
 *   process is writing right now is read next time. Contents are read from the file when asked for.
 */
export class FileStore implements DevtoolsStore {
  readonly directory: string;
  readonly maxBytes: number;
  readonly maxAgeMs: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown, during: 'write' | 'read' | 'prune') => void;
  readonly #segmentMax: number;
  /** Tells this store's files from those of an earlier process with the same pid. */
  readonly #process = `${process.pid}-${randomBytes(3).toString('hex')}`;
  #segment = 0;
  #current: Segment | undefined;
  #writes: Promise<void> = Promise.resolve();
  #reads: Promise<void> = Promise.resolve();
  #directoryMade = false;
  /** Bytes on disk at the last size check (all processes'), and written by this store since. */
  #checked = 0;
  #since = 0;
  // The index: ascending by time (then id), by id, in arrival order (for `since`), and how far each file was read.
  #index: Indexed[] = [];
  readonly #byId = new Map<string, Indexed>();
  #arrivals: Indexed[] = [];
  readonly #files = new Map<string, FileState>();
  #seq = 0;
  /** Lines that could not be read as an entry (never expected: whole lines only) — for tests. */
  corrupt = 0;

  constructor(options: FileStoreOptions) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxAgeMs = (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000;
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? warnOnce();
    this.#segmentMax = Math.max(64 * 1024, Math.floor(this.maxBytes / 10));
  }

  write(entries: readonly AnyEntry[]): Promise<void> {
    if (entries.length === 0) return this.#writes;
    let data: string;
    try {
      data = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    } catch (error) {
      this.#onError(error, 'write');
      return this.#writes;
    }
    const bytes = Buffer.byteLength(data);
    this.#writes = this.#writes.then(async () => {
      try {
        if (!this.#directoryMade) {
          await mkdir(this.directory, { recursive: true });
          this.#directoryMade = true;
        }
        const { target, rotated } = this.#target(bytes);
        await appendFile(target.path, data);
        target.bytes += bytes;
        this.#since += bytes;
        if (rotated || this.#checked + this.#since > this.maxBytes) await this.#prune();
      } catch (error) {
        // A directory removed under us (`rm -rf storage`): made again with the next write.
        this.#directoryMade = false;
        this.#onError(error, 'write');
      }
    });
    return this.#writes;
  }

  /** The file the next `bytes` go to: this process's file of this hour, a new one when it is full. */
  #target(bytes: number): { target: Segment; rotated: boolean } {
    const hour = hourOf(this.#now());
    const current = this.#current;
    if (current && current.hour === hour && (current.bytes === 0 || current.bytes + bytes <= this.#segmentMax)) return { target: current, rotated: false };
    this.#segment++;
    const name = `${hour}-${this.#process}-${String(this.#segment).padStart(4, '0')}.ndjson`;
    this.#current = { path: join(this.directory, name), name, hour, bytes: 0 };
    return { target: this.#current, rotated: current === undefined || current.hour !== hour };
  }

  async list(query: EntryQuery = {}): Promise<AnyEntry[]> {
    await this.#sync();
    const limit = limitOf(query);
    const cutoff = this.#now() - this.maxAgeMs;
    let start = this.#index.length - 1;
    if (query.before !== undefined) {
      const before = this.#byId.get(query.before);
      if (before) start = this.#position(before) - 1;
    }
    const term = query.search ? query.search.toLowerCase() : undefined;
    const reader = new LineReader(this.directory);
    const found: AnyEntry[] = [];
    try {
      for (let i = start; i >= 0 && found.length < limit; i--) {
        const head = this.#index[i]!;
        if (head.at < cutoff) break;
        if (!matchesHead(head, query)) continue;
        const entry = await reader.read(head);
        if (!entry) continue;
        if (term !== undefined && !JSON.stringify(entry).toLowerCase().includes(term)) continue;
        found.push(entry);
      }
    } finally {
      await reader.close();
    }
    return found;
  }

  async get(id: string): Promise<AnyEntry | undefined> {
    await this.#sync();
    const head = this.#byId.get(id);
    if (!head || head.at < this.#now() - this.maxAgeMs) return undefined;
    const reader = new LineReader(this.directory);
    try {
      return await reader.read(head);
    } finally {
      await reader.close();
    }
  }

  async since(cursor?: number): Promise<EntryTail> {
    await this.#sync();
    if (cursor === undefined) return { entries: [], cursor: this.#seq };
    const fresh = this.#arrivals.filter((head) => head.seq > cursor).slice(0, 1000);
    const reader = new LineReader(this.directory);
    const entries: AnyEntry[] = [];
    try {
      for (const head of fresh) {
        const entry = await reader.read(head);
        if (entry) entries.push(entry);
      }
    } finally {
      await reader.close();
    }
    return { entries, cursor: fresh.length > 0 ? fresh.at(-1)!.seq : Math.max(cursor, this.#seq) };
  }

  async clear(): Promise<void> {
    await this.#writes;
    this.#writes = this.#writes.then(async () => {
      for (const file of await this.#names()) await rm(join(this.directory, file), { force: true });
      this.#current = undefined;
      this.#checked = 0;
      this.#since = 0;
    });
    await this.#writes;
    await this.#sync();
  }

  async prune(): Promise<PruneResult> {
    let result: PruneResult = { files: 0, bytes: 0 };
    this.#writes = this.#writes.then(async () => {
      result = await this.#prune();
    });
    await this.#writes;
    return result;
  }

  async usage(): Promise<StoreUsage> {
    await this.#sync();
    let bytes = 0;
    const names = await this.#names();
    for (const name of names) bytes += (await stat(join(this.directory, name)).catch(() => undefined))?.size ?? 0;
    return { bytes, files: names.length, entries: this.#index.length };
  }

  /** Files past the age limit, then the oldest until the rest is within `maxBytes`. Runs in the write queue. */
  async #prune(): Promise<PruneResult> {
    let removed = 0;
    let removedBytes = 0;
    try {
      const files: { name: string; size: number; mtime: number; end: number }[] = [];
      for (const name of await this.#names()) {
        const info = await stat(join(this.directory, name)).catch(() => undefined);
        // A file's entries are of the hour in its name (by the store's clock); a file named otherwise counts by its mtime.
        if (info) files.push({ name, size: info.size, mtime: info.mtimeMs, end: hourEnd(name) ?? info.mtimeMs });
      }
      files.sort((a, b) => a.end - b.end || a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
      const cutoff = this.#now() - this.maxAgeMs;
      let total = files.reduce((sum, file) => sum + file.size, 0);
      for (const file of files) {
        if (file.end > cutoff && total <= this.maxBytes) break;
        await rm(join(this.directory, file.name), { force: true });
        if (this.#current?.name === file.name) this.#current = undefined;
        total -= file.size;
        removed++;
        removedBytes += file.size;
      }
      this.#checked = total;
      this.#since = 0;
    } catch (error) {
      this.#onError(error, 'prune');
    }
    return { files: removed, bytes: removedBytes };
  }

  async #names(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((name) => name.endsWith('.ndjson')).sort();
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** This process's writes done, then the index brought up to date — one refresh after the other. */
  async #sync(): Promise<void> {
    await this.#writes;
    this.#reads = this.#reads.then(() => this.#refresh().catch((error: unknown) => this.#onError(error, 'read')));
    await this.#reads;
  }

  async #refresh(): Promise<void> {
    const names = await this.#names();
    const present = new Set(names);
    for (const file of [...this.#files.keys()]) if (!present.has(file)) this.#forget(file);
    for (const name of names) {
      const info = await stat(join(this.directory, name)).catch(() => undefined);
      if (!info) {
        this.#forget(name);
        continue;
      }
      let state = this.#files.get(name);
      if (state && (state.ino !== info.ino || info.size < state.offset)) {
        // Removed and written anew (`devtools:clear` while a process writes): read it from the start.
        this.#forget(name);
        state = undefined;
      }
      state ??= { offset: 0, ino: info.ino };
      this.#files.set(name, state);
      if (info.size > state.offset) await this.#readAppended(name, state, info.size);
    }
  }

  /** Reads what was appended to `file` since `state.offset` — up to its last complete line. */
  async #readAppended(file: string, state: FileState, size: number): Promise<void> {
    const handle = await open(join(this.directory, file), 'r');
    try {
      const length = size - state.offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      const end = buffer.lastIndexOf(0x0a, bytesRead - 1);
      if (end === -1) return; // not one whole line yet
      let start = 0;
      while (start <= end) {
        const newline = buffer.indexOf(0x0a, start);
        const line = buffer.subarray(start, newline);
        if (line.length > 0) this.#add(file, state.offset + start, line);
        start = newline + 1;
      }
      state.offset += end + 1;
    } finally {
      await handle.close();
    }
  }

  #add(file: string, offset: number, line: Buffer): void {
    let entry: AnyEntry;
    try {
      entry = JSON.parse(line.toString('utf8')) as AnyEntry;
    } catch {
      this.corrupt++;
      return;
    }
    if (typeof entry?.id !== 'string' || typeof entry.at !== 'number' || this.#byId.has(entry.id)) return;
    const head: Indexed = {
      id: entry.id,
      type: entry.type,
      at: entry.at,
      batch: entry.batch,
      ...(entry.requestId === undefined ? {} : { requestId: entry.requestId }),
      ...(entry.jobId === undefined ? {} : { jobId: entry.jobId }),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      file,
      offset,
      length: line.length,
      seq: ++this.#seq,
    };
    this.#byId.set(head.id, head);
    this.#arrivals.push(head);
    // Mostly the newest: insert from the end.
    let i = this.#index.length;
    while (i > 0 && compare(this.#index[i - 1]!, head) > 0) i--;
    this.#index.splice(i, 0, head);
  }

  #forget(file: string): void {
    this.#files.delete(file);
    if (!this.#arrivals.some((head) => head.file === file)) return;
    this.#index = this.#index.filter((head) => head.file !== file);
    this.#arrivals = this.#arrivals.filter((head) => head.file !== file);
    for (const [id, head] of this.#byId) if (head.file === file) this.#byId.delete(id);
  }

  /** Where `head` is in the index (binary search). */
  #position(head: Indexed): number {
    let low = 0;
    let high = this.#index.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(this.#index[middle]!, head) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** Oldest first: by start, then by id. */
function compare(a: EntryHead, b: EntryHead): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** `2026100414` — the UTC hour of `ms`. */
function hourOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13).replaceAll(/[-T]/g, '');
}

/** The end of the hour a file's name starts with (`2026100414-…` → 15:00 UTC), if it does. */
function hourEnd(name: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})-/.exec(name);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) + 1) : undefined;
}

/** Reads entries by where their lines are, keeping a file open across the entries of one read. */
class LineReader {
  readonly #directory: string;
  readonly #handles = new Map<string, FileHandle | undefined>();

  constructor(directory: string) {
    this.#directory = directory;
  }

  async read(head: Indexed): Promise<AnyEntry | undefined> {
    let handle = this.#handles.get(head.file);
    if (!this.#handles.has(head.file)) {
      handle = await open(join(this.#directory, head.file), 'r').catch(() => undefined);
      this.#handles.set(head.file, handle);
    }
    if (!handle) return undefined;
    const buffer = Buffer.alloc(head.length);
    const { bytesRead } = await handle.read(buffer, 0, head.length, head.offset);
    try {
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as AnyEntry;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    for (const handle of this.#handles.values()) await handle?.close();
    this.#handles.clear();
  }
}

/** A process warning per kind of failure — the first one only (a full disk would warn for every request). */
function warnOnce(): (error: unknown, during: string) => void {
  const warned = new Set<string>();
  return (error, during) => {
    const key = `${during}:${(error as { code?: unknown })?.code ?? (error instanceof Error ? error.message : String(error))}`;
    if (warned.has(key)) return;
    warned.add(key);
    process.emitWarning(`The devtools could not ${during} their entries (storage/framework/devtools): ${error instanceof Error ? error.message : String(error)}`, 'MarmeonDevtoolsWarning');
  };
}
