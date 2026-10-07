import cluster from 'node:cluster';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { heldOnLoopback } from './loopback.ts';
import { getRequestListener } from '@hono/node-server';
import { randomUUID } from 'node:crypto';
import { currentRequest, environment, ErrorSolutions, Logger, outsideTransaction, Redactor, runWithRequest, Translator, type Application, type Container, type RequestInfo as RequestContext } from '@marmeon/core';
import { channels, messageBase, trace, type HttpRequestMessage, type PageSummary } from '@marmeon/core/diagnostics';
import {
  AfterResponse,
  AssetVersion,
  CookieDefaults,
  ERROR_PAGE,
  ExceptionHandler,
  HttpError,
  IncomingRequest,
  RequestInfo,
  isActionRequest,
  isViewResult,
  LIVE_PATH,
  LOCATION_HEADER,
  PAGE_HEADER,
  ParentRequest,
  ReadOnly,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  RELOAD_HEADER,
  regionOf,
  ResponseLifecycle,
  ServerClosing,
  SESSION_PATH,
  UPLOAD_HEADER,
  VERSION_HEADER,
  isPageObject,
  partialReloadOf,
  type PageObject,
  type PropOrigins,
  type RegionObject,
  type RegionResult,
} from '@marmeon/http';
import {
  clientIp,
  CookieJar,
  createRequestState,
  editableResponse,
  isLiveValidation,
  RequestNonce,
  liveValidationFields,
  VALIDATED_HEADER,
  Router,
  withQueuedCookies,
  type RouteDefinition,
  type DispatchOptions,
  type HttpContext,
  type MiddlewareHandler,
  type RequestState,
  ValidationError,
} from '@marmeon/router';
import { Hono } from 'hono';
import { overrideMethod } from './method-override.ts';
import { createProductionRenderer } from './production.ts';
import { createResponseFactory, toActionResponse, toLiveValidationResponse, toRegionResponse, type LayerBaseResult, type PageRenderer } from './render.ts';
import { DevDocument } from './dev-document.ts';
import { DevRequestRecorder } from './error-page/recorder-token.ts';
import { checkHealthPaths, createHealthEndpoints } from './health.ts';
import { ServerConfig } from './provider.ts';
import { forwardedRequest, proxyMatcher } from './proxies.ts';
import { serveAssets } from './assets.ts';
import { ServerTiming } from './server-timing.ts';
import { createViteDevRenderer } from './vite.ts';

export interface KernelOptions {
  /** Override the application's container (tests). Every request gets its own scope of it. */
  container?: Container;
  renderer?: PageRenderer;
  /** Built client output (production). Only its `/assets/*` files are served. */
  clientDir?: string;
  /**
   * Development error handling (E119): the development error page — code, request, route, queries, log, solutions — for
   * page requests that fail with a 5xx, and exception details plus a `solution` in JSON errors. Default:
   * `ServerConfig.debug` (`NODE_ENV=development`, never "not production", E115); off without a `ServerConfig`.
   */
  debug?: boolean;
  /** Largest accepted request body in bytes. Defaults to `ServerConfig.maxBodySize` (env `MAX_BODY_SIZE`), else 8 MiB. */
  maxBodySize?: number;
  /** Asset version for 409 reloads. Defaults to `ASSET_VERSION`, else the renderer's (the build's), else none. */
  version?: string | null;
  /** Server rendering (default: `ServerConfig.ssr`, env `SSR_ENABLED`, on). Off: every page goes out without markup, the browser renders it. */
  ssr?: boolean;
  /**
   * What a write in a read-only request (an island's, E52) does: throw (`true`, the default with `NODE_ENV=development` and
   * `test` — the mistake shows where it is made) or get dropped and logged (`false`, the default everywhere else — production,
   * staging, no `NODE_ENV` (E164): the island and its page stay whole).
   */
  strictReadOnly?: boolean;
  /** How long an island resolved in-process may take before it shows its `exception` fallback (ms, default 10 s). */
  islandTimeout?: number;
  /**
   * The health endpoints' path (E126): `/up` (liveness) and `/up/ready` (readiness), answered before any middleware. Default:
   * `ServerConfig.health` (env `HEALTH_PATH`, `/up`); `false`: none.
   */
  health?: string | false;
}

const REQUEST_ID = /^[\w.:-]{1,128}$/;

const requests = channels.tracing('http.request');
const exceptions = channels.event('exception');

/** The class name of a route's action (`ShowUserController`) — none for a closure. */
function controllerOf(route: RouteDefinition): string | undefined {
  const action = route.action as unknown;
  return typeof action === 'function' && action.name !== '' && typeof (action as { prototype?: { handle?: unknown } }).prototype?.handle === 'function' ? action.name : undefined;
}

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
 * The HTTP kernel: Hono does the URL matching, the Marmeon router runs the
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
    debug = container.has(ServerConfig) ? container.make(ServerConfig).debug : false,
    maxBodySize = container.has(ServerConfig) ? container.make(ServerConfig).maxBodySize : undefined,
    version = (container.has(ServerConfig) ? container.make(ServerConfig).assetVersion : undefined) ?? renderer?.version ?? null,
    ssr = container.has(ServerConfig) ? container.make(ServerConfig).ssr : true,
    strictReadOnly = !environment.isProtected(),
    islandTimeout = 10_000,
    health = container.has(ServerConfig) ? container.make(ServerConfig).health : '/up',
  }: KernelOptions = {},
): HttpKernel {
  const router = application.container.make(Router);
  const logger = container.make(Logger).child({ channel: 'http' });
  // The log line's path without secrets in it (E125): `/reset-password/[redacted]` — by the route's sensitive parameters, else token-like segments.
  const redactor = application.container.has(Redactor) ? application.container.make(Redactor) : new Redactor();
  container.instance(AssetVersion, { value: version });
  // TRUSTED_PROXIES (E162): only from these peers `X-Forwarded-For` sets the client's address and `X-Forwarded-Proto`/`-Host` the URL.
  const proxies = container.has(ServerConfig) ? container.make(ServerConfig).trustedProxies : [];
  const trusts = proxyMatcher(proxies);
  // `*` trusts the direct peer only (E172): the client's address is the entry that peer added, never one a client wrote before it.
  const forwardedTrust: readonly string[] | ((address: string) => boolean) = proxies.includes('*') ? ['*'] : trusts;
  // What every cookie gets unless its `set` says otherwise — `secure` from the session's config (E162), when there is a session.
  const cookieDefaults = container.has(CookieDefaults) ? container.make(CookieDefaults) : undefined;
  // Development only (E129): its provider binds it when NODE_ENV=development.
  const timing = container.has(ServerTiming) ? container.make(ServerTiming) : undefined;
  // Development only (E119): the error page's queries and log of each request — bound by the provider in debug mode.
  const recorder = debug && container.has(DevRequestRecorder) ? container.make(DevRequestRecorder) : undefined;
  const app = new Hono();
  /** The route each request in flight matched — its name for the log line and the request channel. */
  const matched = new WeakMap<Request, RouteDefinition>();
  /** The client address of each request in flight — what an island resolved for it is from, too. */
  const addresses = new WeakMap<Request, string | undefined>();
  /** Development only: each request's state (its parsed body) and route parameters, for the error page — and, while
   * something listens to `http.request`, the state and the page it answered with (the devtools, E118). */
  const states = new WeakMap<Request, RequestState>();
  const pages = new WeakMap<Request, PageSummary>();
  const parameters = new WeakMap<Request, Record<string, string>>();

  /**
   * An island, resolved in-process while its page renders (E49): a GET of its URL with the page request's cookies and
   * headers plus `x-marmeon-region: island`, matched by Hono and run through the island route's own middleware and
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
   * (`x-marmeon`, `x-marmeon-region: layer`) with the page request's cookies and headers, run in-process through the base
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
    app: application,
    // Prop sizes for the `http.request` message (E118) — measured only while something listens.
    onPage: (request, page, kind, origins) => {
      if (requests.hasSubscribers) pages.set(request, pageSummary(request, page, kind, origins()));
    },
    logger: container.make(Logger).child({ channel: 'ssr' }),
    ssr,
    debug,
    islands: dispatchIsland,
    layerBases: dispatchLayerBase,
  });

  const renderError = async (error: unknown, failed: Request, scope?: Container): Promise<Response> => {
    if (exceptions.hasSubscribers) {
      const status = error instanceof HttpError ? error.status : error instanceof ValidationError ? 422 : 500;
      exceptions.publish({ ...messageBase(application), error, status, method: failed.method, path: new URL(failed.url).pathname });
    }
    const handler = container.make(ExceptionHandler);
    if (isLiveValidation(failed)) return renderLiveValidationError(handler, error, failed, scope);
    // An upload (W6.9) is answered as JSON whatever it accepts — never back to a form with flashed errors (it is read-only).
    const request = failed.headers.has(UPLOAD_HEADER) ? new Request(failed.url, { method: failed.method, headers: { ...Object.fromEntries(failed.headers), accept: 'application/json' } }) : failed;
    handler.report(error);
    if (regionOf(request) === 'island') return renderRegionError(handler, error, request, scope);
    try {
      // In the request's language, when a translator is bound (@marmeon/i18n) — the error page, its title, validation messages.
      const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
      const result = handler.render(error, request, { debug, translator });
      if (debug) {
        const developed = await developmentError(error, result, failed, request);
        if (developed) return developed;
      }
      return await toResponse(result, { request }, scope);
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
   * Development only (E119): what replaces the handler's answer to a 5xx — for a page request (a document or a visit) whose
   * answer is the error page, the development error page, rendered without the app's views or SSR (so also when those are
   * what broke); for a JSON error with exception details, the same JSON plus the first `solution`. Undefined otherwise —
   * an app's own handler answer, a 4xx, an action or an upload keep theirs. The page's code is loaded here, never in production.
   */
  const developmentError = async (error: unknown, result: unknown, failed: Request, request: Request): Promise<Response | undefined> => {
    try {
      const solutions = application.container.has(ErrorSolutions) ? application.container.make(ErrorSolutions) : undefined;
      if (result instanceof Response) {
        if (result.status < 500 || !result.headers.get('content-type')?.includes('json')) return undefined;
        const [solution] = (await solutions?.find(error, { app: application })) ?? [];
        if (!solution) return undefined;
        const body = (await result.clone().json()) as Record<string, unknown>;
        const shown = { title: redactor.text(solution.title), text: redactor.text(solution.text), ...(solution.command ? { command: redactor.text(solution.command) } : {}), ...(solution.docs ? { docs: solution.docs } : {}) };
        return Response.json({ ...body, solution: shown }, { status: result.status, headers: result.headers });
      }
      if (!isViewResult(result) || result.component !== ERROR_PAGE || result.status < 500 || isActionRequest(request) || request.headers.has(UPLOAD_HEADER)) return undefined;
      const info = currentRequest();
      const route = matched.get(failed);
      const state = states.get(failed);
      const { errorPageResponse } = await import('./error-page/index.ts');
      return await errorPageResponse(
        {
          error,
          status: result.status,
          request: failed,
          requestId: info?.requestId,
          app: application,
          redactor,
          solutions,
          ...(route
            ? {
                route: {
                  name: route.routeName,
                  path: route.path,
                  methods: route.methods,
                  controller: controllerOf(route),
                  middleware: router.middlewareFor(route).map((middleware) => (typeof middleware === 'function' && middleware.name) || '(anonymous)'),
                  params: parameters.get(failed) ?? {},
                },
              }
            : {}),
          ...(state ? { body: () => state.input() } : {}),
          recording: info ? recorder?.recording(info) : undefined,
        },
        result.headers,
      );
    } catch (failure) {
      logger.error('Rendering the development error page failed', { exception: failure instanceof Error ? (failure.stack ?? failure.message) : String(failure) });
      return undefined;
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

  // Health (E126): answered first — before the request id, the log line, the request channel and every middleware group.
  if (health !== false) {
    const endpoints = createHealthEndpoints(application, container, { path: health, debug });
    checkHealthPaths(endpoints, router.routes);
    app.get(endpoints.path, () => endpoints.live());
    app.get(endpoints.readyPath, () => endpoints.ready());
  }

  app.use(async (c, next) => {
    const header = c.req.header('x-request-id');
    const requestId = header && REQUEST_ID.test(header) ? header : randomUUID();
    const started = performance.now();
    const info: RequestContext = { requestId };
    timing?.begin(info);
    recorder?.begin(info);

    await runWithRequest(info, async () => {
      // The log line is written inside the request's trace (a tracer's span, E120: its `trace_id` in the line).
      const run = async () => {
        await next();
        // Built only when it goes somewhere: with LOG_LEVEL=silent (or warn) neither the line nor its redacted path (E187).
        if (logger.enabled?.('info') === false) return;
        const definition = matched.get(c.req.raw);
        const route = definition?.routeName;
        logger.info(`${c.req.method} ${redactor.path(c.req.path, definition?.path)} ${c.res.status}`, route === undefined ? { ms: Math.round(performance.now() - started) } : { route, ms: Math.round(performance.now() - started) });
      };
      // Traced only while something listens (E118): otherwise no message is built at all.
      if (requests.hasSubscribers) await traceRequest(c.req.raw, requestId, c.env, run, () => c.res);
      else await run();
    });

    // In place when the request owns the response (the framework made it, or a middleware copied it already) — else one copy
    // (a response an app may hand out twice, immutable headers). Hono's `res` setter copies what it is given once more when it
    // already holds a response: cleared first, it takes the copy as it is.
    const response = editableResponse(c.res);
    if (response !== c.res) {
      c.res = undefined;
      c.res = response;
    }
    response.headers.set('x-request-id', requestId);
    const serverTiming = timing?.header(info, performance.now() - started);
    if (serverTiming) response.headers.set('server-timing', serverTiming);
  });

  /** One request on the `http.request` channel — with the route and controller it matched, and its status. */
  const traceRequest = (request: Request, requestId: string, env: unknown, next: () => Promise<void>, response: () => Response): Promise<void> => {
    const region = regionOf(request);
    const message: HttpRequestMessage = {
      ...messageBase(application),
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      url: request.url,
      headers: request.headers,
      ...(region ? { region } : {}),
      inProcess: islandParent(env) !== undefined,
    };
    return trace(requests, message, next, (ended) => {
      const route = matched.get(request);
      if (route) {
        const name = route.routeName;
        const controller = controllerOf(route);
        if (name !== undefined) ended.route = name;
        ended.routePath = route.path;
        if (controller !== undefined) ended.controller = controller;
      }
      const answer = response();
      ended.status = answer.status;
      // Where it sends the browser: a redirect, or the protocol's full reload (409 + x-marmeon-location) — not a failure.
      const location = answer.status === 409 ? answer.headers.get(LOCATION_HEADER) : answer.status >= 300 && answer.status < 400 ? answer.headers.get('location') : null;
      if (location) ended.location = location;
      const reload = answer.status === 409 && location ? answer.headers.get(RELOAD_HEADER) : null;
      if (reload) ended.reload = reload;
      const page = pages.get(request);
      if (page) ended.page = page;
      const input = states.get(request)?.inputRead?.();
      if (input) ended.input = input;
    });
  };

  if (clientDir) {
    // The build's hashed files (E162): cached for a year, `immutable`; the `.br`/`.gz` that `marmeon build` wrote next to them by
    // `Accept-Encoding`. Never compressed here — documents least of all (BREACH): that is the proxy's business.
    app.use('/assets/*', ...serveAssets(clientDir));
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
    const ip = parent ? addresses.get(parent.request) : clientIp(remote, request.headers.get('x-forwarded-for'), forwardedTrust);
    addresses.set(request, ip);
    // The response's CSP nonce (E147): made only when a document needs it — the same for the header, React and the template.
    const nonce = new RequestNonce();
    scope.instance(RequestNonce, nonce);
    const state = createRequestState(request, { maxBodySize, ip, nonce, ...(cookieDefaults ? { cookies: cookieDefaults } : {}) });
    if (debug || requests.hasSubscribers) states.set(request, state);
    scope.instance(CookieJar, state.cookies); // injectable per request, e.g. into a cookie session driver
    scope.instance(IncomingRequest, request); // which tab sent it (`x-marmeon-connection`), for the live Broadcaster
    // Who sent it (E169) — for services without `ctx`: `Auth`'s Login event. The header is read only when asked for.
    scope.instance(RequestInfo, {
      ip,
      get userAgent() {
        return request.headers.get('user-agent') ?? undefined;
      },
    });
    const terminable: [MiddlewareHandler<any, any>, HttpContext][] = [];
    // An island's request is read-only (E52): no session write, no cookie, no work after the response — and so is every
    // request resolved in-process for another (an island while its page renders, a layer's base for its deep link).
    const island = regionOf(request) === 'island';
    // A live validation (E62) checks input and changes nothing: read-only like an island — no session write (its flash data
    // stays), no cookie, no work after the response; its controller never runs.
    const live = isLiveValidation(request);
    // An upload's target or its bytes (W6.9): a request beside the page — like a live validation, it never writes the session
    // (flash data meant for the next page stays) or cookies.
    const upload = request.headers.has(UPLOAD_HEADER);
    const { pathname } = new URL(request.url);
    // An event stream (W6.10, the live stream: `EventSource` asks for `text/event-stream`) stays open beside the page for as long
    // as the tab does: it reads the session to check who listens, never writes it — no cookie, no flash data taken. The live
    // stream's path is read-only by itself (W9 step 4): a request without the header (a script, a proxy that drops it) must not
    // start, extend or save a session there either.
    const stream = pathname === LIVE_PATH || request.headers.get('accept')?.includes('text/event-stream') === true;
    // The tabs' question for the session's epoch (W8 step 8): it reads the session, never writes it — it starts none, extends none
    // (a tab becoming visible is no activity), takes no flash data, sets no cookie.
    const epoch = pathname === SESSION_PATH;
    const readOnly = scope.has(ReadOnly) ? scope.make(ReadOnly) : undefined;
    if ((island || parent || live || upload || stream || epoch) && readOnly) {
      const reason = live
        ? `a live validation (${request.method} ${pathname})`
        : epoch
          ? `the session's epoch (${request.method} ${pathname})`
          : upload
          ? `an upload (${request.method} ${pathname})`
          : stream
            ? `an event stream (${request.method} ${pathname})`
            : island
              ? `an island request (${request.method} ${pathname})`
              : `a layer's base, resolved for its deep link (${request.method} ${pathname})`;
      const rule = live
        ? 'a live validation is read-only (E62) — it checks the input and changes nothing: no session, cookies or flash data, no work after the response. Middleware with side effects skips them for it.'
        : epoch
          ? "the session's epoch is read-only (W8 step 8) — a tab asks it when it becomes visible: no session, cookies or flash data, no work after the response."
          : upload
          ? 'an upload is read-only (W6.9) — it stores a file beside the page: no session, cookies or flash data, no work after the response.'
          : stream
            ? 'an event stream is read-only (W6.10) — it stays open beside the page and only listens: no session, cookies or flash data, no work after the response.'
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
        // Outside of any transaction (E107): work after the response never joins one that was open during the request.
        .then(() => outsideTransaction(() => Promise.all(terminable.map(([handler, ctx]) => handler.terminate!(ctx, final)))))
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
            // A boundary (E107): deferred work runs outside of any transaction, also one still open around this request.
            await outsideTransaction(work);
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
    app.on([...route.methods], route.path, (c) => {
      matched.set(c.req.raw, route);
      if (debug) parameters.set(c.req.raw, c.req.param());
      return handle(c.req.raw, remoteAddress(c.env), (scope, state, onTerminable) =>
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
      );
    });
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

  // Behind a trusted proxy (E162), the URL the client asked for (`X-Forwarded-Proto`/`-Host`). A plain HTML form's PUT, PATCH or
  // DELETE (`_method` in its POST body, E64) is routed as that method.
  const dispatch = app.fetch;
  app.fetch = async (request, env, executionContext) => dispatch(await overrideMethod(forwardedRequest(request, remoteAddress(env), trusts)), env, executionContext);

  return Object.assign(app, {
    settle: async () => {
      while (pending.size > 0) await Promise.all(pending);
    },
  });
}


/** A page object's view, the bytes of each prop's JSON, and what a partial reload asked for — for the `http.request` message. */
function pageSummary(request: Request, page: PageObject | RegionObject, kind: PageSummary['kind'], { shared, optional }: PropOrigins): PageSummary {
  const props: Record<string, number> = {};
  for (const [key, value] of Object.entries(page.props ?? {})) props[key] = Buffer.byteLength(JSON.stringify(value) ?? '');
  const partial = partialReloadOf(request, page.component);
  return {
    component: page.component,
    props,
    kind,
    ...(partial?.only ? { only: partial.only } : {}),
    ...(partial && partial.except.length > 0 ? { except: partial.except } : {}),
    ...(page.deferredProps ? { deferred: page.deferredProps } : {}),
    ...(shared.length > 0 ? { shared } : {}),
    ...(optional.length > 0 ? { optional } : {}),
  };
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

/** The host of the start line: `localhost` for every interface, else the one listened on (an IPv6 address in brackets). */
function shownHost(host: string | undefined): string {
  if (host === undefined || host === '0.0.0.0' || host === '::') return 'localhost';
  return host.includes(':') ? `[${host}]` : host;
}

/** The peer address from @hono/node-server's bindings; undefined for in-process requests (tests). */
function remoteAddress(env: unknown): string | undefined {
  return (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
}

export interface ServeOptions {
  app: Application;
  /** Development: SSR entry relative to `root`. Defaults to the entry of the `marmeon()` Vite plugin. */
  ssrEntry?: string;
  /** Defaults to `ServerConfig.port` (env `PORT`). */
  port?: number;
  /** The interface to listen on. Defaults to `ServerConfig.host` (env `HOST`); unset: every interface. */
  host?: string;
  /**
   * `development` runs Vite's dev server in front of the app (source modules, HMR, `/__open-in-editor`); `production` serves
   * the build. Defaults to `development` only with `NODE_ENV=development` (E115) — a missing `NODE_ENV`, `test` or `staging`
   * serves the build: never "anything but production".
   */
  mode?: 'development' | 'production';
  /**
   * How long `close()` waits for work after the responses — `afterResponse.defer(…)` tasks, `terminate` hooks — before
   * it gives up on them (default 8 s; `marmeon serve` exits after 10 s at the latest).
   */
  drainTimeoutMs?: number;
  /**
   * How long an idle keep-alive connection stays open (ms) — above the keep-alive of the proxy in front (W9 step 4). Defaults to
   * `ServerConfig.keepAliveTimeoutMs` (env `KEEP_ALIVE_TIMEOUT`, seconds; default 65). The time to receive a request's headers
   * (`headersTimeout`) is a second longer — between 60 s and the 300 s of `requestTimeout`.
   */
  keepAliveTimeoutMs?: number;
  /**
   * How long `close()` keeps taking requests first, with `/up/ready` at 503 (E163) — so a load balancer that learns from its
   * probes sends the next requests elsewhere before this server stops listening. Defaults to `ServerConfig.shutdownDelayMs`
   * (env `SHUTDOWN_DELAY`, seconds; default 0).
   */
  shutdownDelayMs?: number;
}

export interface CloseOptions {
  /** Skip the shutdown delay (`SHUTDOWN_DELAY`) — `marmeon serve` on Ctrl+C (SIGINT): nobody routes to a terminal. */
  readonly immediately?: boolean;
}

/**
 * A listening server. `close()` stops it gracefully: readiness (`/up/ready`) answers 503 at once and, for `SHUTDOWN_DELAY`
 * seconds, requests are still answered (E163); then no new connections, requests in flight finish, and then the work
 * they deferred until after their response (a reset mail sent by `afterResponse.defer`) finishes too — before the app
 * shuts down and closes its pools (E102).
 */
export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  close(options?: CloseOptions): Promise<void>;
}

export async function startServer({
  app,
  ssrEntry,
  port = app.container.has(ServerConfig) ? app.container.make(ServerConfig).port : 3000,
  host = app.container.has(ServerConfig) ? app.container.make(ServerConfig).host : undefined,
  mode = environment.isDevelopment() ? 'development' : 'production',
  drainTimeoutMs = 8_000,
  shutdownDelayMs = app.container.has(ServerConfig) ? app.container.make(ServerConfig).shutdownDelayMs : 0,
  keepAliveTimeoutMs = app.container.has(ServerConfig) ? app.container.make(ServerConfig).keepAliveTimeoutMs : 65_000,
}: ServeOptions): Promise<RunningServer> {
  // Node closes an idle keep-alive connection after 5 s by default; a proxy that keeps its connections to the app longer (nginx's
  // upstream keepalive: 60 s) sends the next request on one the app is closing — a 502 now and then (W9 step 4). The app
  // waits longer than the proxy. A request's headers may take a second longer (the usual pairing, `headersTimeout` above
  // `keepAliveTimeout`), within Node's defaults: at least 60 s, at most the 300 s a whole request may take (`requestTimeout`, kept
  // — a slow client must not hold a connection longer).
  const server = createServer({ keepAliveTimeout: keepAliveTimeoutMs, headersTimeout: Math.min(300_000, Math.max(60_000, keepAliveTimeoutMs + 1000)) });
  const closing = app.container.has(ServerClosing) ? app.container.make(ServerClosing) : undefined;
  // While the server drains (SHUTDOWN_DELAY, E163) a keep-alive connection ends after its response: the client's next
  // request opens a new one — which the load balancer, told by the failing readiness, gives to another instance.
  server.prependListener('request', (_req, res) => {
    if (closing?.draining.aborted) res.setHeader('connection', 'close');
  });
  const { root } = app;
  let closeVite: (() => Promise<void>) | undefined;
  let kernel: HttpKernel;

  if (mode === 'development') {
    const { vite, renderer } = await createViteDevRenderer({
      root,
      ssrEntry,
      httpServer: server,
      // Bound only with NODE_ENV=development (E115): a Vite dev server on a staging box adds nothing.
      devBody: () => (app.container.has(DevDocument) ? app.container.make(DevDocument).body : ''),
      devHead: () => (app.container.has(DevDocument) ? app.container.make(DevDocument).head : ''),
    });
    // Debug mode follows `ServerConfig.debug` — `NODE_ENV=development` (E115), not this mode: Vite on a staging box shows no stack.
    kernel = createHttpKernel(app, { renderer });
    const handle = getRequestListener(kernel.fetch);
    // Vite answers module, asset and HMR requests; everything else falls through to Hono.
    server.on('request', (req, res) => vite.middlewares(req, res, () => handle(req, res)));
    closeVite = () => vite.close();
  } else {
    const renderer = await createProductionRenderer({ root });
    kernel = createHttpKernel(app, { renderer, clientDir: join(root, 'dist/client') });
    server.on('request', getRequestListener(kernel.fetch));
  }

  let closed: Promise<void> | undefined;
  const close = ({ immediately = false }: CloseOptions = {}) => (closed ??= shutdown(immediately));
  const shutdown = async (immediately: boolean) => {
    // Not ready from now on (E163) — and, for SHUTDOWN_DELAY, still answering what the load balancer sends until it notices.
    closing?.drain();
    if (shutdownDelayMs > 0 && !immediately) await new Promise((resolve) => setTimeout(resolve, shutdownDelayMs));
    // Responses that stay open (live streams, W6.10) end first: `server.close()` waits for every connection, and a tab never
    // closes its stream by itself — it connects to the next server instead.
    closing?.close();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    // A connection whose response is ending now (a live stream just closed) turns idle only afterwards — sweep those up too.
    const sweep = setInterval(() => server.closeIdleConnections(), 50);
    // Vite's HMR WebSocket is an upgraded socket: neither `close()` nor `closeAllConnections()` ends it,
    // so the server would wait forever for an open browser tab. Closing Vite closes its clients.
    await closeVite?.();
    await stopped;
    clearInterval(sweep);
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

  // Every interface beside a program on 127.0.0.1 (macOS): said before listening — a cluster's primary said it for its workers.
  const beside = cluster.isWorker ? undefined : await heldOnLoopback(port, host);
  if (beside) app.container.make(Logger).warn(beside);

  return new Promise((resolve, reject) => {
    // A port that is taken (EADDRINUSE) or not allowed (EACCES): the start fails with Node's error — not an uncaught exception,
    // and without a Vite left running.
    const failed = (error: Error) => void (closeVite?.() ?? Promise.resolve()).finally(() => reject(error));
    server.once('error', failed);
    server.listen(port, host, () => {
      server.off('error', failed);
      // The port it got — `0` asks the system for a free one.
      const listening = (server.address() as { port?: number } | null)?.port ?? port;
      const routes = app.container.make(Router).routes.length;
      const packages = app.packages.length ? `, packages: ${app.packages.join(', ')}` : '';
      // The environment as the framework reads it (E139): `in staging (protected)`, `in unset NODE_ENV (protected, like production)`.
      const serving = mode === 'development' ? "Vite's dev server" : 'the build';
      app.container
        .make(Logger)
        .info(`Marmeon in ${environment.describe()} on http://${shownHost(host)}:${listening} (${serving}; ${routes} routes, ${app.modules.length} modules${packages})`);
      resolve({ server, port: listening, close });
    });
  });
}
