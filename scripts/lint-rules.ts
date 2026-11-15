/**
 * The repository's own oxlint rules (`marmeon/…`), loaded through `jsPlugins` in `.oxlintrc.json`. They check for mistakes that
 * review would otherwise catch by hand; `scripts/lint.test.ts` proves they fire. Written against the ESLint rule API, which
 * oxlint's JS plugins implement. Nodes are untyped on purpose: the plugin has no dependency on a parser's types.
 */
/* oxlint-disable typescript/no-explicit-any -- ESTree nodes arrive untyped from the host */

type Node = any;
type Context = { report(descriptor: { node: Node; message: string }): void; sourceCode: { getScope(node: Node): any } };

/** The expression below type assertions, non-null assertions, parentheses and optional chains. */
const unwrap = (node: Node): Node => {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression')
  )
    current = current.expression;
  return current;
};

/** The name a member expression reads: `.name` or `['name']`. */
function propertyName(node: Node): string | undefined {
  if (node?.type !== 'MemberExpression') return undefined;
  if (!node.computed) return node.property.name;
  return node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : undefined;
}

const isMember = (node: Node, name: string) => propertyName(unwrap(node)) === name;

/** The initializer of a `const` an identifier refers to, followed up to a few times; anything else comes back unchanged. */
function resolver(context: Context) {
  return (node: Node): Node => {
    let current = unwrap(node);
    for (let step = 0; step < 5 && current?.type === 'Identifier'; step++) {
      let variable;
      for (let scope = context.sourceCode.getScope(current); scope && !variable; scope = scope.upper) variable = scope.set.get(current.name);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      const declarator = definition?.node;
      if (declarator?.type !== 'VariableDeclarator' || declarator.id.type !== 'Identifier' || !declarator.init || definition.parent?.kind !== 'const') break;
      current = unwrap(declarator.init);
    }
    return current;
  };
}

const children = (node: Node): Node[] =>
  Object.entries(node)
    .filter(([key]) => key !== 'parent' && key !== 'loc' && key !== 'range')
    .flatMap(([, child]) => (Array.isArray(child) ? child : [child]))
    .filter((child) => child && typeof child === 'object' && typeof child.type === 'string');

const isKey = (node: Node) => node.parent?.type === 'Property' && node.parent.key === node && !node.parent.computed;

/** `import.meta.dirname`, `.filename`, `.url`, or a call, template or sum built from one of them. */
function mentionsImportMeta(node: Node, resolve: (node: Node) => Node): boolean {
  const value = resolve(node);
  if (!value || typeof value !== 'object') return false;
  if (value.type === 'MetaProperty') return true;
  if (value.type === 'MemberExpression') return mentionsImportMeta(value.object, resolve);
  if (value.type === 'CallExpression' || value.type === 'NewExpression') return value.arguments.some((argument: Node) => mentionsImportMeta(argument, resolve)) || mentionsImportMeta(value.callee, resolve);
  if (value.type === 'TemplateLiteral') return value.expressions.some((expression: Node) => mentionsImportMeta(expression, resolve));
  if (value.type === 'BinaryExpression') return mentionsImportMeta(value.left, resolve) || mentionsImportMeta(value.right, resolve);
  return false;
}

const propertyNamed = (object: Node, name: string) =>
  object.properties.find((property: Node) => property.type === 'Property' && !property.computed && (property.key.name === name || property.key.value === name));

/** Walks `node` and the initializers of the constants it names; `visit` returns true to stop. */
function search(node: Node, resolve: (node: Node) => Node, visit: (node: Node) => boolean, seen = new Set<Node>()): boolean {
  const value = node?.type === 'Identifier' && !isKey(node) ? resolve(node) : node;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return visit(value) || children(value).some((child) => search(child, resolve, visit, seen));
}

/** Whether a string or template below `node` names a `__fixtures__` folder. */
const mentionsFixtures = (node: Node, resolve: (node: Node) => Node) =>
  search(node, resolve, (value) => (value.type === 'Literal' && typeof value.value === 'string' && value.value.includes('__fixtures__')) || (value.type === 'TemplateElement' && String(value.value?.raw).includes('__fixtures__')));

/** Whether a `migrations: …` property below `node` names a `__fixtures__` folder. */
const fixtureMigrations = (node: Node, resolve: (node: Node) => Node) =>
  search(node, resolve, (value) => value.type === 'Property' && !value.computed && (value.key.name === 'migrations' || value.key.value === 'migrations') && mentionsFixtures(value.value, resolve));

const fixtureAppRoot = {
  create(context: Context) {
    const resolve = resolver(context);
    return {
      CallExpression(node: Node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'createApplication') return;
        const definition = resolve(node.arguments[0]);
        if (definition?.type !== 'ObjectExpression') return;
        const root = propertyNamed(definition, 'root');
        if (!root || !mentionsImportMeta(root.value, resolve)) return;
        const modules = propertyNamed(definition, 'modules');
        if (!modules || !fixtureMigrations(modules.value, resolve)) return;
        context.report({
          node: root,
          message: "The root of an app with repository fixture modules comes from `workspaceTempDir('marmeon-…')`, not from the test file's folder (CONTRIBUTING › \"Before you open a pull request\").",
        });
      },
    };
  },
};

/** `await x.json()` / `await x.text()`, also inside `String(…)` or `JSON.stringify(…)` — a response body. */
function isBodyOfAnswer(node: Node): boolean {
  const value = unwrap(node);
  if (value?.type === 'CallExpression') {
    const callee = unwrap(value.callee);
    const wrapper = callee.type === 'Identifier' ? callee.name : callee.type === 'MemberExpression' && callee.object.type === 'Identifier' ? `${callee.object.name}.${propertyName(callee)}` : undefined;
    if (wrapper === 'String' || wrapper === 'JSON.stringify') return isBodyOfAnswer(value.arguments[0]);
  }
  if (value?.type === 'AwaitExpression') {
    const awaited = unwrap(value.argument);
    return awaited?.type === 'CallExpression' && (isMember(awaited.callee, 'json') || isMember(awaited.callee, 'text'));
  }
  return false;
}

const exactBodyAssertion = {
  create(context: Context) {
    const isExpect = (callee: Node) => (callee.type === 'Identifier' && callee.name === 'expect') || (callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'expect' && propertyName(callee) === 'soft');
    return {
      CallExpression(node: Node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || !['toContain', 'toMatch', 'toEqual'].includes(propertyName(callee) ?? '') || !isMember(callee.object, 'not')) return;
        const expectation = unwrap(callee.object.object);
        if (expectation.type !== 'CallExpression' || !isExpect(expectation.callee)) return;
        if (!isBodyOfAnswer(expectation.arguments[0])) return;
        context.report({ node, message: 'A negative assertion on a response body also passes for an error body: assert the exact expected answer.' });
      },
    };
  },
};

const identityByName = {
  create(context: Context) {
    const message = 'A class is told apart by `instanceof` or a brand, not by `constructor.name`: the name is minified, shadowed and forgeable.';
    const isConstructorName = (node: Node) => {
      const member = unwrap(node);
      return propertyName(member) === 'name' && propertyName(unwrap(member.object)) === 'constructor';
    };
    return {
      BinaryExpression(node: Node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        if (isConstructorName(node.left) || isConstructorName(node.right)) context.report({ node, message });
      },
      SwitchStatement(node: Node) {
        if (isConstructorName(node.discriminant)) context.report({ node, message });
      },
    };
  },
};

export default {
  meta: { name: 'marmeon' },
  rules: { 'fixture-app-root': fixtureAppRoot, 'exact-body-assertion': exactBodyAssertion, 'identity-by-name': identityByName },
};
