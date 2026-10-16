import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Clock, Logger } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, Schema, sql, type ConnectionOptions } from '@marmeon/database';
import { RedisConnections } from '@marmeon/redis';
import type { CacheStore } from '../cache.ts';
import { CACHE_MIGRATION } from '../commands/make-cache-table.ts';
import { DatabaseStore } from '../stores/database.ts';
import { FileStore } from '../stores/file.ts';
import { MemoryStore } from '../stores/memory.ts';
import { RedisStore } from '../stores/redis.ts';

/** Postgres runs when `MARMEON_TEST_PGSQL_URL` is set (`pnpm test:pgsql`), Redis when `MARMEON_TEST_REDIS_URL` is (`pnpm test:redis`). */
export const PGSQL_URL = process.env.MARMEON_TEST_PGSQL_URL;
export const REDIS_URL = process.env.MARMEON_TEST_REDIS_URL;

export const silent: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => console.error(message, context), child: () => silent };

/** Where a store keeps its data — enough for another process to open the same store (`contender.ts`). */
export type StoreTarget =
  | { kind: 'memory' }
  | { kind: 'file'; directory: string }
  | { kind: 'sqlite'; file: string }
  | { kind: 'pgsql'; url: string }
  | { kind: 'redis'; url: string; prefix: string };

export type StoreKind = StoreTarget['kind'];

/** Every store the suite runs against here: memory, file and SQLite always; Postgres and Redis when their URL is set. */
export const storeKinds: readonly StoreKind[] = ['memory', 'file', 'sqlite', ...(PGSQL_URL ? (['pgsql'] as const) : []), ...(REDIS_URL ? (['redis'] as const) : [])];

/** A store under test: `pass(ms)` lets time go by for it (the test clock; Redis keeps its own time — real waiting). */
export interface StoreUnderTest {
  readonly store: CacheStore;
  readonly clock: TestClock;
  readonly target: StoreTarget;
  pass(ms: number): Promise<void>;
  close(): Promise<void>;
}

/** Runs the cache migration (the file `make:cache-table` copies) on a connection. */
export async function migrate(connections: Connections, name = 'default'): Promise<void> {
  const migration = ((await import(CACHE_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
  await migration.up(new Schema(connections.get(name), connections.options(name).driver));
}

/** A fresh, empty target for `kind` (a new directory, database file, Postgres database or Redis prefix). */
export async function freshTarget(kind: StoreKind): Promise<{ target: StoreTarget; drop: () => Promise<void> }> {
  switch (kind) {
    case 'memory':
      return { target: { kind }, drop: async () => {} };
    case 'file': {
      const directory = mkdtempSync(join(tmpdir(), 'marmeon-cache-'));
      return { target: { kind, directory }, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    }
    case 'sqlite': {
      const directory = mkdtempSync(join(tmpdir(), 'marmeon-cache-db-'));
      const file = join(directory, 'cache.sqlite');
      const connections = databaseConnections({ driver: 'sqlite', database: file });
      await migrate(connections);
      await connections.destroy();
      return { target: { kind, file }, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    }
    case 'pgsql': {
      const name = `marmeon_cache_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const admin = databaseConnections({ driver: 'pgsql', url: PGSQL_URL! });
      await sql`create database ${sql.id(name)}`.execute(admin.get());
      const url = new URL(PGSQL_URL!);
      url.pathname = `/${name}`;
      const connections = databaseConnections({ driver: 'pgsql', url: url.href, poolMax: 2 });
      await migrate(connections);
      await connections.destroy();
      return {
        target: { kind, url: url.href },
        drop: async () => {
          await sql`drop database ${sql.id(name)} with (force)`.execute(admin.get());
          await admin.destroy();
        },
      };
    }
    case 'redis': {
      const prefix = `marmeon-test-${crypto.randomUUID().slice(0, 8)}:`;
      return {
        target: { kind, url: REDIS_URL!, prefix },
        drop: async () => {
          const redis = redisConnections(REDIS_URL!, prefix);
          const keys = await redis.get().command<string[]>(['KEYS', `${prefix}*`]);
          if (keys.length > 0) await redis.get().command(['DEL', ...keys]);
          await redis.close();
        },
      };
    }
  }
}

export function databaseConnections(options: ConnectionOptions): Connections {
  return new Connections({ connections: { default: options }, root: '/', logger: silent });
}

export function redisConnections(url: string, prefix: string): RedisConnections {
  return new RedisConnections({ connections: { default: { url, prefix } }, logger: silent });
}

/** Opens the store at `target` (another process opens the same one the same way). */
export function openStore(target: StoreTarget, clock: Clock): { store: CacheStore; close: () => Promise<void> } {
  switch (target.kind) {
    case 'memory':
      return { store: new MemoryStore(clock), close: async () => {} };
    case 'file':
      return { store: new FileStore(target.directory, clock), close: async () => {} };
    case 'sqlite':
    case 'pgsql': {
      const connections = databaseConnections(target.kind === 'sqlite' ? { driver: 'sqlite', database: target.file } : { driver: 'pgsql', url: target.url, poolMax: 10 });
      return { store: new DatabaseStore({ db: connections.get(), driver: target.kind }, clock), close: () => connections.destroy() };
    }
    case 'redis': {
      const connections = redisConnections(target.url, target.prefix);
      return { store: new RedisStore(connections.get(), clock), close: () => connections.close() };
    }
  }
}

/** A fresh store of `kind` with a test clock, for one test. */
export async function storeUnderTest(kind: StoreKind): Promise<StoreUnderTest> {
  const { target, drop } = await freshTarget(kind);
  const clock = new TestClock();
  const { store, close } = openStore(target, clock);
  return {
    store,
    clock,
    target,
    pass: async (ms) => {
      if (kind === 'redis') await sleep(ms);
      else clock.travel({ milliseconds: ms });
    },
    close: async () => {
      await close();
      await drop();
    },
  };
}
