import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { marmeonInjection, CSP_NONCE_PLACEHOLDER } from '@marmeon/core/internal';
import { defaultClientConditions, defaultServerConditions, type Plugin, type Rolldown, type UserConfig } from 'vite';
import { ROUTE_SINKS, type RouteSink } from './route-references.ts';
import { routesModule } from './routes-module.ts';
import { serverImports } from './server-imports.ts';

/**
 * The export condition that maps framework packages to their TypeScript sources inside the
 * Marmeon monorepo. Published packages do not carry it, so it is harmless elsewhere.
 */
export const SOURCE_CONDITION = '@marmeon/source';

/** The name of the main plugin; the server finds the entries through its `api`. */
export const PLUGIN_NAME = 'marmeon';

/** Vite's default `server.fs.deny`. A list of its own replaces this one rather than extending it, so ours has to repeat it. */
const VITE_DEFAULT_DENY = ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**'];

/** What the dev server must never serve, even to a client that reaches it over the network: storage, databases, build output. */
function privateFiles(root: string): string[] {
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    // A root that does not exist yet has nothing to resolve.
  }
  // `resolve.preserveSymlinks` keeps the path as written, otherwise Vite sees the real one.
  const bases = [...new Set([resolve(root), real])].map((dir) => dir.replaceAll('\\', '/').replace(/[[\]{}()*?!+@]/g, '\\$&'));
  return [
    ...VITE_DEFAULT_DENY,
    ...bases.flatMap((base) => [`${base}/storage/**`, `${base}/dist/**`, `${base}/.marmeon/**`]),
    ...['sqlite', 'sqlite3', 'db', 'db3'].flatMap((extension) => [`**/*.${extension}`, `**/*.${extension}-*`]),
  ];
}

export interface MarmeonEntries {
  /** Browser entry. See `MarmeonOptions.entries`. */
  client: string;
  /** SSR entry. See `MarmeonOptions.entries`. */
  ssr: string;
}

/** What the server and the CLI read from the resolved Vite config (`plugins.find(p => p.name === 'marmeon').api`). */
export interface MarmeonPluginApi {
  entries: MarmeonEntries;
}

export interface MarmeonOptions {
  /**
   * Entries relative to the app root — override only if the app keeps them elsewhere. `client` is the browser entry
   * (default `bootstrap/client.tsx`), `ssr` the entry exporting `render` (default `bootstrap/ssr.tsx`). Further entries come as their own options.
   */
  entries?: { client?: string; ssr?: string };
  /** Page components, as a glob relative to the app root (`virtual:marmeon/pages`). Default `modules/*\/views/**\/*.tsx`.
   * Only files in `modules/<module>/views/` at the app root get a page name; any other file the glob matches is ignored. See docs/vite.md#options. */
  pages?: string | string[];
  /**
   * Language files, as a glob relative to the app root (`virtual:marmeon/lang`, one chunk per file — the browser loads
   * only the page's locale). Default `modules/*\/lang/*.ts` and `lang/*.ts` (namespace `app`).
   */
  lang?: string | string[];
  /**
   * More places where client code hands a route name to the framework, besides the React adapter's
   * (`<Link route>`, `useRoute()`, `useForm(name, …)` — built in). Only names written out at a sink
   * reach the browser's route manifest (`virtual:marmeon/routes`).
   */
  routeSinks?: readonly RouteSink[];
  /**
   * More server modules — globs relative to the app root — besides the built-in conventions; `'!glob'` takes
   * modules out of them. See docs/vite.md#server-code-in-the-browser.
   */
  serverModules?: readonly string[];
  /**
   * For `vitest.config.ts`: conditions, injection, virtual modules and the server-import check only — no entries, no HTML, no CSP
   * nonce, no pre-bundling, no build settings.
   */
  test?: boolean;
  /**
   * Keep Vite's own handling of `.env` files and `VITE_*` variables: every `VITE_*` variable of the process and of the `.env`
   * files of the app's folder that client code reads through `import.meta.env` is written into the public bundle. Off by
   * default, so a variable never reaches the browser by its name, and an own `envDir` or `envPrefix` is refused. `MODE`, `DEV`,
   * `PROD`, `SSR` and `BASE_URL` stay either way. See docs/vite.md#environment-variables.
   */
  viteEnv?: boolean;
}

/** A module of a third-party package — not one of the framework's (`@marmeon/*`), not the app's own. */
function isThirdParty(id: string): boolean {
  return /[\\/]node_modules[\\/]/.test(id) && !/[\\/]node_modules[\\/]@marmeon[\\/]/.test(id);
}

/**
 * How the client build splits what the first page loads: `vendor` (third-party libraries, cached across the app's own
 * deployments) and `index` (the framework, the app's entry and layouts). Without it, every module a lazy chunk shares with the
 * first page becomes an initial chunk of its own. What loads on first use keeps its own chunks.
 */
export const CLIENT_CHUNKS: Rolldown.CodeSplittingOptions = {
  groups: [
    { name: 'vendor', test: isThirdParty, tags: ['$initial'], priority: 1 },
    { name: 'index', tags: ['$initial'] },
  ],
};

const ENV_OWNED = 'marmeon(): `envDir` and `envPrefix` are set by the plugin, so no variable reaches the client bundle by its name. Remove them from the config, or pass `marmeon({ viteEnv: true })` to manage them yourself. See docs/vite.md#environment-variables.';
const NO_PUBLIC_ENV_PREFIX = '__MARMEON_NO_PUBLIC_ENV__';
const DEFAULT_ENTRIES: MarmeonEntries = { client: 'bootstrap/client.tsx', ssr: 'bootstrap/ssr.tsx' };
const DEFAULT_PAGES = 'modules/*/views/**/*.tsx';
const DEFAULT_LANG = ['modules/*/lang/*.ts', 'lang/*.ts'];

/**
 * The Vite plugin of a Marmeon app. UI-agnostic: the adapter brings its own plugin. See docs/vite.md#introduction.
 *
 * ```ts
 * export default defineConfig({ plugins: [marmeon(), react()] });          // vite.config.ts
 * export default defineConfig({ plugins: [marmeon({ test: true })] });     // vitest.config.ts
 * ```
 */
export function marmeon(options: MarmeonOptions = {}): Plugin[] {
  const entries: MarmeonEntries = { ...DEFAULT_ENTRIES, ...options.entries };
  const pages = options.pages ?? DEFAULT_PAGES;
  const api: MarmeonPluginApi = { entries };

  const main: Plugin & { api: MarmeonPluginApi } = {
    name: PLUGIN_NAME,
    api,
    config(config, { command, mode, isSsrBuild }) {
      const root = resolve(config.root ?? process.cwd());
      // Sources only while serving in development or test; a build always takes what a published package ships.
      const source = command === 'serve' && (mode === 'development' || mode === 'test') ? [SOURCE_CONDITION] : [];
      const result: UserConfig = {
        resolve: { conditions: [...source, ...defaultClientConditions], dedupe: adapterPeers(root) },
        // Vitest hands the server conditions to its Node workers (`--conditions`). Node itself never matches `module`: with
        // it, tests would load builds only a bundler can run (the AWS SDK's ES build, with extensionless imports).
        ssr: { resolve: { conditions: [...source, ...(options.test ? defaultServerConditions.filter((condition) => condition !== 'module') : defaultServerConditions)] } },
      };
      // No `.env` file is read and no variable has a public prefix, so nothing reaches `import.meta.env` by its name: the prefix
      // is no real variable name. `MODE`, `DEV`, `PROD` and `SSR` stay, Vite sets them itself.
      if (!options.viteEnv) {
        // Our values would replace a string or an `envDir` of the app silently: say so instead.
        if (config.envDir !== undefined || config.envPrefix !== undefined) throw new Error(ENV_OWNED);
        result.envDir = false;
        result.envPrefix = NO_PUBLIC_ENV_PREFIX;
      }
      // Tags (and the `csp-nonce` meta Vite reads) carry the placeholder; the server replaces only this value with the
      // response's nonce, or takes the attribute out.
      if (!options.test) result.html = { cspNonce: CSP_NONCE_PLACEHOLDER };
      if (command === 'serve' && !options.test) {
        // Vite scans index.html as written, which lacks the client entry and the devtools' bar: found only on the first request,
        // each re-bundling reloads the page (a 504 "Outdated Optimize Dep").
        result.optimizeDeps = { entries: [entries.client, ...[pages].flat()], include: installedModules(root, PREBUNDLED) };
      }
      // An app's own `server.fs.deny` is extended by this list, not replaced (Vite concatenates arrays). A pattern
      // with a slash is matched against the absolute path, so the app's directories carry the root.
      if (command === 'serve' && !options.test) result.server = { fs: { deny: privateFiles(root) } };
      if (command === 'build' && !options.test) {
        result.build = isSsrBuild
          ? { outDir: 'dist/server', emptyOutDir: true, rolldownOptions: { input: { ssr: resolve(root, entries.ssr) } } }
          : // `manifest`: the server reads it at start to preload each page's chunks (docs/vite.md#building).
            { outDir: 'dist/client', emptyOutDir: true, manifest: true, rolldownOptions: { output: { codeSplitting: CLIENT_CHUNKS } } };
      }
      return result;
    },
    configResolved(resolved) {
      if (options.viteEnv) return;
      // An app's own `envPrefix` array is concatenated with ours, a string or an `envDir` replaces it, and another plugin may add
      // prefixes: whatever the merge left, a public variable would reach the bundle by its name.
      const prefixes = [resolved.envPrefix ?? []].flat();
      if (resolved.envDir !== false || prefixes.length !== 1 || prefixes[0] !== NO_PUBLIC_ENV_PREFIX) {
        throw new Error(ENV_OWNED);
      }
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (options.test || html.includes(`src="/${entries.client}"`)) return undefined;
        return [{ tag: 'script', attrs: { type: 'module', src: `/${entries.client}` }, injectTo: 'body' }];
      },
    },
  };

  // `async`: a streamed page hydrates its shell while slow Suspense boundaries still stream in (the page object is in the
  // head). Build only: the dev runtime's preambles (React Refresh) must run first.
  const asyncEntry: Plugin = {
    name: 'marmeon:async-entry',
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
    marmeonInjection() as Plugin,
    virtualGlob('pages', pages),
    virtualGlob('lang', options.lang ?? DEFAULT_LANG),
    routesModule({ sinks: [...ROUTE_SINKS, ...(options.routeSinks ?? [])], ...(options.test ? { test: true } : {}) }),
    serverImports({ pages: typeof pages === 'string' ? [pages] : pages, client: entries.client, ...(options.serverModules ? { serverModules: options.serverModules } : {}) }),
  ];
}

/**
 * A virtual module `virtual:marmeon/<name>` whose default export is `import.meta.glob(pattern)`. Patterns are relative to
 * the app root; the keys are root-absolute (`/modules/…`).
 */
export function virtualGlob(name: string, pattern: string | string[], options: { eager?: boolean } = {}): Plugin {
  const id = `virtual:marmeon/${name}`;
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
 * The non-optional peer dependencies of the app's framework packages (`@marmeon/*`, the CLI `marmeon`, or with a
 * `"marmeon"` field) — deduped, so the adapter and the app share one React even when the adapter is linked from a workspace.
 */
export function adapterPeers(root: string): string[] {
  const app = readJson(join(root, 'package.json'));
  if (!app) return [];
  const names = Object.keys({ ...(app.dependencies as object), ...(app.devDependencies as object) });
  const peers = new Set<string>();
  for (const name of names) {
    const manifest = findPackage(root, name);
    if (!manifest || (!name.startsWith('@marmeon/') && name !== 'marmeon' && manifest.marmeon === undefined)) continue;
    const optional = (manifest.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
    for (const peer of Object.keys((manifest.peerDependencies ?? {}) as object)) {
      if (!optional[peer]?.optional) peers.add(peer);
    }
  }
  return [...peers].sort();
}

/** Modules a page loads that no file of the app imports: the devtools' bar (development only, added by the server). */
const PREBUNDLED = ['@marmeon/devtools/client'];

/**
 * The modules among `specifiers` an installed package provides — in `node_modules` for real: a workspace link (the monorepo's
 * sources) is never pre-bundled.
 */
function installedModules(root: string, specifiers: readonly string[]): string[] {
  return specifiers.filter((specifier) => {
    const name = specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
    for (let dir = root; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate).includes(`${sep}node_modules${sep}`);
      if (dirname(dir) === dir) return false;
    }
  });
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
