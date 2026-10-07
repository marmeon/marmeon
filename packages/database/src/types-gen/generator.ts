import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Application, Logger } from '@marmeon/core';
import { sql } from 'kysely';
import { Connections } from '../connections.ts';
import { Migrator, MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE } from '../migrations/migrator.ts';
import { renderTypes, type Rendered, type SchemaSnapshot } from './render.ts';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /**
     * Own tables other modules may read and join (never write) — E20:
     * `defineModule({ name: 'auth', exposes: ['users'] })`. Everything else stays private to the module.
     */
    readonly exposes?: readonly string[];
  }
}

/** Where the generated types live, relative to the app root. Committed, so type checks need no database. */
export const TYPES_FILE = 'bootstrap/database.d.ts';

/**
 * Generates the table types **from the migrations**: they run on a scratch database of the app's
 * driver (SQLite in memory, or a temporary Postgres database), which is then introspected. The
 * result never depends on the state of the development database.
 */
export class TypeGenerator {
  readonly #app: Application;
  readonly #connections: Connections;
  readonly #logger: Logger;

  constructor(app: Application, connections: Connections, logger: Logger) {
    this.#app = app;
    this.#connections = connections;
    this.#logger = logger;
  }

  get path(): string {
    return join(this.#app.root, TYPES_FILE);
  }

  async render(): Promise<Rendered> {
    return renderTypes(await this.#withScratch((scratch) => this.#snapshot(scratch)));
  }

  /** Writes the file; returns whether it changed. */
  async write(): Promise<{ changed: boolean; warnings: string[] }> {
    const { source, warnings } = await this.render();
    const changed = !existsSync(this.path) || readFileSync(this.path, 'utf8') !== source;
    if (changed) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, source);
    }
    return { changed, warnings };
  }

  /** Whether the committed file matches the migrations. */
  async isCurrent(): Promise<boolean> {
    return existsSync(this.path) && readFileSync(this.path, 'utf8') === (await this.render()).source;
  }

  async #snapshot(scratch: Connections): Promise<SchemaSnapshot> {
    // One scratch database for every table, also those of migrations on another connection (E108): one `Tables`.
    const migrator = new Migrator(this.#app, scratch).onOneConnection();
    await migrator.migrate();
    const db = scratch.get<any>();
    const driver = scratch.options().driver;
    const bookkeeping = new Set([MIGRATIONS_TABLE, OWNERS_TABLE, SECRETS_TABLE]);
    const tables = (await db.introspection.getTables()).filter((t) => !bookkeeping.has(t.name));
    const sqliteKeys = driver === 'sqlite' ? await sqliteKeysOf(scratch, tables.map((t) => t.name)) : undefined;
    return {
      driver,
      tables,
      sqliteKeys,
      owners: await migrator.owners(),
      secrets: await migrator.secrets(),
      modules: this.#app.modules.map((module) => module.name),
      exposes: new Map(this.#app.modules.filter((m) => m.exposes?.length).map((m) => [m.name, m.exposes!])),
    };
  }

  /** A throwaway database of the app's driver, migrated from scratch. */
  async #withScratch<T>(use: (scratch: Connections) => Promise<T>): Promise<T> {
    const options = this.#connections.options();
    const quiet = this.#logger.child({ scratch: true });
    if (options.driver === 'sqlite') {
      const scratch = new Connections({ connections: { default: { driver: 'sqlite', database: ':memory:' } }, root: this.#app.root, logger: quiet });
      try {
        return await use(scratch);
      } finally {
        await scratch.destroy();
      }
    }
    const url = new URL(options.url);
    const name = `${url.pathname.slice(1) || 'marmeon'}_types_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const admin = this.#connections.get();
    await sql`create database ${sql.id(name)}`.execute(admin);
    url.pathname = `/${name}`;
    const scratch = new Connections({ connections: { default: { driver: 'pgsql', url: url.href, poolMax: 1 } }, root: this.#app.root, logger: quiet });
    try {
      return await use(scratch);
    } finally {
      await scratch.destroy();
      await sql`drop database ${sql.id(name)} with (force)`.execute(admin);
    }
  }
}

async function sqliteKeysOf(connections: Connections, tables: readonly string[]): Promise<SchemaSnapshot['sqliteKeys']> {
  const db = connections.get<any>();
  const keys = new Map<string, { primary: string[]; autoIncrement: string | undefined }>();
  for (const table of tables) {
    const columns = (await sql<{ name: string; pk: number }>`select name, pk from pragma_table_info(${table})`.execute(db)).rows;
    const ddl = (await sql<{ sql: string }>`select sql from sqlite_master where type = 'table' and name = ${table}`.execute(db)).rows[0]?.sql ?? '';
    const autoIncrement = /["`]?(\w+)["`]?\s+integer\s+primary\s+key\s+autoincrement/i.exec(ddl)?.[1];
    keys.set(table, { primary: columns.filter((c) => c.pk > 0).map((c) => c.name), autoIncrement });
  }
  return keys;
}
