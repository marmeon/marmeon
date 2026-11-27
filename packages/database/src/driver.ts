import { TransactionError, TransactionFinishedError } from '@marmeon/core';
import { anyTransactionOf, leftTransactionOf, transactionOf, withCode, type TransactionFrame } from '@marmeon/core/internal';
import { CompiledQuery, isAbortedTransactionError, type DatabaseConnection, type Dialect, type DialectAdapter, type Driver, type QueryResult, type TransactionSettings } from 'kysely';
import { changesSchema, isRawSchemaChange, type SchemaMetadata } from './metadata.ts';
import { noteMysqlDuplicate } from './mysql-duplicates.ts';
import { transactionControls } from './mysql-transaction-control.ts';
import { PREFIX, SECRET } from './placeholders.ts';
import type { Driver as SqlDriver } from './schema/blueprint.ts';

/** A connection could not be opened — with the connection's name and where it points, never its password. */
export class DatabaseConnectionError extends Error {
  override name = 'DatabaseConnectionError';
}

/**
 * The error for a connection that could not be opened (D11), with the connection's name and target. A key or certificate file that
 * cannot be read says its path (`sslkey` of the URL): the path stays out of the message.
 */
export function connectionError(context: Pick<DriverContext, 'name' | 'target'>, error: unknown): DatabaseConnectionError {
  const reason =
    // pg-pool's wait for a free connection shares the connect timeout; opening a connection says "due to connection timeout".
    error instanceof Error && error.message === 'timeout exceeded when trying to connect'
      ? 'no free connection within the connect timeout; raise DB_POOL_MAX or shorten transactions'
      : isMysqlRefusal(error)
        ? `${error.code}: ${error.message}`
      : error instanceof Error && typeof (error as { path?: unknown }).path === 'string'
      ? `${(error as { code?: string }).code ?? 'error'}: a certificate or key file named in the URL (sslcert, sslkey, sslrootcert) could not be read`
      : error instanceof Error
        ? error.message || (error as { code?: string }).code || error.name
        : String(error);
  return new DatabaseConnectionError(withCode('D11', `Could not connect to the database connection "${context.name}" (${context.target}): ${reason}`), { cause: error });
}

/** The `mysql2` errors of a connection that reached the server and was turned away: its message names the account and the database, never the password. */
function isMysqlRefusal(error: unknown): error is Error & { code: string } {
  return error instanceof Error && ((error as { code?: unknown }).code === 'ER_ACCESS_DENIED_ERROR' || (error as { code?: unknown }).code === 'ER_BAD_DB_ERROR');
}

export interface DriverContext {
  /** The connection's name, e.g. `default`. */
  readonly name: string;
  /** The SQL dialect. Postgres aborts a transaction whose statement failed ({@link MarmeonDriver}). */
  readonly driver: SqlDriver;
  /** Where it points, for error messages: `sqlite storage/database.sqlite`, `pgsql postgres://marmeon:***@localhost/app`, `mysql mysql://marmeon:***@localhost:3306/app`. */
  readonly target: string;
  /** Refreshed on each connection handed out, while stale (see {@link SchemaMetadata}). */
  readonly metadata?: SchemaMetadata;
  /** Queries compiled before the metadata was fresh: resolved on the connection that runs them, after it loaded the metadata. */
  readonly deferred?: DeferredQueries;
  /** What the rows of a query get once it ran — the relations' nested values converted (`RelationsPlugin.convert`). */
  readonly results?: { convert(query: CompiledQuery, result: QueryResult<unknown>): void };
}

/** What the connection's plugins left unresolved while compiling (see `SchemaResolver`). */
export interface DeferredQueries {
  deferred(query: CompiledQuery): boolean;
  resolve(query: CompiledQuery): CompiledQuery;
}

/**
 * Wraps a dialect's driver with what every Marmeon connection needs: nested transactions become savepoints (so a test can
 * wrap everything in one, {@link MarmeonDriver.isolate}); inside `connections.transaction(callback)` every query of the
 * connection gets the transaction's connection, and work after it finished is refused ({@link TransactionFinishedError});
 * SQLite's one-connection lock lives here, so a query inside a transaction never waits for the transaction that holds it;
 * the queries of a shared connection take turns (`pg` must not get a query while another runs); a failure names the
 * connection; schema metadata is loaded on the connection being handed out, never through the pool a transaction may hold.
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
  /**
   * Postgres: the levels (of {@link #depth}) in which a statement failed on the server. Postgres aborts such a level, whatever the
   * code does with the error, so it cannot commit: see {@link MarmeonDriver.commitTransaction}.
   */
  readonly #tainted = new WeakMap<DatabaseConnection, Set<number>>();
  /**
   * Connections whose outermost transaction Postgres ended by answering the commit with a rollback. Kysely's rollback that follows
   * finds nothing left to undo and sends nothing; the entry goes with the next begin or release.
   */
  readonly #ended = new WeakSet<DatabaseConnection>();
  /** The depth of the connection when an ambient transaction began on it: what is open again once that transaction has ended. */
  readonly #bases = new WeakMap<TransactionFrame, number>();
  #init: Promise<void> | undefined;
  /** While isolated: the one connection every query uses, inside a transaction that is rolled back later. */
  #pinned: DatabaseConnection | undefined;
  /**
   * The pinned connections of isolations that have rolled back. Work still running after the rollback (a request that outlived
   * its test) releases the object it was given — the rollback has returned the pool's client already, and the pool may have
   * handed it to someone else since, so these releases are swallowed. Each isolation pins an object of its own for that.
   */
  readonly #retired = new WeakSet<DatabaseConnection>();
  /** The dialect has one physical connection (SQLite): one user at a time, by {@link #lock}. */
  readonly #single: boolean;
  readonly #lock = new ConnectionLock();
  /** While isolated on a dialect with several connections: ambient transactions take turns on the pinned connection. */
  readonly #turns = new ConnectionLock();
  /** Whether this isolation has told of transactions taking turns (once each: a test that races requests would repeat it for every one). */
  #warnedOfTurns = false;
  /**
   * Connections bound to an ambient transaction, with how many hold them: the transaction itself and each query
   * running inside it. The last release really releases (and unlocks) it.
   */
  readonly #holders = new Map<DatabaseConnection, number>();
  /** The outermost frame that began on the connection {@link #holders} counts: where every frame shares one connection (SQLite), whose holders those are. */
  readonly #holderOf = new Map<DatabaseConnection, TransactionFrame>();

  /** Which transaction frame opened which level (of {@link #depth}) on a connection: the frames the driver marks ended when that level ends. */
  readonly #frameLevels = new WeakMap<DatabaseConnection, Map<number, TransactionFrame>>();
  /** The frames whose level ended on the driver's side (a commit, rollback, release or rollback to savepoint was queued), and how. */
  readonly #frameEnds = new WeakMap<TransactionFrame, 'committed' | 'rolled back'>();
  /** How many acquisitions routed through a frame are out (its transaction and each query inside it): infrastructure work that merely shares the connection is not counted. */
  readonly #routed = new WeakMap<TransactionFrame, number>();
  /**
   * Connections that accept only the driver's end statements, and why. `end`: the outermost transaction queued its commit or rollback; lifted when that
   * end succeeds, kept after a failed commit until `rollback()` succeeds and, once the connection's release undid a transaction left open, until the connection is handed out again. A failed rollback of any kind becomes `failed`.
   * `retired`, `closed` and `failed` (an outermost rollback failed: the wrapper is dead and the raw connection gets a fresh one at its next hand-out): never
   * lifted. A frameless handle (the `trx` of Kysely's own transaction, or a `trx` used outside the callback's call chain) is sealed only while the end statement
   * runs; after the lift Kysely's own state check takes over, and statements already queued in Kysely can still go out. A savepoint's handle is never sealed.
   * Work started in the callback's own call chain is refused by its frame. One more exit: a `begin` at depth 0 on a connection whose commit ended in D24 (no
   * rollback yet) lifts the seal; only a direct driver call reaches it.
   */
  readonly #sealed = new WeakMap<DatabaseConnection, 'end' | 'retired' | 'closed' | 'failed'>();

  /** A pool that never joins an ambient transaction: an infrastructure connection's own pool. */
  readonly #detached: boolean;
  /**
   * Each connection of the dialect's driver as handed out here: its queries take turns ({@link serialQueries}). An
   * isolation pins a wrapper of its own that is not kept here; see `#retired`.
   */
  readonly #serial = new WeakMap<DatabaseConnection, DatabaseConnection>();
  /** A cached wrapper → the connection of the dialect's driver it wraps. */
  readonly #raw = new WeakMap<DatabaseConnection, DatabaseConnection>();

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
   * @internal — for infrastructure connections: a connection of its own, never the ambient transaction's (on a
   * shared physical connection, the caller has made sure no transaction of its call chain holds it).
   */
  acquireDetached(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    return this.#acquire(options);
  }

  /**
   * @internal — for the migrator and `db:show`: a connection of its own, handed out without loading the schema metadata, so they can
   * reach a database whose migrations this release refuses to answer queries for (`migrate` is what ends the refusal). Never
   * the ambient transaction's.
   */
  acquireUnchecked(options?: Parameters<Driver['acquireConnection']>[0]): Promise<DatabaseConnection> {
    return this.#acquire(options, false);
  }

  init(options?: Parameters<Driver['init']>[0]): Promise<void> {
    // A query after the shutdown would open a pool that nothing closes any more.
    if (this.#closed) return Promise.reject(this.#closedError());
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
    if (frame) this.#refuseEnded(frame);
    if (frame) return frame.resource === undefined ? this.#begin(frame, options) : this.#join(frame, frame.resource as DatabaseConnection);
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

  /** Work started in a transaction (or a savepoint around it) whose level ended on the driver's side is refused before it takes a connection: it would register at the next level and run in the transaction around the ended one. */
  #refuseEnded(frame: TransactionFrame): void {
    for (let current: TransactionFrame | undefined = frame; current; current = current.parent) {
      if (current.owner !== this) continue;
      const outcome = this.#frameEnds.get(current);
      if (outcome !== undefined) throw new TransactionFinishedError(current, current.open ? outcome : undefined);
    }
  }

  async releaseConnection(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    // Kysely releases in the async context it acquired in.
    const frame = anyTransactionOf(this);
    const routed = frame ? this.#routed.get(frame) : undefined;
    if (frame && routed) this.#routed.set(frame, routed - 1);
    return this.#release(connection, options);
  }

  /** @internal — releases a connection acquired by acquireDetached() or acquireUnchecked(): never routed through a frame, so no frame's count changes. */
  releaseDetached(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    return this.#release(connection, options);
  }

  async #release(connection: DatabaseConnection, options?: Parameters<Driver['releaseConnection']>[1]): Promise<void> {
    const holders = this.#holders.get(connection);
    if (holders !== undefined) {
      if (holders > 1) {
        this.#holders.set(connection, holders - 1);
        return;
      }
      this.#holders.delete(connection);
    }
    this.#holderOf.delete(connection);
    this.#ended.delete(connection);
    let leftOpen = false;
    try {
      // A transaction still recorded at the final release was left open (an error that made Kysely skip its rollback, a path nobody
      // thought of): undo it here, so the pool never hands it to the next request. A failed rollback leaves the discarding to the
      // dialect: pg's driver marks the client for discard; on MySQL the guarded pool's release runs COM_RESET_CONNECTION and destroys
      // the connection when that fails (mysql-session.ts); SQLite's rollback fails only on a closed handle. The connection is released either way.
      if (this.#depth.has(connection) && connection !== this.#pinned && !this.#retired.has(connection)) {
        this.#depth.delete(connection);
        this.#tainted.delete(connection);
        this.#context.metadata?.release(connection);
        let failed = false;
        leftOpen = true;
        // Whatever of this transaction still arrives is refused: before the rollback is queued, as at any end.
        this.#endFrames(connection, 1, 'rolled back');
        this.#sealed.set(connection, 'end');
        try {
          await this.#driver.rollbackTransaction(this.#controls(connection));
        } catch {
          // Nothing to add to the error that left the transaction open; the warning below says the rollback failed.
          failed = true;
          this.#kill(connection);
        }
        this.#warnLeftOpen(failed);
      }
      if (connection !== this.#pinned && !this.#retired.has(connection)) await this.#driver.releaseConnection(connection, options);
    } finally {
      if (this.#single) this.#lock.release();
    }
    // Whoever committed (or thought they did) did not commit: the transaction is undone, and the caller learns it.
    if (leftOpen) throw new TransactionError(withCode('D24', releasedOpen(this.#context.name)));
  }

  #warnLeftOpen(failed: boolean): void {
    process.emitWarning(
      `A transaction on "${this.#context.name}" was still open when its connection was released; Marmeon rolled it back` +
        (failed ? ' — the rollback failed; the driver discards or resets the connection' : ''),
      { type: 'MarmeonDatabaseWarning', code: 'MARMEON_TRANSACTION_LEFT_OPEN' },
    );
  }

  /**
   * @internal — called once an ambient transaction has ended (its commit or rollback ran, or failed). On a connection that is still inside
   * a transaction around it (a savepoint, or a test's isolated connection), only the levels that were open when it began may be open now.
   * More means a transaction inside it was never closed (Kysely skips the rollback of a transaction whose callback threw its own marker
   * error): its commit or rollback was taken for the one of an inner level, and this transaction's own savepoint is still open. That is
   * rolled back here, with everything above it, and a transaction that reported success throws D24 instead. The outermost transaction of
   * a connection is held to the same when a statement of its own still holds the connection, and otherwise at the release of the connection.
   */
  async closed(frame: TransactionFrame, completed: boolean): Promise<void> {
    const base = this.#bases.get(frame);
    const connection = frame.resource as DatabaseConnection | undefined;
    if (base === undefined || connection === undefined) return;
    if (base === 0) {
      // The outermost transaction of a connection is held to this when a statement of its own still holds the connection: the final release,
      // which the guard in releaseConnection() watches, has not come. Once it has, the connection may belong to someone else already. Where
      // frames share one connection (SQLite), only the frame whose holders these are may undo what is open on it.
      if (this.#holderOf.get(connection) !== frame || !this.#holders.has(connection) || !this.#depth.has(connection) || connection === this.#pinned) return;
      this.#depth.delete(connection);
      this.#tainted.delete(connection);
      this.#context.metadata?.release(connection);
      let failed = false;
      this.#endFrames(connection, 1, 'rolled back');
      this.#sealed.set(connection, 'end');
      try {
        await this.#driver.rollbackTransaction(this.#controls(connection));
        this.#lift(connection);
      } catch {
        // As at the release: the error of the caller (or D24) is what is told; the dialect's driver discards or resets the connection.
        failed = true;
        this.#kill(connection);
      }
      if (failed) this.#warnLeftOpen(true);
      if (completed) throw new TransactionError(withCode('D24', UNCLOSED_LEVEL));
      return;
    }
    const open = this.#depth.get(connection);
    if (open === undefined || open <= base) return;
    this.#depth.set(connection, base);
    this.#healed(connection, base + 1);
    this.#endFrames(connection, base + 1, 'rolled back');
    await connection.executeQuery(control(`rollback to savepoint ${savepoint(base)}`));
    await connection.executeQuery(control(`release savepoint ${savepoint(base)}`));
    this.#undone(connection);
    if (completed) throw new TransactionError(withCode('D24', UNCLOSED_LEVEL));
  }

  /**
   * @internal — runs an outermost ambient transaction. While isolated on a dialect with several connections (a test on
   * Postgres), concurrent transactions would share the pinned connection and interleave their savepoints — they take
   * turns instead. (On SQLite the connection lock already makes them.)
   */
  async exclusive<R>(transaction: () => Promise<R>): Promise<R> {
    if (!transactionOf(this) && leftTransactionOf(this) && (this.#single || this.#pinned)) {
      throw new TransactionError(
        `A transaction on "${this.#context.name}" cannot start inside outsideTransaction() while the transaction it stepped out of is open: ` +
          `the connection has a single physical connection (${this.#pinned ? "a test's isolated connection" : 'SQLite'}), which that transaction holds — ` +
          'this one would wait for it forever. Do it after the transaction instead (afterCommit() runs outside of it).',
      );
    }
    if (!this.#pinned || this.#single || transactionOf(this)) return transaction();
    if (this.#turns.busy && !this.#warnedOfTurns) {
      this.#warnedOfTurns = true;
      process.emitWarning(
        "Two requests' transactions took turns: under database: 'refresh' concurrent requests run one after another, so a missing lock still passes. " +
          "Test a lock with database: 'isolated' — docs/database-testing.md#testing-a-lock",
        { type: 'MarmeonDatabaseWarning', code: 'MARMEON_SERIAL_TRANSACTIONS' },
      );
    }
    await this.#turns.obtain();
    try {
      return await transaction();
    } finally {
      this.#turns.release();
    }
  }

  /** A connection of its own (locked on SQLite; the pinned one while isolated), with fresh schema metadata. */
  async #acquire(options?: Parameters<Driver['acquireConnection']>[0], checked = true): Promise<DatabaseConnection> {
    // After the shutdown the dialect's own error (no client, a closed file) would point at the configuration.
    if (this.#closed) throw this.#closedError();
    if (this.#single) await this.#lock.obtain();
    let connection: DatabaseConnection;
    try {
      // A request that waited for the lock while the application shut down gets the shutdown's message, not the closed file's.
      if (this.#closed) throw this.#closedError();
      connection = this.#pinned ?? this.#serialOf(await this.#connecting(() => this.#driver.acquireConnection(options)));
      if (connection !== this.#pinned) this.#sealed.delete(connection);
    } catch (error) {
      if (this.#single) this.#lock.release();
      throw error;
    }
    if (!checked) return connection;
    try {
      await this.#context.metadata?.refresh(unlogged(connection), connection);
    } catch (error) {
      await this.#release(connection);
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
      this.#bases.set(frame, this.#depth.get(outer.resource as DatabaseConnection) ?? 0);
      return this.#join(frame, outer.resource as DatabaseConnection);
    }
    const connection = await this.#acquire(options);
    frame.resource = connection;
    this.#bases.set(frame, this.#depth.get(connection) ?? 0);
    this.#routed.set(frame, (this.#routed.get(frame) ?? 0) + 1);
    // Isolated on a dialect with several connections, everyone shares the pinned one without a lock: nothing to count.
    if (this.#single || connection !== this.#pinned) {
      this.#holders.set(connection, 1);
      this.#holderOf.set(connection, frame);
    }
    return connection;
  }

  /** The transaction's connection, for a query (or a savepoint) inside it. */
  async #join(frame: TransactionFrame, connection: DatabaseConnection): Promise<DatabaseConnection> {
    // Taken before the wait: the refresh can resume after the transaction released the connection, and this query's own release would be a second one.
    const holders = this.#holders.get(connection);
    if (holders !== undefined) this.#holders.set(connection, holders + 1);
    this.#routed.set(frame, (this.#routed.get(frame) ?? 0) + 1);
    try {
      await this.#context.metadata?.refresh(unlogged(connection), connection);
      // The wait can outlast the transaction (or a savepoint around it): work that began before the end and arrives after it is refused here.
      this.#refuseEnded(frame);
    } catch (error) {
      // Kysely never releases after a failed acquire.
      this.#routed.set(frame, (this.#routed.get(frame) ?? 1) - 1);
      if (holders !== undefined) await this.#release(connection);
      throw error;
    }
    return connection;
  }

  /**
   * Runs every following query on one connection, inside a transaction — until `rollback()` undoes
   * all of it. Transactions the code opens meanwhile become savepoints. The basis of per-test
   * isolation. Concurrent transactions (two requests at once) share the one connection.
   */
  async isolate(): Promise<{ rollback(): Promise<void> }> {
    if (this.#pinned) throw new Error(`The database connection "${this.#context.name}" is already isolated.`);
    await this.init();
    const acquired = await this.#connecting(() => this.#driver.acquireConnection());
    // Not the cached one: this isolation's own object tells its late releases from those of whoever gets the client next.
    const connection = this.#serialOf(acquired, false);
    await this.#driver.beginTransaction(this.#beginControls(connection), {});
    this.#depth.set(connection, 1);
    this.#tainted.delete(connection);
    this.#pinned = connection;
    this.#warnedOfTurns = false;
    return {
      rollback: async () => {
        if (this.#pinned !== connection) return;
        this.#pinned = undefined;
        this.#retired.add(connection);
        this.#depth.delete(connection);
        this.#tainted.delete(connection);
        this.#context.metadata?.release(connection);
        // The retired wrapper is discarded, never unsealed: what outlived the test is refused instead of running on a client the pool may have handed on.
        this.#sealed.set(connection, 'retired');
        try {
          await this.#driver.rollbackTransaction(this.#controls(connection));
        } finally {
          await this.#driver.releaseConnection(acquired);
        }
      },
    };
  }

  async beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const depth = this.#depth.get(connection) ?? 0;
    // A transaction Postgres ended with its rollback answer is over, and a new one on the connection starts clean.
    if (depth === 0 && this.#ended.delete(connection)) this.#lift(connection);
    // Isolation level and access mode belong to the outermost transaction; a savepoint has neither.
    // SQLite upgrades a deferred transaction to a write lock at its first write — and fails at once with SQLITE_BUSY when another
    // connection (the worker, the scheduler) wrote in between. `begin immediate` takes the lock first and waits under the busy timeout.
    if (depth === 0 && this.#single && settings.accessMode !== 'read only') await connection.executeQuery(CompiledQuery.raw('begin immediate'));
    else if (depth === 0) await this.#driver.beginTransaction(this.#beginControls(connection), settings);
    else await connection.executeQuery(CompiledQuery.raw(`savepoint ${savepoint(depth)}`));
    this.#depth.set(connection, depth + 1);
    const frame = anyTransactionOf(this);
    if (frame?.open && frame.resource === connection) {
      let levels = this.#frameLevels.get(connection);
      if (!levels) this.#frameLevels.set(connection, (levels = new Map()));
      // One level per frame (the first), overwriting what a frame of an earlier run left on this level.
      if (![...levels.values()].includes(frame)) levels.set(depth + 1, frame);
    }
    this.#tainted.get(connection)?.delete(depth + 1);
  }

  /**
   * On Postgres a level in which a statement failed is aborted, whether or not the code caught the error: a `commit` would answer
   * with a rollback and `release savepoint` would fail or, worse, leave the transaction around it running in a state nobody
   * decided on. Such a level sends nothing and throws instead (D24); Kysely then rolls exactly this level back.
   * A statement that failed after the callback returned is met at the `release` of a savepoint (D24, Kysely rolls that level back) or
   * at the commit of the outermost transaction, which Postgres answers with a rollback: both throw D24. The outermost transaction's depth is
   * cleared here, a savepoint's is left for Kysely's rollback.
   */
  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const level = this.#depth.get(connection);
    if (level !== undefined && this.#tainted.get(connection)?.has(level)) throw new TransactionError(withCode('D24', ABORTED_TRANSACTION));
    const depth = this.#leave(connection);
    if (depth === 0) {
      try {
        await this.#driver.commitTransaction(this.#controls(connection));
        this.#lift(connection);
      } catch (error) {
        // Postgres answered the commit with a rollback: the transaction is over. Kysely's own error never leaves here: it makes Kysely skip the
        // rollback of any transaction whose callback it escapes from, which would leave the transaction of the other connection open. D24 is an ordinary
        // failure, and the rollback it brings is answered without sending anything.
        if (isAbortedTransactionError(error)) {
          this.#ended.add(connection);
          // What Postgres did was a rollback: late work is told so. The seal stays until Kysely's rollback, which sends nothing, lifts it.
          this.#endFrames(connection, 1, 'rolled back');
          throw new TransactionError(withCode('D24', LATE_FAILURE), { cause: error });
        }
        // The commit itself failed (a deferred constraint, a serialization failure): Kysely rolls back next, with the original error kept.
        this.#depth.set(connection, 1);
        throw error;
      } finally {
        this.#context.metadata?.release(connection);
      }
      return;
    }
    // A failing `release` taints the level below, which it did not abort before: only a level that was tainted already stays so.
    const outerTainted = this.#tainted.get(connection)?.has(depth) ?? false;
    try {
      await connection.executeQuery(control(`release savepoint ${savepoint(depth)}`));
    } catch (error) {
      // Kysely rolls this level back next.
      this.#depth.set(connection, depth + 1);
      if (!outerTainted) this.#tainted.get(connection)?.delete(depth);
      // 25P02: a statement started inside this level failed after the check above, and the `release` met the aborted transaction.
      if (isServerError(error) && (error as { code?: string }).code === '25P02') throw new TransactionError(withCode('D24', LATE_FAILURE), { cause: error });
      throw error;
    }
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    if (this.#ended.delete(connection)) {
      // The end that succeeded by sending nothing: the aborted commit was a rollback.
      this.#endFrames(connection, 1, 'rolled back');
      this.#lift(connection);
      return;
    }
    const level = this.#depth.get(connection);
    const depth = this.#leave(connection, 'rolled back');
    if (depth === 0) {
      this.#tainted.delete(connection);
      try {
        await this.#driver.rollbackTransaction(this.#controls(connection));
        this.#lift(connection);
      } catch (error) {
        this.#kill(connection);
        throw error;
      } finally {
        this.#context.metadata?.release(connection);
      }
    } else {
      await connection.executeQuery(control(`rollback to savepoint ${savepoint(depth)}`));
      this.#healed(connection, level!);
      this.#undone(connection);
    }
  }

  savepoint(...args: Parameters<NonNullable<Driver['savepoint']>>): Promise<void> {
    return this.#driver.savepoint!(...args);
  }

  async rollbackToSavepoint(...args: Parameters<NonNullable<Driver['rollbackToSavepoint']>>): Promise<void> {
    await this.#driver.rollbackToSavepoint!(...args);
    this.#undone(args[0]);
  }

  releaseSavepoint(...args: Parameters<NonNullable<Driver['releaseSavepoint']>>): Promise<void> {
    return this.#driver.releaseSavepoint!(...args);
  }

  /**
   * Closes the driver's pool, once, and only when it was initialised: a driver that never was has no pool to close, and from now on
   * `init()` refuses, so a late first query cannot open one. Kysely calls it when its own `destroy()` runs, and `Connections.destroy()`
   * calls it for every connection, since the migrator's, the inspection's and the infrastructure's Kysely instances and `isolate()`
   * initialise the driver without the app's `db`.
   */
  destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close(options).catch((error: unknown) => {
      this.#closing = undefined;
      throw error;
    });
    return this.#closing;
  }

  #closed = false;

  #closedError(): Error {
    return new Error(`The database connections are closed (the application shut down); cannot use "${this.#context.name}".`);
  }
  #closing: Promise<void> | undefined;

  async #close(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    if (this.#init === undefined) return;
    await this.#init.catch(() => undefined);
    // Closed while isolated (a test that closes its connections itself): its transaction is undone now, before the connection
    // goes — the isolation's rollback() finds nothing left to do instead of failing on a closed database.
    const pinned = this.#pinned;
    if (pinned) {
      this.#pinned = undefined;
      this.#depth.delete(pinned);
      this.#tainted.delete(pinned);
      this.#context.metadata?.release(pinned);
      this.#sealed.set(pinned, 'closed');
      try {
        await this.#driver.rollbackTransaction(this.#controls(pinned));
      } finally {
        await this.#driver.releaseConnection(pinned);
      }
    }
    return this.#driver.destroy(options);
  }

  /** Leaves one level and returns the level that remains (0 = the real transaction ends now). */
  #leave(connection: DatabaseConnection, outcome: 'committed' | 'rolled back' = 'committed'): number {
    const open = this.#depth.get(connection);
    if (open === undefined) throw new Error('No transaction is open on this connection — a commit or rollback without its begin.');
    // Synchronously, before the end statement is queued: a statement sent after this can never take its turn ahead of it.
    this.#endFrames(connection, open, outcome);
    const depth = open - 1;
    if (depth === 0) this.#sealed.set(connection, 'end');
    if (depth === 0) this.#depth.delete(connection);
    else this.#depth.set(connection, depth);
    return depth;
  }

  /** The outermost end succeeded: the connection takes statements again. */
  #lift(connection: DatabaseConnection): void {
    if (this.#sealed.get(connection) === 'end') this.#sealed.delete(connection);
  }

  /**
   * An outermost rollback failed: this wrapper never takes a statement again, and the raw connection gets a fresh wrapper at its next hand-out, so a handle
   * Kysely left active cannot reach a connection that is handed to someone else.
   */
  #kill(connection: DatabaseConnection): void {
    if (connection === this.#pinned) return;
    this.#sealed.set(connection, 'failed');
    const raw = this.#raw.get(connection);
    if (raw && this.#serial.get(raw) === connection) this.#serial.delete(raw);
  }

  /** The frames that opened level `open` or a level above it on `connection` are over: work of theirs that arrives from now on is refused. */
  #endFrames(connection: DatabaseConnection, open: number, outcome: 'committed' | 'rolled back'): void {
    for (const [level, frame] of this.#frameLevels.get(connection) ?? []) if (level >= open) this.#frameEnds.set(frame, outcome);
  }

  /** `rollback to savepoint` brought the transaction back from level `from` on: nothing in those levels is aborted any more. */
  #healed(connection: DatabaseConnection, from: number): void {
    const levels = this.#tainted.get(connection);
    if (!levels) return;
    for (const level of levels) if (level >= from) levels.delete(level);
  }

  #serialOf(connection: DatabaseConnection, cached = true): DatabaseConnection {
    let serial = cached ? this.#serial.get(connection) : undefined;
    if (!serial) {
      const { metadata, deferred, results } = this.#context;
      const hooks: SerialHooks = { name: this.#context.name };
      // A migration's transaction sees the schema as its plan has changed it so far (`SchemaMetadata.during`); everyone else the published one.
      const seen = <T>(work: () => T): T => (metadata ? metadata.as(serial!, work) : work());
      if (results) hooks.result = (query, result) => seen(() => results.convert(query, result));
      if (deferred) {
        hooks.deferred = (query) => deferred.deferred(query);
        hooks.resolve = async (query, own) => {
          await metadata?.settle(own, serial!, { limit: SCHEMA_CHANGE_WAIT_MS, name: this.#context.name });
          return seen(() => deferred.resolve(query));
        };
      }
      // The schema of a managed connection is the migrations', not the catalog's: a statement that changes the catalog changes nothing there.
      if (metadata && !metadata.managed) hooks.ran = (query) => this.#ran(serial!, query, metadata);
      if (this.#context.driver === 'mysql') hooks.refuse = (query) => this.#refuse(serial!, query);
      if (this.#context.driver === 'mysql' && metadata) hooks.failed = (error) => noteMysqlDuplicate(error, metadata);
      if (!this.#detached) hooks.admit = (query) => this.#admit(serial!, query);
      if (this.#context.driver === 'pgsql') {
        hooks.failed = (error) => this.#failed(serial!, error);
        hooks.passed = (query) => this.#passed(serial!, query);
      }
      serial = serialQueries(connection, hooks);
      if (cached) {
        this.#serial.set(connection, serial);
        this.#raw.set(serial, connection);
      }
    }
    return serial;
  }

  /**
   * The connection for the driver's own `commit` and `rollback`: they pass {@link #admit} by their object mark, and on MySQL they are also marked
   * for its guard, so it tells them from the app's SQL.
   */
  #controls(connection: DatabaseConnection): DatabaseConnection {
    return this.#context.driver === 'mysql' ? transactionControls(endStatements(connection)) : endStatements(connection);
  }

  /** The driver's own `begin` on MySQL is marked, so its guard tells it from the app's SQL; elsewhere the connection as it is. It ends nothing. */
  #beginControls(connection: DatabaseConnection): DatabaseConnection {
    return this.#context.driver === 'mysql' ? transactionControls(connection) : connection;
  }

  /** A statement sent after its transaction (or savepoint) queued its end: refused, never queued behind the end. */
  #admit(connection: DatabaseConnection, query: CompiledQuery): Error | undefined {
    if (ENDS.has(query)) return undefined;
    const frame = anyTransactionOf(this);
    if (frame?.resource === connection) {
      const outcome = this.#frameEnds.get(frame);
      // Routed through the frame (#begin, #join) and not released: not infrastructure work that shares the one connection.
      if (outcome !== undefined && this.#routed.get(frame)) return new TransactionFinishedError(frame, frame.open ? outcome : undefined);
    }
    const sealed = this.#sealed.get(connection);
    if (sealed) return new TransactionError(sealedMessage(sealed, this.#context.name));
    return undefined;
  }

  /** MySQL commits a transaction at a schema change, silently: inside one the builder refuses it, before anything is sent. A temporary table, made or dropped, is no schema change to it. */
  #refuse(connection: DatabaseConnection, query: CompiledQuery): Error | undefined {
    if ((this.#depth.get(connection) ?? 0) === 0 || !MYSQL_COMMITS.has(query.query.kind)) return undefined;
    if ((query.query.kind === 'CreateTableNode' || query.query.kind === 'DropTableNode') && (query.query as { temporary?: boolean }).temporary === true) return undefined;
    return new TransactionError(
      withCode(
        'D30',
        'MySQL commits a transaction at a schema change (create, alter or drop of a table, an index, a view or a schema), so this statement was not sent: it would end the transaction ' +
          'without an error and leave what follows outside of it. Make the schema change outside of transaction().',
      ),
    );
  }

  /** A statement failed on the server (pg's error with a SQLSTATE) inside a transaction: Postgres aborted the level it ran in. */
  #failed(connection: DatabaseConnection, error: unknown): void {
    const depth = this.#depth.get(connection);
    if (depth === undefined || !isServerError(error)) return;
    let levels = this.#tainted.get(connection);
    if (!levels) this.#tainted.set(connection, (levels = new Set()));
    levels.add(depth);
  }

  /** A `rollback to savepoint` Postgres accepted (written by hand, or by a repository bound with `using(trx)`) brings the level back from its abort. */
  #passed(connection: DatabaseConnection, query: CompiledQuery): void {
    const depth = this.#depth.get(connection);
    if (depth !== undefined && ROLLBACK_TO.test(query.sql)) this.#tainted.get(connection)?.delete(depth);
  }

  /**
   * Called around every statement on a connection: one that changed the schema makes the metadata stale — also after it
   * ran, since the connection loaded the metadata before it. Inside a transaction, what is loaded until it ends may be the
   * transaction's own uncommitted view: not fresh until then.
   */
  #ran(connection: DatabaseConnection, query: CompiledQuery, metadata: SchemaMetadata): void {
    // A savepoint rolled back by hand (`sql\`rollback to savepoint …\``, a repository bound with using(trx)). Postgres runs several
    // statements of SQL sent without parameters, so a `rollback` anywhere in any statement counts.
    if (metadata.holds(connection) && ROLLBACK.test(query.sql)) metadata.invalidate();
    if (!changesSchema(query.query) && !(query.query.kind === 'RawNode' && isRawSchemaChange(query.sql))) return;
    metadata.invalidate();
    if ((this.#depth.get(connection) ?? 0) > 0) metadata.hold(connection);
  }

  /**
   * A savepoint on `connection` was rolled back. Only when its transaction changed the schema may the loaded view hold what was
   * just undone — a plain rollback (a tryInsert() on a taken value) must not cost the next query a reload, which would take
   * measurably longer than the path where nothing was taken.
   */
  #undone(connection: DatabaseConnection): void {
    const { metadata } = this.#context;
    if (metadata?.holds(connection)) metadata.invalidate();
  }

  async #connecting<T>(open: () => Promise<T>): Promise<T> {
    try {
      return await open();
    } catch (error) {
      if (error instanceof DatabaseConnectionError) throw error;
      throw connectionError(this.#context, error);
    }
  }
}

/**
 * @internal — the driver of the connection the migrator and `db:show` work with: the same connections and transactions as
 * the app's, except that it does not load the schema metadata when it hands one out (see {@link MarmeonDriver.acquireUnchecked}).
 */
export class UncheckedDriver implements Driver {
  readonly #main: MarmeonDriver;
  readonly #report: ((event: { query: CompiledQuery; durationMs: number; error?: unknown }) => void) | undefined;
  /** The connection as handed to Kysely → the connection of the driver beneath. */
  readonly #real = new WeakMap<DatabaseConnection, DatabaseConnection>();

  constructor(main: MarmeonDriver, report?: (event: { query: CompiledQuery; durationMs: number; error?: unknown }) => void) {
    this.#main = main;
    this.#report = report;
  }

  init(): Promise<void> {
    return this.#main.init();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const real = await this.#main.acquireUnchecked();
    const plain = unlogged(real);
    const report = this.#report;
    // A view whose executeQuery reports what it ran: the shared connection itself may carry the app's Kysely log already.
    const view = new Proxy(real, {
      get(target, property) {
        if (property === 'executeQuery') {
          return async (query: CompiledQuery, ...rest: unknown[]) => {
            const started = performance.now();
            try {
              const result = await (plain.executeQuery as (...args: unknown[]) => Promise<QueryResult<unknown>>).call(plain, query, ...rest);
              report?.({ query, durationMs: performance.now() - started });
              return result;
            } catch (error) {
              report?.({ query, durationMs: performance.now() - started, error });
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.#real.set(view, real);
    return view;
  }

  beginTransaction(connection: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return this.#main.beginTransaction(this.#of(connection), settings);
  }

  commitTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#main.commitTransaction(this.#of(connection));
  }

  rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    return this.#main.rollbackTransaction(this.#of(connection));
  }

  releaseConnection(connection: DatabaseConnection): Promise<void> {
    return this.#main.releaseDetached(this.#of(connection));
  }

  #of(connection: DatabaseConnection): DatabaseConnection {
    return this.#real.get(connection) ?? connection;
  }

  async destroy(): Promise<void> {
    // The app's connection owns the pool and closes it.
  }
}

/** The error code of a failure the server reported: five characters of digits and capital letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;
const ROLLBACK_TO = /^\s*rollback\s+to\b/i;

/** An error the server sent (pg's `DatabaseError` has a `severity`), not a Node error such as `EPIPE` whose code looks alike. */
export function isServerError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof severity === 'string' && typeof code === 'string' && SQLSTATE.test(code);
}
const ABORTED_TRANSACTION =
  'A statement failed inside this transaction and its error was caught inside it. Postgres aborted the transaction (or its savepoint), so nothing in it was ' +
  'committed. Catch the error outside the nested transaction(), or use tryInsert().';
/** A level inside this transaction was left open: its rollback never ran. */
export const UNCLOSED_LEVEL =
  "A db.transaction() or db.startTransaction() opened inside this one was never closed, so Marmeon rolled this transaction back instead of committing it. " +
  'The usual cause: Kysely does not roll back a db.transaction() whose callback throws an AbortedTransactionError, even when the error is caught outside the callback. ' +
  'Wrap that error before it leaves the callback (new Error(message, { cause })), or open nested transactions with connections.transaction(), which does it for you.';

/** What the release of a connection with a transaction still open says: the release itself is where it was found. */
export const releasedOpen = (name: string): string =>
  `A transaction on "${name}" was still open when its connection was released, so Marmeon rolled it back. ` +
  'The usual cause: Kysely does not roll back a db.transaction() whose callback throws an AbortedTransactionError, even when the error is caught outside the callback. ' +
  'Wrap that error before it leaves the callback (new Error(message, { cause })), or use connections.transaction(), which does it for you.';

/**
 * Kysely does not roll back a transaction whose callback throws an error that carries its own marker for a commit the database
 * answered with a rollback. That error is carried past Kysely in a wrapper that does not carry the marker, and handed back to the caller
 * once the rollback has run.
 */
class ShieldedError extends Error {
  readonly original: unknown;

  constructor(original: unknown) {
    super('An error that Kysely would not roll back for.', { cause: original });
    this.original = original;
  }
}

/** @internal — runs a transaction callback so that an error with Kysely's marker still makes Kysely roll the transaction back; undo it with {@link unshielded}. */
export async function shielded<T>(callback: () => Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throw isAbortedTransactionError(error) ? new ShieldedError(error) : error;
  }
}

/** @internal — the error that {@link shielded} carried past Kysely, or the error itself. */
export function unshielded(error: unknown): unknown {
  return error instanceof ShieldedError ? error.original : error;
}

/** A statement started inside the callback and not awaited failed after the callback returned. Thrown for the outermost transaction and for a nested one. */
export const LATE_FAILURE =
  'A statement started inside this transaction failed after its callback returned, so Postgres rolled it back instead of committing it ' +
  '(a nested transaction: its savepoint, while the transaction around it goes on). Await every statement inside transaction() before the callback returns.';

/** The nodes of the builder that MySQL commits a transaction at: the ones that change the metadata, and views and schemas, which it does not reload for. */
const MYSQL_COMMITS: ReadonlySet<string> = new Set([
  'CreateTableNode', 'AlterTableNode', 'DropTableNode', 'CreateIndexNode', 'DropIndexNode', 'CreateViewNode', 'DropViewNode', 'CreateSchemaNode', 'DropSchemaNode',
]);

const savepoint = (depth: number) => `marmeon_savepoint_${depth}`;

/** The statements the driver sends to end a level: they pass {@link MarmeonDriver}'s check of what is sent after the end. Private, so app SQL cannot carry the mark. */
const ENDS = new WeakSet<CompiledQuery>();

/** A `release savepoint` or `rollback to savepoint` of the driver's own. */
function control(text: string): CompiledQuery {
  const query = CompiledQuery.raw(text);
  ENDS.add(query);
  return query;
}

/** The connection with every statement sent through it marked as one of the driver's end statements (Kysely's `commit` and `rollback`). */
function endStatements(connection: DatabaseConnection): DatabaseConnection {
  return new Proxy(connection, {
    get(target, property) {
      if (property === 'executeQuery') {
        return (query: CompiledQuery, ...rest: unknown[]) => {
          ENDS.add(query);
          return (target.executeQuery as (...args: unknown[]) => Promise<QueryResult<unknown>>).call(target, query, ...rest);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const sealedMessage = (kind: 'end' | 'retired' | 'closed' | 'failed', name: string): string =>
  kind === 'failed'
    ? `The rollback of the transaction on "${name}" failed, so this statement was not sent: the handle of that transaction is dead. Start a new transaction.`
    : kind === 'end'
    ? `The commit or rollback of the transaction on "${name}" was sent, so this statement was not sent. Await every statement of the transaction before commit() or rollback(). After a failed commit(), call rollback() on the transaction.`
    : kind === 'retired'
      ? `The test's database connection "${name}" was released when the test ended, so this statement was not sent. Await everything the test starts before it ends.`
      : `The database connections were closed (the application shut down), so this statement was not sent. "${name}" accepts no more statements.`;

/** A statement that may roll a savepoint back — a false alarm (the word in a string) costs one load, and only after a schema change. */
const ROLLBACK = /rollback/i;

/** How long a query that needs the schema metadata waits for another connection's open schema change to end, on a connection another tool manages (`managed: false`); managed connections do not wait. */
const SCHEMA_CHANGE_WAIT_MS = 10_000;

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

/** What a connection does around its queries, beside taking turns ({@link serialQueries}). */
export interface SerialHooks {
  /** Whether a query must be resolved before it runs (cheap: called for every query). */
  deferred?(query: CompiledQuery): boolean;
  /** Resolves it — `own` is the connection without Kysely's query log, for the metadata's own queries. */
  resolve?(query: CompiledQuery, own: DatabaseConnection): Promise<CompiledQuery>;
  /** Before and after a statement ran (or failed) on the connection. */
  ran?(query: CompiledQuery): void;
  /** A statement ran without an error. */
  passed?(query: CompiledQuery): void;
  /** A statement failed (before the error goes on to the caller). */
  failed?(error: unknown): void;
  /** Why a statement must not be sent, checked on its turn, before it runs or streams: the error it fails with instead. */
  refuse?(query: CompiledQuery): Error | undefined;
  /**
   * Why a statement must not be sent, asked when it is sent through the connection (not its unlogged view), in the sender's call chain, before it is
   * resolved and again right before it queues; unlike `refuse`, which is asked on its turn.
   */
  admit?(query: CompiledQuery): Error | undefined;
  /** The connection's name, for the message when a query holds placeholders nobody resolves. */
  name?: string;
  /** The rows of a query that ran (or of each chunk of a stream), with the query as it ran. */
  result?(query: CompiledQuery, result: QueryResult<unknown>): void;
}

/**
 * The connection without Kysely's query log around it — for the metadata's own catalog queries, which therefore never appear
 * in `onQuery()`, the log or devtools.
 */
const UNLOGGED = Symbol('unlogged');
function unlogged(connection: DatabaseConnection): DatabaseConnection {
  return (connection as unknown as Record<symbol, DatabaseConnection | undefined>)[UNLOGGED] ?? connection;
}

/**
 * The connection, but its queries take turns — in the order they were sent, a failed one passing the turn on. `pg` warns about a
 * query sent while another is under way ("client.query() when the client is already executing a query") and pg 9 refuses it. A
 * stream holds the turn until it ends. Everything else is the connection itself, bound to it (private fields, the driver's symbols).
 * What is set on the wrapper stays on it: Kysely puts its query log around `executeQuery` that way — around the turn, so the
 * connection's own method is never replaced underneath it. A query the `admit` hook refuses is rejected in the sender's call chain, before it is queued.
 */
export function serialQueries(connection: DatabaseConnection, hooks: SerialHooks = {}): DatabaseConnection {
  type Execute = (query: CompiledQuery, ...rest: unknown[]) => Promise<QueryResult<unknown>>;
  type Stream = (query: CompiledQuery, ...rest: unknown[]) => AsyncIterableIterator<QueryResult<unknown>>;
  const execute = connection.executeQuery.bind(connection) as Execute;
  const stream = connection.streamQuery.bind(connection) as Stream;
  const own = new Map<PropertyKey, unknown>();
  const { ran, failed, passed, refuse, admit } = hooks;
  const checked: Execute = refuse
    ? (query, ...rest) => {
        const refusal = refuse(query);
        return refusal ? Promise.reject(refusal) : execute(query, ...rest);
      }
    : execute;
  const run: Execute =
    ran || failed || passed
      ? async (query, ...rest) => {
          ran?.(query);
          try {
            const result = await checked(query, ...rest);
            passed?.(query);
            return result;
          } catch (error) {
            failed?.(error);
            throw error;
          } finally {
            ran?.(query);
          }
        }
      : checked;
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
  const turned: Execute = (query, ...rest) => turn(() => run(query, ...rest));
  async function* turnedStream(query: CompiledQuery, ...rest: unknown[]): AsyncIterableIterator<QueryResult<unknown>> {
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    await new Promise<void>((started) =>
      void turn(() => {
        started();
        return finished;
      }),
    );
    try {
      const refusal = refuse?.(query);
      if (refusal) throw refusal;
      yield* stream(query, ...rest);
    } catch (error) {
      failed?.(error);
      throw error;
    } finally {
      done();
    }
  }
  // A statement sent after its transaction ended is refused in the sender's call chain, before it is queued behind the end.
  const admitted: Execute = admit
    ? (query, ...rest) => {
        const refusal = admit(query);
        return refusal ? Promise.reject(refusal) : turned(query, ...rest);
      }
    : turned;
  async function* admittedStream(query: CompiledQuery, ...rest: unknown[]): AsyncIterableIterator<QueryResult<unknown>> {
    const refusal = admit?.(query);
    if (refusal) throw refusal;
    yield* turnedStream(query, ...rest);
  }
  // Resolved before it takes its turn: loading the metadata takes turns on this connection too. A query with nothing to
  // resolve is queued at once, so queries keep the order they were sent in.
  const unloggedView = { executeQuery: turned, streamQuery: turnedStream } as unknown as DatabaseConnection;
  const resolving = (query: CompiledQuery) => {
    if (hooks.deferred?.(query)) return hooks.resolve!(query, unloggedView);
    // Built on a Kysely without Marmeon's plugins (or compiled by one): nothing resolved its placeholders.
    if (query.sql.includes(PREFIX)) return Promise.reject(new Error(unresolved(hooks.name ?? 'default', query.sql.includes(SECRET))));
    return undefined;
  };
  // Kysely's query log wraps the connection's executeQuery and streamQuery after this proxy exists, and the wrapper is resolved again
  // (see `set` below), so one result passes the hook twice. A conversion that is not idempotent (JSON text → value) must run once.
  const converted = new WeakSet<object>();
  const after = hooks.result
    ? (query: CompiledQuery, result: QueryResult<unknown>) => {
        if (converted.has(result)) return;
        converted.add(result);
        hooks.result!(query, result);
      }
    : undefined;
  const finished = (inner: Execute): Execute =>
    after ? (query, ...rest) => inner(query, ...rest).then((result) => (after(query, result), result)) : inner;
  const resolvedExecute = (logged: Execute): Execute => {
    const inner = finished(logged);
    return (query, ...rest) => {
      const refusal = admit?.(query);
      if (refusal) return Promise.reject(refusal);
      const pending = resolving(query);
      return pending ? pending.then((resolved) => inner(resolved, ...rest)) : inner(query, ...rest);
    };
  };
  const resolvedStream = (inner: Stream): Stream =>
    async function* (query, ...rest) {
      const refusal = admit?.(query);
      if (refusal) throw refusal;
      const resolved = (await resolving(query)) ?? query;
      for await (const chunk of inner(resolved, ...rest)) {
        after?.(resolved, chunk);
        yield chunk;
      }
    };
  const executeQuery = resolvedExecute(admitted);
  const streamQuery = resolvedStream(admittedStream);
  return new Proxy(connection, {
    get(target, property) {
      if (property === UNLOGGED) return unloggedView;
      if (own.has(property)) return own.get(property);
      if (property === 'executeQuery') return executeQuery;
      if (property === 'streamQuery') return streamQuery;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_target, property, value) {
      // Kysely puts its query log around executeQuery and streamQuery this way: resolve outside it, so it logs what ran.
      if (property === 'executeQuery' && typeof value === 'function') own.set(property, resolvedExecute(value as Execute));
      else if (property === 'streamQuery' && typeof value === 'function') own.set(property, resolvedStream(value as Stream));
      else own.set(property, value);
      return true;
    },
  });
}

function unresolved(name: string, secret: boolean): string {
  if (secret) {
    return (
      `This query reads a column with secret(), which only the app's connection checks — it was not sent: it runs on the database ` +
      `connection "${name}" without Marmeon's plugins (infrastructure(), withoutPlugins()), which check no column. Name the column ` +
      'there as it is, or build the query on connections.get() or Database. See docs/migrations.md#secret-columns.'
    );
  }
  return (
    "This query loads, counts or filters by relations, leaves out soft-deleted rows or touches a row's timestamps (with(), withCount(), " +
    "whereHas(), withRelation(), withTrashed(), a repository's query(), update() or delete()), which " +
    `only the app's connection resolves — it was not sent: it runs on the database connection "${name}" without Marmeon's plugins ` +
    '(infrastructure(), withoutPlugins()). Build it on connections.get() or Database. See docs/queries.md#relations.'
  );
}

/** One user of a single-connection dialect at a time (Kysely's `ConnectionMutex`). */
class ConnectionLock {
  #held: Promise<void> | undefined;
  #release: (() => void) | undefined;

  /** Whether someone holds the lock, so that the next {@link obtain} waits. */
  get busy(): boolean {
    return this.#held !== undefined;
  }

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
