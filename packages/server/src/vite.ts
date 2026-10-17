import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withCode } from '@marmeon/core/internal';
import type { SsrRender } from '@marmeon/http';
import type { ResolvedConfig, ViteDevServer } from 'vite';
import { withDevBody } from './dev-document.ts';
import { createDocumentRenderer, type PageRenderer } from './render.ts';

/** The app's Vite setup is incomplete: no `vite`, no `@marmeon/vite`, or no `marmeon()` plugin. The message says what to do. */
export class ViteSetupError extends Error {
  override name = 'ViteSetupError';
}

/** What `marmeon()` from `@marmeon/vite` exposes on its plugin (duck-typed: the server does not depend on that package). */
interface MarmeonPluginApi {
  entries: { client: string; ssr: string };
}

const INSTALL = 'pnpm add -D vite@^8 @marmeon/vite';

/**
 * Imports the app's own Vite (resolved from `root`, not from the framework), which is an optional
 * peer: production servers never load it, `marmeon dev` and `marmeon build` need it.
 */
export async function importVite(root: string): Promise<typeof import('vite')> {
  // Only the app's node_modules chain counts, as for an ESM import: `require.resolve` would also search
  // NODE_PATH, which pnpm's bin shims point at the store's hoisted packages — finding a Vite the app lacks.
  if (!hasPackage(root, 'vite')) {
    throw new ViteSetupError(withCode('H5', `Vite is not installed in this app. \`marmeon dev\` and \`marmeon build\` need it: ${INSTALL}`));
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
 * package that is not installed (`Cannot find package '@marmeon/vite'` otherwise). Other errors pass through.
 */
export function explainConfigError(error: unknown): unknown {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  const missing = typeof message === 'string' ? /Cannot find (?:package|module) '(@marmeon\/vite)[^']*'/.exec(message) : null;
  if (code === 'ERR_MODULE_NOT_FOUND' && missing) {
    return new ViteSetupError(withCode('H5', `vite.config.ts imports ${missing[1]}, which is not installed in this app: ${INSTALL}`));
  }
  return error;
}

/** The entries of the app's `marmeon()` plugin, or a readable error if `vite.config.ts` does not use it. */
export function marmeonEntries(config: Pick<ResolvedConfig, 'plugins'>): MarmeonPluginApi['entries'] {
  const plugin = config.plugins.find((candidate) => candidate.name === 'marmeon');
  const api = plugin?.api as MarmeonPluginApi | undefined;
  if (!api?.entries) {
    throw new ViteSetupError(
      withCode(
        'H5',
        [
          'vite.config.ts does not use the marmeon() plugin, which tells the server where the app\'s entries are:',
          "  import { marmeon } from '@marmeon/vite';",
          '  export default defineConfig({ plugins: [marmeon(), react()] });',
        ].join('\n'),
      ),
    );
  }
  return api.entries;
}

export interface ViteDevOptions {
  /** App root containing `index.html` and `vite.config.ts`. */
  root: string;
  /** SSR entry relative to `root`, exporting `render: SsrRender`. Defaults to the `marmeon()` plugin's entry. */
  ssrEntry?: string;
  /** Share the HTTP server so HMR runs on the app's port instead of a second one. Without one, no HMR (tests). */
  httpServer?: Server;
  /** Development HTML for the end of every document's body (`DevDocument`) — read per request. */
  devBody?: () => string;
  /** Development HTML for the end of every document's head (`DevDocument`: the devtools' bar, before the app's entry) — read per request. */
  devHead?: () => string;
}

/**
 * Starts Vite in middleware mode. SSR modules run in Vite's module runner, so
 * view edits hot-reload without restarting the Node process.
 */
export async function createViteDevRenderer({ root, ssrEntry, httpServer, devBody, devHead }: ViteDevOptions): Promise<{
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
      // No CORS: Vite's default answers any page on localhost (any port) with `Access-Control-Allow-Origin` — on the app's answers
      // too (the devtools' API, mail previews, the error page). The app and its modules share one origin; nothing needs it.
      server: { middlewareMode: true, cors: false, ...(httpServer ? { hmr: { server: httpServer } } : { hmr: false, ws: false }) },
    });
  } catch (error) {
    throw explainConfigError(error);
  }

  let entry: string;
  try {
    entry = ssrEntry ?? marmeonEntries(vite.config).ssr;
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
    template: async (request) =>
      withDevBody(await vite.transformIndexHtml(new URL(request.url).pathname, await readFile(join(root, 'index.html'), 'utf8')), devBody?.() ?? '', devHead?.() ?? ''),
    // Through Vite's module runner on every request: an edited view renders without a restart.
    ssr: async () => (await ssr.runner.import<{ render: SsrRender }>(`/${entry}`)).render,
    // Stack traces of SSR errors point into the sources, not into Vite's transformed modules.
    fixStack: (error) => vite.ssrFixStacktrace(error as Error),
    // A page that could not render on the server: into Vite's overlay — to the tabs connected now (`hot.send`, which
    // Vite buffers only while no tab is connected) and into the failed document itself, which shows it once it loads.
    failed: async (error, { solutions, redactor, nonce }) => {
      const { overlayError, overlayScript } = await import('./error-page/overlay.ts');
      const err = overlayError(error, root, redactor, solutions);
      vite.environments.client?.hot.send({ type: 'error', err });
      return overlayScript(err, nonce);
    },
  });

  return { vite, renderer };
}
