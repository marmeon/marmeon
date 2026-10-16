import { SystemClock, type Clock } from '@marmeon/core';
import type { Connection } from '@marmeon/database';
import type { CacheStore, Entry } from '../cache.ts';

/** The tables `marmeon make:cache-table` creates (the app owns the migration; the store types them itself). */
export const CACHE_TABLE = 'cache';
export const CACHE_LOCKS_TABLE = 'cache_locks';

/** A connection of @marmeon/database, and which SQL it speaks. */
export interface DatabaseStoreConnection {
  readonly db: Connection<any>;
  readonly driver: 'sqlite' | 'pgsql';
}

type Sql = (typeof import('@marmeon/database'))['sql'];

/**
 * The cache in the app's database (`CACHE_DRIVER=database`): a row per key in `cache` (the value as JSON, the expiry
 * in epoch milliseconds), a row per lock in `cache_locks`. Every deciding operation is ONE statement —
 * `INSERT … ON CONFLICT … DO UPDATE … WHERE`, `DELETE … WHERE owner = ?` — so the database makes it atomic, on
 * Postgres and SQLite alike, across any number of processes.
 */
export class DatabaseStore implements CacheStore {
  readonly #connection: () => Promise<DatabaseStoreConnection>;
  readonly #clock: Clock;
  #sql: Promise<Sql> | undefined;

  /** `connection`: resolved on first use — the store is built before the database package's provider boots. */
  constructor(connection: DatabaseStoreConnection | (() => Promise<DatabaseStoreConnection>), clock: Clock = new SystemClock()) {
    this.#connection = typeof connection === 'function' ? connection : async () => connection;
    this.#clock = clock;
  }

  async read(key: string): Promise<Entry | undefined> {
    const { db, sql } = await this.#use();
    const now = this.#clock.now();
    const { rows } = await sql<{ value: string; expiration: number | null }>`select value, expiration from cache where key = ${key}`.execute(db);
    const row = rows[0];
    if (!row) return undefined;
    if (row.expiration !== null && Number(row.expiration) <= now) {
      // Expired: removed on the way — only if nobody wrote it again meanwhile.
      await sql`delete from cache where key = ${key} and expiration <= ${now}`.execute(db);
      return undefined;
    }
    return { value: JSON.parse(row.value) as unknown, expires: row.expiration === null ? null : Number(row.expiration) };
  }

  async write(key: string, entry: Entry): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`insert into cache (key, value, expiration) values (${key}, ${serialize(entry.value)}, ${entry.expires})
      on conflict (key) do update set value = excluded.value, expiration = excluded.expiration`.execute(db);
  }

  async add(key: string, entry: Entry): Promise<boolean> {
    const { db, sql } = await this.#use();
    // Inserts a new row, or replaces an expired one; a live row stays and nothing is returned.
    const { rows } = await sql`insert into cache (key, value, expiration) values (${key}, ${serialize(entry.value)}, ${entry.expires})
      on conflict (key) do update set value = excluded.value, expiration = excluded.expiration
      where cache.expiration is not null and cache.expiration <= ${this.#clock.now()}
      returning key`.execute(db);
    return rows.length === 1;
  }

  async increment(key: string, by: number, expires: number | null): Promise<number> {
    const { db, sql, driver } = await this.#use();
    const now = this.#clock.now();
    // A live integer is counted on (keeping its expiry); anything else starts over at `by` with the new expiry. (SQLite gets
    // every JavaScript number as a REAL: `by` is cast, or 1 + 1 would be stored as '2.0'.)
    const counting =
      driver === 'pgsql'
        ? sql`(cache.expiration is null or cache.expiration > ${now}) and cache.value ~ '^-?[0-9]{1,18}$'`
        : sql`(cache.expiration is null or cache.expiration > ${now}) and cast(cast(cache.value as integer) as text) = cache.value`;
    const sum = driver === 'pgsql' ? sql`(cast(cache.value as bigint) + ${by})::text` : sql`cast(cast(cache.value as integer) + cast(${by} as integer) as text)`;
    const { rows } = await sql<{ value: string }>`insert into cache (key, value, expiration) values (${key}, ${String(by)}, ${expires})
      on conflict (key) do update set
        value = case when ${counting} then ${sum} else excluded.value end,
        expiration = case when ${counting} then cache.expiration else excluded.expiration end
      returning value`.execute(db);
    return Number(rows[0]!.value);
  }

  async delete(key: string): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`delete from cache where key = ${key}`.execute(db);
  }

  async clear(): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`delete from cache`.execute(db);
  }

  async lock(name: string, owner: string, expires: number): Promise<boolean> {
    const { db, sql } = await this.#use();
    // Free: inserted. Expired, or already this owner's: taken over / extended. Held by another: untouched, no row returned.
    const { rows } = await sql`insert into cache_locks (key, owner, expiration) values (${name}, ${owner}, ${expires})
      on conflict (key) do update set owner = excluded.owner, expiration = excluded.expiration
      where cache_locks.expiration <= ${this.#clock.now()} or cache_locks.owner = excluded.owner
      returning key`.execute(db);
    return rows.length === 1;
  }

  async unlock(name: string, owner: string): Promise<boolean> {
    const { db, sql } = await this.#use();
    const { rows } = await sql`delete from cache_locks where key = ${name} and owner = ${owner} and expiration > ${this.#clock.now()} returning key`.execute(db);
    return rows.length === 1;
  }

  async forceUnlock(name: string): Promise<void> {
    const { db, sql } = await this.#use();
    await sql`delete from cache_locks where key = ${name}`.execute(db);
  }

  async lockOwner(name: string): Promise<string | undefined> {
    const { db, sql } = await this.#use();
    const { rows } = await sql<{ owner: string }>`select owner from cache_locks where key = ${name} and expiration > ${this.#clock.now()}`.execute(db);
    return rows[0]?.owner;
  }

  async prune(): Promise<number> {
    const { db, sql } = await this.#use();
    const now = this.#clock.now();
    // One statement each: a row written again meanwhile has a new expiration and stays.
    const entries = await sql`delete from cache where expiration is not null and expiration <= ${now}`.execute(db);
    const locks = await sql`delete from cache_locks where expiration <= ${now}`.execute(db);
    return Number(entries.numAffectedRows ?? 0n) + Number(locks.numAffectedRows ?? 0n);
  }

  async #use(): Promise<DatabaseStoreConnection & { sql: Sql }> {
    // Imported here, not at the top: @marmeon/database is an optional peer of the cache.
    this.#sql ??= import('@marmeon/database').then((module) => module.sql);
    const [connection, sql] = await Promise.all([this.#connection(), this.#sql]);
    return { ...connection, sql };
  }
}

/** JSON text; `undefined` (which JSON has not) is stored as `null`. */
function serialize(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}
