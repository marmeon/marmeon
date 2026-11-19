import { describe, expect, it } from 'vitest';
import { sqlChangesSchema, sqlWords, type SqlDialect } from './sql-words.ts';

/** Text that hides the word `migrations` from a scanner that reads quotes and comments the wrong way, and that the server reads as code. */
const BYPASSES: [string, string, readonly SqlDialect[]][] = [
  ['a quote in a block comment', "/* ' */ update migrations set name = 'x'", ['sqlite', 'pgsql']],
  ['apostrophes in two block comments', "/* it's */ delete from migrations /* don't */", ['sqlite', 'pgsql']],
  ['an apostrophe in a line comment', "-- it's\nupdate migrations set name = 'x'", ['sqlite', 'pgsql']],
  ['`--` as a name', 'with "--" as (select 1) delete from migrations', ['sqlite', 'pgsql']],
  ['an apostrophe in a double-quoted name', `with "it's" as (select 1) delete from migrations`, ['sqlite', 'pgsql']],
  ['an apostrophe in a bracketed name', 'with [it\'s] as (select 1) delete from migrations', ['sqlite']],
  ['an apostrophe in a backtick name', 'with `it\'s` as (select 1) delete from migrations', ['sqlite']],
  ['a quote in a dollar quote', "select $$ ' $$; delete from migrations", ['pgsql']],
  ['a tagged dollar quote', "select $t$ ' $t$; delete from migrations; select '", ['pgsql']],
  ['an escaped quote in E\'…\'', "select E'\\''; delete from migrations; select '", ['pgsql']],
  ['code in a dollar quote', 'do $$ begin delete from migrations; end $$', ['pgsql']],
  ['a plain string with a backslash, read either way', "select 'a\\'; delete from migrations; select '", ['pgsql']],
  ['a quote after a nested comment', "/* outer /* inner */ ' */ update migrations set name = 'x'", ['pgsql']],
  ['a nested comment, then a quote and a comment', "/* /* */ ' */ delete from migrations /* ' */", ['pgsql']],
  ['a nested comment, then `--`', '/* /* */ -- */ delete from migrations', ['pgsql']],
  ['a carriage return that ends a line comment', '-- x\rdelete from migrations', ['pgsql']],
  ['a letter from U+0080 on in front of a dollar quote', "with x as (select 1 \u00e9$$, ' $$ ') delete from migrations /* ' */", ['pgsql']],
  ['a letter from U+0080 on in front of E', "select \u00e9E'\\' from migrations /* ' */", ['pgsql']],
  ['an astral letter in front of a dollar quote', "with x as (select 1 \u{1D7D8}$$, ' $$ ') delete from migrations /* ' */", ['pgsql']],
  ['a dollar quote with a long tag', `select $${'t'.repeat(300)}$ ' $${'t'.repeat(300)}$; delete from migrations; select '`, ['pgsql']],
  ['a string as a name', "delete from 'migrations'", ['sqlite']],
  ['a variable with a quote in its brackets ($)', "with x as (select $a(')) delete from migrations where $a(') is null", ['sqlite']],
  ['a variable with a quote in its brackets (@)', "with x as (select @a(')) delete from migrations where @a(') is null", ['sqlite']],
  ['a variable with a quote in its brackets (:)', "with x as (select :a(')) delete from migrations where :a(') is null", ['sqlite']],
  ['a no-break space in the brackets of a variable ($)', "with x as (select $a(\u00a0'), 'a'' /* ' ) delete from migrations /* x */", ['sqlite']],
  ['an ideographic space in the brackets of a variable (@)', "with x as (select @a(\u3000'), 'a'' /* ' ) delete from migrations /* x */", ['sqlite']],
  ['a variable with a quote in its brackets (#)', "with x as (select #a(')) delete from migrations where #a(') is null", ['sqlite']],
];

describe.each(['sqlite', 'pgsql'] as const)('the words of a statement on %s', (dialect) => {
  it.each(BYPASSES.filter(([, , dialects]) => dialects.includes(dialect)))('finds migrations after %s', (_name, text) => {
    expect(sqlWords(text, dialect)).toContain('migrations');
  });

  it.each([
    ['a block comment', 'select 1 /* migrations */'],
    ['a line comment', 'select 1 -- migrations\n, 2'],
    ['a block comment with a quote after a string', "select 'a' /* ' */ , 'x'"],
    ['a quoted name with a quote, then a comment', 'select "it\'s" /* migrations */'],
  ])('does not find it in %s', (_name, text) => {
    expect(sqlWords(text, dialect)).not.toContain('migrations');
  });

  it.each([
    ['a string', "select 'migrations' as name"],
    ['a doubled quote in a string', "select 'it''s migrations'"],
  ])('finds it in %s on SQLite only, which reads a string as a name', (_name, text) => {
    expect(sqlWords(text, dialect).includes('migrations')).toBe(dialect === 'sqlite');
  });

  it('puts a `;` or other punctuation of a quoted name nowhere in the statements', () => {
    expect(sqlChangesSchema('select 1 as "x;drop table y"', dialect)).toBe(false);
    expect(sqlChangesSchema('select 1 as "x;\'drop"', dialect)).toBe(false);
  });

  it('keeps the words of a quoted name, and of a statement that has no end', () => {
    expect(sqlWords('select 1 from "migrations"', dialect)).toContain('migrations');
    expect(sqlWords("select 'abc ; delete from migrations", dialect)).toContain('migrations');
    expect(sqlWords('select 1 /* delete from migrations', dialect)).toContain('migrations');
    expect(sqlWords('select "abc ; delete from migrations', dialect)).toContain('migrations');
  });

  it('reads a block comment as the server does: Postgres nests them, SQLite ends at the first end', () => {
    expect(sqlWords('select 1 /* a /* b */ migrations */', dialect).includes('migrations')).toBe(dialect === 'sqlite');
    expect(sqlWords('select 1 /* a /* b */ migrations', dialect)).toContain('migrations'); // no end for the outer one: words
  });

  it('finds a statement that begins with create, alter, drop or do, and none in a string or comment', () => {
    for (const text of ["/* ' */ drop table x", "-- it's\ncreate table x (id int)", "with \"--\" as (select 1) select 1; alter table x add y int", "select 1; /* ' */ drop table x"]) {
      expect(sqlChangesSchema(text, dialect), text).toBe(true);
    }
    for (const text of ["select 'drop table x'", 'select 1 /* drop table x */', 'with created as (select 1) select * from created', 'select dropped, altered from t']) {
      expect(sqlChangesSchema(text, dialect), text).toBe(false);
    }
  });
});

it('reads a Postgres name spelled with unicode escapes as the name it is, and takes one it cannot read for the migrator\'s tables', () => {
  for (const text of ['delete from U&"migr\\0061tions"', 'delete from u&"migr\\+000061tions"', 'delete from U&"migr\\0061tions" uescape \'!\'', 'delete from U&"migr!0061tions" /* x */ UESCAPE \'!\'', 'delete from U&"migr\\zzzztions"']) {
    expect(sqlWords(text, 'pgsql'), text).toContain('migrations');
  }
  expect(sqlWords('select U&"na\\0061me" from t', 'pgsql')).toContain('naame');
  // A nested comment between the name and UESCAPE: Postgres reads it as one, and the clause follows it.
  for (const text of ['delete from U&"migr!0061tions" /* /* */ */ uescape \'!\'', 'delete from U&"migr!0061tions" /* a /* b /* c */ d */ e */ -- x\n uescape \'!\'', 'delete from U&"migr!0061tions" /* never ends']) {
    expect(sqlWords(text, 'pgsql'), text).toContain('migrations');
  }
  expect(sqlWords('select U&"a\\\\b" from t', 'pgsql')).not.toContain('migrations');
  // SQLite has no U&: the name is what it is written.
  expect(sqlWords('delete from U&"migr\\0061tions"', 'sqlite')).not.toContain('migrations');
});

it('judges the part of a Postgres text that cannot be told by every word, not by statement', () => {
  for (const text of ["select 'C:\\temp'; /* cleanup */ drop table if exists zz_nothing", "select 'a\\d+';\n-- cleanup\ndrop table zz_nothing", "select 'a\\'; /* x */ do $$ begin null; end $$"]) {
    expect(sqlChangesSchema(text, 'pgsql'), text).toBe(true);
  }
  expect(sqlChangesSchema("select 'C:\\temp'; /* nothing */ select 1", 'pgsql')).toBe(false);
});

it('cuts no statement inside a dollar quote, and keeps its words', () => {
  const insert = 'insert into notes(body) values ($$example; drop table notes$$)';
  expect(sqlChangesSchema(insert, 'pgsql')).toBe(false);
  expect(sqlWords(insert, 'pgsql')).toContain('drop');
  expect(sqlChangesSchema('do $$ begin drop table t; end $$', 'pgsql')).toBe(true);
  expect(sqlChangesSchema('create function f() returns int as $$ select 1; $$ language sql', 'pgsql')).toBe(true);
});

it('reads Postgres-only forms as Postgres does, and SQLite without them', () => {
  expect(sqlChangesSchema('do $$ begin null; end $$', 'pgsql')).toBe(true);
  // `$$` and `E''` mean nothing to SQLite: its words stay visible, as plain text.
  expect(sqlWords("select E'\\'', migrations", 'sqlite')).toContain('migrations');
});
