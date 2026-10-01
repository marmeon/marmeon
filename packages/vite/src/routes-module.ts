import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Plugin } from 'vite';
import { collectRouteReferences, ROUTE_SINKS, type RouteReferenceProblem, type RouteSink } from './route-references.ts';

/** Written by `bespoke route:types` (`BROWSER_ROUTES_FILE` of @bespokecore/http — this package does not depend on it). */
export const BROWSER_ROUTES_FILE = '.bespoke/routes.json';

const ID = 'virtual:bespoke/routes';
const RESOLVED = `\0${ID}`;
/** Stands in for the client build's manifest until every module is collected (`renderChunk`). */
const PLACEHOLDER = '__BESPOKE_ROUTE_MANIFEST__';
const PLACEHOLDER_PATTERN = new RegExp(`(["'\`])${PLACEHOLDER}\\1`, 'g');

type Manifest = Record<string, { readonly method: string; readonly path: string }>;

interface BrowserRoutes {
  readonly routes: Manifest;
  readonly hidden: Record<string, 'internal' | 'api' | 'except'>;
}

export interface RoutesModuleOptions {
  /** Where client code hands route names to the framework (default: the React adapter's, {@link ROUTE_SINKS}). */
  readonly sinks?: readonly RouteSink[];
  /** Vitest: serve the module, collect nothing. */
  readonly test?: boolean;
}

/**
 * `virtual:bespoke/routes` — the browser's route manifest (E57), from `.bespoke/routes.json`:
 *
 * - **client build:** only the names client code writes out (`<Link route>`, `route()` of `useRoute()`,
 *   `useForm(name, …)` …), collected in `transform` over exactly the modules the build loads and put in at
 *   `renderChunk`. A route only the server links to (`redirect().route()`) never reaches the bundle.
 * - **SSR build:** every route the browser may learn — server code, nothing leaks.
 * - **dev:** every route the browser may learn; the same collector runs, so a name built at runtime is an error in dev
 *   as in the build, and resolving a name the collector never saw warns that production lacks it.
 *
 * `.internal()` routes, API routes and `clientRoutes.except` are never in it — naming one in client code fails.
 */
export function routesModule(options: RoutesModuleOptions = {}): Plugin {
  const sinks = options.sinks ?? ROUTE_SINKS;
  const collected = new Map<string, readonly string[]>();
  let root = process.cwd();
  /** The app root as given and as resolved — module ids are real paths, a configured root may be a symlink. */
  let roots: string[] = [];
  let command: 'build' | 'serve' = 'serve';
  let cache: { text: string; routes: BrowserRoutes } | undefined;

  const file = () => join(root, BROWSER_ROUTES_FILE);
  const read = (): BrowserRoutes | undefined => {
    let text: string;
    try {
      text = readFileSync(file(), 'utf8');
    } catch {
      return undefined;
    }
    if (cache?.text !== text) cache = { text, routes: JSON.parse(text) as BrowserRoutes };
    return cache.routes;
  };
  const missing = () =>
    `${ID}: ${BROWSER_ROUTES_FILE} is missing — run \`bespoke route:types\` (bespoke dev and bespoke build run it themselves).`;
  const isServer = (context: unknown, ssr: boolean | undefined) => {
    const environment = (context as { environment?: { config: { consumer: string } } }).environment;
    return environment ? environment.config.consumer === 'server' : ssr === true;
  };

  return {
    name: 'bespokecore:routes',
    enforce: 'pre',
    configResolved(config) {
      root = config.root;
      command = config.command;
      let real = root;
      try {
        real = realpathSync(root);
      } catch {
        // a root that does not exist yet: nothing to collect from
      }
      roots = [...new Set([root, real])].map((dir) => `${dir}/`);
    },
    buildStart() {
      collected.clear();
    },
    resolveId: (source) => (source === ID ? RESOLVED : undefined),
    load(id, loadOptions) {
      if (id !== RESOLVED) return undefined;
      const routes = read();
      this.addWatchFile(file());
      if (!routes) this.error(missing());
      if (command === 'build' && !isServer(this, loadOptions?.ssr)) return `export const routes = /* filled at renderChunk */ ${JSON.stringify(PLACEHOLDER)};\n`;
      if (command === 'build' || options.test) return `export const routes = ${JSON.stringify(routes.routes)};\n`;
      return devModule(routes.routes);
    },
    transform(code, id) {
      if (options.test) return undefined;
      const path = id.split('?')[0]!;
      if (id.startsWith('\0') || !/\.[cm]?[jt]sx?$/.test(path) || path.includes('/node_modules/') || !roots.some((dir) => path.startsWith(dir))) return undefined;
      if (command === 'build' && isServer(this, undefined)) return undefined;

      const routes = read();
      const allowed = routes ? Object.keys(routes.routes) : [];
      const { references, problems } = collectRouteReferences(code, path, { sinks, names: allowed });
      if (references.length === 0 && problems.length === 0) return undefined;
      if (!routes) this.error(missing());

      const all: RouteReferenceProblem[] = [...problems];
      for (const { name, start } of references) {
        if (Object.hasOwn(routes.routes, name)) continue;
        const reason = Object.hasOwn(routes.hidden, name) ? routes.hidden[name] : undefined;
        all.push({ message: reason ? hiddenMessage(name, reason) : unknownMessage(name, allowed), start });
      }
      if (all.length > 0) {
        const where = relative(roots.find((dir) => path.startsWith(dir)) ?? root, path).split(sep).join('/');
        this.error(all.sort((a, b) => a.start - b.start).map(({ message, start }) => `[bespoke] ${where}:${position(code, start)} — ${message}`).join('\n'));
      }

      const names = [...new Set(references.map((reference) => reference.name))].sort();
      if (command === 'build') {
        collected.set(path, names);
        return undefined;
      }
      // Dev: the module tells the manifest which names it uses — before any of its components runs.
      return {
        code: `${code}\nimport { __referenceRoutes as __bespokeReferenceRoutes } from '${ID}';\n__bespokeReferenceRoutes(${JSON.stringify(names)});\n`,
        map: null,
      };
    },
    renderChunk(code) {
      if (!code.includes(PLACEHOLDER)) return undefined;
      const routes = read();
      if (!routes) this.error(missing());
      const manifest: Manifest = {};
      for (const name of [...new Set([...collected.values()].flat())].sort()) manifest[name] = routes.routes[name]!;
      return { code: code.replace(PLACEHOLDER_PATTERN, () => JSON.stringify(manifest)), map: null };
    },
  };
}

/** Every allowed route, and a warning for a name no module declared: the client build would lack it. */
function devModule(routes: Manifest): string {
  return `const all = ${JSON.stringify(routes)};
const referenced = new Set();
const warned = new Set();
/** Called by every module that names routes (injected by the bespoke() plugin in dev). */
export function __referenceRoutes(names) {
  for (const name of names) referenced.add(name);
}
function check(name) {
  if (typeof name !== 'string' || !Object.hasOwn(all, name) || referenced.has(name) || warned.has(name)) return;
  warned.add(name);
  console.warn(\`[bespoke] Route [\${name}] is resolved, but no module writes it out (<Link route="\${name}">, route('\${name}'), useForm('\${name}', …)) — the production build will lack it. Name the route where it is used instead of passing the name or the route() function along.\`);
}
// Reading a route warns (resolveRoute reads it); listing the keys does not.
export const routes = new Proxy(all, {
  get(target, key, receiver) {
    check(key);
    return Reflect.get(target, key, receiver);
  },
});
`;
}

function hiddenMessage(name: string, reason: 'internal' | 'api' | 'except'): string {
  const why = { internal: 'it is .internal()', api: 'API routes stay on the server unless clientRoutes.include lists them', except: 'it is in clientRoutes.except' }[reason];
  return `'${name}' is never sent to the browser — ${why}. Link to it from the server (redirect().route(), router.url()), not from client code.`;
}

function unknownMessage(name: string, allowed: readonly string[]): string {
  const parent = name.includes('.') ? name.slice(0, name.lastIndexOf('.') + 1) : '';
  const near = parent ? allowed.filter((candidate) => candidate.startsWith(parent) && !candidate.slice(parent.length).includes('.')).sort() : [];
  const listed = near.length > 5 ? `${near.slice(0, 5).join(', ')}, …` : near.join(', ');
  return `'${name}' is not a route name${near.length > 0 ? ` — did you mean ${listed}?` : ''} (run bespoke route:types after adding a route).`;
}

/** `line:column`, both 1-based like an editor's. */
function position(code: string, offset: number): string {
  const before = code.slice(0, offset);
  const line = before.split('\n').length;
  return `${line}:${offset - before.lastIndexOf('\n')}`;
}
