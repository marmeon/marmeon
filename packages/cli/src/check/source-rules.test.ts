import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../../scripts/test/temp-dir.js';
import { parseSource, innerHtmlCheck, innerHtmlProblems, isLiteral, rawSqlCheck, rawSqlProblems } from './source-rules.ts';

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
      'src/builder.ts': `import { sql as k } from '${['kys', 'ely'].join('')}';\nexport const a = k.lit(name);\n`,
      'src/namespace.ts': "import * as db from '@marmeon/database';\nexport const a = db.sql.raw(name);\n",
    });
    expect(rawSqlProblems(root).map((problem) => problem.file)).toEqual(['src/alias.ts', 'src/builder.ts', 'src/namespace.ts']);
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

describe('inner-html', () => {
  const report = (code: string, file = 'src/a.tsx') => innerHtmlProblems(app({ [file]: `declare const html: string, parts: string[], el: any;\n${code}\n` }));

  it.each([
    ['a JSX attribute with a name', '<div dangerouslySetInnerHTML={{ __html: html }} />'],
    ['a JSX attribute with a template', '<div dangerouslySetInnerHTML={{ __html: `<b>${html}</b>` }} />'],
    ['a JSX attribute with a call', '<div dangerouslySetInnerHTML={{ __html: sanitize(html) }} />'],
    ['a JSX attribute with an object of its own', '<div dangerouslySetInnerHTML={props.inner} />'],
    ['a JSX attribute with a spread that can replace the markup', "<div dangerouslySetInnerHTML={{ __html: 'x', ...other }} />"],
    ['a JSX attribute with a computed key', "<div dangerouslySetInnerHTML={{ [key]: 'x' }} />"],
    ['a JSX attribute with an object without __html', '<div dangerouslySetInnerHTML={{}} />'],
    ['a JSX attribute with an object in parentheses and a cast', '<div dangerouslySetInnerHTML={({ __html: html } as any)!} />'],
    ['a JSX attribute with a const object of a name', 'const p = { __html: html }; <div dangerouslySetInnerHTML={p} />'],
    ['a JSX attribute with a const set to a const object of a name', 'const p = { __html: html }; const q = p; <div dangerouslySetInnerHTML={q} />'],
    ['a JSX attribute with a let object', "let p = { __html: 'x' }; <div dangerouslySetInnerHTML={p} />"],
    ['a JSX attribute with a key written as a string', "<div dangerouslySetInnerHTML={{ '__html': html }} />"],
    ['a property of createElement', "createElement('div', { dangerouslySetInnerHTML: { __html: html } })"],
    ['a property with a string key', "createElement('div', { 'dangerouslySetInnerHTML': { __html: html } })"],
    ['a property with a computed key', "createElement('div', { ['dangerouslySetInnerHTML']: { __html: html } })"],
    ['a property with a template key', "createElement('div', { [`dangerouslySetInnerHTML`]: { __html: html } })"],
    ['a shorthand property', "const dangerouslySetInnerHTML = { __html: html }; createElement('div', { dangerouslySetInnerHTML })"],
    ['a property in a spread object', '<div {...{ dangerouslySetInnerHTML: { __html: html } }} />'],
    ['innerHTML', 'el.innerHTML = html'],
    ['outerHTML', 'el.outerHTML = html'],
    ['innerHTML with +=', "el.innerHTML += '<b>' + html"],
    ['innerHTML with a template', 'el.innerHTML = `<b>${html}</b>`'],
    ['innerHTML in parentheses', '(el).innerHTML = html'],
    ['innerHTML with a cast', '(el as HTMLElement).innerHTML = html'],
    ['innerHTML with a non-null mark', 'el!.innerHTML = html'],
    ['innerHTML as a computed member', "el['innerHTML'] = html"],
    ['innerHTML as a template member', 'el[`innerHTML`] = html'],
    ['innerHTML set from a let', "let h = 'x'; el.innerHTML = h"],
    ['innerHTML set from a name declared twice', "const h = 'x'; (() => { const h = html; el.innerHTML = h; })()"],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', html)"],
    ['an optional insertAdjacentHTML', "el?.insertAdjacentHTML('beforeend', html)"],
    ['insertAdjacentHTML as a computed member', "el['insertAdjacentHTML']('beforeend', html)"],
    ['insertAdjacentHTML with a spread', 'el.insertAdjacentHTML(...parts)'],
    ['insertAdjacentHTML.call', "el.insertAdjacentHTML.call(el, 'beforeend', html)"],
    ['insertAdjacentHTML.apply with an array', "el.insertAdjacentHTML.apply(el, ['beforeend', html])"],
    ['insertAdjacentHTML.apply with a variable', 'el.insertAdjacentHTML.apply(el, parts)'],
    ['insertAdjacentHTML in a const', "const add = el.insertAdjacentHTML; add('beforeend', html)"],
    ['document.write', 'document.write(html)'],
    ['document.writeln', 'document.writeln(html)'],
    ['window.document.write', 'window.document.write(html)'],
    ['document.write after a literal', "document.write('<p>', html)"],
    ['document.write.call', 'document.write.call(document, html)'],
    ['a const set to the document', 'const d = document; d.write(html)'],
    ['createContextualFragment', 'document.createRange().createContextualFragment(html)'],
    ['setHTMLUnsafe', 'el.setHTMLUnsafe(html)'],
    ['a srcDoc attribute', '<iframe srcDoc={html} />'],
    ['a srcDoc attribute with a template', '<iframe srcDoc={`<p>${html}</p>`} />'],
    ['srcdoc', 'el.srcdoc = html'],
    ['srcdoc with +=', "el['srcdoc'] += html"],
    ['__html set after the object', "const o = { __html: 'a' }; o.__html = html; <div dangerouslySetInnerHTML={o} />"],
    ['an object with a literal __html and a computed key', "<div dangerouslySetInnerHTML={{ __html: 'x', [key]: html }} />"],
    ['the contentDocument', 'iframe.contentDocument.write(html)'],
    ['the ownerDocument', 'el.ownerDocument.write(html)'],
    ['an optional member in parentheses', "(el?.insertAdjacentHTML)('beforeend', html)"],
    ['an optional member in parentheses with an optional call', "(el?.insertAdjacentHTML)?.call(el, 'beforeend', html)"],
    ['bind', "el.insertAdjacentHTML.bind(el)('beforeend', html)"],
    ['bind with the position', 'el.insertAdjacentHTML.bind(el, \'beforeend\')(html)'],
    ['bind in a const', "const add = el.insertAdjacentHTML.bind(el); add('beforeend', html)"],
    ['bind with a spread', "el.insertAdjacentHTML.bind(...parts)('<b>')"],
    ['a srcDoc property', "createElement('iframe', { srcDoc: html })"],
    ['call with a spread array', "el.insertAdjacentHTML.call(...[el, 'beforeend', html])"],
  ])('reports %s', (_, code) => {
    expect(report(code)).toMatchObject([{ severity: 'warning', file: 'src/a.tsx', rule: 'marmeon(inner-html)', docs: 'docs/check.md#html-from-code' }]);
  });

  it('reports at the value, with its line and column', () => {
    const root = app({ 'src/a.ts': 'declare const el: any, html: string;\n\nel.innerHTML = html;\n' });
    expect(innerHtmlProblems(root)).toMatchObject([{ file: 'src/a.ts', line: 3, column: 16 }]);
  });

  it.each([
    ['a literal __html', "<div dangerouslySetInnerHTML={{ __html: '<b>x</b>' }} />"],
    ['a template without an expression', '<div dangerouslySetInnerHTML={{ __html: `<b>x</b>` }} />'],
    ['a const __html', "const H = '<b>x</b>'; <div dangerouslySetInnerHTML={{ __html: H }} />"],
    ['a literal sum', "<div dangerouslySetInnerHTML={{ __html: '<b>' + 'x</b>' }} />"],
    ['a const object', "const p = { __html: 'x' }; <div dangerouslySetInnerHTML={p} />"],
    ['a const object in parentheses and a cast', "const p = { __html: 'x' }; <div dangerouslySetInnerHTML={(p as any)} />"],
    ['a property with a literal', "createElement('div', { dangerouslySetInnerHTML: { __html: 'x' } })"],
    ['an empty string for innerHTML', "el.innerHTML = ''"],
    ['a literal for outerHTML', "el.outerHTML = '<p></p>'"],
    ['a const for innerHTML', "const T = '<p></p>'; el.innerHTML = T"],
    ['a literal for insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', '<hr>')"],
    ['a literal for document.write', "document.write('<hr>')"],
    ['a literal for createContextualFragment', "range.createContextualFragment('<hr>')"],
    ['a literal for setHTMLUnsafe', "el.setHTMLUnsafe('<hr>')"],
    ['a literal for call', "el.insertAdjacentHTML.call(el, 'beforeend', '<hr>')"],
    ['textContent', 'el.textContent = html'],
    ['innerText', 'el.innerText = html'],
    ['reading innerHTML', 'const copy = el.innerHTML; log(copy)'],
    ['a write of a stream', 'stream.write(html)'],
    ['a write of a response', 'res.write(html)'],
    ['an attribute with another name', '<div title={html} data-html={html} />'],
    ['a property with another name', "createElement('div', { innerHTML: html })"],
    ['an attribute without a value', '<div dangerouslySetInnerHTML />'],
    ['a literal srcDoc', "<iframe srcDoc='<p>x</p>' />"],
    ['a literal srcdoc', "el.srcdoc = '<p>x</p>'"],
    ['a literal __html assigned', "const o = { __html: 'a' }; o.__html = 'b'; <div dangerouslySetInnerHTML={o} />"],
    ['a literal for bind', "el.insertAdjacentHTML.bind(el)('beforeend', '<hr>')"],
    ['a literal position for bind', "el.insertAdjacentHTML.bind(el, 'beforeend')('<hr>')"],
    ['a write of another member document', 'frame.contentWindow.write(html)'],
  ])('does not report %s', (_, code) => {
    expect(report(`declare const stream: any, res: any, range: any, log: any, createElement: any, props: any, other: any, key: string;\n${code}`)).toEqual([]);
  });

  it('does not read tests, node_modules, dist at the root or a file that does not parse', () => {
    const root = app({
      'src/a.test.tsx': 'el.innerHTML = html;\n',
      'src/a.spec.ts': 'el.innerHTML = html;\n',
      'node_modules/pkg/index.js': 'el.innerHTML = html;\n',
      'dist/index.js': 'el.innerHTML = html;\n',
      'src/broken.ts': 'el.innerHTML = html\n(\n',
    });
    expect(innerHtmlProblems(root)).toEqual([]);
  });

  it('is a warning: the status is warning, and no finding is passed', () => {
    expect(innerHtmlCheck(app({ 'src/a.ts': 'el.innerHTML = html;\n' })).report).toMatchObject({ name: 'inner-html', status: 'warning' });
    expect(innerHtmlCheck(app({ 'src/a.ts': "el.innerHTML = '';\n" })).report).toMatchObject({ name: 'inner-html', status: 'passed', problems: [] });
  });

  it('is silenced by a comment above or at the end of the line, in JSX too, and keeps the finding in silenced', () => {
    const root = app({
      'src/a.ts': ['// marmeon-check-ignore inner-html: the markup is built by the server', 'el.innerHTML = html;', 'el.outerHTML = html; // marmeon-check-ignore inner-html: same', ''].join('\n'),
      'src/b.tsx': ['<div>', '  {/* marmeon-check-ignore inner-html: from Shiki */}', '  <p dangerouslySetInnerHTML={{ __html: html }} />', '</div>;', ''].join('\n'),
    });
    expect(innerHtmlCheck(root).report).toMatchObject({
      status: 'passed',
      problems: [],
      silenced: [
        { file: 'src/a.ts', line: 2, reason: 'the markup is built by the server' },
        { file: 'src/a.ts', line: 3, reason: 'same' },
        { file: 'src/b.tsx', line: 3, reason: 'from Shiki' },
      ],
    });
  });

  it('is not silenced by a comment for another check, one two lines up, or one at the end of the line above', () => {
    const root = app({
      'src/a.ts': ['// marmeon-check-ignore raw-sql: not this check', 'el.innerHTML = a;', '// marmeon-check-ignore inner-html: too far', '', 'el.innerHTML = b;', 'one(); // marmeon-check-ignore inner-html: only its own line', 'el.innerHTML = c;', ''].join('\n'),
    });
    const { report } = innerHtmlCheck(root);
    expect(report.problems.filter((problem) => problem.rule === 'marmeon(inner-html)').map((problem) => problem.line)).toEqual([2, 5, 7]);
    expect(report.silenced ?? []).toEqual([]);
  });
});
