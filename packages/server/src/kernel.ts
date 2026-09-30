import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Router } from '@bespokecore/router';
import { Hono } from 'hono';
import { createProductionRenderer } from './production.ts';
import { createResponseFactory, type PageRenderer } from './render.ts';
import { createViteDevRenderer } from './vite.ts';

export interface KernelOptions {
  renderer?: PageRenderer;
  /** Built client output (production). Only its `/assets/*` files are served. */
  clientDir?: string;
  /** Expose error stacks in responses (development). */
  debug?: boolean;
}

/**
 * The HTTP kernel: Hono does the URL matching, the BespokeCore router runs the
 * typed middleware pipeline and the action.
 */
export function createHttpKernel(router: Router, { renderer, clientDir, debug = false }: KernelOptions = {}): Hono {
  const app = new Hono();
  const toResponse = createResponseFactory(renderer);

  if (clientDir) {
    // serveStatic appends the request path to `root`, which it resolves against the working directory.
    app.use('/assets/*', serveStatic({ root: relative(process.cwd(), clientDir) }));
  }

  for (const route of router.routes) {
    app.on([...route.methods], route.path, (c) =>
      router.dispatch(route, { request: c.req.raw, params: c.req.param() }, toResponse),
    );
  }

  app.onError((error, c) => {
    console.error(error);
    return c.text(debug ? (error.stack ?? String(error)) : 'Internal Server Error', 500);
  });

  return app;
}

export interface ServeOptions {
  router: Router;
  /** App root containing `index.html` and `vite.config.ts`. */
  root: string;
  /** SSR entry relative to `root`, e.g. `bootstrap/ssr.tsx`. */
  ssrEntry: string;
  port?: number;
  mode?: 'development' | 'production';
}

export async function startServer({
  router,
  root,
  ssrEntry,
  port = 3000,
  mode = process.env.NODE_ENV === 'production' ? 'production' : 'development',
}: ServeOptions): Promise<Server> {
  const server = createServer();

  if (mode === 'development') {
    const { vite, renderer } = await createViteDevRenderer({ root, ssrEntry, httpServer: server });
    const handle = getRequestListener(createHttpKernel(router, { renderer, debug: true }).fetch);
    // Vite answers module, asset and HMR requests; everything else falls through to Hono.
    server.on('request', (req, res) => vite.middlewares(req, res, () => handle(req, res)));
    server.on('close', () => void vite.close());
  } else {
    const renderer = await createProductionRenderer({ root, ssrEntry });
    const kernel = createHttpKernel(router, { renderer, clientDir: join(root, 'dist/client') });
    server.on('request', getRequestListener(kernel.fetch));
  }

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`BespokeCore [${mode}] on http://localhost:${port} (${router.routes.length} routes)`);
      resolve(server);
    });
  });
}
