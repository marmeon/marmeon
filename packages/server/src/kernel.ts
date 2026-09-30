import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomUUID } from 'node:crypto';
import { Logger, runWithRequest, type Application, type Container } from '@bespokecore/core';
import { ExceptionHandler, HttpError } from '@bespokecore/http';
import { Router } from '@bespokecore/router';
import { Hono } from 'hono';
import { createProductionRenderer } from './production.ts';
import { createResponseFactory, type PageRenderer } from './render.ts';
import { ServerConfig } from './provider.ts';
import { createViteDevRenderer } from './vite.ts';

export interface KernelOptions {
  /** Override the application's container (tests). Every request gets its own scope of it. */
  container?: Container;
  renderer?: PageRenderer;
  /** Built client output (production). Only its `/assets/*` files are served. */
  clientDir?: string;
  /** Show exception details on error pages and in JSON errors (development). */
  debug?: boolean;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

/**
 * The HTTP kernel: Hono does the URL matching, the BespokeCore router runs the
 * typed middleware pipeline and the action. Controllers and middleware classes
 * are resolved from a fresh container scope per request.
 *
 * Every request gets a request id (from `x-request-id` or generated) that all log
 * entries of the request carry, and every error — thrown, `abort()`ed or an
 * unknown route — goes through the application's `ExceptionHandler`.
 */
export function createHttpKernel(
  application: Application,
  { container = application.container, renderer, clientDir, debug = false }: KernelOptions = {},
): Hono {
  const router = application.container.make(Router);
  const logger = container.make(Logger).child({ channel: 'http' });
  const toResponse = createResponseFactory(renderer);
  const app = new Hono();

  const renderError = async (error: unknown, request: Request): Promise<Response> => {
    const handler = container.make(ExceptionHandler);
    handler.report(error);
    try {
      return await toResponse(handler.render(error, request, { debug }), { request });
    } catch (failure) {
      // Rendering the error page failed too — answer without it rather than not at all.
      logger.error('Rendering the error response failed', { exception: String(failure) });
      return new Response('Server Error', { status: 500 });
    }
  };

  app.use(async (c, next) => {
    const header = c.req.header('x-request-id');
    const requestId = header && REQUEST_ID.test(header) ? header : randomUUID();
    const started = performance.now();

    await runWithRequest({ requestId }, async () => {
      await next();
      logger.info(`${c.req.method} ${c.req.path} ${c.res.status}`, { ms: Math.round(performance.now() - started) });
    });

    // Some responses (e.g. Response.redirect) have immutable headers — copy before setting.
    c.res = new Response(c.res.body, c.res);
    c.res.headers.set('x-request-id', requestId);
  });

  if (clientDir) {
    // serveStatic appends the request path to `root`, which it resolves against the working directory.
    app.use('/assets/*', serveStatic({ root: relative(process.cwd(), clientDir) }));
  }

  for (const route of router.routes) {
    app.on([...route.methods], route.path, async (c) => {
      const scope = container.createScope();
      try {
        return await router.dispatch(
          route,
          { request: c.req.raw, params: c.req.param() },
          { toResponse, resolve: (Class) => scope.make(Class) },
        );
      } catch (error) {
        return renderError(error, c.req.raw);
      }
    });
  }

  app.notFound((c) => renderError(new HttpError(404), c.req.raw));
  app.onError((error, c) => renderError(error, c.req.raw));

  return app;
}

export interface ServeOptions {
  app: Application;
  /** SSR entry relative to `root`, e.g. `bootstrap/ssr.tsx`. */
  ssrEntry: string;
  /** Defaults to `ServerConfig.port` (env `PORT`). */
  port?: number;
  mode?: 'development' | 'production';
}

export async function startServer({
  app,
  ssrEntry,
  port = app.container.has(ServerConfig) ? app.container.make(ServerConfig).port : 3000,
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
      app.container
        .make(Logger)
        .info(`BespokeCore [${mode}] on http://localhost:${port} (${routes} routes, ${app.modules.length} modules${packages})`);
      resolve(server);
    });
  });
}
