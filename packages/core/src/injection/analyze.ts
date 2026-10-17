import { withCode, withoutCode } from '../error-codes.ts';
import { parseSync } from '../oxc.ts';

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
      /** Runtime expressions for each parameter, e.g. `UserRepository` or `mail.Mailer`. Empty when only warnings are attached. */
      readonly dependencies: readonly string[];
      /**
       * Defaulted or optional parameters of an injectable type: never injected — the default applies. The container
       * reports them once it builds the class (`Container.onWarning`); no error.
       */
      readonly warnings?: readonly string[];
    })
  | (SiteBase & {
      /** Why the class cannot be built by the container. */
      readonly unresolvable: string;
    });

/** Static, symbol-keyed field carrying the reason a class has no injection list. */
export const UNRESOLVABLE = 'marmeon.injection.unresolvable';

/** Static, symbol-keyed field carrying a class's injection warnings. */
export const WARNINGS = 'marmeon.injection.warnings';

export class InjectionError extends Error {
  override name = 'InjectionError';

  constructor(message: string) {
    super(withCode('K5', message));
  }
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
 * Finds the classes of a TypeScript module, at any depth, that take constructor parameters and resolves each parameter type
 * to a runtime expression (against the module's imports and declarations). Never throws for a class: a parameter that cannot
 * be injected is only a problem once the container is asked for that class. A class with its own `static inject` is left
 * alone; optional and defaulted parameters end the list, with a warning when their type could be injected
 * (docs/container.md#default-values-are-never-injected).
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
    const context = { source, filename, className: name, bindings };
    const warnings = firstOptional === -1 ? [] : allParams.slice(firstOptional).flatMap((param) => optionalWarning(param, context) ?? []);
    if (params.length === 0) {
      if (warnings.length > 0) sites.push({ className: name, classIndex: index, bodyStart: node.body.start, dependencies: [], warnings });
      continue;
    }

    try {
      const dependencies = params.map((param) => dependencyOf(param, context));
      sites.push({ className: name, classIndex: index, bodyStart: node.body.start, dependencies, ...(warnings.length > 0 ? { warnings } : {}) });
    } catch (error) {
      if (!(error instanceof InjectionError)) throw error;
      sites.push({ className: name, classIndex: index, bodyStart: node.body.start, unresolvable: withoutCode(error.message) });
    }
  }

  return sites;
}

/** What the transform adds to a module: a text at an offset of the TypeScript source (right after a class body's `{`). */
export type Insertion = readonly [offset: number, text: string];

/**
 * The text each site gets — `static inject = [...]` (or the unresolvable reason, the warnings) — at the offset of its class
 * body's `{`, so line numbers never shift. `marmeon build` keeps these per file (`.marmeon/injections.json`).
 */
export function insertionsOf(sites: readonly InjectionSite[]): Insertion[] {
  return sites.map((site) => {
    const field =
      'dependencies' in site
        ? (site.dependencies.length > 0 ? ` static inject = [${site.dependencies.join(', ')}];` : '') +
          (site.warnings?.length ? ` static [Symbol.for(${JSON.stringify(WARNINGS)})] = ${JSON.stringify(site.warnings)};` : '')
        : ` static [Symbol.for(${JSON.stringify(UNRESOLVABLE)})] = ${JSON.stringify(site.unresolvable)};`;
    return [site.bodyStart + 1, field] as const;
  });
}

/** Applies {@link insertionsOf}'s result — from the back, so earlier offsets stay valid. */
export function applyInsertions(source: string, insertions: readonly Insertion[]): string {
  let output = source;
  for (const [at, text] of [...insertions].sort((a, b) => b[0] - a[0])) {
    if (text !== '') output = `${output.slice(0, at)}${text}${output.slice(at)}`;
  }
  return output;
}

/**
 * Inserts `static inject = [...]` (or the unresolvable reason) into each site —
 * on the line of the class body's `{`, so line numbers never shift.
 */
export function insertInjections(source: string, sites: readonly InjectionSite[]): string {
  return applyInsertions(source, insertionsOf(sites));
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
 * n-th class of the compiled output too (`marmeon package:build` pairs them).
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

/**
 * The warning for a defaulted or optional parameter — when its type could be injected: a class or a token that exists
 * at runtime (a value import or a declaration of the module). `name = 'x'`, `options?: Options` (a type only) and the like
 * are what defaults are for: no warning.
 */
function optionalWarning(param: Node, context: ParamContext): string | undefined {
  const target: Node = param.type === 'AssignmentPattern' ? param.left : param;
  const type: Node | undefined = target.typeAnnotation?.typeAnnotation;
  if (type?.type !== 'TSTypeReference') return undefined;
  const expression = context.source.slice(type.typeName.start, type.typeName.end);
  // `parent?: Node` in `class Node` is a tree, not a dependency.
  if (!context.bindings.values.has(expression.split('.')[0]!) || expression === context.className) return undefined;
  const where = `${context.filename}:${lineOf(context.source, param.start)}`;
  const text = context.source.slice(param.start, param.end);
  const outcome = param.type === 'AssignmentPattern' ? 'its default is always used' : 'it stays undefined';
  return (
    `${context.className} (${where}): the parameter "${text}" is ${param.type === 'AssignmentPattern' ? 'defaulted' : 'optional'}, so the container never injects ${expression} — ` +
    `${outcome}, also when a provider or a test binds another ${expression}. Remove the ${param.type === 'AssignmentPattern' ? 'default' : '"?"'} to have it injected, ` +
    'or write `static inject = [...]` to make the choice explicit.'
  );
}

function lineOf(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}
