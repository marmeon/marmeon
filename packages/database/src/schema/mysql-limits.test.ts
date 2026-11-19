import type { Application } from '@marmeon/core';
import { DummyDriver, Kysely, MysqlAdapter, MysqlIntrospector, MysqlQueryCompiler, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../../scripts/test/temp-dir.js';
import { freshConnections, withMysql } from '../__fixtures__/databases.ts';
import type { Connections } from '../connections.ts';
import { Migrator } from '../migrations/migrator.ts';
import type { Blueprint } from './blueprint.ts';
import { executePlan, planOf } from './plan.ts';
import { applyPlan, emptyProjection, listCheckOf, tablesAtOf } from './projection.ts';
import type { Schema } from './schema.ts';
import { SchemaError } from './schema-error.ts';

// What MySQL cannot do is refused before the first statement of a plan: MySQL commits every DDL statement as it runs, so a refusal half way
// leaves the first half in place and a rerun fails on it. What the plan alone shows runs on a Kysely that compiles for MySQL and sends nothing
// (always) and on the server. What depends on the tables is held against the database, so it runs on the server
// (MARMEON_TEST_MYSQL_URL, `pnpm test:mysql`), where each case counts the DDL statements sent and compares the catalog before and after.

type Up = (schema: Schema) => void;
const file = { name: 'test', module: 'test' };
const plan = (up: Up) => planOf({ up }, 'up');
const ddl = /^\s*(create|alter|drop|rename)\b/i;

/** A Kysely that compiles for MySQL and runs nothing; it keeps every statement it compiled, and the DDL ones apart. */
function recorder() {
  const statements: string[] = [];
  const everything: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely: Kysely<any>) => new MysqlIntrospector(kysely),
      createQueryCompiler: () => ({
        compileQuery: (node, queryId) => {
          const compiled = new MysqlQueryCompiler().compileQuery(node, queryId);
          everything.push({ sql: compiled.sql, parameters: compiled.parameters });
          if (ddl.test(compiled.sql)) statements.push(compiled.sql);
          return compiled;
        },
      }),
    },
  });
  return { db, statements, everything };
}

/** Runs `up` after `setup` (one migration, or several) has been applied to the schema the migrations know (not to a database), on the recorder. */
async function attempt(setup: Up | readonly Up[] | undefined, up: Up) {
  const { db, statements, everything } = recorder();
  let before = emptyProjection;
  for (const step of setup === undefined ? [] : Array.isArray(setup) ? setup : [setup as Up]) before = applyPlan(before, plan(step), file);
  const steps = plan(up);
  const error = await executePlan(db, 'mysql', steps, undefined, listCheckOf(before, steps, file), tablesAtOf(before, steps, file)).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return { error, statements, everything };
}

const long = (length: number, letter = 'x') => letter.repeat(length);
const parentAndChild: Up = (s) => {
  s.create('parents', (t) => t.id());
  s.create('t', (t) => { t.id(); t.foreignId('parent_id').constrained('parents'); });
};

type Refusal = readonly [name: string, setup: Up | readonly Up[] | undefined, up: Up, code: 'D18' | 'D5', message: RegExp];

/** What the plan alone shows: refused on the recorder and on the server, before a statement is sent. */
const planRefusals: readonly Refusal[] = [
  ['a partial index in a create', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a'); t.unique('a', { where: { a: 'x' } }); }), 'D18', /cannot make the index "t_a_unique" partial \(where\) on MySQL/],
  ['a partial index in an alter', (s) => s.create('t', (t) => { t.id(); t.string('a'); }), (s) => s.alter('t', (t) => t.index('a', { name: 'live', where: { a: { not: null } } })), 'D18', /cannot make the index "live" partial/],
  ['notNull() in an alter', (s) => s.create('t', (t) => { t.id(); t.string('a').nullable(); }), (s) => s.alter('t', (t) => t.notNull('a')), 'D18', /cannot make the column "a" NOT NULL on MySQL/],
  ['nullable() in an alter', (s) => s.create('t', (t) => { t.id(); t.string('a'); }), (s) => s.alter('t', (t) => t.nullable('a')), 'D18', /cannot make the column "a" nullable on MySQL/],
  ['a json() column in an index', undefined, (s) => s.create('t', (t) => { t.id(); t.json('m'); t.index('m'); }), 'D18', /puts the column "m" in the index "t_m_index" on MySQL, but it is a json\(\) column/],
  ['a json() column that is unique', undefined, (s) => s.create('t', (t) => { t.id(); t.json('m').unique(); }), 'D18', /the index "t_m_unique" on MySQL, but it is a json\(\) column/],
  ['a binary() column in an index', undefined, (s) => s.create('t', (t) => { t.id(); t.binary('b'); t.unique('b'); }), 'D18', /but it is a binary\(\) column/],
  ['an index on a text() column of an earlier step of the same plan', undefined, (s) => { s.create('t', (t) => { t.id(); t.text('body'); }); s.alter('t', (t) => t.index('body')); }, 'D18', /"body" in the index "t_body_index" on MySQL, but it is a text\(\) column of an earlier step, which MySQL holds as longtext/],
  ['two text() columns in one key', undefined, (s) => s.create('t', (t) => { t.id(); t.text('a'); t.text('b'); t.index(['a', 'b']); }), 'D18', /the index "t_a_b_index" 6144 bytes wide on MySQL, which allows 3072/],
  ['a key of 3073 bytes (string, integer and a boolean)', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 767); t.integer('b'); t.boolean('c'); t.index(['a', 'b', 'c']); }), 'D18', /the index "t_a_b_c_index" 3073 bytes wide/],
  ['a key of 3073 bytes with a date', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 767); t.date('d'); t.boolean('x'); t.boolean('y'); t.index(['a', 'd', 'x', 'y']); }), 'D18', /3073 bytes wide/],
  ['a key of 3073 bytes with a bigint', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 766); t.bigInteger('n'); t.boolean('x'); t.index(['a', 'n', 'x']); }), 'D18', /3073 bytes wide/],
  ['a key of 3073 bytes with a foreign id', undefined, (s) => { s.create('parents', (t) => t.id()); s.create('t', (t) => { t.id(); t.string('a', 766); t.foreignId('p').constrained('parents'); t.boolean('x'); t.index(['a', 'p', 'x']); }); }, 'D18', /3073 bytes wide/],
  ['a key of 3073 bytes with a float', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 766); t.float('f'); t.boolean('x'); t.index(['a', 'f', 'x']); }), 'D18', /3073 bytes wide/],
  ['a string() of 769 characters in an index', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 769); t.index('a'); }), 'D18', /3076 bytes wide/],
  ['a string() of 769 characters that is unique', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 769).unique(); }), 'D18', /the index "t_a_unique" 3076 bytes wide/],
  ['a primary key of 3076 bytes', undefined, (s) => s.create('t', (t) => { t.string('a', 769).primary(); }), 'D18', /the primary key 3076 bytes wide/],
  ['a json() primary key added by an alter', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.json('k').primary(); }), 'D18', /puts the column "k" in the primary key on MySQL, but it is a json\(\) column/],
  ['a binary() primary key added by an alter', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.binary('k').primary(); }), 'D18', /in the primary key on MySQL, but it is a binary\(\) column/],
  ['a string() of 4000 characters added by an alter with an index, whatever the character set', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.string('k', 4000); t.index('k'); }), 'D18', /the index "t_k_index" at least 4000 bytes wide/],
  ['a decimal that makes the key one byte too wide', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 767); t.decimal('d', 9, 2); t.index(['a', 'd']); }), 'D18', /3073 bytes wide/],
  ['a datetime and two booleans that make the key one byte too wide', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a', 766); t.timestamp('at'); t.boolean('x'); t.boolean('y'); t.index(['a', 'at', 'x', 'y']); }), 'D18', /3073 bytes wide/],
  ['a key of 17 columns', undefined, (s) => s.create('t', (t) => { t.id(); for (let i = 0; i < 17; i++) t.boolean(`c${i}`); t.index(Array.from({ length: 17 }, (_, i) => `c${i}`), 'wide'); }), 'D18', /over 17 columns on MySQL, which allows 16/],
  ['an index name of 65 characters', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a'); t.index('a', long(65)); }), 'D5', /index name "x{65}" is 65 characters long; MySQL allows 64/],
  ['an index name of 65 characters in the alter of an existing column', (s) => s.create('t', (t) => { t.id(); t.string('a'); }), (s) => s.alter('t', (t) => t.index('a', long(65))), 'D5', /index name/],
  ['an index name of 65 characters, written with characters outside the first plane', undefined, (s) => s.create('t', (t) => { t.id(); t.string('a'); t.index('a', '😀'.repeat(65)); }), 'D5', /is 65 characters long/],
  ['an index name derived from the names of the table and the columns', undefined, (s) => s.create('t', (t) => { t.id(); t.string(long(30, 'a')); t.string(long(30, 'b')); t.index([long(30, 'a'), long(30, 'b')]); }), 'D5', /index name "t_a{30}_b{30}_index" is 69 characters long/],
  ['a check constraint name of 65 characters', undefined, (s) => s.create('t', (t) => { t.id(); t.integer('n'); t.check(long(65), 'n > 0'); }), 'D5', /check constraint name/],
  ['the constraint oneOf() names after a long table and column', undefined, (s) => s.create(long(40), (t) => { t.id(); t.string(long(30)).oneOf('a'); }), 'D5', /check constraint name/],
  ['the constraint oneOf() of an alter names after a long table and column', (s) => s.create(long(40), (t) => { t.id(); t.string(long(30)); }), (s) => s.alter(long(40), (t) => t.oneOf(long(30), ['a'])), 'D5', /check constraint name/],
  ['a foreign key name derived from a long table and column', (s) => s.create('parents', (t) => t.id()), (s) => s.create(long(40), (t) => { t.id(); t.foreignId(long(30)).constrained('parents'); }), 'D5', /foreign key name/],
  ['a table name of 65 characters', undefined, (s) => s.create(long(65), (t) => t.id()), 'D5', /table name/],
  ['a column name of 65 characters', undefined, (s) => s.create('t', (t) => { t.id(); t.string(long(65)); }), 'D5', /column name/],
  ['a column renamed to 65 characters', (s) => s.create('t', (t) => { t.id(); t.string('a'); }), (s) => s.alter('t', (t) => t.renameColumn('a', long(65))), 'D5', /column name/],
  ['a table renamed to 65 characters', (s) => s.create('t', (t) => t.id()), (s) => s.rename('t', long(65)), 'D5', /table name/],
];

const foreignKeyTable: Up = parentAndChild;
const hasCheck: Up = (s) => s.create('t', (t) => { t.id(); t.string('role').oneOf('a', 'b'); t.integer('n'); t.check('t_n', 'n > 0'); });
const retired: readonly Up[] = [(s) => { s.create('parents', (t) => t.id()); s.create('t', (t) => { t.id(); t.foreignId('parent_id').constrained('parents').nullable(); }); }, (s) => s.alter('t', (t) => t.retire('parent_id'))];

/** What depends on the tables: refused against the database, so on the server. The recorder has no database and the server decides there. */
const databaseRefusals: readonly Refusal[] = [
  ['a primary key of 3076 bytes added by an alter', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.string('k', 769).primary(); }), 'D18', /schema\.alter\('t'\) makes the primary key 3076 bytes wide/],
  ['a unique string() of 769 characters added by an alter', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.string('k', 769).unique(); }), 'D18', /the index "t_k_unique" 3076 bytes wide/],
  ['a string() of 769 characters added to a table of the database that is utf8mb4, with an index', (s) => s.create('t', (t) => t.id()), (s) => s.alter('t', (t) => { t.string('k', 769); t.index('k'); }), 'D18', /the index "t_k_index" 3076 bytes wide/],
  ['an index on a json() column of an earlier migration', (s) => s.create('t', (t) => { t.id(); t.json('m'); }), (s) => s.alter('t', (t) => t.index('m')), 'D18', /"m" in the index "t_m_index" on MySQL, but it is a json column/],
  ['an index on a text() column of an earlier migration', (s) => s.create('t', (t) => { t.id(); t.text('body'); }), (s) => s.alter('t', (t) => t.index('body')), 'D18', /"body" in the index "t_body_index" on MySQL, but it is a text column \(MySQL holds a text\(\) column of an earlier step or migration as longtext\)/],
  ['a unique index on a text() column of an earlier migration', (s) => s.create('t', (t) => { t.id(); t.text('body'); }), (s) => s.alter('t', (t) => t.unique('body')), 'D18', /"body" in the index "t_body_unique"/],
  ['an index on a text() column that this alter renamed', (s) => s.create('t', (t) => { t.id(); t.text('body'); }), (s) => s.alter('t', (t) => { t.renameColumn('body', 'text'); t.index('text'); }), 'D18', /"text" in the index "t_text_index"/],
  ['a key over columns of earlier migrations that one more column pushes over', (s) => s.create('t', (t) => { t.id(); t.string('a', 767); t.integer('b'); t.boolean('c'); }), (s) => s.alter('t', (t) => t.index(['a', 'b', 'c'])), 'D18', /3073 bytes wide/],
  ['a rename with indexes that makes an index name 65 characters long', (s) => s.create('t', (t) => { t.id(); t.string('a'); t.index('a', `t_${long(62)}`); }), (s) => s.rename('t', 'tt', { indexes: true }), 'D5', /name after the rename "tt_x{62}" is 65 characters long/],
  ['a rename with indexes of a table with a foreign key', foreignKeyTable, (s) => { s.create('first', (t) => t.id()); s.rename('t', 'u', { indexes: true }); }, 'D18', /cannot run on MySQL: the table has constraints named after it \("t_parent_id_fkey"\)/],
  ['a rename with indexes of a table with a oneOf() constraint', hasCheck, (s) => { s.create('first', (t) => t.id()); s.rename('t', 'u', { indexes: true }); }, 'D18', /"t_role_check"/],
  ['a rename with indexes of a table with a check()', hasCheck, (s) => { s.create('first', (t) => t.id()); s.rename('t', 'u', { indexes: true }); }, 'D18', /"t_n"/],
  ['a rename with indexes that gives an index the name another one has', [(s) => s.create('c', (t) => { t.id(); t.string('a'); t.index('a'); }), (s) => s.raw({ mysql: sql`create index cc_a_index on c (id)` })], (s) => { s.create('first', (t) => t.id()); s.rename('c', 'cc', { indexes: true }); }, 'D18', /would give the index "c_a_index" the name "cc_a_index", which another index of the table has/],
  ['a rename with indexes after an alter that added a column, with an index name another one has', [(s) => s.create('c', (t) => { t.id(); t.string('a'); t.index('a'); }), (s) => s.raw({ mysql: sql`create index cc_a_index on c (id)` })], (s) => { s.alter('c', (t) => t.string('z')); s.rename('c', 'cc', { indexes: true }); }, 'D18', /would give the index "c_a_index" the name "cc_a_index"/],
  ['a column that a foreign key holds', foreignKeyTable, (s) => s.alter('t', (t) => t.dropColumn('parent_id')), 'D18', /cannot drop the column "parent_id" on MySQL: the foreign key "t_parent_id_fkey" holds it, to "parents.id"/],
  ['a column that a foreign key holds, renamed twice in the same alter', foreignKeyTable, (s) => s.alter('t', (t) => { t.renameColumn('parent_id', 'q'); t.renameColumn('q', 'r'); t.dropColumn('r'); }), 'D18', /cannot drop the column "r" on MySQL: the foreign key "t_parent_id_fkey" holds it/],
  ['a column that a foreign key of another table references', foreignKeyTable, (s) => s.alter('parents', (t) => t.dropColumn('id')), 'D18', /the foreign key "t_parent_id_fkey" of "t" references it/],
  ['a column that a foreign key holds, renamed first in the same alter', foreignKeyTable, (s) => s.alter('t', (t) => { t.renameColumn('parent_id', 'mother_id'); t.dropColumn('mother_id'); }), 'D18', /cannot drop the column "mother_id"/],
  ['a retired column that a foreign key still holds', retired, (s) => s.alter('t', (t) => t.dropColumn('parent_id')), 'D18', /the foreign key "t_parent_id_fkey" holds it/],
  ['a column that the foreign key of a retired column references', retired, (s) => s.alter('parents', (t) => t.dropColumn('id')), 'D18', /the foreign key "t_parent_id_fkey" of "t" references it/],
  ['a column that a foreign key holds, after the table was renamed without its indexes', [(s) => { s.create('parents', (t) => t.id()); s.create('orders', (t) => { t.id(); t.foreignId('parent_id').constrained('parents'); }); }, (s) => s.rename('orders', 'bills')], (s) => s.alter('bills', (t) => t.dropColumn('parent_id')), 'D18', /the foreign key "orders_parent_id_fkey" holds it/],
  ['renaming the column of a oneOf() list', hasCheck, (s) => s.alter('t', (t) => t.renameColumn('role', 'kind')), 'D18', /cannot rename the column "role" to "kind" on MySQL: the check "t_role_check" names it/],
  ['renaming the column a check() starts with', hasCheck, (s) => s.alter('t', (t) => t.renameColumn('n', 'count')), 'D18', /the check "t_n" names it/],
  ['dropping a table that a foreign key references', foreignKeyTable, (s) => s.drop('parents'), 'D18', /schema\.drop\('parents'\) cannot run on MySQL: the foreign key "t_parent_id_fkey" of "t" references the table/],
  [
    'dropping the last index a foreign key stands on',
    (s) => { s.create('p', (t) => t.id()); s.create('c', (t) => { t.id(); t.foreignId('p_id').constrained('p'); t.integer('at'); t.index(['p_id', 'at']); }); },
    (s) => s.alter('c', (t) => t.dropIndex('c_p_id_at_index')),
    'D18',
    /cannot drop the last index that the foreign key "c_p_id_fkey" stands on \("p_id"\) on MySQL/,
  ],
];

describe('what MySQL refuses before the first statement of a plan', () => {
  it.each(planRefusals)('refuses %s, and sends no statement', async (_name, setup, up, code, message) => {
    const { error, statements } = await attempt(setup, up);
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as Error).message).toMatch(new RegExp(`^\\[marmeon:${code}\\] `));
    expect((error as Error).message).toMatch(message);
    expect(statements).toEqual([]);
  });

  it('refuses the later step of a plan before the first one runs', async () => {
    const { error, statements } = await attempt(undefined, (s) => {
      s.create('first', (t) => t.id());
      s.alter('first', (t) => { t.string('a'); t.index('a', { name: 'partial', where: { a: 'x' } }); });
    });
    expect((error as Error).message).toMatch(/schema\.alter\('first'\) cannot make the index "partial" partial/);
    expect(statements).toEqual([]);
  });

  it('names where the alternatives are written', async () => {
    const { error } = await attempt(undefined, (s) => s.create('t', (t) => { t.id(); t.string('a'); t.index('a', { name: 'p', where: { a: 'x' } }); }));
    expect((error as Error).message).toContain('docs/migrations.md#what-mysql-refuses-before-a-migration-runs');
  });

  it('reads nothing from the database for a plan that only creates tables', async () => {
    const { error, everything } = await attempt(undefined, (s) => {
      s.create('a', (t) => { t.id(); t.string('x'); t.index('x'); });
      s.create('b', (t) => t.id());
    });
    expect(error).toBeUndefined();
    expect(everything.filter((query) => /information_schema/i.test(query.sql))).toEqual([]);
  });

  it('reads nothing for an alter of a table that the same plan created', async () => {
    const { error, everything } = await attempt(undefined, (s) => {
      s.create('a', (t) => { t.id(); t.string('x'); });
      s.alter('a', (t) => { t.index('x'); t.dropIndex('a_x_index'); });
    });
    expect(error).toBeUndefined();
    expect(everything.filter((query) => /information_schema/i.test(query.sql))).toEqual([]);
  });

  it('asks the catalog with the names of the tables as parameters, not in the text', async () => {
    const { error, everything } = await attempt((s) => s.create("o'brien", (t) => { t.id(); t.string('x'); }), (s) => s.alter("o'brien", (t) => t.dropColumn('x')));
    expect(error).toBeUndefined();
    const asked = everything.filter((query) => /information_schema/i.test(query.sql));
    expect(asked.length).toBeGreaterThan(0);
    for (const query of asked) {
      expect(query.sql).not.toContain("o'brien");
      expect(query.parameters).toContain("o'brien");
    }
  });

  it.each(databaseRefusals)('lets %s through when the catalog shows nothing: the server decides', async (_name, setup, up) => {
    const { error } = await attempt(setup, up);
    expect(error).toBeUndefined();
  });

  describe('lets through what MySQL takes', () => {
    it.each([
      ['a key of exactly 3072 bytes', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 767); t.integer('b'); t.index(['a', 'b']); })],
      ['a key of exactly 3072 bytes with a date and five booleans', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 766); t.date('d'); for (const name of ['v', 'w', 'x', 'y', 'z']) t.boolean(name); t.index(['a', 'd', 'v', 'w', 'x', 'y', 'z']); })],
      ['a key of exactly 3072 bytes with a date and a boolean', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 767); t.date('d'); t.boolean('x'); t.index(['a', 'd', 'x']); })],
      ['a key of exactly 3072 bytes with a bigint', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 766); t.bigInteger('n'); t.index(['a', 'n']); })],
      ['a key of exactly 3072 bytes with a foreign id', (s: Schema) => { s.create('parents', (t) => t.id()); s.create('t', (t) => { t.id(); t.string('a', 766); t.foreignId('p').constrained('parents'); t.index(['a', 'p']); }); }],
      ['a key of exactly 3072 bytes with a float', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 766); t.float('f'); t.index(['a', 'f']); })],
      ['a key of exactly 3072 bytes with a decimal', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 767); t.decimal('d', 8, 2); t.index(['a', 'd']); })],
      ['a key of exactly 3072 bytes with a datetime', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 766); t.timestamp('at'); t.boolean('x'); t.index(['a', 'at', 'x']); })],
      ['the longest single column of a key', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a', 768).unique(); })],
      ['a text() column in a key of the same blueprint', (s: Schema) => s.create('t', (t) => { t.id(); t.text('a').unique(); })],
      ['a text() column added and indexed by one alter', (s: Schema) => s.alter('t', (t) => { t.text('c'); t.index('c'); })],
      ['a key of 16 columns', (s: Schema) => s.create('t', (t) => { t.id(); for (let i = 0; i < 16; i++) t.boolean(`c${i}`); t.index(Array.from({ length: 16 }, (_, i) => `c${i}`), 'wide'); })],
      ['names of exactly 64 characters', (s: Schema) => s.create(long(64), (t) => { t.id(); t.string(long(64)); t.index(long(64), long(64, 'y')); t.check(long(64, 'z'), 'true'); })],
      ['names of 64 characters outside the first plane', (s: Schema) => s.create('t', (t) => { t.id(); t.string('a'); t.index('a', '😀'.repeat(64)); })],
      ['a column of a table the migrations do not know', (s: Schema) => s.alter('elsewhere', (t) => t.index('anything'))],
      ['a column that holds a foreign key, dropped after a raw step', (s: Schema) => { s.raw({ mysql: sql`select 1` }); s.alter('t', (t) => t.dropColumn('parent_id')); }],
      ['a text() column indexed after a raw step', (s: Schema) => { s.raw({ mysql: sql`select 1` }); s.alter('free', (t) => t.index('a')); }],
      ['a column that no foreign key holds', (s: Schema) => s.alter('t', (t) => t.dropColumn('plain'))],
      ['a rename with indexes of a table without constraints named after it', (s: Schema) => s.rename('free', 'liberated', { indexes: true })],
    ])('%s', async (_name, up) => {
      const { error, statements } = await attempt(
        (s) => {
          s.create('parents', (t) => t.id());
          s.create('t', (t) => { t.id(); t.foreignId('parent_id').constrained('parents'); t.string('plain'); });
          s.create('free', (t) => { t.id(); t.string('a'); t.index('a'); });
        },
        up,
      );
      expect(error).toBeUndefined();
      expect(statements).not.toEqual([]);
    });
  });
});

/**
 * Runs `up` on the connection as a migration does on MySQL, outside a transaction (its DDL would end it), and hands the schema it leaves to the connection.
 * (`runMigration` wraps its plan in a transaction, which MySQL refuses for DDL.)
 */
async function run(connections: Connections, up: Up): Promise<void> {
  const before = connections.projection();
  const steps = plan(up);
  await executePlan(connections.get(), 'mysql', steps, undefined, listCheckOf(before, steps, file), tablesAtOf(before, steps, file));
  connections.publish({ ...applyPlan(before, steps, file), migrations: before.migrations });
}

/** The tables, columns, indexes and constraints of the database, one line each. */
async function catalog(connections: Connections): Promise<string[]> {
  const { rows } = await sql<{ line: string }>`
    select concat_ws('|', 'table', table_name) as line from information_schema.tables where table_schema = database()
    union all select concat_ws('|', 'column', table_name, column_name, column_type, is_nullable, column_default) from information_schema.columns where table_schema = database()
    union all select concat_ws('|', 'index', table_name, index_name, seq_in_index, column_name) from information_schema.statistics where table_schema = database()
    union all select concat_ws('|', 'constraint', table_name, constraint_name, constraint_type) from information_schema.table_constraints where table_schema = database()`.execute(connections.get());
  return rows.map((row) => row.line).sort();
}

withMysql('what MySQL refuses before the first statement of a plan, on the server', () => {
  describe('refusals, a database for each', { timeout: 30_000 }, () => {
    // One database a case: what the setup makes is not seen by the next.
    it.each([...planRefusals, ...databaseRefusals].map(([name, setup, up, code, message]) => ({ name, setup, up, code, message })))('refuses $name with nothing sent and the database as it was', async ({ setup, up, code, message }) => {
      const own = await freshConnections('mysql');
      try {
        for (const step of setup === undefined ? [] : Array.isArray(setup) ? setup : [setup as Up]) await run(own.connections, step);
        const before = await catalog(own.connections);
        const sent: string[] = [];
        const stopOwn = own.connections.onQuery((query) => {
          if (ddl.test(query.sql)) sent.push(query.sql);
        });
        const error = await run(own.connections, up).then(
          () => undefined,
          (caught: unknown) => caught,
        );
        stopOwn();
        expect(error).toBeInstanceOf(SchemaError);
        expect((error as Error).message).toMatch(new RegExp(`^\\[marmeon:${code}\\] `));
        expect((error as Error).message).toMatch(message);
        expect(sent).toEqual([]);
        expect(await catalog(own.connections)).toEqual(before);
      } finally {
        await own.close();
      }
    });
  });

  describe('what the server takes', { timeout: 30_000 }, () => {
    let connections: Connections;
    let close: () => Promise<void>;
    /** The DDL statements sent since the last call, which resets the count. */
    const sent: string[] = [];
    let stop = () => {};

    beforeAll(async () => {
      ({ connections, close } = await freshConnections('mysql'));
      stop = connections.onQuery((query) => {
        if (ddl.test(query.sql)) sent.push(query.sql);
      });
    });
    afterAll(async () => {
      stop();
      await close();
    });

    const migrate = (up: Up) => run(connections, up);
    const drain = () => sent.splice(0);
    const names = async (table: string) =>
      (await sql<{ name: string }>`select distinct index_name as name from information_schema.statistics where table_schema = database() and table_name = ${table} and index_name <> 'PRIMARY' order by index_name`.execute(connections.get())).rows.map((row) => row.name);
    const columnsOf = async (table: string) =>
      (await sql<{ name: string }>`select column_name as name from information_schema.columns where table_schema = database() and table_name = ${table} order by ordinal_position`.execute(connections.get())).rows.map((row) => row.name);

    it('holds the keys of exactly 3072 bytes that the plan lets through, and the server refuses the same keys with one byte more', async () => {
      await migrate((s) => {
        s.create('srv_k1', (t) => { t.id(); t.string('a', 767); t.integer('b'); t.index(['a', 'b']); });
        s.create('srv_k2', (t) => { t.id(); t.string('a', 766); t.timestamp('at'); t.boolean('x'); t.index(['a', 'at', 'x']); });
        s.create('srv_k3', (t) => { t.id(); t.string('a', 767); t.decimal('d', 8, 2); t.index(['a', 'd']); });
        s.create('srv_k4', (t) => { t.id(); t.string('a', 766); t.date('d'); for (const name of ['v', 'w', 'x', 'y', 'z']) t.boolean(name); t.index(['a', 'd', 'v', 'w', 'x', 'y', 'z']); });
        s.create('srv_k5', (t) => { t.id(); t.string('a', 768).unique(); });
        s.create('srv_k6', (t) => { t.string('a', 768).primary(); });
        s.create('srv_k7', (t) => { t.id(); t.string('a', 767); t.date('d'); t.boolean('x'); t.index(['a', 'd', 'x']); });
        s.create('srv_k8', (t) => { t.id(); t.string('a', 766); t.bigInteger('n'); t.index(['a', 'n']); });
        s.create('srv_k9', (t) => { t.id(); t.string('a', 766); t.float('f'); t.index(['a', 'f']); });
      });
      // The plan refuses these (see the cases above); written as SQL, they show that the server does too, and by the same arithmetic.
      for (const definition of [
        'a varchar(767) not null, b integer not null, c boolean not null, key (a, b, c)',
        'a varchar(766) not null, b datetime(3) not null, c boolean not null, d boolean not null, key (a, b, c, d)',
        'a varchar(767) not null, b numeric(9, 2) not null, key (a, b)',
        'a varchar(767) not null, b date not null, c boolean not null, d boolean not null, key (a, b, c, d)',
        'a varchar(766) not null, b bigint not null, c boolean not null, key (a, b, c)',
        'a varchar(766) not null, b double not null, c boolean not null, key (a, b, c)',
        'a varchar(769) not null, key (a)',
        'a varchar(769) not null primary key',
      ]) {
        await expect(sql.raw(`create table srv_too_wide (${definition})`).execute(connections.get())).rejects.toThrow(/Specified key was too long; max key length is 3072 bytes/);
      }
    });

    // The columns of earlier migrations, by the type the catalog reports: `n` characters of a varchar so that the key is 3072 bytes with the type, 3073 with one more boolean.
    const cataloged: [string, number, (t: Blueprint) => void, string[]][] = [
      ['integer', 767, (t) => void t.integer('c1'), ['c1']],
      ['bigint', 766, (t) => void t.bigInteger('c1'), ['c1']],
      ['double', 766, (t) => void t.float('c1'), ['c1']],
      ['date and boolean', 767, (t) => { t.date('c1'); t.boolean('c2'); }, ['c1', 'c2']],
      ['datetime and boolean', 766, (t) => { t.timestamp('c1'); t.boolean('c2'); }, ['c1', 'c2']],
      ['decimal(8, 2)', 767, (t) => void t.decimal('c1', 8, 2), ['c1']],
      ['four booleans', 767, (t) => { for (const name of ['c1', 'c2', 'c3', 'c4']) t.boolean(name); }, ['c1', 'c2', 'c3', 'c4']],
    ];
    it.each(cataloged)('holds a key over columns of an earlier migration by what the catalog reports: %s', async (label, length, typed, keyed) => {
      const table = `srv_cat_${label.replaceAll(/\W+/g, '_')}`;
      await migrate((s) => s.create(table, (t) => { t.id(); t.string('a', length); typed(t); t.boolean('z'); }));
      drain();
      await migrate((s) => s.alter(table, (t) => t.index(['a', ...keyed], 'fits')));
      expect(await names(table)).toContain('fits');
      const before = await catalog(connections);
      drain();
      await expect(migrate((s) => s.alter(table, (t) => t.index(['a', ...keyed, 'z'], 'too_wide')))).rejects.toThrow(/\[marmeon:D18\].*(at least )?3073 bytes wide/);
      expect(drain()).toEqual([]);
      expect(await catalog(connections)).toEqual(before);
    });

    it('counts the bytes of a column an alter adds by the default character set of its table', async () => {
      await migrate((s) => s.create('srv_l1', (t) => t.id()));
      await migrate((s) => s.raw({ mysql: sql`alter table srv_l1 default character set latin1 collate latin1_bin` }));
      // 800 characters are 800 bytes in latin1, and 3200 in utf8mb4, which the table was made in.
      await migrate((s) => s.alter('srv_l1', (t) => { t.string('code', 800); t.index('code'); }));
      expect(await names('srv_l1')).toEqual(['srv_l1_code_index']);
    });

    it('holds the bytes of a latin1 table exactly: 3072 passes, 3073 and a uuid that tips it over are refused', async () => {
      await migrate((s) => s.create('srv_l2', (t) => t.id()));
      await migrate((s) => s.raw({ mysql: sql`alter table srv_l2 default character set latin1 collate latin1_bin` }));
      await migrate((s) => s.alter('srv_l2', (t) => { t.string('a', 3072); t.index('a'); }));
      await migrate((s) => s.alter('srv_l2', (t) => { t.string('b', 3036); t.uuid('u'); t.index(['b', 'u']); }));
      expect(await names('srv_l2')).toEqual(['srv_l2_a_index', 'srv_l2_b_u_index']);
      const before = await catalog(connections);
      drain();
      await expect(migrate((s) => s.alter('srv_l2', (t) => { t.string('c', 3073); t.index('c'); }))).rejects.toThrow(/\[marmeon:D18\].*the index "srv_l2_c_index" (at least )?3073 bytes wide/);
      await expect(migrate((s) => s.alter('srv_l2', (t) => { t.string('d', 3037); t.uuid('v'); t.index(['d', 'v']); }))).rejects.toThrow(/\[marmeon:D18\].*3073 bytes wide/);
      expect(drain()).toEqual([]);
      expect(await catalog(connections)).toEqual(before);
    });

    it('makes a table utf8mb4 whatever the default character set of the database is', async () => {
      const own = await freshConnections('mysql');
      try {
        const name = (await sql<{ name: string }>`select database() as name`.execute(own.connections.get())).rows[0]!.name;
        await sql.raw(`alter database \`${name}\` default character set latin1`).execute(own.connections.get());
        await run(own.connections, (s) => s.create('srv_made', (t) => { t.id(); t.string('a', 768).unique(); }));
        const { rows } = await sql<{ collation: string }>`select table_collation as collation from information_schema.tables where table_schema = database() and table_name = 'srv_made'`.execute(own.connections.get());
        expect(rows.map((row) => row.collation)).toEqual(['utf8mb4_0900_bin']);
        await expect(run(own.connections, (s) => s.create('srv_wide', (t) => { t.id(); t.string('a', 769).unique(); }))).rejects.toThrow(/3076 bytes wide/);
      } finally {
        await own.close();
      }
    });

    it('takes an index name of 64 characters that take three bytes each, and refuses 65: MySQL counts characters', async () => {
      const wide = '界'.repeat(64);
      await migrate((s) => s.create('srv_names', (t) => { t.id(); t.string('a'); t.index('a', wide); }));
      expect(await names('srv_names')).toEqual([wide]);
      await expect(sql.raw(`create index ${'界'.repeat(65)} on srv_names (a)`).execute(connections.get())).rejects.toThrow(/Identifier name .* is too long/);
    });

    it('stores an index name of characters outside the first plane as question marks, and counts them as one character each', async () => {
      // What MySQL does with such a name, held as it is: it keeps no character of it, and 65 are one too many all the same.
      await migrate((s) => s.create('srv_astral', (t) => { t.id(); t.string('a'); t.index('a', '😀'.repeat(64)); }));
      expect(await names('srv_astral')).toEqual(['?'.repeat(64)]);
      await expect(sql.raw(`create index ${'😀'.repeat(65)} on srv_astral (a)`).execute(connections.get())).rejects.toThrow(/Identifier name .* is too long/);
    });

    it('adds a text() column and indexes it in one alter(): MySQL holds it as varchar(768)', async () => {
      await migrate((s) => s.create('srv_txt', (t) => t.id()));
      await migrate((s) => s.alter('srv_txt', (t) => { t.text('c'); t.index('c'); }));
      const { rows } = await sql<{ type: string }>`select column_type as type from information_schema.columns where table_schema = database() and table_name = 'srv_txt' and column_name = 'c'`.execute(connections.get());
      expect(rows.map((row) => row.type)).toEqual(['varchar(768)']);
    });

    describe('a rename with its indexes', () => {
      it('renames the indexes that start with the old name, and none other, in the statement that renames the table', async () => {
        await migrate((s) => s.create('srv_old', (t) => { t.id(); t.string('a'); t.string('b'); t.index('a'); t.unique(['a', 'b']); t.index('b', 'by_b'); }));
        drain();
        await migrate((s) => s.rename('srv_old', 'srv_new', { indexes: true }));
        expect(await names('srv_new')).toEqual(['by_b', 'srv_new_a_b_unique', 'srv_new_a_index']);
        expect(drain()).toEqual(['alter table `srv_old` rename to `srv_new`, rename index `srv_old_a_b_unique` to `srv_new_a_b_unique`, rename index `srv_old_a_index` to `srv_new_a_index`']);
      });

      it('takes a rename with indexes after an alter that added a column and an index, and renames the indexes of both', async () => {
        await migrate((s) => s.create('srv_f', (t) => { t.id(); t.string('a'); t.index('a'); }));
        await migrate((s) => { s.alter('srv_f', (t) => { t.string('z'); t.index('z'); t.dropIndex('srv_f_a_index'); }); s.rename('srv_f', 'srv_g', { indexes: true }); });
        expect(await names('srv_g')).toEqual(['srv_g_z_index']);
      });

      it('counts an index an earlier alter made and a later one dropped as gone', async () => {
        await migrate((s) => s.create('srv_p1', (t) => { t.id(); t.string('a'); t.index('a'); }));
        await migrate((s) => {
          s.alter('srv_p1', (t) => t.index('a', 'srv_pq_a_index'));
          s.alter('srv_p1', (t) => t.dropIndex('srv_pq_a_index'));
          s.rename('srv_p1', 'srv_pq', { indexes: true });
        });
        expect(await names('srv_pq')).toEqual(['srv_pq_a_index']);
      });

      it('goes through when the new name itself starts with the old one: the indexes change their names in a chain', async () => {
        await migrate((s) => s.create('srv_pa', (t) => { t.id(); t.string('a'); t.index('a', 'srv_pa_x_index'); t.index('a', 'srv_pa_b_x'); }));
        drain();
        await migrate((s) => s.rename('srv_pa', 'srv_pa_b', { indexes: true }));
        expect(await names('srv_pa_b')).toEqual(['srv_pa_b_b_x', 'srv_pa_b_x_index']);
        expect(drain()).toHaveLength(1);
      });

      it('refuses a name another index has before the table is renamed, also when raw SQL made it', async () => {
        await migrate((s) => s.create('srv_clash', (t) => { t.id(); t.string('a'); t.index('a'); }));
        await migrate((s) => s.raw({ mysql: sql`create index srv_clashed_a_index on srv_clash (id)` }));
        const before = await catalog(connections);
        drain();
        await expect(migrate((s) => { s.create('srv_first', (t) => t.id()); s.rename('srv_clash', 'srv_clashed', { indexes: true }); })).rejects.toThrow(
          /\[marmeon:D18\] schema\.rename\('srv_clash', 'srv_clashed', \{ indexes: true \}\) would give the index "srv_clash_a_index" the name "srv_clashed_a_index"/,
        );
        expect(drain()).toEqual([]);
        expect(await catalog(connections)).toEqual(before);
      });

      it('counts the indexes an earlier alter of the same plan changed, and refuses before the first statement', async () => {
        await migrate((s) => s.create('srv_clash3', (t) => { t.id(); t.string('a'); t.index('a'); }));
        await migrate((s) => s.raw({ mysql: sql`create index srv_clashed3_a_index on srv_clash3 (id)` }));
        drain();
        await expect(migrate((s) => { s.alter('srv_clash3', (t) => t.string('z')); s.rename('srv_clash3', 'srv_clashed3', { indexes: true }); })).rejects.toThrow(/\[marmeon:D18\].*"srv_clashed3_a_index"/);
        expect(drain()).toEqual([]);
        expect(await columnsOf('srv_clash3')).not.toContain('z');
      });

      it('an index that raw SQL made, with a name too long after the rename, is refused before the table is renamed', async () => {
        await migrate((s) => s.create('srv_raw', (t) => { t.id(); t.string('a'); }));
        await sql`create index ${sql.id(`srv_raw_${'q'.repeat(55)}`)} on srv_raw (a)`.execute(connections.get());
        const before = await catalog(connections);
        drain();
        await expect(migrate((s) => s.rename('srv_raw', 'srv_rawer', { indexes: true }))).rejects.toThrow(/\[marmeon:D5\] The name after the rename "srv_rawer_q{55}" is 65 characters long/);
        expect(drain()).toEqual([]);
        expect(await catalog(connections)).toEqual(before);
      });

      it('is refused for a table with a foreign key before it is renamed, and goes through without `indexes`', async () => {
        await migrate((s) => {
          s.create('srv_parent', (t) => t.id());
          s.create('srv_child', (t) => { t.id(); t.foreignId('parent_id').constrained('srv_parent'); });
        });
        const before = await catalog(connections);
        drain();
        await expect(migrate((s) => s.rename('srv_child', 'srv_kid', { indexes: true }))).rejects.toThrow(/\[marmeon:D18\].*"srv_child_parent_id_fkey"/);
        expect(drain()).toEqual([]);
        expect(await catalog(connections)).toEqual(before);
        await migrate((s) => s.rename('srv_child', 'srv_kid'));
        expect(await columnsOf('srv_kid')).toContain('parent_id');
      });

      it('goes through for a table whose foreign key kept the name of the table it had before, and refuses to drop its column by that name', async () => {
        await migrate((s) => {
          s.create('srv_ps', (t) => t.id());
          s.create('srv_orders', (t) => { t.id(); t.foreignId('parent_id').constrained('srv_ps'); });
        });
        await migrate((s) => s.rename('srv_orders', 'srv_bills'));
        await expect(migrate((s) => s.alter('srv_bills', (t) => t.dropColumn('parent_id')))).rejects.toThrow(/the foreign key "srv_orders_parent_id_fkey" holds it/);
        await migrate((s) => s.rename('srv_bills', 'srv_invoices', { indexes: true }));
        expect(await columnsOf('srv_invoices')).toContain('parent_id');
      });
    });

    describe('what the server takes that the schema of the migrations alone would refuse', () => {
      it('drops a column whose foreign key an earlier migration dropped with raw SQL', async () => {
        await migrate((s) => {
          s.create('srv_p2', (t) => t.id());
          s.create('srv_a2', (t) => { t.id(); t.foreignId('p_id').constrained('srv_p2'); });
        });
        await migrate((s) => s.raw({ mysql: sql`alter table srv_a2 drop foreign key srv_a2_p_id_fkey` }));
        await migrate((s) => s.alter('srv_a2', (t) => t.dropColumn('p_id')));
        expect(await columnsOf('srv_a2')).toEqual(['id']);
      });

      it('renames the indexes of a table whose foreign key and check an earlier migration dropped with raw SQL', async () => {
        await migrate((s) => {
          s.create('srv_p3', (t) => t.id());
          s.create('srv_b3', (t) => { t.id(); t.string('role').oneOf('a'); t.foreignId('p_id').constrained('srv_p3'); t.index('role'); });
        });
        await migrate((s) => s.raw({ mysql: sql`alter table srv_b3 drop foreign key srv_b3_p_id_fkey, drop check srv_b3_role_check` }));
        await migrate((s) => s.rename('srv_b3', 'srv_c3', { indexes: true }));
        expect(await names('srv_c3')).toEqual(['srv_c3_p_id_fkey', 'srv_c3_role_index']);
      });

      it('indexes a text() column that an earlier migration changed to a varchar with raw SQL', async () => {
        await migrate((s) => s.create('srv_cc', (t) => { t.id(); t.text('body'); }));
        await migrate((s) => s.raw({ mysql: sql`alter table srv_cc modify column body varchar(500) not null` }));
        await migrate((s) => s.alter('srv_cc', (t) => t.index('body')));
        expect(await names('srv_cc')).toEqual(['srv_cc_body_index']);
      });

      it('indexes a text() column that raw SQL of the same migration changed to a varchar', async () => {
        await migrate((s) => s.create('srv_dd', (t) => { t.id(); t.text('body'); }));
        await migrate((s) => {
          s.raw({ mysql: sql`alter table srv_dd modify column body varchar(500) not null` });
          s.alter('srv_dd', (t) => t.index('body'));
        });
        expect(await names('srv_dd')).toEqual(['srv_dd_body_index']);
      });

      it('counts the bytes of a latin1 column the way the catalog reports them', async () => {
        await migrate((s) => s.create('srv_ee', (t) => { t.id(); t.string('code', 800); }));
        await migrate((s) => s.raw({ mysql: sql`alter table srv_ee modify column code varchar(800) character set latin1 not null` }));
        // 800 characters are 3200 bytes in utf8mb4, which the migrations' schema would count, and 800 bytes in latin1.
        await migrate((s) => s.alter('srv_ee', (t) => t.index('code')));
        expect(await names('srv_ee')).toEqual(['srv_ee_code_index']);
      });

      it('renames a column of a table whose check an earlier alter dropped, and one that the same alter drops first', async () => {
        await migrate((s) => s.create('srv_r1', (t) => { t.id(); t.string('role').oneOf('a', 'b'); }));
        await migrate((s) => s.alter('srv_r1', (t) => { t.dropCheck('srv_r1_role_check'); t.renameColumn('role', 'kind'); }));
        expect(await columnsOf('srv_r1')).toEqual(['id', 'kind']);
        await migrate((s) => s.create('srv_r2', (t) => { t.id(); t.string('role').oneOf('a', 'b'); }));
        await migrate((s) => s.alter('srv_r2', (t) => t.dropCheck('srv_r2_role_check')));
        await migrate((s) => s.alter('srv_r2', (t) => t.renameColumn('role', 'kind')));
        expect(await columnsOf('srv_r2')).toEqual(['id', 'kind']);
      });

      it('drops tables in an order the server takes: the child first, and a table that references itself', async () => {
        await migrate((s) => {
          s.create('srv_dp', (t) => t.id());
          s.create('srv_dc', (t) => { t.id(); t.foreignId('p_id').constrained('srv_dp'); });
        });
        await migrate((s) => { s.drop('srv_dc'); s.drop('srv_dp'); });
        await migrate((s) => s.create('srv_self', (t) => { t.id(); t.foreignId('parent_id').constrained('srv_self').nullable(); }));
        await migrate((s) => s.drop('srv_self'));
        expect(await columnsOf('srv_dp')).toEqual([]);
        expect(await columnsOf('srv_self')).toEqual([]);
      });

      it('drops a referenced table after a data step turned foreign_key_checks off on the connection of the migration', async () => {
        await migrate((s) => {
          s.create('srv_fp', (t) => t.id());
          s.create('srv_fc', (t) => { t.id(); t.foreignId('p_id').constrained('srv_fp'); });
        });
        const before = connections.projection();
        const steps = plan((s) => {
          s.data(async (db) => void (await sql`set foreign_key_checks = 0`.execute(db)));
          s.drop('srv_fp');
        });
        // As the migrator runs a migration on MySQL: one connection, which the data step's transaction uses too.
        await connections.get().connection().execute(async (own) => {
          try {
            await executePlan(own, 'mysql', steps, undefined, listCheckOf(before, steps, file), tablesAtOf(before, steps, file));
          } finally {
            await sql`set foreign_key_checks = 1`.execute(own);
          }
        });
        connections.publish({ ...applyPlan(before, steps, file), migrations: before.migrations });
        expect(await columnsOf('srv_fp')).toEqual([]);
      });

      it('refuses the last index of a foreign key also with foreign_key_checks off on the connection, as the server does', async () => {
        await migrate((s) => {
          s.create('srv_gp', (t) => t.id());
          s.create('srv_gc', (t) => { t.id(); t.foreignId('p_id').constrained('srv_gp'); t.integer('at'); t.index(['p_id', 'at']); });
        });
        const before = connections.projection();
        const steps = plan((s) => {
          s.data(async (db) => void (await sql`set foreign_key_checks = 0`.execute(db)));
          s.alter('srv_gc', (t) => t.dropIndex('srv_gc_p_id_at_index'));
        });
        const catalogBefore = await catalog(connections);
        drain();
        await connections.get().connection().execute(async (own) => {
          try {
            // The plan is refused before its first statement, the data step included.
            await expect(executePlan(own, 'mysql', steps, undefined, listCheckOf(before, steps, file), tablesAtOf(before, steps, file))).rejects.toThrow(/\[marmeon:D18\].*cannot drop the last index that the foreign key "srv_gc_p_id_fkey" stands on/);
            // The same statements sent as they are: the server refuses with 1553 although the checks are off.
            await sql`set foreign_key_checks = 0`.execute(own);
            await expect(sql`drop index srv_gc_p_id_at_index on srv_gc`.execute(own)).rejects.toThrow(/needed in a foreign key constraint|1553/);
          } finally {
            await sql`set foreign_key_checks = 1`.execute(own);
          }
        });
        expect(drain()).toEqual([expect.stringMatching(/^drop index/)]);
        expect(await catalog(connections)).toEqual(catalogBefore);
      });

      it('drops an index that another one covers for the foreign key', async () => {
        await migrate((s) => {
          s.create('srv_ip', (t) => t.id());
          s.create('srv_ic', (t) => { t.id(); t.foreignId('p_id').constrained('srv_ip'); t.integer('at'); t.index(['p_id', 'at']); t.index('p_id'); });
        });
        await migrate((s) => s.alter('srv_ic', (t) => t.dropIndex('srv_ic_p_id_at_index')));
        expect(await names('srv_ic')).toContain('srv_ic_p_id_index');
      });
    });

    describe('what the server takes that the plan lets through', () => {
      it('adds a foreign key to an existing column, and refuses to drop the column while the key holds it', async () => {
        await migrate((s) => {
          s.create('srv_owner', (t) => t.id());
          s.create('srv_thing', (t) => { t.id(); t.foreignId('owner_id'); });
        });
        await migrate((s) => s.alter('srv_thing', (t) => t.foreign('owner_id').constrained('srv_owner').cascadeOnDelete()));
        const { rows } = await sql<{ name: string }>`select constraint_name as name from information_schema.table_constraints where table_schema = database() and table_name = 'srv_thing' and constraint_type = 'FOREIGN KEY'`.execute(connections.get());
        expect(rows.map((row) => row.name)).toEqual(['srv_thing_owner_id_fkey']);
        const before = await catalog(connections);
        drain();
        await expect(migrate((s) => s.alter('srv_thing', (t) => t.dropColumn('owner_id')))).rejects.toThrow(/\[marmeon:D18\] schema\.alter\('srv_thing'\) cannot drop the column "owner_id" on MySQL/);
        await expect(migrate((s) => s.alter('srv_owner', (t) => t.dropColumn('id')))).rejects.toThrow(/\[marmeon:D18\].*the foreign key "srv_thing_owner_id_fkey" of "srv_thing" references it/);
        expect(drain()).toEqual([]);
        expect(await catalog(connections)).toEqual(before);
        // A step of raw SQL that drops the key first is what the message asks for; nothing after it is held against the database.
        await migrate((s) => {
          s.raw({ mysql: sql`alter table srv_thing drop foreign key srv_thing_owner_id_fkey` });
          s.alter('srv_thing', (t) => t.dropColumn('owner_id'));
        });
        expect(await columnsOf('srv_thing')).toEqual(['id']);
      });

      it('adds and drops a check, and replaces the list of oneOf() in one statement that the server takes', async () => {
        await migrate((s) => s.create('srv_checked', (t) => { t.id(); t.string('role').oneOf('a', 'b'); t.integer('n').default(1); }));
        drain();
        await migrate((s) => s.alter('srv_checked', (t) => { t.check('srv_checked_n', 'n > 0'); }));
        await migrate((s) => s.alter('srv_checked', (t) => t.oneOf('role', ['a', 'b', 'c'])));
        expect(drain()).toEqual([
          'alter table `srv_checked` add constraint `srv_checked_n` check (n > 0)',
          'alter table `srv_checked` drop constraint `srv_checked_role_check`, add constraint `srv_checked_role_check` check (`role` in (\'a\', \'b\', \'c\'))',
        ]);
        await sql`insert into srv_checked (role) values ('c')`.execute(connections.get());
        await expect(sql`insert into srv_checked (role, n) values ('d', 1)`.execute(connections.get())).rejects.toThrow(/srv_checked_role_check/);
        await expect(sql`insert into srv_checked (role, n) values ('a', 0)`.execute(connections.get())).rejects.toThrow(/srv_checked_n/);
        await migrate((s) => s.alter('srv_checked', (t) => t.dropCheck('srv_checked_n')));
        await sql`insert into srv_checked (role, n) values ('a', 0)`.execute(connections.get());
      });
    });
  });
});

withMysql('a run of the migrator on MySQL', () => {
  describe('migrations', { timeout: 30_000 }, () => {
    // Made once the MySQL tests run: a file whose tests are all skipped does not remove what its top level made.
    let root = '';

    beforeAll(() => {
      root = workspaceTempDir('marmeon-mysql-limits-');
    });

    const migrator = (connections: Connections, directory: string) =>
      new Migrator({ modules: [{ name: 'limits', migrations: new URL(`../__fixtures__/migrations/${directory}/`, import.meta.url) }], root } as unknown as Application, connections);
    /** The DDL sent from now on, and not the record of migrations. */
    const watch = (connections: Connections) => {
      const sent: string[] = [];
      const stop = connections.onQuery((query) => {
        if (ddl.test(query.sql) && !/\bmigrations\b/.test(query.sql)) sent.push(query.sql);
      });
      return { sent, stop };
    };
    const recorded = async (connections: Connections) => (await sql<{ name: string }>`select name from migrations order by id`.execute(connections.get())).rows.map((row) => row.name);
    const tables = async (connections: Connections) => (await sql<{ name: string }>`select table_name as name from information_schema.tables where table_schema = database() order by table_name`.execute(connections.get())).rows.map((row) => row.name);

    it('refuses a migration that indexes the text() column of an earlier one before it sends a statement', async () => {
      const { connections, close } = await freshConnections('mysql');
      try {
        const { sent, stop } = watch(connections);
        await expect(migrator(connections, 'mysql-limits').migrate()).rejects.toThrow(
          /\[marmeon:D18\] schema\.alter\('limit_notes'\) puts the column "body" in the index "limit_notes_body_index" on MySQL, but it is a text column \(MySQL holds a text\(\) column of an earlier step or migration as longtext\)/,
        );
        stop();
        // The first migration ran (and is recorded); the second sent nothing, not even the index on `title` that would have been fine.
        expect(sent).toEqual([expect.stringMatching(/^create table `limit_notes`/)]);
        expect(await recorded(connections)).toEqual(['2026_03_01_000001_notes']);
      } finally {
        await close();
      }
    });

    it('refuses what the plan of a later migration alone shows before the first migration runs', async () => {
      const { connections, close } = await freshConnections('mysql');
      try {
        const { sent, stop } = watch(connections);
        await expect(migrator(connections, 'mysql-limits-plan').migrate()).rejects.toThrow(/\[marmeon:D18\] Migration 2026_03_02_000002_partial \(module "limits"\): schema\.alter\('lp_a'\) cannot make the index "lp_partial" partial/);
        stop();
        expect(sent).toEqual([]);
        expect(await tables(connections)).not.toContain('lp_a');
        expect(await recorded(connections)).toEqual([]);
      } finally {
        await close();
      }
    });

    it('stops a rollback of several migrations between two when the second needs the database: the first is rolled back and out of the record', async () => {
      const { connections, close } = await freshConnections('mysql');
      try {
        const own = migrator(connections, 'mysql-limits-rollback');
        await own.migrate();
        const { sent, stop } = watch(connections);
        await expect(own.rollback({ steps: 2 })).rejects.toThrow(/\[marmeon:D18\] schema\.alter\('rb_posts'\) cannot drop the column "parent_id" on MySQL: the foreign key "rb_posts_parent_id_fkey" holds it/);
        stop();
        expect(sent).toEqual(['drop table `rb_other`']);
        const present = await tables(connections);
        expect(present).not.toContain('rb_other');
        expect(await sql<{ n: number }>`select count(*) as n from information_schema.columns where table_schema = database() and table_name = 'rb_posts' and column_name = 'parent_id'`.execute(connections.get()).then((result) => Number(result.rows[0]!.n))).toBe(1);
        expect(await recorded(connections)).toEqual(['2026_03_03_000001_tables', '2026_03_03_000002_parent']);
      } finally {
        await close();
      }
    });

    it('refuses a rollback whose down() the plan alone shows cannot run before it rolls back anything', async () => {
      const { connections, close } = await freshConnections('mysql');
      try {
        const own = migrator(connections, 'mysql-limits-rollback-plan');
        await own.migrate();
        const { sent, stop } = watch(connections);
        await expect(own.rollback({ steps: 2 })).rejects.toThrow(/\[marmeon:D18\] Migration 2026_03_04_000001_a \(module "limits"\): schema\.alter\('rq_a'\) cannot make the column "x" nullable on MySQL/);
        stop();
        expect(sent).toEqual([]);
        expect(await tables(connections)).toContain('rq_b');
        expect(await recorded(connections)).toEqual(['2026_03_04_000001_a', '2026_03_04_000002_b']);
      } finally {
        await close();
      }
    });
  });
});
