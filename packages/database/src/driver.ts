import { CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type TransactionSettings } from 'kysely';

/** A connection could not be opened — with the connection's name and where it points, never its password. */
export class DatabaseConnectionError extends Error {
  override name = 'DatabaseConnectionError';
}

export interface DriverContext {
  /** The connection's name, e.g. `default`. */
  readonly name: string;
  /** Where it points, for error messages: `sqlite storage/database.sqlite`, `pgsql postgres://bespoke:***@localhost/app`. */
  readonly target: string;
}

/**
 * Wraps a dialect's driver with what every BespokeCore connection needs:
 *
 * - **Nested transactions become savepoints.** When a connection is already inside a transaction,
 *   beginning another one starts a savepoint instead (commit → release, rollback → rollback to it) —
 *   Laravel's transaction level. That is what lets a test wrap everything in one transaction
 *   ({@link BespokeDriver.isolate}) while the code under test opens its own.
 * - **Connection failures say which connection** failed and where it points.
 */
export function withBespokeDriver(dialect: Dialect, context: DriverContext): { dialect: Dialect; driver: BespokeDriver } {
  const driver = new BespokeDriver(dialect.createDriver(), context);
  return {
    driver,
    dialect: {
      createAdapter: () => dialect.createAdapter(),
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

  constructor(driver: Driver, context: DriverContext) {
    this.#driver = driver;
    this.#context = context;
  }

  init(options?: Parameters<Driver['init']>[0]): Promise<void> {
    // Once: Kysely inits lazily on the first query, `isolate()` may need it earlier.
    this.#init ??= this.#connecting(() => this.#driver.init(options)).catch((error: unknown) => {
      this.#init = undefined;
      throw error;
    });
    return this.#init;
  }

  acquireConnection(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    if (this.#pinned) return Promise.resolve(this.#pinned);
    return this.#connecting(() => this.#driver.acquireConnection(options));
  }

  releaseConnection(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    if (connection === this.#pinned) return Promise.resolve();
    return this.#driver.releaseConnection(connection, options);
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
