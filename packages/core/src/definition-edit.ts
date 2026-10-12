import { accessSync, chmodSync, constants, existsSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { parseSync } from './oxc.ts';

type Node = { type: string; start: number; end: number; [key: string]: any };

/** A binding the edited file must have for the new entry: the entry's class, `listen`, an event. */
export interface DefinitionImport {
  /** The exported name (`listen`, `SendInvoiceReminderJob`); for `kind: 'default'` the local name to give it. */
  readonly name: string;
  /** The specifier: `./jobs/SendInvoiceReminderJob.ts`, `@marmeon/core`, `#modules/billing`. */
  readonly from: string;
  readonly kind?: 'named' | 'default';
  /** Use a value binding of this name the file already has, wherever it is imported from. */
  readonly reuseAnyBinding?: boolean;
}

/** What to add to the object that `defineModule`/`defineApplication` receives. */
export interface DefinitionEdit {
  /** The definition function and its module — `{ name: 'defineModule', from: '@marmeon/core' }`; aliases and namespace imports are followed. */
  readonly define: { readonly name: string; readonly from: string };
  readonly key: string;
  /** `element`: added to the array under `key` (the property is created when missing). `value`: `key: value`, unless `key` exists. */
  readonly add:
    | { readonly element: (names: Readonly<Record<string, string>>) => string; readonly position?: 'first' | 'last' }
    | { readonly value: string };
  readonly imports?: readonly DefinitionImport[];
}

/** `added` carries the new source; `manual` says why the file has a shape the editor does not touch. */
export type DefinitionEditOutcome =
  | { readonly status: 'added'; readonly source: string }
  | { readonly status: 'present' }
  | { readonly status: 'manual'; readonly reason: string };

/** A top-level import of a file, by local name. */
export interface ImportedBinding {
  readonly from: string;
  readonly imported: string | 'default' | '*';
  readonly typeOnly: boolean;
}

type Splice = readonly [start: number, end: number, text: string];

/**
 * Adds an entry to a list (or a property) of the object passed to `defineModule`/`defineApplication`, with the imports it needs.
 * Only inserts: the rest of the file stays byte for byte. Anything the editor does not recognise comes back as `manual` with a
 * reason. See `docs/package-development.md#registering-what-a-generator-writes`.
 */
export function editDefinition(source: string, filename: string, edit: DefinitionEdit): DefinitionEditOutcome {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length > 0) return manual(`${filename} does not parse`);
  const program: Node = parsed.program;
  const body: Node[] = program.body;
  const where = `${edit.define.name}({ … })`;

  const imports = body.filter((statement) => statement.type === 'ImportDeclaration');
  const callNames = new Set<string>();
  const namespaces = new Set<string>();
  for (const declaration of imports) {
    if (declaration.source.value !== edit.define.from || declaration.importKind === 'type') continue;
    for (const specifier of declaration.specifiers as Node[]) {
      if (specifier.importKind === 'type') continue;
      if (specifier.type === 'ImportSpecifier' && nameOf(specifier.imported) === edit.define.name) callNames.add(specifier.local.name);
      if (specifier.type === 'ImportNamespaceSpecifier') namespaces.add(specifier.local.name);
    }
  }
  const calls = callsOf(program, callNames, namespaces, edit.define.name);
  if (calls.length === 0) return manual(`${filename} has no ${where} call`);
  if (calls.length > 1) return manual(`${filename} calls ${edit.define.name} more than once`);
  const object: Node | undefined = calls[0]!.arguments[0];
  if (object?.type !== 'ObjectExpression') return manual(`the argument of ${edit.define.name} is not an object written out in ${filename}`);

  const members: Node[] = object.properties;
  const matches = members.filter((member) => member.type === 'Property' && !member.computed && keyOf(member.key) === edit.key);
  if (matches.length > 1) return manual(`${edit.key} is set twice in ${where}`);
  const property = matches[0];
  const spreadAt = members.findIndex((member) => member.type === 'SpreadElement');
  if (spreadAt !== -1 && (!property || spreadAt > members.indexOf(property))) {
    return manual(`${edit.key} may come from a spread in ${where}`);
  }

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const resolved = resolveImports(source, body, imports, edit.imports ?? [], eol);
  if ('reason' in resolved) return manual(resolved.reason);

  const splices: Splice[] = [...resolved.splices];
  if ('value' in edit.add) {
    if (property) return { status: 'present' };
    splices.push(...appendSplices(source, members, object, `${edit.key}: ${edit.add.value}`, eol, 'last'));
  } else {
    const element = edit.add.element(resolved.names);
    const position = edit.add.position ?? 'last';
    if (!property) {
      splices.push(...appendSplices(source, members, object, `${edit.key}: [${element}]`, eol, 'last'));
    } else {
      const list: Node = property.value;
      if (property.shorthand || property.method || property.kind !== 'init' || list.type !== 'ArrayExpression') {
        return manual(`${edit.key} is not a list written out in ${where}`);
      }
      const elements: Node[] = list.elements.filter((item: Node | null) => item !== null);
      const wanted = squash(element);
      if (elements.some((item) => squash(source.slice(item.start, item.end)) === wanted)) return { status: 'present' };
      splices.push(...appendSplices(source, elements, list, element, eol, position));
    }
  }

  const result = apply(source, splices);
  // Invariant: a file is never left half-edited or unparsable. An entry that breaks the syntax (or a splice that went wrong)
  // is caught here, before anything is written.
  if (parseSync(filename, result).errors.length > 0) return manual('the edit would not parse — the file is left as it was');
  return { status: 'added', source: result };
}

/**
 * {@link editDefinition} on a file. Writes only on `added`, atomically (a temporary file beside it, renamed into place); a missing
 * file is `manual`. `display` is the name reasons use (an app-relative path such as `bootstrap/app.ts`; default: `file`) and must
 * keep the file's extension. See `docs/package-development.md#registering-what-a-generator-writes`.
 */
export function editDefinitionFile(file: string, edit: DefinitionEdit, display: string = file): DefinitionEditOutcome {
  if (!existsSync(file)) return manual(`${display} does not exist`);
  const real = realpathSync(file); // a symlinked file is edited where it lives, the link stays
  const outcome = editDefinition(readFileSync(real, 'utf8'), display, edit);
  if (outcome.status !== 'added') return outcome;
  try {
    accessSync(real, constants.W_OK);
  } catch {
    return manual(`${display} is not writable`);
  }
  const temporary = `${real}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, outcome.source);
    chmodSync(temporary, statSync(real).mode & 0o7777); // the write's mode is umasked
    renameSync(temporary, real);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return outcome;
}

/**
 * The top-level imports of a source by local name, type-only ones included — for a generator that follows an import the file
 * already has. Empty when the source does not parse. See `docs/package-development.md#registering-what-a-generator-writes`.
 */
export function importedBindings(source: string, filename: string): ReadonlyMap<string, ImportedBinding> {
  const bindings = new Map<string, ImportedBinding>();
  const { program, errors } = parseSync(filename, source);
  if (errors.length > 0) return bindings;
  for (const declaration of program.body as Node[]) {
    if (declaration.type !== 'ImportDeclaration') continue;
    for (const specifier of declaration.specifiers as Node[]) {
      bindings.set(specifier.local.name, {
        from: declaration.source.value,
        imported: specifier.type === 'ImportDefaultSpecifier' ? 'default' : specifier.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(specifier.imported),
        typeOnly: declaration.importKind === 'type' || specifier.importKind === 'type',
      });
    }
  }
  return bindings;
}

function manual(reason: string): DefinitionEditOutcome {
  return { status: 'manual', reason };
}

function nameOf(node: Node): string {
  return node.type === 'Literal' ? String(node.value) : node.name;
}

function keyOf(node: Node): string | undefined {
  return node.type === 'Identifier' ? node.name : node.type === 'Literal' ? String(node.value) : undefined;
}

function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

function callsOf(program: Node, names: ReadonlySet<string>, namespaces: ReadonlySet<string>, exported: string): Node[] {
  const found: Node[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object' || node === null || typeof (node as Node).type !== 'string') return;
    const current = node as Node;
    if (current.type === 'CallExpression') {
      const callee: Node = current.callee;
      const direct = callee.type === 'Identifier' && names.has(callee.name);
      const qualified =
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        namespaces.has(callee.object.name) &&
        callee.property.name === exported;
      if (direct || qualified) found.push(current);
    }
    for (const [key, value] of Object.entries(current)) {
      if (key !== 'type' && typeof value === 'object') visit(value);
    }
  };
  visit(program);
  return found;
}

/** Relative and `#` specifiers match without their extension (`./x.ts`, `./x.js`, `./x`); a folder is never its `index`. */
function sameSource(a: string, b: string): boolean {
  if (a === b) return true;
  if (!/^[.#]/.test(a) || !/^[.#]/.test(b)) return false;
  const bare = (specifier: string): string => specifier.replace(/\.(?:ts|js|mts|mjs)$/, '');
  return bare(a) === bare(b);
}

function declaredNames(body: Node[]): Set<string> {
  const names = new Set<string>();
  const pattern = (node: Node | null | undefined): void => {
    if (!node) return;
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'ObjectPattern') for (const item of node.properties as Node[]) pattern(item.type === 'RestElement' ? item.argument : item.value);
    else if (node.type === 'ArrayPattern') for (const item of node.elements as (Node | null)[]) pattern(item);
    else if (node.type === 'AssignmentPattern') pattern(node.left);
    else if (node.type === 'RestElement') pattern(node.argument);
  };
  for (const statement of body) {
    const declaration: Node | null = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? statement.declaration : statement;
    if (!declaration) continue;
    if (declaration.type === 'VariableDeclaration') for (const item of declaration.declarations as Node[]) pattern(item.id);
    else if ([
        'FunctionDeclaration',
        'ClassDeclaration',
        'TSEnumDeclaration',
        'TSTypeAliasDeclaration',
        'TSInterfaceDeclaration',
        'TSModuleDeclaration',
        'TSImportEqualsDeclaration',
      ].includes(declaration.type) &&
      declaration.id?.type === 'Identifier'
    ) {
      names.add(declaration.id.name);
    }
  }
  return names;
}

function resolveImports(
  source: string,
  body: Node[],
  imports: Node[],
  wanted: readonly DefinitionImport[],
  eol: string,
): { names: Record<string, string>; splices: Splice[] } | { reason: string } {
  const taken = declaredNames(body);
  const bindings = new Map<string, { declaration: Node; specifier: Node; typeOnly: boolean }>();
  for (const declaration of imports) {
    for (const specifier of declaration.specifiers as Node[]) {
      taken.add(specifier.local.name);
      bindings.set(specifier.local.name, { declaration, specifier, typeOnly: declaration.importKind === 'type' || specifier.importKind === 'type' });
    }
  }

  const names: Record<string, string> = {};
  const splices: Splice[] = [];
  const lines: string[] = [];
  const quote = imports[0] ? source[imports[0].source.start]! : "'";
  const semicolon = imports.length === 0 || source[imports[imports.length - 1]!.end - 1] === ';' ? ';' : '';
  const added = new Map<Node, Node[]>();

  for (const item of wanted) {
    const isDefault = item.kind === 'default';
    let local: string | undefined;
    let typeOnlyFound = false;

    for (const { declaration, specifier, typeOnly } of bindings.values()) {
      if (!sameSource(declaration.source.value, item.from)) continue;
      const matches = isDefault ? specifier.type === 'ImportDefaultSpecifier' : specifier.type === 'ImportSpecifier' && nameOf(specifier.imported) === item.name;
      if (!matches) continue;
      if (typeOnly) typeOnlyFound = true;
      else {
        local = specifier.local.name;
        break;
      }
    }
    if (!local && !isDefault) {
      for (const { declaration, specifier, typeOnly } of bindings.values()) {
        if (specifier.type === 'ImportNamespaceSpecifier' && !typeOnly && sameSource(declaration.source.value, item.from)) {
          local = `${specifier.local.name}.${item.name}`;
          break;
        }
      }
    }
    if (!local && item.reuseAnyBinding) {
      const existing = bindings.get(item.name);
      if (existing && !existing.typeOnly) local = item.name;
    }
    if (!local && typeOnlyFound) return { reason: `${item.name} is imported from ${item.from} only as a type` };
    if (!local) {
      if (taken.has(item.name)) return { reason: `the name ${item.name} is already used for something else` };
      taken.add(item.name);
      local = item.name;
      const target = isDefault
        ? undefined
        : imports.find(
            (declaration) =>
              declaration.source.value === item.from &&
              declaration.importKind !== 'type' &&
              (declaration.specifiers as Node[]).some((specifier) => specifier.type === 'ImportSpecifier'),
          );
      if (target) added.set(target, [...(added.get(target) ?? []), { type: 'name', start: 0, end: 0, name: item.name }]);
      else lines.push(isDefault ? `import ${item.name} from ${quote}${item.from}${quote}${semicolon}` : `import { ${item.name} } from ${quote}${item.from}${quote}${semicolon}`);
    }
    names[item.name] = local;
  }

  for (const [declaration, newcomers] of added) {
    const specifiers = (declaration.specifiers as Node[]).filter((specifier) => specifier.type === 'ImportSpecifier');
    const listed = specifiers.map((specifier) => nameOf(specifier.imported));
    const sorted = listed.every((name, index) => index === 0 || listed[index - 1]! <= name);
    for (const { name } of newcomers) {
      const next = sorted ? specifiers.find((specifier) => nameOf(specifier.imported) > name) : undefined;
      if (next) splices.push([next.start, next.start, `${name}, `]);
      else splices.push([specifiers[specifiers.length - 1]!.end, specifiers[specifiers.length - 1]!.end, `, ${name}`]);
    }
  }

  if (lines.length > 0) {
    const last = imports[imports.length - 1];
    if (last) {
      const tail = /^[ \t]*(?:\/\/[^\r\n]*|\/\*[^\r\n]*?\*\/)?/.exec(source.slice(last.end))![0];
      const at = last.end + tail.length;
      splices.push([at, at, lines.map((line) => eol + line).join('')]);
    } else {
      splices.push([0, 0, lines.map((line) => line + eol).join('')]);
    }
  }
  return { names, splices };
}

/** Splices that put `text` behind (or, for `first`, before) the items of a list or object, in the file's own style. */
function appendSplices(source: string, items: Node[], container: Node, text: string, eol: string, position: 'first' | 'last'): Splice[] {
  const open = container.start + 1;
  if (items.length === 0) {
    const inner = source.slice(open, container.end - 1);
    const padded = container.type === 'ObjectExpression' ? ` ${text} ` : text;
    return /^\s*$/.test(inner) ? [[open, container.end - 1, padded]] : [[open, open, padded]];
  }

  const lineStart = (offset: number): number => source.lastIndexOf('\n', offset - 1) + 1;
  const indentAt = (offset: number): string => /^[ \t]*/.exec(source.slice(lineStart(offset)))![0];
  const first = items[0]!;
  const last = items[items.length - 1]!;

  if (position === 'first') {
    if (source.slice(container.start, first.start).includes('\n') && source.slice(lineStart(first.start), first.start).trim() === '') {
      const at = lineStart(first.start);
      return [[at, at, `${indentAt(first.start)}${text},${eol}`]];
    }
    return [[first.start, first.start, `${text}, `]];
  }

  const comma = /^[ \t]*(,)?/.exec(source.slice(last.end))!;
  const hasComma = comma[1] !== undefined;
  const multiline = source.slice(container.start, last.start).includes('\n');
  if (multiline) {
    const rest = /^[ \t]*(,)?[ \t]*(?:\/\/[^\r\n]*)?(?=\r?\n|$)/.exec(source.slice(last.end));
    if (rest) {
      const at = last.end + rest[0].length;
      const entry = `${eol}${indentAt(last.start)}${text}`;
      return hasComma ? [[at, at, `${entry},`]] : [[last.end, last.end, ','], [at, at, entry]];
    }
  }
  const after = last.end + comma[0].length;
  return hasComma ? [[after, after, ` ${text}`]] : [[last.end, last.end, `, ${text}`]];
}

function apply(source: string, splices: readonly Splice[]): string {
  const ordered = splices.map((splice, index) => ({ splice, index })).sort((a, b) => b.splice[0] - a.splice[0] || b.index - a.index);
  let result = source;
  for (const { splice: [start, end, text] } of ordered) result = result.slice(0, start) + text + result.slice(end);
  return result;
}
