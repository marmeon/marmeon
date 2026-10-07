import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { runTransaction, TransactionError, transactionOf, token, type Application, type Logger } from '@marmeon/core';
import { channels, messageBase, publishEnded, type DbQueryMessage } from '@marmeon/core/diagnostics';
import { Kysely, TableNode, type CompiledQuery, type Dialect, type IsolationLevel, type LogEvent, type OperationNode, type Transaction } from 'kysely';
import type { ExposedTables, ModuleDatabase, Modules, TableOwners, Tables } from './types.ts';
import { DEFAULT_INFRASTRUCTURE_POOL_MAX, describeConnection, type ConnectionOptions } from './config.ts';
import { MarmeonDriver, DatabaseConnectionError, multipleConnections, withMarmeonDriver } from './driver.ts';
import { InfrastructureDriver, type InfrastructureUsage } from './infrastructure.ts';
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
  /** The app the queries are reported for on the `db.query` channel (E118) — none: not reported (scratch connections). */
  readonly #app: Application | undefined;
  readonly #instances = new Map<string, Instance>();
  /** Infrastructure handles (E108), per connection and user. */
  readonly #infrastructure = new Map<string, Kysely<any>>();
  /** Postgres: the infrastructure's own pool, per connection. */
  readonly #pools = new Map<string, MarmeonDriver>();
  readonly #listeners = new Set<(query: QueryEvent) => void>();
  #destroyed = false;

  constructor(options: { connections: Readonly<Record<string, ConnectionOptions>>; root: string; logger: Logger; app?: Application }) {
    this.#options = new Map(Object.entries(options.connections));
    this.#root = options.root;
    this.#logger = options.logger.child({ channel: 'db' });
    this.#app = options.app;
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

  /**
   * The connection for infrastructure — the cache with its rate limits and locks, sessions (E108): it NEVER joins the
   * app's transactions. A rate-limit hit or a lock inside a transaction that rolls back stays, and a lock is visible to
   * every other process at once — as it must be.
   *
   * - **Postgres:** a pool of its own to the same database (`infrastructurePoolMax`, `DB_INFRA_POOL_MAX`, default 4),
   *   opened on first use. Nothing to configure.
   * - **SQLite:** a second connection to the same file would wait for an open transaction's write lock — forever, if
   *   that transaction waits for it. So the handle shares the file's one connection: outside of transactions (the normal
   *   case) that is all it takes; inside an open transaction of that file every statement throws an
   *   `InfrastructureTransactionError` that says what to do (`usage.remedy`) — never a silent join. Full separation on
   *   SQLite means a connection with a file of its own (e.g. `defineConnection('system', …)` and `CACHE_CONNECTION=system`).
   * - In a test's isolated connection (`database: 'refresh'`) there is one physical connection, as on SQLite.
   *
   * Runs single statements — no transactions of its own.
   */
  infrastructure<DB = any>(name = 'default', usage?: InfrastructureUsage): Kysely<DB> {
    const key = `${name}\0${usage?.system ?? ''}`;
    let db = this.#infrastructure.get(key);
    if (!db) {
      const main = this.#instance(name);
      const options = this.options(name);
      const dialect = this.#dialect(options); // for its compiler and adapter only — the driver is below
      const driver = new InfrastructureDriver({
        main: main.driver,
        // Every connection of this app on the same SQLite file: a transaction of any of them holds the file.
        peers: () => [...this.#instances.values()].filter((other) => other === main || (main.file !== undefined && other.file === main.file)).map((other) => other.driver),
        ...(options.driver === 'pgsql' ? { pool: () => this.#pool(name, options) } : {}),
        ...(usage ? { usage } : {}),
      });
      const adapter = dialect.createAdapter();
      db = new Kysely<any>({
        dialect: {
          createAdapter: () => multipleConnections(adapter),
          createQueryCompiler: () => dialect.createQueryCompiler(),
          createIntrospector: (kysely) => dialect.createIntrospector(kysely),
          createDriver: () => driver,
        },
        log: (event) => this.#log(name, event),
      });
      this.#infrastructure.set(key, db);
    }
    return db as Kysely<DB>;
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
    const pools = [...this.#pools.values()];
    this.#instances.clear();
    this.#infrastructure.clear();
    this.#pools.clear();
    await Promise.all([...instances.map(({ db }) => db.destroy()), ...pools.map((pool) => pool.destroy())]);
  }

  #instance(name: string): Instance {
    if (this.#destroyed) throw new Error(`The database connections are closed (the application shut down); cannot use "${name}".`);
    let instance: Instance | undefined = this.#instances.get(name);
    if (!instance) {
      const options = this.options(name);
      const metadata = new SchemaMetadata(options.driver);
      const { dialect, driver } = withMarmeonDriver(this.#dialect(options), { name, target: describeConnection(options), metadata });
      const plugins = [metadata.plugin(), new RelationsPlugin(options.driver, metadata), new SecretColumnsPlugin(metadata)];
      const db = new Kysely<any>({ dialect, plugins, log: (event) => this.#log(name, event) });
      instance = { db, driver, metadata, ...(options.driver === 'sqlite' && options.database !== ':memory:' ? { file: this.#sqlitePath(options.database) } : {}) };
      this.#instances.set(name, instance);
    }
    return instance;
  }

  /** Postgres: the infrastructure's own pool of a connection, created on first use (it connects on its first query). */
  #pool(name: string, options: Extract<ConnectionOptions, { driver: 'pgsql' }>): MarmeonDriver {
    if (this.#destroyed) throw new Error(`The database connections are closed (the application shut down); cannot use "${name}".`);
    let pool = this.#pools.get(name);
    if (!pool) {
      const dialect = this.#dialect({ ...options, poolMax: options.infrastructurePoolMax ?? DEFAULT_INFRASTRUCTURE_POOL_MAX });
      pool = new MarmeonDriver(dialect.createDriver(), { name, target: `${describeConnection(options)} (infrastructure pool)` }, { detached: true });
      this.#pools.set(name, pool);
    }
    return pool;
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
    // Called where the query was awaited: the request's or job's context is the current one (E118).
    if (this.#app && queries.hasSubscribers) {
      const message: DbQueryMessage = {
        ...messageBase(this.#app),
        // Kysely reports a query once it ended: it started `durationMs` before.
        startedAt: performance.timeOrigin + performance.now() - query.durationMs,
        connection,
        driver: this.#options.get(connection)?.driver ?? 'unknown',
        sql: query.sql,
        parameters: query.parameters,
        secret: touchesSecrets(event.query, this.#instances.get(connection)?.metadata.secrets),
        durationMs: query.durationMs,
        ...(query.error === undefined ? {} : { error: query.error }),
      };
      publishEnded(queries, message);
    }
  }
}

const queries = channels.tracing('db.query');

interface Instance {
  db: Kysely<any>;
  driver: MarmeonDriver;
  metadata: SchemaMetadata;
  file?: string;
}

/**
 * Whether a statement touches a table with secret columns (E125: its parameters may hold a password hash or a token) —
 * every table the query builder named, and for raw SQL (`sql\`…\``, in whole or in part) any secret table's name in
 * the text. When in doubt, yes.
 */
export function touchesSecrets(query: CompiledQuery, secrets: ReadonlyMap<string, ReadonlySet<string>> | undefined): boolean {
  if (!secrets || secrets.size === 0) return false;
  let raw = false;
  let touches = false;
  visit(query.query, (node) => {
    if (node.kind === 'RawNode') raw = true;
    else if (TableNode.is(node) && secrets.has(node.table.identifier.name)) touches = true;
  });
  if (touches) return true;
  if (!raw) return false;
  const sql = query.sql.toLowerCase();
  for (const table of secrets.keys()) {
    const name = table.toLowerCase();
    for (let at = sql.indexOf(name); at !== -1; at = sql.indexOf(name, at + 1)) {
      if (!/[\w$]/.test(sql[at - 1] ?? ' ') && !/[\w$]/.test(sql[at + name.length] ?? ' ')) return true;
    }
  }
  return false;
}

/** Visits every operation node below `node` (nodes are plain frozen objects with a `kind`). */
function visit(node: unknown, fn: (node: OperationNode) => void): void {
  if (ArrayBuffer.isView(node)) return; // a binary parameter — nothing to visit, possibly large
  if (Array.isArray(node)) {
    for (const item of node) visit(item, fn);
  } else if (node !== null && typeof node === 'object') {
    if (typeof (node as { kind?: unknown }).kind === 'string') fn(node as OperationNode);
    for (const value of Object.values(node)) if (value !== null && typeof value === 'object') visit(value, fn);
  }
}
