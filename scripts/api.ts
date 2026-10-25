/**
 * `pnpm api:check` — is the public surface of every package what `packages/<name>/api.md` says? A part of `pnpm run ci`. The
 * rules in full: CONTRIBUTING.md, "Pull requests and releases" › "The API snapshot".
 *
 *   pnpm api:check                        # the built declarations against the checked-in api.md files; exit 1 on any difference
 *   pnpm api:update                       # a clean build, then rewrite the api.md files (commit them with the change)
 *   node scripts/api.ts --write           # rewrite from the current dist/
 *
 * The snapshot is read from the emitted `.d.ts` files with oxc-parser: per entry point (not `./internal`) every exported
 * declaration without its comments, and the types a public declaration names without exporting them. `@internal` declarations
 * and members are left out, `@experimental` ones listed apart: a declaration or a member tagged so, a whole entry point or
 * package (`marmeon.experimental` in its `package.json`: `true`, or a list of subpaths), a command (`static experimental`).
 * The Environment and Commands sections come from the built `dist/*.js` of the providers, which are imported (nothing boots).
 * Everything experimental must be named in `docs/releases.md`. The format: `scripts/api-snapshot.ts`.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SAME_VALUE } from './api-names.ts';
import { compareSnapshots, parseSnapshot, renderSnapshot, type ApiChanges, type ApiItem } from './api-snapshot.ts';
import { LIBRARY } from './check-source.ts';
import { frameworkPackages } from './packages.ts';
import { oxc } from './source-files.ts';

/**
 * The packages whose types a package's public declarations may name, per package (the directory name under `packages/`).
 * Anything else is a problem: an app would need the library installed to compile against Marmeon. Each entry says why it is
 * there; an entry that only waits for a change names it, and that change deletes the entry.
 */
export const FOREIGN_TYPES: Readonly<Record<string, readonly string[]>> = {
  // The query builder's aliases (`Connection`, `Row`, …) point at Kysely's types: the builder's shape is public API, its package is not.
  database: [LIBRARY],
  table: [LIBRARY],
  react: ['react', 'react-dom', '@tanstack/react-table'], // peers: the adapter is typed in the types of its UI library
  vite: ['vite'], // a peer: the plugin is a Vite plugin
};

type Node = { type: string; start: number; end: number; [key: string]: any };
interface Comment {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}
/** A top-level declaration: the statement as written (`wrapper`, with its `export`) and the declaration inside it. */
interface Statement {
  readonly wrapper: Node;
  readonly node: Node;
}
interface Import {
  readonly source: string;
  /** `undefined` for a namespace import; `default` for a default import. */
  readonly imported: string | undefined;
  readonly typeOnly: boolean;
}
interface DtsFile {
  readonly path: string;
  readonly text: string;
  readonly comments: readonly Comment[];
  readonly body: readonly Node[];
  readonly declarations: Map<string, Statement[]>;
  readonly imports: Map<string, Import>;
}
/** What an exported name stands for. */
type Target =
  | { readonly kind: 'declaration'; readonly file: string; readonly local: string; readonly typeOnly?: boolean }
  /** A re-export from another package; `imported` is the name there (none for `export * as ns` and `export *`). */
  | { readonly kind: 'external'; readonly text: string; readonly specifier: string; readonly name: string; readonly imported?: string }
  /** `export * as ns from './x'`: a module of the package under one name. */
  | { readonly kind: 'namespace'; readonly file: string };
/** What a name in a declaration stands for: an export of a module of the package, a name another package exports, or a whole module. */
type Resolved =
  | Target
  | { readonly kind: 'foreign'; readonly specifier: string; readonly names: readonly string[] }
  | { readonly kind: 'module'; readonly source: string };

const MEMBER_TYPES = new Set([
  'PropertyDefinition',
  'MethodDefinition',
  'AccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSIndexSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
]);
const DECLARATION_TYPES = new Set([
  'TSDeclareFunction',
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'VariableDeclaration',
]);

/** The declarations that exist at run time too (a namespace may hold values; an empty one is rare enough to mark). */
const VALUE_DECLARATIONS = new Set(['TSDeclareFunction', 'FunctionDeclaration', 'ClassDeclaration', 'TSEnumDeclaration', 'VariableDeclaration', 'TSModuleDeclaration']);

const hasTag =(comment: Comment | undefined, tag: string) =>
  comment?.type === 'Block' && comment.value.startsWith('*') && new RegExp(`(?:^|[\\s*])@${tag}(?![\\w-])`).test(comment.value);

/** The package a specifier of an import names, unless it is one of Marmeon's or Node's. */
export function foreignPackage(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('node:') || specifier === 'marmeon' || specifier.startsWith('marmeon/')) return undefined;
  if (specifier.startsWith('@marmeon/')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const stringOf = (node: Node | null | undefined): string | undefined =>
  node?.type === 'Literal' && typeof node.value === 'string' ? node.value : node?.type === 'TSLiteralType' ? stringOf(node.literal) : undefined;
const nameOf = (node: Node): string => (node.type === 'Literal' ? String(node.value) : node.name);
/** The segments of a dotted name: `['a', 'b', 'c']` for `a.b.c`; none for anything else. */
function pathOf(node: Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'Identifier') return [node.name];
  if (node.type === 'TSQualifiedName') return [...pathOf(node.left), ...pathOf(node.right)];
  if (node.type === 'MemberExpression') return [...pathOf(node.object), ...pathOf(node.property)];
  return [];
}

function* children(node: Node): Generator<Node> {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === 'object' && typeof item.type === 'string') yield item;
    } else if (value && typeof value === 'object' && typeof value.type === 'string') {
      yield value;
    }
  }
}

/** The declarations of one package: its `.d.ts` files, read once, and what they export. */
class Declarations {
  readonly problems: string[] = [];
  readonly #files = new Map<string, DtsFile | undefined>();
  readonly #exports = new Map<string, Map<string, Target>>();
  readonly #parser = oxc();

  file(path: string): DtsFile | undefined {
    if (this.#files.has(path)) return this.#files.get(path);
    let file: DtsFile | undefined;
    if (!existsSync(path)) {
      this.problems.push(`${path} does not exist — run pnpm build first`);
    } else {
      const text = readFileSync(path, 'utf8');
      const parsed = this.#parser.parseSync(path, text);
      if (parsed.errors.length > 0) this.problems.push(`${path} cannot be parsed: ${parsed.errors[0]!.message}`);
      else file = readDts(path, text, parsed.program as Node, parsed.comments as unknown as readonly Comment[]);
    }
    this.#files.set(path, file);
    return file;
  }

  /** The `.d.ts` a relative specifier of `from` stands for. */
  resolveRelative(from: string, specifier: string): string | undefined {
    const base = resolve(dirname(from), specifier);
    const candidates = /\.d\.[cm]?ts$/.test(base)
      ? [base]
      : /\.[cm]?[jt]sx?$/.test(base)
        ? [base.replace(/\.[cm]?[jt]sx?$/, '.d.ts')]
        : [`${base}.d.ts`, join(base, 'index.d.ts')];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) this.problems.push(`${from} imports ${specifier}, which has no declaration file — run pnpm build first`);
    return found;
  }

  /** Every name `path` exports (`export *` followed), by the exported name. */
  exportsOf(path: string, active: Set<string> = new Set()): Map<string, Target> {
    const known = this.#exports.get(path);
    if (known) return known;
    const table = new Map<string, Target>();
    const file = this.file(path);
    if (!file || active.has(path)) return table;
    active.add(path);

    const stars: Map<string, Target>[] = [];
    const external = (specifier: string, exported: string, imported: string | undefined, typeOnly: boolean): Target => ({
      kind: 'external',
      specifier,
      name: exported,
      ...(imported === undefined ? {} : { imported }),
      text:
        imported === undefined
          ? `export * as ${exported} from '${specifier}';`
          : `export ${typeOnly ? 'type ' : ''}{ ${imported === exported ? exported : `${imported} as ${exported}`} } from '${specifier}';`,
    });
    const reexport = (source: string, imported: string, exported: string, typeOnly: boolean) => {
      if (source.startsWith('.')) {
        const target = this.resolveRelative(path, source);
        const found = target && this.exportsOf(target, active).get(imported);
        if (found) table.set(exported, typeOnly && found.kind === 'declaration' ? { ...found, typeOnly: true } : found);
      } else {
        table.set(exported, external(source, exported, imported, typeOnly));
      }
    };

    for (const statement of file.body) {
      if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
        for (const name of declaredNames(statement.declaration)) table.set(name, { kind: 'declaration', file: path, local: name });
      } else if (statement.type === 'ExportNamedDeclaration') {
        const source = stringOf(statement.source);
        for (const specifier of statement.specifiers as Node[]) {
          const local = nameOf(specifier.local);
          const exported = nameOf(specifier.exported);
          const typeOnly = statement.exportKind === 'type' || specifier.exportKind === 'type';
          if (source !== undefined) {
            reexport(source, local, exported, typeOnly);
          } else if (file.declarations.has(local)) {
            table.set(exported, { kind: 'declaration', file: path, local, ...(typeOnly ? { typeOnly: true } : {}) });
          } else {
            const imported = file.imports.get(local);
            if (imported?.imported === undefined) {
              if (imported?.source.startsWith('.')) {
                const target = this.resolveRelative(path, imported.source);
                if (target) table.set(exported, { kind: 'namespace', file: target });
              } else if (imported) {
                table.set(exported, external(imported.source, exported, undefined, false));
              }
            } else {
              reexport(imported.source, imported.imported, exported, typeOnly || imported.typeOnly);
            }
          }
        }
      } else if (statement.type === 'ExportAllDeclaration') {
        const source = stringOf(statement.source)!;
        if (statement.exported) {
          const exported = nameOf(statement.exported);
          if (!source.startsWith('.')) {
            table.set(exported, external(source, exported, undefined, false));
          } else {
            const target = this.resolveRelative(path, source);
            if (target) table.set(exported, { kind: 'namespace', file: target });
          }
        } else if (source.startsWith('.')) {
          const target = this.resolveRelative(path, source);
          if (target) {
            const star = this.exportsOf(target, active);
            const asTypes = (found: Target): Target => (found.kind === 'declaration' ? { ...found, typeOnly: true } : found);
            stars.push(statement.exportKind === 'type' ? new Map([...star].map(([name, found]) => [name, asTypes(found)])) : star);
          }
        } else {
          const type = statement.exportKind === 'type' ? 'type ' : '';
          table.set(`* from ${source}`, { kind: 'external', specifier: source, name: `* from ${source}`, text: `export ${type}* from '${source}';` });
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        const declaration = statement.declaration as Node;
        if (declaration.type === 'Identifier') table.set('default', { kind: 'declaration', file: path, local: declaration.name });
        else table.set('default', { kind: 'declaration', file: path, local: declaration.id?.name ?? 'default' });
      }
    }
    for (const star of stars) {
      for (const [name, target] of star) if (name !== 'default' && !table.has(name)) table.set(name, target);
    }
    active.delete(path);
    this.#exports.set(path, table);
    return table;
  }
}

function declaredNames(declaration: Node): string[] {
  if (declaration.type === 'VariableDeclaration') return (declaration.declarations as Node[]).map((declarator) => declarator.id.name);
  if (declaration.type === 'TSModuleDeclaration' && declaration.id.type !== 'Identifier') return [];
  return declaration.id ? [declaration.id.name] : [];
}

function readDts(path: string, text: string, program: Node, comments: readonly Comment[]): DtsFile {
  const declarations = new Map<string, Statement[]>();
  const imports = new Map<string, Import>();
  const body = program.body as Node[];
  for (const wrapper of body) {
    if (wrapper.type === 'ImportDeclaration') {
      const source = stringOf(wrapper.source)!;
      for (const specifier of wrapper.specifiers as Node[]) {
        imports.set(specifier.local.name, {
          source,
          imported:
            specifier.type === 'ImportNamespaceSpecifier' ? undefined : specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported),
          typeOnly: wrapper.importKind === 'type' || specifier.importKind === 'type',
        });
      }
      continue;
    }
    const node: Node | undefined =
      (wrapper.type === 'ExportNamedDeclaration' || wrapper.type === 'ExportDefaultDeclaration') && wrapper.declaration
        ? (wrapper.declaration as Node)
        : wrapper;
    if (!DECLARATION_TYPES.has(node.type)) continue;
    const names = node.type === 'VariableDeclaration' || node.id ? declaredNames(node) : wrapper.type === 'ExportDefaultDeclaration' ? ['default'] : [];
    for (const name of names) declarations.set(name, [...(declarations.get(name) ?? []), { wrapper, node }]);
  }
  return { path, text, comments: [...comments].sort((a, b) => a.start - b.start), body, declarations, imports };
}

/** The doc comment that ends right before `node` (only whitespace between them). */
function commentBefore(file: DtsFile, node: Node): Comment | undefined {
  let found: Comment | undefined;
  for (const comment of file.comments) {
    if (comment.end > node.start) break;
    found = comment;
  }
  return found && file.text.slice(found.end, node.start).trim() === '' ? found : undefined;
}

/** The members under `node` that carry `@internal` — they are not part of the public declaration. */
function internalMembers(file: DtsFile, node: Node, out: Node[] = []): Node[] {
  if (MEMBER_TYPES.has(node.type) && hasTag(commentBefore(file, node), 'internal')) {
    out.push(node);
    return out;
  }
  for (const child of children(node)) internalMembers(file, child, out);
  return out;
}

/** What a member is called in the item `<Declaration>.<member>`. */
function memberName(file: DtsFile, member: Node): string {
  if (member.key) return member.computed ? `[${file.text.slice(member.key.start, member.key.end)}]` : nameOf(member.key);
  if (member.type === 'TSIndexSignature') return '[index]';
  return member.type === 'TSConstructSignatureDeclaration' ? 'new' : '()';
}

interface ExperimentalMember {
  readonly node: Node;
  /** The names from the declaration down to the member (`['pages']`, or `['server', 'port']` for a member of an object type). */
  readonly path: readonly string[];
}

/** The members under `node` that carry `@experimental` (not those inside one): the snapshot lists each as an item of its own. */
function experimentalMembers(file: DtsFile, node: Node, path: readonly string[] = [], out: ExperimentalMember[] = []): ExperimentalMember[] {
  for (const child of children(node)) {
    if (!MEMBER_TYPES.has(child.type)) {
      experimentalMembers(file, child, path, out);
    } else if (hasTag(commentBefore(file, child), 'internal')) {
      continue;
    } else if (hasTag(commentBefore(file, child), 'experimental')) {
      out.push({ node: child, path: [...path, memberName(file, child)] });
    } else {
      experimentalMembers(file, child, [...path, memberName(file, child)], out);
    }
  }
  return out;
}

/**
 * The text of a statement as emitted, without comments, without the members marked `@internal` and (unless `whole`) the ones
 * marked `@experimental`, and without blank lines.
 */
function declarationText(file: DtsFile, statement: Statement, whole = false): string {
  const { start, end } = statement.wrapper;
  const cuts: [number, number][] = file.comments.filter((comment) => comment.start >= start && comment.end <= end).map((comment) => [comment.start, comment.end]);
  for (const member of internalMembers(file, statement.node)) cuts.push([member.start, member.end]);
  if (!whole) for (const { node } of experimentalMembers(file, statement.node)) cuts.push([node.start, node.end]);
  // A cut inside another one (a comment in a removed member) is already gone with it.
  cuts.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const outer = cuts.filter(([from, to], index) => !cuts.slice(0, index).some(([earlier, until]) => earlier <= from && to <= until));
  let text = file.text.slice(start, end);
  for (const [from, to] of outer.reverse()) {
    if (from >= start && to <= end) text = text.slice(0, from - start) + text.slice(to - start);
  }
  // A statement inside `declare module { … }` is indented: take that off its continuation lines.
  const lineStart = file.text.lastIndexOf('\n', start - 1) + 1;
  const indent = file.text.slice(lineStart, start).trim() === '' ? start - lineStart : 0;
  return text
    .split('\n')
    .map((line, index) => (index > 0 ? line.replace(new RegExp(`^ {0,${indent}}`), '') : line).trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

interface Reference {
  /** The file whose scope resolves the name. */
  readonly file: DtsFile;
  /** A dotted name as written: `ns.T` is `['ns', 'T']`. */
  readonly path?: readonly string[];
  /** An `import('…')` type: the module and the dotted name it takes from it. */
  readonly importType?: { readonly source: string; readonly path: readonly string[] };
  /** The members from the declaration down to where the name stands (`['constructor']`); none at the top. */
  readonly member: readonly string[];
}

/**
 * The names a declaration uses as types (or as a base class), without type parameters and members marked `@internal` — and,
 * with `stableOnly`, without the members marked `@experimental`.
 */
function referencesOf(file: DtsFile, statement: Statement, stableOnly = false): Reference[] {
  const hidden = new Set(internalMembers(file, statement.node));
  if (stableOnly) for (const { node } of experimentalMembers(file, statement.node)) hidden.add(node);
  const shadow = new Set<string>();
  const collectShadow = (node: Node) => {
    if (node.type === 'TSTypeParameter') shadow.add(nameOf(node.name));
    if (node.type === 'TSMappedType' && node.key) shadow.add(nameOf(node.key));
    for (const child of children(node)) collectShadow(child);
  };
  collectShadow(statement.node);

  const out: Reference[] = [];
  let member: readonly string[] = [];
  const named = (path: string[]) => {
    if (path.length > 0 && !shadow.has(path[0]!)) out.push({ file, path, member });
  };
  const walk = (node: Node) => {
    if (hidden.has(node)) return;
    const outer = member;
    if (MEMBER_TYPES.has(node.type)) member = [...member, memberName(file, node)];
    switch (node.type) {
      case 'TSTypeReference':
        named(pathOf(node.typeName));
        break;
      case 'TSTypeQuery':
        if (node.exprName.type !== 'TSImportType') named(pathOf(node.exprName));
        break;
      case 'TSImportType':
        out.push({ file, importType: { source: stringOf(node.source) ?? '', path: pathOf(node.qualifier) }, member });
        break;
      case 'ClassDeclaration':
        named(pathOf(node.superClass));
        break;
      case 'TSClassImplements':
      case 'TSInterfaceHeritage':
        named(pathOf(node.expression));
        break;
      default:
        if (MEMBER_TYPES.has(node.type) && node.computed) named(pathOf(node.key));
    }
    for (const child of children(node)) walk(child);
    member = outer;
  };
  walk(statement.node);
  return out;
}

/** The export a dotted name stands for in a module of the package, through nested `export * as` namespaces. */
function lookupIn(declarations: Declarations, modulePath: string, names: readonly string[]): Target | undefined {
  const found = names.length > 0 ? declarations.exportsOf(modulePath).get(names[0]!) : undefined;
  return found?.kind === 'namespace' ? lookupIn(declarations, found.file, names.slice(1)) : found;
}

/** What a name that a declaration uses stands for — in the package, or in another one. */
function resolveReference(declarations: Declarations, reference: Reference): Resolved | undefined {
  const origin = originOf(reference);
  if (origin?.kind !== 'import') return origin;
  if (!origin.source.startsWith('.')) return { kind: 'foreign', specifier: origin.source, names: origin.names };
  const target = declarations.resolveRelative(origin.from, origin.source);
  if (!target) return undefined;
  return origin.names.length === 0 ? { kind: 'module', source: origin.source } : lookupIn(declarations, target, origin.names);
}

/** Where a name that a declaration uses comes from: a declaration of its own file, or a module and the dotted name it takes from it. */
function originOf(
  reference: Reference,
): { readonly kind: 'declaration'; readonly file: string; readonly local: string } | { readonly kind: 'import'; readonly from: string; readonly source: string; readonly names: readonly string[] } | undefined {
  const { file } = reference;
  if (reference.importType) return { kind: 'import', from: file.path, source: reference.importType.source, names: reference.importType.path };
  const [name, ...rest] = reference.path!;
  if (file.declarations.has(name!)) return { kind: 'declaration', file: file.path, local: name! };
  const imported = file.imports.get(name!);
  return imported ? { kind: 'import', from: file.path, source: imported.source, names: imported.imported === undefined ? rest : [imported.imported, ...rest] } : undefined;
}

/** The statements an export of the package stands for, without those marked `@internal`; `experimental` when one is marked so. */
function exportedStatements(declarations: Declarations, target: { readonly file: string; readonly local: string }) {
  const file = declarations.file(target.file);
  if (!file) return undefined;
  const shown = (file.declarations.get(target.local) ?? []).filter((statement) => !hasTag(commentBefore(file, statement.wrapper), 'internal'));
  if (shown.length === 0) return undefined;
  return { file, shown, experimental: shown.some((statement) => hasTag(commentBefore(file, statement.wrapper), 'experimental')) };
}

/** The `.d.ts` files a file reaches through its relative imports and re-exports, itself included. */
function reachedFiles(declarations: Declarations, path: string, reached = new Set<string>()): Set<string> {
  if (reached.has(path)) return reached;
  reached.add(path);
  for (const statement of declarations.file(path)?.body ?? []) {
    const source = statement.type === 'ImportDeclaration' || statement.type === 'ExportAllDeclaration' || (statement.type === 'ExportNamedDeclaration' && statement.source)
      ? stringOf(statement.source)
      : undefined;
    if (source?.startsWith('.')) {
      const target = declarations.resolveRelative(path, source);
      if (target) reachedFiles(declarations, target, reached);
    }
  }
  return reached;
}

/** The declarations inside the `declare module '…'` and `declare global` blocks of a file. */
function* augmentationsOf(file: DtsFile): Generator<{ module: string; local: string; statement: Statement }> {
  for (const module of file.body.filter((statement) => statement.type === 'TSModuleDeclaration' && (statement.kind === 'global' || statement.id.type === 'Literal'))) {
    const moduleName = module.kind === 'global' ? 'global' : String(module.id.value);
    for (const member of (module.body?.body ?? []) as Node[]) {
      const node = member.type === 'ExportNamedDeclaration' && member.declaration ? (member.declaration as Node) : member;
      for (const local of DECLARATION_TYPES.has(node.type) ? declaredNames(node) : []) yield { module: moduleName, local, statement: { wrapper: member, node } };
    }
  }
}

interface Collected {
  readonly items: ApiItem[];
  /** The packages whose types the declarations of the entry name. */
  readonly foreign: Set<string>;
}

/** The snapshot items of one entry point. */
function collectEntry(declarations: Declarations, entry: string, path: string, claimed: Set<string>, base: string): Collected {
  const items: ApiItem[] = [];
  const foreign = new Set<string>();
  const publicKeys = new Set<string>();
  const queue: { file: DtsFile; local: string }[] = [];
  const referenced = new Map<string, string>();
  const referencedNames = new Set<string>();
  const memberItems = new Set<string>();

  /** A public declaration names `name` from `specifier`: a library's types, or a package's `./internal`, which no snapshot holds. */
  const note = (specifier: string, name: string) => {
    const library = foreignPackage(specifier);
    if (library !== undefined) foreign.add(library);
    if (/^(?:@marmeon\/[^/]+|marmeon)\/internal(?:\/|$)/.test(specifier)) {
      declarations.problems.push(`${entry} names ${name} from ${specifier}, whose shape no snapshot holds: keep ${name} public, or stop naming it`);
    }
  };
  const follow = (reference: Reference) => {
    const target = resolveReference(declarations, reference);
    if (target?.kind === 'module') {
      declarations.problems.push(`${entry} names a whole module of the package (${target.source}): the snapshot cannot list its members — name the types it needs`);
    } else if (target?.kind === 'foreign') {
      note(target.specifier, target.names[0] ?? target.specifier);
    } else if (target) {
      enqueue(target);
    }
  };
  const enqueue = (target: Target) => {
    if (target.kind === 'namespace') return;
    if (target.kind === 'external') return note(target.specifier, target.name);
    const file = declarations.file(target.file);
    if (!file) return;
    const key = `${target.file}\0${target.local}`;
    if (publicKeys.has(key) || referenced.has(key)) return;
    referenced.set(key, '');
    queue.push({ file, local: target.local });
  };

  // The declarations the entry exports.
  const exported = [...declarations.exportsOf(path)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const pending: Reference[] = [];
  for (const [name, target] of exported) {
    if (target.kind === 'external') {
      note(target.specifier, target.name);
      items.push({ entry, section: 'stable', name, text: target.text });
      continue;
    }
    if (target.kind === 'namespace') {
      declarations.problems.push(`${entry} exports ${name}, a module of the package: the snapshot cannot list its members — export them one by one`);
      continue;
    }
    const statements = exportedStatements(declarations, target);
    if (!statements) continue;
    const { file, shown, experimental } = statements;
    publicKeys.add(`${target.file}\0${target.local}`);
    const text = shown
      .map((statement) => {
        const deprecated = hasTag(commentBefore(file, statement.wrapper), 'deprecated');
        // A class, function, constant or enum exported with `export type` is no value for an app: the line shows the switch.
        const typeOnly = target.typeOnly === true && VALUE_DECLARATIONS.has(statement.node.type);
        return `${typeOnly ? '// type-only\n' : ''}${deprecated ? '// @deprecated\n' : ''}${declarationText(file, statement)}`;
      })
      .join('\n');
    items.push({ entry, section: experimental ? 'experimental' : 'stable', name, text });
    for (const statement of shown) {
      pending.push(...referencesOf(file, statement));
      for (const member of experimentalMembers(file, statement.node)) {
        const memberText = declarationText(file, { wrapper: member.node, node: member.node }, true);
        // Several call signatures, or merged interfaces, can share a name: number them like referenced names.
        let memberItem = `${name}.${member.path.join('.')}`;
        for (let count = 2; memberItems.has(memberItem); count++) memberItem = `${name}.${member.path.join('.')} (${count})`;
        memberItems.add(memberItem);
        items.push({ entry, section: 'experimental', name: memberItem, text: memberText });
      }
    }
  }

  // The augmentations of the files the entry reaches (the first entry to reach a file owns it).
  const augmentNames = new Set<string>();
  for (const filePath of [...reachedFiles(declarations, path)].sort()) {
    if (claimed.has(filePath)) continue;
    claimed.add(filePath);
    const file = declarations.file(filePath);
    if (!file) continue;
    for (const { module, local, statement } of augmentationsOf(file)) {
      let name = `${module}.${local}`;
      for (let count = 2; augmentNames.has(name); count++) name = `${module}.${local} (${count})`;
      augmentNames.add(name);
      items.push({ entry, section: 'augments', name, text: declarationText(file, statement, true) });
      pending.push(...referencesOf(file, statement));
    }
  }

  for (const reference of pending) follow(reference);
  for (let index = 0; index < queue.length; index++) {
    const { file, local } = queue[index]!;
    for (const statement of file.declarations.get(local) ?? []) for (const reference of referencesOf(file, statement)) follow(reference);
  }
  // Same names from different files are numbered by the file's path, not by the order they were found in: a new reference
  // elsewhere must not swap two of them.
  const where = (file: DtsFile) => relative(base, file.path).split('\\').join('/');
  queue.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : where(a.file) < where(b.file) ? -1 : 1));
  for (const { file, local } of queue) {
    let name = local;
    for (let count = 2; referencedNames.has(name); count++) name = `${local} (${count})`;
    referencedNames.add(name);
    const statements = file.declarations.get(local) ?? [];
    items.push({ entry, section: 'referenced', name, text: statements.map((statement) => declarationText(file, statement, true)).join('\n') });
  }
  return { items, foreign };
}

/** Where `EnvSchema` hands out its variables (`packages/core/src/config/env.ts`). */
const ENV_FIELDS = Symbol.for('marmeon.env.fields');
/** Where it hands out its retired names (old to new). */
const ENV_RENAMED = Symbol.for('marmeon.env.renamed');

interface EnvField {
  readonly '~env': (raw: string | undefined, name: string) => { readonly value?: unknown; readonly problem?: string };
}
interface CommandShape {
  readonly command: string;
  readonly usage?: string;
  readonly experimental?: boolean;
  readonly options?: Readonly<Record<string, { readonly type?: string; readonly short?: string; readonly multiple?: boolean }>>;
}

/** Whether the variable reads `true` and `false` as a switch (`env.boolean()`) and nothing else. */
function readsSwitch(name: string, field: EnvField): boolean {
  const reads = (raw: string) => field['~env'](raw, name);
  return reads('true').value === true && reads('false').value === false && reads('maybe').problem !== undefined;
}

/** Whether `true` and `false` come out as those words and anything else is refused (`env.in(['true', 'false'])`): a switch read as text. */
function readsSwitchAsText(name: string, field: EnvField): boolean {
  const reads = (raw: string) => field['~env'](raw, name);
  return reads('true').value === 'true' && reads('false').value === 'false' && reads('maybe').problem !== undefined;
}

/**
 * What a missing variable is: its default as JSON, `required` or `optional`. A switch with no default says so (`optional (boolean)`),
 * since its type is not visible otherwise.
 */
function defaultOf(name: string, field: EnvField): string {
  const read = field['~env'](undefined, name);
  if (read.problem !== undefined) return readsSwitch(name, field) ? '— required (boolean)' : '— required';
  if (read.value !== undefined) return `= \`${JSON.stringify(read.value)}\``;
  return readsSwitch(name, field) ? '— optional (boolean)' : '— optional';
}

/** One `--option (type)` line per option, sorted. The description is no part of it: its wording is no API. */
function commandItem(Command: CommandShape): ApiItem {
  const options = Object.entries(Command.options ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, option]) => {
      const more = [option.type ?? 'boolean', ...(option.short ? [`short ${option.short}`] : []), ...(option.multiple ? ['multiple'] : [])];
      return `--${name} (${more.join(', ')})`;
    });
  const head = `marmeon ${Command.command}${Command.usage ? ` ${Command.usage}` : ''}`;
  return { entry: '', section: Command.experimental === true ? 'experimental' : 'commands', name: Command.command, text: [head, ...options].join('\n') };
}

/**
 * The environment variables and commands of a package, read from its built code: the providers its manifest lists
 * (`marmeon.providers`) with their `static config` and `static commands`, every other config or provider a public entry point
 * exports, and the CLI's built-in commands. Nothing boots —
 * the modules are only imported, with `NODE_ENV=test`.
 */
export async function runtimeItems(pkg: PackageToSnapshot): Promise<{ items: ApiItem[]; problems: string[] }> {
  const items: ApiItem[] = [];
  const problems: string[] = [];
  const names = ((pkg.manifest.marmeon as { providers?: string[] } | undefined)?.providers ?? []) as string[];
  const isCli = pkg.name === 'marmeon';
  const exportsField = (pkg.manifest.exports ?? {}) as Record<string, { default?: unknown } | string | undefined>;
  const main = ((exportsField['.'] as { default?: string } | undefined)?.default ?? './dist/index.js');
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  try {
    // Only a module that cannot be imported hints at a missing build; any other failure names its provider or config below.
    const load = async (file: string): Promise<Record<string, any> | undefined> => {
      try {
        return await import(pathToFileURL(join(pkg.dir, file)).href);
      } catch (error) {
        problems.push(`${pkg.name}: cannot import ${file} to read its environment variables and commands (${(error as Error).message}) — run pnpm build first`);
        return undefined;
      }
    };
    const module = names.length > 0 ? await load(main) : {};
    if (module === undefined) return { items, problems };
    const commands: CommandShape[] = [];
    const variables = new Map<string, { config: string; value: string }[]>();
    const renamed = new Map<string, string>();
    const seen = new Set<object>();
    interface ConfigShape {
      readonly name: string;
      readonly env: Record<symbol, Record<string, EnvField> | undefined>;
    }
    const readConfig = (config: ConfigShape, via: string): void => {
      if (seen.has(config)) return;
      seen.add(config);
      const fields = typeof config.env === 'object' && config.env !== null ? config.env[ENV_FIELDS] : undefined;
      if (fields === undefined) {
        problems.push(`${pkg.name}: the env of the config ${config.name} is not made by env({ … }) — the snapshot cannot read its variables`);
        return;
      }
      try {
        const locks = (config.env as unknown as Record<symbol, Record<string, string> | undefined>)[ENV_RENAMED] ?? {};
        for (const [from, to] of Object.entries(locks)) {
          const other = renamed.get(from);
          if (other !== undefined && other !== to) problems.push(`${pkg.name}: ${from} is retired for ${other} by one config and for ${to} by the config ${config.name} — one name cannot lead to two`);
          renamed.set(from, other ?? to);
        }
        for (const [variable, field] of Object.entries(fields)) {
          if (readsSwitchAsText(variable, field)) problems.push(`${pkg.name}: ${variable} (config ${config.name}) is a switch read as text — read it with env.boolean()`);
          variables.set(variable, [...(variables.get(variable) ?? []), { config: config.name, value: defaultOf(variable, field) }]);
        }
      } catch (error) {
        problems.push(`${pkg.name}: reading the variables of the config ${config.name} (${via}) failed: ${(error as Error).message}`);
      }
    };
    for (const name of names) {
      const Provider = module[name] as { config?: readonly ConfigShape[]; commands?: readonly CommandShape[] } | undefined;
      if (Provider === undefined) {
        problems.push(`${pkg.name} lists the provider ${name}, but its entry point does not export it`);
        continue;
      }
      for (const config of Provider.config ?? []) readConfig(config, `provider ${name}`);
      commands.push(...(Provider.commands ?? []));
    }
    // A config no listed provider brings (an opt-in provider's, or one the app reads itself) is part of the surface too: every
    // config and every provider's `static config` that a public entry point exports.
    const entries = new Set<string>([main]);
    for (const [subpath, target] of Object.entries(exportsField)) {
      const file = typeof target === 'object' && target !== null ? target.default : undefined;
      if (subpath !== './internal' && typeof file === 'string') entries.add(file);
    }
    for (const file of entries) {
      // The main entry of a package with no provider may be types only (or none): nothing to read there, so not a missing build.
      if (file === main && names.length === 0 && !existsSync(join(pkg.dir, file))) continue;
      const exported = file === main && names.length > 0 ? module : await load(file);
      for (const [exportName, value] of Object.entries(exported ?? {})) {
        if (typeof value === 'function' && Array.isArray((value as { config?: unknown }).config)) {
          for (const config of (value as { config: ConfigShape[] }).config) {
            if (typeof config === 'object' && config !== null && typeof config.env === 'object' && config.env !== null) readConfig(config, `provider ${exportName}`);
          }
        } else if (typeof value === 'object' && value !== null && typeof (value as ConfigShape).env === 'object' && (value as ConfigShape).env !== null && (value as ConfigShape).env[ENV_FIELDS] !== undefined) {
          readConfig(value as ConfigShape, `export ${exportName}`);
        }
      }
    }
    for (const [from, to] of renamed) {
      if (variables.has(from)) problems.push(`${pkg.name}: ${from} is retired for ${to}, but a config reads ${from} as a variable — a retired name is never given out again`);
    }
    if (isCli) commands.push(...(((await load('dist/built-in.js'))?.BUILT_IN ?? []) as CommandShape[]));

    for (const [variable, definitions] of variables) {
      // One item per variable, so a second definition that reads it the same way changes nothing; differing ones name their definition.
      const values = [...new Set(definitions.map(({ value }) => value))];
      const text = values.length === 1 ? values[0]! : definitions.map(({ config, value }) => `${value} (${config})`).join('; ');
      items.push({ entry: '', section: 'environment', name: variable, text: `\`${variable}\` ${text}` });
    }
    for (const [from, to] of renamed) items.push({ entry: '', section: 'environment', name: from, text: `\`${from}\` → \`${to}\` (renamed)` });
    for (const Command of commands) items.push(commandItem(Command));
  } finally {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  }
  return { items, problems };
}

export interface PackageToSnapshot {
  /** `@marmeon/http`, or `marmeon`. */
  readonly name: string;
  readonly dir: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}

/**
 * What `marmeon.experimental` of a manifest marks: `true` for the whole package, or the entries (`@marmeon/x/y`) of the listed
 * subpaths. A subpath that is no entry point, or is `./internal`, is a problem.
 */
function experimentalScope(pkg: PackageToSnapshot, problems: string[]): true | ReadonlySet<string> | undefined {
  const value = (pkg.manifest.marmeon as { experimental?: unknown } | undefined)?.experimental;
  if (value === undefined || value === false) return undefined;
  if (value === true) return true;
  const exportsField = (pkg.manifest.exports ?? {}) as Record<string, unknown>;
  if (!Array.isArray(value) || value.some((subpath) => typeof subpath !== 'string')) {
    problems.push(`${pkg.name}: marmeon.experimental must be true or a list of subpaths of exports`);
    return undefined;
  }
  const entries = new Set<string>();
  for (const subpath of value as string[]) {
    if (subpath === './internal') problems.push(`${pkg.name}: marmeon.experimental lists ./internal, which no snapshot holds`);
    else if (!(subpath in exportsField)) problems.push(`${pkg.name}: marmeon.experimental lists ${subpath}, which is no subpath of exports`);
    else entries.add(subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`);
  }
  return entries;
}

/** The entry points of a package with types (every subpath of `exports` but `./internal`): their import specifier and `.d.ts`. */
function entryPoints(pkg: PackageToSnapshot): { entry: string; path: string }[] {
  const out: { entry: string; path: string }[] = [];
  for (const [subpath, conditions] of Object.entries((pkg.manifest.exports ?? {}) as Record<string, unknown>)) {
    if (subpath === './internal' || typeof conditions !== 'object' || conditions === null) continue;
    const types = (conditions as Record<string, unknown>).types;
    if (typeof types === 'string') out.push({ entry: subpath === '.' ? pkg.name : `${pkg.name}${subpath.slice(1)}`, path: join(pkg.dir, types) });
  }
  return out;
}

const REEXPORT_ADVICE = 're-export it from an experimental entry point, or stop re-exporting it';

/**
 * Stability is transitive: a stable item — a declaration of a stable entry point, without its `@experimental` members — must not
 * name a type that only experimental entry points export, or that is marked `@experimental`, since a minor release may change
 * that type and with it the stable signature. Names from other packages (`@marmeon/live/testing`) are followed to their
 * declaration; a helper type that no entry point exports is part of the shape of what names it, so the walk goes through it.
 * The augmentations a stable entry point reaches and its re-exports from other packages count as stable items too. The
 * problems by package name; `root` makes the paths in them relative.
 */
export function stabilityProblems(packages: readonly PackageToSnapshot[], root: string): Map<string, string[]> {
  interface Owner {
    readonly pkg: PackageToSnapshot;
    readonly declarations: Declarations;
    readonly path: string;
    readonly experimental: boolean;
  }
  interface Located {
    readonly declarations: Declarations;
    readonly file: string;
    readonly local: string;
  }
  type Hit = Located | { readonly entry: string } | undefined;
  const owners = new Map<string, Owner>();
  for (const pkg of packages) {
    const declarations = new Declarations();
    // Its problems are the snapshot's to report.
    const scope = experimentalScope(pkg, []);
    for (const { entry, path } of entryPoints(pkg)) owners.set(entry, { pkg, declarations, path, experimental: scope === true || scope?.has(entry) === true });
  }

  // Per declaration (`<file>\0<local>`): whether a stable entry point exports it, and the experimental ones that do.
  const exportedBy = new Map<string, { stable: boolean; experimental: string[] }>();
  for (const [entry, owner] of owners) {
    for (const target of owner.declarations.exportsOf(owner.path).values()) {
      if (target.kind !== 'declaration') continue;
      const statements = exportedStatements(owner.declarations, target);
      if (!statements) continue;
      const key = `${target.file}\0${target.local}`;
      const record = exportedBy.get(key) ?? { stable: false, experimental: [] };
      if (owner.experimental || statements.experimental) record.experimental.push(owner.experimental ? entry : `${entry} (@experimental)`);
      else record.stable = true;
      exportedBy.set(key, record);
    }
  }

  /**
   * What a dotted name stands for in an entry point of a package, through namespaces and re-exports between packages: a
   * declaration, a whole entry point (`export * as ns from '@marmeon/…'` with no name left), or nothing for a library or what
   * no entry point exports. `visited` holds each module and name once, so stars that export each other end.
   */
  const across = (specifier: string, names: readonly string[], visited: Set<string>): Hit => {
    const owner = owners.get(specifier);
    if (!owner) return undefined;
    return names.length === 0 ? { entry: specifier } : within(owner.declarations, owner.path, names, visited);
  };
  const within = (declarations: Declarations, modulePath: string, names: readonly string[], visited: Set<string>): Hit => {
    const key = `${modulePath}\0${names.join('.')}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const table = declarations.exportsOf(modulePath);
    const found = table.get(names[0]!);
    if (found?.kind === 'declaration') return { declarations, file: found.file, local: found.local };
    if (found?.kind === 'namespace') return names.length > 1 ? within(declarations, found.file, names.slice(1), visited) : undefined;
    if (found) return across(found.specifier, found.imported === undefined ? names.slice(1) : [found.imported, ...names.slice(1)], visited);
    // `export * from '@marmeon/…'` is kept under its own key: the name may come through it.
    for (const star of table.values()) {
      const hit = star.kind === 'external' && star.name === `* from ${star.specifier}` ? across(star.specifier, names, visited) : undefined;
      if (hit) return hit;
    }
    return undefined;
  };
  /** What a name in a declaration stands for, like `across`; a whole module of the package is the snapshot's to report. */
  const locate = (declarations: Declarations, reference: Reference): Hit => {
    const origin = originOf(reference);
    if (origin?.kind === 'declaration') return { declarations, file: origin.file, local: origin.local };
    if (!origin) return undefined;
    if (!origin.source.startsWith('.')) return across(origin.source, origin.names, new Set());
    const target = declarations.resolveRelative(origin.from, origin.source);
    return target && origin.names.length > 0 ? within(declarations, target, origin.names, new Set()) : undefined;
  };
  const where = (found: Located) => {
    const record = exportedBy.get(`${found.file}\0${found.local}`)!;
    return `which is experimental (exported by ${record.experimental.join(', ')}; declared in ${relative(root, found.file).split('\\').join('/')})`;
  };

  const problems = new Map<string, string[]>();
  const report = (owner: Owner, problem: string) => problems.set(owner.pkg.name, [...(problems.get(owner.pkg.name) ?? []), problem]);
  /** Reports the experimental types the stable part of `statement` names, and walks into the helper types no entry exports. */
  const check = (owner: Owner, item: string, declarations: Declarations, file: DtsFile, statement: Statement, seen: Set<string>, via: readonly string[] = [], origin?: string) => {
    for (const reference of referencesOf(file, statement, true)) {
      const found = locate(declarations, reference);
      if (!found) continue;
      const key = 'entry' in found ? found.entry : `${found.file}\0${found.local}`;
      // Once per member and type: each member that names it is a problem of its own, a cycle of helpers is not.
      const named = origin ?? [item, ...reference.member].join('.');
      if (seen.has(`${named}\0${key}`)) continue;
      seen.add(`${named}\0${key}`);
      if ('entry' in found) {
        if (owners.get(found.entry)!.experimental) report(owner, `${named} names the whole of ${found.entry}, which is experimental: name a stable type`);
        continue;
      }
      const record = exportedBy.get(key);
      if (record?.stable) continue;
      if (record) {
        const through = via.length === 0 ? '' : ` (through ${via.join(', ')})`;
        report(owner, `${named} names ${found.local}${through}, ${where(found)}: mark it @experimental, or name a stable type`);
        continue;
      }
      const helper = found.declarations.file(found.file);
      for (const inner of helper?.declarations.get(found.local) ?? []) check(owner, item, found.declarations, helper!, inner, seen, [...via, found.local], named);
    }
  };

  const reached = new Set<string>();
  for (const [entry, owner] of [...owners].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (owner.experimental) continue;
    for (const [name, target] of [...owner.declarations.exportsOf(owner.path)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (target.kind === 'external') {
        const found: Hit = target.imported === undefined ? { entry: target.specifier } : across(target.specifier, [target.imported], new Set());
        if (found && 'entry' in found) {
          if (owners.get(found.entry)?.experimental) report(owner, `${entry} › ${name} re-exports ${found.entry}, which is experimental: ${REEXPORT_ADVICE}`);
        } else if (found && exportedBy.get(`${found.file}\0${found.local}`)?.stable === false) {
          report(owner, `${entry} › ${name} re-exports ${found.local}, ${where(found)}: ${REEXPORT_ADVICE}`);
        }
        continue;
      }
      if (target.kind !== 'declaration') continue;
      const statements = exportedStatements(owner.declarations, target);
      if (!statements || statements.experimental) continue;
      const seen = new Set<string>();
      for (const statement of statements.shown) check(owner, `${entry} › ${name}`, owner.declarations, statements.file, statement, seen);
    }
    for (const filePath of [...reachedFiles(owner.declarations, owner.path)].sort()) {
      const file = reached.has(filePath) ? undefined : owner.declarations.file(filePath);
      reached.add(filePath);
      for (const { module, local, statement } of file ? augmentationsOf(file) : []) check(owner, `${entry} › ${module}.${local}`, owner.declarations, file!, statement, new Set());
    }
  }
  return problems;
}

export interface NameLists {
  /** Names exported as two declarations on purpose, each with its reason. */
  readonly sameValue: Readonly<Record<string, string>>;
}

const NAME_LISTS: NameLists = { sameValue: SAME_VALUE };

/**
 * One exported name stands for one declaration: two entry points of the framework (stable or experimental, not `./internal`,
 * not `@internal`) that export a name must export the same declaration, by re-export or with the same text. `lists` holds the
 * exceptions; one that does not collide any more is a problem.
 */
export function nameProblems(packages: readonly PackageToSnapshot[], lists: NameLists = NAME_LISTS): string[] {
  interface Site {
    readonly pkg: string;
    readonly where: string;
    readonly text: string;
  }
  const declared = new Map<string, Map<string, Site>>();
  for (const pkg of packages) {
    const declarations = new Declarations();
    for (const { path } of entryPoints(pkg)) {
      for (const [name, target] of declarations.exportsOf(path)) {
        if (target.kind !== 'declaration' || name === 'default') continue;
        const statements = exportedStatements(declarations, target);
        if (!statements) continue;
        const sites = declared.get(name) ?? new Map<string, Site>();
        const key = `${target.file}\0${target.local}`;
        if (!sites.has(key)) {
          const where = relative(pkg.dir, target.file).split('\\').join('/').replace(/^dist\//, 'src/').replace(/\.d\.ts$/, '.ts');
          sites.set(key, { pkg: pkg.name, where, text: statements.shown.map((statement) => declarationText(statements.file, statement, true)).join('\n') });
        }
        declared.set(name, sites);
      }
    }
  }
  const colliding = new Set<string>();
  const problems: string[] = [];
  for (const [name, sites] of [...declared].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    // The same text in two places is one declaration, like a helper type every package spells out.
    const distinct = new Map<string, Site>();
    for (const site of sites.values()) if (!distinct.has(site.text)) distinct.set(site.text, site);
    if (distinct.size < 2) continue;
    colliding.add(name);
    if (Object.hasOwn(lists.sameValue, name)) continue;
    const places = [...distinct.values()].map((site) => `${site.pkg} (${site.where})`);
    const list = places.length === 2 ? places.join(' and ') : `${places.slice(0, -1).join(', ')} and ${places.at(-1)}`;
    problems.push(`\`${name}\` is exported as ${distinct.size === 2 ? 'two' : distinct.size} declarations: ${list} — rename one (CONTRIBUTING › The API snapshot)`);
  }
  for (const name of Object.keys(lists.sameValue)) if (!colliding.has(name)) problems.push(`\`${name}\` is listed in SAME_VALUE but no longer collides — delete the line`);
  return problems;
}

/** The api.md of a package, or none when it has no entry point with types; plus the problems met on the way and what is experimental in it. */
export function snapshotPackage(
  pkg: PackageToSnapshot,
  allowedForeign: readonly string[],
  runtime: readonly ApiItem[] = [],
): { markdown?: string; problems: string[]; experimental: string[] } {
  const declarations = new Declarations();
  const problems: string[] = [];
  const scope = experimentalScope(pkg, problems);
  // A package that is experimental as a whole has experimental variables and commands too.
  const items: ApiItem[] = runtime.map((item) => (scope === true && item.section !== 'experimental' ? { ...item, section: 'experimental' } : item));
  const foreign = new Map<string, readonly string[]>();
  const claimed = new Set<string>();
  const used = new Set<string>();

  for (const { entry, path } of entryPoints(pkg)) {
    const collected = collectEntry(declarations, entry, path, claimed, pkg.dir);
    items.push(...collected.items.map((item) => (scope === true || scope?.has(entry) ? (item.section === 'stable' ? { ...item, section: 'experimental' as const } : item.section === 'referenced' ? { ...item, section: 'experimentalReferenced' as const } : item) : item)));
    foreign.set(entry, [...collected.foreign].sort());
    for (const name of [...collected.foreign].sort()) {
      used.add(name);
      if (!allowedForeign.includes(name)) {
        problems.push(`${entry} exposes types of ${name}: add own types, or list it with a reason in FOREIGN_TYPES`);
      }
    }
  }
  for (const name of allowedForeign.filter((candidate) => !used.has(candidate))) {
    problems.push(`FOREIGN_TYPES lists ${name} for ${pkg.name}, but no entry point names its types any more: delete the entry`);
  }
  problems.push(...new Set(declarations.problems));
  // What `docs/releases.md` must name: the package, the listed entries, and the commands marked on their own.
  const experimental =
    scope === true ? [pkg.name] : [...(scope ?? [])].sort().concat(runtime.filter((item) => item.section === 'experimental').map((item) => `marmeon ${item.name}`));
  return { markdown: foreign.size === 0 ? undefined : renderSnapshot(pkg.name, items, foreign), problems, experimental };
}

const NAMES_SHOWN = 10;

function describeChanges(changes: ApiChanges): string[] {
  const lines: string[] = [];
  const list = (what: string, items: readonly ApiItem[]) => {
    if (items.length === 0) return;
    const names = items.slice(0, NAMES_SHOWN).map((item) => item.name);
    lines.push(`    ${what}: ${names.join(', ')}${items.length > NAMES_SHOWN ? `, … (${items.length - NAMES_SHOWN} more)` : ''}`);
  };
  list('removed', changes.removed);
  list('changed', changes.changed.map(({ after }) => after));
  list('added', changes.added);
  return lines;
}

const RELEASES = 'docs/releases.md';

/** The inline code in the list items under `### Experimental` in `docs/releases.md`, or `undefined` when there is no such heading. */
function documentedExperimental(root: string): Set<string> | undefined {
  const file = join(root, RELEASES);
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.indexOf('### Experimental');
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^#{1,3} /.test(line));
  const names = new Set<string>();
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end).filter((entry) => /^[-*] /.test(entry))) for (const match of line.matchAll(/`([^`]+)`/g)) names.add(match[1]!);
  return names;
}

/** Every experimental entry point, package and command must be named in `docs/releases.md`, and every name there must exist. */
function experimentalProblems(root: string, sources: ReadonlySet<string>): string[] {
  const documented = documentedExperimental(root);
  if (documented === undefined && sources.size === 0 && !existsSync(join(root, RELEASES))) return [];
  if (documented === undefined) return [`${RELEASES} has no "### Experimental" section under "What is public API", but ${[...sources].sort().join(', ') || 'nothing'} is experimental`];
  return [
    ...[...sources].sort().filter((name) => !documented.has(name)).map((name) => `${RELEASES} does not name ${name} under "### Experimental", but a package marks it experimental`),
    ...[...documented].filter((name) => !sources.has(name)).map((name) => `${RELEASES} names ${name} under "### Experimental", but nothing marks it experimental`),
  ];
}

export interface ApiRun {
  readonly code: number;
  readonly lines: string[];
}

/** Compares (or, with `write`, rewrites) the `api.md` of every package under `root`. */
export async function runApi(root: string, options: { write?: boolean; allowed?: Readonly<Record<string, readonly string[]>>; names?: NameLists } = {}): Promise<ApiRun> {
  const allowed = options.allowed ?? FOREIGN_TYPES;
  const lines: string[] = [];
  let failed = false;
  const experimental = new Set<string>();
  const packages = frameworkPackages(root);
  const stability = stabilityProblems(packages, root);
  for (const pkg of packages) {
    const { items: runtime, problems: runtimeProblems } = await runtimeItems(pkg);
    const snapshot = snapshotPackage(pkg, allowed[pkg.short] ?? [], runtime);
    const markdown = snapshot.markdown;
    for (const name of snapshot.experimental) experimental.add(name);
    const problems = [...snapshot.problems, ...runtimeProblems, ...(stability.get(pkg.name) ?? [])];
    const file = join(pkg.dir, 'api.md');
    const shown = relative(root, file).split('\\').join('/');
    if (problems.length > 0) {
      failed = true;
      lines.push(`${pkg.name}:`, ...problems.map((problem) => `  ${problem}`));
      continue;
    }
    if (markdown === undefined) {
      // A package that lost its last entry point with types: its old snapshot would stay and stay green.
      if (!existsSync(file)) continue;
      if (options.write) {
        unlinkSync(file);
        lines.push(`removed ${shown}`);
      } else {
        failed = true;
        lines.push(`${pkg.name}: ${shown} is out of date — the package has no entry point with types any more`, `  run pnpm api:update and commit the removal of ${shown}`);
      }
      continue;
    }
    const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    if (current === markdown) continue;
    if (options.write) {
      writeFileSync(file, markdown);
      lines.push(`wrote ${shown}`);
      continue;
    }
    failed = true;
    lines.push(`${pkg.name}: ${shown} is ${current === undefined ? 'missing' : 'out of date'}`);
    if (current !== undefined) {
      const changes = describeChanges(compareSnapshots(parseSnapshot(current), parseSnapshot(markdown)));
      lines.push(...(changes.length > 0 ? changes : ['    the layout or the packages named under "Types from other packages" differ']));
    }
    lines.push(`  run pnpm api:update and commit ${shown}`);
  }
  const names = nameProblems(packages, options.names);
  if (names.length > 0) {
    failed = true;
    lines.push('names:', ...names.map((problem) => `  ${problem}`));
  }
  const docs = experimentalProblems(root, experimental);
  if (docs.length > 0) {
    failed = true;
    lines.push(`${RELEASES}:`, ...docs.map((problem) => `  ${problem}`));
  }
  if (!failed && !options.write) lines.push('api: every api.md matches the built declarations, environment variables and commands');
  return { code: failed ? 1 : 0, lines };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { write: { type: 'boolean', default: false } } });
  const root = fileURLToPath(new URL('..', import.meta.url));
  const run = await runApi(root, { write: values.write });
  for (const line of run.lines) console.log(line);
  process.exit(run.code);
}
