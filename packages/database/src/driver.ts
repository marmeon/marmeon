import { leftTransactionOf, TransactionError, transactionOf, type TransactionFrame } from '@marmeon/core';
import { CompiledQuery, type DatabaseConnection, type Dialect, type DialectAdapter, type Driver, type QueryResult, type TransactionSettings } from 'kysely';
import type { SchemaMetadata } from './metadata.ts';

/** A connection could not be opened — with the connection's name and where it points, never its password. */
export class DatabaseConnectionError extends Error {
  override name = 'DatabaseConnectionError';
}

export interface DriverContext {
  /** The connection's name, e.g. `default`. */
  readonly name: string;
  /** Where it points, for error messages: `sqlite storage/database.sqlite`, `pgsql postgres://marmeon:***@localhost/app`. */
  readonly target: string;
  /** Refreshed on each connection handed out, while stale (see {@link SchemaMetadata}). */
  readonly metadata?: SchemaMetadata;
}

/**
 * Wraps a dialect's driver with what every Marmeon connection needs:
 *
 * - **Nested transactions become savepoints.** When a connection is already inside a transaction,
 *   beginning another one starts a savepoint instead (commit → release, rollback → rollback to it) —
 *   Laravel's transaction level. That is what lets a test wrap everything in one transaction
 *   ({@link MarmeonDriver.isolate}) while the code under test opens its own.
 * - **The ambient transaction (E107).** Inside `connections.transaction(callback)` every query of this
 *   connection — from a repository, the queue, any `db` — gets the transaction's connection; a transaction
 *   opened inside it becomes a savepoint on it. After the transaction finished, work of its call chain is
 *   refused ({@link TransactionFinishedError}) instead of running outside it.
 * - **One connection at a time on SQLite** — Kysely's lock, moved here so a query inside the transaction
 *   does not wait for the transaction that holds the lock (the hang W3 warned about).
 * - **One query at a time per connection.** A transaction's connection (and a test's isolated one) is
 *   shared by everything inside it — `Promise.all` over a page's props, two requests of a test — so its
 *   queries take turns: a driver like `pg` must not be sent a query while another is under way.
 * - **Connection failures say which connection** failed and where it points.
 * - **Schema metadata is loaded on the connection being handed out** — never through the pool,
 *   which a transaction may be holding.
 */
export function withMarmeonDriver(dialect: Dialect, context: DriverContext): { dialect: Dialect; driver: MarmeonDriver } {
  const adapter = dialect.createAdapter();
  const driver = new MarmeonDriver(dialect.createDriver(), context, { single: adapter.supportsMultipleConnections === false });
  return {
    driver,
    dialect: {
      // Kysely would lock single-connection dialects (SQLite) around every connection it hands out — before asking the
      // driver, so a query inside a transaction would wait for the transaction itself. The driver locks instead.
      createAdapter: () => multipleConnections(adapter),
      createQueryCompiler: () => dialect.createQueryCompiler(),
      createIntrospector: (db) => dialect.createIntrospector(db),
      createDriver: () => driver,
    },
  };
}

export class MarmeonDriver implements Driver {
  readonly #driver: Driver;
  readonly #context: DriverContext;
  /** Open transaction levels per connection: 1 = a real transaction, 2+ = savepoints inside it. */
  readonly #depth = new WeakMap<DatabaseConnection, number>();
  #init: Promise<void> | undefined;
  /** While isolated: the one connection every query uses, inside a transaction that is rolled back later. */
  #pinned: DatabaseConnection | undefined;
  /** The dialect has one physical connection (SQLite): one user at a time, by {@link #lock}. */
  readonly #single: boolean;
  readonly #lock = new ConnectionLock();
  /** While isolated on a dialect with several connections: ambient transactions take turns on the pinned connection. */
  readonly #turns = new ConnectionLock();
  /**
   * Connections bound to an ambient transaction, with how many hold them: the transaction itself and each query
   * running inside it. The last release really releases (and unlocks) it.
   */
  readonly #holders = new Map<DatabaseConnection, number>();

  /** A pool that never joins an ambient transaction: an infrastructure connection's own pool (E108). */
  readonly #detached: boolean;
  /** Each connection of the dialect's driver as handed out here: its queries take turns ({@link serialQueries}). */
  readonly #serial = new WeakMap<DatabaseConnection, DatabaseConnection>();

  constructor(driver: Driver, context: DriverContext, options: { single?: boolean; detached?: boolean } = {}) {
    this.#driver = driver;
    this.#context = context;
    this.#single = options.single ?? false;
    this.#detached = options.detached ?? false;
  }

  /** The connection's name, e.g. `default`. */
  get name(): string {
    return this.#context.name;
  }

  /**
   * Whether everyone shares one physical connection: SQLite, or a connection isolated for a test. Work that must not
   * join an open transaction cannot get a connection of its own here while that transaction holds it.
   */
  get sharesOneConnection(): boolean {
    return this.#single || this.#pinned !== undefined;
  }

  /**
   * @internal — for infrastructure connections (E108): a connection of its own, never the ambient transaction's (on a
   * shared physical connection, the caller has made sure no transaction of its call chain holds it).
   */
  acquireDetached(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    return this.#acquire(options);
  }

  init(options?: Parameters<Driver['init']>[0]): Promise<void> {
    // Once: Kysely inits lazily on the first query, `isolate()` may need it earlier.
    this.#init ??= this.#connecting(() => this.#driver.init(options)).catch((error: unknown) => {
      this.#init = undefined;
      throw error;
    });
    return this.#init;
  }

  async acquireConnection(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    if (this.#detached) return this.#acquire(options);
    // Throws when this call chain's transaction has finished: never a silent fallback to a fresh connection.
    const frame = transactionOf(this);
    if (frame) return frame.resource === undefined ? this.#begin(frame, options) : this.#join(frame.resource as DatabaseConnection);
    const left = leftTransactionOf(this);
    if (left && (this.#single || this.#pinned)) {
      throw new TransactionError(
        `outsideTransaction() cannot reach the database connection "${this.#context.name}" while the transaction it stepped out of is open: ` +
          `the connection has a single physical connection (${this.#pinned ? "a test's isolated connection" : 'SQLite'}), which that transaction holds — ` +
          'the work would wait for it forever. Do it after the transaction instead (catch the error, record, rethrow).',
      );
    }
    return this.#acquire(options);
  }

  async releaseConnection(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    const holders = this.#holders.get(connection);
    if (holders !== undefined) {
      if (holders > 1) {
        this.#holders.set(connection, holders - 1);
        return;
      }
      this.#holders.delete(connection);
    }
    try {
      if (connection !== this.#pinned) await this.#driver.releaseConnection(connection, options);
    } finally {
      if (this.#single) this.#lock.release();
    }
  }

  /**
   * @internal — runs an outermost ambient transaction. While isolated on a dialect with several connections (a test on
   * Postgres), concurrent transactions would share the pinned connection and interleave their savepoints — they take
   * turns instead. (On SQLite the connection lock already makes them.)
   */
  async exclusive<R>(transaction: () => Promise<R>): Promise<R> {
    if (!this.#pinned || this.#single || transactionOf(this)) return transaction();
    await this.#turns.obtain();
    try {
      return await transaction();
    } finally {
      this.#turns.release();
    }
  }

  /** A connection of its own (locked on SQLite; the pinned one while isolated), with fresh schema metadata. */
  async #acquire(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    if (this.#single) await this.#lock.obtain();
    let connection: DatabaseConnection;
    try {
      connection = this.#pinned ?? this.#serialOf(await this.#connecting(() => this.#driver.acquireConnection(options)));
    } catch (error) {
      if (this.#single) this.#lock.release();
      throw error;
    }
    try {
      await this.#context.metadata?.refresh(connection);
    } catch (error) {
      await this.releaseConnection(connection);
      throw error;
    }
    return connection;
  }

  /**
   * The connection a new ambient transaction begins on: inside another transaction of this connection, that one's
   * (the transaction becomes a savepoint); otherwise a connection of its own, held until the transaction releases it.
   */
  async #begin(frame: TransactionFrame, options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    let outer = frame.parent;
    while (outer && outer.owner !== this) outer = outer.parent;
    if (outer) {
      frame.resource = outer.resource;
      return this.#join(outer.resource as DatabaseConnection);
    }
    const connection = await this.#acquire(options);
    frame.resource = connection;
    // Isolated on a dialect with several connections, everyone shares the pinned one without a lock: nothing to count.
    if (this.#single || connection !== this.#pinned) this.#holders.set(connection, 1);
    return connection;
  }

  /** The transaction's connection, for a query (or a savepoint) inside it. */
  async #join(connection: DatabaseConnection): Promise<DatabaseConnection> {
    await this.#context.metadata?.refresh(connection);
    // Counted once it is handed out (a failed refresh is never released).
    const holders = this.#holders.get(connection);
    if (holders !== undefined) this.#holders.set(connection, holders + 1);
    return connection;
  }

  /**
   * Runs every following query on one connection, inside a transaction — until `rollback()` undoes
   * all of it. Transactions the code opens meanwhile become savepoints. The basis of per-test
   * isolation (Laravel's `RefreshDatabase`).
   *
   * Like Laravel's single test connection, concurrent transactions (two requests at once) share it.
   */
  async isolate(): Promise<{ rollback(): Promise<void> }> {
    if (this.#pinned) throw new Error(`The database connection "${this.#context.name}" is already isolated.`);
    await this.init();
    const connection = this.#serialOf(await this.#connecting(() => this.#driver.acquireConnection()));
    await this.#driver.beginTransaction(connection, {});
    this.#depth.set(connection, 1);
    this.#pinned = connection;
    return {
      rollback: async () => {
        if (this.#pinned !== connection) return;
        this.#pinned = undefined;
        this.#depth.delete(connection);
        try {
          await this.#driver.rollbackTransaction(connection);
        } finally {
          await this.#driver.releaseConnection(connection);
        }
      },
    };
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const depth = this.#depth.get(connection) ?? 0;
    // Isolation level and access mode belong to the outermost transaction; a savepoint has neither.
    if (depth === 0) await this.#driver.beginTransaction(connection, settings);
    else await connection.executeQuery(CompiledQuery.raw(`savepoint ${savepoint(depth)}`));
    this.#depth.set(connection, depth + 1);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const depth = this.#leave(connection);
    if (depth === 0) await this.#driver.commitTransaction(connection);
    else await connection.executeQuery(CompiledQuery.raw(`release savepoint ${savepoint(depth)}`));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const depth = this.#leave(connection);
    if (depth === 0) await this.#driver.rollbackTransaction(connection);
    else await connection.executeQuery(CompiledQuery.raw(`rollback to savepoint ${savepoint(depth)}`));
  }

  savepoint(...args: Parameters<NonNullable<Driver['savepoint']>>): Promise<void> {
    return this.#driver.savepoint!(...args);
  }

  rollbackToSavepoint(...args: Parameters<NonNullable<Driver['rollbackToSavepoint']>>): Promise<void> {
    return this.#driver.rollbackToSavepoint!(...args);
  }

  releaseSavepoint(...args: Parameters<NonNullable<Driver['releaseSavepoint']>>): Promise<void> {
    return this.#driver.releaseSavepoint!(...args);
  }

  destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    return this.#driver.destroy(options);
  }

  /** Leaves one level and returns the level that remains (0 = the real transaction ends now). */
  #leave(connection: DatabaseConnection): number {
    const depth = (this.#depth.get(connection) ?? 1) - 1;
    if (depth === 0) this.#depth.delete(connection);
    else this.#depth.set(connection, depth);
    return depth;
  }

  #serialOf(connection: DatabaseConnection): DatabaseConnection {
    let serial = this.#serial.get(connection);
    if (!serial) this.#serial.set(connection, (serial = serialQueries(connection)));
    return serial;
  }

  async #connecting<T>(open: () => Promise<T>): Promise<T> {
    try {
      return await open();
    } catch (error) {
      if (error instanceof DatabaseConnectionError) throw error;
      const reason = error instanceof Error ? error.message || (error as { code?: string }).code || error.name : String(error);
      throw new DatabaseConnectionError(
        `Could not connect to the database connection "${this.#context.name}" (${this.#context.target}): ${reason}`,
        { cause: error },
      );
    }
  }
}

const savepoint = (depth: number) => `marmeon_savepoint_${depth}`;

/** The adapter as it is, but claiming several connections — so Kysely leaves the locking to {@link MarmeonDriver}. */
export function multipleConnections(adapter: DialectAdapter): DialectAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'supportsMultipleConnections') return true;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const ignore = () => {};

/**
 * The connection, but its queries take turns — in the order they were sent, a failed one passing the turn on. `pg` warns about a
 * query sent while another is under way ("client.query() when the client is already executing a query") and pg 9 refuses it. A
 * stream holds the turn until it ends. Everything else is the connection itself, bound to it (private fields, the driver's symbols).
 * What is set on the wrapper stays on it: Kysely puts its query log around `executeQuery` that way — around the turn, so the
 * connection's own method is never replaced underneath it.
 */
export function serialQueries(connection: DatabaseConnection): DatabaseConnection {
  const execute = connection.executeQuery.bind(connection);
  const stream = connection.streamQuery.bind(connection);
  const own = new Map<PropertyKey, unknown>();
  let tail: Promise<unknown> | undefined;
  const turn = <T>(run: () => Promise<T>): Promise<T> => {
    const result = tail ? tail.then(run, run) : run();
    const settled = result.then(ignore, ignore);
    tail = settled;
    void settled.then(() => {
      if (tail === settled) tail = undefined;
    });
    return result;
  };
  const executeQuery: DatabaseConnection['executeQuery'] = (...args) => turn(() => execute(...args));
  async function* streamQuery<R>(...args: Parameters<DatabaseConnection['streamQuery']>): AsyncIterableIterator<QueryResult<R>> {
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    await new Promise<void>((started) =>
      void turn(() => {
        started();
        return finished;
      }),
    );
    try {
      yield* stream<R>(...args);
    } finally {
      done();
    }
  }
  return new Proxy(connection, {
    get(target, property) {
      if (own.has(property)) return own.get(property);
      if (property === 'executeQuery') return executeQuery;
      if (property === 'streamQuery') return streamQuery;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, property, value) {
      own.set(property, value);
      return true;
    },
  });
}

/** One user of a single-connection dialect at a time (Kysely's `ConnectionMutex`). */
class ConnectionLock {
  #held: Promise<void> | undefined;
  #release: (() => void) | undefined;

  async obtain(): Promise<void> {
    while (this.#held) await this.#held;
    this.#held = new Promise((resolve) => (this.#release = resolve));
  }

  release(): void {
    const release = this.#release;
    this.#held = undefined;
    this.#release = undefined;
    release?.();
  }
}
