import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bespokeInjection } from '@bespokecore/core/vite';
import { defaultClientConditions, defaultServerConditions, type Plugin, type Rolldown, type UserConfig } from 'vite';
import { ROUTE_SINKS, type RouteSink } from './route-references.ts';
import { routesModule } from './routes-module.ts';
import { serverImports } from './server-imports.ts';

export { collectRouteReferences, ROUTE_SINKS } from './route-references.ts';
export type { CollectOptions, RouteReference, RouteReferenceProblem, RouteSink } from './route-references.ts';
export { BROWSER_ROUTES_FILE, routesModule } from './routes-module.ts';
export { SERVER_MODULES, serverImports, valueImports } from './server-imports.ts';
export type { ServerImportsOptions, ServerModule } from './server-imports.ts';

/**
 * The export condition that maps framework packages to their TypeScript sources inside the
 * BespokeCore monorepo. Published packages do not carry it, so it is harmless elsewhere.
 */
export const SOURCE_CONDITION = '@bespokecore/source';

/** The name of the main plugin; the server finds the entries through its `api`. */
export const PLUGIN_NAME = 'bespokecore';

export interface BespokeEntries {
  /** Browser entry, relative to the app root. Default `bootstrap/client.tsx`. */
  client: string;
  /** SSR entry exporting `render`, relative to the app root. Default `bootstrap/ssr.tsx`. */
  ssr: string;
}

/** What the server and the CLI read from the resolved Vite config (`plugins.find(p => p.name === 'bespokecore').api`). */
export interface BespokePluginApi {
  entries: BespokeEntries;
}

export interface BespokeOptions {
  /** Entries relative to the app root — override only if the app keeps them elsewhere. */
  entries?: Partial<BespokeEntries>;
  /** Page components, as a glob relative to the app root (`virtual:bespoke/pages`). Default `modules/*\/views/**\/*.tsx`. */
  pages?: string | string[];
  /**
   * Language files, as a glob relative to the app root (`virtual:bespoke/lang`, one chunk per file — the browser loads
   * only the page's locale). Default `modules/*\/lang/*.ts` and `lang/*.ts` (namespace `app`).
   */
  lang?: string | string[];
  /**
   * More places where client code hands a route name to the framework, besides the React adapter's
   * (`<Link route>`, `useRoute()`, `useForm(name, …)` — see `ROUTE_SINKS`). Only names written out at a sink
   * reach the browser's route manifest (`virtual:bespoke/routes`).
   */
  routeSinks?: readonly RouteSink[];
  /**
   * More server modules — globs relative to the app root — besides the conventions in `SERVER_MODULES` (controllers, jobs,
   * listeners, mails, policies, providers, repositories, a module's `index.ts`/`routes.ts`/`config.ts`, `config/`, …).
   * Client code (pages, layouts, the client entry and what they import) never imports one as a value: a dev error and a
   * failed build (E121). `'!glob'` takes modules out of the conventions.
   */
  serverModules?: readonly string[];
  /**
   * For `vitest.config.ts`: conditions, injection and virtual modules only — no entries, no HTML,
   * no build settings.
   */
  test?: boolean;
}

/** A module of a third-party package — not one of the framework's (`@bespokecore/*`), not the app's own. */
function isThirdParty(id: string): boolean {
  return /[\\/]node_modules[\\/]/.test(id) && !/[\\/]node_modules[\\/]@bespokecore[\\/]/.test(id);
}

/**
 * How the client build splits what the first page loads (Wave 5c): two chunks — the third-party libraries (`vendor`: the UI
 * library and its DOM renderer, cached across the app's own deployments) and the rest (`index`: the framework's client core and
 * adapter with the app's entry and layouts). Without it, every module a lazy chunk shares with the first page became a chunk
 * of its own (the web app loaded 9 initial chunks, each compressed on its own). Only what the first page loads (`$initial`):
 * what loads on first use — pages, layers, live validation, prefetching, instant visits — stays in its own chunks.
 */
export const CLIENT_CHUNKS: Rolldown.CodeSplittingOptions = {
  groups: [
    { name: 'vendor', test: isThirdParty, tags: ['$initial'], priority: 1 },
    { name: 'index', tags: ['$initial'] },
  ],
};

const DEFAULT_ENTRIES: BespokeEntries = { client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' };
const DEFAULT_PAGES = 'modules/*/views/**/*.tsx';
const DEFAULT_LANG = ['modules/*/lang/*.ts', 'lang/*.ts'];

/**
 * The Vite plugin of a BespokeCore app. UI-agnostic: the adapter brings its own plugin.
 *
 * ```ts
 * export default defineConfig({ plugins: [bespoke(), react()] });          // vite.config.ts
 * export default defineConfig({ plugins: [bespoke({ test: true })] });     // vitest.config.ts
 * ```
 *
 * - resolves workspace packages to their sources only while serving (dev, tests) — never in a build;
 * - dedupes the peers of the framework packages the app depends on (one React for the adapter and the app);
 * - runs the constructor-injection transform (`@bespokecore/core/vite`);
 * - adds the client entry to `index.html` and builds the SSR entry to `dist/server/ssr.js`;
 * - splits the client build's initial load into two chunks, `vendor` and `index` ({@link CLIENT_CHUNKS});
 * - serves `virtual:bespoke/pages`, `virtual:bespoke/lang` and `virtual:bespoke/routes` (types: `@bespokecore/vite/client`) —
 *   the route manifest with only the names client code writes out (E57);
 * - refuses client code that imports a server module as a value — a controller, a job, a repository … (E121, {@link serverImports}):
 *   an error in Vite's overlay while serving, a failed build, and in tests too.
 */
export function bespoke(options: BespokeOptions = {}): Plugin[] {
  const entries: BespokeEntries = { ...DEFAULT_ENTRIES, ...options.entries };
  const pages = options.pages ?? DEFAULT_PAGES;
  const api: BespokePluginApi = { entries };

  const main: Plugin & { api: BespokePluginApi } = {
    name: PLUGIN_NAME,
    api,
    config(config, { command, mode, isSsrBuild }) {
      const root = resolve(config.root ?? process.cwd());
      // Sources while serving (dev server, Vitest); a build always takes what a published package ships.
      const source = command === 'serve' && mode !== 'production' ? [SOURCE_CONDITION] : [];
      const result: UserConfig = {
        resolve: { conditions: [...source, ...defaultClientConditions], dedupe: adapterPeers(root) },
        // Vitest hands the server conditions to its Node workers (`--conditions`). Node itself never matches `module`: with
        // it, tests would load builds only a bundler can run (the AWS SDK's ES build, with extensionless imports).
        ssr: { resolve: { conditions: [...source, ...(options.test ? defaultServerConditions.filter((condition) => condition !== 'module') : defaultServerConditions)] } },
      };
      if (command === 'build' && !options.test) {
        result.build = isSsrBuild
          ? { outDir: 'dist/server', emptyOutDir: true, rolldownOptions: { input: { ssr: resolve(root, entries.ssr) } } }
          : { outDir: 'dist/client', emptyOutDir: true, rolldownOptions: { output: { codeSplitting: CLIENT_CHUNKS } } };
      }
      return result;
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (options.test || html.includes(`src="/${entries.client}"`)) return undefined;
        return [{ tag: 'script', attrs: { type: 'module', src: `/${entries.client}` }, injectTo: 'body' }];
      },
    },
  };

  // Built pages start their client entry as soon as it is loaded (`async`), not once the whole document has arrived
  // (a module script's default): a streamed page hydrates its shell while slow Suspense boundaries still stream in.
  // The page object is in the head, before the markup. Not while serving: the dev runtime's preambles (React Refresh)
  // must run first, so in development a streamed page hydrates once it has arrived completely.
  const asyncEntry: Plugin = {
    name: 'bespokecore:async-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, { chunk }) {
        if (options.test || !chunk) return undefined;
        const entry = new RegExp(`<script type="module"((?:(?!async)[^>])*\\ssrc="[^"]*/${chunk.fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`);
        return html.replace(entry, '<script type="module" async$1');
      },
    },
  };

  return [
    main,
    asyncEntry,
    bespokeInjection() as Plugin,
    virtualGlob('pages', pages),
    virtualGlob('lang', options.lang ?? DEFAULT_LANG),
    routesModule({ sinks: [...ROUTE_SINKS, ...(options.routeSinks ?? [])], ...(options.test ? { test: true } : {}) }),
    serverImports({ pages: typeof pages === 'string' ? [pages] : pages, client: entries.client, ...(options.serverModules ? { serverModules: options.serverModules } : {}) }),
  ];
}

/**
 * A virtual module `virtual:bespoke/<name>` whose default export is `import.meta.glob(pattern)` —
 * one place for a glob that framework code needs (pages; language files later). Patterns are
 * relative to the app root; the keys are root-absolute (`/modules/…`). Vite keeps the module up
 * to date when matching files are added or removed.
 */
export function virtualGlob(name: string, pattern: string | string[], options: { eager?: boolean } = {}): Plugin {
  const id = `virtual:bespoke/${name}`;
  const resolved = `\0${id}`;
  const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map((glob) => (glob.startsWith('!') ? `!/${glob.slice(1).replace(/^\/+/, '')}` : `/${glob.replace(/^\/+/, '')}`));

  return {
    name: `${PLUGIN_NAME}:virtual-${name}`,
    resolveId: (source) => (source === id ? resolved : undefined),
    load(loaded) {
      if (loaded !== resolved) return undefined;
      const glob = `import.meta.glob(${JSON.stringify(patterns)}${options.eager ? ', { eager: true }' : ''})`;
      return `export default ${glob};\n`;
    },
  };
}

/**
 * The non-optional peer dependencies of the app's framework packages (`@bespokecore/*` or with a
 * `"bespoke"` field) — e.g. `react` and `react-dom` for `@bespokecore/react`. Deduped, so the
 * adapter and the app share one copy even when the adapter is linked from a workspace.
 */
export function adapterPeers(root: string): string[] {
  const app = readJson(join(root, 'package.json'));
  if (!app) return [];
  const names = Object.keys({ ...(app.dependencies as object), ...(app.devDependencies as object) });
  const peers = new Set<string>();
  for (const name of names) {
    const manifest = findPackage(root, name);
    if (!manifest || (!name.startsWith('@bespokecore/') && manifest.bespoke === undefined)) continue;
    const optional = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    for (const peer of Object.keys((manifest.peerDependencies ?? {}) as object)) {
      if (!optional[peer]?.optional) peers.add(peer);
    }
  }
  return [...peers].sort();
}

type Manifest = Record<string, unknown>;

/** Node's lookup of a package directory (`node_modules/<name>` upwards) — `exports` need not list `package.json`. */
function findPackage(root: string, name: string): Manifest | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file)) return readJson(file);
    if (dirname(dir) === dir) return undefined;
  }
}

function readJson(file: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
}
