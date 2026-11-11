import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calledNames, checkPlan, readPlan, type FunctionFact, type PlanFacts } from './pg-plan-guard.ts';

// Plans as Postgres 18 deparsed them (`EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON)` of the wrapped query).
const plan = (name: string): unknown => JSON.parse(readFileSync(new URL(`./__fixtures__/plans/${name}.json`, import.meta.url), 'utf8'));

const fn = (name: string, volatility: string, schema = 'pg_catalog'): FunctionFact => ({ schema, name, volatility });
const KNOWN: FunctionFact[] = [
  fn('pg_terminate_backend', 'v'),
  fn('now', 's'),
  fn('count', 'i'),
  fn('length', 'i'),
  fn('numeric', 'i'),
  fn('varchar', 'i'),
  fn('to_jsonb', 's'),
];
const facts = (more: Partial<PlanFacts> = {}): PlanFacts => ({ functions: KNOWN, ancestors: new Map(), derived: new Map(), secrets: new Map([['users', new Set(['password'])]]), ...more });

describe('the plan guard', () => {
  it('lets a plain read pass', () => {
    expect(checkPlan(plan('plain'), facts())).toBeUndefined();
  });

  it('refuses a volatile function', () => {
    expect(checkPlan(plan('terminate-backend'), facts())).toContain('pg_terminate_backend() can have effects');
  });

  it.each(['table_to_xml', 'schema_to_xmlschema', 'database_to_xml_and_xmlschema', 'query_to_xml', 'ts_stat', 'current_setting', 'dblink_exec', 'lo_get', 'pg_read_file', 'pg_ls_dir', 'pg_stat_file'])(
    'refuses %s by name, even marked immutable',
    (name) => {
      const call = [{ Plan: { 'Node Type': 'Result', Output: [`${name}('x'::text)`] } }];
      expect(checkPlan(call, facts({ functions: [fn(name, 'i')] }))).toContain(`${name}() is not available here`);
    },
  );

  it('does not take upper-case grammar words for functions', () => {
    // EXTRACT( is a grammar word, not a name.
    expect(calledNames(readPlan(plan('upper-case-keywords'))!).sort()).toEqual(['count', 'now']);
    expect(checkPlan(plan('upper-case-keywords'), facts())).toBeUndefined();
  });

  it('does not count a function name inside a string literal', () => {
    expect(calledNames(readPlan(plan('function-in-literal'))!)).toEqual(['length']);
    expect(checkPlan(plan('function-in-literal'), facts())).toBeUndefined();
  });

  it('refuses a name the database does not know', () => {
    expect(checkPlan(plan('terminate-backend'), facts({ functions: [] }))).toContain('is not a function the database knows');
  });

  it('lets a type modifier pass: character varying(20), numeric(10,2)', () => {
    expect(checkPlan(plan('cast-varchar'), facts({ functions: [] }))).toBeUndefined();
  });

  it('refuses any overload that is volatile, in the schema named or in any when unqualified', () => {
    expect(checkPlan(plan('terminate-backend'), facts({ functions: [fn('pg_terminate_backend', 'i', 'public'), fn('pg_terminate_backend', 'v', 'other')] }))).toContain('can have effects');
  });

  it('refuses the whole row of a table with secret columns', () => {
    expect(checkPlan(plan('whole-row'), facts())).toContain('users has secret columns (password)');
  });

  it('refuses a secret column by name, and by the table a child table inherits from', () => {
    expect(checkPlan(plan('secret-column'), facts())).toContain('users.password is a secret column');
    // The same plan on a child table: only its parent is known to have secrets.
    const child = JSON.parse(JSON.stringify(plan('secret-column')).replaceAll('"users"', '"users_archive"').replaceAll('users.password', 'users_archive.password'));
    expect(checkPlan(child, facts())).toBeUndefined();
    expect(checkPlan(child, facts({ ancestors: new Map([['users_archive', ['users_archive', 'users']]]) }))).toContain('users.password is a secret column');
  });

  it('refuses a catalog relation that holds credentials or samples', () => {
    const scan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'pg_authid', Schema: 'pg_catalog', Alias: 'pg_authid', Output: ['pg_authid.oid'] } }];
    expect(checkPlan(scan, facts())).toContain('pg_authid');
  });

  it.each(['pg_toast', 'pg_toast_temp_3'])('refuses a scan of a TOAST table (schema %s)', (schema) => {
    const scan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'pg_toast_16384', Schema: schema, Alias: 'pg_toast_16384', Output: ['chunk_data'] } }];
    expect(checkPlan(scan, facts())).toContain('TOAST');
  });

  it('refuses a materialized view built from a table with secret columns', () => {
    const scan = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'users_copy', Schema: 'public', Alias: 'users_copy', Output: ['users_copy.id'] } }];
    expect(checkPlan(scan, facts())).toBeUndefined();
    expect(checkPlan(scan, facts({ derived: new Map([['users_copy', ['users']]]) }))).toContain('keeps a copy of data from users');
  });

  it.each(['crosstab', 'crosstab3', 'connectby', 'xpath_table', 'ts_rewrite', 'txid_current', 'pg_current_xact_id', 'get_raw_page', 'heap_page_items'])('refuses %s by name', (name) => {
    expect(checkPlan([{ Plan: { 'Node Type': 'Result', Output: [`${name}('x'::text)`] } }], facts({ functions: [fn(name, 's')] }))).toContain(`${name}() is not available here`);
  });

  it('refuses a foreign table scan', () => {
    expect(checkPlan([{ Plan: { 'Node Type': 'Foreign Scan', Output: ['1'] } }], facts())).toContain('foreign table');
  });

  it.each([
    ['not an array', {}],
    ['two plans', [{ Plan: { 'Node Type': 'Result' } }, { Plan: { 'Node Type': 'Result' } }]],
    ['no Plan', [{}]],
    ['a node without a type', [{ Plan: { Output: ['1'] } }]],
    ['children that are not nodes', [{ Plan: { 'Node Type': 'Limit', Plans: ['x'] } }]],
    ['an unclosed quote', [{ Plan: { 'Node Type': 'Result', Output: ["'abc"] } }]],
    ['an unclosed quoted identifier', [{ Plan: { 'Node Type': 'Result', Output: ['"abc'] } }]],
  ])('refuses a plan it cannot read: %s', (_, shape) => {
    expect(checkPlan(shape, facts())).toContain('Could not read the query plan');
  });
});
