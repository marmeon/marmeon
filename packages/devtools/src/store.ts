import { token } from '@marmeon/core';
import { newestFirst, type AnyEntry, type EntryType } from './entry.ts';

/**
 * Which entries a read wants — every field narrows. The devtools pages (lists with filters, a request's batch, a job's
 * attempts) and the in-page bar (a request's entries by its `x-request-id`) read through it.
 */
export interface EntryQuery {
  readonly type?: EntryType | readonly EntryType[];
  readonly batch?: string;
  /** Entries of a request — and of the jobs it dispatched (their entries carry it). */
  readonly requestId?: string;
  readonly jobId?: string;
  /** One of the entry's tags (`status:500`, `status:5xx`, `slow`, `failed`, `route:users.show`) — or several, all of which it has. */
  readonly tag?: string | readonly string[];
  /** Text anywhere in the entry (case-insensitive) — reads entries one by one: narrow by type first. */
  readonly search?: string;
  /** Older than this entry (its id) — the next page after the last entry shown. */
  readonly before?: string;
  /** At most this many (default 50, at most 1000). */
  readonly limit?: number;
}

/** New entries since a cursor, oldest first — for a live tail (`since(cursor)` again with the returned cursor). */
export interface EntryTail {
  readonly entries: AnyEntry[];
  /** Pass it to the next `since()`. */
  readonly cursor: number;
}

/** What `prune()` removed. */
export interface PruneResult {
  readonly files: number;
  readonly bytes: number;
}

/** How much the store holds. */
export interface StoreUsage {
  readonly bytes: number;
  readonly files: number;
  readonly entries: number;
}

/**
 * Where entries go: the {@link FileDevtoolsStore} — NDJSON files under `storage/framework/devtools/`, shared by the server, the
 * worker and the scheduler — or an in-memory store in tests. Entries come in redacted; a store never sees raw values.
 * Writing never throws: a failure is reported (`onError`) and the entries are lost — never the request.
 */
export interface DevtoolsStore {
  /** Keeps one batch's entries (in one write, so a reader never sees half a batch from one process). */
  write(entries: readonly AnyEntry[]): Promise<void>;
  /** Entries matching `query`, newest first. */
  list(query?: EntryQuery): Promise<AnyEntry[]>;
  get(id: string): Promise<AnyEntry | undefined>;
  /** Entries that arrived after `cursor` (from any process writing to the store), oldest first; no cursor: none, just the cursor. */
  since(cursor?: number): Promise<EntryTail>;
  /** Removes every entry. */
  clear(): Promise<void>;
  /** Removes what is older than the store's age limit, then the oldest until it is within its size limit. */
  prune(): Promise<PruneResult>;
  usage(): Promise<StoreUsage>;
}
export const DevtoolsStore = token<DevtoolsStore>('DevtoolsStore');

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 1000;

/** The metadata of an entry a query filters on. */
export interface EntryHead {
  readonly id: string;
  readonly type: EntryType;
  readonly at: number;
  readonly batch: string;
  readonly requestId?: string;
  readonly jobId?: string;
  readonly tags: readonly string[];
}

/** Whether `head` matches every field of `query` but `search`, `before` and `limit`. */
export function matchesHead(head: EntryHead, query: EntryQuery): boolean {
  if (query.type !== undefined && (typeof query.type === 'string' ? head.type !== query.type : !query.type.includes(head.type))) return false;
  if (query.batch !== undefined && head.batch !== query.batch) return false;
  if (query.requestId !== undefined && head.requestId !== query.requestId) return false;
  if (query.jobId !== undefined && head.jobId !== query.jobId) return false;
  if (query.tag !== undefined && !(typeof query.tag === 'string' ? [query.tag] : query.tag).every((tag) => head.tags.includes(tag))) return false;
  return true;
}

/** Whether an entry matches every field of `query` but `before` and `limit` — `search` too (case-insensitive, anywhere in it). */
export function matchesEntry(entry: AnyEntry, query: EntryQuery): boolean {
  if (!matchesHead(entry, query)) return false;
  return query.search === undefined || query.search === '' || JSON.stringify(entry).toLowerCase().includes(query.search.toLowerCase());
}

export function limitOf(query: EntryQuery): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(query.limit ?? DEFAULT_LIMIT)));
}

/**
 * The store of tests (`createTestApp(App, { devtools: true })`) and of `storage: { driver: 'memory' }`: entries in this
 * process only, gone with it. Writes land at once (synchronously), so a test sees a request's entries when it has its
 * response. Keeps the newest `maxEntries`.
 */
export class MemoryDevtoolsStore implements DevtoolsStore {
  readonly #entries: AnyEntry[] = [];
  readonly #maxEntries: number;
  #dropped = 0;

  constructor(options: { maxEntries?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
  }

  /** Every entry, in the order written — for tests. */
  all(): readonly AnyEntry[] {
    return this.#entries;
  }

  write(entries: readonly AnyEntry[]): Promise<void> {
    this.#entries.push(...entries);
    const over = this.#entries.length - this.#maxEntries;
    if (over > 0) {
      this.#entries.splice(0, over);
      this.#dropped += over;
    }
    return Promise.resolve();
  }

  async list(query: EntryQuery = {}): Promise<AnyEntry[]> {
    let candidates = this.#entries.filter((entry) => matchesHead(entry, query)).sort(newestFirst);
    if (query.before !== undefined) {
      const before = this.#entries.find((entry) => entry.id === query.before);
      if (before) candidates = candidates.filter((entry) => newestFirst(entry, before) > 0);
    }
    if (query.search !== undefined && query.search !== '') {
      const term = query.search.toLowerCase();
      candidates = candidates.filter((entry) => JSON.stringify(entry).toLowerCase().includes(term));
    }
    return candidates.slice(0, limitOf(query));
  }

  async get(id: string): Promise<AnyEntry | undefined> {
    return this.#entries.find((entry) => entry.id === id);
  }

  async since(cursor?: number): Promise<EntryTail> {
    const end = this.#dropped + this.#entries.length;
    if (cursor === undefined) return { entries: [], cursor: end };
    return { entries: this.#entries.slice(Math.max(0, cursor - this.#dropped)), cursor: end };
  }

  async clear(): Promise<void> {
    this.#dropped += this.#entries.length;
    this.#entries.length = 0;
  }

  async prune(): Promise<PruneResult> {
    return { files: 0, bytes: 0 };
  }

  async usage(): Promise<StoreUsage> {
    return { bytes: Buffer.byteLength(JSON.stringify(this.#entries)), files: 0, entries: this.#entries.length };
  }
}
