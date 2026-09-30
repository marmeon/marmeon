import { parseSync } from 'oxc-parser';

type Node = { type: string; start: number; end: number; [key: string]: any };

interface SiteBase {
  /** Class name, `default` for an anonymous default export, or `anonymous class`. */
  readonly className: string;
  /** Position among the module's classes (source order) — pairs TypeScript and compiled classes. */
  readonly classIndex: number;
  /** Offset of the class body's `{` — insertions go right after it, on the same line. */
  readonly bodyStart: number;
}

/**
 * A class with constructor parameters. Either its `static inject` list
 * can be derived, or it cannot — then the reason is attached to the class, and the
 * container reports it if (and only if) someone tries to resolve that class.
 */
export type InjectionSite =
  | (SiteBase & {
      /** Runtime expressions for each parameter, e.g. `UserRepository` or `mail.Mailer`. */
      readonly dependencies: readonly string[];
    })
  | (SiteBase & {
      /** Why the class cannot be built by the container. */
      readonly unresolvable: string;
    });

/** Static, symbol-keyed field carrying the reason a class has no injection list. */
export const UNRESOLVABLE = 'bespokecore.injection.unresolvable';

export class InjectionError extends Error {
  override name = 'InjectionError';
}

interface ModuleBindings {
  /** Names that exist at runtime: value imports, classes, functions, variables. */
  readonly values: Set<string>;
  /** Names imported with `import type` (or `import { type X }`). */
  readonly typeImports: Set<string>;
  /** Interfaces and type aliases declared in this module. */
  readonly localTypes: Set<string>;
}

/**
 * Finds the classes of a TypeScript module that take constructor parameters —
 * at any depth, so a class declared in a function (a middleware factory, a
 * test) is covered too — and resolves every parameter type to a runtime expression.
 * Types resolve against the module's imports and declarations.
 *
 * Never throws for a class: most classes (value objects, the router's own) are
 * never built by the container, so a parameter like `amount: number` is only a
 * problem once someone asks the container for that class.
 *
 * - Covered: `class X`, `export class X`, `export default class`, `const X = class`, `return class { … }`.
 * - A class declaring its own `static inject` is left alone (explicit override).
 * - Optional and defaulted parameters end the list, so their JavaScript defaults apply.
 */
export function analyzeInjections(source: string, filename: string): InjectionSite[] {
  if (!source.includes('constructor')) return [];

  const { program, errors } = parseSync(filename, source);
  if (errors.length > 0) return []; // let the runtime report syntax errors with its own diagnostics

  const bindings = collectBindings(program.body);
  const sites: InjectionSite[] = [];

  for (const { node, name, index } of classesOf(program)) {
    const members: Node[] = node.body.body;
    if (members.some((member) => member.static && member.key?.name === 'inject')) continue;

    const ctor = members.find((member) => member.kind === 'constructor');
    const allParams: Node[] = ctor?.value.params ?? [];
    const firstOptional = allParams.findIndex((param) => param.type === 'AssignmentPattern' || param.optional);
    const params = firstOptional === -1 ? allParams : allParams.slice(0, firstOptional);
    if (params.length === 0) continue;

    const context = { source, filename, className: name, bindings };
    try {
      const dependencies = params.map((param) => dependencyOf(param, context));
      sites.push({ className: name, classIndex: index, bodyStart: node.body.start, dependencies });
    } catch (error) {
      if (!(error instanceof InjectionError)) throw error;
      sites.push({ className: name, classIndex: index, bodyStart: node.body.start, unresolvable: error.message });
    }
  }

  return sites;
}

/**
 * Inserts `static inject = [...]` (or the unresolvable reason) into each site —
 * on the line of the class body's `{`, so line numbers never shift.
 */
export function insertInjections(source: string, sites: readonly InjectionSite[]): string {
  let output = source;
  for (const site of [...sites].sort((a, b) => b.bodyStart - a.bodyStart)) {
    const at = site.bodyStart + 1;
    const field =
      'dependencies' in site
        ? ` static inject = [${site.dependencies.join(', ')}];`
        : ` static [Symbol.for(${JSON.stringify(UNRESOLVABLE)})] = ${JSON.stringify(site.unresolvable)};`;
    output = `${output.slice(0, at)}${field}${output.slice(at)}`;
  }
  return output;
}

/** Source transform for app code: derive and insert the injection lists. */
export function injectConstructorDependencies(source: string, filename: string): string {
  const sites = analyzeInjections(source, filename);
  return sites.length === 0 ? source : insertInjections(source, sites);
}

// ---------------------------------------------------------------------------

/**
 * Every class of a module in source order, with a name for messages. `declare`
 * classes produce no JavaScript and are skipped, so the n-th class here is the
 * n-th class of the compiled output too (`bespoke package:build` pairs them).
 */
export function classesOf(program: Node): { node: Node; name: string; index: number }[] {
  const found: { node: Node; name: string }[] = [];
  const visit = (node: unknown, parent: Node | undefined): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent);
      return;
    }
    if (typeof node !== 'object' || node === null || typeof (node as Node).type !== 'string') return;
    const current = node as Node;
    if ((current.type === 'ClassDeclaration' || current.type === 'ClassExpression') && !current.declare) {
      found.push({ node: current, name: className(current, parent) });
    }
    for (const [key, value] of Object.entries(current)) {
      if (key !== 'type' && typeof value === 'object') visit(value, current);
    }
  };
  visit(program, undefined);
  return found.sort((a, b) => a.node.start - b.node.start).map((entry, index) => ({ ...entry, index }));
}

function className(node: Node, parent: Node | undefined): string {
  if (node.id?.name) return node.id.name;
  if (parent?.type === 'VariableDeclarator' && parent.id?.type === 'Identifier') return parent.id.name;
  if (parent?.type === 'ExportDefaultDeclaration') return 'default';
  return 'anonymous class';
}

function collectBindings(body: Node[]): ModuleBindings {
  const values = new Set<string>();
  const typeImports = new Set<string>();
  const localTypes = new Set<string>();

  for (const statement of body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        const typeOnly = statement.importKind === 'type' || specifier.importKind === 'type';
        (typeOnly ? typeImports : values).add(specifier.local.name);
      }
      continue;
    }

    const declaration =
      statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
        ? statement.declaration
        : statement;
    if (!declaration) continue;

    switch (declaration.type) {
      case 'ClassDeclaration':
      case 'FunctionDeclaration':
        if (declaration.id) values.add(declaration.id.name);
        break;
      case 'VariableDeclaration':
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === 'Identifier') values.add(declarator.id.name);
        }
        break;
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
        localTypes.add(declaration.id.name);
        break;
    }
  }

  return { values, typeImports, localTypes };
}

interface ParamContext {
  readonly source: string;
  readonly filename: string;
  readonly className: string;
  readonly bindings: ModuleBindings;
}

function dependencyOf(param: Node, context: ParamContext): string {
  const target = param;
  const where = () =>
    `${context.filename}:${lineOf(context.source, param.start)} — ${context.className}, parameter "${context.source.slice(param.start, param.end)}"`;

  if (target.type === 'RestElement') {
    throw new InjectionError(`Cannot inject ${where()}: rest parameters cannot be injected.`);
  }

  const type: Node | undefined = target.typeAnnotation?.typeAnnotation;
  if (!type) {
    throw new InjectionError(`Cannot inject ${where()}: add a type annotation naming a class or token.`);
  }
  if (type.type !== 'TSTypeReference') {
    throw new InjectionError(
      `Cannot inject ${where()}: only classes and tokens can be injected, not "${context.source.slice(type.start, type.end)}". ` +
        'Wrap primitives or unions in a token, or inject a config object.',
    );
  }

  // `Mailer` or `mail.Mailer` (namespace import). Type arguments (`Repository<User>`) are erased.
  const expression = context.source.slice(type.typeName.start, type.typeName.end);
  const root = expression.split('.')[0]!;
  const { values, typeImports, localTypes } = context.bindings;

  if (values.has(root)) return expression;
  if (typeImports.has(root)) {
    throw new InjectionError(
      `Cannot inject ${where()}: "${root}" is imported with "import type", so it does not exist at runtime. ` +
        `Import its token as a value: import { ${root} } from '…'.`,
    );
  }
  if (localTypes.has(root)) {
    throw new InjectionError(
      `Cannot inject ${where()}: "${root}" is only a type. Declare a token next to it: ` +
        `export const ${root} = token<${root}>('${root}');`,
    );
  }
  throw new InjectionError(`Cannot inject ${where()}: "${root}" is not imported or declared in this module.`);
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
