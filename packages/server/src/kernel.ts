import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomUUID } from 'node:crypto';
import { Logger, runWithRequest, type Application, type Container } from '@bespokecore/core';
import { AfterResponse, AssetVersion, ExceptionHandler, HttpError } from '@bespokecore/http';
import {
  clientIp,
  CookieJar,
  createRequestState,
  Router,
  withQueuedCookies,
  type DispatchOptions,
  type HttpContext,
  type MiddlewareHandler,
  type RequestState,
} from '@bespokecore/router';
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
  /** Largest accepted request body in bytes. Defaults to `ServerConfig.maxBodySize` (env `MAX_BODY_SIZE`), else 8 MiB. */
  maxBodySize?: number;
  /** Asset version for 409 reloads. Defaults to `ASSET_VERSION`, else the renderer's (the build's), else none. */
  version?: string | null;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

type OnTerminable = NonNullable<DispatchOptions['onTerminable']>;

/** The Hono app, plus a way to wait for `terminate` work (tests do, so they stay deterministic). */
export type HttpKernel = Hono & {
  /** Resolves once every `terminate` hook scheduled so far has run. */
  settle(): Promise<void>;
};

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
  {
    container = application.container,
    renderer,
    clientDir,
    debug = false,
    maxBodySize = container.has(ServerConfig) ? container.make(ServerConfig).maxBodySize : undefined,
    version = (container.has(ServerConfig) ? container.make(ServerConfig).assetVersion : undefined) ?? renderer?.version ?? null,
  }: KernelOptions = {},
): HttpKernel {
  const router = application.container.make(Router);
  const logger = container.make(Logger).child({ channel: 'http' });
  container.instance(AssetVersion, { value: version });
  const trustedProxies = container.has(ServerConfig) ? container.make(ServerConfig).trustedProxies : [];
  const toResponse = createResponseFactory(renderer, router, version);
  const app = new Hono();

  const renderError = async (error: unknown, request: Request, scope?: Container): Promise<Response> => {
    const handler = container.make(ExceptionHandler);
    handler.report(error);
    try {
      return await toResponse(handler.render(error, request, { debug }), { request }, scope);
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

  const pending = new Set<Promise<void>>();

  /** Runs one request: a fresh container scope, the request state, terminate hooks after the response. */
  const handle = async (
    request: Request,
    remote: string | undefined,
    run: (scope: Container, state: RequestState, onTerminable: OnTerminable) => Promise<Response>,
  ) => {
    const scope = container.createScope();
    const ip = clientIp(remote, request.headers.get('x-forwarded-for'), trustedProxies);
    const state = createRequestState(request, { maxBodySize, ip });
    scope.instance(CookieJar, state.cookies); // injectable per request, e.g. into a cookie session driver
    const terminable: [MiddlewareHandler<any, any>, HttpContext][] = [];

    let response: Response;
    try {
      response = await run(scope, state, (handler, ctx) => terminable.push([handler, ctx]));
    } catch (error) {
      response = await renderError(error, request, scope);
    }
    // Cookies queued during the request reach the client whatever the outcome (like Laravel).
    const final = await withQueuedCookies(response, state.cookies);

    if (terminable.length > 0) {
      // After the response is handed to the server — the client does not wait for this work.
      const task = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => Promise.all(terminable.map(([handler, ctx]) => handler.terminate!(ctx, final))))
        .then(
          () => undefined,
          (error: unknown) => logger.error('A terminate hook failed', { exception: String(error) }),
        );
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    // `afterResponse.defer(…)` work: also after the response, one task after the other.
    const deferred = scope.has(AfterResponse) ? scope.make(AfterResponse).take() : [];
    if (deferred.length > 0) {
      const task = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        for (const work of deferred) {
          try {
            await work();
          } catch (error) {
            logger.error('Deferred work failed', { exception: error instanceof Error ? (error.stack ?? error.message) : String(error) });
          }
        }
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
    return final;
  };

  for (const route of router.routes) {
    app.on([...route.methods], route.path, (c) =>
      handle(c.req.raw, remoteAddress(c.env), (scope, state, onTerminable) =>
        router.dispatch(
          route,
          { request: c.req.raw, params: c.req.param() },
          {
            toResponse: (result, ctx) => toResponse(result, ctx, scope),
            resolve: (Class) => scope.make(Class),
            state,
            onTerminable,
            onError: (error) => renderError(error, c.req.raw, scope),
          },
        ),
      ),
    );
  }

  // Unknown paths still pass the global middleware, then end in the exception handler's 404.
  app.notFound((c) =>
    handle(c.req.raw, remoteAddress(c.env), (scope, state, onTerminable) =>
      router.dispatchNotFound(c.req.raw, {
        resolve: (Class) => scope.make(Class),
        state,
        onTerminable,
        onError: (error) => renderError(error, c.req.raw, scope),
      }),
    ),
  );
  app.onError((error, c) => renderError(error, c.req.raw));

  return Object.assign(app, {
    settle: async () => {
      while (pending.size > 0) await Promise.all(pending);
    },
  });
}


/** The peer address from @hono/node-server's bindings; undefined for in-process requests (tests). */
function remoteAddress(env: unknown): string | undefined {
  return (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export interface ServeOptions {
  app: Application;
  /** SSR entry relative to `root`, e.g. `bootstrap/ssr.tsx`. */
  ssrEntry: string;
  /** Defaults to `ServerConfig.port` (env `PORT`). */
  port?: number;
  mode?: 'development' | 'production';
}

/** A listening server. `close()` stops it gracefully: no new connections, requests in flight finish. */
export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export async function startServer({
  app,
  ssrEntry,
  port = app.container.has(ServerConfig) ? app.container.make(ServerConfig).port : 3000,
  mode = process.env.NODE_ENV === 'production' ? 'production' : 'development',
}: ServeOptions): Promise<RunningServer> {
  const server = createServer();
  const { root } = app;
  let closeVite: (() => Promise<void>) | undefined;

  if (mode === 'development') {
    const { vite, renderer } = await createViteDevRenderer({ root, ssrEntry, httpServer: server });
    const handle = getRequestListener(createHttpKernel(app, { renderer, debug: true }).fetch);
    // Vite answers module, asset and HMR requests; everything else falls through to Hono.
    server.on('request', (req, res) => vite.middlewares(req, res, () => handle(req, res)));
    closeVite = () => vite.close();
  } else {
    const renderer = await createProductionRenderer({ root, ssrEntry });
    const kernel = createHttpKernel(app, { renderer, clientDir: join(root, 'dist/client') });
    server.on('request', getRequestListener(kernel.fetch));
  }

  const close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    // Vite's HMR WebSocket is an upgraded socket: neither `close()` nor `closeAllConnections()` ends it,
    // so the server would wait forever for an open browser tab. Closing Vite closes its clients.
    await closeVite?.();
    await closed;
  };

  return new Promise((resolve) => {
    server.listen(port, () => {
      const routes = app.container.make(Router).routes.length;
      const packages = app.packages.length ? `, packages: ${app.packages.join(', ')}` : '';
      app.container
        .make(Logger)
        .info(`BespokeCore [${mode}] on http://localhost:${port} (${routes} routes, ${app.modules.length} modules${packages})`);
      resolve({ server, port, close });
    });
  });
}
