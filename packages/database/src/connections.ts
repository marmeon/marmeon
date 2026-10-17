import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { Redactor, rollBackOnErr, runTransaction, TransactionError, token, type Application, type Logger } from '@marmeon/core';
import { messageBase, publishEnded, transactionOf, withCode } from '@marmeon/core/internal';
import { channels, type DbQueryMessage } from '@marmeon/core/diagnostics';
import { Kysely, sql, TableNode, type CompiledQuery, type Dialect, type IsolationLevel, type KyselyPlugin, type LogEvent, type OperationNode } from 'kysely';
import type { Connection, Transaction } from './builder.ts';
import type { ExposedTables, ModuleDatabase, Modules, TableOwners, Tables } from './types.ts';
import { DEFAULT_INFRASTRUCTURE_POOL_MAX, describeConnection, type ConnectionOptions } from './config.ts';
// Puts the relation methods on Kysely's select builder when it loads — every connection made here offers them.
import './chain.ts';
import { MarmeonDriver, DatabaseConnectionError, multipleConnections, UncheckedDriver, withMarmeonDriver } from './driver.ts';
import { InfrastructureDriver, type InfrastructureUsage } from './infrastructure.ts';
import { onlyMigratorTables, registerInspection, registerMigrator } from './migrator-connection.ts';
import { SchemaMetadata, type SchemaSource } from './metadata.ts';
import { MigrationStateError } from './migration-state.ts';
import { migrationFiles } from './migrations/files.ts';
import { createPostgresDialect } from './postgres.ts';
import { RelationsPlugin } from './relations.ts';
import { fold } from './secret-guard.ts';
import { SchemaResolver } from './schema-resolver.ts';
import { loadProjection } from './schema/projection-file.ts';
import { emptyProjection, type SchemaProjection } from './schema/projection.ts';
import { createSqliteDialect } from './sqlite.ts';

/**
 * The default connection, typed by the app's tables: `constructor(db: Database)`.
 *
 * Module boundaries are opt-in: with a module's name — `Database<'user-profile'>` —
 * the module sees its own tables for everything, and other modules' `exposes` tables for reading and
 * joins only. At runtime it is the same connection either way; the boundary is a type.
 */
export type Database<M extends keyof Modules & string = never> = [M] extends [never]
  ? Connection<Tables>
  : ModuleDatabase<Tables, TableOwners, ExposedTables, M>;
export const Database = token<Connection<Tables>>('Database');

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

/** The app's database connections — opened on first use, closed on shutdown: `connections.get<ReportingTables>('reporting')`. */
export class Connections {
  readonly #options: ReadonlyMap<string, ConnectionOptions>;
  readonly #root: string;
  readonly #logger: Logger;
  /** The app the queries are reported for on the `db.query` channel — none: not reported (scratch connections). */
  readonly #app: Application | undefined;
  /** What a connection's failure is masked with in the log: the app's (the names its packages add count too). */
  readonly #redactor: Redactor;
  readonly #instances = new Map<string, Instance>();
  /** Infrastructure handles, per connection and user. */
  readonly #infrastructure = new Map<string, Connection<any>>();
  /** Postgres: the infrastructure's own pool, per connection. */
  readonly #pools = new Map<string, MarmeonDriver>();
  readonly #listeners = new Set<(query: QueryEvent) => void>();
  /** The schema a migrator of this process handed over: every connection, opened now or later, has it as its schema. */
  #published: SchemaProjection | undefined;
  #destroyed = false;

  constructor(options: { connections: Readonly<Record<string, ConnectionOptions>>; root: string; logger: Logger; app?: Application }) {
    this.#options = new Map(Object.entries(options.connections));
    this.#root = options.root;
    this.#logger = options.logger.child({ channel: 'db' });
    this.#app = options.app;
    this.#redactor = options.app?.container.has(Redactor) ? options.app.container.make(Redactor) : new Redactor();
  }

  /** The connection by name (default: `default`, from `DB_CONNECTION`). Typed by `Tables` unless given its own. */
  get<DB = Tables>(name = 'default'): Connection<DB> {
    return this.#instance(name).db as Connection<DB>;
  }

  /**
   * Runs `callback` in a transaction — and everything it awaits with it: repositories, the database queue, in-process event
   * listeners and any `db` of this connection join on their own. It commits when the callback resolves and rolls back when it
   * throws (rethrowing the error) or returns an `err` (returning it; `commitAnyway(err(…))` commits); a nested call is a
   * savepoint. Work that runs after the transaction finished throws `TransactionFinishedError` instead of running outside it.
   * See `docs/transactions.md#running-a-transaction`.
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
        return builder.execute(async (trx) => rollBackOnErr(await callback(trx as Transaction<Tables>)));
      }),
    );
  }

  /**
   * The connection for infrastructure — the cache with its rate limits and locks, sessions: it NEVER joins the app's
   * transactions, so a rate-limit hit or a lock survives a rollback and other processes see a lock at once. On Postgres a
   * small pool of its own; on SQLite the file's one connection, and in a test's isolated connection its one physical
   * connection — there every statement inside an open transaction throws `InfrastructureTransactionError` (`usage.remedy`
   * says what to do) — never a silent join. Runs single statements only. See `docs/database.md#infrastructure-connections`.
   */
  infrastructure<DB = any>(name = 'default', usage?: InfrastructureUsage): Connection<DB> {
    const key = `${name}\0${usage?.system ?? ''}`;
    let db = this.#infrastructure.get(key);
    if (!db) {
      const main = this.#instance(name);
      const options = this.options(name);
      const dialect = this.#dialect(options, name); // for its compiler and adapter only — the driver is below
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
    return db as Connection<DB>;
  }

  /** @internal — what a connection knows about its schema (relations, markers, secret columns), as far as it is loaded. */
  metadata(name = 'default'): SchemaMetadata {
    return this.#instance(name).metadata;
  }

  /**
   * @internal — the schema the migrations leave, as the migrator of this process has just made the database: every managed connection
   * uses it from now on instead of reading the migration files and comparing them with the database.
   */
  publish(projection: SchemaProjection): void {
    this.#published = projection;
    for (const { metadata } of this.#instances.values()) metadata.publish(projection);
  }

  /** @internal — the schema the managed connections work with now: the one last {@link publish}ed, else the one loaded from the migration files; empty before. */
  projection(): SchemaProjection {
    return this.#published ?? this.#instances.get('default')?.metadata.projection ?? emptyProjection;
  }

  /** Whether the current call chain runs inside a `transaction()` of this connection. */
  inTransaction(name = 'default'): boolean {
    const instance = this.#instances.get(name);
    return instance !== undefined && transactionOf(instance.driver) !== undefined;
  }

  /**
   * Runs every query of a connection inside one transaction until `rollback()` undoes all of it;
   * transactions opened meanwhile become savepoints. The basis of per-test isolation.
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
        withCode('D11', `Database connection "${name}" is not configured. Known: ${this.names().join(', ')}. Add one with defineConnection('${name}', …) in the app's config.`),
      );
    }
    this.#used.add(name);
    return options;
  }

  /**
   * The connections this process uses — `default`, and every one asked for since: a query, an infrastructure connection, or a
   * package that checks its connection when it boots (the cache, sessions, the queue, notifications). Readiness asks these only,
   * so a connection the app configures and nothing uses is never opened (a SQLite file never created).
   */
  used(): string[] {
    return this.names().filter((name) => this.#used.has(name));
  }

  readonly #used = new Set<string>(['default']);

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
          withCode('D11', `The directory of the SQLite database for connection "${name}" does not exist: ${directory} (${describeConnection(options)}).`),
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
      const metadata = new SchemaMetadata(options.driver, name, options.managed !== false, this.#schemaSource(name));
      if (this.#published) metadata.publish(this.#published);
      const base = this.#dialect(options, name);
      const relations = new RelationsPlugin(options.driver, metadata);
      const resolver = new SchemaResolver(metadata, base.createQueryCompiler(), relations);
      const { dialect, driver } = withMarmeonDriver(base, { name, target: describeConnection(options), metadata, deferred: resolver, results: relations });
      // In this order: placeholders resolved, then the relations' JSON built and the query checked for secret columns.
      const plugins = [resolver, relations];
      const db = new Kysely<any>({ dialect, plugins, log: (event) => this.#log(name, event) });
      // The migrator's own way to the same connections (see migrator-connection.ts): it must reach a database `db` refuses (migrations pending,
      // a record of migrations of a newer Marmeon, tables and no record), and `db:show` looks at one. Their driver reports the queries itself:
      // Kysely instances patching one shared connection would log each query twice.
      const unchecked = (plugins: KyselyPlugin[]) =>
        new Kysely<any>({
          dialect: {
            ...dialect,
            createDriver: () =>
              new UncheckedDriver(driver, ({ query, durationMs, error }) =>
                this.#log(name, { query, queryDurationMillis: durationMs, ...(error === undefined ? { level: 'query' as const } : { level: 'error' as const, error }) } as LogEvent),
              ),
          },
          plugins,
        });
      registerMigrator(this, name, unchecked([onlyMigratorTables()]));
      registerInspection(this, name, unchecked([]));
      instance = { db, driver, metadata, ...(options.driver === 'sqlite' && options.database !== ':memory:' ? { file: this.#sqlitePath(options.database) } : {}) };
      this.#instances.set(name, instance);
    }
    return instance;
  }

  /**
   * Where a managed connection gets its schema when no migrator handed it over: the projection of the app's migration files (cached in
   * `.marmeon/schema.json`; without an app: empty), and — for a connection other than `default`, whose database holds no record of
   * migrations — the state of `default`.
   */
  #schemaSource(name: string): SchemaSource {
    const app = this.#app;
    return {
      projection: async () => (app ? loadProjection(app.root, migrationFiles(app)) : emptyProjection),
      ...(name === 'default'
        ? {}
        : {
            follow: async () => {
              if (this.options('default').managed === false) {
                throw new MigrationStateError(
                  'unmigrated',
                  name,
                  withCode(
                    'D1',
                    `The database connection "${name}" is migrated by Marmeon, but "default" is set to \`managed: false\`, and the record of migrations is kept on "default": nothing tells which migrations ran. ` +
                      'Remove `managed: false` from "default", or set it on this connection too. Every query on this connection is refused until that is so. See docs/migrations.md#how-the-migrator-keeps-track.',
                  ),
                );
              }
              // No query once `default` has been checked: it may be the connection a transaction of this very call chain holds (SQLite has one
              // physical connection per file), and a query on it would wait for that transaction while this connection's lock is held.
              if (this.metadata('default').ready) return;
              await sql`select 1`.execute(this.get('default'));
            },
          }),
      ahead: (migrations) =>
        this.#logger.info('The database has migrations this version of the code does not know (a deploy in progress, or a newer release elsewhere); it keeps running with the schema it knows', {
          connection: name,
          migrations: migrations.join(', '),
        }),
    };
  }

  /** Postgres: the infrastructure's own pool of a connection, created on first use (it connects on its first query). */
  #pool(name: string, options: Extract<ConnectionOptions, { driver: 'pgsql' }>): MarmeonDriver {
    if (this.#destroyed) throw new Error(`The database connections are closed (the application shut down); cannot use "${name}".`);
    let pool = this.#pools.get(name);
    if (!pool) {
      const dialect = this.#dialect({ ...options, poolMax: options.infrastructurePoolMax ?? DEFAULT_INFRASTRUCTURE_POOL_MAX }, name);
      pool = new MarmeonDriver(dialect.createDriver(), { name, target: `${describeConnection(options)} (infrastructure pool)` }, { detached: true });
      this.#pools.set(name, pool);
    }
    return pool;
  }

  #dialect(options: ConnectionOptions, name: string): Dialect {
    if (options.driver === 'sqlite') return createSqliteDialect(this.#sqlitePath(options.database));
    return createPostgresDialect({
      url: options.url,
      name,
      poolMax: options.poolMax,
      onIdleError: (error) => this.#logger.warn('An idle database connection failed; the pool replaces it', { error: this.#redactor.text(error.message) }),
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
    // Called where the query was awaited: the request's or job's context is the current one.
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
  db: Connection<any>;
  driver: MarmeonDriver;
  metadata: SchemaMetadata;
  file?: string;
}

/**
 * Whether a statement touches a table with secret columns (its parameters may hold a password hash or a token) —
 * every table the query builder named, and for raw SQL (`sql\`…\``, in whole or in part) any secret table's name in
 * the text. When in doubt, yes.
 */
export function touchesSecrets(query: CompiledQuery, secrets: ReadonlyMap<string, ReadonlySet<string>> | undefined): boolean {
  if (!secrets || secrets.size === 0) return false;
  let raw = false;
  let touches = false;
  // SQLite reads `Users` as `users`; a name in another case counts, since the flag errs towards hiding the parameters.
  const folded = new Set([...secrets.keys()].map(fold));
  visit(query.query, (node) => {
    if (node.kind === 'RawNode') raw = true;
    else if (TableNode.is(node) && folded.has(fold(node.table.identifier.name))) touches = true;
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
