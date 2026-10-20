import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { parseSource, isLiteral, rawSqlCheck, rawSqlProblems } from './source-rules.ts';

function app(files: Record<string, string>): string {
  const root = tempDir('marmeon-check-raw-sql-');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

const IMPORT = "import { sql } from '@marmeon/database';\n";

describe('raw-sql', () => {
  it.each([
    ['a name', 'sql.raw(name)'],
    ['a template with an expression', 'sql.raw(`order by ${name}`)'],
    ['a member', 'sql.raw(input.key)'],
    ['a call', 'sql.raw(f())'],
    ['sql.lit', 'sql.lit(value)'],
    ['an optional call', 'sql?.raw(name)'],
    ['a computed member', "sql['raw'](name)"],
    ['a spread', 'sql.raw(...parts)'],
    ['a concatenation with a name', "sql.raw('a' + name)"],
    ['nested in a sql template', 'sql`select ${sql.raw(name)} from t`'],
    ['a let', "(() => { let T = 'x'; return sql.raw(T); })()"],
    ['a name that is declared twice', "const T = 'x'; (() => { const T = name; return sql.raw(T); })()"],
    ['a parameter of the same name', "const T = 'x'; export const f = (T: string) => sql.raw(T)"],
    ['a constant of another file', "import { TABLE } from './table.ts'; sql.raw(TABLE)"],
    ['a constant set from a name', 'const T = name; sql.raw(T)'],
    ['a function that is called sanitize', 'sql.raw(sanitize(name))'],
    ['sql in parentheses', '(sql).raw(name)'],
    ['sql with as', '(sql as any).raw(name)'],
    ['sql with a non-null mark', 'sql!.raw(name)'],
    ['the method in parentheses', '(sql.raw)(name)'],
    ['a const set to sql', 'const s = sql; s.raw(name)'],
    ['a const set to a const set to sql', 'const s = sql; const t = s; t.lit(name)'],
    ['raw taken out by destructuring', 'const { raw, lit: l } = sql; raw(name)'],
    ['lit taken out under another name', 'const { raw, lit: l } = sql; l(name)'],
    ['a const set to sql.raw', 'const r = sql.raw; r(name)'],
    ['call', 'sql.raw.call(null, name)'],
    ['apply with an array', 'sql.raw.apply(null, [name])'],
    ['apply with a variable', 'sql.raw.apply(null, parts)'],
    ['a template as the member', 'sql[`raw`](name)'],
  ])('reports %s', (_, code) => {
    const root = app({ 'src/a.ts': `${IMPORT}declare const name: string, input: any, value: string, parts: string[];\n${code};\n` });
    expect(rawSqlProblems(root)).toMatchObject([{ severity: 'warning', file: 'src/a.ts', rule: 'marmeon(raw-sql)', docs: 'docs/check.md#raw-sql' }]);
  });

  it('reports at the argument, with its line and column', () => {
    const root = app({ 'src/a.ts': `${IMPORT}\nexport const q = sql.raw(name);\n` });
    expect(rawSqlProblems(root)).toMatchObject([{ file: 'src/a.ts', line: 3, column: 26 }]);
  });

  it('reports an alias of the import and a namespace import', () => {
    const root = app({
      'src/alias.ts': "import { sql as q } from '@marmeon/database';\nexport const a = q.raw(name);\n",
      'src/kysely.ts': "import { sql as k } from 'kysely';\nexport const a = k.lit(name);\n",
      'src/namespace.ts': "import * as db from '@marmeon/database';\nexport const a = db.sql.raw(name);\n",
    });
    expect(rawSqlProblems(root).map((problem) => problem.file)).toEqual(['src/alias.ts', 'src/kysely.ts', 'src/namespace.ts']);
  });

  it.each([
    ['a string literal', "sql.raw('order by name')"],
    ['a template without an expression', 'sql.raw(`order by name`)'],
    ['a sum of literals', "sql.raw('a' + 'b')"],
    ['a parenthesized literal', "sql.raw(('a'))"],
    ['a literal with as const', "sql.raw('a' as const)"],
    ['a const', "const T = 'x'; sql.raw(T)"],
    ['a const as const', "const T = 'x' as const; sql.raw(T)"],
    ['a const of a const', "const A = 'x'; const B = A + 'y'; sql.raw(B)"],
    ['sql.lit of a literal', "sql.lit('a')"],
    ['an interpolation in a sql template', 'sql`select ${name}`'],
    ['a value in a sql template', 'sql`${name}`'],
    ['another object', 'other.raw(name)'],
    ['another method', 'sql.ref(name)'],
    ['no argument', 'sql.raw()'],
    ['call with a literal', "sql.raw.call(null, 'x')"],
    ['apply with a literal', "sql.raw.apply(null, ['x'])"],
    ['a destructured name that is not raw', 'const { ref } = sql; ref(name)'],
    ['a const set to raw of another object', 'const r = other.raw; r(name)'],
    ['a const set to something else', 'const s = other; s.raw(name)'],
  ])('does not report %s', (_, code) => {
    const root = app({ 'src/a.ts': `${IMPORT}declare const name: string, other: any;\n${code};\n` });
    expect(rawSqlProblems(root)).toEqual([]);
  });

  it('does not read tests, node_modules, dist at the root or a file that does not parse', () => {
    const root = app({
      'src/a.test.ts': 'sql.raw(name);\n',
      'src/a.spec.tsx': 'sql.raw(name);\n',
      'src/a.type-test.ts': 'sql.raw(name);\n',
      'node_modules/pkg/index.js': 'sql.raw(name);\n',
      'dist/index.js': 'sql.raw(name);\n',
      'src/broken.ts': 'sql.raw(name\n',
    });
    expect(rawSqlProblems(root)).toEqual([]);
  });

  it('reads a file below a folder called dist', () => {
    expect(rawSqlProblems(app({ 'modules/dist/a.ts': 'sql.raw(name);\n' }))).toHaveLength(1);
  });

  it('is a warning: the status is warning, and no finding is passed', () => {
    expect(rawSqlCheck(app({ 'src/a.ts': 'sql.raw(name);\n' })).report).toMatchObject({ name: 'raw-sql', status: 'warning' });
    expect(rawSqlCheck(app({ 'src/a.ts': "sql.raw('x');\n" })).report).toMatchObject({ name: 'raw-sql', status: 'passed', problems: [] });
  });

  it('silences a finding with a reason, and keeps it in silenced', () => {
    const { report } = rawSqlCheck(app({ 'src/a.ts': '// marmeon-check-ignore raw-sql: the column comes from a list in this file\nsql.raw(name);\n' }));
    expect(report).toMatchObject({
      status: 'passed',
      problems: [],
      silenced: [{ file: 'src/a.ts', line: 2, rule: 'marmeon(raw-sql)', reason: 'the column comes from a list in this file' }],
    });
  });
});

describe('isLiteral', () => {
  const literal = (code: string) => {
    const parsed = parseSource(`${code};`, 'x.ts')!;
    const statement = (parsed.program.body as { expression: never }[]).at(-1)!;
    return isLiteral(statement.expression, parsed.declarations);
  };

  it('knows a name by its only declaration', () => {
    expect(literal("const A = 'a'; A")).toBe(true);
    expect(literal("var A = 'a'; A")).toBe(false);
    expect(literal("const A = 'a'; function f(A: string) {} A")).toBe(false);
    expect(literal("const { A } = x; A")).toBe(false);
    expect(literal('const A = A; A')).toBe(false);
  });
});
