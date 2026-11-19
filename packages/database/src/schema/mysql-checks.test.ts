import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { checkMysqlState, indexRenamesOf, mysqlStateTables, NO_STATE, type CatalogConstraint, type CatalogForeignKey, type CatalogIndexPart, type MysqlState } from './mysql-checks.ts';
import { mysqlCatalogKeyBytes, type CatalogColumn } from './mysql-keys.ts';
import { planOf } from './plan.ts';
import { applyPlan, emptyProjection, tablesAtOf } from './projection.ts';
import type { Schema } from './schema.ts';

// The second stage of what MySQL refuses, held against hand-built catalogs: a row that is seen refuses the plan, one that is not lets it through.

type Up = (schema: Schema) => void;
const plan = (up: Up) => planOf({ up }, 'up');
const file = { name: 'test', module: 'test' };

const fk = (name: string, table: string, column: string, references: string, extra: Partial<CatalogForeignKey> = {}): CatalogForeignKey => ({
  name, table, local: true, references, referencedLocal: true, parts: [{ column, position: 1, referenced: 'id' }], ...extra,
});
const column = (dataType: string, columnType = dataType, octets: number | null = null): CatalogColumn => ({ dataType, columnType, octets });
const check = (name: string, clause: string): CatalogConstraint => ({ name, type: 'CHECK', clause });
const index = (...parts: (string | [string, false])[]): CatalogIndexPart[] => parts.map((part) => (typeof part === 'string' ? { column: part, whole: true } : { column: part[0], whole: false }));
const state = (over: Partial<MysqlState> = {}): MysqlState => ({ ...NO_STATE, foreignKeyChecks: true, tables: new Set(['t', 'parents', 'c', 'orders', 'a', 'b', 'd', 'free', 'x']), ...over });

/** What `checkMysqlState` says of `up`, as the message or undefined. */
function say(up: Up, held: MysqlState, before?: Up) {
  const steps = plan(up);
  const projection = before ? applyPlan(emptyProjection, plan(before), file) : emptyProjection;
  try {
    checkMysqlState(steps, held, tablesAtOf(projection, steps, file));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('a column a foreign key holds', () => {
  const keys = [fk('t_p_fkey', 't', 'p', 'parents')];
  const held = state({ foreignKeys: keys, columns: new Map([['t', new Map([['p', column('bigint')]])], ['parents', new Map([['id', column('bigint')]])]]) });

  it('cannot be dropped, as the child', () => {
    expect(say((s) => s.alter('t', (t) => t.dropColumn('p')), held)).toMatch(/\[marmeon:D18\].*the foreign key "t_p_fkey" holds it, to "parents.id"/);
  });

  it('is not held against a raw step before it', () => {
    expect(say((s) => { s.raw({ mysql: sql`select 1` }); s.alter('t', (t) => t.dropColumn('p')); }, held)).toBeUndefined();
  });

  it('is still held after an alter that only added a column', () => {
    expect(say((s) => { s.alter('t', (t) => t.string('extra')); s.alter('t', (t) => t.dropColumn('p')); }, held)).toMatch(/holds it/);
  });

  it('is not held for a table that was renamed first', () => {
    expect(say((s) => { s.rename('t', 'u'); s.alter('u', (t) => t.dropColumn('p')); }, held)).toBeUndefined();
  });

  it('cannot be dropped, as the referenced column of another table', () => {
    expect(say((s) => s.alter('parents', (t) => t.dropColumn('id')), held)).toMatch(/the foreign key "t_p_fkey" of "t" references it/);
  });

  it('is not held when the child was dropped or renamed first', () => {
    expect(say((s) => { s.drop('t'); s.alter('parents', (t) => t.dropColumn('id')); }, held)).toBeUndefined();
    expect(say((s) => { s.rename('t', 'u'); s.alter('parents', (t) => t.dropColumn('id')); }, held)).toBeUndefined();
  });

  it('is held when the child is in another database', () => {
    const other = state({ foreignKeys: [fk('x_fkey', 'x', 'p', 'parents', { local: false })] });
    expect(say((s) => s.alter('parents', (t) => t.dropColumn('id')), other)).toMatch(/the foreign key "x_fkey" of "x" references it/);
  });

  it('is found by its old name when this alter renames it first', () => {
    expect(say((s) => s.alter('t', (t) => { t.renameColumn('p', 'q'); t.dropColumn('q'); }), held)).toMatch(/cannot drop the column "q"/);
  });

  it('lets a column through that no foreign key holds', () => {
    expect(say((s) => s.alter('t', (t) => t.dropColumn('other')), held)).toBeUndefined();
  });
});

describe('columns renamed one after the other in one alter', () => {
  const held = state({
    foreignKeys: [fk('t_p_fkey', 't', 'p', 'parents')],
    columns: new Map([['t', new Map([['p', column('longtext')], ['x', column('bigint')]])]]),
  });

  it('finds the column by the name it had when the alter began', () => {
    expect(say((s) => s.alter('t', (t) => { t.renameColumn('p', 'q'); t.renameColumn('q', 'r'); t.dropColumn('r'); }), held)).toMatch(/cannot drop the column "r".*"t_p_fkey" holds it/);
    expect(say((s) => s.alter('t', (t) => { t.renameColumn('p', 'q'); t.renameColumn('q', 'r'); t.index('r'); }), held)).toMatch(/"r" in the index "t_r_index" on MySQL, but it is a text column/);
  });

  it('does not give a name that a rename passed on to another column the facts of the old one', () => {
    const swap = (t: Parameters<Parameters<Schema['alter']>[1]>[0]) => { t.renameColumn('p', 'q'); t.renameColumn('x', 'p'); };
    expect(say((s) => s.alter('t', (t) => { swap(t); t.dropColumn('p'); }), held)).toBeUndefined();
    expect(say((s) => s.alter('t', (t) => { swap(t); t.dropColumn('q'); }), held)).toMatch(/cannot drop the column "q".*"t_p_fkey" holds it/);
    expect(say((s) => s.alter('t', (t) => { swap(t); t.index('p'); }), held)).toBeUndefined();
  });
});

describe('dropping a table', () => {
  const held = state({ foreignKeys: [fk('t_p_fkey', 't', 'p', 'parents')], columns: new Map([['parents', new Map()]]) });

  it('is refused while a foreign key of another table references it', () => {
    expect(say((s) => s.drop('parents'), held)).toMatch(/error 3730/);
  });

  it('is not refused when the server does not check foreign keys', () => {
    expect(say((s) => s.drop('parents'), state({ foreignKeys: held.foreignKeys, columns: held.columns, foreignKeyChecks: false }))).toBeUndefined();
  });

  it('is not refused for a table that references itself, or when the child went first', () => {
    expect(say((s) => s.drop('parents'), state({ foreignKeys: [fk('self', 'parents', 'parent_id', 'parents')], columns: held.columns }))).toBeUndefined();
    expect(say((s) => { s.drop('t'); s.drop('parents'); }, held)).toBeUndefined();
  });
});

describe('dropping the last index a foreign key stands on', () => {
  const keys = [fk('c_p_fkey', 'c', 'p', 'parents')];
  const drop = (s: Schema) => s.alter('c', (t) => t.dropIndex('c_p_at_index'));
  const held = (indexes: Record<string, CatalogIndexPart[]>, extra: Partial<MysqlState> = {}) => state({ foreignKeys: keys, indexes: new Map([['c', new Map(Object.entries(indexes))]]), ...extra });

  it('is refused', () => {
    expect(say(drop, held({ PRIMARY: index('id'), c_p_at_index: index('p', 'at') }))).toMatch(/last index that the foreign key "c_p_fkey" stands on \("p"\).*error 1553/);
  });

  it('is not refused while another index starts with the column', () => {
    expect(say(drop, held({ c_p_at_index: index('p', 'at'), other: index('p') }))).toBeUndefined();
  });

  it('is refused when the replacement is made by the same alter, as the drops run first', () => {
    expect(say((s) => s.alter('c', (t) => { t.dropIndex('c_p_at_index'); t.index('p'); }), held({ c_p_at_index: index('p', 'at') }))).toMatch(/1553/);
  });

  it('is refused when the only other index has the column as a prefix of its characters', () => {
    expect(say(drop, held({ c_p_at_index: index('p', 'at'), prefix: index(['p', false]) }))).toMatch(/1553/);
  });

  it('is not refused when the row of the first part of the key is hidden', () => {
    const hidden = state({ foreignKeys: [fk('c_p_fkey', 'c', 'p', 'parents', { parts: [{ column: 'p', position: 2, referenced: 'id' }] })], indexes: new Map([['c', new Map([['c_p_at_index', index('p', 'at')]])]]) });
    expect(say(drop, hidden)).toBeUndefined();
  });

  it('is not held after an earlier alter of the table', () => {
    expect(say((s) => { s.alter('c', (t) => t.string('extra')); drop(s); }, held({ c_p_at_index: index('p', 'at') }))).toBeUndefined();
  });
});

describe('what is held after other steps', () => {
  const keys = [fk('t_p_fkey', 't', 'p', 'parents')];

  it('does not hold a drop after a data step: it may have turned foreign_key_checks off', () => {
    expect(say((s) => { s.data(async () => {}); s.drop('parents'); }, state({ foreignKeys: keys, columns: new Map([['parents', new Map()]]) }))).toBeUndefined();
    expect(say((s) => s.drop('parents'), state({ foreignKeys: keys, columns: new Map([['parents', new Map()]]) }))).toMatch(/3730/);
  });

  it('does not hold a drop of a table the catalog does not have, with a key of another table that points at it', () => {
    expect(say((s) => s.drop('parents'), state({ foreignKeys: keys, columns: new Map() }))).toBeUndefined();
  });

  it('counts the indexes an earlier alter dropped or made when it holds the names of a rename', () => {
    const indexes = new Map([['orders', new Map([['orders_a_index', index('a')], ['bills_a_index', index('b')]])]]);
    const rename = (s: Schema) => s.rename('orders', 'bills', { indexes: true });
    expect(say((s) => { s.alter('orders', (t) => t.dropIndex('bills_a_index')); rename(s); }, state({ indexes }))).toBeUndefined();
    expect(say((s) => { s.alter('orders', (t) => t.index('b', 'bills_b_index')); s.alter('orders', (t) => t.index('c', 'orders_b_index')); rename(s); }, state({ indexes }))).toMatch(/"bills_a_index"/);
    expect(say((s) => { s.alter('orders', (t) => t.index('c', 'bills_c_index')); s.rename('orders', 'bills', { indexes: true }); }, state({ indexes: new Map([['orders', new Map([['orders_c_index', index('c')]])]]) }))).toMatch(/"bills_c_index"/);
  });

  it('counts an index an earlier alter made and a later one dropped as gone', () => {
    const indexes = new Map([['orders', new Map([['orders_x_index', index('x')]])]]);
    expect(say((s) => { s.alter('orders', (t) => t.index('c', 'bills_x_index')); s.alter('orders', (t) => t.dropIndex('bills_x_index')); s.rename('orders', 'bills', { indexes: true }); }, state({ indexes }))).toBeUndefined();
    const long = `orders_${'q'.repeat(60)}`;
    expect(say((s) => { s.alter('orders', (t) => t.index('c', long)); s.alter('orders', (t) => t.dropIndex(long)); s.rename('orders', 'bills', { indexes: true }); }, state({ indexes }))).toBeUndefined();
    expect(say((s) => { s.alter('orders', (t) => t.index('c', long)); s.rename('orders', 'bills', { indexes: true }); }, state({ indexes }))).toMatch(/\[marmeon:D5\]/);
  });

  it('does not count the index MySQL made for a foreign key once an index was made, and holds the names after a dropped column no more', () => {
    const indexes = new Map([['orders', new Map([['orders_a_index', index('a')], ['bills_a_index', index('b')]])]]);
    const held = state({ indexes, constraints: new Map([['orders', [{ name: 'bills_a_index', type: 'FOREIGN KEY' as const, clause: null }]]]) });
    const rename = (s: Schema) => s.rename('orders', 'bills', { indexes: true });
    expect(say(rename, held)).toMatch(/"bills_a_index"/);
    expect(say((s) => { s.alter('orders', (t) => t.index('c')); rename(s); }, held)).toBeUndefined();
    expect(say((s) => { s.alter('orders', (t) => t.dropColumn('a')); rename(s); }, state({ indexes }))).toBeUndefined();
  });

  it('does not hold the constraints of a rename after a column was dropped', () => {
    const held = state({ constraints: new Map([['orders', [{ name: 'orders_user_id_fkey', type: 'FOREIGN KEY' as const, clause: null }]]]) });
    expect(say((s) => s.rename('orders', 'bills', { indexes: true }), held)).toMatch(/orders_user_id_fkey/);
    expect(say((s) => { s.alter('orders', (t) => t.dropColumn('user_id')); s.rename('orders', 'bills', { indexes: true }); }, held)).toBeUndefined();
  });

  it('fails aloud when a check asks for a table that was not read', () => {
    expect(say((s) => s.alter('t', (t) => t.dropColumn('p')), state({ foreignKeys: keys, tables: new Set() }))).toMatch(/mysqlStateTables did not name the table "t"/);
    expect(say((s) => s.drop('parents'), state({ foreignKeys: keys, tables: new Set() }))).toMatch(/did not name the table "parents"/);
    expect(say((s) => s.rename('orders', 'bills', { indexes: true }), state({ tables: new Set() }))).toMatch(/did not name the table "orders"/);
    expect(say((s) => s.alter('t', (t) => t.index('body')), state({ tables: new Set() }))).toMatch(/did not name the table "t"/);
    expect(say((s) => s.alter('c', (t) => t.dropIndex('c_p_at_index')), state({ tables: new Set() }))).toMatch(/did not name the table "c"/);
  });
});

describe('renaming a column a check names', () => {
  const role = check('t_role_check', "(`role` in (_utf8mb4'a',_utf8mb4'b'))");
  const held = state({ constraints: new Map([['t', [role]]]), columns: new Map([['t', new Map([['role', column('varchar')]])]]) });
  const rename = (s: Schema) => s.alter('t', (t) => t.renameColumn('role', 'kind'));

  it('is refused', () => {
    expect(say(rename, held)).toMatch(/the check "t_role_check" names it.*error 3959/);
  });

  it('is not refused when the same alter drops the check, or an earlier alter did', () => {
    expect(say((s) => s.alter('t', (t) => { t.dropCheck('t_role_check'); t.renameColumn('role', 'kind'); }), held)).toBeUndefined();
    expect(say((s) => { s.alter('t', (t) => t.dropCheck('T_ROLE_CHECK')); rename(s); }, held)).toBeUndefined();
  });

  it('is not held after a column of the table was dropped', () => {
    expect(say((s) => { s.alter('t', (t) => t.dropColumn('other')); rename(s); }, held)).toBeUndefined();
  });

  it('is not refused for a check that does not start with the column, or for another column', () => {
    const second = state({ constraints: new Map([['t', [check('t_n_m', '(`n` > `m`)')]]]) });
    expect(say((s) => s.alter('t', (t) => t.renameColumn('m', 'k')), second)).toBeUndefined();
    const roles = state({ constraints: new Map([['t', [role]]]) });
    expect(say((s) => s.alter('t', (t) => t.renameColumn('roles', 'kinds')), roles)).toBeUndefined();
  });
});

describe('renaming a table with its indexes', () => {
  const rename = (s: Schema) => s.rename('orders', 'bills', { indexes: true });

  it('is refused for a constraint named after the table', () => {
    expect(say(rename, state({ constraints: new Map([['orders', [{ name: 'orders_user_id_fkey', type: 'FOREIGN KEY', clause: null }]]]) }))).toMatch(/constraints named after it \("orders_user_id_fkey"\)/);
  });

  it('is not refused for a constraint named after another table, or one that was dropped first', () => {
    expect(say(rename, state({ constraints: new Map([['orders', [check('bills_x', '(`x` > 0)')]]]) }))).toBeUndefined();
    expect(say((s) => { s.alter('orders', (t) => t.dropCheck('orders_x')); rename(s); }, state({ constraints: new Map([['orders', [check('orders_x', '(`x` > 0)')]]]) }))).toBeUndefined();
  });

  it('holds the names of the indexes: too long, or taken by an index that stays', () => {
    expect(() => indexRenamesOf('t', 'tt', [`t_${'x'.repeat(62)}`])).toThrow(/\[marmeon:D5\].*65 characters long/);
    expect(() => indexRenamesOf('c', 'cc', ['c_a_index', 'CC_A_INDEX'])).toThrow(/\[marmeon:D18\].*"cc_a_index"/i);
    expect(say(rename, state({ indexes: new Map([['orders', new Map([['orders_a_index', index('a')], ['bills_a_index', index('b')]])]]) }))).toMatch(/\[marmeon:D18\].*"bills_a_index"/);
  });

  it('lets a chain of names through: the new name starts with the old one', () => {
    expect(indexRenamesOf('pa', 'pa_b', ['pa_x_index', 'pa_b_x'])).toEqual([['pa_x_index', 'pa_b_x_index'], ['pa_b_x', 'pa_b_b_x']]);
  });
});

describe('the type of the columns of a key', () => {
  const held = state({ maxlen: new Map([['t', 4]]), columns: new Map([['t', new Map([['body', column('longtext')], ['code', column('varchar', 'varchar(800)', 800)], ['shape', column('geometry')]])]]) });

  it('refuses a longtext column of the catalog', () => {
    expect(say((s) => s.alter('t', (t) => t.index('body')), held)).toMatch(/"body" in the index "t_body_index" on MySQL, but it is a text column/);
  });

  it('takes the type of a column an earlier alter added from the schema of the migrations', () => {
    expect(say((s) => { s.alter('t', (t) => t.json('meta')); s.alter('t', (t) => t.index('meta')); }, held, (s) => s.create('t', (t) => t.id()))).toMatch(/"meta".*a json\(\) column/);
  });

  it('takes the catalog type of the old name for a column an earlier alter renamed', () => {
    expect(say((s) => { s.alter('t', (t) => t.renameColumn('body', 'text')); s.alter('t', (t) => t.index('text')); }, held)).toMatch(/"text" in the index/);
  });

  it('leaves out a column of a type it does not know to the byte', () => {
    expect(say((s) => s.alter('t', (t) => t.index('shape')), held)).toBeUndefined();
  });

  it('counts the octets the catalog reports, not four bytes a character', () => {
    expect(say((s) => s.alter('t', (t) => { t.string('more', 500); t.index(['code', 'more']); }), held)).toBeUndefined();
    expect(say((s) => s.alter('t', (t) => { t.string('more', 569); t.index(['code', 'more']); }), held)).toMatch(/3076 bytes wide/);
  });
});

describe('the character set of a table', () => {
  const wide = (s: Schema) => s.alter('t', (t) => { t.string('code', 800); t.index('code'); });

  it('counts the bytes of a column an alter adds by the default of its table', () => {
    expect(say(wide, state({ maxlen: new Map([['t', 1]]) }))).toBeUndefined();
    expect(say(wide, state({ maxlen: new Map([['t', 4]]) }))).toMatch(/3200 bytes wide/);
  });

  it('counts a table of one byte a character exactly: 3072 passes, 3073 is refused, and it is no estimate', () => {
    const one = state({ maxlen: new Map([['t', 1]]) });
    expect(say((s) => s.alter('t', (t) => { t.string('code', 3072); t.index('code'); }), one)).toBeUndefined();
    const message = say((s) => s.alter('t', (t) => { t.string('code', 3073); t.index('code'); }), one);
    expect(message).toMatch(/3073 bytes wide/);
    expect(message).not.toMatch(/at least/);
  });

  it('leaves the column out of the sum when the character set of the table is not known', () => {
    expect(say(wide, state())).toBeUndefined();
  });

  it('counts a table the plan made as utf8mb4', () => {
    expect(say((s) => { s.create('x', (t) => t.id()); s.alter('x', (t) => { t.string('code', 800); t.index('code'); }); }, state())).toMatch(/3200 bytes wide/);
  });
});

describe('what the second stage reads', () => {
  it('names no table for a plan that only creates tables, or alters one that the plan created', () => {
    expect(mysqlStateTables(plan((s) => { s.create('a', (t) => t.id()); s.create('b', (t) => t.id()); }))).toEqual([]);
    expect(mysqlStateTables(plan((s) => { s.create('a', (t) => { t.id(); t.string('x'); }); s.alter('a', (t) => { t.index('x'); t.dropColumn('x'); }); }))).toEqual([]);
  });

  it('names no table after a raw step', () => {
    expect(mysqlStateTables(plan((s) => { s.raw({ mysql: sql`select 1` }); s.alter('a', (t) => t.dropColumn('x')); s.drop('b'); }))).toEqual([]);
  });

  it('names the table of the snapshot under the name it had', () => {
    expect(mysqlStateTables(plan((s) => { s.rename('a', 'b'); s.alter('b', (t) => t.dropColumn('x')); }))).toEqual(['a']);
  });

  it('names the tables a drop, a rename with indexes or a key over an existing column needs', () => {
    expect(mysqlStateTables(plan((s) => { s.drop('a'); s.rename('b', 'c', { indexes: true }); s.alter('d', (t) => t.index('x')); }))).toEqual(['a', 'b', 'd']);
  });
});

describe('what a key takes, by the catalog', () => {
  it.each([
    [column('varchar', 'varchar(10)', 40), 40],
    [column('varchar', 'varchar(10)', 10), 10],
    [column('char', 'char(36)', 144), 144],
    [column('varbinary', 'varbinary(20)', 20), 20],
    [column('tinyint', 'tinyint(1)'), 1],
    [column('smallint', 'smallint'), 2],
    [column('mediumint', 'mediumint'), 3],
    [column('int', 'int'), 4],
    [column('float', 'float'), 4],
    [column('bigint', 'bigint unsigned'), 8],
    [column('double', 'double'), 8],
    [column('date', 'date'), 3],
    [column('datetime', 'datetime'), 5],
    [column('datetime', 'datetime(3)'), 7],
    [column('datetime', 'datetime(6)'), 8],
    [column('decimal', 'decimal(8,2)'), 4],
    [column('decimal', 'decimal(9,2)'), 5],
    [column('decimal', 'decimal(18,2) unsigned'), 9],
    [column('longtext'), 'unindexable'],
    [column('text'), 'unindexable'],
    [column('blob'), 'unindexable'],
    [column('json'), 'unindexable'],
    [column('geometry'), undefined],
    [column('timestamp', 'timestamp'), undefined],
    [column('varchar', 'varchar(10)', null), undefined],
  ])('%j', (given, bytes) => {
    expect(mysqlCatalogKeyBytes(given)).toBe(bytes);
  });
});
