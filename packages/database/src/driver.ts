import { leftTransactionOf, TransactionError, transactionOf, type TransactionFrame } from '@bespokecore/core';
import { CompiledQuery, type DatabaseConnection, type Dialect, type DialectAdapter, type Driver, type TransactionSettings } from 'kysely';
import type { SchemaMetadata } from './metadata.ts';

/** A connection could not be opened — with the connection's name and where it points, never its password. */
export class DatabaseConnectionError extends Error {
  override name = 'DatabaseConnectionError';
}

export interface DriverContext {
  /** The connection's name, e.g. `default`. */
  readonly name: string;
  /** Where it points, for error messages: `sqlite storage/database.sqlite`, `pgsql postgres://bespoke:***@localhost/app`. */
  readonly target: string;
  /** Refreshed on each connection handed out, while stale (see {@link SchemaMetadata}). */
  readonly metadata?: SchemaMetadata;
}

/**
 * Wraps a dialect's driver with what every BespokeCore connection needs:
 *
 * - **Nested transactions become savepoints.** When a connection is already inside a transaction,
 *   beginning another one starts a savepoint instead (commit → release, rollback → rollback to it) —
 *   Laravel's transaction level. That is what lets a test wrap everything in one transaction
 *   ({@link BespokeDriver.isolate}) while the code under test opens its own.
 * - **The ambient transaction (E107).** Inside `connections.transaction(callback)` every query of this
 *   connection — from a repository, the queue, any `db` — gets the transaction's connection; a transaction
 *   opened inside it becomes a savepoint on it. After the transaction finished, work of its call chain is
 *   refused ({@link TransactionFinishedError}) instead of running outside it.
 * - **One connection at a time on SQLite** — Kysely's lock, moved here so a query inside the transaction
 *   does not wait for the transaction that holds the lock (the hang W3 warned about).
 * - **Connection failures say which connection** failed and where it points.
 * - **Schema metadata is loaded on the connection being handed out** — never through the pool,
 *   which a transaction may be holding.
 */
export function withBespokeDriver(dialect: Dialect, context: DriverContext): { dialect: Dialect; driver: BespokeDriver } {
  const adapter = dialect.createAdapter();
  const driver = new BespokeDriver(dialect.createDriver(), context, { single: adapter.supportsMultipleConnections === false });
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

export class BespokeDriver implements Driver {
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

  constructor(driver: Driver, context: DriverContext, options: { single?: boolean } = {}) {
    this.#driver = driver;
    this.#context = context;
    this.#single = options.single ?? false;
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
      connection = this.#pinned ?? (await this.#connecting(() => this.#driver.acquireConnection(options)));
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
    const connection = await this.#connecting(() => this.#driver.acquireConnection());
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

const savepoint = (depth: number) => `bespoke_savepoint_${depth}`;

/** The adapter as it is, but claiming several connections — so Kysely leaves the locking to {@link BespokeDriver}. */
function multipleConnections(adapter: DialectAdapter): DialectAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === 'supportsMultipleConnections') return true;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
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
