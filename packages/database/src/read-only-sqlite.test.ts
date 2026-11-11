import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Redactor } from '@marmeon/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { queryReadOnlySqlite } from './read-only-sqlite.ts';
import { readOnlyQuery, type ReadOnlyQueryOptions } from './read-only-query.ts';
import { Connections } from './connections.ts';
import { silent } from './__fixtures__/databases.ts';

const redactor = new Redactor();
const options: ReadOnlyQueryOptions = {
  limit: 100,
  secrets: new Map([
    ['users', new Set(['password'])],
    ['gen', new Set(['password'])],
    ['notebook', new Set(['secret_note'])],
    ['f4', new Set(['body'])],
    ['sec5', new Set(['body'])],
  ]),
  redact: (text) => redactor.text(text),
  timeoutMs: 10_000,
};

describe('a read-only query on SQLite', () => {
  const directory = tempDir('marmeon-ro-query-');
  const file = join(directory, 'app.db');
  const hash = () => createHash('sha256').update(readFileSync(file)).digest('hex');
  const run = (sql: string, more: Partial<ReadOnlyQueryOptions> = {}) => queryReadOnlySqlite(file, sql, { ...options, ...more });
  const count = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare('select count(*) as n from users').get() as { n: number }).n;
    } finally {
      db.close();
    }
  };
  let before: string;

  beforeAll(() => {
    const db = new DatabaseSync(file);
    db.exec(`
      pragma journal_mode = wal;
      create table users (id integer primary key, email text, password text);
      insert into users (email, password) values ('a@example.test', 'abc'), ('b@example.test', 'xyz');
      create table gen (id integer primary key, password text, g text as (upper(password)), s text as (lower(password)) stored);
      insert into gen (password) values ('abc');
      create virtual table docs using fts5(title, body);
      insert into docs (title, body) values ('hello', 'world');
      create virtual table notebook using fts5(note, secret_note);
      insert into notebook (note, secret_note) values ('n', 'hidden');
      create virtual table f4 using fts4(body);
      insert into f4 (body) values ('topsecret');
      create virtual table ext using fts5(password, content='users', content_rowid='id');
      insert into ext (rowid, password) select id, password from users;
      create virtual table e_bracket using fts5(password, content=[users], content_rowid=id);
      create virtual table e_tick using fts5(password, content=\`users\`, content_rowid=id);
      create virtual table e_double using fts5(password, content="Users", content_rowid=id);
      create virtual table e_bare using fts5(password, content=users, content_rowid=id);
      create virtual table "x content=notes" using fts5(password, content=users, content_rowid=id);
      create view secret_view as select id, password from users;
      create view plain_view as select id, email from users;
      create table plain_docs (id integer primary key, body text);
      insert into plain_docs (body) values ('findable');
      create virtual table e_view using fts5(password, content=secret_view, content_rowid=id);
      create virtual table e_plain_view using fts5(email, content=plain_view, content_rowid=id);
      create virtual table e_missing using fts5(body, content=nothing_here);
      create virtual table e_plain using fts5(body, content=plain_docs, content_rowid=id);
      insert into e_plain (rowid, body) select id, body from plain_docs;
      create virtual table sec5 using fts5(body);
      insert into sec5 (body) values ('topsecret');
      create virtual table viashadow using fts5(c0, content=sec5_content, content_rowid=id);
      insert into viashadow (viashadow) values ('rebuild');
      create view v as select * from users;
      create table notes (id integer primary key, body text);
      create index notes_body on notes (body);
      insert into notes (body) values ('x'), ('y'), ('z');
      analyze;
    `);
    db.close();
    before = hash();
  });

  const refused = (sql: string) => {
    const result = run(sql);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('refused');
    return result.ok ? '' : result.error.message;
  };

  it.each(['insert into users (email) values (1)', "update users set email = 'x'", 'delete from users', 'create table t (a)', 'drop table users', 'alter table users add column x'])(
    'refuses %s',
    (sql) => {
      refused(sql);
      expect(count()).toBe(2);
    },
  );

  it('withholds a table whatever the case its name is written in', () => {
    for (const query of ['select * from users', 'select * from USERS', 'select id from "Users"']) {
      const result = run(query, { withheld: new Set(['Users']) });
      expect(result.ok, query).toBe(false);
      if (!result.ok) expect(result.error.message).toContain('cannot be read');
    }
  });

  it('refuses a write that returns rows, as a refusal and not as a failed write', () => {
    expect(refused("insert into users (email) select 'x' returning id")).toContain('Only a plain SELECT');
    expect(count()).toBe(2);
  });

  it('refuses a second statement', () => {
    refused('select 1; delete from users');
    expect(count()).toBe(2);
  });

  it('refuses VACUUM INTO and writes no file', () => {
    const copy = join(directory, 'copy.db');
    expect(refused(`vacuum into '${copy}'`)).toBe('Only a single SELECT that returns columns can run here.');
    expect(existsSync(copy)).toBe(false);
  });

  it('refuses ATTACH DATABASE', () => {
    const other = join(directory, 'other.db');
    refused(`attach database '${other}' as o`);
    expect(existsSync(other)).toBe(false);
  });

  it.each(['pragma query_only = 0', 'pragma writable_schema = 1', 'pragma table_info(users)'])('refuses %s', (sql) => {
    refused(sql);
  });

  it("refuses load_extension() and fts3_tokenizer()", () => {
    refused("select load_extension('x')");
    refused("select fts3_tokenizer('simple')");
  });

  it.each(['begin', 'savepoint s', 'commit', 'reindex', 'analyze'])('refuses %s', (sql) => {
    refused(sql);
  });

  it.each([
    'select * from users',
    'select password from users',
    'select length(password) from users',
    "select id from users where password like 'a%'",
    'select * from v',
    'select * from (select password as p from users)',
    'select u.* from users as u',
    'select "PASSWORD" from "Users"',
  ])('refuses the secret column in %s and names it', (sql) => {
    expect(refused(sql)).toContain('users.password');
  });

  it('refuses the statistics of the data', () => {
    expect(refused('select * from sqlite_stat1')).toContain('sqlite_stat1');
  });

  it('refuses the columns a secret one is computed into, generated or stored', () => {
    expect(refused('select g from gen')).toContain('gen.g');
    expect(refused('select s from gen')).toContain('gen.s');
    expect(refused('select id from gen where g = 1')).toContain('gen.g');
  });

  it('refuses the shadow tables of a text index with a secret column', () => {
    expect(refused('select note, secret_note from notebook')).toContain('notebook.secret_note');
    for (const shadow of ['content', 'data', 'idx', 'docsize', 'config']) expect(refused(`select * from notebook_${shadow}`)).toContain(`notebook_${shadow}`);
  });

  it('refuses a MATCH on an FTS4 index over a secret column, and its tables', () => {
    refused("select count(*) from f4 where f4 match 'tops*'");
    for (const shadow of ['content', 'docsize', 'segments', 'segdir', 'stat']) expect(refused(`select * from f4_${shadow}`)).toContain(`f4_${shadow}`);
  });

  it('refuses a MATCH on an index whose content is a table with a secret column', () => {
    refused("select rowid from ext where ext match 'abc'");
    refused('select rowid from ext');
  });

  it.each(['e_bracket', 'e_tick', 'e_double', 'e_bare'])('refuses a MATCH on %s, an index over a table with secrets however its name is quoted', (name) => {
    refused(`select rowid from ${name} where ${name} match 'abc'`);
  });

  it('reads the content= of the arguments, not one in the name of the table', () => {
    refused(`select rowid from "x content=notes" where "x content=notes" match 'abc'`);
  });

  it.each(['e_view', 'e_plain_view', 'e_missing'])('withholds %s: a content= that is a view or names no table is not followed, even over harmless columns', (name) => {
    refused(`select rowid from ${name} where ${name} match 'abc'`);
  });

  it('withholds an index whose content= is a table an FTS index keeps its text in', () => {
    refused("select rowid from viashadow where viashadow match 'topsecret'");
  });

  it('reads an index over an ordinary table without secrets', () => {
    expect(run("select rowid from e_plain where e_plain match 'findable'")).toMatchObject({ ok: true, value: { rows: [[1]] } });
  });

  it.each([-1, 0, 1.5, Infinity, NaN])('fails for the row limit %s', (limit) => {
    expect(run('select 1', { limit })).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('fails the row limit before it picks a driver', async () => {
    const connections = new Connections({ connections: { default: { driver: 'pgsql', url: 'postgres://localhost/none' } }, root: directory, logger: silent });
    expect(await readOnlyQuery(connections, 'default', 'select 1', { ...options, limit: 0 })).toMatchObject({ ok: false, error: { message: expect.stringContaining('row limit') } });
    await connections.destroy();
  });

  it('withholds an index whose content= it cannot read', () => {
    const odd = join(directory, 'odd.db');
    const writer = new DatabaseSync(odd);
    writer.exec('create table users (id integer primary key, password text)');
    writer.exec('create virtual table e using fts5(password, content=)');
    writer.close();
    expect(queryReadOnlySqlite(odd, 'select rowid from e', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('reads a text index without a secret column', () => {
    expect(run("select title, body from docs where docs match 'hello'")).toMatchObject({ ok: true, value: { rows: [['hello', 'world']] } });
    expect(run('select * from docs')).toMatchObject({ ok: true });
  });

  it('refuses a value larger than the bound, and answers one below it', () => {
    expect(run('select zeroblob(1048577)')).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(run('select length(zeroblob(1048576))')).toMatchObject({ ok: true, value: { rows: [[1048576]] } });
    expect(run('select length(zeroblob(1000))')).toMatchObject({ ok: true, value: { rows: [[1000]] } });
  });

  it('reads a database with a table of 150 columns', () => {
    const wide = join(directory, 'wide.db');
    const writer = new DatabaseSync(wide);
    writer.exec(`create table users (id integer primary key, password text, ${Array.from({ length: 150 }, (_, i) => `c${i} integer`).join(', ')})`);
    writer.exec('insert into users (id, c149) values (1, 7)');
    writer.close();
    expect(queryReadOnlySqlite(wide, 'select 1', options)).toMatchObject({ ok: true });
    expect(queryReadOnlySqlite(wide, 'select c149 from users', options)).toMatchObject({ ok: true, value: { rows: [[7]] } });
  });

  it('works on a database with a rollback journal, and always ends its transaction', () => {
    const journal = join(directory, 'journal.db');
    const writer = new DatabaseSync(journal);
    writer.exec('create table users (id integer primary key, password text, email text); insert into users (email) values (\'a\')');
    const writes = () => {
      // An open read transaction would hold the shared lock and make this wait out its timeout.
      const other = new DatabaseSync(journal, { timeout: 100 });
      try {
        other.exec('begin exclusive; rollback');
      } finally {
        other.close();
      }
    };
    expect(queryReadOnlySqlite(journal, 'select email from users', options)).toMatchObject({ ok: true, value: { rows: [['a']] } });
    writes();
    expect(queryReadOnlySqlite(journal, 'select password from users', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
    writes();
    expect(queryReadOnlySqlite(journal, 'select 1; delete from users', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
    writes();
    expect(queryReadOnlySqlite(journal, 'select * from', options)).toMatchObject({ ok: false, error: { kind: 'failed' } });
    writes();
    writer.close();
  });

  it('fails, and does not throw, for a file that is no database or one that is locked', () => {
    const garbage = join(directory, 'garbage.db');
    writeFileSync(garbage, 'this is not a database'.repeat(100));
    expect(queryReadOnlySqlite(garbage, 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'failed' } });
    const locked = join(directory, 'locked.db');
    const writer = new DatabaseSync(locked);
    writer.exec('create table users (id, password); begin exclusive');
    try {
      expect(queryReadOnlySqlite(locked, 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'failed' } });
    } finally {
      writer.close();
    }
  });

  it('reads the columns that are not secret', () => {
    const result = run('select id, email from users order by id');
    expect(result).toMatchObject({ ok: true, value: { rows: [[1, 'a@example.test'], [2, 'b@example.test']], truncated: false, cut: 0 } });
  });

  it('answers a join, a recursive CTE, an aggregate and VALUES', () => {
    expect(run('select u.email, n.body from users u join notes n on n.id = u.id order by u.id')).toMatchObject({ ok: true, value: { rows: [['a@example.test', 'x'], ['b@example.test', 'y']] } });
    expect(run('with recursive c(n) as (select 1 union all select n + 1 from c where n < 5) select sum(n) from c')).toMatchObject({ ok: true, value: { rows: [[15]] } });
    expect(run('select count(*), max(id) from users')).toMatchObject({ ok: true, value: { rows: [[2, 2]] } });
    expect(run('values (1)')).toMatchObject({ ok: true, value: { rows: [[1]] } });
  });

  it('keeps two columns of one name apart, and says the declared types', () => {
    const result = run('select u.id, n.id, u.email from users u join notes n on n.id = u.id order by u.id limit 1');
    expect(result).toMatchObject({
      ok: true,
      value: { columns: [{ name: 'id', type: 'INTEGER' }, { name: 'id', type: 'INTEGER' }, { name: 'email', type: 'TEXT' }], rows: [[1, 1, 'a@example.test']] },
    });
  });

  it('lets a comment after the statement belong to it, and refuses one after a semicolon', () => {
    expect(run('select 1 -- x')).toMatchObject({ ok: true, value: { rows: [[1]] } });
    expect(refused('select 1; -- x')).toContain('Only one statement');
  });

  it('accepts a trailing semicolon and a comment-free tail of blanks', () => {
    expect(run('select 1 ;  \n')).toMatchObject({ ok: true });
  });

  it('stops at the limit and says there were more', () => {
    expect(run('select id from notes', { limit: 2 })).toMatchObject({ ok: true, value: { rows: [[1], [2]], truncated: true } });
    expect(run('select id from notes', { limit: 3 })).toMatchObject({ ok: true, value: { truncated: false } });
  });

  it('cuts long text, marks bytes and masks what the redactor knows', () => {
    const token = ['ghp_', 'a'.repeat(36)].join('');
    expect(redactor.text(token)).not.toContain(token);
    const result = run(`select '${'x'.repeat(10_000)}', x'0102', '${token}', 9007199254740993, 42`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [long, bytes, masked, big, small] = result.value.rows[0] as [string, string, string, string, number];
    expect(long).toHaveLength(4096);
    expect(result.value.cut).toBe(1);
    expect(bytes).toBe('[binary 2 bytes]');
    expect(masked).not.toContain(token);
    expect(big).toBe('9007199254740993');
    expect(small).toBe(42);
  });

  it('opens a WAL database whose writer has closed', () => {
    // What a closed writer leaves: neither the shared-memory file nor the log (an earlier reader may have made the first).
    rmSync(`${file}-shm`, { force: true });
    rmSync(`${file}-wal`, { force: true });
    expect(run('select 1')).toMatchObject({ ok: true });
  });

  it('refuses a database that does not exist and creates nothing', () => {
    const missing = join(directory, 'missing.db');
    expect(queryReadOnlySqlite(missing, 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses an in-memory database', () => {
    expect(queryReadOnlySqlite(undefined, 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
  });

  it('leaves the file as it was', () => {
    expect(hash()).toBe(before);
  });

  describe('through the connections', () => {
    it('opens the file of a connection by its name, relative to the app root', async () => {
      const connections = new Connections({ connections: { default: { driver: 'sqlite', database: 'app.db' } }, root: directory, logger: silent });
      expect(await readOnlyQuery(connections, 'default', 'select email from users where id = 1', options)).toMatchObject({ ok: true, value: { rows: [['a@example.test']] } });
      expect(await readOnlyQuery(connections, 'default', 'select * from users', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
      expect(await readOnlyQuery(connections, 'other', 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'failed' } });
      await connections.destroy();
    });

    it('refuses an in-memory connection and fails a Postgres one it cannot yet run', async () => {
      const memory = new Connections({ connections: { default: { driver: 'sqlite', database: ':memory:' } }, root: directory, logger: silent });
      expect(await readOnlyQuery(memory, 'default', 'select 1', options)).toMatchObject({ ok: false, error: { kind: 'refused' } });
      await memory.destroy();
      // Port 1 answers nobody: the Postgres driver is picked, and it fails to connect without a word about the host.
      const pgsql = new Connections({ connections: { default: { driver: 'pgsql', url: 'postgres://user:pw@127.0.0.1:1/none' } }, root: directory, logger: silent });
      const result = await readOnlyQuery(pgsql, 'default', 'select 1', options);
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
      expect(JSON.stringify(result)).not.toContain('127.0.0.1');
      await pgsql.destroy();
    });
  });
});
