import type { Application, ModuleDefinition } from '@marmeon/core';
import { ValidationError } from '@marmeon/router';
import { sql, type Generated } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshConnections, withMysql } from './__fixtures__/databases.ts';
import { failOnDuplicate, isUniqueViolation, Migrator, missingTable, Repository, uniqueViolationColumns, type Connections } from './index.ts';
import type { SchemaMetadata } from './metadata.ts';
import { isMysqlDuplicate, mysqlDuplicateKey, uniqueIndexColumns } from './mysql-duplicates.ts';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';

// The MySQL cases run in `pnpm test:mysql`, which sets MARMEON_TEST_MYSQL_URL; the unit cases need no server.

const duplicate = (sqlMessage: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(sqlMessage), { errno: 1062, code: 'ER_DUP_ENTRY', sqlState: '23000', sqlMessage, ...extra });

describe('the duplicate-key error of MySQL', () => {
  it('names its table and index from the end of the text', () => {
    const error = duplicate(`Duplicate entry 'x' for key 'coupons.coupons_email_unique'`);
    expect(isMysqlDuplicate(error)).toBe(true);
    expect(isUniqueViolation(error)).toBe(true);
    expect(mysqlDuplicateKey(error)).toEqual({ table: 'coupons', index: 'coupons_email_unique' });
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry '1' for key 'coupons.PRIMARY'`))).toEqual({ table: 'coupons', index: 'PRIMARY' });
  });

  it('takes the last key when the duplicate value holds the text of a key', () => {
    const crafted = duplicate(`Duplicate entry 'x' for key 'coupons.coupons_email_unique' for key 'coupons.coupons_code_unique'`);
    expect(mysqlDuplicateKey(crafted)).toEqual({ table: 'coupons', index: 'coupons_code_unique' });
  });

  it('reads a value with a line break, and an error with the key name of errno 1586', () => {
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'a\nb' for key 'coupons.coupons_code_unique'`))).toEqual({ table: 'coupons', index: 'coupons_code_unique' });
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'a' for key 'coupons.coupons_code_unique'`, { errno: 1586 }))).toEqual({ table: 'coupons', index: 'coupons_code_unique' });
  });

  it('refuses what it cannot prove: a key without or with two dots, text after the key, another errno, no SQLSTATE', () => {
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key 'coupons_email_unique'`))).toBeUndefined();
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key 'a.b.c'`))).toBeUndefined();
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key '.c'`))).toBeUndefined();
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key 'a.'`))).toBeUndefined();
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key 'a.b' (more)`))).toBeUndefined();
    expect(mysqlDuplicateKey(duplicate(`Duplicate entry 'x' for key 'a.b'\n`))).toBeUndefined();
    const other = duplicate(`Duplicate entry 'x' for key 'a.b'`, { errno: 1452 });
    expect(isMysqlDuplicate(other)).toBe(false);
    expect(isUniqueViolation(other)).toBe(false);
    expect(mysqlDuplicateKey(other)).toBeUndefined();
    const bare = duplicate(`Duplicate entry 'x' for key 'a.b'`, { sqlState: undefined });
    expect(isMysqlDuplicate(bare)).toBe(false);
    expect(mysqlDuplicateKey(bare)).toBeUndefined();
    expect(isMysqlDuplicate(null)).toBe(false);
  });

  it('reads the message when the error has no sqlMessage', () => {
    const error = Object.assign(new Error(`Duplicate entry 'x' for key 'a.b'`), { errno: 1062, sqlState: '23000' });
    expect(mysqlDuplicateKey(error)).toEqual({ table: 'a', index: 'b' });
  });

  it('finds the columns by the exact name of a unique index, and finds none for a non-unique, partial or differently named one', () => {
    const index = (name: string, unique: boolean, extra: object = {}) => ({ name, columns: ['a'], unique, ...extra });
    const metadata = {
      primaryKeys: new Map([['t', ['id']]]),
      projection: { tables: new Map([['t', { indexes: [index('t_a_unique', true), index('t_plain', false), index('t_part', true, { where: { b: 1 } })] }]]) },
    } as unknown as SchemaMetadata;
    expect(uniqueIndexColumns(metadata, 't', 'PRIMARY')).toEqual(['id']);
    expect(uniqueIndexColumns(metadata, 't', 't_a_unique')).toEqual(['a']);
    expect(uniqueIndexColumns(metadata, 't', 't_plain')).toBeUndefined();
    expect(uniqueIndexColumns(metadata, 't', 't_part')).toBeUndefined();
    expect(uniqueIndexColumns(metadata, 't', 't_a')).toBeUndefined();
    expect(uniqueIndexColumns(metadata, 'other', 't_a_unique')).toBeUndefined();
    expect(uniqueIndexColumns(metadata, 'other', 'PRIMARY')).toBeUndefined();
  });

  it('gives no columns for an error that did not pass an app connection', () => {
    expect(uniqueViolationColumns(duplicate(`Duplicate entry 'x' for key 'coupons.coupons_email_unique'`))).toEqual([]);
  });

  it('names the missing table of errno 1146', () => {
    const missing = (sqlMessage: string) => Object.assign(new Error(sqlMessage), { errno: 1146, code: 'ER_NO_SUCH_TABLE', sqlState: '42S02', sqlMessage });
    expect(missingTable(missing(`Table 'app.users' doesn't exist`))).toBe('users');
    expect(missingTable(missing(`Something else`))).toBe('unknown');
    expect(missingTable(missing(`Table 'users' doesn't exist`))).toBe('unknown');
  });

  it('does not read a missing table out of another error that quotes the SQLite text, such as a duplicate value', () => {
    const sqlMessage = `Duplicate entry 'no such table: users' for key 'coupons.coupons_email_unique'`;
    expect(missingTable(Object.assign(new Error(sqlMessage), { errno: 1062, code: 'ER_DUP_ENTRY', sqlState: '23000', sqlMessage }))).toBeUndefined();
  });
});

interface CouponTables {
  coupons: { id: Generated<number>; email: string; code: string; note: string | null };
  slots: { slug: string; seats: Generated<number> };
  memberships: { id: Generated<number>; team_id: number; email: string; badge: string | null };
}

class Slots extends Repository<'slots', CouponTables> {
  static table = 'slots' as const;
}

class Memberships extends Repository<'memberships', CouponTables> {
  static table = 'memberships' as const;
}

class Coupons extends Repository<'coupons', CouponTables> {
  static table = 'coupons' as const;
}

const root = workspaceTempDir('marmeon-mysql-duplicates-app-');
const modules: ModuleDefinition[] = [{ name: 'mysql-writes', migrations: new URL('./__fixtures__/migrations/mysql-writes/', import.meta.url) }];

withMysql('duplicate keys on MySQL', () => {
  let connections: Connections;
  let close: () => Promise<void>;

  // DDL on the shared Docker host is slow.
  beforeAll(async () => {
    ({ connections, close } = await freshConnections('mysql'));
    await new Migrator({ modules, root } as unknown as Application, connections).migrate();
    await sql`create unique index coupons_note_raw on coupons (note)`.execute(connections.get<any>());
  }, 30_000);
  afterAll(() => close());

  const db = () => connections.get<CouponTables>();
  const row = (email: string, code: string, note: string | null = null) => ({ email, code, note });
  const failure = (work: () => Promise<unknown>) => work().then(() => undefined, (error: unknown) => error);

  it('names the columns of a unique index a migration describes, and of the primary key', async () => {
    await db().insertInto('coupons').values({ id: 7, ...row('a@example.com', 'A') }).execute();
    const byEmail = await failure(() => db().insertInto('coupons').values(row('a@example.com', 'B')).execute());
    expect(isUniqueViolation(byEmail)).toBe(true);
    expect(mysqlDuplicateKey(byEmail)).toEqual({ table: 'coupons', index: 'coupons_email_unique' });
    expect(uniqueViolationColumns(byEmail)).toEqual(['email']);
    expect(uniqueViolationColumns(await failure(() => db().insertInto('coupons').values({ id: 7, ...row('b@example.com', 'C') }).execute()))).toEqual(['id']);
  });

  it('names no column for an index made by raw SQL', async () => {
    await db().insertInto('coupons').values(row('n1@example.com', 'N1', 'same')).execute();
    const error = await failure(() => db().insertInto('coupons').values(row('n2@example.com', 'N2', 'same')).execute());
    expect(isUniqueViolation(error)).toBe(true);
    expect(mysqlDuplicateKey(error)?.index).toBe('coupons_note_raw');
    expect(uniqueViolationColumns(error)).toEqual([]);
  });

  it('makes failOnDuplicate answer 422 at the field of the index', async () => {
    await db().insertInto('coupons').values(row('f@example.com', 'F')).execute();
    const error = await failure(() => failOnDuplicate('email', () => db().insertInto('coupons').values(row('f@example.com', 'F2')).execute(), { email: 'f@example.com' }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual({ email: ['The email has already been taken.'] });
  });

  it('does not take the key text inside a duplicate value for the key: the end of the message decides', async () => {
    await db().insertInto('coupons').values(row('c1@example.com', `x' for key 'coupons.coupons_email_unique`)).execute();
    const error = await failure(() => failOnDuplicate('email', () => db().insertInto('coupons').values(row('c2@example.com', `x' for key 'coupons.coupons_email_unique`)).execute()));
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(isUniqueViolation(error)).toBe(true);
    expect(uniqueViolationColumns(error)).toEqual(['code']);
  });

  it('names the columns through the repository too, by the exact index name', async () => {
    const coupons = new Coupons(connections);
    await coupons.insertMany([row('r@example.com', 'R')]);
    expect(await coupons.tryInsertMany([row('r@example.com', 'R2')])).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['email'] } });
    expect(await coupons.tryInsertMany([row('r2@example.com', 'R')])).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['code'] } });
    await coupons.insertMany([row('n3@example.com', 'N3', 'raw')]);
    expect(await coupons.tryInsertMany([row('n4@example.com', 'N4', 'raw')])).toEqual({ ok: false, error: { kind: 'duplicate', columns: [] } });
  });

  it('names the primary key a caller gives', async () => {
    const slots = new Slots(connections);
    await slots.insertMany([{ slug: 'a' }]);
    expect(await slots.tryInsertMany([{ slug: 'a' }])).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['slug'] } });
  });

  it('names no column when a trigger raises the duplicate in another table, though that table has a column of the same name', async () => {
    await db().insertInto('coupons').values(row('trigger@example.com', 'TRIGGER')).execute();
    await sql`create trigger memberships_coupon after insert on memberships for each row insert into coupons (email, code) values ('trigger@example.com', 'TRIGGER2')`.execute(db());
    try {
      // The error names `coupons.coupons_email_unique`; the repository writes `memberships`, which also has an `email` column.
      expect(await new Memberships(connections).tryInsertMany([{ team_id: 9, email: 'trigger-member@example.com' }])).toEqual({ ok: false, error: { kind: 'duplicate', columns: [] } });
    } finally {
      await sql`drop trigger memberships_coupon`.execute(db());
    }
  });

  it('keeps the order of a composite index and finds an index by its own name', async () => {
    const memberships = new Memberships(connections);
    await memberships.insertMany([{ team_id: 1, email: 'm@example.com', badge: 'gold' }]);
    expect(await memberships.tryInsertMany([{ team_id: 1, email: 'm@example.com' }])).toEqual({ ok: false, error: { kind: 'duplicate', columns: ['team_id', 'email'] } });
    const named = await failure(() => db().insertInto('memberships').values({ team_id: 2, email: 'm2@example.com', badge: 'gold' }).execute());
    expect(mysqlDuplicateKey(named)?.index).toBe('memberships_badge_custom');
    expect(uniqueViolationColumns(named)).toEqual(['badge']);
  });

  it('names the columns of a duplicate inside a transaction, which stays usable', async () => {
    await db().insertInto('coupons').values(row('t@example.com', 'T')).execute();
    const columns = await connections.transaction(async () => {
      const error = await failure(() => db().insertInto('coupons').values(row('t@example.com', 'T2')).execute());
      await db().insertInto('coupons').values(row('t2@example.com', 'T3')).execute();
      return uniqueViolationColumns(error);
    });
    expect(columns).toEqual(['email']);
    expect((await db().selectFrom('coupons').select('id').where('email', '=', 't2@example.com').execute()).length).toBe(1);
  });

  it('keeps the metadata when the caller changes the columns it was given', async () => {
    const coupons = new Coupons(connections);
    await coupons.insertMany([row('k@example.com', 'K')]);
    const id = (await db().selectFrom('coupons').select('id').where('email', '=', 'k@example.com').executeTakeFirstOrThrow()).id;
    const columnsOf = async (values: object) => {
      const result = await coupons.tryInsertMany([values as never]);
      return result.ok ? undefined : (result.error.columns as string[]);
    };
    // The primary key's columns, then a unique index's.
    const byKey = (await columnsOf({ id, email: 'k2@example.com', code: 'K2', note: null }))!;
    expect(byKey).toEqual(['id']);
    byKey.push('code');
    byKey[0] = 'email';
    expect(await columnsOf({ id, email: 'k2@example.com', code: 'K2', note: null })).toEqual(['id']);
    expect(await coupons.find(id as never)).toMatchObject({ id, email: 'k@example.com' });
    const byEmail = (await columnsOf(row('k@example.com', 'K3')))!;
    expect(byEmail).toEqual(['email']);
    byEmail.push('id');
    expect(await columnsOf(row('k@example.com', 'K3'))).toEqual(['email']);
  });

  it('hands out its own copy of the columns of uniqueViolationColumns', async () => {
    await db().insertInto('coupons').values(row('copy@example.com', 'COPY')).execute();
    const duplicateEmail = () => failure(() => db().insertInto('coupons').values(row('copy@example.com', 'COPY2')).execute());
    const given = uniqueViolationColumns(await duplicateEmail());
    expect(given).toEqual(['email']);
    given.push('code');
    given[0] = 'id';
    expect(uniqueViolationColumns(await duplicateEmail())).toEqual(['email']);
    const id = (await db().selectFrom('coupons').select('id').where('email', '=', 'copy@example.com').executeTakeFirstOrThrow()).id;
    expect(await new Coupons(connections).find(id as never)).toMatchObject({ id, email: 'copy@example.com' });
  });

  it('names the table a real statement could not find', async () => {
    const error = await failure(() => sql`select * from nope`.execute(db()));
    expect(missingTable(error)).toBe('nope');
  });
});
