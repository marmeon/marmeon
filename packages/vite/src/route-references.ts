import { parseSync } from 'oxc-parser';

/**
 * A place where client code hands a route name to the framework — what the browser's route manifest is built from
 * (E57). Sinks are keyed by the package that exports them, so another UI adapter brings its own rows.
 *
 * - `element`: a JSX attribute, `<Link route="…">`.
 * - `call`: an argument of a function, `useForm('…', …)`. `minArguments`: calls with fewer arguments take no name
 *   (`useForm(initial)` types a form by controller instead).
 * - `route-function`: the function a hook returns, called with the name first: `const route = useRoute(); route('…')`.
 */
export type RouteSink =
  | { readonly module: string; readonly export: string; readonly kind: 'element'; readonly prop: string }
  | { readonly module: string; readonly export: string; readonly kind: 'call'; readonly argument: number; readonly minArguments?: number }
  | { readonly module: string; readonly export: string; readonly kind: 'route-function' };

const REACT = '@bespokecore/react';

/**
 * The sinks of the React adapter. Rows for APIs that do not exist yet (`<Island route>`, `<Link layer>`, `<Form route>`,
 * `useAction`, `usePending`) are here already, so they reach the manifest from their first day — and so does the
 * error for a name built at runtime.
 */
export const ROUTE_SINKS: readonly RouteSink[] = [
  { module: REACT, export: 'Link', kind: 'element', prop: 'route' },
  { module: REACT, export: 'Link', kind: 'element', prop: 'layer' },
  { module: REACT, export: 'Island', kind: 'element', prop: 'route' },
  { module: REACT, export: 'Form', kind: 'element', prop: 'route' },
  { module: REACT, export: 'useRoute', kind: 'route-function' },
  { module: REACT, export: 'useForm', kind: 'call', argument: 0, minArguments: 2 },
  { module: REACT, export: 'useAction', kind: 'call', argument: 0 },
  { module: REACT, export: 'usePending', kind: 'call', argument: 0 },
  { module: REACT, export: 'useQueryState', kind: 'call', argument: 0 },
];

/** A route name written out in client code. */
export interface RouteReference {
  readonly name: string;
  /** Offset of the expression that names it. */
  readonly start: number;
}

/** A route name the build cannot see: built at runtime, passed in from elsewhere, or hidden in a spread. */
export interface RouteReferenceProblem {
  readonly message: string;
  readonly start: number;
}

export interface CollectOptions {
  readonly sinks?: readonly RouteSink[];
  /** The route names of the app, for "did you mean" (the names the browser may learn). */
  readonly names?: readonly string[];
}

type Node = { type: string; start: number; end: number; [key: string]: any };

type Binding =
  | { readonly kind: 'import'; readonly module: string; readonly imported: string }
  | { readonly kind: 'namespace'; readonly module: string }
  | { readonly kind: 'const'; readonly init: Node | undefined; readonly scope: Scope }
  | { readonly kind: 'other' };

class Scope {
  readonly parent: Scope | undefined;
  readonly bindings = new Map<string, Binding>();

  constructor(parent?: Scope) {
    this.parent = parent;
  }

  lookup(name: string): Binding | undefined {
    for (let scope: Scope | undefined = this; scope; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  }
}

/** Keys that hold types or other things no route name flows through. */
const SKIPPED_KEYS = new Set(['typeAnnotation', 'typeParameters', 'typeArguments', 'returnType', 'superTypeArguments', 'decorators']);

/**
 * The route names a module hands to the framework, and the places where it hands one the build cannot know.
 *
 * Seen: string literals, template literals without expressions, both branches of a conditional, `as const` /
 * `satisfies` / parentheses, and `const` bindings of those — including an `as const` object or array indexed by a
 * variable (all its values). Imports are resolved by binding, so `import { Link as L }` and `import * as B` count.
 * Anything else — a template with expressions, a concatenation, a prop, a function parameter — is a problem with a
 * readable message: the browser's manifest would lack the name, and the page would throw in production.
 */
export function collectRouteReferences(code: string, filename: string, options: CollectOptions = {}): { references: RouteReference[]; problems: RouteReferenceProblem[] } {
  const sinks = options.sinks ?? ROUTE_SINKS;
  const references: RouteReference[] = [];
  const problems: RouteReferenceProblem[] = [];
  const modules = new Set(sinks.map((sink) => sink.module));
  if (![...modules].some((module) => code.includes(module))) return { references, problems };

  const { program, errors } = parseSync(filename, code);
  if (errors.length > 0) return { references, problems }; // Vite reports syntax errors itself

  const names = options.names ?? [];
  const sinkOf = (binding: Binding | undefined, member?: string): readonly RouteSink[] => {
    if (binding?.kind === 'import') return sinks.filter((sink) => sink.module === binding.module && sink.export === binding.imported);
    if (binding?.kind === 'namespace' && member) return sinks.filter((sink) => sink.module === binding.module && sink.export === member);
    return [];
  };
  /** The sinks a callee or element name refers to: `useForm`, `B.useForm`, `<Link>`, `<B.Link>`. */
  const sinksAt = (node: Node, scope: Scope): readonly RouteSink[] => {
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier') return sinkOf(scope.lookup(node.name));
    if ((node.type === 'MemberExpression' && !node.computed) || node.type === 'JSXMemberExpression') {
      const object = node.object as Node;
      const property = node.property as Node;
      if ((object.type === 'Identifier' || object.type === 'JSXIdentifier') && property.name) return sinkOf(scope.lookup(object.name), property.name);
    }
    return [];
  };
  /** Whether `node` evaluates to the function a `route-function` sink returns (`useRoute()`). */
  const isRouteFunctionCall = (node: Node | undefined, scope: Scope): boolean =>
    node?.type === 'CallExpression' && sinksAt(unwrap(node.callee), scope).some((sink) => sink.kind === 'route-function');
  const isRouteFunction = (callee: Node, scope: Scope): boolean => {
    const target = unwrap(callee);
    if (isRouteFunctionCall(target, scope)) return true;
    if (target.type !== 'Identifier') return false;
    const binding = scope.lookup(target.name);
    return binding?.kind === 'const' && isRouteFunctionCall(binding.init && unwrap(binding.init), binding.scope);
  };

  const check = (expression: Node, scope: Scope, sink: string): void => {
    const result = staticNames(expression, scope, 0);
    if (result) {
      for (const name of result) references.push({ name, start: expression.start });
      return;
    }
    problems.push({ message: dynamicMessage(code, expression, sink, names), start: expression.start });
  };

  const visitCall = (node: Node, scope: Scope): void => {
    const args = node.arguments as Node[];
    if (isRouteFunction(node.callee, scope)) {
      if (args[0] && args[0].type !== 'SpreadElement') check(args[0], scope, 'route()');
      else problems.push({ message: dynamicMessage(code, args[0] ?? node, 'route()', names), start: (args[0] ?? node).start });
      return;
    }
    for (const sink of sinksAt(unwrap(node.callee), scope)) {
      if (sink.kind !== 'call') continue;
      if (args.some((arg) => arg.type === 'SpreadElement')) {
        problems.push({ message: dynamicMessage(code, node, `${sink.export}()`, names), start: node.start });
        continue;
      }
      if (args.length < (sink.minArguments ?? sink.argument + 1)) continue;
      check(args[sink.argument]!, scope, `${sink.export}()`);
    }
  };

  const visitElement = (node: Node, scope: Scope): void => {
    const elementSinks = sinksAt(node.name, scope).filter((sink): sink is RouteSink & { kind: 'element' } => sink.kind === 'element');
    if (elementSinks.length === 0) return;
    const attributes = node.attributes as Node[];
    const element = elementSinks[0]!.export;
    const props = new Set(elementSinks.map((sink) => sink.prop));
    const lastSpread = attributes.findLastIndex((attribute) => attribute.type === 'JSXSpreadAttribute');
    if (lastSpread !== -1) {
      const explicit = attributes.slice(lastSpread + 1).some((attribute) => attribute.type === 'JSXAttribute' && (props.has(attribute.name.name) || attribute.name.name === 'href'));
      if (!explicit) {
        const spread = attributes[lastSpread]!;
        problems.push({
          message:
            `<${element} ${code.slice(spread.start, spread.end)}> may carry a route name the build cannot see, so the browser's route manifest would lack it. ` +
            `Write ${elementSinks[0]!.prop}="…" on the <${element}> itself (after the spread), or pass a URL as href.`,
          start: spread.start,
        });
      }
    }
    for (const attribute of attributes) {
      if (attribute.type !== 'JSXAttribute' || attribute.name.type !== 'JSXIdentifier' || !props.has(attribute.name.name)) continue;
      const value = attribute.value as Node | null;
      if (!value) continue;
      const expression = value.type === 'JSXExpressionContainer' ? (value.expression as Node) : value;
      if (expression.type === 'JSXEmptyExpression') continue;
      check(expression, scope, `<${element} ${attribute.name.name}>`);
    }
  };

  const visit = (node: unknown, scope: Scope): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope);
      return;
    }
    if (!node || typeof node !== 'object' || typeof (node as Node).type !== 'string') return;
    const current = node as Node;
    let inner = scope;
    switch (current.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression': {
        inner = new Scope(scope);
        if (current.type === 'FunctionExpression' && current.id) inner.bindings.set(current.id.name, { kind: 'other' });
        for (const param of current.params as Node[]) declarePattern(param, inner);
        if (current.body?.type === 'BlockStatement') {
          declareStatements(current.body.body, inner);
          visit(current.params, inner);
          visit(current.body.body, inner);
          return;
        }
        break;
      }
      case 'BlockStatement':
      case 'StaticBlock':
        inner = new Scope(scope);
        declareStatements(current.body, inner);
        break;
      case 'SwitchStatement':
        inner = new Scope(scope);
        declareStatements((current.cases as Node[]).flatMap((entry) => entry.consequent as Node[]), inner);
        break;
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        inner = new Scope(scope);
        const head = (current.init ?? current.left) as Node | null;
        if (head?.type === 'VariableDeclaration') declareStatements([head], inner);
        break;
      }
      case 'CatchClause':
        inner = new Scope(scope);
        if (current.param) declarePattern(current.param, inner);
        break;
      case 'CallExpression':
        visitCall(current, scope);
        break;
      case 'JSXOpeningElement':
        visitElement(current, scope);
        break;
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || SKIPPED_KEYS.has(key)) continue;
      const value = current[key];
      if (value && typeof value === 'object') visit(value, inner);
    }
  };

  const root = new Scope();
  declareStatements(program.body as Node[], root);
  visit(program.body, root);
  return { references, problems };
}

/** Declares what a statement list binds — hoisted for the whole block, as imports, functions, `let` and `const` are. */
function declareStatements(statements: readonly Node[], scope: Scope): void {
  for (const statement of statements) {
    const node = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' ? (statement.declaration as Node | null) : statement;
    if (!node) continue;
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue;
      const module = node.source.value as string;
      for (const specifier of node.specifiers as Node[]) {
        if (specifier.importKind === 'type') continue;
        const local = specifier.local.name as string;
        if (specifier.type === 'ImportNamespaceSpecifier') scope.bindings.set(local, { kind: 'namespace', module });
        else if (specifier.type === 'ImportDefaultSpecifier') scope.bindings.set(local, { kind: 'import', module, imported: 'default' });
        else scope.bindings.set(local, { kind: 'import', module, imported: (specifier.imported.name ?? specifier.imported.value) as string });
      }
    } else if (node.type === 'VariableDeclaration') {
      for (const declarator of node.declarations as Node[]) {
        if (node.kind === 'const' && declarator.id.type === 'Identifier') scope.bindings.set(declarator.id.name, { kind: 'const', init: declarator.init ?? undefined, scope });
        else declarePattern(declarator.id, scope);
      }
    } else if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration') && node.id) {
      scope.bindings.set(node.id.name, { kind: 'other' });
    }
  }
}

/** Every identifier a binding pattern declares (`{ a, b: [c] }`, defaults, rest). */
function declarePattern(pattern: Node | null | undefined, scope: Scope): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      scope.bindings.set(pattern.name, { kind: 'other' });
      break;
    case 'ObjectPattern':
      for (const property of pattern.properties as Node[]) declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope);
      break;
    case 'ArrayPattern':
      for (const element of pattern.elements as (Node | null)[]) declarePattern(element, scope);
      break;
    case 'AssignmentPattern':
      declarePattern(pattern.left, scope);
      break;
    case 'RestElement':
      declarePattern(pattern.argument, scope);
      break;
    case 'TSParameterProperty':
      declarePattern(pattern.parameter, scope);
      break;
  }
}

const WRAPPERS = new Set(['ParenthesizedExpression', 'TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);

function unwrap(node: Node): Node {
  let current = node;
  while (WRAPPERS.has(current.type)) current = current.expression as Node;
  return current;
}

/** The names an expression can evaluate to, if the build can know them all; otherwise `undefined`. */
function staticNames(node: Node, scope: Scope, depth: number): string[] | undefined {
  if (depth > 20) return undefined;
  const expression = unwrap(node);
  switch (expression.type) {
    case 'Literal':
      return typeof expression.value === 'string' ? [expression.value] : undefined;
    case 'TemplateLiteral':
      return expression.expressions.length === 0 ? [expression.quasis[0].value.cooked as string] : undefined;
    case 'ConditionalExpression': {
      const consequent = staticNames(expression.consequent, scope, depth + 1);
      const alternate = consequent && staticNames(expression.alternate, scope, depth + 1);
      return consequent && alternate ? [...consequent, ...alternate] : undefined;
    }
    case 'Identifier': {
      const binding = scope.lookup(expression.name);
      return binding?.kind === 'const' && binding.init ? staticNames(binding.init, binding.scope, depth + 1) : undefined;
    }
    case 'MemberExpression': {
      const values = constantMembers(expression.object, scope, depth + 1);
      if (!values) return undefined;
      const key = expression.computed ? staticNames(expression.property, scope, depth + 1) : [expression.property.name as string];
      // A key the build cannot know (`TABS[tab]`): any of the values — all of them are static.
      if (!key) return [...new Set(values.values())];
      const picked = key.map((name) => values.get(name));
      return picked.every((value): value is string => value !== undefined) ? picked : undefined;
    }
    default:
      return undefined;
  }
}

/** The string members of a `const` object or array literal (`{ edit: 'user-profile.edit' } as const`), all static. */
function constantMembers(node: Node, scope: Scope, depth: number): Map<string, string> | undefined {
  const target = unwrap(node);
  if (target.type !== 'Identifier' || depth > 20) return undefined;
  const binding = scope.lookup(target.name);
  if (binding?.kind !== 'const' || !binding.init) return undefined;
  const literal = unwrap(binding.init);
  const members = new Map<string, string>();
  if (literal.type === 'ObjectExpression') {
    for (const property of literal.properties as Node[]) {
      if (property.type !== 'Property' || property.kind !== 'init') return undefined;
      const key = property.computed ? staticNames(property.key, binding.scope, depth + 1)?.[0] : ((property.key.name ?? String(property.key.value)) as string);
      const value = staticNames(property.value, binding.scope, depth + 1);
      if (key === undefined || value?.length !== 1) return undefined;
      members.set(key, value[0]!);
    }
    return members;
  }
  if (literal.type === 'ArrayExpression') {
    for (const [index, element] of (literal.elements as (Node | null)[]).entries()) {
      const value = element && element.type !== 'SpreadElement' ? staticNames(element, binding.scope, depth + 1) : undefined;
      if (value?.length !== 1) return undefined;
      members.set(String(index), value[0]!);
    }
    return members;
  }
  return undefined;
}

// -- Messages ---------------------------------------------------------------------------------------------------

/** The literal start of a name built at runtime: `user-profile.` of `` `user-profile.${tab}` `` or `'user-profile.' + tab`. */
function prefixOf(node: Node): string {
  const expression = unwrap(node);
  if (expression.type === 'TemplateLiteral') return expression.quasis[0].value.cooked as string;
  if (expression.type === 'BinaryExpression' && expression.operator === '+') {
    const left = unwrap(expression.left);
    if (left.type === 'Literal' && typeof left.value === 'string') return left.value;
    return prefixOf(left);
  }
  return '';
}

/** Names starting with `prefix`, the closest first (no further dot), at most five. */
function suggestions(prefix: string, names: readonly string[]): string[] {
  if (!prefix) return [];
  const matching = names.filter((name) => name.startsWith(prefix) && name !== prefix);
  const near = matching.filter((name) => !name.slice(prefix.length).includes('.'));
  return (near.length > 0 ? near : matching).sort();
}

function dynamicMessage(code: string, node: Node, sink: string, names: readonly string[]): string {
  const source = code.slice(node.start, node.end).replace(/\s+/g, ' ');
  const shown = source.length > 60 ? `${source.slice(0, 57)}…` : source;
  const prefix = prefixOf(node);
  const near = suggestions(prefix, names);
  const listed = near.length > 5 ? `${near.slice(0, 5).join(', ')}, …` : near.join(', ');
  const lines = [
    `route names sent to the browser must be written out: ${shown} (${sink}) is ${prefix ? 'built at runtime' : 'not known at build time'}, ` +
      'so the build cannot tell which routes this page needs.',
  ];
  if (near.length === 1) {
    lines.push(`Did you mean ${near[0]}? Write it as a literal: '${near[0]}'.`);
  } else if (near.length > 1) {
    const expression = unwrap(node);
    const variable =
      expression.type === 'TemplateLiteral' && expression.expressions.length === 1 ? code.slice(expression.expressions[0].start, expression.expressions[0].end) : 'condition';
    const [first, second] = near as [string, string];
    const example =
      variable === 'condition' ? `condition ? '${first}' : '${second}'` : `${variable} === '${first.slice(prefix.length)}' ? '${first}' : '${second}'`;
    lines.push(`Did you mean one of ${listed}? Write them as literals, e.g. ${example}.`);
  } else {
    lines.push(
      "Write the name as a literal — a conditional of literals works too (isOwn ? 'a.edit' : 'a.show'). " +
        'A route that comes from props or the server: send its URL instead (router.url() on the server), not its name.',
    );
  }
  return lines.join(' ');
}
