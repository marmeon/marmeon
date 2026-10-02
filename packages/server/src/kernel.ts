import { createServer, type Server } from 'node:http';
import { join, relative } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomUUID } from 'node:crypto';
import { Logger, runWithRequest, Translator, type Application, type Container } from '@bespokecore/core';
import {
  AfterResponse,
  AssetVersion,
  ExceptionHandler,
  HttpError,
  isActionRequest,
  isViewResult,
  LOCATION_HEADER,
  PAGE_HEADER,
  ParentRequest,
  ReadOnly,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  regionOf,
  ResponseLifecycle,
  VERSION_HEADER,
  isPageObject,
  type PageObject,
  type RegionObject,
  type RegionResult,
} from '@bespokecore/http';
import {
  clientIp,
  CookieJar,
  createRequestState,
  isLiveValidation,
  liveValidationFields,
  VALIDATED_HEADER,
  Router,
  withQueuedCookies,
  type DispatchOptions,
  type HttpContext,
  type MiddlewareHandler,
  type RequestState,
  ValidationError,
} from '@bespokecore/router';
import { Hono } from 'hono';
import { overrideMethod } from './method-override.ts';
import { createProductionRenderer } from './production.ts';
import { createResponseFactory, toActionResponse, toLiveValidationResponse, toRegionResponse, type LayerBaseResult, type PageRenderer } from './render.ts';
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
  /** Server rendering (default: `ServerConfig.ssr`, env `SSR_ENABLED`, on). Off: every page goes out without markup, the browser renders it. */
  ssr?: boolean;
  /**
   * What a write in a read-only request (an island's, E52) does: throw (`true`, the default outside production — the
   * mistake shows where it is made) or get dropped and logged (`false`, production — the island and its page stay whole).
   */
  strictReadOnly?: boolean;
  /** How long an island resolved in-process may take before it shows its `exception` fallback (ms, default 10 s). */
  islandTimeout?: number;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

/** The page request an island resolved in-process belongs to (E49) — what `handle` gives the island's request. */
interface IslandParent {
  readonly request: Request;
  readonly scope: Container;
  readonly requestId: string | undefined;
}

/**
 * What an island's request takes over from its page's request (E49) — as the browser would send them with its own
 * request: the cookies (the session's id, a remember-me token), the languages, the client and proxy headers. Nothing
 * that is about the page's own request (its body, `Purpose`, partial reloads).
 */
const ISLAND_HEADERS = ['cookie', 'accept-language', 'user-agent', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port'];

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
    ssr = container.has(ServerConfig) ? container.make(ServerConfig).ssr : true,
    strictReadOnly = process.env.NODE_ENV !== 'production',
    islandTimeout = 10_000,
  }: KernelOptions = {},
): HttpKernel {
  const router = application.container.make(Router);
  const logger = container.make(Logger).child({ channel: 'http' });
  container.instance(AssetVersion, { value: version });
  const trustedProxies = container.has(ServerConfig) ? container.make(ServerConfig).trustedProxies : [];
  const app = new Hono();
  /** The client address of each request in flight — what an island resolved for it is from, too. */
  const addresses = new WeakMap<Request, string | undefined>();

  /**
   * An island, resolved in-process while its page renders (E49): a GET of its URL with the page request's cookies and
   * headers plus `x-bespoke-region: island`, matched by Hono and run through the island route's own middleware and
   * authorization — in a scope of its own, read-only (E52), its session a copy of the page's. What it answers becomes
   * the island's outcome, as for the browser's request (`toRegionResponse`); a 409 — the document is out of date — is
   * left to the browser, whose request reloads the page.
   */
  const dispatchIsland = async (url: string, parent: IslandParent): Promise<RegionResult> => {
    const base = new URL(parent.request.url);
    const target = new URL(url, base);
    if (target.origin !== base.origin) {
      logger.error(`An island comes from this site, not from ${target.origin} (${url})`);
      return { status: 'exception', failure: {} };
    }
    const headers = new Headers();
    for (const name of ISLAND_HEADERS) {
      const value = parent.request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set(PAGE_HEADER, 'true');
    headers.set(REGION_HEADER, 'island');
    if (version) headers.set(VERSION_HEADER, version);
    if (parent.requestId) headers.set('x-request-id', parent.requestId);
    const timeout = AbortSignal.timeout(islandTimeout);
    const signal = AbortSignal.any([parent.request.signal, timeout]);
    const request = new Request(target, { method: 'GET', headers, signal });
    const timedOut = new Promise<'timeout'>((resolve) => timeout.addEventListener('abort', () => resolve('timeout'), { once: true }));
    try {
      const response = await Promise.race([app.fetch(request, { parent }), timedOut]);
      if (response === 'timeout') {
        logger.error(`The island ${target.pathname}${target.search} took longer than ${islandTimeout} ms — it shows its error`);
        return { status: 'exception', failure: { status: 504, ...(debug ? { message: `The island took longer than ${islandTimeout} ms.` } : {}) } };
      }
      return await regionResultOf(response);
    } catch (error) {
      logger.error(`Resolving the island ${target.pathname}${target.search} failed`, { exception: String(error) });
      return { status: 'exception', failure: {} };
    }
  };

  /**
   * The base of a layer whose URL was loaded as a document (E53): a GET of its URL as a layer's client would send it
   * (`x-bespoke`, `x-bespoke-region: layer`) with the page request's cookies and headers, run in-process through the base
   * route's own middleware and authorization — read-only, its session a copy of the request's. Its page object, or what kept
   * it from showing one: a redirect, 401 or 403 (E54: the layer shows alone), anything else.
   */
  const dispatchLayerBase = async (url: string, parent: IslandParent): Promise<LayerBaseResult> => {
    const origin = new URL(parent.request.url);
    const target = new URL(url, origin);
    if (target.origin !== origin.origin) return { status: 'unavailable', httpStatus: 400 };
    const headers = new Headers();
    for (const name of ISLAND_HEADERS) {
      const value = parent.request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set(PAGE_HEADER, 'true');
    headers.set(REGION_HEADER, 'layer');
    if (version) headers.set(VERSION_HEADER, version);
    if (parent.requestId) headers.set('x-request-id', parent.requestId);
    const request = new Request(target, { method: 'GET', headers, signal: parent.request.signal });
    try {
      const response = await app.fetch(request, { parent });
      if (response.status === 200 && response.headers.get(PAGE_HEADER) === 'true') {
        const page: unknown = await response.json();
        if (isPageObject(page)) return { status: 'page', page: page as PageObject };
        return { status: 'unavailable', httpStatus: 500 };
      }
      await response.body?.cancel();
      return { status: 'unavailable', httpStatus: response.status };
    } catch (error) {
      logger.error(`Resolving the layer base ${target.pathname}${target.search} failed`, { exception: String(error) });
      return { status: 'unavailable', httpStatus: 500 };
    }
  };

  const toResponse = createResponseFactory(renderer, router, version, {
    logger: container.make(Logger).child({ channel: 'ssr' }),
    ssr,
    debug,
    islands: dispatchIsland,
    layerBases: dispatchLayerBase,
  });

  const renderError = async (error: unknown, request: Request, scope?: Container): Promise<Response> => {
    const handler = container.make(ExceptionHandler);
    if (isLiveValidation(request)) return renderLiveValidationError(handler, error, request, scope);
    handler.report(error);
    if (regionOf(request) === 'island') return renderRegionError(handler, error, request, scope);
    try {
      // In the request's language, when a translator is bound (@bespokecore/i18n) — the error page, its title, validation messages.
      const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
      return await toResponse(handler.render(error, request, { debug, translator }), { request }, scope);
    } catch (failure) {
      // Building the error page failed too — most likely a shared prop (the database is down). Once more without
      // the request's scope, so with the error's own props only; server rendering failing is no reason (the browser
      // renders the page then). Only if even that fails: a plain answer rather than none.
      logger.error('Rendering the error response failed', { exception: String(failure) });
      try {
        return await toResponse(handler.render(error, request, { debug }), { request });
      } catch {
        return new Response('Server Error', { status: 500 });
      }
    }
  };

  /**
   * An error in an island's request (E52): no error page — the island shows its fallback. JSON with the status (and, in
   * development, the exception), which `toRegionResponse` marks as the island's `exception`.
   */
  const renderRegionError = (handler: ExceptionHandler, error: unknown, request: Request, scope?: Container): Response => {
    try {
      const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
      // Never back to a form with the errors flashed (that would write the session): the island has no form.
      const result = error instanceof ValidationError ? Response.json({ message: error.message }, { status: 422 }) : handler.render(error, request, { debug, translator });
      if (result instanceof Response) return result;
      if (isViewResult(result)) return Response.json(result.props, { status: result.status, headers: result.headers });
    } catch (failure) {
      logger.error('Rendering the error of an island failed', { exception: String(failure) });
    }
    return Response.json({ message: 'Server Error' }, { status: error instanceof HttpError ? error.status : 500 });
  };

  /**
   * What a live validation (E62) answers when it does not pass: `422` with the named fields' errors in the request's language —
   * JSON, never a page and never back to the form (that would write the session) — or the failure (403, 419, 429, …) as JSON.
   */
  const renderLiveValidationError = (handler: ExceptionHandler, error: unknown, request: Request, scope?: Container): Response => {
    const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
    if (error instanceof ValidationError) {
      const { message, errors } = translator ? error.translate(translator) : error;
      return Response.json({ message, errors }, { status: 422, headers: { [VALIDATED_HEADER]: (liveValidationFields(request) ?? []).join(',') } });
    }
    handler.report(error);
    return renderRegionError(handler, error, request, scope);
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
    parent?: IslandParent,
  ) => {
    const scope = container.createScope();
    // An island resolved in-process is from where its page's request is from.
    const ip = parent ? addresses.get(parent.request) : clientIp(remote, request.headers.get('x-forwarded-for'), trustedProxies);
    addresses.set(request, ip);
    const state = createRequestState(request, { maxBodySize, ip });
    scope.instance(CookieJar, state.cookies); // injectable per request, e.g. into a cookie session driver
    const terminable: [MiddlewareHandler<any, any>, HttpContext][] = [];
    // An island's request is read-only (E52): no session write, no cookie, no work after the response — and so is every
    // request resolved in-process for another (an island while its page renders, a layer's base for its deep link).
    const island = regionOf(request) === 'island';
    // A live validation (E62) checks input and changes nothing: read-only like an island — no session write (its flash data
    // stays), no cookie, no work after the response; its controller never runs.
    const live = isLiveValidation(request);
    const { pathname } = new URL(request.url);
    const readOnly = scope.has(ReadOnly) ? scope.make(ReadOnly) : undefined;
    if ((island || parent || live) && readOnly) {
      const reason = live
        ? `a live validation (${request.method} ${pathname})`
        : island
          ? `an island request (${request.method} ${pathname})`
          : `a layer's base, resolved for its deep link (${request.method} ${pathname})`;
      const rule = live
        ? 'a live validation is read-only (E62) — it checks the input and changes nothing: no session, cookies or flash data, no work after the response. Middleware with side effects skips them for it.'
        : undefined;
      readOnly.engage({ reason, strict: strictReadOnly, report: (message) => logger.error(message), ...(rule ? { rule } : {}) });
      state.cookies.lock((what) => readOnly.permit(what));
      if (scope.has(AfterResponse)) scope.make(AfterResponse).lock((what) => readOnly.permit(what));
    }
    // Resolved while its page renders (E49): its session is a copy of the page request's (`StartSession`).
    if (parent && scope.has(ParentRequest)) scope.make(ParentRequest).adopt(parent.request, parent.scope);

    let response: Response;
    try {
      response = await run(scope, state, (handler, ctx) => terminable.push([handler, ctx]));
    } catch (error) {
      response = await renderError(error, request, scope);
    }
    // Redirects, 401 and 403 of an island become its fallback — never a navigation of the page.
    if (island) response = await toRegionResponse(response);
    // A live validation's answer is never cached, and a redirect of its route (a guest-only page) is reported, not followed.
    else if (live) response = await toLiveValidationResponse(response);
    // An action's redirect is reported, not followed — and its answer is never cached (E59).
    else if (isActionRequest(request)) response = await toActionResponse(response);
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
    // The headers are out (the session saved, its cookie set): what still runs in this request — a server-rendered page
    // streams on, computing its deferred props (E49) — cannot change the session, cookies or work after the response.
    if (!island && !parent && readOnly) {
      readOnly.engage({
        reason: `${request.method} ${pathname} after its response headers were sent (a deferred prop, streamed with the page)`,
        strict: strictReadOnly,
        report: (message) => logger.error(message),
      });
      state.cookies.lock((what) => readOnly.permit(what));
      if (scope.has(AfterResponse)) scope.make(AfterResponse).lock((what) => readOnly.permit(what));
    }
    if (scope.has(ResponseLifecycle)) scope.make(ResponseLifecycle).markHeadersSent();
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
        islandParent(c.env),
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
      islandParent(c.env),
    ),
  );
  app.onError((error, c) => renderError(error, c.req.raw));

  // A plain HTML form's PUT, PATCH or DELETE (`_method` in its POST body, E64) is routed as that method.
  const dispatch = app.fetch;
  app.fetch = async (request, env, executionContext) => dispatch(await overrideMethod(request, maxBodySize), env, executionContext);

  return Object.assign(app, {
    settle: async () => {
      while (pending.size > 0) await Promise.all(pending);
    },
  });
}


/** The page request of an island resolved in-process (`app.fetch(request, { parent })`, E49) — never set from outside. */
function islandParent(env: unknown): IslandParent | undefined {
  return (env as { parent?: IslandParent } | undefined)?.parent;
}

/** What an island's request answered (after `toRegionResponse`), as the outcome streamed with the page (E49). */
async function regionResultOf(response: Response): Promise<RegionResult> {
  if (response.ok && response.headers.get(REGION_HEADER) === 'island') return { status: 'ready', region: (await response.json()) as RegionObject };
  // A new build or a document change: the browser's request of the island reloads the page (as on a client-side visit).
  if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {
    await response.body?.cancel();
    return { status: 'browser' };
  }
  const outcome = response.headers.get(REGION_STATUS_HEADER);
  if (outcome === 'unauthorized' || outcome === 'forbidden') {
    await response.body?.cancel();
    return { status: outcome };
  }
  let message: string | undefined;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // No JSON: the status says enough.
  }
  return { status: 'exception', failure: { status: response.status, ...(message === undefined ? {} : { message }) } };
}

/** The peer address from @hono/node-server's bindings; undefined for in-process requests (tests). */
function remoteAddress(env: unknown): string | undefined {
  return (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export interface ServeOptions {
  app: Application;
  /** Development: SSR entry relative to `root`. Defaults to the entry of the `bespoke()` Vite plugin. */
  ssrEntry?: string;
  /** Defaults to `ServerConfig.port` (env `PORT`). */
  port?: number;
  mode?: 'development' | 'production';
  /**
   * How long `close()` waits for work after the responses — `afterResponse.defer(…)` tasks, `terminate` hooks — before
   * it gives up on them (default 8 s; `bespoke serve` exits after 10 s at the latest).
   */
  drainTimeoutMs?: number;
}

/**
 * A listening server. `close()` stops it gracefully: no new connections, requests in flight finish, and then the work
 * they deferred until after their response (a reset mail sent by `afterResponse.defer`) finishes too — before the app
 * shuts down and closes its pools (E102).
 */
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
  drainTimeoutMs = 8_000,
}: ServeOptions): Promise<RunningServer> {
  const server = createServer();
  const { root } = app;
  let closeVite: (() => Promise<void>) | undefined;
  let kernel: HttpKernel;

  if (mode === 'development') {
    const { vite, renderer } = await createViteDevRenderer({ root, ssrEntry, httpServer: server });
    kernel = createHttpKernel(app, { renderer, debug: true });
    const handle = getRequestListener(kernel.fetch);
    // Vite answers module, asset and HMR requests; everything else falls through to Hono.
    server.on('request', (req, res) => vite.middlewares(req, res, () => handle(req, res)));
    closeVite = () => vite.close();
  } else {
    const renderer = await createProductionRenderer({ root });
    kernel = createHttpKernel(app, { renderer, clientDir: join(root, 'dist/client') });
    server.on('request', getRequestListener(kernel.fetch));
  }

  const close = async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    // Vite's HMR WebSocket is an upgraded socket: neither `close()` nor `closeAllConnections()` ends it,
    // so the server would wait forever for an open browser tab. Closing Vite closes its clients.
    await closeVite?.();
    await closed;
    // The requests are answered; what they deferred until after their response (a mail, a terminate hook) still runs —
    // and needs the app's pools, which the caller closes next (E102). Bounded: a hanging task must not block the exit.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      kernel.settle().then(() => true),
      new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), drainTimeoutMs))),
    ]);
    clearTimeout(timer);
    if (!settled) app.container.make(Logger).warn(`Work after responses still ran ${drainTimeoutMs} ms after the server closed; shutting down anyway`);
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
