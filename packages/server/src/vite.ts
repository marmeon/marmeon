import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Application } from '@marmeon/core';
import { channels } from '@marmeon/core/diagnostics';
import { messageBase, packageServerEntries, withCode } from '@marmeon/core/internal';
import type { SsrRender } from '@marmeon/http';
import { BROWSER_LOG_EVENT } from '@marmeon/http/protocol';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { acceptBrowserLog, BrowserLogLimiter, SHARED_BUDGET } from './browser-log.ts';
import { withDevBody } from './dev-document.ts';
import { devStyleTags, entryStylesheets } from './dev-styles.ts';
import { packageTemplate } from './documents.ts';
import { createDocumentRenderer, type EntryDocumentOptions, type PageRenderer } from './render.ts';

/** The app's Vite setup is incomplete: no `vite`, no `@marmeon/vite`, or no `marmeon()` plugin. The message says what to do. */
export class ViteSetupError extends Error {
  override name = 'ViteSetupError';
}

/** What `marmeon()` from `@marmeon/vite` exposes on its plugin (duck-typed: the server does not depend on that package). */
interface MarmeonPluginApi {
  entries: { client: string; ssr: string };
  /** The installed packages that declare a namespace: where each one's client entry is (absolute), if it has one. */
  surfaces?: readonly { namespace: string; entry?: { client: string } }[];
}

const INSTALL = 'pnpm add -D vite@^8 @marmeon/vite@<version of your app>';

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
  /** The app the browser reports (`browser.log`) belong to. Without one, the dev server listens for none. */
  app?: Application;
  /** Share the HTTP server so HMR runs on the app's port instead of a second one. Without one, no HMR (tests). */
  httpServer?: Server;
  /** Development HTML for the end of every document's body (`DevDocument`) — read per request. */
  devBody?: () => string;
  /** Development HTML for the end of every document's head (`DevDocument`: the devtools' bar, before the app's entry) — read per request. */
  devHead?: () => string;
  /** Link the stylesheets the client entry imports in each document's head, so a reload paints styled (`marmeon dev`). Off where no browser paints the document (page tests). */
  styles?: boolean;
}

/**
 * Starts Vite in middleware mode. SSR modules run in Vite's module runner, so
 * view edits hot-reload without restarting the Node process.
 */
export async function createViteDevRenderer({ root, ssrEntry, app, httpServer, devBody, devHead, styles }: ViteDevOptions): Promise<{
  vite: ViteDevServer;
  renderer: PageRenderer;
  /** The app's SSR entry's `render`, loaded through Vite's module runner — for what a document does not carry (a placeholder's markup). */
  ssr: () => Promise<SsrRender>;
}> {
  // Imported lazily: production servers never load Vite.
  const { createServer, isRunnableDevEnvironment, parseAst } = await importVite(root);

  let vite: ViteDevServer;
  try {
    vite = await createServer({
      root,
      // Node imports vite.config.ts directly. The default loader bundles it to a temporary
      // file first, which `node --watch` sees disappear and answers with a restart.
      configLoader: 'native',
      appType: 'custom',
      // The page's reports come in on the HMR WebSocket (from any script on the app's origin), so only where it runs (`marmeon dev`).
      ...(httpServer && app ? { plugins: [browserLogPlugin(app)] } : {}),
      // No CORS: Vite's default answers any page on localhost (any port) with `Access-Control-Allow-Origin` — on the app's answers
      // too (the devtools' API, mail previews, the error page). The app and its modules share one origin; nothing needs it.
      server: { middlewareMode: true, cors: false, ...(httpServer ? { hmr: { server: httpServer } } : { hmr: false, ws: false }) },
    });
  } catch (error) {
    throw explainConfigError(error);
  }

  let entry: string;
  let clientEntry: string | undefined;
  try {
    if (ssrEntry) {
      entry = ssrEntry;
      // An explicit SSR entry works without the plugin (tests): then there is no client entry to read the stylesheets from.
      if (styles && vite.config.plugins.some((plugin) => plugin.name === 'marmeon')) clientEntry = marmeonEntries(vite.config).client;
    } else {
      ({ ssr: entry, client: clientEntry } = marmeonEntries(vite.config));
    }
  } catch (error) {
    await vite.close();
    throw error;
  }

  const surfaces = (vite.config.plugins.find((plugin) => plugin.name === 'marmeon')?.api as MarmeonPluginApi | undefined)?.surfaces ?? [];
  const withEntry = surfaces.filter((surface) => surface.entry !== undefined);
  let serverEntries: ReadonlyMap<string, string> = new Map();
  if (withEntry.length > 0) {
    try {
      serverEntries = packageServerEntries({ root });
    } catch (error) {
      await vite.close();
      throw error;
    }
  }

  const ssr = vite.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) {
    await vite.close();
    throw new Error('The Vite SSR environment is not runnable in this process.');
  }

  const loadRender = async () => (await ssr.runner.import<{ render: SsrRender }>(`/${entry}`)).render;
  const imports = new WeakMap<object, readonly string[]>();
  const client = vite.environments.client;
  const stylesheets = async () =>
    styles && clientEntry !== undefined && client ? devStyleTags(await entryStylesheets(client, `/${clientEntry}`, { base: vite.config.base, parse: parseAst, imports })) : '';
  // The document of each package entry: the standard template with the entry served from where it lies (`/@fs`), which Vite transforms like the app's.
  const packages = new Map<string, EntryDocumentOptions>();
  for (const { namespace, entry } of withEntry) {
    const server = serverEntries.get(namespace);
    if (server === undefined) {
      await vite.close();
      throw new ViteSetupError(withCode('H16', `The package entry "${namespace}" has no server entry under the server's conditions.`));
    }
    const url = `/@fs${entry!.client}`;
    const packageStylesheets = async () =>
      styles && client ? devStyleTags(await entryStylesheets(client, url, { base: vite.config.base, parse: parseAst, imports })) : '';
    packages.set(namespace, {
      template: async (request) => {
        const [html, links] = await Promise.all([
          vite.transformIndexHtml(new URL(request.url).pathname, packageTemplate({ script: url, preloads: [], stylesheets: [] })),
          packageStylesheets(),
        ]);
        return withDevBody(html, devBody?.() ?? '', [links, devHead?.() ?? ''].filter(Boolean).join('\n'));
      },
      ssr: async () => (await ssr.runner.import<{ render: SsrRender }>(`/@fs${server}`)).render,
      version: `dev:${namespace}`,
    });
  }
  const renderer = createDocumentRenderer({
    ...(packages.size > 0 ? { packages, version: 'dev:app' } : {}),
    template: async (request) => {
      const [html, links] = await Promise.all([
        readFile(join(root, 'index.html'), 'utf8').then((template) => vite.transformIndexHtml(new URL(request.url).pathname, template)),
        stylesheets(),
      ]);
      // The links come first, ahead of the devtools' bar.
      return withDevBody(html, devBody?.() ?? '', [links, devHead?.() ?? ''].filter(Boolean).join('\n'));
    },
    // Through Vite's module runner on every request: an edited view renders without a restart.
    ssr: loadRender,
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

  return { vite, renderer, ssr: loadRender };
}

const browserLog = channels.event('browser.log');

/** What {@link listenForBrowserLogs} listens on: Vite's HMR channel of the client environment. */
export interface BrowserLogHot {
  on(event: string, listener: (data: unknown, client: object) => void): void;
}

/**
 * Publishes what a page reports on the HMR channel as `browser.log` — checked, and limited per HMR connection and across all of
 * them. `clock` is the limiters' time in ms (tests set it).
 */
export function listenForBrowserLogs(app: Application, hot: BrowserLogHot, clock: () => number = () => performance.now()): void {
  const limiters = new WeakMap<object, BrowserLogLimiter>();
  // Around every connection's own budget: many sockets of one origin do not add up to many budgets.
  const shared = new BrowserLogLimiter(SHARED_BUDGET);
  hot.on(BROWSER_LOG_EVENT, (data, client) => {
    let limiter = limiters.get(client);
    if (!limiter) limiters.set(client, (limiter = new BrowserLogLimiter()));
    const now = clock();
    const allowed = limiter.take(now);
    if (!allowed) return;
    if (!shared.take(now)) {
      limiter.hold(1);
      return;
    }
    if (!browserLog.hasSubscribers) return;
    const report = acceptBrowserLog(data);
    if (!report) return;
    browserLog.publish({ ...messageBase(app), ...report, ...(allowed.dropped > 0 ? { dropped: allowed.dropped } : {}) });
    limiter.reported();
  });
}

/** Registers the listener on every Vite server this config starts — Vite restarts in-process (`vite.restart()`, a changed `.env`) with a new HMR channel. */
function browserLogPlugin(app: Application): Plugin {
  return {
    name: 'marmeon:browser-log',
    configureServer(server) {
      const hot = server.environments.client?.hot;
      if (hot) listenForBrowserLogs(app, hot);
    },
  };
}
