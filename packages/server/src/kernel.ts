import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Application, Container } from '@bespokecore/core';
import { Router } from '@bespokecore/router';
import { Hono } from 'hono';
import { createProductionRenderer } from './production.ts';
import { createResponseFactory, type PageRenderer } from './render.ts';
import { createViteDevRenderer } from './vite.ts';

export interface KernelOptions {
  /** Override the application's container (tests). Every request gets its own scope of it. */
  container?: Container;
  renderer?: PageRenderer;
  /** Built client output (production). Only its `/assets/*` files are served. */
  clientDir?: string;
  /** Expose error stacks in responses (development). */
  debug?: boolean;
}

/**
 * The HTTP kernel: Hono does the URL matching, the BespokeCore router runs the
 * typed middleware pipeline and the action. Controllers and middleware classes
 * are resolved from a fresh container scope per request.
 */
export function createHttpKernel(
  application: Application,
  { container = application.container, renderer, clientDir, debug = false }: KernelOptions = {},
): Hono {
  const router = application.container.make(Router);
  const app = new Hono();
  const toResponse = createResponseFactory(renderer);

  if (clientDir) {
    // serveStatic appends the request path to `root`, which it resolves against the working directory.
    app.use('/assets/*', serveStatic({ root: relative(process.cwd(), clientDir) }));
  }

  for (const route of router.routes) {
    app.on([...route.methods], route.path, (c) => {
      const scope = container.createScope();
      return router.dispatch(
        route,
        { request: c.req.raw, params: c.req.param() },
        { toResponse, resolve: (Class) => scope.make(Class) },
      );
    });
  }

  app.onError((error, c) => {
    console.error(error);
    return c.text(debug ? (error.stack ?? String(error)) : 'Internal Server Error', 500);
  });

  return app;
}

export interface ServeOptions {
  app: Application;
  /** SSR entry relative to `root`, e.g. `bootstrap/ssr.tsx`. */
  ssrEntry: string;
  port?: number;
  mode?: 'development' | 'production';
}

export async function startServer({
  app,
  ssrEntry,
  port = 3000,
  mode = process.env.NODE_ENV === 'production' ? 'production' : 'development',
}: ServeOptions): Promise<Server> {
  const server = createServer();
  const { root } = app;

  if (mode === 'development') {
    const { vite, renderer } = await createViteDevRenderer({ root, ssrEntry, httpServer: server });
    const handle = getRequestListener(createHttpKernel(app, { renderer, debug: true }).fetch);
    // Vite answers module, asset and HMR requests; everything else falls through to Hono.
    server.on('request', (req, res) => vite.middlewares(req, res, () => handle(req, res)));
    server.on('close', () => void vite.close());
  } else {
    const renderer = await createProductionRenderer({ root, ssrEntry });
    const kernel = createHttpKernel(app, { renderer, clientDir: join(root, 'dist/client') });
    server.on('request', getRequestListener(kernel.fetch));
  }

  return new Promise((resolve) => {
    server.listen(port, () => {
      const routes = app.container.make(Router).routes.length;
      const packages = app.packages.length ? `, packages: ${app.packages.join(', ')}` : '';
      console.log(`BespokeCore [${mode}] on http://localhost:${port} (${routes} routes, ${app.modules.length} modules${packages})`);
      resolve(server);
    });
  });
}
