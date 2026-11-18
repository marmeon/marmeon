import { EventEmitter } from 'node:events';
import { TransactionError } from '@marmeon/core';
import { CompiledQuery, type DatabaseConnection, type MysqlPool, type MysqlPoolConnection } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnectionError } from './driver.ts';
import { bind, CastFailure, COLLATION, guardedPool, NO_FREE_CONNECTION, SQL_MODE, TRACKED_VARIABLES } from './mysql-session.ts';
import { transactionControls } from './mysql-transaction-control.ts';

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

const SESSION = { version: '8.4.3', version_comment: 'MySQL Community Server - GPL', sql_mode: SQL_MODE, time_zone: '+00:00', collation: COLLATION, client: 'utf8mb4', autocommit: 1, completion_type: 'NO_CHAIN', tracked: TRACKED_VARIABLES.join(','), db: 'app' };

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
    running(rows: unknown[], failure?: Error) {
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
            if (failure) throw failure;
          })(),
      });
    },
    answer(sql: string, callback: ((error: unknown, result: unknown) => void) | undefined, rows: unknown[] = [{ row: 1 }]) {
      for (const [pattern, answer] of raw.answers) {
        if (!pattern.test(sql)) continue;
        Object.assign(raw.session, answer.change);
        if (callback && answer.hold) return void raw.held.push(() => callback(answer.error ?? null, answer.result));
        if (!callback) return raw.running(answer.error ? [] : answer.result === undefined ? rows : [answer.result], answer.error);
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
      // The tracked variables and the end of a transaction are part of the set-up: the checks of a lease read what the server reports of them.
      `set names utf8mb4 collate ${COLLATION}, session sql_mode = '${SQL_MODE}', time_zone = '+00:00', session_track_schema = 1, ` +
        `session_track_system_variables = '${TRACKED_VARIABLES.join(',')}', completion_type = 'NO_CHAIN'`,
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
    ['a session that chains transactions', { completion_type: 'CHAIN' }, 'completion_type is "CHAIN"'],
    ['a session that does not report what a lease checks', { tracked: 'time_zone,autocommit' }, 'does not report changes of character_set_client, character_set_results, character_set_connection, completion_type'],
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

describe('a transaction that MySQL ended', () => {
  const IN_TRANS = 0x3;
  const AUTOCOMMIT = 0x2;
  const error = (errno: number) => Object.assign(new Error(`mysql error ${errno}`), { errno });
  const run = (connection: MysqlPoolConnection, sql: string, parameters: unknown[] = []) =>
    new Promise<{ error: unknown; result: unknown }>((resolve) => connection.query(sql, parameters, (failure, result) => resolve({ error: failure, result })));
  /** What Kysely's driver does for `begin`, `commit` and `rollback`: the statements of the transaction, marked as the driver's own. */
  const driverOf = (connection: MysqlPoolConnection) =>
    transactionControls({
      executeQuery: (query: CompiledQuery) =>
        new Promise((resolve, reject) => connection.query(query.sql, query.parameters as unknown[], (failure, result) => (failure ? reject(failure) : resolve({ rows: [], result })))),
    } as unknown as DatabaseConnection);
  const control = (connection: MysqlPoolConnection, sql: 'begin' | 'commit' | 'rollback') => driverOf(connection).executeQuery(CompiledQuery.raw(sql));
  const lease = async () => {
    const raw = stubConnection();
    raw.answers.set(/^begin$/, { result: ok(IN_TRANS) });
    raw.answers.set(/^(commit|rollback)$/, { result: ok(AUTOCOMMIT) });
    raw.answers.set(/^update t /, { result: ok(IN_TRANS) });
    raw.answers.set(/^(insert|delete) /, { result: ok(IN_TRANS) });
    raw.answers.set(/^do 0$/, { result: ok(IN_TRANS) });
    const released = raw.release;
    const guarded = guardedPool(stubPool(raw, raw), { integer, poolMax: 10 });
    const get = () => new Promise<MysqlPoolConnection>((resolve) => guarded.getConnection((_error, connection) => resolve(connection)));
    const connection = await get();
    raw.sent.length = 0;
    return { raw, connection, get, released };
  };
  const nothingSent = (raw: ReturnType<typeof stubConnection>) => ({ sent: [...raw.sent], prepared: [...raw.prepared], executed: [...raw.executed] });
  const D24 = /^\[marmeon:D24\] This transaction was ended by MySQL: /;

  it.each([
    ['a deadlock', 1213, /rolled it back after a deadlock \(error 1213\): nothing of it is committed/],
    ['a lock wait timeout', 1205, /a lock wait timed out \(error 1205\)/],
  ])('after %s, refuses every statement and the commit without sending them, on both ways to the server, and sends the rollback', async (_name, errno, wording) => {
    const { raw, connection } = await lease();
    await control(connection, 'begin');
    // The error of either way ends it: the text protocol, and a prepared statement.
    for (const parameters of [[], [1]]) {
      raw.answers.set(/^update locked/, { error: error(errno) });
      await control(connection, 'rollback');
      await control(connection, 'begin');
      expect((await run(connection, 'update locked set a = ?'.replace('?', parameters.length === 0 ? '1' : '?'), parameters)).error).toMatchObject({ errno });
      const before = nothingSent(raw);
      for (const [sql, values] of [['insert into t values (1)', []], ['insert into t values (?)', [1]], ['release savepoint s', []], ['select 1', []]] as const) {
        const refused = (await run(connection, sql, [...values])).error;
        expect(refused).toBeInstanceOf(TransactionError);
        expect((refused as Error).message).toMatch(D24);
        expect((refused as Error).message).toMatch(wording);
      }
      await expect(drain(connection.query('select 1', []))).rejects.toBeInstanceOf(TransactionError);
      await expect(drain(connection.query('select ?', [1]))).rejects.toBeInstanceOf(TransactionError);
      await expect(control(connection, 'commit')).rejects.toBeInstanceOf(TransactionError);
      expect(nothingSent(raw)).toEqual(before);
    }
    await control(connection, 'rollback');
    expect(raw.sent.at(-1)).toBe('rollback');
    expect((await run(connection, 'insert into t values (1)')).error).toBeNull();
    expect(raw.sent.at(-1)).toBe('insert into t values (1)');
  });

  it('lets a rollback to a savepoint of the ended transaction pass without sending it, and still refuses what follows', async () => {
    const { raw, connection } = await lease();
    await control(connection, 'begin');
    raw.answers.set(/^update locked/, { error: error(1213) });
    await run(connection, 'update locked set a = 1');
    const before = nothingSent(raw);
    expect((await run(connection, 'rollback to savepoint marmeon_savepoint_1')).error).toBeNull();
    expect((await run(connection, 'rollback to `s`')).error).toBeNull();
    expect(nothingSent(raw)).toEqual(before);
    expect((await run(connection, 'select 1')).error).toBeInstanceOf(TransactionError);
  });

  it('ends the transaction at an OK packet without IN_TRANS, whichever way the statement went, and says the cause is an implicit commit', async () => {
    for (const [sql, parameters] of [['create table t2 (id int)', []], ['alter table t add column b int', []], ['commit', []], ['lock tables t write', []]] as const) {
      const { raw, connection } = await lease();
      raw.answers.set(/^(create|alter|lock) |^commit$/, { result: ok(AUTOCOMMIT) });
      await control(connection, 'begin');
      expect((await run(connection, sql, [...parameters])).error).toBeNull();
      const before = nothingSent(raw);
      const refused = (await run(connection, 'insert into t values (1)')).error;
      expect((refused as Error).message, sql).toMatch(/^\[marmeon:D24\] This transaction was ended by MySQL: a statement committed it \(/);
      await expect(control(connection, 'commit')).rejects.toBeInstanceOf(TransactionError);
      expect(nothingSent(raw), sql).toEqual(before);
    }
  });

  it('sees the implicit commit of a statement with parameters (prepared) too, and of a call whose last packet has no IN_TRANS', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^create /, { result: ok(AUTOCOMMIT) });
    raw.answers.set(/^call p\(/, { result: [[{ a: 1 }], ok(IN_TRANS)] });
    raw.answers.set(/^call q\(/, { result: [[{ a: 1 }], ok(AUTOCOMMIT)] });
    await control(connection, 'begin');
    expect((await run(connection, 'call p(?)', [1])).error).toBeNull();
    expect((await run(connection, 'select 1')).error).toBeNull();
    expect((await run(connection, 'call q(?)', [1])).error).toBeNull();
    expect((await run(connection, 'select 1')).error).toBeInstanceOf(TransactionError);
  });

  it('sees the implicit commit of a statement that streams', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^create /, { result: ok(AUTOCOMMIT) });
    await control(connection, 'begin');
    await drain(connection.query('create table t2 (id int)', []));
    expect((await run(connection, 'select 1')).error).toBeInstanceOf(TransactionError);
  });

  it('takes a begin or start transaction of the app inside the transaction for what it is: it commits the one that is open', async () => {
    for (const sql of ['begin', 'start transaction', '  START TRANSACTION read only']) {
      const { raw, connection } = await lease();
      raw.answers.set(/^\s*(begin|start)/i, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      await run(connection, sql);
      expect((await run(connection, 'select 1')).error, sql).toBeInstanceOf(TransactionError);
    }
  });

  it('does not take the words of the app for the transaction of the driver: a commit of the app alone starts and ends nothing it tracks', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^create /, { result: ok(AUTOCOMMIT) });
    expect((await run(connection, 'begin')).error).toBeNull();
    expect((await run(connection, 'create table t2 (id int)')).error).toBeNull();
    expect((await run(connection, 'select 1')).error).toBeNull();
    expect(raw.sent).toEqual(['begin', 'create table t2 (id int)', 'select 1']);
  });

  it('is not ended by an error that is none of the two, nor by a deadlock outside of a transaction', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^update dup/, { error: error(1062) });
    raw.answers.set(/^update locked/, { error: error(1213) });
    await control(connection, 'begin');
    expect((await run(connection, 'update dup set a = 1')).error).toMatchObject({ errno: 1062 });
    expect((await run(connection, 'select 1')).error).toBeNull();
    await control(connection, 'commit');
    expect((await run(connection, 'update locked set a = 1')).error).toMatchObject({ errno: 1213 });
    expect((await run(connection, 'select 1')).error).toBeNull();
  });

  it('keeps a transaction open that went on: the OK packets of its statements say IN_TRANS, and the commit goes out', async () => {
    const { raw, connection } = await lease();
    await control(connection, 'begin');
    expect((await run(connection, 'update t set a = 1')).error).toBeNull();
    expect((await run(connection, 'update t set a = ?', [2])).error).toBeNull();
    await control(connection, 'commit');
    expect(raw.sent).toEqual(['begin', 'update t set a = 1', 'commit']);
  });

  /** The answer of `do 0`, the probe: a different one than the lease's default. */
  const probeAnswer = (raw: ReturnType<typeof stubConnection>, answer: Answer) => {
    for (const pattern of [...raw.answers.keys()]) if (pattern.source === '^do 0$') raw.answers.delete(pattern);
    raw.answers.set(/^do 0$/, answer);
  };
  /** An answer that wins over the lease's own for the same statement: the first pattern that matches is the one used. */
  const answerFirst = (raw: ReturnType<typeof stubConnection>, pattern: RegExp, answer: Answer) => {
    const others = [...raw.answers];
    raw.answers.clear();
    raw.answers.set(pattern, answer);
    for (const [key, value] of others) raw.answers.set(key, value);
  };
  const rows = (name: string) => [{ Table: name, Op: 'analyze', Msg_type: 'status', Msg_text: 'OK' }];

  it('asks with `do 0` before the next statement after an answer without a status, and goes on when the transaction is still open', async () => {
    for (const parameters of [[], [1]]) {
      const { raw, connection } = await lease();
      raw.answers.set(/^analyze table/, { result: rows('t') });
      raw.answers.set(/^create table exists/, { error: error(1050) });
      await control(connection, 'begin');
      for (const statement of ['analyze table t', 'create table exists (id int)']) {
        raw.sent.length = 0;
        await run(connection, statement);
        expect(raw.sent).toEqual([statement]);
        expect((await run(connection, parameters.length === 0 ? 'insert into t values (1)' : 'insert into t values (?)', parameters)).error).toBeNull();
        // The probe went out first, over the text protocol, and then the statement.
        expect(raw.sent).toEqual([statement, 'do 0', ...(parameters.length === 0 ? ['insert into t values (1)'] : [])]);
        expect(raw.executed.at(-1)).toEqual(parameters.length === 0 ? raw.executed.at(-1) : { sql: 'insert into t values (?)', values: [1] });
      }
    }
  });

  it('refuses what follows an answer without a status when the probe finds the transaction gone, whatever the statement was, with nothing but the probe sent', async () => {
    for (const [statement, answer] of [
      ['analyze table t', { result: rows('t') }],
      ['create table exists (id int)', { error: error(1050) }],
      ['alter table missing add column a int', { error: error(1146) }],
      ['drop table missing', { error: error(1051) }],
      ['call commits_then_signals()', { error: error(1644) }],
      ['/*! analyze table t */', { result: rows('t') }],
      ['/*+ x */ select 1', { result: rows('t') }],
      ['(select 1)', { result: rows('t') }],
    ] as const) {
      const { raw, connection } = await lease();
      raw.answers.set(/analyze table|^create table exists|^alter table missing|^drop table missing|^call commits_then|^\/\*\+ x|^\(select 1\)/, answer);
      await control(connection, 'begin');
      await run(connection, statement);
      probeAnswer(raw, { result: ok(AUTOCOMMIT) });
      raw.sent.length = 0;
      const refused = (await run(connection, 'insert into t values (1)')).error;
      expect(refused, statement).toBeInstanceOf(TransactionError);
      expect((refused as Error).message).toMatch(/it is no longer open: a statement or an error of the transaction ended it, committed or rolled back/);
      expect(raw.sent, statement).toEqual(['do 0']);
      await expect(control(connection, 'commit')).rejects.toBeInstanceOf(TransactionError);
      // The rollback of the driver goes out without a question first.
      await control(connection, 'rollback');
      expect(raw.sent, statement).toEqual(['do 0', 'rollback']);
    }
  });

  it('does not ask after the answers that cannot end a transaction: a plain read, a signal of a procedure that did not commit is asked once', async () => {
    const { raw, connection } = await lease();
    await control(connection, 'begin');
    raw.sent.length = 0;
    for (const statement of ['select 1', 'with a as (select 1) select * from a', 'show tables', 'explain select 1', 'describe t', 'desc t', 'table t', 'values row(1)', '/* a */ select 2', '-- c\nselect 3', '# c\nselect 4']) {
      await run(connection, statement);
    }
    await drain(connection.query('select 5', []));
    await drain(connection.query('select ?', [6]));
    expect(raw.sent.filter((sent) => sent === 'do 0')).toEqual([]);
    // A statement that is none of them is asked about, once, and the answer with a status ends the asking.
    raw.answers.set(/^call p_fail/, { error: error(1644) });
    await run(connection, 'call p_fail()');
    await run(connection, 'select 1');
    await run(connection, 'select 1');
    expect(raw.sent.filter((sent) => sent === 'do 0')).toEqual(['do 0']);
    expect((await run(connection, 'insert into t values (1)')).error).toBeNull();
  });

  it('asks before the commit of the driver, a rollback to and a release savepoint too; a failing probe ends the transaction', async () => {
    for (const next of [(c: MysqlPoolConnection) => control(c, 'commit').then(() => undefined), (c: MysqlPoolConnection) => run(c, 'release savepoint s').then((r) => r.error), (c: MysqlPoolConnection) => run(c, 'rollback to savepoint s').then((r) => r.error)]) {
      const { raw, connection } = await lease();
      raw.answers.set(/^analyze table/, { result: rows('t') });
      await control(connection, 'begin');
      await run(connection, 'analyze table t');
      probeAnswer(raw, { error: error(2013) });
      raw.sent.length = 0;
      const outcome = await next(connection).then((value) => value, (failure: unknown) => failure);
      expect(raw.sent[0]).toBe('do 0');
      // The commit and the release are refused; a rollback to passes, and the rollback of the driver would end it.
      if (outcome !== null) expect(outcome === undefined || outcome instanceof TransactionError).toBe(true);
      expect(raw.sent).toEqual(['do 0']);
    }
  });

  it('asks a stream too, and a deadlock that ends a stream, over the text and the prepared way, ends the transaction', async () => {
    for (const parameters of [[], [1]]) {
      const { raw, connection } = await lease();
      raw.answers.set(/^select locked/, { error: error(1213) });
      await control(connection, 'begin');
      await expect(drain(connection.query(parameters.length === 0 ? 'select locked from t' : 'select locked from t where a = ?', parameters))).rejects.toMatchObject({ errno: 1213 });
      const before = nothingSent(raw);
      expect((await run(connection, 'insert into t values (1)')).error).toBeInstanceOf(TransactionError);
      await expect(drain(connection.query('select 1', []))).rejects.toBeInstanceOf(TransactionError);
      expect(nothingSent(raw)).toEqual(before);
    }
  });

  it('ends the transaction at a prepared statement without IN_TRANS as at a text one, and at a stream that streams one', async () => {
    const { raw, connection } = await lease();
    answerFirst(raw, /^delete from gone/, { result: ok(AUTOCOMMIT) });
    await control(connection, 'begin');
    expect((await run(connection, 'delete from gone where id = ?', [1])).error).toBeNull();
    expect((await run(connection, 'select 1')).error).toBeInstanceOf(TransactionError);
    const second = await lease();
    answerFirst(second.raw, /^delete from gone/, { result: ok(AUTOCOMMIT) });
    await control(second.connection, 'begin');
    await drain(second.connection.query('delete from gone where id = ?', [1]));
    expect((await run(second.connection, 'select 1')).error).toBeInstanceOf(TransactionError);
  });

  it('ends the transaction at a full lock table, like a deadlock', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^update locked/, { error: error(1206) });
    await control(connection, 'begin');
    await run(connection, 'update locked set a = 1');
    const refused = (await run(connection, 'select 1')).error;
    expect(refused).toBeInstanceOf(TransactionError);
    expect((refused as Error).message).toMatch(/lock table was full \(error 1206\)/);
  });

  it('knows a begin, commit or rollback of the app by its text, behind comments and executable comments, and with chain, work or release', async () => {
    const cases: Array<[string, RegExp]> = [
      ['/* own */ begin', /committed it/],
      ['-- x\nstart transaction', /committed it/],
      ['# x\nbegin', /committed it/],
      ['/*! begin */', /committed it/],
      ['/*!50000 start transaction */', /committed it/],
      ['commit and chain', /committed it/],
      ['commit work release', /committed it/],
      ['/* x */ rollback and chain', /a rollback written by hand undid it/],
      ['rollback work', /a rollback written by hand undid it/],
    ];
    for (const [sql, wording] of cases) {
      const { raw, connection } = await lease();
      // Chained: the server keeps the transaction open (IN_TRANS), which the status alone would not call ended.
      raw.answers.set(/begin|start|commit|rollback/, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      await run(connection, sql);
      const refused = (await run(connection, 'insert into t values (1)')).error;
      expect((refused as Error | undefined)?.message, sql).toMatch(wording);
    }
  });

  it('lets a rollback to a savepoint of the app pass behind comments, and does not take it for a rollback', async () => {
    for (const sql of ['/* x */ rollback to savepoint s', 'rollback work to savepoint s', '-- c\nrollback to s']) {
      const { raw, connection } = await lease();
      raw.answers.set(/rollback/, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      raw.answers.set(/^update locked/, { error: error(1213) });
      await run(connection, 'update locked set a = 1');
      raw.sent.length = 0;
      expect((await run(connection, sql)).error, sql).toBeNull();
      expect(raw.sent).toEqual([]);
    }
  });

  it('spoils the lease when the commit or rollback of the driver leaves a transaction open (completion_type chains them): the error says so, and the connection is destroyed, not given back', async () => {
    for (const sql of ['commit', 'rollback'] as const) {
      const { raw, connection, released } = await lease();
      await control(connection, 'begin');
      answerFirst(raw, /^(commit|rollback)$/, { result: ok(IN_TRANS) });
      const failure = await control(connection, sql).then(() => undefined, (caught: unknown) => caught);
      expect(failure).toBeInstanceOf(DatabaseConnectionError);
      expect((failure as Error).message).toMatch(/^\[marmeon:D28\] .*completion_type/);
      expect(raw.destroy).toHaveBeenCalled();
      connection.release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(released).not.toHaveBeenCalled();
    }
  });

  it('refuses everything after an answer that says autocommit is OFF, as it does for a changed character set, and gives the connection up', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^set autocommit/, { result: ok(IN_TRANS, { autocommit: 'OFF' }) });
    await run(connection, 'set autocommit = 0');
    const refused = (await run(connection, 'select 1')).error;
    expect(refused).toBeInstanceOf(DatabaseConnectionError);
    expect((refused as Error).message).toMatch(/^\[marmeon:D28\] .*autocommit is OFF/);
    expect(raw.destroy).toHaveBeenCalled();
  });

  it('asks before a stream too: the probe finds the transaction gone, so the stream is refused with only the probe sent, text and prepared', async () => {
    for (const [sql, parameters] of [['select 1', []], ['select ?', [1]]] as const) {
      for (const first of ['analyze table t', 'create table exists (id int)']) {
        const { raw, connection } = await lease();
        raw.answers.set(/^analyze table/, { result: rows('t') });
        raw.answers.set(/^create table exists/, { error: error(1050) });
        await control(connection, 'begin');
        await run(connection, first);
        probeAnswer(raw, { result: ok(AUTOCOMMIT) });
        raw.sent.length = 0;
        await expect(drain(connection.query(sql, [...parameters]))).rejects.toBeInstanceOf(TransactionError);
        expect(raw.sent, `${first} ${sql}`).toEqual(['do 0']);
        expect(raw.prepared).toEqual([]);
      }
    }
  });

  it('forgets that it has to ask when the driver rolls back or the lease is given back: the next transaction runs without a question', async () => {
    const { raw, connection, get } = await lease();
    raw.answers.set(/^analyze table/, { result: rows('t') });
    await control(connection, 'begin');
    await run(connection, 'analyze table t');
    await control(connection, 'rollback');
    await control(connection, 'begin');
    await run(connection, 'update t set a = 1');
    expect(raw.sent.filter((sent) => sent === 'do 0')).toEqual([]);
    await run(connection, 'analyze table t');
    connection.release();
    await new Promise((resolve) => setImmediate(resolve));
    const next = await get();
    raw.sent.length = 0;
    await control(next, 'begin');
    await run(next, 'update t set a = 1');
    expect(raw.sent).toEqual(['begin', 'update t set a = 1']);
  });

  it('sends the rollback of the driver without a question first, even when an answer left the state unknown', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^analyze table/, { result: rows('t') });
    await control(connection, 'begin');
    await run(connection, 'analyze table t');
    raw.sent.length = 0;
    await control(connection, 'rollback');
    expect(raw.sent).toEqual(['rollback']);
  });

  it('ends the transaction when the probe has no OK packet to read, and reads the probe like any answer: a session it changed refuses the statement behind it', async () => {
    const stateless = await lease();
    stateless.raw.answers.set(/^analyze table/, { result: rows('t') });
    await control(stateless.connection, 'begin');
    await run(stateless.connection, 'analyze table t');
    probeAnswer(stateless.raw, { result: [] });
    expect((await run(stateless.connection, 'insert into t values (1)')).error).toBeInstanceOf(TransactionError);

    for (const [name, packet, reason] of [
      ['autocommit', ok(IN_TRANS, { autocommit: 'OFF' }), /autocommit is OFF/],
      ['NO_BACKSLASH_ESCAPES', ok(IN_TRANS | 0x200), /NO_BACKSLASH_ESCAPES/],
      ['completion_type', ok(IN_TRANS, { completion_type: 'CHAIN' }), /completion_type/],
    ] as const) {
      const { raw, connection } = await lease();
      raw.answers.set(/^analyze table/, { result: rows('t') });
      await control(connection, 'begin');
      await run(connection, 'analyze table t');
      probeAnswer(raw, { result: packet });
      raw.sent.length = 0;
      const refused = (await run(connection, 'insert into t values (1)')).error;
      expect(refused, name).toBeInstanceOf(DatabaseConnectionError);
      expect((refused as Error).message).toMatch(reason);
      // Only the probe went out: the statement behind it was refused after the probe's answer changed the session.
      expect(raw.sent, name).toEqual(['do 0']);
      expect(raw.destroy).toHaveBeenCalled();
    }
  });

  it('asks after a stream that ended without an OK packet and without a plain read, and after one that was left before its end, whatever it began with', async () => {
    const analyzed = await lease();
    analyzed.raw.answers.set(/^analyze table/, { result: rows('t') });
    await control(analyzed.connection, 'begin');
    await drain(analyzed.connection.query('analyze table t', []));
    await run(analyzed.connection, 'insert into t values (1)');
    expect(analyzed.raw.sent.slice(-2)).toEqual(['do 0', 'insert into t values (1)']);

    for (const [sql, parameters] of [['select a from t', []], ['select ? as a', [1]]] as const) {
      const { raw, connection } = await lease();
      raw.answers.set(/^select (a from t|\? as a)/, { result: undefined });
      await control(connection, 'begin');
      raw.sent.length = 0;
      const leaving = connection.query(sql, [...parameters]) as unknown as { stream: () => AsyncIterable<unknown> };
      for await (const _row of leaving.stream()) {
        void _row;
        break;
      }
      await run(connection, 'insert into t values (1)');
      expect(raw.sent.filter((sent) => sent === 'do 0'), sql).toEqual(['do 0']);
      // A stream that ran to its end asks nothing.
      raw.sent.length = 0;
      await drain(connection.query(sql, [...parameters]));
      await run(connection, 'insert into t values (2)');
      expect(raw.sent.filter((sent) => sent === 'do 0'), sql).toEqual([]);
    }
  });

  it('refuses a commit after an answer that changed completion_type, before it is sent: nothing was committed, and the connection is destroyed', async () => {
    const { raw, connection } = await lease();
    raw.answers.set(/^set session completion_type/, { result: ok(IN_TRANS, { completion_type: 'CHAIN' }) });
    await control(connection, 'begin');
    await run(connection, 'set session completion_type = 1');
    raw.sent.length = 0;
    expect((await run(connection, 'insert into t values (1)')).error).toBeInstanceOf(DatabaseConnectionError);
    const commit = await control(connection, 'commit').then(() => undefined, (failure: unknown) => failure);
    expect(commit).toBeInstanceOf(DatabaseConnectionError);
    expect((commit as Error).message).toMatch(/^\[marmeon:D28\] .*completion_type is no longer NO_CHAIN \(now "CHAIN"\)/);
    expect(raw.sent).toEqual([]);
    expect(raw.destroy).toHaveBeenCalledTimes(1);
  });

  it('says that the commit ran when its own answer still has IN_TRANS (the fallback behind the check of the variable)', async () => {
    const { raw, connection } = await lease();
    await control(connection, 'begin');
    answerFirst(raw, /^commit$/, { result: ok(IN_TRANS) });
    const failure = await control(connection, 'commit').then(() => undefined, (caught: unknown) => caught);
    expect((failure as Error).message).toMatch(/^\[marmeon:D28\] .*the commit or rollback of the transaction ran, but it left a transaction open/);
  });

  it('takes a version comment as the server does: one of a newer version than the server (8.4.3 here) is skipped, so what it hides is not run', async () => {
    for (const [sql, ended] of [
      ['/*!99999 COMMIT */ SELECT 1', false],
      ['/*!99999begin*/ select 1', false],
      ['/*!800000 begin */ select 1', false],
      ['/*!80404 commit */ select 1', false],
      ['/*!80000 begin */', true],
      ['/*!80403 begin */', true],
      ['/*!080000 begin */', true],
      ['/*!80000begin */', true],
      ['/*! commit */', true],
      ['/*!99999 x */ /*!80000 begin */', true],
    ] as const) {
      const { raw, connection } = await lease();
      raw.answers.set(/^\/\*!/, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      await run(connection, sql);
      expect((await run(connection, 'insert into t values (1)')).error instanceof TransactionError, sql).toBe(ended);
    }
  });

  it('does not take a version comment for a transaction statement when no reading of it is one', async () => {
    for (const sql of ['/*!80000 select 1 */', '/*!99999 x */ /*!80000 select 1 */ select 2', '/*!80000 rollback to s */', '/*!80000 commit_log */']) {
      const { raw, connection } = await lease();
      raw.answers.set(/^\/\*!/, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      await run(connection, sql);
      const after = (await run(connection, 'insert into t values (1)')).error;
      // A statement that is not one is not taken for one: the answer has IN_TRANS, so the transaction goes on.
      expect(after, sql).toBeNull();
    }
  });

  it('knows a begin or commit behind a comment that a server may skip (/*!99999 … */), whether the comment hides it or not', async () => {
    for (const sql of [
      '/*!99999 select 1 */ begin',
      '/*!99999 x */ commit and chain',
      '/*!50000 begin */',
      '/*!99999 x */ rollback and chain',
      // Several version comments: the keyword may stand in any of them.
      '/*!99999 x */ /*!80000 begin */',
      '/*!99999 x */ /*! commit and chain */',
      '/*!99999 x */ /* y */ /*!80000 start transaction */',
      '/*!80000 rollback */ and chain',
    ]) {
      const { raw, connection } = await lease();
      raw.answers.set(/begin|commit|rollback/, { result: ok(IN_TRANS) });
      await control(connection, 'begin');
      await run(connection, sql);
      expect((await run(connection, 'insert into t values (1)')).error, sql).toBeInstanceOf(TransactionError);
    }
  });

  it('starts the next lease clean: a lease that ended inside an ended transaction leaves nothing of it', async () => {
    const { raw, connection, get } = await lease();
    await control(connection, 'begin');
    raw.answers.set(/^update locked/, { error: error(1213) });
    await run(connection, 'update locked set a = 1');
    expect((await run(connection, 'select 1')).error).toBeInstanceOf(TransactionError);
    connection.release();
    await new Promise((resolve) => setImmediate(resolve));
    const next = await get();
    raw.sent.length = 0;
    expect((await run(next, 'select 1')).error).toBeNull();
    // A transaction of the next lease is its own: the driver's begin opens it, and a statement before it refused nothing.
    await control(next, 'begin');
    expect((await run(next, 'update t set a = 1')).error).toBeNull();
    await control(next, 'commit');
    expect(raw.sent).toEqual(['select 1', 'begin', 'update t set a = 1', 'commit']);
  });
});
