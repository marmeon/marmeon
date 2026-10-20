import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseSync } from '@marmeon/core/internal';
import { sourceFiles } from './files.ts';
import { reportOf, unrunReport, type CheckProblem } from './report.ts';
import { silence, type SilenceableCheck } from './silence.ts';
import type { CheckRun } from './tools.ts';
import { plainReason } from './tools.ts';

/** A node of the syntax tree, as far as these rules read it. */
export type Node = { type: string; start: number; end: number; [key: string]: any };

/** How often a name is declared in a file, and — for a single `const` — what it is set to. */
export type Declarations = ReadonlyMap<string, { readonly count: number; readonly kind?: string; readonly init?: Node }>;

/** The parsed form of a source file the rules share. */
export interface ParsedSource {
  readonly program: Node;
  readonly declarations: Declarations;
  /** Every node, in no particular order. */
  readonly nodes: readonly Node[];
  /** 1-based line and column of an offset. */
  readonly position: (offset: number) => { line: number; column: number };
}

/** The names a binding pattern declares (`a`, `{ a, b: [c] }`, `a = 1`, `...rest`). */
function bindingNames(pattern: Node | null | undefined): string[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return (pattern.properties as Node[]).flatMap((property) => bindingNames(property.type === 'RestElement' ? property.argument : property.value));
    case 'ArrayPattern':
      return (pattern.elements as (Node | null)[]).flatMap(bindingNames);
    case 'AssignmentPattern':
      return bindingNames(pattern.left);
    case 'RestElement':
      return bindingNames(pattern.argument);
    case 'TSParameterProperty':
      return bindingNames(pattern.parameter);
    default:
      return [];
  }
}

/** Parses `source`; `undefined` when it does not parse (the type check reports such a file). */
export function parseSource(source: string, filename: string): ParsedSource | undefined {
  const { program, errors } = parseSync(filename, source);
  if (errors.length > 0) return undefined;
  const starts: number[] = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) starts.push(index + 1);
  const position = (offset: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return { line: low + 1, column: offset - starts[low]! + 1 };
  };
  const declarations = new Map<string, { count: number; kind?: string; init?: Node }>();
  const declare = (name: string, extra: { kind?: string; init?: Node } = {}) => {
    const known = declarations.get(name);
    declarations.set(name, known ? { count: known.count + 1 } : { count: 1, ...extra });
  };
  const nodes: Node[] = [];
  const stack: unknown[] = [program];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
    } else if (node !== null && typeof node === 'object') {
      const found = node as Node;
      if (typeof found.type === 'string') {
        nodes.push(found);
        switch (found.type) {
          case 'VariableDeclaration':
            for (const declarator of found.declarations as Node[]) {
              const single = declarator.id.type === 'Identifier';
              for (const name of bindingNames(declarator.id)) declare(name, single ? { kind: found.kind, ...(declarator.init ? { init: declarator.init } : {}) } : {});
            }
            break;
          case 'FunctionDeclaration':
          case 'FunctionExpression':
          case 'ArrowFunctionExpression':
          case 'TSDeclareFunction':
            for (const parameter of found.params as Node[]) for (const name of bindingNames(parameter)) declare(name);
            if (found.id) declare(found.id.name);
            break;
          case 'ClassDeclaration':
          case 'ClassExpression':
          case 'TSEnumDeclaration':
            if (found.id?.type === 'Identifier') declare(found.id.name);
            break;
          case 'CatchClause':
            for (const name of bindingNames(found.param)) declare(name);
            break;
          case 'ImportDeclaration':
            for (const specifier of found.specifiers as Node[]) declare(specifier.local.name);
            break;
        }
      }
      for (const key of Object.keys(found)) {
        const child = found[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return { program, declarations, nodes, position };
}

/**
 * Whether the value of `node` is fixed in the source: a string literal, a template without an expression, a `+` of literals,
 * any of them in parentheses or with `as`/`satisfies`, or a name declared exactly once in the file as `const NAME = <literal>`.
 * A name from another file is not literal, and neither is any function call — whatever it is called.
 */
export function isLiteral(node: Node | null | undefined, declarations: Declarations, seen: ReadonlySet<string> = new Set()): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'bigint' || typeof node.value === 'boolean';
    case 'TemplateLiteral':
      return (node.expressions as Node[]).length === 0;
    case 'BinaryExpression':
      return node.operator === '+' && isLiteral(node.left, declarations, seen) && isLiteral(node.right, declarations, seen);
    case 'ParenthesizedExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      return isLiteral(node.expression, declarations, seen);
    case 'Identifier': {
      const declared = declarations.get(node.name);
      if (!declared || declared.count !== 1 || declared.kind !== 'const' || seen.has(node.name)) return false;
      return isLiteral(declared.init, declarations, new Set(seen).add(node.name));
    }
    default:
      return false;
  }
}

/** Reads the app's sources once for a rule: `visit` gets each parsed file; a file that cannot be read or parsed is skipped. */
function scan(root: string, tests: boolean, visit: (file: string, parsed: ParsedSource) => void): void {
  for (const path of sourceFiles(root, { tests })) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const parsed = parseSource(text, path.slice(path.lastIndexOf('/') + 1));
    if (parsed) visit(relative(root, path).split('\\').join('/'), parsed);
  }
}

/** The packages whose `sql` is the query builder's tag. */
const SQL_PACKAGES = new Set(['@marmeon/database', 'kysely']);

/** `(x)`, `x as T`, `x satisfies T`, `x!` and `<T>x` are `x`. */
function unwrap(node: Node): Node {
  let current = node;
  while (['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion'].includes(current.type)) current = current.expression;
  return current;
}

/** The name a member is read by: `.raw`, `['raw']` or a template without an expression. */
function memberName(member: Node): string | undefined {
  const property = member.property as Node | undefined;
  if (!member.computed) return property?.type === 'Identifier' ? property.name : undefined;
  if (property?.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property?.type === 'TemplateLiteral' && property.expressions.length === 0) return property.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** What names the query builder's `sql` in a file: `sql` itself, an import of it, a namespace import that holds it, a `const` set to one of them. */
function sqlResolver(nodes: readonly Node[], declarations: Declarations): (node: Node, seen?: ReadonlySet<string>) => boolean {
  const direct = new Set(['sql']);
  const namespaces = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'ImportDeclaration' || !SQL_PACKAGES.has(node.source.value)) continue;
    for (const specifier of node.specifiers as Node[]) {
      if (specifier.type === 'ImportSpecifier' && (specifier.imported.name ?? specifier.imported.value) === 'sql') direct.add(specifier.local.name);
      else if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name);
    }
  }
  const isSql = (node: Node, seen: ReadonlySet<string> = new Set()): boolean => {
    const target = unwrap(node);
    if (target.type === 'Identifier') {
      if (direct.has(target.name)) return true;
      const declared = declarations.get(target.name);
      return declared?.count === 1 && declared.kind === 'const' && declared.init !== undefined && !seen.has(target.name) && isSql(declared.init, new Set(seen).add(target.name));
    }
    if (target.type !== 'MemberExpression' || memberName(target) !== 'sql') return false;
    const holder = unwrap(target.object);
    return holder.type === 'Identifier' && namespaces.has(holder.name);
  };
  return isSql;
}

/** The locals of `const { raw, lit: l } = sql`, which call `sql.raw` and `sql.lit` bare. */
function rawFunctions(nodes: readonly Node[], declarations: Declarations, isSql: (node: Node) => boolean): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || !node.init || !isSql(node.init)) continue;
    for (const property of node.id.properties as Node[]) {
      if (property.type !== 'Property' || property.computed) continue;
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      const local = property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
      if ((key === 'raw' || key === 'lit') && local.type === 'Identifier' && declarations.get(local.name)?.count === 1) names.add(local.name);
    }
  }
  return names;
}

const RAW_SQL_MESSAGE =
  'This SQL is built from a value the code does not fix. Put the value in the query with `${value}` in a `sql` template, which sends it as a parameter; a column or table name comes from a list in the code. If the argument is safe, say why: `// marmeon-check-ignore raw-sql: <why>`.';

/**
 * The scan for `sql.raw()` and `sql.lit()` with an argument that is not a literal: those put the text into the query as written, so
 * a value from a request becomes SQL. `sql` is the name `sql`, an import of it from `@marmeon/database` or `kysely` under another
 * name, `NS.sql` of a namespace import, or a `const` set to one of them; parentheses, `as` and `!` around it do not hide it, and
 * neither do `const { raw } = sql`, `['raw']`, `.call()` and `.apply()`. Tests are not read. See docs/check.md#raw-sql.
 */
export function rawSqlProblems(root: string): CheckProblem[] {
  const problems: CheckProblem[] = [];
  scan(root, false, (file, { nodes, declarations, position }) => {
    const isSql = sqlResolver(nodes, declarations);
    const bare = rawFunctions(nodes, declarations, isSql);
    /** Whether `node` is `sql.raw`, `sql.lit` or a name destructured from them. */
    const isRaw = (node: Node, seen: ReadonlySet<string> = new Set()): boolean => {
      const target = unwrap(node);
      if (target.type === 'Identifier') {
        if (bare.has(target.name)) return true;
        const declared = declarations.get(target.name);
        return declared?.count === 1 && declared.kind === 'const' && declared.init !== undefined && !seen.has(target.name) && isRaw(declared.init, new Set(seen).add(target.name));
      }
      if (target.type !== 'MemberExpression') return false;
      const method = memberName(target);
      return (method === 'raw' || method === 'lit') && isSql(target.object);
    };
    for (const node of nodes) {
      if (node.type !== 'CallExpression') continue;
      const callee = unwrap(node.callee);
      const args = node.arguments as Node[];
      let argument: Node | undefined;
      if (isRaw(callee)) argument = args[0];
      else if (callee.type === 'MemberExpression' && isRaw(callee.object)) {
        const via = memberName(callee);
        if (via === 'call') argument = args[1];
        else if (via === 'apply') argument = args[1]?.type === 'ArrayExpression' ? (args[1].elements as Node[])[0] : args[1];
      }
      if (!argument || isLiteral(argument, declarations)) continue;
      const { line, column } = position(argument.start);
      problems.push({ severity: 'warning', message: RAW_SQL_MESSAGE, file, line, column, rule: 'marmeon(raw-sql)', docs: 'docs/check.md#raw-sql' });
    }
  });
  return sorted(problems);
}

/** A rule's findings in the order of the files, then of the lines. */
function sorted(problems: CheckProblem[]): CheckProblem[] {
  return problems.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : a.line! - b.line! || a.column! - b.column!));
}

/** A source rule as a check: the findings, less those a comment with a reason silences. */
function sourceCheck(name: SilenceableCheck, root: string, find: (root: string) => CheckProblem[]): CheckRun {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  try {
    const { problems, silenced } = silence(name, root, find(root));
    return { report: { ...reportOf(name, problems, ms()), ...(silenced.length > 0 ? { silenced } : {}) } };
  } catch (error) {
    return { report: unrunReport(name, 'error', `the scan failed: ${plainReason(error, root)}`, ms()) };
  }
}

/** `raw-sql` as a check: the findings, less those a comment with a reason silences. */
export function rawSqlCheck(root: string): CheckRun {
  return sourceCheck('raw-sql', root, rawSqlProblems);
}

/** The name a property is keyed by: `a`, `'a'`, `['a']` or a template without an expression. */
function keyName(property: Node): string | undefined {
  const key = property.key as Node;
  if (!property.computed) return key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : undefined;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'TemplateLiteral' && key.expressions.length === 0) return key.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

/** Whether `node` is `{ __html: <literal> }` — itself, in parentheses or with a cast, or a `const` set to it — with nothing that could replace the markup. */
function fixedHtml(node: Node, declarations: Declarations, seen: ReadonlySet<string> = new Set()): boolean {
  const target = unwrap(node);
  if (target.type === 'Identifier') {
    const declared = declarations.get(target.name);
    return declared?.count === 1 && declared.kind === 'const' && declared.init !== undefined && !seen.has(target.name) && fixedHtml(declared.init, declarations, new Set(seen).add(target.name));
  }
  if (target.type !== 'ObjectExpression') return false;
  let found = false;
  for (const property of target.properties as Node[]) {
    if (property.type !== 'Property') return false;
    const name = keyName(property);
    if (name === '__html') {
      if (!isLiteral(property.value, declarations)) return false;
      found = true;
    } else if (name === undefined) return false;
  }
  return found;
}

/** Whether `node` is the `document` — by name, as `window.document`, or a `const` set to one. */
function isDocument(node: Node, declarations: Declarations, seen: ReadonlySet<string> = new Set()): boolean {
  const target = unwrap(node);
  if (target.type === 'MemberExpression') return ['document', 'contentDocument', 'ownerDocument'].includes(memberName(target) ?? '');
  if (target.type !== 'Identifier') return false;
  if (target.name === 'document') return true;
  const declared = declarations.get(target.name);
  return declared?.count === 1 && declared.kind === 'const' && declared.init !== undefined && !seen.has(target.name) && isDocument(declared.init, declarations, new Set(seen).add(target.name));
}

/** The methods that parse their argument as HTML, and the position of that argument. `write` and `writeln` of the document are checked on every argument. */
const HTML_METHODS: ReadonlyMap<string, number> = new Map([
  ['insertAdjacentHTML', 1],
  ['createContextualFragment', 0],
  ['setHTMLUnsafe', 0],
]);

/** `unwrap`, and the `?.` chain around an optional member: `(el?.insertAdjacentHTML)` is `el.insertAdjacentHTML`. */
function unchain(node: Node): Node {
  let current = unwrap(node);
  while (current.type === 'ChainExpression') current = unwrap(current.expression);
  return current;
}

/**
 * The method `node` is, when it sets HTML — `el.insertAdjacentHTML`, `document.write`, a `const` set to one, or one of them
 * `.bind()`-ed — and the arguments `.bind()` already gave it.
 */
function htmlMethod(node: Node, declarations: Declarations, seen: ReadonlySet<string> = new Set()): { name: string; preset: Node[] } | undefined {
  const target = unchain(node);
  if (target.type === 'Identifier') {
    const declared = declarations.get(target.name);
    if (declared?.count !== 1 || declared.kind !== 'const' || declared.init === undefined || seen.has(target.name)) return undefined;
    return htmlMethod(declared.init, declarations, new Set(seen).add(target.name));
  }
  if (target.type === 'CallExpression') {
    const callee = unchain(target.callee);
    if (callee.type !== 'MemberExpression' || memberName(callee) !== 'bind') return undefined;
    const bound = htmlMethod(callee.object, declarations, seen);
    const given = target.arguments as Node[];
    return bound && { name: bound.name, preset: [...bound.preset, ...(given[0]?.type === 'SpreadElement' ? [given[0]] : given.slice(1))] };
  }
  if (target.type !== 'MemberExpression') return undefined;
  const name = memberName(target);
  if (name === undefined) return undefined;
  if (name === 'write' || name === 'writeln') return isDocument(target.object, declarations) ? { name, preset: [] } : undefined;
  return HTML_METHODS.has(name) ? { name, preset: [] } : undefined;
}

const INNER_HTML_MESSAGE =
  'This HTML is set from a value the code does not fix, so a value from a request can become script. Show the value as text (`{value}` in JSX, `textContent` in the DOM). If the HTML is safe, say why: `// marmeon-check-ignore inner-html: <why>`.';

/**
 * The scan for HTML that code sets from a value it does not fix: the `dangerouslySetInnerHTML` attribute or property unless its
 * value is `{ __html: <literal> }`, an assignment to `.innerHTML`, `.outerHTML`, `.srcdoc` or `.__html`, the `srcDoc` attribute, and
 * `insertAdjacentHTML`, `document.write`, `createContextualFragment` and `setHTMLUnsafe` with a non-literal argument. Parentheses,
 * `as`, `!`, `?.`, a `const` that holds the object or the method, `['innerHTML']`, `.call()`, `.apply()` and `.bind()` do not hide a sink. A name such as `sanitize` is no proof.
 * Tests are not read. See docs/check.md#html-from-code.
 */
export function innerHtmlProblems(root: string): CheckProblem[] {
  const problems: CheckProblem[] = [];
  scan(root, false, (file, { nodes, declarations, position }) => {
    const report = (at: Node) => {
      const { line, column } = position(at.start);
      problems.push({ severity: 'warning', message: INNER_HTML_MESSAGE, file, line, column, rule: 'marmeon(inner-html)', docs: 'docs/check.md#html-from-code' });
    };
    for (const node of nodes) {
      switch (node.type) {
        case 'JSXAttribute':
          if (node.name.type === 'JSXIdentifier' && node.value?.type === 'JSXExpressionContainer') {
            const value = node.value.expression as Node;
            if (value.type === 'JSXEmptyExpression') break;
            if (node.name.name === 'dangerouslySetInnerHTML' && !fixedHtml(value, declarations)) report(value);
            else if ((node.name.name === 'srcDoc' || node.name.name === 'srcdoc') && !isLiteral(value, declarations)) report(value);
          }
          break;
        case 'ObjectExpression':
          for (const property of node.properties as Node[]) {
            if (property.type !== 'Property') continue;
            const key = keyName(property);
            if (key === 'dangerouslySetInnerHTML' && !fixedHtml(property.value, declarations)) report(property.value);
            else if (key === 'srcDoc' && !isLiteral(property.value, declarations)) report(property.value);
          }
          break;
        case 'AssignmentExpression': {
          const target = unwrap(node.left);
          const name = target.type === 'MemberExpression' ? memberName(target) : undefined;
          if (name !== undefined && ['innerHTML', 'outerHTML', 'srcdoc', '__html'].includes(name) && !isLiteral(node.right, declarations)) report(node.right);
          break;
        }
        case 'CallExpression': {
          const callee = unchain(node.callee);
          let args = node.arguments as Node[];
          let method = htmlMethod(callee, declarations);
          if (!method && callee.type === 'MemberExpression') {
            const via = memberName(callee);
            if (via === 'call' || via === 'apply') {
              method = htmlMethod(callee.object, declarations);
              if (via === 'call') args = args[0]?.type === 'SpreadElement' ? [args[0]] : args.slice(1);
              else args = args[1] === undefined ? [] : args[1].type === 'ArrayExpression' ? (args[1].elements as (Node | null)[]).map((element) => element ?? { type: 'Literal', value: '', start: 0, end: 0 }) : [{ ...args[1], type: 'SpreadElement' }];
            }
          }
          if (!method) break;
          args = [...method.preset, ...args];
          const index = HTML_METHODS.get(method.name);
          // A spread before the argument moves it: whatever is spread could be the HTML.
          const spread = args.slice(0, index === undefined ? args.length : index + 1).find((argument) => argument.type === 'SpreadElement');
          const argument = spread ?? (index === undefined ? args.find((each) => !isLiteral(each, declarations)) : args[index]);
          if (argument && !isLiteral(argument, declarations)) report(argument);
          break;
        }
      }
    }
  });
  return sorted(problems);
}

/** `inner-html` as a check: the findings, less those a comment with a reason silences. */
export function innerHtmlCheck(root: string): CheckRun {
  return sourceCheck('inner-html', root, innerHtmlProblems);
}
