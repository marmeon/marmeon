import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { runTransaction, TransactionError, transactionOf, token, type Logger } from '@bespokecore/core';
import { Kysely, type Dialect, type IsolationLevel, type LogEvent, type Transaction } from 'kysely';
import type { ExposedTables, ModuleDatabase, Modules, TableOwners, Tables } from './types.ts';
import { describeConnection, type ConnectionOptions } from './config.ts';
import { DatabaseConnectionError, withBespokeDriver, type BespokeDriver } from './driver.ts';
import { SchemaMetadata } from './metadata.ts';
import { createPostgresDialect } from './postgres.ts';
import { RelationsPlugin } from './relations.ts';
import { SecretColumnsPlugin } from './secrets.ts';
import { createSqliteDialect } from './sqlite.ts';

/**
 * The default connection, typed by the app's tables: `constructor(db: Database)`.
 *
 * Module boundaries are opt-in (E20, revised): with a module's name — `Database<'user-profile'>` —
 * the module sees its own tables for everything, and other modules' `exposes` tables for reading and
 * joins only. At runtime it is the same connection either way; the boundary is a type.
 */
export type Database<M extends keyof Modules & string = never> = [M] extends [never]
  ? Kysely<Tables>
  : ModuleDatabase<Tables, TableOwners, ExposedTables, M>;
export const Database = token<Kysely<Tables>>('Database');

/** How `connections.transaction()` runs. */
export interface TransactionOptions {
  /** The connection (default: `default`). */
  readonly connection?: string;
  /** For the outermost transaction only (a nested one is a savepoint). */
  readonly isolationLevel?: IsolationLevel;
}

/** One executed (or failed) query — for the query log, tests counting queries, and devtools. */
export interface QueryEvent {
  readonly connection: string;
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly durationMs: number;
  /** Set when the query failed. */
  readonly error?: unknown;
}

/**
 * The app's database connections — opened on first use, closed on shutdown.
 *
 * ```ts
 * constructor(connections: Connections) {
 *   this.#reporting = connections.get<ReportingTables>('reporting');
 * }
 * ```
 */
export class Connections {
  readonly #options: ReadonlyMap<string, ConnectionOptions>;
  readonly #root: string;
  readonly #logger: Logger;
  readonly #instances = new Map<string, { db: Kysely<any>; driver: BespokeDriver }>();
  readonly #listeners = new Set<(query: QueryEvent) => void>();
  #destroyed = false;

  constructor(options: { connections: Readonly<Record<string, ConnectionOptions>>; root: string; logger: Logger }) {
    this.#options = new Map(Object.entries(options.connections));
    this.#root = options.root;
    this.#logger = options.logger.child({ channel: 'db' });
  }

  /** The connection by name (default: `default`, from `DB_CONNECTION`). Typed by `Tables` unless given its own. */
  get<DB = Tables>(name = 'default'): Kysely<DB> {
    return this.#instance(name).db as Kysely<DB>;
  }

  /**
   * Runs `callback` in a transaction — and everything it awaits with it (E107): repositories, the database queue,
   * in-process event listeners and any `db` of this connection join the transaction on their own, no `using(trx)`
   * needed. It commits when the callback resolves and rolls back when it throws (rethrowing the error).
   *
   * ```ts
   * const user = await this.#connections.transaction(async () => {
   *   const user = await this.#users.insert({ … });
   *   await this.#profiles.insert({ user_id: user.id });
   *   await this.#queue.dispatch(SendWelcomeMailJob, { userId: user.id });   // a row in the same transaction
   *   return user;
   * });
   * ```
   *
   * - **Nested** `transaction()` calls (here, in a repository, in Kysely's own `db.transaction()`) become savepoints:
   *   an inner rollback keeps the outer writes. One at a time — not several at once in a `Promise.all`.
   * - **After the commit:** work for the outside world (a job on a non-database queue, a mail) waits for the outermost
   *   commit with `afterCommit(fn)` and is dropped on a rollback. **Outside:** `outsideTransaction(fn)` for writes that
   *   must survive a rollback.
   * - **Await everything.** Work started inside that runs after the transaction finished (an un-awaited promise, a timer)
   *   throws `TransactionFinishedError` — it never runs outside the transaction by accident.
   * - The context follows this call chain only (AsyncLocalStorage): other requests and jobs running meanwhile never see
   *   it. Framework boundaries (work after the response, jobs, the worker) start outside of it.
   *
   * `callback` also receives the transaction as a Kysely `Transaction` — for code outside this call chain, or a
   * repository's `using(trx)`. `isolationLevel` applies to an outermost transaction only.
   */
  async transaction<R>(callback: (trx: Transaction<Tables>) => R | PromiseLike<R>, options: TransactionOptions = {}): Promise<R> {
    const name = options.connection ?? 'default';
    const { db, driver } = this.#instance(name);
    if (options.isolationLevel && transactionOf(driver)) {
      throw new TransactionError(
        `transaction({ isolationLevel: '${options.isolationLevel}' }) inside another transaction of "${name}" becomes a savepoint, which has no isolation level of its own — set it on the outermost transaction.`,
      );
    }
    return driver.exclusive(() =>
      runTransaction(driver, name, () => {
        const builder = options.isolationLevel ? db.transaction().setIsolationLevel(options.isolationLevel) : db.transaction();
        return builder.execute(async (trx) => callback(trx as Transaction<Tables>));
      }),
    );
  }

  /** Whether the current call chain runs inside a `transaction()` of this connection (E107). */
  inTransaction(name = 'default'): boolean {
    const instance = this.#instances.get(name);
    return instance !== undefined && transactionOf(instance.driver) !== undefined;
  }

  /**
   * Runs every query of a connection inside one transaction until `rollback()` undoes all of it;
   * transactions opened meanwhile become savepoints. The basis of per-test isolation (E21).
   */
  isolate(name = 'default'): Promise<{ rollback(): Promise<void> }> {
    return this.#instance(name).driver.isolate();
  }

  /** Names of every configured connection. */
  names(): string[] {
    return [...this.#options.keys()];
  }

  options(name = 'default'): ConnectionOptions {
    const options = this.#options.get(name);
    if (!options) {
      throw new DatabaseConnectionError(
        `Database connection "${name}" is not configured. Known: ${this.names().join(', ')}. Add one with defineConnection('${name}', …) in the app's config.`,
      );
    }
    return options;
  }

  /** Listens to every query on every connection. Returns a function that stops listening. */
  onQuery(listener: (query: QueryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Checks what can be checked without connecting: that the directory of each SQLite file exists
   * (SQLite creates the file, not its directory). Postgres is reached lazily, on the first query —
   * otherwise every CLI command would need a running database.
   */
  verify(): void {
    for (const [name, options] of this.#options) {
      if (options.driver !== 'sqlite' || options.database === ':memory:') continue;
      const directory = dirname(this.#sqlitePath(options.database));
      if (!existsSync(directory)) {
        throw new DatabaseConnectionError(
          `The directory of the SQLite database for connection "${name}" does not exist: ${directory} (${describeConnection(options)}).`,
        );
      }
    }
  }

  /** Closes every opened connection (pools included). Later `get()` calls throw. */
  async destroy(): Promise<void> {
    this.#destroyed = true;
    const instances = [...this.#instances.values()];
    this.#instances.clear();
    await Promise.all(instances.map(({ db }) => db.destroy()));
  }

  #instance(name: string): { db: Kysely<any>; driver: BespokeDriver } {
    if (this.#destroyed) throw new Error(`The database connections are closed (the application shut down); cannot use "${name}".`);
    let instance = this.#instances.get(name);
    if (!instance) {
      const options = this.options(name);
      const metadata = new SchemaMetadata(options.driver);
      const { dialect, driver } = withBespokeDriver(this.#dialect(options), { name, target: describeConnection(options), metadata });
      const plugins = [metadata.plugin(), new RelationsPlugin(options.driver, metadata), new SecretColumnsPlugin(metadata)];
      const db = new Kysely<any>({ dialect, plugins, log: (event) => this.#log(name, event) });
      instance = { db, driver };
      this.#instances.set(name, instance);
    }
    return instance;
  }

  #dialect(options: ConnectionOptions): Dialect {
    if (options.driver === 'sqlite') return createSqliteDialect(this.#sqlitePath(options.database));
    return createPostgresDialect({
      url: options.url,
      poolMax: options.poolMax,
      onIdleError: (error) => this.#logger.warn('An idle database connection failed; the pool replaces it', { error: error.message }),
    });
  }

  #sqlitePath(database: string): string {
    return database === ':memory:' || isAbsolute(database) ? database : join(this.#root, database);
  }

  #log(connection: string, event: LogEvent): void {
    const query: QueryEvent = {
      connection,
      sql: event.query.sql,
      parameters: event.query.parameters,
      durationMs: event.queryDurationMillis,
      ...(event.level === 'error' ? { error: event.error } : {}),
    };
    // Parameters stay out of the log line — they may hold password hashes or tokens.
    this.#logger.debug(query.error ? 'Query failed' : 'Query', { connection, sql: query.sql, durationMs: Math.round(query.durationMs * 100) / 100 });
    for (const listener of this.#listeners) listener(query);
  }
}
