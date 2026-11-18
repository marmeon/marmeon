import type { EventEmitter } from 'node:events';
import { withCode } from '@marmeon/core/internal';
import type { MysqlPool, MysqlPoolConnection } from 'kysely';
import { DatabaseConnectionError } from './driver.ts';
import { mysqlServerProblem } from './mysql-server.ts';

/**
 * What every MySQL session of Marmeon runs with, as a set: strict, no zero dates, `||` concatenates and `"x"` is an identifier — the
 * same text means the same on every driver. `NO_BACKSLASH_ESCAPES` is left out on purpose: Kysely escapes a backslash in
 * a literal and in a JSON path, which that mode would store doubled. A value is never affected: it does not go into the statement text.
 */
export const SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,STRICT_ALL_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,PIPES_AS_CONCAT,ANSI_QUOTES';

/** The collation of every session: binary, so `'A' = 'a'` is false as it is on SQLite and Postgres. */
export const COLLATION = 'utf8mb4_0900_bin';

/** How long a connection may take to open, or to be waited for, when nothing says otherwise. */
export const CONNECT_TIMEOUT_MS = 10_000;

/** What a caller is told when no connection came within the connect timeout: the pool was full, or opening and setting one up took too long. */
export const NO_FREE_CONNECTION = 'no free connection within the connect timeout (the pool is full, or opening a connection took too long); raise poolMax or shorten transactions';

/** Most statements a lease keeps prepared on its connection (`mysql2` closes the least recently used one beyond it). */
export const MAX_PREPARED_STATEMENTS = 16;

/** `serverStatus` bit of an OK packet: the session has `NO_BACKSLASH_ESCAPES`. */
const STATUS_NO_BACKSLASH_ESCAPES = 0x200;

/** What a session is set up with: after the connection opens, and again after every `COM_RESET_CONNECTION`, which puts the server's defaults back. */
const SET_SESSION = `set names utf8mb4 collate ${COLLATION}, session sql_mode = '${SQL_MODE}', time_zone = '+00:00', session_track_schema = 1`;
const READ_VERSION = 'select @@version as version, @@version_comment as version_comment';
const READ_SESSION =
  'select @@version as version, @@version_comment as version_comment, @@session.sql_mode as sql_mode, @@session.time_zone as time_zone, ' +
  '@@collation_connection as collation, @@character_set_client as client, @@autocommit as autocommit, database() as db';

export interface GuardedPoolOptions {
  /** The connection's name, for the message of a refusal (default `default`). */
  name?: string;
  /** How long a caller waits for a connection, a new one opened and set up included (default {@link CONNECT_TIMEOUT_MS}; 0: no limit). */
  connectTimeoutMs?: number;
  /** An idle pooled connection failed. Without a listener `mysql2` emits an unhandled 'error' event the second time, which ends the process. */
  onIdleError?: (error: Error) => void;
  /** The most connections the pool beneath opens (its `connectionLimit`): callers beyond it wait here, in the order they came. */
  poolMax: number;
  /** How a `bigint` parameter is sent: as a typed 64-bit integer, unsigned when `unsigned` is set (`mysql2`'s `TypedParameter.LONGLONG`). */
  integer: (value: bigint, unsigned: boolean) => unknown;
}

type Parameters = readonly unknown[] | undefined;
type Callback = (error: unknown, result: unknown) => void;
type Query = (sql: string, parameters?: unknown, callback?: Callback) => unknown;

/**
 * What `typeCast` puts into a cell it cannot read (a `bigint` beyond 2^53): throwing there would end the command in the middle of its
 * result, with the rest of it still coming from the server. The guard looks for it in the answer and reports its error instead.
 */
export class CastFailure {
  readonly error: Error;
  constructor(error: Error) {
    this.error = error;
  }
}

/** What `mysql2` hands back for a prepared statement: the parameters the server counted, and a way to run it. */
interface Statement {
  parameters: readonly unknown[];
  execute: (values: unknown[], callback?: Callback) => unknown;
}

/** What `mysql2` hands back for a statement without a callback: asked for a stream. */
interface StreamQuery {
  stream: (options: unknown) => AsyncIterable<unknown>;
  on?: (event: 'fields' | 'result', listener: (...values: unknown[]) => void) => unknown;
}

/**
 * Wraps a `mysql2` pool so that every connection it hands out was checked first: on its first use the session is set up (UTF-8, the
 * binary collation, {@link SQL_MODE}, UTC) and read back, and a server that is not MySQL 8.4 or newer, or a session that did not take the
 * setting, is refused with D28 and destroyed. A statement with parameters is prepared on the server and executed with the values, so a
 * value is never part of the text MySQL parses, whatever the session's mode or character set; a statement without parameters goes over
 * the text protocol. The parameters are checked against the types SQLite accepts first. A connection goes back to the pool reset
 * (`COM_RESET_CONNECTION`), set up again and read in full. Inside a lease an answer that reports `NO_BACKSLASH_ESCAPES` or another client
 * character set than `utf8mb4` makes every later statement of the lease fail with D28, nothing sent: Kysely writes names and JSON paths
 * into the text. See `docs/database.md#mysql`.
 *
 * Statements are not queued here: the pool is reached only through `Connections`, whose connections run one statement at a time
 * (`serialQueries`), and `mysql2` queues the reset of the way back behind the last statement.
 */
export function guardedPool(pool: MysqlPool, options: GuardedPoolOptions): MysqlPool {
  const name = options.name ?? 'default';
  const timeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const prepared = new WeakSet<object>();
  const inUse = new WeakSet<object>();
  /** The database each connection was opened in, as the server reported it (a name's case may differ from the URL's): a `use` of the app must not carry over to the next caller. */
  const homes = new WeakMap<object, unknown>();
  /** The character set `mysql2` writes parameters in, as it was when the connection opened: the driver, not the server, decides it. */
  const charsets = new WeakMap<object, unknown>();
  /**
   * The callers wait for a connection here and not in `mysql2`'s queue, where a caller that timed out would stay and take a connection
   * nobody uses. A lease holds one of `poolMax` slots from the call of `getConnection` until the connection is back or gone; a slot goes to
   * the first caller that still waits, so `mysql2` always has a free connection or room for a new one when it is asked.
   */
  let leases = 0;
  const waiters: Array<{ grant: () => void; fail: (error: Error) => void }> = [];
  /** Set by `end()`: the callers that wait are refused, and so is every later one. */
  let closed = false;
  const closedError = () => new DatabaseConnectionError(withCode('D11', `The MySQL connection "${name}" is closed.`));
  /** How a lease gives its slot back, set when the connection is handed out; the way back calls it once the connection is back or destroyed. */
  const slots = new WeakMap<object, () => void>();

  const refuse = (raw: MysqlPoolConnection, reason: string): DatabaseConnectionError => {
    raw.destroy();
    return new DatabaseConnectionError(withCode('D28', `The MySQL connection "${name}" was refused: ${reason}`));
  };

  /** Sets the session up and checks it; the first use of a connection only. Resolves to the error that refuses it. */
  const setUp = async (raw: MysqlPoolConnection): Promise<unknown> => {
    if (prepared.has(raw)) return undefined;
    const query = (raw.query as unknown as Query).bind(raw);
    const run = (sql: string) => new Promise<unknown>((resolve, reject) => query(sql, [], (error, result) => (error ? reject(error) : resolve(result))));
    try {
      // The server first: MariaDB or MySQL 5.7 fail at the collation of the set-up, which must not hide as a connection error.
      const [server] = (await run(READ_VERSION)) as Record<string, unknown>[];
      const unsupported = serverProblem(server);
      if (unsupported !== undefined) return refuse(raw, unsupported);
      await run(SET_SESSION);
      const [row] = (await run(READ_SESSION)) as Record<string, unknown>[];
      const problem = sessionProblem(row);
      if (problem !== undefined) return refuse(raw, problem);
      homes.set(raw, row?.db ?? null);
      charsets.set(raw, (raw as unknown as { config?: { charsetNumber?: unknown } }).config?.charsetNumber);
    } catch (error) {
      raw.destroy();
      return error;
    }
    guard(raw, query);
    prepared.add(raw);
    return undefined;
  };

  /** Reads the session of a connection, as {@link setUp} did when it was new: `undefined` when it is still the one Marmeon sets, else why not. */
  const reread = async (raw: MysqlPoolConnection, query: Query): Promise<string | undefined> => {
    const rows = await new Promise<unknown>((resolve, reject) => query(READ_SESSION, [], (error, result) => (error ? reject(error) : resolve(result))));
    return sessionProblem((rows as Record<string, unknown>[])[0], homes.get(raw) as string | null);
  };

  /**
   * Puts the checks on a connection that passed: its parameters, its idle errors, and the session. A statement with parameters is
   * prepared (`COM_STMT_PREPARE`) and executed with the values (`COM_STMT_EXECUTE`), which the server never parses as SQL. The server
   * counts the placeholders with its own parser in the session's mode; when its count is not the number of values, nothing is executed
   * (a `?` inside a comment, a string or a `"name"` is not one). A statement MySQL cannot prepare runs only without parameters.
   * An answer that carries `NO_BACKSLASH_ESCAPES`, or names another client character set than `utf8mb4`, refuses every later statement
   * of the lease: the text Kysely writes (names, JSON paths) would be read another way. On release the connection is reset, set up again
   * and read in full, and only then goes back. See `docs/database.md#mysql`.
   */
  const guard = (raw: MysqlPoolConnection, query: Query) => {
    const prepare = (raw as unknown as { prepare: (sql: string, callback: (error: unknown, statement: Statement) => void) => unknown }).prepare.bind(raw);
    /** Why the session of this lease is no longer the one Marmeon set, as an answer told: set once, never cleared. */
    let changed: string | undefined;
    /** The refusal every statement after it gets: the connection was destroyed with it. */
    let refusal: DatabaseConnectionError | undefined;
    /** The statements prepared in this lease: `mysql2` keeps them per text, and the server parsed each one against the database of that time. */
    const kept = new Set<string>();
    /**
     * Notes a text as used just now. `kept` holds the texts of the 4 x {@link MAX_PREPARED_STATEMENTS} most recently used statements: `mysql2` keeps
     * only the 16 most recently used ones prepared, so those are always among them, and an `unprepare` of a text that `mysql2` dropped long ago does nothing.
     */
    const touch = (sql: string) => {
      kept.delete(sql);
      kept.add(sql);
      if (kept.size > 4 * MAX_PREPARED_STATEMENTS) kept.delete(kept.values().next().value as string);
    };
    const unprepare = (sql: string) => (raw as unknown as { unprepare: (sql: string) => unknown }).unprepare(sql);
    /** What an answer tells of the session. */
    const watch = (result: unknown) => {
      for (const packet of okPackets(result)) {
        // A `use` moves the names in a statement to another database, but a statement prepared before keeps reading the old one: prepare it anew.
        if (typeof packet.stateChanges?.schema === 'string') {
          try {
            for (const sql of kept) unprepare(sql);
            kept.clear();
          } catch {
            // The statement that moved the database was answered; the ones after it could read the old one, so they are refused.
            changed ??= 'the statements prepared before the change of database could not be dropped';
          }
        }
      }
      if (changed !== undefined) return;
      for (const packet of okPackets(result)) {
        if ((packet.serverStatus & STATUS_NO_BACKSLASH_ESCAPES) !== 0) {
          changed = "the session's sql_mode has NO_BACKSLASH_ESCAPES, which the statements of Marmeon are not written for";
          return;
        }
        const variables = packet.stateChanges?.systemVariables ?? {};
        for (const variable of ['character_set_client', 'character_set_connection']) {
          if (variable in variables && variables[variable] !== 'utf8mb4') {
            changed = `the session's ${variable} is ${JSON.stringify(String(variables[variable]))}, not "utf8mb4"`;
            return;
          }
        }
      }
    };
    /** The refusal for a statement that is about to go out, if the lease has changed its session. */
    const refused = (): DatabaseConnectionError | undefined => {
      if (refusal === undefined && changed !== undefined) refusal = refuse(raw, changed);
      return refusal;
    };
    const mismatch = (counted: number, given: number) =>
      new TypeError(`MySQL sees ${counted} placeholders in the statement and ${given} parameters were given; a ? inside a comment, a string or a "name" is not one.`);
    /** The statement as the server prepared it, when its placeholders are as many as the values. */
    const prepareFor = (sql: string, count: number) =>
      new Promise<Statement>((resolve, reject) =>
        prepare(sql, (error, statement) => {
          if (!error) touch(sql);
          if (error) reject(error);
          else if (statement.parameters.length !== count) reject(mismatch(statement.parameters.length, count));
          else resolve(statement);
        }),
      );
    /** One statement with an answer to call back. */
    const execute = (sql: string, values: unknown[], callback: Callback) => {
      const answer: Callback = (error, result) => {
        watch(result);
        const failure = error ? undefined : castFailure(result);
        if (failure) callback(failure, undefined);
        else callback(error, result);
      };
      if (values.length === 0) return void query(sql, [], answer);
      prepareFor(sql, values.length).then(
        (statement) => {
          try {
            statement.execute(values, answer);
          } catch (error) {
            callback(error, undefined);
          }
        },
        (error: unknown) => callback(error, undefined),
      );
    };
    /** One statement as a stream of rows: sent when the first row is asked for. */
    async function* stream(sql: string, values: unknown[], streamOptions: unknown): AsyncGenerator<unknown> {
      const stop = refused();
      if (stop) throw stop;
      const running = values.length === 0 ? (query(sql, []) as StreamQuery) : (await prepareFor(sql, values.length)).execute(values) as StreamQuery;
      // A statement without rows streams its OK packet as a 'result' that follows a 'fields' event without fields; a row follows one with
      // fields. That is how the two are told apart: no column of a select can look like a packet.
      let fields: unknown = [];
      running.on?.('fields', (columns) => void (fields = columns));
      running.on?.('result', (row) => {
        if (fields === undefined) watch(row);
      });
      for await (const row of running.stream(streamOptions)) {
        // A destroyed stream is drained by `mysql2`'s command: the statements after it work.
        const failure = castFailure([row]);
        if (failure) throw failure;
        yield row;
      }
    }
    (raw as { query: Query }).query = (sql, parameters, callback) => {
      const values = bind(parameters as Parameters, options.integer);
      if (callback === undefined) return { stream: (streamOptions: unknown) => stream(sql, values, streamOptions) };
      const stop = refused();
      if (stop) callback(stop, undefined);
      else execute(sql, values, callback);
      return undefined;
    };
    (raw as unknown as EventEmitter).on('error', (error: Error) => {
      // A connection in use hands its error to the query that runs on it.
      if (!inUse.has(raw)) options.onIdleError?.(error);
    });
    const release = raw.release.bind(raw);
    const reset = () => new Promise<void>((resolve, reject) => (raw as unknown as { reset: (callback: (error: unknown) => void) => void }).reset((error) => (error ? reject(error) : resolve())));
    raw.release = () => {
      inUse.delete(raw);
      // The reset of the way back closes them on the server and in `mysql2`.
      kept.clear();
      // The way back has a limit, which also covers the last statement of the lease: `mysql2` queues the reset behind it, and a server that
      // stops answering must not keep the connection out of the pool for good.
      let finished = false;
      const finish = (back: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (back) release();
        else if (refusal === undefined) raw.destroy();
        slots.get(raw)?.();
      };
      const timer = timeout > 0 ? setTimeout(() => finish(false), timeout) : undefined;
      // What the lease left on the connection (an open transaction, `lock tables`, `get_lock`, user variables, `sql_select_limit`,
      // `foreign_key_checks`, prepared statements) goes with COM_RESET_CONNECTION, which the server answers with its defaults; the session is
      // set up again and read in full. Only a connection that reads as Marmeon set it goes back, and any failure ends it.
      const unchanged = () => (raw as unknown as { config?: { charsetNumber?: unknown } }).config?.charsetNumber === charsets.get(raw);
      reset()
        .then(() => new Promise<void>((resolve, reject) => query(SET_SESSION, [], (error) => (error ? reject(error) : resolve()))))
        .then(() => reread(raw, query))
        .then(
          // A lease whose answers said the session changed does not go back, even when no statement came after: the next one would be refused.
          (problem) => finish(refusal === undefined && changed === undefined && problem === undefined && unchanged()),
          () => finish(false),
        );
    };
  };

  return {
    getConnection(callback) {
      let settled = false;
      let current: MysqlPoolConnection | undefined;
      let queued: { grant: () => void; fail: (error: Error) => void } | undefined;
      if (closed) return callback(closedError(), undefined as never);
      let held = false;
      /** Gives this caller's slot to the first one that waits; once. */
      const giveSlot = () => {
        if (!held) return;
        held = false;
        leases -= 1;
        waiters.shift()?.grant();
      };
      const timer =
        timeout > 0
          ? setTimeout(() => {
              settled = true;
              if (queued) waiters.splice(waiters.indexOf(queued), 1);
              // The slot is free from now on, also while `pool.getConnection` has not answered: a late connection is released at once, below, and
              // `mysql2`'s own limit still bounds the connections that exist.
              current?.destroy(); // set up for too long
              giveSlot();
              callback(new Error(NO_FREE_CONNECTION), undefined as never);
            }, timeout)
          : undefined;
      const connect = () => {
        queued = undefined;
        held = true;
        leases += 1;
        pool.getConnection((error, raw) => {
          if (settled) {
            // Too late: nobody waits for it any more, and its slot was given back when the caller timed out.
            if (!error) raw.release();
            return;
          }
          if (error) {
            clearTimeout(timer);
            settled = true;
            giveSlot();
            return callback(error, undefined as never);
          }
          current = raw;
          slots.set(raw, giveSlot);
          void setUp(raw).then((refused) => {
            if (settled) return;
            clearTimeout(timer);
            settled = true;
            if (refused !== undefined) {
              giveSlot();
              return callback(refused, undefined as never);
            }
            inUse.add(raw);
            callback(null, raw);
          });
        });
      };
      if (leases < options.poolMax) connect();
      else {
        waiters.push(
          (queued = {
            grant: connect,
            fail: (error) => {
              clearTimeout(timer);
              settled = true;
              queued = undefined;
              callback(error, undefined as never);
            },
          }),
        );
      }
    },
    end: (callback) => {
      closed = true;
      // The callers that wait here are not in the pool beneath: nobody else would answer them.
      const error = closedError();
      for (const waiter of waiters.splice(0)) waiter.fail(error);
      pool.end(callback);
    },
  };
}

/** Why the session is not the one Marmeon asked for, or `undefined`. `row` is what {@link READ_SESSION} returned. */
function sessionProblem(row: Record<string, unknown> | undefined, database?: string | null): string | undefined {
  if (row === undefined) return 'the server did not report its session';
  const text = (value: unknown) => (typeof value === 'string' ? value : String(value));
  const server = serverProblem(row);
  if (server !== undefined) return server;
  const wanted = new Set(SQL_MODE.split(','));
  const mode = new Set(text(row.sql_mode).split(',').filter(Boolean));
  if (mode.size !== wanted.size || [...wanted].some((flag) => !mode.has(flag))) {
    return `the session's sql_mode is ${JSON.stringify(text(row.sql_mode))}, not the one Marmeon sets (${SQL_MODE}); a server or proxy that rewrites it is not supported`;
  }
  if (text(row.time_zone) !== '+00:00') return `the session's time_zone is ${JSON.stringify(text(row.time_zone))}, not "+00:00"`;
  if (text(row.client) !== 'utf8mb4') return `the session's character_set_client is ${JSON.stringify(text(row.client))}, not "utf8mb4"`;
  if (text(row.collation) !== COLLATION) return `the session's collation is ${JSON.stringify(text(row.collation))}, not ${COLLATION}`;
  if (database !== undefined && (row.db ?? null) !== database) return `the session's database is ${JSON.stringify(row.db ?? null)}, not ${JSON.stringify(database)}`;
  if (Number(row.autocommit) !== 1) return 'the session does not autocommit, which the migrator and the pool rely on';
  return undefined;
}

/** Smallest and largest value of a MySQL `bigint` (signed) and `bigint unsigned`. */
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

/**
 * The parameters as they are sent to the server: SQLite's rules (null, string, finite number, bigint, boolean, `Date`, `Uint8Array`).
 * A `Date` becomes UTC text, which the session's time zone reads as stored. A `bigint` is handed to `integer`, which sends it as a typed
 * 64-bit integer (unsigned beyond 2^63 - 1), so it compares exactly and not as a double. `undefined` is no parameters.
 */
export function bind(parameters: Parameters, integer: (value: bigint, unsigned: boolean) => unknown): unknown[] {
  if (parameters === undefined) return [];
  return parameters.map((value, index) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') {
      if (value < INT64_MIN || value > UINT64_MAX) throw new TypeError(`MySQL cannot take parameter ${index + 1}: ${value} does not fit a bigint (-2^63 to 2^64-1).`);
      return integer(value, value > INT64_MAX);
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError(`MySQL cannot take parameter ${index + 1}: ${value} is not a finite number.`);
      return value;
    }
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError(`MySQL cannot take parameter ${index + 1}: Invalid Date.`);
      // `toISOString` writes a year outside 0 to 9999 with a sign and six digits, which a `datetime` cannot read.
      if (value.getUTCFullYear() < 0 || value.getUTCFullYear() > 9999) throw new TypeError(`MySQL cannot take parameter ${index + 1}: the year of a datetime is 0 to 9999.`);
      return value.toISOString().slice(0, 23).replace('T', ' ');
    }
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    const type = value === undefined ? 'undefined' : ((value as object).constructor?.name ?? typeof value);
    throw new TypeError(
      `MySQL cannot take parameter ${index + 1} of type ${type}. ` +
        'Pass a string, number, bigint, boolean, Date, Uint8Array or null (JSON: JSON.stringify it).',
    );
  });
}

/** The error of the first {@link CastFailure} among the rows of an answer, or of the result sets of a `call`; the command has read all of it by then. */
function castFailure(result: unknown): Error | undefined {
  if (!Array.isArray(result)) return undefined;
  for (const part of result) {
    if (Array.isArray(part)) {
      const nested = castFailure(part);
      if (nested) return nested;
    } else if (typeof part === 'object' && part !== null) {
      for (const cell of Object.values(part)) if (cell instanceof CastFailure) return cell.error;
    }
  }
  return undefined;
}

interface OkPacket {
  serverStatus: number;
  stateChanges?: { systemVariables?: Record<string, unknown>; schema?: unknown };
}

const isPacket = (value: unknown): value is OkPacket => typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as OkPacket).serverStatus === 'number';

/**
 * The OK packets of an answer. A statement without rows answers with the packet itself. One with several results (a `call`) answers with
 * an array that has an array of rows among its parts, and its packets are the other parts. The rows of a plain query are objects in an
 * array with no array among them: a column named `serverStatus` is no packet.
 */
function okPackets(result: unknown): OkPacket[] {
  if (isPacket(result)) return [result];
  return Array.isArray(result) && result.some((part) => Array.isArray(part)) ? result.filter(isPacket) : [];
}

/** Why the server is not a supported one, from its `@@version` and `@@version_comment`; its own string is quoted. */
function serverProblem(row: Record<string, unknown> | undefined): string | undefined {
  if (row === undefined) return 'the server did not report its version';
  const version = String(row.version);
  const problem = mysqlServerProblem(version, String(row.version_comment));
  return problem === undefined ? undefined : `${problem} (server ${JSON.stringify(version)})`;
}
