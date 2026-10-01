import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bespokeInjection } from '@bespokecore/core/vite';
import { defaultClientConditions, defaultServerConditions, type Plugin, type UserConfig } from 'vite';

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
   * For `vitest.config.ts`: conditions, injection and virtual modules only — no entries, no HTML,
   * no build settings.
   */
  test?: boolean;
}

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
 * - serves `virtual:bespoke/pages` and `virtual:bespoke/lang` (types: `@bespokecore/vite/client`).
 */
export function bespoke(options: BespokeOptions = {}): Plugin[] {
  const entries: BespokeEntries = { ...DEFAULT_ENTRIES, ...options.entries };
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
        ssr: { resolve: { conditions: [...source, ...defaultServerConditions] } },
      };
      if (command === 'build' && !options.test) {
        result.build = isSsrBuild
          ? { outDir: 'dist/server', emptyOutDir: true, rolldownOptions: { input: { ssr: resolve(root, entries.ssr) } } }
          : { outDir: 'dist/client', emptyOutDir: true };
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
    virtualGlob('pages', options.pages ?? DEFAULT_PAGES),
    virtualGlob('lang', options.lang ?? DEFAULT_LANG),
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
