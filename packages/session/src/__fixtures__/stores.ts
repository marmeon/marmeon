import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { TestClock, type Clock, type Logger } from '@bespokecore/core';
import { Connections, Schema, sql, type ConnectionOptions } from '@bespokecore/database';
import { RedisConnections } from '@bespokecore/redis';
import { SESSIONS_MIGRATION } from '../commands/make-session-table.ts';
import type { SessionStore } from '../store.ts';
import { DatabaseSessionStore } from '../stores/database.ts';
import { FileSessionStore } from '../stores/file.ts';
import { MemorySessionStore } from '../stores/memory.ts';
import { RedisSessionStore } from '../stores/redis.ts';

/** Postgres runs when `BESPOKE_TEST_PGSQL_URL` is set (`pnpm test:pgsql`), Redis when `BESPOKE_TEST_REDIS_URL` is (`pnpm test:redis`). */
export const PGSQL_URL = process.env.BESPOKE_TEST_PGSQL_URL;
export const REDIS_URL = process.env.BESPOKE_TEST_REDIS_URL;

export const silent: Logger = { debug() {}, info() {}, warn() {}, error: (message, context) => console.error(message, context), child: () => silent };

/** The lifetime every store under test is opened with (the database store keeps it; the others get it per write). */
export const LIFETIME = 60;

/** Where a store keeps its sessions — enough for another process to open the same store. */
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
  readonly store: SessionStore;
  readonly clock: TestClock;
  readonly target: StoreTarget;
  /** How many rows the `sessions` table holds (database stores only). */
  rows(): Promise<number>;
  pass(ms: number): Promise<void>;
  close(): Promise<void>;
}

/** Runs the sessions migration (the file `make:session-table` copies) on a connection. */
export async function migrate(connections: Connections): Promise<void> {
  const migration = ((await import(SESSIONS_MIGRATION.href)) as { default: { up(schema: Schema): Promise<void> } }).default;
  await migration.up(new Schema(connections.get(), connections.options().driver));
}

export function databaseConnections(options: ConnectionOptions): Connections {
  return new Connections({ connections: { default: options }, root: '/', logger: silent });
}

export function redisConnections(url: string, prefix: string): RedisConnections {
  return new RedisConnections({ connections: { default: { url, prefix } }, logger: silent });
}

/** A fresh, empty target for `kind` (a new directory, database file, Postgres database or Redis prefix). */
export async function freshTarget(kind: StoreKind): Promise<{ target: StoreTarget; drop: () => Promise<void> }> {
  switch (kind) {
    case 'memory':
      return { target: { kind }, drop: async () => {} };
    case 'file': {
      const directory = mkdtempSync(join(tmpdir(), 'bespoke-sessions-'));
      return { target: { kind, directory }, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    }
    case 'sqlite': {
      const directory = mkdtempSync(join(tmpdir(), 'bespoke-sessions-db-'));
      const file = join(directory, 'sessions.sqlite');
      const connections = databaseConnections({ driver: 'sqlite', database: file });
      await migrate(connections);
      await connections.destroy();
      return { target: { kind, file }, drop: async () => rmSync(directory, { recursive: true, force: true }) };
    }
    case 'pgsql': {
      const name = `bespoke_sessions_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
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
      const prefix = `bespoke-test-${crypto.randomUUID().slice(0, 8)}:`;
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

/** Opens the store at `target`. */
export function openStore(target: StoreTarget, clock: Clock): { store: SessionStore; rows: () => Promise<number>; close: () => Promise<void> } {
  const none = async () => 0;
  switch (target.kind) {
    case 'memory':
      return { store: new MemorySessionStore(clock), rows: none, close: async () => {} };
    case 'file':
      return { store: new FileSessionStore(target.directory, clock), rows: none, close: async () => {} };
    case 'sqlite':
    case 'pgsql': {
      const connections = databaseConnections(target.kind === 'sqlite' ? { driver: 'sqlite', database: target.file } : { driver: 'pgsql', url: target.url, poolMax: 10 });
      const db = connections.get();
      return {
        store: new DatabaseSessionStore({ db }, LIFETIME, clock),
        rows: async () => Number((await sql<{ count: number | string }>`select count(*) as count from sessions`.execute(db)).rows[0]!.count),
        close: () => connections.destroy(),
      };
    }
    case 'redis': {
      const connections = redisConnections(target.url, target.prefix);
      return { store: new RedisSessionStore(connections.get()), rows: none, close: () => connections.close() };
    }
  }
}

/** A fresh store of `kind` with a test clock, for one test. */
export async function storeUnderTest(kind: StoreKind): Promise<StoreUnderTest> {
  const { target, drop } = await freshTarget(kind);
  const clock = new TestClock();
  const { store, rows, close } = openStore(target, clock);
  return {
    store,
    clock,
    target,
    rows,
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
