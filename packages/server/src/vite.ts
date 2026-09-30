import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { SsrRender } from '@bespokecore/http';
import type { ViteDevServer } from 'vite';
import { renderDocument } from './html.ts';
import type { PageRenderer } from './render.ts';

export interface ViteDevOptions {
  /** App root containing `index.html` and `vite.config.ts`. */
  root: string;
  /** SSR entry relative to `root`, exporting `render: SsrRender`. */
  ssrEntry: string;
  /** Share the HTTP server so HMR runs on the app's port instead of a second one. */
  httpServer: Server;
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
  const { createServer, isRunnableDevEnvironment } = await import('vite');

  const vite = await createServer({
    root,
    appType: 'custom',
    server: { middlewareMode: true, hmr: { server: httpServer } },
  });

  const ssr = vite.environments.ssr;
  if (!ssr || !isRunnableDevEnvironment(ssr)) {
    throw new Error('The Vite SSR environment is not runnable in this process.');
  }

  const renderer: PageRenderer = {
    async render(page, request) {
      const template = await vite.transformIndexHtml(
        new URL(request.url).pathname,
        await readFile(join(root, 'index.html'), 'utf8'),
      );
      const { render } = await ssr.runner.import<{ render: SsrRender }>(`/${ssrEntry}`);
      return renderDocument(template, page, await render(page));
    },
  };

  return { vite, renderer };
}
