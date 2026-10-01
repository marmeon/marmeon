import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SsrRender } from '@bespokecore/http';
import type { ResolvedConfig, ViteDevServer } from 'vite';
import { createDocumentRenderer, type PageRenderer } from './render.ts';

/** The app's Vite setup is incomplete: no `vite`, no `@bespokecore/vite`, or no `bespoke()` plugin. The message says what to do. */
export class ViteSetupError extends Error {
  override name = 'ViteSetupError';
}

/** What `bespoke()` from `@bespokecore/vite` exposes on its plugin (duck-typed: the server does not depend on that package). */
interface BespokePluginApi {
  entries: { client: string; ssr: string };
}

const INSTALL = 'pnpm add -D vite @bespokecore/vite';

/**
 * Imports the app's own Vite (resolved from `root`, not from the framework), which is an optional
 * peer: production servers never load it, `bespoke dev` and `bespoke build` need it.
 */
export async function importVite(root: string): Promise<typeof import('vite')> {
  // Only the app's node_modules chain counts, as for an ESM import: `require.resolve` would also search
  // NODE_PATH, which pnpm's bin shims point at the store's hoisted packages — finding a Vite the app lacks.
  if (!hasPackage(root, 'vite')) {
    throw new ViteSetupError(`Vite is not installed in this app. \`bespoke dev\` and \`bespoke build\` need it: ${INSTALL}`);
  }
  const path = createRequire(join(root, 'package.json')).resolve('vite');
  return (await import(pathToFileURL(path).href)) as typeof import('vite');
}

function hasPackage(root: string, name: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules', name, 'package.json'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Turns the error of loading `vite.config.ts` into a readable one when the config imports a framework
 * package that is not installed (`Cannot find package '@bespokecore/vite'` otherwise). Other errors pass through.
 */
export function explainConfigError(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const missing = typeof message === 'string' ? /Cannot find (?:package|module) '(@bespokecore\/vite)[^']*'/.exec(message) : null;
  if (code === 'ERR_MODULE_NOT_FOUND' && missing) {
    return new ViteSetupError(`vite.config.ts imports ${missing[1]}, which is not installed in this app: ${INSTALL}`);
  }
  return error;
}

/** The entries of the app's `bespoke()` plugin, or a readable error if `vite.config.ts` does not use it. */
export function bespokeEntries(config: Pick<ResolvedConfig, 'plugins'>): BespokePluginApi['entries'] {
  const plugin = config.plugins.find((candidate) => candidate.name === 'bespokecore');
  const api = plugin?.api as BespokePluginApi | undefined;
  if (!api?.entries) {
    throw new ViteSetupError(
      [
        'vite.config.ts does not use the bespoke() plugin, which tells the server where the app\'s entries are:',
        "  import { bespoke } from '@bespokecore/vite';",
        '  export default defineConfig({ plugins: [bespoke(), react()] });',
      ].join('\n'),
    );
  }
  return api.entries;
}

export interface ViteDevOptions {
  /** App root containing `index.html` and `vite.config.ts`. */
  root: string;
  /** SSR entry relative to `root`, exporting `render: SsrRender`. Defaults to the `bespoke()` plugin's entry. */
  ssrEntry?: string;
  /** Share the HTTP server so HMR runs on the app's port instead of a second one. Without one, no HMR (tests). */
  httpServer?: Server;
}

/**
 * Starts Vite in middleware mode. SSR modules run in Vite's module runner, so
 * view edits hot-reload without restarting the Node process.
 */
export async function createViteDevRenderer({ root, ssrEntry, httpServer }: ViteDevOptions): Promise<{
  vite: ViteDevServer;
  renderer: PageRenderer;
}> {
  // Imported lazily: production servers never load Vite.
  const { createServer, isRunnableDevEnvironment } = await importVite(root);

  let vite: ViteDevServer;
  try {
    vite = await createServer({
      root,
      // Node imports vite.config.ts directly. The default loader bundles it to a temporary
      // file first, which `node --watch` sees disappear and answers with a restart.
      configLoader: 'native',
      appType: 'custom',
      server: { middlewareMode: true, ...(httpServer ? { hmr: { server: httpServer } } : { hmr: false, ws: false }) },
    });
  } catch (error) {
    throw explainConfigError(error);
  }

  let entry: string;
  try {
    entry = ssrEntry ?? bespokeEntries(vite.config).ssr;
  } catch (error) {
    await vite.close();
    throw error;
  }

  const ssr = vite.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) {
    await vite.close();
    throw new Error('The Vite SSR environment is not runnable in this process.');
  }

  const renderer = createDocumentRenderer({
    template: async (request) => vite.transformIndexHtml(new URL(request.url).pathname, await readFile(join(root, 'index.html'), 'utf8')),
    // Through Vite's module runner on every request: an edited view renders without a restart.
    ssr: async () => (await ssr.runner.import<{ render: SsrRender }>(`/${entry}`)).render,
    // Stack traces of SSR errors point into the sources, not into Vite's transformed modules.
    fixStack: (error) => vite.ssrFixStacktrace(error as Error),
  });

  return { vite, renderer };
}
