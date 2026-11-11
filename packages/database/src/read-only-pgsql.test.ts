import { Redactor } from '@marmeon/core';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { freshConnections } from './__fixtures__/databases.ts';
import type { Connections } from './connections.ts';
import { importPg } from './postgres.ts';
import { readOnlyQuery, type ReadOnlyQueryOptions } from './read-only-query.ts';
import { queryReadOnlyPgsql } from './read-only-pgsql.ts';

const redactor = new Redactor();
const options: ReadOnlyQueryOptions = {
  limit: 100,
  secrets: new Map([
    ['users', new Set(['password'])],
    ['gen', new Set(['password'])],
    ['users_part', new Set(['password'])],
    ['ledger', new Set(['secret'])],
  ]),
  redact: (text) => redactor.text(text),
  timeoutMs: 10_000,
};

describe.runIf(process.env.MARMEON_TEST_PGSQL_URL)('a read-only query on Postgres', () => {
  let connections: Connections;
  let close: () => Promise<void>;
  let url: string;
  const run = (query: string, more: Partial<ReadOnlyQueryOptions> = {}) => queryReadOnlyPgsql(url, query, { ...options, ...more });
  const scalar = async <T>(query: string): Promise<T> => {
    const { rows } = await sql<{ value: T }>`${sql.raw(query)}`.execute(connections.get());
    return rows[0]!.value;
  };
  const users = () => scalar<number>('select count(*)::int as value from users');
  const refused = async (query: string) => {
    const result = await run(query);
    expect(result.ok, query).toBe(false);
    if (!result.ok) expect(result.error.kind, `${query}: ${result.error.message}`).toBe('refused');
    return result.ok ? '' : result.error.message;
  };

  beforeAll(async () => {
    ({ connections, close } = await freshConnections('pgsql', { managed: false }));
    url = (connections.options() as { url: string }).url;
    for (const statement of [
      'create table users (id serial primary key, email text, password text)',
      "insert into users (email, password) values ('a@example.test', 'abc'), ('b@example.test', 'xyz')",
      'create table users_archive () inherits (users)',
      'create table users_public (id integer primary key, name text)',
      "insert into users_public values (1, 'Ada')",
      'create view users_view as select * from users',
      'create view users_renamed as select password as pw from users',
      'create sequence counter',
      'create table users_part (id integer, password text) partition by range (id)',
      'create table users_part_1 partition of users_part for values from (0) to (100)',
      "insert into users_part values (1, 'pp')",
      'create materialized view mv_arch as select id, password from users_archive',
      'create materialized view mv_part as select id, password from users_part_1',
      'create extension tablefunc',
      'create table gen (id serial primary key, password text, pw_prefix text generated always as (left(password, 2)) stored)',
      "insert into gen (password) values ('hunter2')",
      'create table ledger (id serial primary key, note text, secret text)',
      'alter table ledger alter column secret set storage external',
      "insert into ledger (note, secret) select 'n', string_agg(md5(i::text), '') from generate_series(1, 200) i",
      'create materialized view users_copy as select id, password from users',
      'create materialized view users_copy_view as select * from users_view',
      'analyze users',
    ]) {
      await sql.raw(statement).execute(connections.get());
    }
  });
  afterAll(async () => {
    await close();
  });
  // Every query ends its connection, whatever became of it.
  afterEach(async () => {
    await expect.poll(() => scalar<number>("select count(*)::int as value from pg_stat_activity where application_name = 'marmeon-db-query'"), { timeout: 2000 }).toBe(0);
  });

  describe('what only the read-only transaction refuses', () => {
    it('refuses SELECT … FOR UPDATE, which takes a lock', async () => {
      expect(await refused('select * from users_public for update')).toContain('read-only transaction');
    });
  });

  describe('writes and statements', () => {
    it.each([
      "insert into users (email) values ('x')",
      "update users set email = 'x'",
      'delete from users',
      'create table t (a int)',
      'drop table users',
      'truncate users',
      "set transaction read write",
      "set session authorization default",
    ])('refuses %s and leaves the rows', async (query) => {
      await refused(query);
      expect(await users()).toBe(2);
    });

    it('refuses a second statement', async () => {
      await refused('select 1; delete from users');
      expect(await users()).toBe(2);
    });

    it('refuses a breakout from the wrapper', async () => {
      await refused('1) q; delete from users; select * from (select 1');
      await refused('select 1) q; delete from users; --');
      await refused('select 1) q; drop table users; /*');
      expect(await users()).toBe(2);
    });

    it('takes dollar quoting for what it is: a string', async () => {
      expect(await run('select $$1) q; delete from users; select * from (select 1$$')).toMatchObject({ ok: true, value: { rows: [['1) q; delete from users; select * from (select 1']] } });
      expect(await users()).toBe(2);
    });

    it('refuses a statement that only a comment hides from the end of the wrapper', async () => {
      await refused('select 1 /*');
    });

    // The file would appear on the machine of the server, which is what `pg_stat_file` looks at.
    const marker = () => `/tmp/marmeon-${crypto.randomUUID()}`;
    const written = (file: string) => scalar<unknown>(`select (pg_stat_file('${file}', true)).size as value`);

    it('refuses COPY, which a read-only transaction would allow', async () => {
      const file = marker();
      await refused(`copy (select 1) to program 'touch ${file}'`);
      await refused('copy (select 1) to stdout');
      expect(await written(file)).toBeNull();
    });

    // The extended protocol takes one statement, and it is the one that Postgres parses before the plan is checked: with the simple protocol
    // the second statement would run while the first is only explained.
    it('runs nothing that follows a breakout, not even a statement a read-only transaction allows', async () => {
      const file = marker();
      await refused(`select 1) q; copy (select 1) to program 'touch ${file}'; select * from (select 1`);
      expect(await written(file)).toBeNull();
    });

    it('refuses a data-modifying WITH', async () => {
      await refused('with d as (delete from users returning id) select * from d');
      expect(await users()).toBe(2);
    });

    it('refuses set_config(), which could turn the transaction read-write', async () => {
      await refused("select set_config('transaction_read_only', 'off', true)");
    });

    it('allows one trailing semicolon and a trailing line comment', async () => {
      expect(await run('select 1;')).toMatchObject({ ok: true });
      expect(await run('select 1 -- end')).toMatchObject({ ok: true });
    });
  });

  describe('functions with effects', () => {
    it('refuses nextval() and leaves the sequence', async () => {
      await refused("select nextval('counter')");
      expect(await scalar<boolean>('select is_called as value from counter')).toBe(false);
    });

    it('refuses pg_terminate_backend() and the other connection still answers', async () => {
      const pg = await importPg();
      const other = new pg.Client(url);
      await other.connect();
      try {
        const pid = (await other.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        await refused(`select pg_terminate_backend(${pid})`);
        await refused(`select pg_cancel_backend(${pid})`);
        expect((await other.query('select 1 as one')).rows[0].one).toBe(1);
      } finally {
        await other.end();
      }
    });

    it('refuses pg_advisory_lock(), a lock that outlives a rollback', async () => {
      await refused('select pg_advisory_lock(4242)');
      await refused('select pg_try_advisory_lock(4243)');
      expect(await scalar<number>("select count(*)::int as value from pg_locks where locktype = 'advisory' and objid in (4242, 4243)")).toBe(0);
    });

    it('refuses pg_notify(), which a read-only transaction allows', async () => {
      const pg = await importPg();
      const listener = new pg.Client(url);
      await listener.connect();
      const heard: string[] = [];
      listener.on('notification', (message) => heard.push(message.payload ?? ''));
      try {
        await listener.query('listen marmeon_test');
        await refused("select pg_notify('marmeon_test', 'hello')");
        await listener.query('select 1');
        expect(heard).toEqual([]);
      } finally {
        await listener.end();
      }
    });

    it('refuses pg_sleep()', async () => {
      await refused('select pg_sleep(0.01)');
    });
  });

  describe('functions that read for themselves, and the settings', () => {
    it.each([
      "select table_to_xml('users', true, false, '')",
      "select query_to_xml('select * from users', true, false, '')",
      'select database_to_xml(true, false, \'\')',
      "select current_setting('server_version')",
      'select * from pg_settings',
      "select pg_read_file('/etc/hostname')",
      "select pg_ls_dir('/')",
      "select lo_get(1)",
      "select * from ts_stat('select to_tsvector(email) from users')",
    ])('refuses %s', async (query) => {
      await refused(query);
    });
  });

  describe('secret columns', () => {
    it.each([
      'select * from users',
      'select password from users',
      'select length(password) from users',
      "select id from users where password like 'a%'",
      "select id from users where password = 'x'",
      'select id from users order by password',
      'select to_jsonb(u) from users u',
      'select row_to_json(u) from users u',
      'select u from users u',
      'select * from users_view',
      'select pw from users_renamed',
      'select q from (select * from users) q',
      'select * from (select password from users offset 0) q',
      'select * from users_archive',
      'select password from only users',
    ])('refuses %s and names the column or the table', async (query) => {
      expect(await refused(query)).toMatch(/users\.password|has secret columns/);
    });

    it('refuses a stored generated column of a table with a secret column', async () => {
      expect(await refused('select pw_prefix from gen')).toContain('gen.pw_prefix is a secret column');
      expect(await run('select id from gen')).toMatchObject({ ok: true });
    });

    it('refuses a materialized view that keeps a copy of a secret column, directly or through a view', async () => {
      expect(await refused('select id from users_copy')).toContain('keeps a copy of data from users');
      expect(await refused('select id from users_copy_view')).toContain('keeps a copy of data from');
      // Built from a child table or a partition: the parent's secrets reach it.
      expect(await refused('select id from mv_arch')).toContain('keeps a copy of data from');
      expect(await refused('select id from mv_part')).toContain('keeps a copy of data from');
    });

    it("refuses the TOAST table behind a secret that is too big for its row", async () => {
      const toast = await scalar<string>("select reltoastrelid::regclass::text as value from pg_class where relname = 'ledger'");
      expect(toast).toMatch(/^pg_toast\.pg_toast_\d+$/);
      await refused(`select substr(convert_from(chunk_data, 'UTF8'), 1, 30) from ${toast}`);
      await refused(`select encode(chunk_data, 'escape') from ${toast}`);
      // Control: the same value through the table is refused as a secret column, not as unreadable.
      expect(await refused('select secret from ledger')).toContain('ledger.secret');
    });

    it.each([
      "select * from crosstab('select 1, 2, 3 from users') as t(a int, b int, c int)",
      "select * from connectby('users', 'id', 'id', '1', 0) as t(id int, parent int, level int)",
      "select txid_current()",
      "select pg_current_xact_id()",
    ])('refuses %s', async (query) => {
      await refused(query);
    });

    it('lets the other columns of a table with secrets through', async () => {
      expect(await run('select id, email from users order by id')).toMatchObject({ ok: true, value: { rows: [[1, 'a@example.test'], [2, 'b@example.test']] } });
      expect(await run('select count(*) from users')).toMatchObject({ ok: true, value: { rows: [['2']] } });
    });

    it('refuses the samples and credentials that Postgres keeps in its catalogs', async () => {
      await refused("select most_common_vals from pg_stats where attname = 'password'");
      await refused('select * from pg_statistic');
      await refused('select rolpassword from pg_authid');
      await refused('select passwd from pg_shadow');
      await refused('select * from pg_user_mapping');
      await refused('select subconninfo from pg_subscription');
      await refused('select * from pg_largeobject');
      await refused('select * from pg_db_role_setting');
      await refused('select query from pg_stat_activity');
    });
  });

  describe('what it answers', () => {
    it('joins, uses CTEs, VALUES, TABLE, window functions and the catalog', async () => {
      expect(await run('select u.id, p.name from users u join users_public p on p.id = u.id')).toMatchObject({ ok: true, value: { rows: [[1, 'Ada']] } });
      expect(await run('with c as (select id from users_public) select * from c')).toMatchObject({ ok: true, value: { rows: [[1]] } });
      expect(await run('values (1, $$a$$), (2, $$b$$)')).toMatchObject({ ok: true, value: { rows: [[1, 'a'], [2, 'b']] } });
      expect(await run('table users_public')).toMatchObject({ ok: true, value: { rows: [[1, 'Ada']] } });
      expect(await run('select name, row_number() over (order by id) from users_public')).toMatchObject({ ok: true, value: { rows: [['Ada', '1']] } });
      expect(await run("select column_name from information_schema.columns where table_name = 'users_public' order by ordinal_position")).toMatchObject({ ok: true, value: { rows: [['id'], ['name']] } });
      expect(await run("select coalesce(name, 'none'), extract(year from now())::int > 2000, name::varchar(20) from users_public")).toMatchObject({ ok: true, value: { rows: [['Ada', true, 'Ada']] } });
    });

    it('reports the column names and types, duplicates apart', async () => {
      expect(await run("select 1 as a, 2 as a, 'x'::text as t, now() as n")).toMatchObject({
        ok: true,
        value: { columns: [{ name: 'a', type: 'integer' }, { name: 'a', type: 'integer' }, { name: 't', type: 'text' }, { name: 'n', type: 'timestamp with time zone' }] },
      });
      expect(await run('select from users_public')).toMatchObject({ ok: true, value: { columns: [], rows: [[]] } });
    });

    it('keeps dates and JSON as text, in the order of the session (UTC)', async () => {
      const result = await run("select date '2026-01-02', timestamp '2026-01-02 03:04:05', '{\"a\": 1}'::jsonb, 9007199254740993::bigint");
      expect(result).toMatchObject({ ok: true, value: { rows: [['2026-01-02', '2026-01-02 03:04:05', '{"a": 1}', '9007199254740993']] } });
    });

    it('has Postgres stop at the limit, not the client', async () => {
      expect(await run('select generate_series(1, 1000000000000)', { limit: 2, timeoutMs: 2000 })).toMatchObject({ ok: true, value: { rows: [['1'], ['2']], truncated: true } });
    });

    it('replaces a value beyond the size limit, an array of long strings included, and counts it as cut', async () => {
      const result = await run("select array[repeat('x', 2000000)], array[1, 2], 7, array[repeat('x', 100000)]");
      expect(result).toMatchObject({ ok: true, value: { rows: [[null, [1, 2], 7, null]], cut: 2 } });
    });

    it('leaves out the rows beyond what an answer may weigh in all', async () => {
      const result = await run("select array(select repeat('y', 4000) from generate_series(1, 15)) from generate_series(1, 200)", { limit: 200 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.truncated).toBe(true);
        expect(result.value.rows.length).toBeGreaterThanOrEqual(1);
        expect(result.value.rows.length).toBeLessThan(150);
      }
    }, 30_000);

    it('cuts a number of 130 000 digits like any text', async () => {
      const result = await run('select 10::numeric ^ 130000');
      expect(result).toMatchObject({ ok: true, value: { cut: 1 } });
      if (result.ok) expect((result.value.rows[0]![0] as string).length).toBe(4096);
    });

    it('stops at the limit and says so', async () => {
      expect(await run('select generate_series(1, 5)', { limit: 3 })).toMatchObject({ ok: true, value: { rows: [[1], [2], [3]], truncated: true } });
      expect(await run('select generate_series(1, 3)', { limit: 3 })).toMatchObject({ ok: true, value: { truncated: false } });
    });

    it('cuts text in the database, marks bytes and masks what the redactor knows', async () => {
      const token = ['ghp_', 'a'.repeat(36)].join('');
      expect(redactor.text(token)).not.toContain(token);
      const result = await run(`select repeat('x', 20000000), '\\x0102'::bytea, '${token}', '{"k": "${token}"}'::json, array['${token}']`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [long, bytes, masked, json, array] = result.value.rows[0] as [string, string, string, string, string[]];
      expect(long).toHaveLength(4096);
      expect(result.value.cut).toBeGreaterThanOrEqual(1);
      expect(bytes).toBe('[binary 2 bytes]');
      expect(masked).not.toContain(token);
      expect(json).not.toContain(token);
      expect(array[0]).not.toContain(token);
    });
  });

  describe('limits', () => {
    it('stops a query at the time limit', async () => {
      const result = await run('select count(*) from generate_series(1, 1e10)', { timeoutMs: 200 });
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed', message: expect.stringContaining('longer than 200 ms') } });
    });

    it('counts the time limit over the whole query, not per batch of rows', async () => {
      const started = Date.now();
      // Many cheap rows: every batch stays far below the limit, while all of them together take about ten times as long.
      const result = await run('select (select count(*) from generate_series(1, g * 0 + 4000)) from generate_series(1, 20001) g', { limit: 20000, timeoutMs: 1000 });
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed', message: expect.stringContaining('longer than 1000 ms') } });
      expect(Date.now() - started).toBeLessThan(2500);
    });

    it('does not let the URL lift the time limit', async () => {
      const lifted = new URL(url);
      lifted.searchParams.set('statement_timeout', '0');
      const result = await queryReadOnlyPgsql(lifted.href, 'select count(*) from generate_series(1, 1e10)', { ...options, timeoutMs: 200 });
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
    });

    it.each([0, -1, 1.5, Number.NaN])('fails for the time limit %s', async (timeoutMs) => {
      expect(await run('select 1', { timeoutMs })).toMatchObject({ ok: false, error: { kind: 'failed' } });
    });

    it('does not name the host when it cannot connect', async () => {
      const result = await queryReadOnlyPgsql('postgres://someone:pw@127.0.0.1:1/none', 'select 1', options);
      expect(result).toMatchObject({ ok: false, error: { kind: 'failed' } });
      expect(JSON.stringify(result)).not.toMatch(/127\.0\.0\.1|someone/);
    });

    it('answers through the connections by their name', async () => {
      expect(await readOnlyQuery(connections, 'default', 'select 1', options)).toMatchObject({ ok: true, value: { rows: [[1]] } });
    });
  });
});
