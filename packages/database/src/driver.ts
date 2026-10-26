import { TransactionError, type TransactionFrame } from '@marmeon/core';
import { leftTransactionOf, transactionOf, withCode } from '@marmeon/core/internal';
import { CompiledQuery, type DatabaseConnection, type Dialect, type DialectAdapter, type Driver, type QueryResult, type TransactionSettings } from 'kysely';
import { changesSchema, isRawSchemaChange, type SchemaMetadata } from './metadata.ts';
import { PREFIX, SECRET } from './placeholders.ts';

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
      : error instanceof Error && typeof (error as { path?: unknown }).path === 'string'
      ? `${(error as { code?: string }).code ?? 'error'}: a certificate or key file named in the URL (sslcert, sslkey, sslrootcert) could not be read`
      : error instanceof Error
        ? error.message || (error as { code?: string }).code || error.name
        : String(error);
  return new DatabaseConnectionError(withCode('D11', `Could not connect to the database connection "${context.name}" (${context.target}): ${reason}`), { cause: error });
}

export interface DriverContext {
  /** The connection's name, e.g. `default`. */
  readonly name: string;
  /** Where it points, for error messages: `sqlite storage/database.sqlite`, `pgsql postgres://marmeon:***@localhost/app`. */
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

  /** A pool that never joins an ambient transaction: an infrastructure connection's own pool. */
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
  async #acquire(options?: Parameters<Driver['acquireConnection']>[0], checked = true): Promise<DatabaseConnection> {
    if (this.#single) await this.#lock.obtain();
    let connection: DatabaseConnection;
    try {
      connection = this.#pinned ?? this.#serialOf(await this.#connecting(() => this.#driver.acquireConnection(options)));
    } catch (error) {
      if (this.#single) this.#lock.release();
      throw error;
    }
    if (!checked) return connection;
    try {
      await this.#context.metadata?.refresh(unlogged(connection), connection);
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
    await this.#context.metadata?.refresh(unlogged(connection), connection);
    // Counted once it is handed out (a failed refresh is never released).
    const holders = this.#holders.get(connection);
    if (holders !== undefined) this.#holders.set(connection, holders + 1);
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
    const connection = this.#serialOf(await this.#connecting(() => this.#driver.acquireConnection()));
    await this.#driver.beginTransaction(connection, {});
    this.#depth.set(connection, 1);
    this.#pinned = connection;
    return {
      rollback: async () => {
        if (this.#pinned !== connection) return;
        this.#pinned = undefined;
        this.#depth.delete(connection);
        this.#context.metadata?.release(connection);
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
    // SQLite upgrades a deferred transaction to a write lock at its first write — and fails at once with SQLITE_BUSY when another
    // connection (the worker, the scheduler) wrote in between. `begin immediate` takes the lock first and waits under the busy timeout.
    if (depth === 0 && this.#single && settings.accessMode !== 'read only') await connection.executeQuery(CompiledQuery.raw('begin immediate'));
    else if (depth === 0) await this.#driver.beginTransaction(connection, settings);
    else await connection.executeQuery(CompiledQuery.raw(`savepoint ${savepoint(depth)}`));
    this.#depth.set(connection, depth + 1);
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    const depth = this.#leave(connection);
    if (depth === 0) {
      try {
        await this.#driver.commitTransaction(connection);
      } finally {
        this.#context.metadata?.release(connection);
      }
    } else await connection.executeQuery(CompiledQuery.raw(`release savepoint ${savepoint(depth)}`));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    const depth = this.#leave(connection);
    if (depth === 0) {
      try {
        await this.#driver.rollbackTransaction(connection);
      } finally {
        this.#context.metadata?.release(connection);
      }
    } else {
      await connection.executeQuery(CompiledQuery.raw(`rollback to savepoint ${savepoint(depth)}`));
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

  async destroy(options?: Parameters<Driver['destroy']>[0]): Promise<void> {
    // Closed while isolated (a test that closes its connections itself): its transaction is undone now, before the connection
    // goes — the isolation's rollback() finds nothing left to do instead of failing on a closed database.
    const pinned = this.#pinned;
    if (pinned) {
      this.#pinned = undefined;
      this.#depth.delete(pinned);
      this.#context.metadata?.release(pinned);
      try {
        await this.#driver.rollbackTransaction(pinned);
      } finally {
        await this.#driver.releaseConnection(pinned);
      }
    }
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
      this.#serial.set(connection, (serial = serialQueries(connection, hooks)));
    }
    return serial;
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
    return this.#main.releaseConnection(this.#of(connection));
  }

  #of(connection: DatabaseConnection): DatabaseConnection {
    return this.#real.get(connection) ?? connection;
  }

  async destroy(): Promise<void> {
    // The app's connection owns the pool and closes it.
  }
}

const savepoint = (depth: number) => `marmeon_savepoint_${depth}`;
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
 * connection's own method is never replaced underneath it.
 */
export function serialQueries(connection: DatabaseConnection, hooks: SerialHooks = {}): DatabaseConnection {
  type Execute = (query: CompiledQuery, ...rest: unknown[]) => Promise<QueryResult<unknown>>;
  type Stream = (query: CompiledQuery, ...rest: unknown[]) => AsyncIterableIterator<QueryResult<unknown>>;
  const execute = connection.executeQuery.bind(connection) as Execute;
  const stream = connection.streamQuery.bind(connection) as Stream;
  const own = new Map<PropertyKey, unknown>();
  const { ran } = hooks;
  const run: Execute = ran
    ? async (query, ...rest) => {
        ran(query);
        try {
          return await execute(query, ...rest);
        } finally {
          ran(query);
        }
      }
    : execute;
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
      yield* stream(query, ...rest);
    } finally {
      done();
    }
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
  const { result: after } = hooks;
  const finished = (inner: Execute): Execute =>
    after ? (query, ...rest) => inner(query, ...rest).then((result) => (after(query, result), result)) : inner;
  const resolvedExecute = (logged: Execute): Execute => {
    const inner = finished(logged);
    return (query, ...rest) => {
      const pending = resolving(query);
      return pending ? pending.then((resolved) => inner(resolved, ...rest)) : inner(query, ...rest);
    };
  };
  const resolvedStream = (inner: Stream): Stream =>
    async function* (query, ...rest) {
      const resolved = (await resolving(query)) ?? query;
      for await (const chunk of inner(resolved, ...rest)) {
        after?.(resolved, chunk);
        yield chunk;
      }
    };
  const executeQuery = resolvedExecute(turned);
  const streamQuery = resolvedStream(turnedStream);
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
