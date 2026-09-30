import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { token } from '@bespokecore/core';

/**
 * A key-value store with expiry (Laravel's `Cache` repository). Values must
 * survive `JSON.stringify`. Redis, tags and locks follow in Wave 6 — as further
 * implementations of this contract.
 */
export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Stores a value; without `ttlSeconds` it never expires. */
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Stores the value only if the key is absent; returns whether it did. */
  add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean>;
  has(key: string): Promise<boolean>;
  forget(key: string): Promise<void>;
  /**
   * Adds `by` to a number (a missing key counts as 0) and returns the result. A new
   * key gets `ttlSeconds`; an existing one keeps its expiry — a rate limit window
   * does not restart with every hit.
   */
  increment(key: string, by?: number, ttlSeconds?: number): Promise<number>;
  /** The cached value, or `compute()` stored for `ttlSeconds`. */
  remember<T>(key: string, ttlSeconds: number | undefined, compute: () => T | Promise<T>): Promise<T>;
  /** Seconds until the key expires, undefined if absent or without expiry. */
  ttl(key: string): Promise<number | undefined>;
  flush(): Promise<void>;
}
export const Cache = token<Cache>('Cache');

interface Entry {
  value: unknown;
  /** Epoch milliseconds; null = forever. */
  expires: number | null;
}

/** The storage behind a cache: the rest (increment, remember, …) is built on these three. */
export interface CacheStore {
  read(key: string): Promise<Entry | undefined>;
  write(key: string, entry: Entry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const expiresAt = (ttlSeconds: number | undefined) => (ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000);
const alive = (entry: Entry | undefined): entry is Entry => entry !== undefined && (entry.expires === null || entry.expires > Date.now());

/**
 * The cache on top of a store. `increment` is read-modify-write: atomic within one
 * process (the memory store), not across processes on the file store — a cluster
 * needs Redis (Wave 6) for exact rate limits.
 */
export class StoreCache implements Cache {
  readonly #store: CacheStore;
  readonly #prefix: string;

  constructor(store: CacheStore, prefix = '') {
    this.#store = store;
    this.#prefix = prefix;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = await this.#read(key);
    return entry?.value as T | undefined;
  }

  async put(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    await this.#store.write(this.#prefix + key, { value, expires: expiresAt(ttlSeconds) });
  }

  async add(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    if (await this.#read(key)) return false;
    await this.put(key, value, ttlSeconds);
    return true;
  }

  async has(key: string): Promise<boolean> {
    return (await this.#read(key)) !== undefined;
  }

  async forget(key: string): Promise<void> {
    await this.#store.delete(this.#prefix + key);
  }

  async increment(key: string, by = 1, ttlSeconds?: number): Promise<number> {
    const entry = await this.#read(key);
    const value = (typeof entry?.value === 'number' ? entry.value : 0) + by;
    await this.#store.write(this.#prefix + key, { value, expires: entry ? entry.expires : expiresAt(ttlSeconds) });
    return value;
  }

  async remember<T>(key: string, ttlSeconds: number | undefined, compute: () => T | Promise<T>): Promise<T> {
    const entry = await this.#read(key);
    if (entry) return entry.value as T;
    const value = await compute();
    await this.put(key, value, ttlSeconds);
    return value;
  }

  async ttl(key: string): Promise<number | undefined> {
    const entry = await this.#read(key);
    return entry?.expires ? Math.max(0, Math.ceil((entry.expires - Date.now()) / 1000)) : undefined;
  }

  async flush(): Promise<void> {
    await this.#store.clear();
  }

  async #read(key: string): Promise<Entry | undefined> {
    const entry = await this.#store.read(this.#prefix + key);
    if (alive(entry)) return entry;
    if (entry) await this.#store.delete(this.#prefix + key); // expired: clean up on the way
    return undefined;
  }
}

/** In-process: fast, lost on restart, not shared between processes. Tests and single-process apps. */
export class MemoryStore implements CacheStore {
  readonly #entries = new Map<string, string>();

  async read(key: string): Promise<Entry | undefined> {
    const raw = this.#entries.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as Entry);
  }

  async write(key: string, entry: Entry): Promise<void> {
    this.#entries.set(key, JSON.stringify(entry)); // serialized, like every real store
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }

  async clear(): Promise<void> {
    this.#entries.clear();
  }
}

/** One JSON file per key (named by its hash), written atomically. Survives restarts. */
export class FileStore implements CacheStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  async read(key: string): Promise<Entry | undefined> {
    try {
      return JSON.parse(await readFile(this.#path(key), 'utf8')) as Entry;
    } catch {
      return undefined;
    }
  }

  async write(key: string, entry: Entry): Promise<void> {
    const file = this.#path(key);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 });
    await rename(temporary, file);
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async clear(): Promise<void> {
    for (const name of await readdir(this.#directory)) await rm(join(this.#directory, name), { force: true });
  }

  #path(key: string): string {
    return join(this.#directory, createHash('sha256').update(key).digest('hex'));
  }
}
