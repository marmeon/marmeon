import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, MysqlDialect, sql, type MysqlPool } from 'kysely';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { freshConnections, freshDatabase, MYSQL_URL, silent, withMysql } from './__fixtures__/databases.ts';
import { Connections } from './connections.ts';
import { tableColumns } from './introspection.ts';
import { connectionError, DatabaseConnectionError } from './driver.ts';
import { migratorConnection } from './migrator-connection.ts';
import { CastFailure, guardedPool } from './mysql-session.ts';
import { createMysqlDialect, importMysql2, MYSQL_INSTALL, mysqlConnection, textOnly, typeCast } from './mysql.ts';
import { tempDir } from '../../../scripts/test/temp-dir.js';

// The tests that need a server run in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL; the others run everywhere.

describe('mysqlConnection', () => {
  it('spells out the URL’s parts and the settings that make values come back as on the other drivers', () => {
    expect(mysqlConnection('mysql://app:p%40ss@db.example:3307/shop%20db')).toMatchObject({
      host: 'db.example',
      port: 3307,
      user: 'app',
      password: 'p@ss',
      database: 'shop db',
      connectTimeout: 10_000,
      charset: 'utf8mb4',
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      decimalNumbers: false,
      flags: ['-LOCAL_FILES', 'FOUND_ROWS'],
      typeCast,
    });
    expect(mysqlConnection('mysql://app@db/shop')).toMatchObject({ port: 3306, password: '' });
    expect(mysqlConnection('mysql://app@[::1]/shop')).toMatchObject({ host: '::1' });
  });

  it('takes the socket, the connect timeout (seconds, or the override in milliseconds) and nothing else from the query string', () => {
    expect(mysqlConnection('mysql://app@localhost/shop?socket=/var/run/mysqld/mysqld.sock&connect_timeout=30')).toMatchObject({ socketPath: '/var/run/mysqld/mysqld.sock', connectTimeout: 30_000 });
    expect(mysqlConnection('mysql://app@db/shop?connect_timeout=30', 200).connectTimeout).toBe(200);
    expect(() => mysqlConnection('mysql://app@db/shop?connect_timeout=1.5')).toThrow('connect_timeout');
    expect(() => mysqlConnection('mysql://app@db/shop?connect_timeout=2147484')).toThrow('connect_timeout');
  });

  it('refuses a query parameter that would switch on multiple statements, the client flags or anything else, without quoting its value', () => {
    for (const parameter of ['multipleStatements=true', 'flags=%2BMULTI_STATEMENTS', 'password=hunter2', 'localInfile=1', 'ssl=%7B%7D']) {
      const error = (() => {
        try {
          return mysqlConnection(`mysql://app@db/shop?${parameter}`);
        } catch (caught) {
          return caught;
        }
      })();
      expect(error, parameter).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain(JSON.stringify(parameter.split('=')[0]));
      expect((error as Error).message).not.toContain('hunter2');
    }
    expect(() => mysqlConnection('mysql://app@db/shop?socket=/a&socket=/b')).toThrow('more than once');
  });

  it('names a refused parameter only when it is an option of mysql2: a ? inside the password is no parameter name', () => {
    expect(() => mysqlConnection('mysql://app:12?s3cret-tail@db/app')).toThrow(
      new TypeError('The URL of a MySQL connection has a query parameter that Marmeon does not pass on; it takes ssl-mode, ssl-ca, ssl-cert, ssl-key, connect_timeout, socket.'),
    );
    expect(() => mysqlConnection('mysql://app@db/app?multipleStatements=true')).toThrow(
      new TypeError('The URL of a MySQL connection has a query parameter "multipleStatements" that Marmeon does not pass on; it takes ssl-mode, ssl-ca, ssl-cert, ssl-key, connect_timeout, socket.'),
    );
  });

  it('is not a MySQL address without the mysql scheme and a host', () => {
    expect(() => mysqlConnection('postgres://app@db/shop')).toThrow('mysql:// URL');
    expect(() => mysqlConnection('mysql:///shop')).toThrow('mysql:// URL');
    expect(() => mysqlConnection('not a url')).toThrow('mysql:// URL');
  });

  it('asks for no encryption without an ssl-mode, and for what the mode says with one', () => {
    expect(mysqlConnection('mysql://app@db/shop').ssl).toBeUndefined();
    expect(mysqlConnection('mysql://app@db/shop?ssl-mode=DISABLED').ssl).toBeUndefined();
    expect(mysqlConnection('mysql://app@db/shop?ssl-mode=REQUIRED').ssl).toMatchObject({ rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    // mysql2 decides about the host name by `verifyIdentity` alone; a `checkServerIdentity` of ours would not be read.
    expect(mysqlConnection('mysql://app@db/shop?ssl-mode=REQUIRED').ssl).toMatchObject({ verifyIdentity: false });
    expect(mysqlConnection('mysql://app@db/shop?ssl-mode=verify_ca').ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: false, minVersion: 'TLSv1.2' });
    expect(mysqlConnection('mysql://app@db.example/shop?ssl-mode=VERIFY_IDENTITY').ssl).toEqual({ rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' });
    expect(() => mysqlConnection('mysql://app@db/shop?ssl-mode=PREFERRED')).toThrow('ssl-mode');
  });

  it('refuses VERIFY_IDENTITY for an IP address: there is no name to check a certificate against', () => {
    for (const host of ['127.0.0.1', '[::1]', '10.0.0.5']) {
      expect(() => mysqlConnection(`mysql://app@${host}/shop?ssl-mode=VERIFY_IDENTITY`)).toThrow(
        "The URL of a MySQL connection has ssl-mode=VERIFY_IDENTITY with an IP address as its host: use the server's name, or VERIFY_CA.",
      );
    }
    expect(() => mysqlConnection('mysql://a@127%2E0%2E0%2E1/db?ssl-mode=VERIFY_IDENTITY')).toThrow('with an IP address as its host');
    expect(mysqlConnection('mysql://app@127.0.0.1/shop?ssl-mode=VERIFY_CA').ssl).toMatchObject({ verifyIdentity: false });
    expect(mysqlConnection('mysql://app@localhost/shop?ssl-mode=VERIFY_IDENTITY').ssl).toMatchObject({ verifyIdentity: true });
  });

  it('reads the certificate files the URL names, and refuses them where no TLS is asked for', () => {
    const directory = tempDir('marmeon-mysql-ssl-');
    const file = join(directory, 'ca.pem');
    writeFileSync(file, 'the certificate');
    expect((mysqlConnection(`mysql://app@db/shop?ssl-mode=VERIFY_CA&ssl-ca=${encodeURIComponent(file)}`).ssl as { ca: Buffer }).ca.toString()).toBe('the certificate');
    expect(() => mysqlConnection(`mysql://app@db/shop?ssl-ca=${encodeURIComponent(file)}`)).toThrow('no ssl-mode');
    expect(() => mysqlConnection(`mysql://app@db/shop?ssl-mode=DISABLED&ssl-key=${encodeURIComponent(file)}`)).toThrow('no ssl-mode');
    const missing = join(directory, 'secret-name.pem');
    const error = (() => {
      try {
        return mysqlConnection(`mysql://app@db/shop?ssl-mode=VERIFY_CA&ssl-key=${encodeURIComponent(missing)}`);
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as Error).message).toContain('ssl-key');
    expect((error as Error).message).toContain('ENOENT');
    expect((error as Error).message).not.toContain('secret-name');
  });
});

describe('importMysql2', () => {
  it('names the install command when mysql2 is not installed — for the default connection and for one of its own', async () => {
    const missing = () => Promise.reject(Object.assign(new Error("Cannot find package 'mysql2' imported from /app/dist/mysql.js"), { code: 'ERR_MODULE_NOT_FOUND' }));
    expect(MYSQL_INSTALL).toBe('pnpm add mysql2@^3');
    await expect(importMysql2(missing)).rejects.toThrow('DB_DRIVER=mysql needs the "mysql2" package, which is not installed in this app: pnpm add mysql2@^3');
    await expect(importMysql2(missing, 'reporting')).rejects.toThrow('The MySQL connection "reporting" needs the "mysql2" package');
  });

  it('refuses a version older than 3.24.6 and one of an unknown form, and takes the one it asks for or a newer one', async () => {
    const mysql2 = { TypedParameter: { LONGLONG: () => 0 } } as never;
    const load = () => Promise.resolve({ default: mysql2 } as never);
    await expect(importMysql2(load, 'default', () => '3.24.5')).rejects.toThrow('DB_DRIVER=mysql needs "mysql2" 3.x from 3.24.6 on, and this app has "3.24.5": pnpm add mysql2@^3');
    await expect(importMysql2(load, 'reporting', () => '2.9.9')).rejects.toThrow('The MySQL connection "reporting" needs "mysql2" 3.x from 3.24.6 on');
    await expect(importMysql2(load, 'default', () => 'latest')).rejects.toThrow('this app has "latest"');
    await expect(importMysql2(load, 'default', () => undefined)).rejects.toThrow('needs "mysql2" 3.x from 3.24.6 on');
    await expect(importMysql2(load, 'default', () => '4.0.0')).rejects.toThrow('this app has "4.0.0": pnpm add mysql2@^3');
    for (const version of ['3.24.6', '3.25.0', '3.24.7-beta.1']) await expect(importMysql2(load, 'default', () => version), version).resolves.toBe(mysql2);
  });

  it('takes mysql2 from `default` — under plain Node its TypedParameter is only there — and refuses a module that has none', async () => {
    const typed = { TypedParameter: { LONGLONG: () => 0 }, createPool: () => 0 };
    await expect(importMysql2(() => Promise.resolve({ default: typed, createPool: () => 1 } as never), 'default', () => '3.24.6')).resolves.toBe(typed);
    // a bundler may hand the module itself
    await expect(importMysql2(() => Promise.resolve(typed as never), 'default', () => '3.24.6')).resolves.toBe(typed);
    await expect(importMysql2(() => Promise.resolve({ createPool: () => 1 } as never), 'default', () => '3.24.6')).rejects.toThrow('TypedParameter could not be read');
    await expect(importMysql2(() => Promise.resolve({ default: { createPool: () => 1 } } as never), 'reporting', () => '3.24.6')).rejects.toThrow('The MySQL connection "reporting" needs "mysql2"');
  });

  it('reads the installed version from the package, which is new enough', async () => {
    await expect(importMysql2()).resolves.toHaveProperty('createPool');
  });

  it('lets any other failure through — a broken install, another missing package', async () => {
    const broken = new Error('Unexpected token');
    await expect(importMysql2(() => Promise.reject(broken))).rejects.toBe(broken);
    const other = Object.assign(new Error("Cannot find package 'iconv-lite' imported from mysql2"), { code: 'ERR_MODULE_NOT_FOUND' });
    await expect(importMysql2(() => Promise.reject(other))).rejects.toBe(other);
  });
});

describe('connectionError for mysql2', () => {
  const context = { name: 'default', target: 'mysql mysql://app:***@db:3306/shop' };
  const prefix = '[marmeon:D11] Could not connect to the database connection "default" (mysql mysql://app:***@db:3306/shop): ';

  it('puts the code in front of the server\u2019s message for a refused account and an unknown database', () => {
    expect(connectionError(context, Object.assign(new Error("Access denied for user 'app'@'10.0.0.2' (using password: YES)"), { code: 'ER_ACCESS_DENIED_ERROR' })).message).toBe(
      `${prefix}ER_ACCESS_DENIED_ERROR: Access denied for user 'app'@'10.0.0.2' (using password: YES)`,
    );
    expect(connectionError(context, Object.assign(new Error("Unknown database 'shop'"), { code: 'ER_BAD_DB_ERROR' })).message).toBe(`${prefix}ER_BAD_DB_ERROR: Unknown database 'shop'`);
  });

  it('says another code the way it says any error: its message, or its code when it has none', () => {
    expect(connectionError(context, Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:3306'), { code: 'ECONNREFUSED' })).message).toBe(`${prefix}connect ECONNREFUSED 10.0.0.2:3306`);
    expect(connectionError(context, Object.assign(new Error(''), { code: 'ECONNREFUSED' })).message).toBe(`${prefix}ECONNREFUSED`);
    expect(connectionError(context, Object.assign(new Error('Too many connections'), { code: 'ER_CON_COUNT_ERROR' })).message).toBe(`${prefix}Too many connections`);
  });
});

describe('textOnly', () => {
  it('returns the text of a statement without parameters, and throws for a value — nothing is ever formatted into the text', () => {
    expect(textOnly('select 1', undefined)).toBe('select 1');
    expect(textOnly('select 1', [])).toBe('select 1');
    expect(() => textOnly('select ?', [1])).toThrow(new TypeError('a value never goes into the text of a MySQL statement'));
    expect(() => textOnly('select ?', { a: 1 })).toThrow('a value never goes into the text');
    expect(() => textOnly('select ?', 'x')).toThrow(TypeError);
  });
});

describe('typeCast', () => {
  const field = (type: string, value: string | null, length = 11) => ({ type, length, string: () => value, buffer: () => (value === null ? null : Buffer.from(value, 'utf8')) }) as never;
  const refuseNext = () => {
    throw new Error('next() was called');
  };

  it('reads tinyint(1) as a boolean and other integers as they come', () => {
    expect(typeCast(field('TINY', '1', 1), refuseNext)).toBe(true);
    expect(typeCast(field('TINY', '0', 1), refuseNext)).toBe(false);
    expect(typeCast(field('TINY', null, 1), refuseNext)).toBeNull();
    expect(typeCast(field('TINY', '5', 4), () => 5)).toBe(5);
  });

  it('reads bigint as a number through next() — the binary protocol has no text for string() to read — and returns a marker instead of throwing beyond 2^53', () => {
    const binary = (type: string, _value: unknown) =>
      ({ type, length: 20, string: () => { throw new Error('string() reads a length-coded string; a binary LONGLONG is eight bytes'); } }) as never;
    expect(typeCast(binary('LONGLONG', '9007199254740991'), () => '9007199254740991')).toBe(9007199254740991);
    expect(typeCast(binary('LONGLONG', null), () => null)).toBeNull();
    const failure = typeCast(binary('LONGLONG', '9007199254740993'), () => '9007199254740993');
    expect(failure).toBeInstanceOf(CastFailure);
    expect((failure as CastFailure).error).toEqual(new RangeError('bigint value 9007199254740993 does not fit a JavaScript number; cast it to text in the query.'));
    expect(typeCast(binary('LONGLONG', '18446744073709551615'), () => '18446744073709551615')).toBeInstanceOf(CastFailure);
  });

  it('reads a float with 6 significant digits, as MySQL’s text protocol writes it, so the binary 1.100000023841858 is 1.1 and 1.2345678 is 1.23457', () => {
    expect(typeCast(field('FLOAT', null), () => 1.100000023841858)).toBe(1.1);
    expect(typeCast(field('FLOAT', null), () => 1.1)).toBe(1.1);
    expect(typeCast(field('FLOAT', null), () => Math.fround(1.2345678))).toBe(1.23457);
    expect(typeCast(field('FLOAT', null), () => 16777216)).toBe(16777200);
    // an exact tie goes to the even digit, as in the text protocol
    expect(typeCast(field('FLOAT', null), () => Math.fround(123456.5))).toBe(123456);
    expect(typeCast(field('FLOAT', null), () => Math.fround(123457.5))).toBe(123458);
    expect(typeCast(field('FLOAT', null), () => 1234565)).toBe(1234560);
    expect(typeCast(field('FLOAT', null), () => 999999.5)).toBe(1000000);
    expect(typeCast(field('FLOAT', null), () => -1234565)).toBe(-1234560);
    expect(typeCast(field('FLOAT', null), () => 0)).toBe(0);
    expect(typeCast(field('FLOAT', null), () => null)).toBeNull();
  });

  it('reads a time without the trailing zeros of its fraction, the same from the text protocol and the binary one', () => {
    expect(typeCast(field('TIME', '12:00:00.250'), refuseNext)).toBe('12:00:00.25');
    expect(typeCast(field('TIME', '12:00:00.25'), refuseNext)).toBe('12:00:00.25');
    expect(typeCast(field('TIME', '12:00:00.000'), refuseNext)).toBe('12:00:00');
    expect(typeCast(field('TIME', '-838:59:59.500000'), refuseNext)).toBe('-838:59:59.5');
    expect(typeCast(field('TIME', '10:00:00'), refuseNext)).toBe('10:00:00');
    expect(typeCast(field('TIME', null), refuseNext)).toBeNull();
  });

  it('reads datetimes as ISO-8601 UTC, dates and decimals as the text stored, and leaves the rest to mysql2', () => {
    expect(typeCast(field('DATETIME', '2026-10-01 12:34:56.789'), refuseNext)).toBe('2026-10-01T12:34:56.789Z');
    expect(typeCast(field('TIMESTAMP', '2026-10-01 12:34:56'), refuseNext)).toBe('2026-10-01T12:34:56.000Z');
    expect(typeCast(field('DATETIME', null), refuseNext)).toBeNull();
    expect(typeCast(field('DATE', '2026-10-01'), refuseNext)).toBe('2026-10-01');
    expect(typeCast(field('NEWDECIMAL', '12.50'), refuseNext)).toBe('12.50');
    expect(typeCast(field('JSON', '{"id":9007199254740993,"name":"Zoë","list":[1.5,9007199254740993]}'), refuseNext)).toEqual(JSON.parse('{"id":9007199254740993,"name":"Zoë","list":[1.5,9007199254740993]}'));
    expect(typeCast(field('JSON', 'null'), refuseNext)).toBeNull();
    expect(typeCast(field('JSON', null), refuseNext)).toBeNull();
    expect(typeCast(field('JSON', '"text"'), refuseNext)).toBe('text');
    expect(typeCast(field('JSON', '{broken'), refuseNext)).toBeInstanceOf(CastFailure);
    expect(typeCast(field('VAR_STRING', 'x'), () => 'x')).toBe('x');
  });
});

const dialects: Kysely<any>[] = [];
const drops: (() => Promise<void>)[] = [];

/** A fresh database on the server and a Kysely on the dialect alone: nothing between the test and the pool. */
async function open(options: { poolMax?: number; connectTimeoutMs?: number; onIdleError?: (error: Error) => void } = {}) {
  const fresh = await freshDatabase('mysql');
  drops.push(fresh.drop);
  const url = fresh.options.driver === 'mysql' ? fresh.options.url : '';
  const db = new Kysely<any>({ dialect: createMysqlDialect({ url, ...options }) });
  dialects.push(db);
  return { db, url };
}

afterEach(async () => {
  await Promise.all(dialects.splice(0).map((db) => db.destroy()));
  for (const drop of drops.splice(0)) await drop();
});

withMysql('values on MySQL', () => {
  it('come back as the same JavaScript types as on SQLite and Postgres, from the text protocol and from a prepared statement alike', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table kinds (id bigint auto_increment primary key, flag boolean not null, big bigint, huge bigint unsigned, price decimal(10, 2), doc json, born date, at datetime(3), stamp timestamp(3) null, whole datetime(3), ratio float, took time(3), bytes blob, label varchar(40))`.execute(db);
    const at = new Date('2026-10-01T12:34:56.789Z');
    await sql`insert into kinds (flag, big, huge, price, doc, born, at, stamp, whole, ratio, took, bytes, label) values (${true}, ${9007199254740991n}, ${9007199254740991n}, ${'12.50'}, ${JSON.stringify({ theme: 'dark', list: [1, 2] })}, ${'2026-10-01'}, ${at}, ${at}, ${'2026-10-01 12:00:00.000'}, ${1.1}, ${'12:00:00.250'}, ${new Uint8Array([1, 2, 255])}, ${null})`.execute(db);
    await sql`insert into kinds (flag, doc) values (${false}, ${JSON.stringify([1, 'two', null])})`.execute(db);
    // Without parameters the result comes over the text protocol, with one from a prepared statement in binary.
    const text = (await sql<Record<string, unknown>>`select * from kinds order by id`.execute(db)).rows;
    const binary = (await sql<Record<string, unknown>>`select * from kinds where id > ${0} order by id`.execute(db)).rows;
    expect(binary).toEqual(text);
    expect(text[0]).toEqual({
      id: 1,
      flag: true,
      big: 9007199254740991,
      huge: 9007199254740991,
      price: '12.50',
      doc: { theme: 'dark', list: [1, 2] },
      born: '2026-10-01',
      at: '2026-10-01T12:34:56.789Z',
      stamp: '2026-10-01T12:34:56.789Z',
      whole: '2026-10-01T12:00:00.000Z',
      ratio: 1.1,
      took: '12:00:00.25',
      bytes: expect.any(Uint8Array),
      label: null,
    });
    expect([...(text[0]!.bytes as Uint8Array)]).toEqual([1, 2, 255]);
    expect(text[1]).toMatchObject({ id: 2, flag: false, big: null, doc: [1, 'two', null], at: null, ratio: null, took: null });
  });

  it('read JSON as JSON.parse does, from either protocol: an integer beyond 2^53 stays a number, and umlauts arrive', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table docs (id int primary key, doc json)`.execute(db);
    const text = '{"id":9007199254740993,"name":"Zoë Müller","list":[1.5,9007199254740993,"ä"],"none":null}';
    await sql`insert into docs values (1, ${text}), (2, ${'[9007199254740992, 1]'}), (3, null), (4, ${'null'})`.execute(db);
    const textRows = (await sql<{ doc: unknown }>`select doc from docs order by id`.execute(db)).rows;
    const binaryRows = (await sql<{ doc: unknown }>`select doc from docs where id > ${0} order by id`.execute(db)).rows;
    expect(binaryRows).toEqual(textRows);
    expect(textRows.map((row) => row.doc)).toEqual([JSON.parse(text), [9007199254740992, 1], null, null]);
  });

  it('read a float the same from either protocol: with 6 significant digits, whatever the stored float32 has more of', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table floats (id int primary key, f float)`.execute(db);
    await sql`insert into floats values (1, ${1.2345678}), (2, ${16777217}), (3, ${1.1}), (4, ${-0.000123456789}), (5, ${123456.5}), (6, ${1234565})`.execute(db);
    const text = (await sql<{ f: number }>`select f from floats order by id`.execute(db)).rows;
    const binary = (await sql<{ f: number }>`select f from floats where id > ${0} order by id`.execute(db)).rows;
    expect(binary).toEqual(text);
    expect(text.map((row) => row.f)).toEqual([1.23457, 16777200, 1.1, -0.000123457, 123456, 1234560]);
  });

  it('throw a RangeError for a bigint beyond 2^53 instead of rounding it — after the whole result was read, so the connection goes on — from either protocol', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table ids (id bigint primary key)`.execute(db);
    await sql`insert into ids values (${1n}), (${9007199254740993n}), (${3n})`.execute(db);
    await db.connection().execute(async (lease) => {
      const { rows } = await sql<{ id: number }>`select connection_id() as id`.execute(lease);
      for (const read of [sql`select id from ids order by id`, sql`select id from ids where id > ${0} order by id`]) {
        const error = await read.execute(lease).then(() => undefined, (caught: unknown) => caught);
        expect(error).toEqual(new RangeError('bigint value 9007199254740993 does not fit a JavaScript number; cast it to text in the query.'));
        // the same connection, in step with the server
        expect((await sql<{ id: number }>`select connection_id() as id`.execute(lease)).rows).toEqual(rows);
        expect((await sql<{ one: number }>`select ${1} as one`.execute(lease)).rows).toEqual([{ one: 1 }]);
      }
      // a stream too: the error comes with the row, and the next statement works
      const streamed = async () => {
        for await (const _chunk of lease.getExecutor().stream(sql`select id from ids where id > ${0} order by id`.compile(lease), 1)) void _chunk;
      };
      await expect(streamed()).rejects.toThrow(RangeError);
      expect((await sql<{ id: number }>`select connection_id() as id`.execute(lease)).rows).toEqual(rows);
    });
    // Cast to text, as the message says.
    expect((await sql<{ id: string }>`select cast(id as char) as id from ids where id = ${9007199254740993n}`.execute(db)).rows).toEqual([{ id: '9007199254740993' }]);
  });

  it('accept a Date and a datetime literal in the session’s time zone, in an insert and in a where', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table events (id int primary key, at datetime(3) not null)`.execute(db);
    await sql`insert into events values (1, ${new Date('2026-10-01T12:00:00.000Z')})`.execute(db);
    await sql`insert into events values (2, '2026-10-02 12:00:00.000')`.execute(db);
    expect((await sql<{ id: number }>`select id from events where at = ${new Date('2026-10-02T12:00:00.000Z')}`.execute(db)).rows).toEqual([{ id: 2 }]);
    expect((await sql<{ at: string }>`select at from events where id = 1`.execute(db)).rows).toEqual([{ at: '2026-10-01T12:00:00.000Z' }]);
  });

  it('refuse a datetime literal that ends in Z in an insert, though a where compares it — the form the other drivers return cannot be written back as it is read', { timeout: 30_000 }, async () => {
    // The probe: what MySQL does with `…Z` in an insert and in a where. Pinned either way; whoever writes timestamps as text reads it.
    const { db } = await open();
    await sql`create table events (id int primary key, at datetime(3) not null)`.execute(db);
    await sql`insert into events values (1, '2026-10-01 12:00:00.000')`.execute(db);
    const insert = await sql`insert into events values (2, '2026-10-01T12:00:00.000Z')`.execute(db).then(() => 'accepted', (caught: unknown) => caught);
    const where = await sql`select id from events where at = '2026-10-01T12:00:00.000Z'`.execute(db).then((result) => result.rows, (caught: unknown) => caught);
    const outcome = { insert: insert === 'accepted' ? 'accepted' : (insert as { code?: string }).code, where: Array.isArray(where) ? where : (where as { code?: string }).code };
    expect(outcome).toEqual({ insert: 'ER_TRUNCATED_WRONG_VALUE', where: [{ id: 1 }] });
  });

  it('compare text in binary: "A" is not "a" on a utf8mb4_0900_bin column, and in a literal', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table names (name varchar(40) not null)`.execute(db);
    await sql`insert into names values ('a')`.execute(db);
    expect((await sql<{ same: number }>`select 'A' = 'a' as same`.execute(db)).rows).toEqual([{ same: 0 }]);
    expect((await sql<{ name: string }>`select name from names where name = ${'A'}`.execute(db)).rows).toEqual([]);
    expect((await sql<{ name: string }>`select name from names where name = ${'a'}`.execute(db)).rows).toEqual([{ name: 'a' }]);
  });

  it('read || as concatenation and "x" as an identifier', { timeout: 30_000 }, async () => {
    const { db } = await open();
    expect((await sql<{ joined: string }>`select 'a' || 'b' as joined`.execute(db)).rows).toEqual([{ joined: 'ab' }]);
    await sql`create table "quoted name" ("x" int)`.execute(db);
    await sql`insert into "quoted name" ("x") values (7)`.execute(db);
    expect((await sql<{ x: number }>`select "x" from "quoted name"`.execute(db)).rows).toEqual([{ x: 7 }]);
  });

  it('write a backslash and a quote as what they are, whatever the server’s mode', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table notes (id int auto_increment primary key, body text not null)`.execute(db);
    const body = "it's a \\' trick \\\\ '; drop table notes; --";
    await sql`insert into notes (body) values (${body})`.execute(db);
    expect((await sql<{ body: string }>`select body from notes`.execute(db)).rows).toEqual([{ body }]);
  });

  it('are refused as parameters when SQLite would refuse them: an object, an array, undefined, NaN and an Invalid Date', { timeout: 30_000 }, async () => {
    const { db } = await open();
    for (const value of [{ a: 1 }, [1, 2], undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN), Symbol('x')]) {
      const error = await sql`select ${value as never} as v`.execute(db).then(() => undefined, (caught: unknown) => caught);
      expect(error, String(value)).toBeInstanceOf(TypeError);
      expect((error as Error).message).toMatch(/^MySQL cannot take parameter 1/);
    }
  });
});

withMysql('the session of a MySQL connection', () => {
  it('runs in UTF-8, the binary collation, UTC and the strict, ANSI-flavoured mode — on every connection of the pool', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 2 });
    const read = (on: Kysely<any>) => sql<Record<string, string>>`select @@session.session_track_schema as track_schema, @@session.sql_mode as sql_mode, @@session.time_zone as time_zone, @@collation_connection as collation, @@character_set_client as client, @@autocommit as autocommit, connection_id() as id`.execute(on);
    // Two connections held at once: each lease waits until both have read, so they are two connections of the pool.
    let reading = 0;
    let both!: () => void;
    const bothRead = new Promise<void>((resolve) => (both = resolve));
    const hold = () =>
      db.connection().execute(async (held) => {
        const { rows } = await read(held);
        if (++reading === 2) both();
        await bothRead;
        return { rows };
      });
    const [first, second] = await Promise.all([hold(), hold()]);
    expect(first.rows[0]!.id).not.toBe(second.rows[0]!.id);
    for (const { rows } of [first, second]) {
      expect(rows[0]).toMatchObject({ time_zone: '+00:00', collation: 'utf8mb4_0900_bin', client: 'utf8mb4' });
      expect(Number(rows[0]!.autocommit)).toBe(1);
      expect(Number(rows[0]!.track_schema)).toBe(1);
      expect(rows[0]!.sql_mode!.split(',').toSorted()).toEqual(
        ['ANSI_QUOTES', 'ERROR_FOR_DIVISION_BY_ZERO', 'NO_ENGINE_SUBSTITUTION', 'NO_ZERO_DATE', 'NO_ZERO_IN_DATE', 'ONLY_FULL_GROUP_BY', 'PIPES_AS_CONCAT', 'STRICT_ALL_TABLES', 'STRICT_TRANS_TABLES'],
      );
    }
  });

  /** The SQL texts of the prepared statements the connection of this lease holds on the server. */
  const instances = async (on: Kysely<any>) =>
    (await sql<{ sql_text: string }>`select sql_text from performance_schema.prepared_statements_instances where owner_thread_id = ps_current_thread_id() order by sql_text`.execute(on)).rows.map((row) => row.sql_text);

  it('never puts a value into the statement text: the server holds the statement with its ? and the payload only as a value', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const payload = "x' or 1=1 -- \\";
    await db.transaction().execute(async (trx) => {
      expect((await sql<{ x: string }>`select ${payload} as x`.execute(trx)).rows).toEqual([{ x: payload }]);
      const held = await instances(trx);
      expect(held).toEqual(['select ? as x']);
      expect(held.join('\n')).not.toContain('or 1=1');
    });
  });

  it('refuses a value that was written into a comment — the server counts no ? in `/* */` or in a `/*+ */` hint — and binds one in `/*! */` as data', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table t (id int primary key)`.execute(db);
    await sql`insert into t values (1), (2)`.execute(db);
    const comment = await sql`select ${1} as x /* ${2} */`.execute(db).then(() => undefined, (caught: unknown) => caught);
    expect(comment).toEqual(new TypeError('MySQL sees 1 placeholders in the statement and 2 parameters were given; a ? inside a comment, a string or a "name" is not one.'));
    const hint = await sql`select /*+ MAX_EXECUTION_TIME(${1000}) */ ${1} as x`.execute(db).then(() => undefined, (caught: unknown) => caught);
    expect((hint as Error).message).toMatch(/^MySQL sees 1 placeholders in the statement and 2 parameters were given/);
    // MySQL runs the inside of `/*! */`, and its ? is a placeholder: the payload that tries to close the comment is only a value.
    const payload = '*/ where 1 = 1 -- ';
    expect((await sql<{ id: number }>`select id from t /*! where id = ${payload} */`.execute(db)).rows).toEqual([]);
  });

  it('refuses every statement once the app switched on NO_BACKSLASH_ESCAPES — the names and JSON paths Kysely writes are escaped for the other mode — and the next lease is a new connection in the mode Marmeon sets', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table notes (id int auto_increment primary key, body text not null)`.execute(db);
    await sql`insert into notes (body) values ('kept')`.execute(db);
    const heldId = await db.connection().execute(async (held) => {
      const { rows } = await sql<{ id: number }>`select connection_id() as id`.execute(held);
      await sql`set session sql_mode = concat(@@sql_mode, ',NO_BACKSLASH_ESCAPES')`.execute(held);
      for (const run of [() => sql`insert into notes (body) values (${"\\'), ('injected"})`.execute(held), () => sql`select 1`.execute(held)]) {
        const error = await run().then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(DatabaseConnectionError);
        expect((error as Error).message).toMatch(/^\[marmeon:D28\] The MySQL connection "default" was refused: the session's sql_mode has NO_BACKSLASH_ESCAPES/);
      }
      return rows[0]!.id;
    });
    const { rows } = await sql<{ body: string; mode: string; id: number }>`select body, @@session.sql_mode as mode, connection_id() as id from notes`.execute(db);
    expect(rows).toEqual([{ body: 'kept', mode: expect.not.stringContaining('NO_BACKSLASH_ESCAPES'), id: expect.any(Number) }]);
    expect(rows[0]!.id).not.toBe(heldId);
  });

  it('refuses every statement after `set names latin1` — the server says so in the OK packet — even one with an ASCII parameter', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await db.connection().execute(async (lease) => {
      await sql`set names latin1`.execute(lease);
      const error = await sql`select ${'Zoe'} as v`.execute(lease).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(DatabaseConnectionError);
      expect((error as Error).message).toContain('character_set_client is "latin1"');
    });
  });

  it('replaces a connection whose last statement changed the session, so the next lease runs its first statement instead of being refused', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const id = async (on: Kysely<any>) => (await sql<{ id: number }>`select connection_id() as id`.execute(on)).rows[0]!.id;
    for (const change of ['set names latin1', "set session sql_mode = concat(@@sql_mode, ',NO_BACKSLASH_ESCAPES')"]) {
      const held = await db.connection().execute(async (lease) => {
        const before = await id(lease);
        await sql.raw(change).execute(lease);
        return before;
      });
      expect(await id(db)).not.toBe(held);
    }
  });

  it('sees a streamed `set names` as well: the OK packet is the stream’s one row', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const error = await db.connection().execute(async (lease) => {
      for await (const _chunk of lease.getExecutor().stream(sql`set names latin1`.compile(lease), 1)) void _chunk;
      return sql`select 1 as v`.execute(lease).then(() => undefined, (caught: unknown) => caught);
    });
    expect(error).toBeInstanceOf(DatabaseConnectionError);
  });

  it('does not take a streamed row for an OK packet because of its column names', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await db.connection().execute(async (lease) => {
      const rows: unknown[] = [];
      for await (const chunk of lease.getExecutor().stream(sql`select 0 as affectedRows, 512 as serverStatus`.compile(lease), 1)) rows.push(...chunk.rows);
      expect(rows).toEqual([{ affectedRows: 0, serverStatus: 512 }]);
      expect((await sql<{ one: number }>`select 1 as one`.execute(lease)).rows).toEqual([{ one: 1 }]);
    });
  });

  it('keeps a value a value when the session is changed where no packet says so — tracking switched off, `set names latin1` — and a quote and a backslash are stored as they are', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table notes (id int auto_increment primary key, body text not null)`.execute(db);
    const body = "\\'; drop table notes; -- it's a \\\\ trick '";
    // The limit of the check: without session tracking the server tells nothing, and the lease goes on. The value is not parsed in any case.
    await db.connection().execute(async (lease) => {
      await sql`set session session_track_system_variables = ''`.execute(lease);
      await sql`set names latin1`.execute(lease);
      await sql`insert into notes (body) values (${body})`.execute(lease);
    });
    expect((await sql<{ body: string }>`select body from notes`.execute(db)).rows).toEqual([{ body }]);
  });

  it('does not fall back to text for a statement MySQL cannot prepare: it fails with ER_UNSUPPORTED_PS', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table t (id int primary key)`.execute(db);
    const error = await db.connection().execute((lease) => sql.raw('handler t open').execute(lease).then(() => sql`handler t read first where id = ${1}`.execute(lease).then(() => undefined, (caught: unknown) => caught)));
    expect(error).toMatchObject({ code: 'ER_UNSUPPORTED_PS' });
  });

  it('sends a bigint as a 64-bit integer: the ends of the signed and the unsigned range round trip, and 9007199254740993 does not match …992', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table big (id int primary key, n bigint, u bigint unsigned)`.execute(db);
    await sql`insert into big values (1, ${2n ** 63n - 1n}, ${2n ** 64n - 1n}), (2, ${-(2n ** 63n)}, ${0n}), (3, ${9007199254740992n}, null)`.execute(db);
    expect((await sql<Record<string, string | null>>`select id, cast(n as char) as n, cast(u as char) as u from big order by id`.execute(db)).rows).toEqual([
      { id: 1, n: '9223372036854775807', u: '18446744073709551615' },
      { id: 2, n: '-9223372036854775808', u: '0' },
      { id: 3, n: '9007199254740992', u: null },
    ]);
    expect((await sql<{ id: number }>`select id from big where n = ${9007199254740993n}`.execute(db)).rows).toEqual([]);
    expect((await sql<{ id: number }>`select id from big where n = ${9007199254740992n}`.execute(db)).rows).toEqual([{ id: 3 }]);
    // A bigint parameter is a bigint on the server, not text: it comes back as the number a `bigint` column is.
    expect((await sql<{ v: number }>`select ${5n} as v`.execute(db)).rows).toEqual([{ v: 5 }]);
    const error = await sql`select ${2n ** 64n}`.execute(db).then(() => undefined, (caught: unknown) => caught);
    expect((error as Error).message).toContain('does not fit a bigint');
  });

  it('runs a bigint parameter under plain Node, not through Vite: mysql2 keeps TypedParameter on its default export there', { timeout: 60_000 }, async () => {
    const { url } = await open();
    const mysqlModule = fileURLToPath(new URL('./mysql.ts', import.meta.url));
    const script =
      `import { Kysely, sql } from 'kysely'; import { createMysqlDialect } from ${JSON.stringify(mysqlModule)};` +
      `const db = new Kysely({ dialect: createMysqlDialect({ url: process.env.SMOKE_URL, poolMax: 1 }) });` +
      `try { const { rows } = await sql\`select \${5n} as v, cast(\${2n ** 63n} as char) as w\`.execute(db); console.log(JSON.stringify(rows.map((row) => [row.v, typeof row.w]))); } finally { await db.destroy(); }`;
    const child = spawn(process.execPath, ['--conditions=@marmeon/source', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, SMOKE_URL: url, NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => void child.kill());
    const timer = setTimeout(() => child.kill(), 40_000);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    clearTimeout(timer);
    expect(err.split('\n').filter((line) => !line.includes('Warning') && !line.includes('--trace') && line.trim() !== '')).toEqual([]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual([[5, 'string']]);
  });

  it('reads the new database after a `use`, also for a statement text that was prepared before it', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const other = await freshDatabase('mysql');
    drops.push(other.drop);
    const otherName = new URL(other.options.driver === 'mysql' ? other.options.url : '').pathname.slice(1);
    await sql`create table t (id int primary key, v varchar(10))`.execute(db);
    await sql`insert into t values (1, 'home')`.execute(db);
    await sql.raw(`create table \`${otherName}\`.t (id int primary key, v varchar(10))`).execute(db);
    await sql.raw(`insert into \`${otherName}\`.t values (1, 'other')`).execute(db);
    const read = (on: Kysely<any>) => sql<{ v: string }>`select v from t where id = ${1}`.execute(on);
    const seen = await db.connection().execute(async (lease) => {
      const before = (await read(lease)).rows;
      await sql.raw(`use \`${otherName}\``).execute(lease);
      return [before, (await read(lease)).rows];
    });
    expect(seen).toEqual([[{ v: 'home' }], [{ v: 'other' }]]);
  });

  it('reads the new database after a `use` for the statements used last, though more than 16 texts were prepared before it', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const other = await freshDatabase('mysql');
    drops.push(other.drop);
    const otherName = new URL(other.options.driver === 'mysql' ? other.options.url : '').pathname.slice(1);
    await sql`create table t (id int primary key, v varchar(10))`.execute(db);
    await sql`insert into t values (1, 'home')`.execute(db);
    await sql.raw(`create table \`${otherName}\`.t (id int primary key, v varchar(10))`).execute(db);
    await sql.raw(`insert into \`${otherName}\`.t values (1, 'other')`).execute(db);
    const read = (on: Kysely<any>, n: number) => sql<Record<string, string>>`select v as ${sql.ref(`c${n}`)} from t where id = ${1}`.execute(on);
    const seen = await db.connection().execute(async (lease) => {
      for (let n = 0; n < 100; n += 1) await read(lease, n);
      await sql.raw(`use \`${otherName}\``).execute(lease);
      const after: unknown[] = [];
      for (let n = 84; n < 100; n += 1) after.push(Object.values((await read(lease, n)).rows[0]!)[0]);
      return after;
    });
    expect(seen).toEqual(Array.from({ length: 16 }, () => 'other'));
  });

  it('keeps at most 16 prepared statements per lease, and none on the connection after it went back', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const id = async (on: Kysely<any>) => (await sql<{ id: number }>`select connection_id() as id`.execute(on)).rows[0]!.id;
    const during = await db.connection().execute(async (lease) => {
      for (let n = 0; n < 20; n += 1) await sql`select ${n} as ${sql.ref(`c${n}`)}`.execute(lease);
      return { id: await id(lease), held: (await instances(lease)).length };
    });
    expect(during.held).toBe(16);
    await db.connection().execute(async (lease) => {
      expect(await id(lease)).toBe(during.id); // the same connection, reset
      expect(await instances(lease)).toEqual([]);
    });
  });

  it('binds the parameters right behind a name in double quotes that ends in a backslash — a query and a stream', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table t (id int primary key, b varchar(10), "a\\" int)`.execute(db);
    await sql`insert into t values (${1}, ${'x'}, ${7}), (${2}, ${'y'}, ${8})`.execute(db);
    const read = sql<{ v: number }>`select "a\\" as v from t where id = ${2} and b = ${'y'}`;
    expect((await read.execute(db)).rows).toEqual([{ v: 8 }]);
    const streamed: unknown[] = [];
    await db.connection().execute(async (lease) => {
      for await (const chunk of lease.getExecutor().stream(read.compile(lease), 1)) streamed.push(...chunk.rows);
    });
    expect(streamed).toEqual([{ v: 8 }]);
  });

  it('is not held by a stream that was read once and left: the lease ends, and the next one works on the pool of one', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    await sql`create table numbers (n int primary key)`.execute(db);
    await sql`insert into numbers values (1), (2), (3)`.execute(db);
    await db.connection().execute(async (lease) => {
      const iterator = lease.selectFrom('numbers').selectAll().orderBy('n').stream()[Symbol.asyncIterator]();
      await iterator.next(); // once, and never again
    });
    expect((await sql<{ n: number }>`select count(*) as n from numbers`.execute(db)).rows).toEqual([{ n: 3 }]);
    expect((await sql<{ n: number }>`select count(*) as n from numbers`.execute(db)).rows).toEqual([{ n: 3 }]);
  });

  it('sets a connection up again after each return: the second lease on it has the session of Marmeon, not the server’s defaults', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const read = (on: Kysely<any>) => sql<{ id: number; collation: string; zone: string; mode: string }>`select connection_id() as id, @@collation_connection as collation, @@session.time_zone as zone, @@session.sql_mode as mode`.execute(on);
    const first = (await read(db)).rows[0]!;
    const second = (await read(db)).rows[0]!;
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ collation: 'utf8mb4_0900_bin', zone: '+00:00', mode: expect.stringContaining('ANSI_QUOTES') });
  });

  it('hands a connection back reset: nothing of what a lease left on it reaches the next one', { timeout: 60_000 }, async () => {
    const { db, url } = await open({ poolMax: 1 });
    const admin = new Kysely<any>({ dialect: createMysqlDialect({ url, poolMax: 1 }) });
    dialects.push(admin);
    await sql`create table notes (id int auto_increment primary key, body text not null)`.execute(db);
    await sql`create table parent (id int primary key)`.execute(db);
    await sql`create table child (id int primary key, parent_id int, foreign key (parent_id) references parent (id))`.execute(db);
    await sql`insert into notes (body) values ('kept')`.execute(db);
    const same = async () => (await sql<{ id: number }>`select connection_id() as id`.execute(db)).rows[0]!.id;
    const first = await same();

    // lock tables: another connection can read the table afterwards
    await db.connection().execute(async (lease) => void (await sql`lock tables notes write`.execute(lease)));
    expect((await sql<{ n: number }>`select count(*) as n from notes`.execute(admin)).rows).toEqual([{ n: 1 }]);
    // get_lock: obtainable from another connection afterwards
    await db.connection().execute(async (lease) => void (await sql`select get_lock(concat(database(), ':leak'), 1)`.execute(lease)));
    expect((await sql<{ got: number }>`select get_lock(${`${new URL(url).pathname.slice(1)}:leak`}, 0) as got`.execute(admin)).rows).toEqual([{ got: 1 }]);
    // user variable, sql_select_limit, foreign_key_checks
    await db.connection().execute(async (lease) => void (await sql`set @leak = 1, sql_select_limit = 1, foreign_key_checks = 0`.execute(lease)));
    expect((await sql<{ leak: unknown; limit: string; checks: number }>`select @leak as leak, cast(@@sql_select_limit as char) as \`limit\`, @@foreign_key_checks as checks`.execute(db)).rows).toEqual([
      { leak: null, limit: '18446744073709551615', checks: 1 },
    ]);
    expect((await sql`insert into child values (1, 99)`.execute(db).then(() => 'inserted', (caught: unknown) => (caught as { code?: string }).code))).toBe('ER_NO_REFERENCED_ROW_2');
    // a raw begin with a write, and a streamed one: the rows are not committed, and the next lease writes by autocommit
    await db.connection().execute(async (lease) => {
      await sql`begin`.execute(lease);
      await sql`insert into notes (body) values ('open')`.execute(lease);
    });
    await db.connection().execute(async (lease) => {
      for await (const _chunk of lease.getExecutor().stream(sql`begin`.compile(lease), 1)) void _chunk;
      await sql`insert into notes (body) values ('streamed open')`.execute(lease);
    });
    await sql`insert into notes (body) values ('autocommitted')`.execute(db);
    expect((await sql<{ body: string }>`select body from notes order by id`.execute(admin)).rows).toEqual([{ body: 'kept' }, { body: 'autocommitted' }]);
    // the reset does not take the connection away: all of this ran on one
    expect(await same()).toBe(first);
  });

  it('does not give a connection back that the app moved to another database with `use` — the next lease is in the URL’s database, on a new connection', { timeout: 30_000 }, async () => {
    const { db } = await open({ poolMax: 1 });
    const other = await freshDatabase('mysql');
    drops.push(other.drop);
    const otherName = new URL(other.options.driver === 'mysql' ? other.options.url : '').pathname.slice(1);
    const home = (await sql<{ name: string }>`select database() as name`.execute(db)).rows[0]!.name;
    const first = await db.connection().execute(async (held) => {
      await sql.raw(`use \`${otherName}\``).execute(held);
      return (await sql<{ id: number; name: string }>`select connection_id() as id, database() as name`.execute(held)).rows[0]!;
    });
    expect(first.name).toBe(otherName);
    const second = (await sql<{ id: number; name: string }>`select connection_id() as id, database() as name`.execute(db)).rows[0]!;
    expect(second.name).toBe(home);
    expect(second.id).not.toBe(first.id);
  });

  it('refuses a multiple-statements query: one statement per query', { timeout: 30_000 }, async () => {
    const { db } = await open();
    const error = await sql`select 1 as one; select 2 as two`.execute(db).then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ER_PARSE_ERROR' });
  });

  it('survives an idle connection killed by another session: the pool replaces it, the error goes to onIdleError', { timeout: 30_000 }, async () => {
    const idle: Error[] = [];
    let notify!: () => void;
    const idled = new Promise<void>((resolve) => (notify = resolve));
    const fresh = await freshDatabase('mysql');
    drops.push(fresh.drop);
    const url = fresh.options.driver === 'mysql' ? fresh.options.url : '';
    // The pool is built here, to know when the connection is back in it: it is reset, set up and read before that, and a kill during it
    // would end a connection that is not idle.
    const mysql2 = await importMysql2();
    const rawPool = mysql2.createPool({ ...mysqlConnection(url), connectionLimit: 1, waitForConnections: false, resetOnRelease: false });
    const back = new Promise<void>((resolve) => rawPool.once('release', () => resolve()));
    const pool = guardedPool(rawPool as unknown as MysqlPool, {
      poolMax: 1,
      integer: (value, unsigned) => (unsigned ? mysql2.TypedParameter.LONGLONG.unsigned(value) : mysql2.TypedParameter.LONGLONG(value)),
      onIdleError: (error) => {
        idle.push(error);
        notify();
      },
    });
    const db = new Kysely<any>({ dialect: new MysqlDialect({ pool: async () => pool }) });
    dialects.push(db);
    const admin = new Kysely<any>({ dialect: createMysqlDialect({ url, poolMax: 1 }) });
    dialects.push(admin);
    const { rows } = await sql<{ id: number }>`select connection_id() as id`.execute(db);
    await back;
    await sql`kill ${sql.lit(rows[0]!.id)}`.execute(admin);
    await idled;
    expect(idle).toHaveLength(1);
    expect((await sql<{ one: number }>`select 1 as one`.execute(db)).rows).toEqual([{ one: 1 }]);
  });
  it('fails the wait for a free connection within the connect timeout, saying that none was free', { timeout: 30_000 }, async () => {
    const fresh = await freshConnections('mysql');
    drops.push(fresh.close);
    const url = new URL((fresh.connections.options() as { url: string }).url);
    url.searchParams.set('connect_timeout', '1');
    const connections = new Connections({ connections: { default: { driver: 'mysql', url: url.href, poolMax: 1 } }, root: '/', logger: silent });
    try {
      await connections.get().connection().execute(async () => {
        const error = await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught);
        expect(error).toBeInstanceOf(DatabaseConnectionError);
        expect((error as Error).message).toMatch(/^\[marmeon:D11\] Could not connect to the database connection "default" \(mysql mysql:\/\/[^)]*\*\*\*@[^)]*\): no free connection within the connect timeout/);
      });
    } finally {
      await connections.destroy();
    }
  });
});

withMysql('reading the catalog of MySQL', () => {
  it('lists the columns of the base tables of the database in order, with their types and nullability, and leaves a view out', { timeout: 30_000 }, async () => {
    const { db } = await open();
    await sql`create table accounts (id bigint auto_increment primary key, email varchar(190) not null, nickname varchar(40), price decimal(10, 2) not null, doc json, at datetime(3) not null)`.execute(db);
    await sql`create table empty_one (Flag boolean not null)`.execute(db);
    await sql`create view account_emails as select email from accounts`.execute(db);
    const run = async <R>(text: string) => (await sql.raw<R>(text).execute(db)).rows;
    const { types, nullable } = await tableColumns(run, 'mysql');
    expect([...types.keys()]).toEqual(['accounts', 'empty_one']);
    expect([...types.get('accounts')!]).toEqual([
      ['id', 'bigint'],
      ['email', 'varchar(190)'],
      ['nickname', 'varchar(40)'],
      ['price', 'decimal(10,2)'],
      ['doc', 'json'],
      ['at', 'datetime(3)'],
    ]);
    expect([...types.get('empty_one')!]).toEqual([['Flag', 'tinyint(1)']]);
    expect([...nullable].toSorted()).toEqual(['accounts\0doc', 'accounts\0nickname']);
  });
});

withMysql('a Connections with a MySQL connection', () => {
  it('opens, runs queries, commits and rolls back, and reports the queries', { timeout: 30_000 }, async () => {
    const { connections, close } = await freshConnections('mysql');
    try {
      const queries: string[] = [];
      connections.onQuery((query) => queries.push(query.sql));
      const db = migratorConnection(connections);
      await sql`create table posts (id int auto_increment primary key, title varchar(80) not null)`.execute(db);
      await db.transaction().execute((trx) => sql`insert into posts (title) values (${'Kept'})`.execute(trx));
      await expect(
        db.transaction().execute(async (trx) => {
          await sql`insert into posts (title) values (${'Lost'})`.execute(trx);
          throw new Error('rolled back');
        }),
      ).rejects.toThrow('rolled back');
      expect((await sql<{ title: string }>`select title from posts`.execute(db)).rows).toEqual([{ title: 'Kept' }]);
      expect(queries.some((text) => text.startsWith('insert into posts'))).toBe(true);
    } finally {
      await close();
    }
  });

  it('names a connection that cannot be opened, with where it points and never the password', { timeout: 30_000 }, async () => {
    const url = new URL(MYSQL_URL!);
    const attempt = async (change: (url: URL) => void) => {
      const target = new URL(url.href);
      change(target);
      const connections = new Connections({ connections: { default: { driver: 'mysql', url: target.href } }, root: '/', logger: silent });
      try {
        return await sql`select 1`.execute(connections.get()).then(() => undefined, (caught: unknown) => caught as Error);
      } finally {
        await connections.destroy();
      }
    };
    const refused = await attempt((target) => (target.port = '1'));
    expect(refused).toBeInstanceOf(DatabaseConnectionError);
    expect(refused!.message).toMatch(/^\[marmeon:D11\] Could not connect to the database connection "default" \(mysql mysql:\/\/root:\*\*\*@127\.0\.0\.1:1\/marmeon\): .*ECONNREFUSED/);
    const denied = await attempt((target) => (target.password = 'hunter2-not-the-password'));
    expect(denied!.message).toContain('ER_ACCESS_DENIED_ERROR');
    expect(denied!.message).not.toContain('hunter2');
    const unknown = await attempt((target) => (target.pathname = '/no_such_database'));
    expect(unknown!.message).toContain('ER_BAD_DB_ERROR');
    expect(unknown!.message).not.toContain(url.password);
  });
});
