import { readFileSync, realpathSync } from 'node:fs';
import { matchesGlob, relative, sep } from 'node:path';
import { parseSync } from 'oxc-parser';
import type { Plugin, ResolvedConfig } from 'vite';

/** A kind of server module: a glob relative to the app root, and what to call such a module in an error. */
export interface ServerModule {
  readonly pattern: string;
  readonly what: string;
}

/**
 * The app's server modules by convention — what client code must never import as a value. Globs relative to the app root;
 * `marmeon({ serverModules })` adds patterns and, with a leading `!`, takes some out.
 */
export const SERVER_MODULES: readonly ServerModule[] = [
  { pattern: 'modules/*/controllers/**', what: 'a controller' },
  { pattern: 'modules/*/listeners/**', what: 'a listener' },
  { pattern: 'modules/*/jobs/**', what: 'a job' },
  { pattern: 'modules/*/mail/**', what: 'a mail' },
  { pattern: 'modules/*/notifications/**', what: 'a notification' },
  { pattern: 'modules/*/policies/**', what: 'a policy' },
  { pattern: 'modules/*/middleware/**', what: 'a middleware' },
  { pattern: 'modules/*/tasks/**', what: 'a scheduled task' },
  { pattern: 'modules/*/health/**', what: 'a health check' },
  { pattern: 'modules/*/commands/**', what: 'a command' },
  { pattern: 'modules/*/migrations/**', what: 'a migration' },
  { pattern: 'modules/*/seeders/**', what: 'a seeder' },
  { pattern: 'modules/*/factories/**', what: 'a factory' },
  { pattern: 'modules/*/index.ts', what: "a module's definition (its providers, routes, listeners …)" },
  { pattern: 'modules/*/routes.ts', what: "a module's routes" },
  { pattern: 'modules/*/api-routes.ts', what: "a module's routes" },
  { pattern: 'modules/*/schedule.ts', what: "a module's schedule" },
  { pattern: 'modules/*/config.ts', what: "a module's config (read from the server's environment)" },
  { pattern: '**/*ServiceProvider.ts', what: 'a service provider' },
  { pattern: '**/*Repository.ts', what: 'a repository' },
  { pattern: 'bootstrap/app.ts', what: "the app's definition" },
  { pattern: 'config/**', what: "the app's config (read from the server's environment)" },
  { pattern: 'middleware/**', what: 'a middleware' },
];

/** Client code by convention — where the check starts in a server environment (SSR, tests), besides the pages. */
const CLIENT_LAYOUTS = ['layouts/**', 'modules/*/layouts/**'];
const TEST_FILE = /\.(?:type-)?test\.[cm]?[jt]sx?$/;

export interface ServerImportsOptions {
  /** The page globs (`marmeon({ pages })`) — client code. */
  readonly pages: readonly string[];
  /** The client entry, relative to the app root — client code. */
  readonly client: string;
  /** More server modules (globs relative to the app root); `!glob` takes modules out. */
  readonly serverModules?: readonly string[];
}

/** A value import of one of the app's own modules. */
interface Edge {
  readonly target: string;
  readonly line: number;
  readonly column: number;
  readonly specifier: string;
  readonly hint: string;
}

interface Problem {
  readonly file: string;
  readonly edge: Edge;
  readonly what: string;
}

interface State {
  /** The value imports of the client modules checked so far, resolved. */
  readonly edges: Map<string, readonly Edge[]>;
  /** App modules a server environment transformed as server code — not parsed; read again if client code reaches one. */
  readonly seen: Set<string>;
  /** App modules client code imports (as values) — in a server environment, where not every module is client code. */
  readonly reached: Set<string>;
  /** Which client module first imported a module: the chain in the message. */
  readonly parents: Map<string, string>;
}

/**
 * `marmeon:server-imports` — refuses client code that imports a server module as a value, which would bundle it into the
 * browser. See docs/vite.md#server-code-in-the-browser.
 *
 * In the client environment every module of the app is client code. In a server environment (SSR in dev and tests,
 * Vitest) only the pages, layouts, the client entry and their value imports are; server code may import anything. The
 * SSR build is not checked: the client build has checked what reaches the browser.
 */
export function serverImports(options: ServerImportsOptions): Plugin {
  const extra = options.serverModules ?? [];
  const serverModules: ServerModule[] = [
    ...SERVER_MODULES,
    ...extra.filter((pattern) => !pattern.startsWith('!')).map((pattern) => ({ pattern: pattern.replace(/^\/+/, ''), what: `a module matching ${pattern}` })),
  ];
  const excluded = extra.filter((pattern) => pattern.startsWith('!')).map((pattern) => pattern.slice(1).replace(/^\/+/, ''));
  const clientRoots = [...options.pages, ...CLIENT_LAYOUTS, options.client].map((pattern) => pattern.replace(/^\/+/, ''));

  let roots: string[] = [];
  let command: 'build' | 'serve' = 'serve';
  let aliases: ResolvedConfig['resolve']['alias'] = [];
  const states = new Map<string, State>();
  const stateOf = (environment: string): State => {
    let state = states.get(environment);
    if (!state) states.set(environment, (state = { edges: new Map(), seen: new Set(), reached: new Set(), parents: new Map() }));
    return state;
  };

  const own = (path: string): string | undefined => {
    if (path.includes('/node_modules/') || !/\.[cm]?[jt]sx?$/.test(path)) return undefined;
    const base = roots.find((dir) => path.startsWith(dir));
    return base === undefined ? undefined : relative(base, path).split(sep).join('/');
  };
  const serverModule = (rel: string): ServerModule | undefined =>
    excluded.some((pattern) => matchesGlob(rel, pattern)) ? undefined : serverModules.find((module) => matchesGlob(rel, module.pattern));
  const isClientRoot = (rel: string) => !TEST_FILE.test(rel) && clientRoots.some((pattern) => matchesGlob(rel, pattern));
  /** Specifiers that can name one of the app's files: relative, root-absolute, subpath imports (`#modules/…`), aliases. */
  const resolvable = (specifier: string) =>
    /^[./#]/.test(specifier) || aliases.some(({ find }) => (typeof find === 'string' ? specifier === find || specifier.startsWith(`${find}/`) : find.test(specifier)));

  return {
    name: 'marmeon:server-imports',
    enforce: 'pre',
    configResolved(config) {
      command = config.command;
      aliases = config.resolve.alias.filter(({ find }) => typeof find !== 'string' || !find.startsWith('@vite/'));
      let real = config.root;
      try {
        real = realpathSync(config.root);
      } catch {
        // a root that does not exist yet: nothing to check
      }
      roots = [...new Set([config.root, real])].map((dir) => `${dir}/`);
    },
    buildStart() {
      states.clear();
    },
    async transform(code, id, transformOptions) {
      const path = id.split('?')[0]!;
      if (id.startsWith('\0')) return undefined;
      const rel = own(path);
      if (rel === undefined) return undefined;
      const environment = (this as { environment?: { name: string; config: { consumer: string } } }).environment;
      const client = environment ? environment.config.consumer === 'client' : transformOptions?.ssr !== true;
      // The SSR build may bundle server code; the client build has already checked what reaches the browser.
      if (command === 'build' && !client) return undefined;

      const state = stateOf(environment?.name ?? (client ? 'client' : 'ssr'));
      // Server code is not parsed: a server environment (and Vitest, where most modules are server code) pays only for pages,
      // layouts and what they import.
      if (!client && !state.reached.has(path) && !isClientRoot(rel)) {
        state.seen.add(path);
        return undefined;
      }
      const edgesOf = async (file: string, source: string): Promise<Edge[]> => {
        const edges: Edge[] = [];
        for (const found of valueImports(source, file)) {
          if (!resolvable(found.specifier)) continue;
          const resolved = await this.resolve(found.specifier, file, { skipSelf: true });
          if (!resolved || resolved.external) continue;
          const target = resolved.id.split('?')[0]!;
          if (own(target) !== undefined) edges.push({ ...found, target });
        }
        return edges;
      };
      state.edges.set(path, await edgesOf(path, code));

      // In the client environment every module is checked when it is transformed. A server environment follows the value
      // imports of client code — into modules not transformed yet (checked when they are) and into modules it transformed
      // before as server code, which it is not asked to transform again: those it reads from disk.
      const problems: Problem[] = [];
      const visit = async (file: string): Promise<void> => {
        for (const edge of state.edges.get(file) ?? []) {
          const target = own(edge.target)!;
          const server = serverModule(target);
          if (server) {
            problems.push({ file, edge, what: server.what });
            continue;
          }
          if (!state.parents.has(edge.target) && edge.target !== file) state.parents.set(edge.target, file);
          if (client || state.reached.has(edge.target)) continue;
          state.reached.add(edge.target);
          if (!state.seen.has(edge.target)) continue;
          let source: string;
          try {
            source = readFileSync(edge.target, 'utf8');
          } catch {
            continue;
          }
          state.edges.set(edge.target, await edgesOf(edge.target, source));
          await visit(edge.target);
        }
      };
      state.reached.add(path);
      await visit(path);
      if (problems.length === 0) return undefined;

      const lines = problems.map(({ file, edge, what }) => {
        const at = own(file)!;
        const chain = isClientRoot(at) ? [] : chainOf(file, state.parents, own);
        const via = chain.length > 1 ? ` (${at} is client code: ${chain.join(' → ')})` : '';
        return `[marmeon] ${at}:${edge.line}:${edge.column} — imports ${own(edge.target)} as a value${via}: ${what} is server code, and a value import bundles it — with everything it imports — into the browser. ${edge.hint}`;
      });
      this.error(lines.join('\n'));
    },
  };
}

/** `a → b → c`: the client modules from the first one that imported `file` down to it. */
function chainOf(file: string, parents: ReadonlyMap<string, string>, name: (path: string) => string | undefined): string[] {
  const chain = [file];
  for (let at = parents.get(file); at !== undefined && !chain.includes(at) && chain.length < 12; at = parents.get(at)) chain.unshift(at);
  return chain.map((path) => name(path) ?? path);
}

type Node = { type: string; start: number; end: number; [key: string]: any };

/**
 * The imports of a module that load another module at runtime — everything but `import type`, `export type … from` and
 * `export type * from`. `import { type A } from` counts: with `verbatimModuleSyntax` it stays as `import {} from …` and loads
 * the module (and so does `export { type A } from`). `import()` with a literal counts; a `typeof import()` type does not.
 */
export function valueImports(code: string, filename: string): Omit<Edge, 'target'>[] {
  if (!/\bimport\b|\bexport\b/.test(code)) return [];
  const { program, module, errors } = parseSync(filename, code);
  if (errors.length > 0) return []; // Vite reports syntax errors itself
  const found: Omit<Edge, 'target'>[] = [];
  const at = (offset: number) => position(code, offset);

  for (const node of program.body as Node[]) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue;
      const specifier = node.source.value as string;
      found.push({ specifier, ...at(node.start), hint: importHint(node, specifier) });
    } else if ((node.type === 'ExportNamedDeclaration' && node.source) || node.type === 'ExportAllDeclaration') {
      if (node.exportKind === 'type') continue;
      const specifier = node.source.value as string;
      found.push({ specifier, ...at(node.start), hint: `Re-export its types only: export type { … } from '${specifier}'.` });
    }
  }
  for (const dynamic of module.dynamicImports) {
    const literal = code.slice(dynamic.moduleRequest.start, dynamic.moduleRequest.end);
    const quoted = /^(['"])(.*)\1$/s.exec(literal) ?? /^(`)([^`$]*)`$/s.exec(literal);
    if (!quoted) continue;
    found.push({ specifier: quoted[2]!, ...at(dynamic.start), hint: 'import() loads it in the browser — ask the server for what the page needs (a prop, a route) instead.' });
  }
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

function importHint(node: Node, specifier: string): string {
  const specifiers = (node.specifiers ?? []) as Node[];
  const names = specifiers.map((entry) => {
    if (entry.type === 'ImportDefaultSpecifier') return { kind: 'default', text: entry.local.name as string };
    if (entry.type === 'ImportNamespaceSpecifier') return { kind: 'namespace', text: `* as ${entry.local.name as string}` };
    const imported = entry.imported.type === 'Identifier' ? (entry.imported.name as string) : JSON.stringify(entry.imported.value);
    return { kind: 'named', text: imported === entry.local.name ? imported : `${imported} as ${entry.local.name as string}` };
  });
  const shared = 'If the browser needs a value from it, move that value into a module both sides import.';
  if (names.length === 0) return `It is imported for its side effects only — leave it to the server. ${shared}`;
  const inlineOnly = specifiers.every((entry) => entry.type === 'ImportSpecifier' && entry.importKind === 'type');
  const named = names.filter((name) => name.kind === 'named').map((name) => name.text);
  // `import type` takes a default (or namespace) import or named ones, never both.
  const clauses = [names.find((name) => name.kind !== 'named')?.text, named.length > 0 ? `{ ${named.join(', ')} }` : undefined].filter(Boolean);
  const suggestion = clauses.map((clause) => `import type ${clause} from '${specifier}'`).join('; ');
  if (inlineOnly) return `\`import { type … }\` still loads the module (verbatimModuleSyntax keeps it as \`import {} from …\`): write ${suggestion}. ${shared}`;
  return `A class is a value even where only its type is used: write ${suggestion}. ${shared}`;
}

/** 1-based line and column, like an editor's. */
function position(code: string, offset: number): { line: number; column: number } {
  const before = code.slice(0, offset);
  return { line: before.split('\n').length, column: offset - before.lastIndexOf('\n') };
}
