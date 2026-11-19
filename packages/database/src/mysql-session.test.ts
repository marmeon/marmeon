import { EventEmitter } from 'node:events';
import type { MysqlPool, MysqlPoolConnection } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnectionError } from './driver.ts';
import { bind, CastFailure, COLLATION, guardedPool, NO_FREE_CONNECTION, SQL_MODE } from './mysql-session.ts';

/** What `mysql2` answers an insert, a `set` or a `begin` with: it is told from a row by its class. */
class ResultSetHeader {
  readonly serverStatus: number;
  readonly affectedRows = 0;
  readonly stateChanges?: { systemVariables: Record<string, string>; schema?: string };
  constructor(serverStatus: number, systemVariables?: Record<string, string>, schema?: string) {
    this.serverStatus = serverStatus;
    if (systemVariables || schema) this.stateChanges = { systemVariables: systemVariables ?? {}, ...(schema ? { schema } : {}) };
  }
}
const ok = (status: number, systemVariables?: Record<string, string>, schema?: string) => new ResultSetHeader(status, systemVariables, schema);

const SESSION = { version: '8.4.3', version_comment: 'MySQL Community Server - GPL', sql_mode: SQL_MODE, time_zone: '+00:00', collation: COLLATION, client: 'utf8mb4', autocommit: 1, db: 'app' };

/** How the tests send a `bigint`: the real one is a typed LONGLONG of `mysql2`. */
const integer = (value: bigint, unsigned: boolean) => ({ integer: value, unsigned });

type Answer = { change?: Record<string, unknown>; result?: unknown; error?: Error; hold?: boolean };

/** A pooled connection that answers like a server: the three statements of the setup, and whatever `answers` says for others. */
function stubConnection(session: Record<string, unknown> = SESSION) {
  const sent: string[] = [];
  const base = { ...session };
  const raw = Object.assign(new EventEmitter(), {
    /** The statements that went over the text protocol, and the reset. */
    sent,
    /** The statements that were prepared, and what was executed with which values. */
    prepared: [] as string[],
    executed: [] as Array<{ sql: string; values: unknown[] }>,
    /** How many placeholders the server counts in a statement, when not the number of `?`. */
    placeholders: undefined as number | undefined,
    prepareError: undefined as Error | undefined,
    /** The statements `unprepare` was called for. */
    unprepared: [] as string[],
    unprepare(sql: string) {
      raw.unprepared.push(sql);
    },
    session: { ...session } as Record<string, unknown>,
    /** What an OK packet says: a statement of the app can answer with its own. */
    answers: new Map<RegExp, Answer>(),
    /** Answers that wait: the server has the statement, the client has not heard yet. */
    held: [] as Array<() => void>,
    destroy: vi.fn(),
    release: vi.fn(),
    /** COM_RESET_CONNECTION: the server's defaults come back, which the session set-up then replaces. */
    resetError: undefined as Error | undefined,
    reset(callback: (error: unknown) => void) {
      sent.push('reset');
      callback(raw.resetError ?? null);
    },
    /** What `mysql2` returns without a callback: something to ask for a stream of rows. */
    running(rows: unknown[]) {
      const events = new EventEmitter();
      return Object.assign(events, {
        // What `mysql2` emits: a statement without rows gives its OK packet as a 'result' after 'fields' without fields.
        stream: () =>
          (async function* () {
            for (const row of rows) {
              events.emit('fields', row instanceof ResultSetHeader ? undefined : []);
              events.emit('result', row);
              yield row;
            }
          })(),
      });
    },
    answer(sql: string, callback: ((error: unknown, result: unknown) => void) | undefined, rows: unknown[] = [{ row: 1 }]) {
      for (const [pattern, answer] of raw.answers) {
        if (!pattern.test(sql)) continue;
        Object.assign(raw.session, answer.change);
        if (callback && answer.hold) return void raw.held.push(() => callback(answer.error ?? null, answer.result));
        if (!callback) return raw.running(answer.error ? [] : answer.result === undefined ? rows : [answer.result]);
        return callback(answer.error ?? null, answer.result);
      }
      if (!callback) return raw.running(rows);
      callback(null, sql.startsWith('select @@version') ? (Object.keys(raw.session).length === 0 ? [] : [raw.session]) : {});
    },
    query(sql: string, _parameters: unknown, callback?: (error: unknown, result: unknown) => void) {
      sent.push(sql);
      // The set-up puts everything but the database back (a reset does not change the database).
      if (sql.startsWith('set names utf8mb4') && Object.keys(base).length > 0) raw.session = { ...base, db: raw.session.db };
      return raw.answer(sql, callback);
    },
    /** COM_STMT_PREPARE: the statement knows how many placeholders the server counted. */
    prepare(sql: string, callback: (error: unknown, statement?: unknown) => void) {
      raw.prepared.push(sql);
      if (raw.prepareError) return callback(raw.prepareError);
      const count = raw.placeholders ?? sql.split('?').length - 1;
      callback(null, {
        parameters: Array.from({ length: count }),
        execute: (values: unknown[], executed?: (error: unknown, result: unknown) => void) => {
          raw.executed.push({ sql, values });
          return raw.answer(sql, executed);
        },
      });
    },
  });
  return raw;
}
function stubPool(...connections: ReturnType<typeof stubConnection>[]): MysqlPool & { ended: boolean } {
  const queue = [...connections];
  const pool = {
    ended: false,
    getConnection: (callback: (error: unknown, connection: MysqlPoolConnection) => void) => callback(null, queue.shift() as unknown as MysqlPoolConnection),
    end: (callback: (error: unknown) => void) => {
      pool.ended = true;
      callback(null);
    },
  };
  return pool;
}

/** What Kysely does with a statement it streams: ask for `stream()` and read it to the end. */
const drain = async (query: unknown) => {
  const rows: unknown[] = [];
  for await (const row of (query as { stream: () => AsyncIterable<unknown> }).stream()) rows.push(row);
  return rows;
};

const acquire = (pool: MysqlPool, options?: Partial<Parameters<typeof guardedPool>[1]>) =>
  new Promise<{ error: unknown; connection: MysqlPoolConnection | undefined }>((resolve) => guardedPool(pool, { integer, poolMax: 10, ...options }).getConnection((error, connection) => resolve({ error, connection })));

afterEach(() => vi.useRealTimers());

describe('a connection the pool hands out', () => {
  it('has its session set up and read back first, once, and then answers queries', async () => {
    const raw = stubConnection();
    const { error, connection } = await acquire(stubPool(raw));
    expect(error).toBeNull();
    expect(raw.sent).toEqual([
      // The server's version first, then the set-up, then the full reading.
      expect.stringMatching(/^select @@version as version, @@version_comment as version_comment$/),
      `set names utf8mb4 collate ${COLLATION}, session sql_mode = '${SQL_MODE}', time_zone = '+00:00', session_track_schema = 1`,
      expect.stringMatching(/^select @@version as version, @@version_comment/),
    ]);
    connection!.query('select 1', [], () => {});
    expect(raw.sent.at(-1)).toBe('select 1');
  });

  it('is set up once, however often the pool hands it out', async () => {
    const raw = stubConnection();
    const guarded = guardedPool(stubPool(raw, raw, raw), { integer, poolMax: 10 });
    for (let round = 0; round < 3; round += 1) {
      await new Promise<void>((resolve, reject) => guarded.getConnection((error) => (error ? reject(error) : resolve())));
    }
    expect(raw.sent.filter((sql) => sql.startsWith('set names'))).toHaveLength(1);
  });

  it('is refused with D28 and destroyed when the session did not take the sql_mode — a server that adds NO_BACKSLASH_ESCAPES', async () => {
    const raw = stubConnection({ ...SESSION, sql_mode: `${SQL_MODE},NO_BACKSLASH_ESCAPES` });
    const { error, connection } = await acquire(stubPool(raw), { name: 'reporting' });
    expect(connection).toBeUndefined();
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D28\] The MySQL connection "reporting" was refused: the session's sql_mode is "[^"]*NO_BACKSLASH_ESCAPES"/);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(raw.release).not.toHaveBeenCalled();
  });

  it('is refused when a mode of the set is missing, whatever else the server added', async () => {
    const raw = stubConnection({ ...SESSION, sql_mode: SQL_MODE.replace('ANSI_QUOTES', 'ALLOW_INVALID_DATES') });
    expect(((await acquire(stubPool(raw))).error as Error).message).toContain("the session's sql_mode");
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('is accepted when the server reports the modes in another order', async () => {
    const raw = stubConnection({ ...SESSION, sql_mode: SQL_MODE.split(',').toReversed().join(',') });
    expect((await acquire(stubPool(raw))).error).toBeNull();
  });

  it.each([
    ['MariaDB', { version: '11.4.2-MariaDB', version_comment: 'mariadb.org binary distribution' }, 'the server is MariaDB'],
    ['a MySQL older than 8.4', { version: '8.0.39', version_comment: 'MySQL Community Server - GPL' }, 'older than 8.4'],
    ['a server of an unknown form', { version: 'quoted "\n8.4.0', version_comment: '' }, 'unknown version form "quoted \\"\\n8.4.0"'],
    ['a time zone other than UTC', { time_zone: 'SYSTEM' }, 'time_zone is "SYSTEM"'],
    ['another collation', { collation: 'utf8mb4_general_ci' }, 'collation is "utf8mb4_general_ci"'],
    ['a session without autocommit', { autocommit: 0 }, 'does not autocommit'],
  ])('is refused with D28 for %s', async (_name, change, reason) => {
    const raw = stubConnection({ ...SESSION, ...change });
    const { error } = await acquire(stubPool(raw));
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D28\] /);
    expect((error as Error).message).toContain(reason);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('says the server’s own string only quoted, so a newline in it cannot forge a log line', async () => {
    const raw = stubConnection({ ...SESSION, version: '11.4.2-MariaDB\n[marmeon:D1] forged' });
    const { error } = await acquire(stubPool(raw));
    expect((error as Error).message).not.toContain('\n');
  });

  it('names MariaDB with D28 before it fails at the collation of the set-up: the version is read first, and nothing else is sent', async () => {
    const raw = stubConnection({ ...SESSION, version: '11.4.2-MariaDB', version_comment: 'mariadb.org binary distribution' });
    raw.answers.set(/^set names utf8mb4/, { error: Object.assign(new Error("Unknown collation: 'utf8mb4_0900_bin'"), { code: 'ER_UNKNOWN_COLLATION' }) });
    const { error } = await acquire(stubPool(raw));
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toMatch(/^\[marmeon:D28\] .*the server is MariaDB/);
    expect(raw.sent).toEqual([expect.stringMatching(/^select @@version as version, @@version_comment as version_comment$/)]);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('is refused when the server reports no session at all', async () => {
    const raw = stubConnection({});
    const { error } = await acquire(stubPool(raw));
    expect((error as Error).message).toMatch(/^\[marmeon:D28\] .*the server did not report its version/);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('is destroyed and its error passed on when a statement of the setup fails', async () => {
    const raw = stubConnection();
    const failure = Object.assign(new Error('Access denied'), { code: 'ER_SPECIFIC_ACCESS_DENIED_ERROR' });
    raw.query = (_sql: string, _parameters: unknown, callback?: (error: unknown, result: unknown) => void) => callback?.(failure, undefined);
    const { error } = await acquire(stubPool(raw));
    expect(error).toBe(failure);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('the parameters of a query', () => {
  const open = async () => {
    const raw = stubConnection();
    const { connection } = await acquire(stubPool(raw));
    raw.sent.length = 0;
    return { raw, connection: connection! };
  };
  const run = (connection: MysqlPoolConnection, sql: string, parameters: unknown[]) =>
    new Promise<{ error: unknown; result: unknown }>((resolve) => connection.query(sql, parameters, (error, result) => resolve({ error, result })));

  it('go to the server with a prepare and an execute, and the text protocol is not used for a statement that has them', async () => {
    const { raw, connection } = await open();
    const { error } = await run(connection, 'select * from users where id = ? and name = ?', [7, "x' or 1=1 -- \\"]);
    expect(error).toBeNull();
    expect(raw.prepared).toEqual(['select * from users where id = ? and name = ?']);
    expect(raw.executed).toEqual([{ sql: 'select * from users where id = ? and name = ?', values: [7, "x' or 1=1 -- \\"] }]);
    expect(raw.sent).toEqual([]);
  });

  it('are not needed for the text protocol: a statement without any is sent as it is, and nothing is prepared', async () => {
    const { raw, connection } = await open();
    await run(connection, 'select 1', []);
    expect(raw.sent).toEqual(['select 1']);
    expect(raw.prepared).toEqual([]);
    expect(raw.executed).toEqual([]);
  });

  it('go the same way for a stream: prepared with parameters, text without', async () => {
    const { raw, connection } = await open();
    expect(await drain(connection.query('select ?', [1]))).toEqual([{ row: 1 }]);
    expect(raw.prepared).toEqual(['select ?']);
    expect(raw.executed).toEqual([{ sql: 'select ?', values: [1] }]);
    expect(raw.sent).toEqual([]);
    expect(await drain(connection.query('select 2', []))).toEqual([{ row: 1 }]);
    expect(raw.sent).toEqual(['select 2']);
    expect(raw.prepared).toEqual(['select ?']);
  });

  it('are not run when the server counts other placeholders than there are values — a ? in a comment, a string or a name is none', async () => {
    const { raw, connection } = await open();
    raw.placeholders = 1;
    const { error } = await run(connection, 'select "a?b" from t where id = ?', [1, 2]);
    expect(error).toEqual(new TypeError('MySQL sees 1 placeholders in the statement and 2 parameters were given; a ? inside a comment, a string or a "name" is not one.'));
    expect(raw.executed).toEqual([]);
    expect(raw.sent).toEqual([]);
    // the same for a stream
    await expect(drain(connection.query('select "a?b" from t where id = ?', [1, 2]))).rejects.toThrow('MySQL sees 1 placeholders in the statement and 2 parameters were given');
    expect(raw.executed).toEqual([]);
  });

  it('are not run either when the server counts more placeholders than there are values', async () => {
    const { raw, connection } = await open();
    raw.placeholders = 3;
    const { error } = await run(connection, 'select ?, ?, ?', [1, 2]);
    expect((error as Error).message).toMatch(/^MySQL sees 3 placeholders in the statement and 2 parameters were given/);
    expect(raw.executed).toEqual([]);
  });

  it('pass the server’s error for a statement it cannot prepare on, and do not fall back to the text protocol', async () => {
    const { raw, connection } = await open();
    const failure = Object.assign(new Error('This command is not supported in the prepared statement protocol yet'), { code: 'ER_UNSUPPORTED_PS' });
    raw.prepareError = failure;
    expect((await run(connection, 'handler t read first where id = ?', [1])).error).toBe(failure);
    await expect(drain(connection.query('lock tables t write, u read where ?', [1]))).rejects.toBe(failure);
    expect(raw.sent).toEqual([]);
    expect(raw.executed).toEqual([]);
  });

  it('throw before anything is sent when SQLite would refuse them: an object, an array, undefined', async () => {
    const { raw, connection } = await open();
    expect(() => connection.query('update users set name = ?', [{ name: 'x', is_admin: 1 }])).toThrow(/^MySQL cannot take parameter 1 of type Object/);
    expect(() => connection.query('select * from users where id in (?)', [[1, 2]])).toThrow('parameter 1 of type Array');
    expect(() => connection.query('select ?, ?', [1, undefined])).toThrow('parameter 2 of type undefined');
    expect(() => connection.query('select ?', [Symbol('x')])).toThrow('parameter 1 of type');
    expect(raw.sent).toEqual([]);
    expect(raw.prepared).toEqual([]);
  });

  it('are checked for a statement without a callback too — the streaming path', async () => {
    const { raw, connection } = await open();
    expect(() => connection.query('select ?', [{ a: 1 }])).toThrow(TypeError);
    expect(raw.sent).toEqual([]);
    expect(raw.prepared).toEqual([]);
  });

  it('are sent as bind gives them: a bigint through `integer`, a Date as UTC text, bytes as a Buffer', async () => {
    const { raw, connection } = await open();
    await run(connection, 'select ?, ?, ?', [2n ** 64n - 1n, new Date('2026-10-01T12:34:56.789Z'), new Uint8Array([1, 2])]);
    expect(raw.executed[0]!.values).toEqual([{ integer: 2n ** 64n - 1n, unsigned: true }, '2026-10-01 12:34:56.789', Buffer.from([1, 2])]);
  });
});

describe('a cell that typeCast could not read', () => {
  const failure = new RangeError('bigint value 9007199254740993 does not fit a JavaScript number; cast it to text in the query.');
  const open = async () => {
    const raw = stubConnection();
    const { connection } = await acquire(stubPool(raw));
    return { raw, connection: connection! };
  };
  const run = (connection: MysqlPoolConnection, sql: string, parameters: unknown[] = []) =>
    new Promise<{ error: unknown; result: unknown }>((resolve) => connection.query(sql, parameters, (error, result) => resolve({ error, result })));

  it('is reported as the error of the statement once its result is there, for either protocol — and not a row of it', async () => {
    const { raw, connection } = await open();
    raw.answers.set(/^select/, { result: [{ id: 1 }, { id: new CastFailure(failure) }, { id: 3 }] });
    expect(await run(connection, 'select id from t')).toEqual({ error: failure, result: undefined });
    expect(await run(connection, 'select id from t where id > ?', [0])).toEqual({ error: failure, result: undefined });
  });

  it('is found in the result sets of a call too', async () => {
    const { raw, connection } = await open();
    raw.answers.set(/^call/, { result: [[{ a: 1 }], [{ b: new CastFailure(failure) }], ok(2)] });
    expect((await run(connection, 'call two()')).error).toBe(failure);
  });

  it('leaves an answer without one as it is', async () => {
    const { raw, connection } = await open();
    const rows = [{ id: 1 }, { id: null }, { id: 'text' }];
    raw.answers.set(/^select/, { result: rows });
    expect(await run(connection, 'select id from t')).toEqual({ error: null, result: rows });
  });

  it('ends a stream with its error at the row, after the rows before it, and the next statement is sent as usual', async () => {
    const { raw, connection } = await open();
    const cells = [{ id: 1 }, { id: new CastFailure(failure) }, { id: 3 }];
    raw.running = () => Object.assign(new EventEmitter(), { stream: () => (async function* () { yield* cells; })() });
    const rows: unknown[] = [];
    await expect(
      (async () => {
        for await (const row of (connection.query('select id from t', []) as unknown as { stream: () => AsyncIterable<unknown> }).stream()) rows.push(row);
      })(),
    ).rejects.toBe(failure);
    expect(rows).toEqual([{ id: 1 }]);
    expect((await run(connection, 'select 2')).error).toBeNull();
  });
});

describe('bind', () => {
  it('passes null, strings, finite numbers and booleans as they are, and no parameters as an empty list', () => {
    expect(bind([null, 'a', 1.5, true, false], integer)).toEqual([null, 'a', 1.5, true, false]);
    expect(bind(undefined, integer)).toEqual([]);
    expect(bind([], integer)).toEqual([]);
  });

  it('hands a bigint to `integer`, unsigned beyond 2^63 - 1, and refuses one outside -2^63 to 2^64 - 1', () => {
    expect(bind([2n ** 63n - 1n, -(2n ** 63n), 0n], integer)).toEqual([
      { integer: 2n ** 63n - 1n, unsigned: false },
      { integer: -(2n ** 63n), unsigned: false },
      { integer: 0n, unsigned: false },
    ]);
    expect(bind([2n ** 63n, 2n ** 64n - 1n], integer)).toEqual([
      { integer: 2n ** 63n, unsigned: true },
      { integer: 2n ** 64n - 1n, unsigned: true },
    ]);
    expect(() => bind([1, 2n ** 64n], integer)).toThrow(new TypeError('MySQL cannot take parameter 2: 18446744073709551616 does not fit a bigint (-2^63 to 2^64-1).'));
    expect(() => bind([-(2n ** 63n) - 1n], integer)).toThrow('does not fit a bigint');
  });

  it('refuses a number that is not finite', () => {
    expect(() => bind([Number.NaN], integer)).toThrow('parameter 1: NaN is not a finite number');
    expect(() => bind([1, Number.NEGATIVE_INFINITY], integer)).toThrow('parameter 2');
  });

  it('writes a Date as UTC text to the millisecond, and refuses an Invalid Date', () => {
    expect(bind([new Date('2026-10-01T12:34:56.789Z')], integer)).toEqual(['2026-10-01 12:34:56.789']);
    expect(bind([new Date('2026-10-01T12:34:56Z')], integer)).toEqual(['2026-10-01 12:34:56.000']);
    expect(() => bind([new Date(Number.NaN)], integer)).toThrow('Invalid Date');
    expect(() => bind([new Date('+010000-01-01T00:00:00Z')], integer)).toThrow('the year of a datetime is 0 to 9999');
  });

  it('hands binary data over as a Buffer, whatever view of it was given', () => {
    const bytes = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4);
    const [value] = bind([bytes], integer) as [Buffer];
    expect(Buffer.isBuffer(value)).toBe(true);
    expect([...value]).toEqual([1, 2, 3]);
  });
});

describe('waiting for a connection', () => {
  it('fails after the connect timeout with the text of a full pool, and releases a connection that arrives later at once, giving its slot back', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    let deliver: (() => void) | undefined;
    const pool: MysqlPool = {
      getConnection: (callback) => {
        deliver = () => callback(null, raw as unknown as MysqlPoolConnection);
      },
      end: (callback) => callback(null),
    };
    const guarded = guardedPool(pool, { integer, poolMax: 1, connectTimeoutMs: 500 });
    const first = new Promise<unknown>((resolve) => guarded.getConnection((error) => resolve(error)));
    await vi.advanceTimersByTimeAsync(499);
    deliver ??= () => {};
    await vi.advanceTimersByTimeAsync(2);
    expect(((await first) as Error).message).toBe(NO_FREE_CONNECTION);
    // The slot was given back at the timeout, though the pool never answered: the next caller asks it again.
    const asked = vi.fn();
    const late = deliver!;
    pool.getConnection = (callback) => void asked(callback);
    guarded.getConnection(() => {});
    expect(asked).toHaveBeenCalledTimes(1);
    // The late connection is released at once and changes nothing about the slots: a third caller still waits for the second.
    late();
    expect(raw.release).toHaveBeenCalledTimes(1);
    expect(raw.sent).toEqual([]);
    guarded.getConnection(() => {});
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('gives up on a connection whose setup never answers, and destroys it', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    raw.query = () => {}; // a server that accepted the handshake and says nothing
    const result = acquire(stubPool(raw), { connectTimeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(501);
    expect(((await result).error as Error).message).toBe(NO_FREE_CONNECTION);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('has no limit with a timeout of 0', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    let deliver: (() => void) | undefined;
    const pool: MysqlPool = { getConnection: (callback) => void (deliver = () => callback(null, raw as unknown as MysqlPoolConnection)), end: (callback) => callback(null) };
    const result = acquire(pool, { connectTimeoutMs: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    deliver!();
    expect((await result).error).toBeNull();
  });

  it('passes the pool’s own error on', async () => {
    const failure = new Error('connect ECONNREFUSED');
    const pool: MysqlPool = { getConnection: (callback) => callback(failure, undefined as never), end: (callback) => callback(null) };
    expect((await acquire(pool)).error).toBe(failure);
  });
});

describe('waiting for a slot', () => {
  /** A pool that hands out the connections it is given, and counts how often it was asked. */
  const countingPool = (...connections: ReturnType<typeof stubConnection>[]) => {
    const queue = [...connections];
    const pool = Object.assign(stubPool(), {
      asked: 0,
      getConnection: (callback: (error: unknown, connection: MysqlPoolConnection) => void) => {
        pool.asked += 1;
        callback(null, queue.shift() as unknown as MysqlPoolConnection);
      },
    });
    return pool;
  };
  const request = (guarded: MysqlPool) => {
    const outcome = { connection: undefined as MysqlPoolConnection | undefined, error: undefined as unknown, done: false };
    guarded.getConnection((error, connection) => Object.assign(outcome, { error, connection, done: true }));
    return outcome;
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it('asks the pool only for as many connections as there are slots: a caller beyond them waits, and takes the slot of a lease that ended', async () => {
    const first = stubConnection();
    const second = stubConnection();
    const pool = countingPool(first, second);
    const guarded = guardedPool(pool, { integer, poolMax: 1 });
    const one = request(guarded);
    const two = request(guarded);
    await settle();
    expect(pool.asked).toBe(1);
    expect(one.done).toBe(true);
    expect(two.done).toBe(false);
    one.connection!.release();
    await settle();
    expect(pool.asked).toBe(2);
    expect(two.connection).toBe(second);
  });

  it('serves the callers in the order they came', async () => {
    const connections = [stubConnection(), stubConnection(), stubConnection(), stubConnection()];
    const pool = countingPool(...connections);
    const guarded = guardedPool(pool, { integer, poolMax: 1 });
    const order: number[] = [];
    const callers = [0, 1, 2, 3].map((index) => {
      const outcome = request(guarded);
      return { index, outcome };
    });
    for (let round = 0; round < 4; round += 1) {
      await settle();
      const now = callers.filter(({ outcome }) => outcome.connection !== undefined && !order.includes(callers.find((caller) => caller.outcome === outcome)!.index));
      expect(now.map(({ index }) => index)).toEqual([round]);
      order.push(now[0]!.index);
      now[0]!.outcome.connection!.release();
    }
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('forgets a caller that timed out: its place is not taken by a connection nobody uses, and the next live caller gets the slot', async () => {
    vi.useFakeTimers();
    const held = stubConnection();
    const third = stubConnection();
    const pool = countingPool(held, third);
    const guarded = guardedPool(pool, { integer, poolMax: 1, connectTimeoutMs: 500 });
    const holder = request(guarded);
    await vi.advanceTimersByTimeAsync(1);
    expect(holder.done).toBe(true);
    const gone = [request(guarded), request(guarded), request(guarded)];
    // A fourth comes later, with a timer of its own.
    await vi.advanceTimersByTimeAsync(300);
    const live = request(guarded);
    await vi.advanceTimersByTimeAsync(250);
    for (const caller of gone) expect((caller.error as Error).message).toBe(NO_FREE_CONNECTION);
    expect(live.done).toBe(false);
    // The lease ends: the pool is asked once more, for the caller that still waits and for no other.
    holder.connection!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(pool.asked).toBe(2);
    expect(live.connection).toBe(third);
    // Nothing is left behind: the next release asks nobody.
    live.connection!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(pool.asked).toBe(2);
  });

  it('answers the callers that wait when the pool is ended — their timers gone, even with no limit — and refuses every later caller at once', async () => {
    vi.useFakeTimers();
    const pool = countingPool(stubConnection(), stubConnection());
    for (const connectTimeoutMs of [500, 0]) {
      const guarded = guardedPool(pool, { integer, poolMax: 1, connectTimeoutMs, name: 'reporting' });
      const holder = request(guarded);
      const waiting = request(guarded);
      await vi.advanceTimersByTimeAsync(1);
      expect(holder.done).toBe(true);
      expect(waiting.done).toBe(false);
      await new Promise<void>((resolve) => guarded.end(() => resolve()));
      expect(waiting.error).toBeInstanceOf(DatabaseConnectionError);
      expect((waiting.error as Error).message).toBe('[marmeon:D11] The MySQL connection "reporting" is closed.');
      const later = request(guarded);
      expect(later.done).toBe(true);
      expect((later.error as Error).message).toMatch(/^\[marmeon:D11\] .*is closed/);
      const asked = pool.asked;
      holder.connection!.release();
      await vi.advanceTimersByTimeAsync(1000);
      expect(pool.asked).toBe(asked); // no one is served from the abandoned queue, and no timer fires for the waiter
    }
  });

  it('frees the slot of a connection refused with D28, and of one that failed to open', async () => {
    const refused = stubConnection({ ...SESSION, version: '11.4.2-MariaDB', version_comment: 'mariadb.org binary distribution' });
    const good = stubConnection();
    const failing = { asked: 0 };
    const queue: Array<{ error?: Error; connection?: ReturnType<typeof stubConnection> }> = [{ connection: refused }, { error: new Error('connect ECONNREFUSED') }, { connection: good }];
    const pool: MysqlPool = {
      getConnection: (callback) => {
        failing.asked += 1;
        const next = queue.shift()!;
        callback(next.error ?? null, next.connection as unknown as MysqlPoolConnection);
      },
      end: (callback) => callback(null),
    };
    const guarded = guardedPool(pool, { integer, poolMax: 1 });
    const one = request(guarded);
    const two = request(guarded);
    const three = request(guarded);
    await settle();
    expect(one.error).toBeInstanceOf(DatabaseConnectionError);
    expect((two.error as Error).message).toBe('connect ECONNREFUSED');
    expect(three.connection).toBe(good);
    expect(failing.asked).toBe(3);
  });

  it('frees the slot of a lease that ends destroyed, and of one whose set-up never answered', async () => {
    vi.useFakeTimers();
    const silent = stubConnection();
    silent.query = () => {};
    const dying = stubConnection();
    dying.resetError = new Error('reset refused');
    const good = stubConnection();
    const pool = countingPool(silent, dying, good);
    const guarded = guardedPool(pool, { integer, poolMax: 1, connectTimeoutMs: 500 });
    const one = request(guarded);
    await vi.advanceTimersByTimeAsync(100);
    const two = request(guarded);
    await vi.advanceTimersByTimeAsync(401);
    expect((one.error as Error).message).toBe(NO_FREE_CONNECTION);
    expect(silent.destroy).toHaveBeenCalledTimes(1);
    // The slot of the first went to the second, which waited for it.
    expect(pool.asked).toBe(2);
    expect(two.connection).toBe(dying);
    const three = request(guarded);
    await vi.advanceTimersByTimeAsync(1);
    expect(three.done).toBe(false);
    two.connection!.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(dying.destroy).toHaveBeenCalledTimes(1);
    expect(three.connection).toBe(good);
  });
});

describe('an idle connection', () => {
  it('reports its error to onIdleError instead of ending the process, but not while a query has it', async () => {
    const raw = stubConnection();
    const released = raw.release;
    const idle: Error[] = [];
    const { connection } = await acquire(stubPool(raw), { onIdleError: (error) => idle.push(error) });
    // In use: the query that runs on it gets the error.
    raw.emit('error', new Error('in use'));
    expect(idle).toEqual([]);
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve)); // the session is read before the connection goes back
    raw.emit('error', new Error('idle'));
    expect(idle.map((error) => error.message)).toEqual(['idle']);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('has an error listener of ours: a second error would end the process, the pool listens for the first only', async () => {
    const raw = stubConnection();
    await acquire(stubPool(raw));
    expect(() => raw.emit('error', new Error('after the pool dropped its own listener'))).not.toThrow();
  });
});

describe('ending the pool', () => {
  it('ends the pool beneath', async () => {
    const pool = stubPool();
    await new Promise((resolve) => guardedPool(pool, { integer, poolMax: 10 }).end(resolve));
    expect(pool.ended).toBe(true);
  });
});

describe('the session of a connection in use', () => {
  const READ = /^select @@version/;

  it('is read again when the connection goes back, once, and then it goes back', async () => {
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    raw.sent.length = 0;
    await drain(connection!.query('select 1', []));
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    // Back to the pool only after the reset, the set-up and the full reading: three statements, one of them the reset itself.
    expect(raw.sent).toEqual(['select 1', 'reset', expect.stringMatching(/^set names utf8mb4 collate utf8mb4_0900_bin, session sql_mode = /), expect.stringMatching(READ)]);
    expect(released).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it.each([
    ['a time zone', { time_zone: '+05:00' }],
    ['a collation', { collation: 'utf8mb4_general_ci' }],
    ['a client character set', { client: 'gbk' }],
    ['the sql_mode', { sql_mode: `${SQL_MODE},NO_BACKSLASH_ESCAPES` }],
  ])('goes back with what a statement changed in %s put right: the reset and the set-up replace it', async (_name, change) => {
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    raw.session = { ...raw.session, ...change };
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.sent).toContain('reset');
    expect(released).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
    expect(raw.session).toMatchObject({ time_zone: '+00:00', collation: COLLATION, client: 'utf8mb4', sql_mode: SQL_MODE });
  });

  it.each([
    ['the reset', (raw: ReturnType<typeof stubConnection>) => void (raw.resetError = new Error('reset refused'))],
    ['the set-up', (raw: ReturnType<typeof stubConnection>) => void raw.answers.set(/^set names utf8mb4/, { error: new Error('set refused') })],
  ])('is destroyed when %s fails on the way back', async (_name, fail) => {
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    fail(raw);
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('is destroyed when its session cannot be read on the way back', async () => {
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    raw.answers.set(READ, { error: new Error('gone') });
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('goes back after a reset whether or not a transaction was open, a stream or a failed statement came before — the reset rolls the transaction back', async () => {
    const raw = stubConnection();
    raw.answers.set(/^begin/, { result: ok(3) });
    raw.answers.set(/^insert /, { result: ok(3) });
    raw.answers.set(/^bad/, { error: new Error('syntax') });
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    const run = (sql: string, parameters: unknown[] = []) => new Promise<unknown>((resolve) => connection!.query(sql, parameters, (error, rows) => resolve(error ?? rows)));
    await run('begin');
    await run('insert into t values (?)', [1]);
    await run('bad');
    await drain(connection!.query('select 1', [])); // streamed
    raw.sent.length = 0;
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.sent).toEqual(['reset', expect.stringMatching(/^set names utf8mb4/), expect.stringMatching(READ)]);
    expect(released).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('is destroyed instead of going back when a statement of the app switched the database', async () => {
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    raw.session = { ...raw.session, db: 'other' };
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('opens in a database whose name the server writes in another case than the URL — it is the server’s answer that counts', async () => {
    const raw = stubConnection({ ...SESSION, db: 'myapp' }); // `--lower-case-table-names=1` and a URL path of /MyApp
    expect((await acquire(stubPool(raw))).error).toBeNull();
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('does not ask the server anything for a statement whose answer has no flag, and runs the next one as it is', async () => {
    const raw = stubConnection();
    raw.answers.set(/^update /, { result: ok(0x2) });
    const { connection } = await acquire(stubPool(raw));
    connection!.query('update t set a = 1', [], () => {});
    raw.sent.length = 0;
    await new Promise<unknown>((resolve) => connection!.query('select ?', ['ä'], (_error, rows) => resolve(rows)));
    expect(raw.sent).toEqual([]);
    expect(raw.executed.map((statement) => statement.sql)).toEqual(['select ?']);
  });
});

describe('a lease whose answers say that the session changed', () => {
  const SETTINGS = /^set (session|names)/;
  const run = (connection: MysqlPoolConnection, sql: string, parameters: unknown[] = []) =>
    new Promise<unknown>((resolve) => connection.query(sql, parameters, (error, rows) => resolve(error ?? rows)));
  const lease = async (answers: Array<[RegExp, Answer]>, options?: Parameters<typeof acquire>[1]) => {
    const raw = stubConnection();
    for (const [pattern, answer] of answers) raw.answers.set(pattern, answer);
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw), options);
    return { raw, released, connection: connection! };
  };
  const back = () => new Promise((resolve) => setImmediate(resolve));

  it('refuses every statement after an OK packet with NO_BACKSLASH_ESCAPES with D28 — nothing is sent, the connection is destroyed once, and it is not given back', async () => {
    const { raw, released, connection } = await lease([[SETTINGS, { result: ok(0x202) }]], { name: 'reporting' });
    // The statement that sets the mode itself runs; the ones behind it do not.
    expect(await run(connection, "set session sql_mode = concat(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")).toMatchObject({ serverStatus: 0x202 });
    raw.sent.length = 0;
    for (const [sql, parameters] of [['select * from notes where id = ?', ["\\' or 1=1 -- "]], ['select 1', []], ['update t set a = 1', []]] as const) {
      const error = await run(connection, sql, [...parameters]);
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect((error as Error).message).toMatch(/^\[marmeon:D28\] The MySQL connection "reporting" was refused: the session's sql_mode has NO_BACKSLASH_ESCAPES/);
    }
    expect(raw.sent).toEqual([]);
    expect(raw.prepared).toEqual([]);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    connection.release();
    await back();
    expect(released).not.toHaveBeenCalled();
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('refuses a stream after it too, with nothing sent', async () => {
    const { raw, connection } = await lease([[SETTINGS, { result: ok(0x202) }]]);
    await run(connection, 'set session sql_mode = x');
    raw.sent.length = 0;
    await expect(drain(connection.query('select ?', [1]))).rejects.toBeInstanceOf(DatabaseConnectionError);
    await expect(drain(connection.query('select 1', []))).rejects.toBeInstanceOf(DatabaseConnectionError);
    expect(raw.sent).toEqual([]);
    expect(raw.prepared).toEqual([]);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('sees the flag in an OK packet that a streamed statement gives as its only row', async () => {
    const { raw, connection } = await lease([[/^set session/, { result: ok(0x202) }]]);
    expect(await drain(connection.query('set session sql_mode = x', []))).toEqual([ok(0x202)]);
    raw.sent.length = 0;
    expect(await run(connection, 'select 1')).toBeInstanceOf(DatabaseConnectionError);
    expect(raw.sent).toEqual([]);
  });

  it('sees the flag in any of the results of a call', async () => {
    const { raw, connection } = await lease([[/^call /, { result: [[{ a: 1 }], ok(0x200), ok(0x202)] }]]);
    await run(connection, 'call multi()');
    raw.sent.length = 0;
    expect(await run(connection, 'select ?', [1])).toBeInstanceOf(DatabaseConnectionError);
    expect(raw.prepared).toEqual([]);
  });

  it.each([
    ['character_set_client', { character_set_client: 'latin1' }],
    ['character_set_connection', { character_set_connection: 'gbk' }],
  ])('refuses every statement after an OK packet that names another %s than utf8mb4 — an ASCII parameter too', async (variable, systemVariables) => {
    const { raw, connection } = await lease([[/^set names/, { result: ok(0x4002, systemVariables) }]]);
    await run(connection, 'set names latin1');
    raw.sent.length = 0;
    const error = await run(connection, 'select ?', ['Zoe']);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toContain(`the session's ${variable} is "${Object.values(systemVariables)[0]}", not "utf8mb4"`);
    expect(raw.sent).toEqual([]);
    expect(raw.prepared).toEqual([]);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('lets a lease go on that sets utf8mb4 again, changes another variable, or answers a row with a column named serverStatus', async () => {
    const { raw, connection } = await lease([
      [/^set names utf8mb4/, { result: ok(0x4002, { character_set_client: 'utf8mb4', character_set_connection: 'utf8mb4' }) }],
      [/^set time_zone/, { result: ok(0x4002, { time_zone: '+02:00' }) }],
      [/^select 1 as serverStatus/, { result: [{ serverStatus: 0x203 }] }],
      [/^update /, { result: ok(0x2) }],
    ]);
    await run(connection, 'set names utf8mb4');
    await run(connection, "set time_zone = '+02:00'");
    await run(connection, 'select 1 as serverStatus');
    await run(connection, 'update t set a = 1');
    raw.sent.length = 0;
    expect(await run(connection, 'select ?', ['Zoë'])).toEqual({});
    expect(raw.executed).toEqual([{ sql: 'select ?', values: ['Zoë'] }]);
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('drops what it prepared when an OK packet reports another database: a statement prepared before a `use` would read the old one', async () => {
    const { raw, connection } = await lease([[/^use /, { result: ok(0x2, undefined, 'other') }]]);
    await run(connection, 'select * from t where id = ?', [1]);
    await run(connection, 'select * from t where id = ? and a = ?', [1, 2]);
    expect(raw.unprepared).toEqual([]);
    await run(connection, 'use other');
    expect(raw.unprepared.toSorted()).toEqual(['select * from t where id = ?', 'select * from t where id = ? and a = ?']);
    // a second `use` has nothing left to drop
    raw.unprepared.length = 0;
    await run(connection, 'use other');
    expect(raw.unprepared).toEqual([]);
    // and a statement of a later text is dropped by the next one
    await run(connection, 'select ?', [1]);
    await run(connection, 'use other');
    expect(raw.unprepared).toEqual(['select ?']);
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('refuses what comes after, and does not go back, when dropping the prepared statements fails — the statement itself is still answered', async () => {
    const { raw, released, connection } = await lease([[/^use /, { result: ok(0x2, undefined, 'other') }]]);
    await run(connection, 'select ?', [1]);
    raw.unprepare = () => {
      throw new Error('gone');
    };
    expect(await run(connection, 'use other')).toMatchObject({ serverStatus: 0x2 });
    raw.sent.length = 0;
    const error = await run(connection, 'select 1');
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    expect((error as Error).message).toContain('could not be dropped');
    expect(raw.sent).toEqual([]);
    connection.release();
    await back();
    expect(released).not.toHaveBeenCalled();
  });

  it('remembers the 64 texts used last, and a text used again counts as used last: a `use` drops them, so the 16 that mysql2 still holds are among them', async () => {
    const { raw, connection } = await lease([[/^use /, { result: ok(0x2, undefined, 'other') }]]);
    for (let n = 0; n < 100; n += 1) await run(connection, `select ? as c${n}`, [1]);
    await run(connection, 'select ? as c36', [1]); // the oldest of the 64, used again: the newest
    await run(connection, 'select ? as c100', [1]); // pushes the oldest out
    await run(connection, 'use other');
    expect(raw.unprepared).toHaveLength(64);
    expect(raw.unprepared).toContain('select ? as c36');
    expect(raw.unprepared).not.toContain('select ? as c37');
    for (let n = 85; n <= 100; n += 1) expect(raw.unprepared).toContain(`select ? as c${n}`);
    expect(raw.unprepared).not.toContain('select ? as c1');
  });

  it('forgets what it prepared when the connection goes back: the next lease drops nothing of the last one', async () => {
    const raw = stubConnection();
    raw.answers.set(/^use /, { result: ok(0x2, undefined, 'other') });
    const guarded = guardedPool(stubPool(raw, raw), { integer, poolMax: 10 });
    const acquireAgain = () => new Promise<MysqlPoolConnection>((resolve) => guarded.getConnection((_error, connection) => resolve(connection)));
    const first = await acquireAgain();
    await run(first, 'select ?', [1]);
    first.release();
    await back();
    const second = await acquireAgain();
    await run(second, 'use other');
    expect(raw.unprepared).toEqual([]);
  });

  it('is not misled by a streamed row whose columns are named affectedRows and serverStatus', async () => {
    const { raw, connection } = await lease([]);
    raw.answers.set(/^select 0 as affectedRows/, { result: { affectedRows: 0, serverStatus: 0x200 } });
    expect(await drain(connection.query('select 0 as affectedRows, 512 as serverStatus', []))).toEqual([{ affectedRows: 0, serverStatus: 0x200 }]);
    expect(await run(connection, 'select 2')).toEqual({});
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('does not go back when its last answer said the session changed — also when no statement came after it — and is replaced instead, so the next lease is not refused', async () => {
    const { raw, released, connection } = await lease([[/^set names latin1/, { change: { sql_mode: `${SQL_MODE},NO_BACKSLASH_ESCAPES`, client: 'latin1' }, result: ok(0x4202, { character_set_client: 'latin1' }) }]]);
    await run(connection, 'set names latin1');
    connection.release();
    await back();
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('does not go back either after a call that carried the NO_BACKSLASH_ESCAPES flag', async () => {
    const { raw, released, connection } = await lease([[/^call /, { result: ok(0x200) }]]);
    await run(connection, 'call flip()');
    connection.release();
    await back();
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });
});

describe('the way back into the pool', () => {
  it('has a limit: a reset that is never answered ends the connection after the connect timeout, and a late answer changes nothing', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    const released = raw.release;
    let answer!: (error?: unknown) => void;
    raw.reset = (callback: (error: unknown) => void) => void (answer = callback);
    const { connection } = await acquire(stubPool(raw), { connectTimeoutMs: 500 });
    connection!.release();
    await vi.advanceTimersByTimeAsync(499);
    expect(raw.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    answer(null);
    await vi.advanceTimersByTimeAsync(10);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('is not cut short when the chain finishes in time: the timer is gone and the connection goes back once', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw), { connectTimeoutMs: 500 });
    connection!.release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(released).toHaveBeenCalledTimes(1);
    expect(raw.destroy).not.toHaveBeenCalled();
  });

  it('ends a connection whose driver writes in another character set than at the start — the server cannot tell', async () => {
    const raw = Object.assign(stubConnection(), { config: { charsetNumber: 255 } });
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    raw.config.charsetNumber = 28; // gbk: what `mysql2` follows after a `set names gbk` that tracking did not report
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });

  it('keeps a connection whose character set of the driver is as it was', async () => {
    const raw = Object.assign(stubConnection(), { config: { charsetNumber: 255 } });
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw));
    connection!.release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe('a statement that never answers', () => {
  it('ends the connection within the connect timeout of the return: the reset waits behind it, and the timer starts at the release', async () => {
    vi.useFakeTimers();
    const raw = stubConnection();
    raw.answers.set(/^insert /, { result: ok(2), hold: true });
    // `mysql2` queues the reset behind the statement: this one never answers either.
    raw.reset = () => {};
    const released = raw.release;
    const { connection } = await acquire(stubPool(raw), { connectTimeoutMs: 500 });
    connection!.query('insert into t values (1)', [], () => {});
    connection!.release();
    await vi.advanceTimersByTimeAsync(499);
    expect(raw.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
    expect(released).not.toHaveBeenCalled();
  });
});
