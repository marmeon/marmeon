import { ConsoleLogger, currentRequest, ErrorSolutions, Redactor, Translator, type Application, type Container, type Logger, type Solution } from '@marmeon/core';
import { channels, messageBase, trace, type SsrRenderMessage } from '@marmeon/core/diagnostics';
import {
  ACTION_HEADER,
  ACTION_REDIRECT_HEADER,
  FLASH_HEADER,
  FLASH_WAITING_HEADER,
  Flasher,
  flashOf,
  HttpError,
  isActionRequest,
  isIslandResult,
  isJsonResult,
  isLayerResult,
  isPrefetch,
  isRedirectResult,
  isViewResult,
  jsonResponse,
  LAYER_BACKDROP,
  DOCUMENT_HEADER,
  epochOf,
  LiveSigner,
  liveOf,
  LOCATION_HEADER,
  MAX_LAYER_DEPTH,
  heldOnceProps,
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  PAGE_HEADER,
  PageSession,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  partialReloadOf,
  ReadOnly,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  regionOf,
  propOrigins,
  resolvePageProps,
  ResponseLifecycle,
  serializedFlash,
  SharedData,
  signedLive,
  type LiveDeclaration,
  type FlashEntry,
  type FlashMessage,
  type DeferredResult,
  type IslandResult,
  type LayerResult,
  type PageObject,
  type PropOrigins,
  type RegionObject,
  type RegionOutcomeStatus,
  type RegionResult,
  type SsrRender,
} from '@marmeon/http';
import { defaultToResponse, ownResponse, RequestNonce, urlFor, VALIDATE_HEADER, VALIDATED_HEADER, type ResponseContext, type ResponseFactory, type RouteLookup } from '@marmeon/router';
import { documentOf, FALLBACK_TEMPLATE, renderDocument, withNonce } from './html.ts';

export interface PageRenderOptions {
  /** Wait for the whole page before sending — for bots (see {@link isBot}). */
  complete: boolean;
  /** An error after the shell (the browser renders that part instead) — the response is already on its way. */
  onError(error: unknown): void;
  /** A hint for the developer (development only). */
  onWarning(message: string): void;
  /** Stops rendering when the client went away. */
  signal?: AbortSignal;
  /** Resolves an island of this page in-process — `SsrRenderOptions.resolveIsland`. */
  resolveIsland?: (url: string) => Promise<RegionResult>;
  /** Computes a deferred group of this page while it streams — `SsrRenderOptions.resolveDeferred`. */
  resolveDeferred?: (group: string) => Promise<DeferredResult | null>;
  /**
   * The response's CSP nonce, when it has one: on the template's tags (in place of `CSP_NONCE_PLACEHOLDER`), React's
   * streamed scripts and styles and `<Head>`'s scripts. Without it, the template's placeholder attributes are taken out.
   */
  nonce?: string;
}

/** Turns a page object into a full HTML document. Implemented per environment (Vite in development, the build in production). */
export interface PageRenderer {
  /**
   * The document with the server-rendered page — streamed: the head and the shell first, Suspense boundaries as they
   * finish. Rejects when the page cannot render on the server (an error in the shell).
   */
  render(page: PageObject, request: Request, options: PageRenderOptions): Promise<string | ReadableStream<Uint8Array>>;
  /** The document without markup: the browser renders the page (server rendering failed, or is off). `nonce`: as for {@link render}. */
  shell(page: PageObject, request: Request, nonce?: string): Promise<string>;
  /** Version of the built assets; undefined in development (no checks while Vite serves sources). */
  readonly version?: string;
  /**
   * Development: server rendering of a page failed and its document goes out without markup — tell the developer
   * (the Vite dev renderer shows it in Vite's overlay). What it returns goes into that document, before `</body>`.
   */
  failed?(error: unknown, details: RenderFailureDetails): Promise<string | undefined>;
}

/** What {@link PageRenderer.failed} gets beside the error. */
export interface RenderFailureDetails {
  /** The page that failed. */
  readonly component: string;
  /** The solutions for the error. */
  readonly solutions: readonly Solution[];
  /** The app's redactor: what is shown passes it. */
  readonly redactor: Redactor;
  /** The response's CSP nonce, for a script the markup brings. */
  readonly nonce?: string;
}

export interface DocumentRendererOptions {
  /** The app's `index.html`, per request (Vite transforms it in development). */
  template(request: Request): string | Promise<string>;
  /** The app's SSR entry (`render` of `bootstrap/ssr.tsx`). */
  ssr(): SsrRender | Promise<SsrRender>;
  /** Maps an error's stack to the sources (Vite's `ssrFixStacktrace` in development). */
  fixStack?(error: unknown): void;
  /** Development: see {@link PageRenderer.failed}. */
  failed?: PageRenderer['failed'];
  version?: string;
}

const renders = channels.tracing('render.ssr');

/** A renderer from a template and an SSR entry — the one code path of the development and the production renderer. */
export function createDocumentRenderer({ template, ssr, fixStack, failed, version }: DocumentRendererOptions): PageRenderer {
  const fixed = (error: unknown) => {
    if (error instanceof Error) fixStack?.(error);
    return error;
  };
  return {
    async render(page, request, { complete, onError, onWarning, signal, resolveIsland, resolveDeferred, nonce }) {
      const [document, render] = await Promise.all([template(request), ssr()]);
      // Rendering stops when the client goes away — the request aborts, or the server cancels the body. Not an error.
      const stopped = new AbortController();
      try {
        const result = await render(page, {
          complete,
          signal: signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal,
          onWarning,
          onError: (error) => onError(fixed(error)),
          ...(resolveIsland ? { resolveIsland } : {}),
          ...(resolveDeferred ? { resolveDeferred } : {}),
          ...(nonce ? { nonce } : {}),
        });
        return await documentOf(withNonce(document, nonce), page, result, (reason) => stopped.abort(reason));
      } catch (error) {
        throw fixed(error);
      }
    },
    async shell(page, request, nonce) {
      return renderDocument(withNonce(await template(request), nonce), page, { html: '' });
    },
    ...(failed ? { failed } : {}),
    version,
  };
}

/** Renders an empty shell with the page object — the client renders everything (tests, apps without SSR). */
export const shellRenderer: PageRenderer = {
  render: async (page) => renderDocument(FALLBACK_TEMPLATE, page, { html: '' }),
  shell: async (page) => renderDocument(FALLBACK_TEMPLATE, page, { html: '' }),
};

/**
 * Crawlers and link previews, which read the HTML without running scripts: they get the whole page at once
 * (every Suspense boundary rendered), not a shell that fills in later.
 */
export function isBot(request: Request): boolean {
  return BOTS.test(request.headers.get('user-agent') ?? '');
}

const BOTS =
  /bot\b|bot\/|crawl|spider|slurp|archiver|bingpreview|facebookexternalhit|embedly|quora link preview|outbrain|pinterest|vkshare|w3c_validator|whatsapp|telegram|discord|slack|linkedin|skype|lighthouse|headlesschrome|prerender/i;

/**
 * Page responses differ by these request headers: a page document or its JSON (`x-marmeon`), all props or some
 * (a partial reload), a prefetch or the visit (`Purpose` — a page may skip side effects for a prefetch). A cache
 * (`Cache-Control: private, max-age=…`) must never answer one with the other.
 */
const PAGE_VARY = [PAGE_HEADER, REGION_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, PURPOSE_HEADER, ONCE_HEADER, ONCE_SCOPE_HEADER].join(', ');

/**
 * The live subscriptions of a response, signed for the request's session — `PageObject.live`. A result that declares
 * some in an app without @marmeon/live is a mistake that says so.
 */
async function liveSubscriptions(declarations: readonly LiveDeclaration[], scope: Container | undefined, component: string): Promise<{ live?: PageObject['live'] }> {
  const live = await signedLive(declarations, () => {
    if (!scope?.has(LiveSigner)) {
      throw new Error(`[${component}] follows a live channel (.live() or shared.live()), which needs @marmeon/live in the app: pnpm add @marmeon/live (marmeon discover registers it).`);
    }
    return scope.make(LiveSigner);
  });
  return live ? { live } : {};
}

/** A response factory that may use the request's container scope (the kernel passes it). */
export type ScopedResponseFactory = (...args: [...Parameters<ResponseFactory>, scope?: Container]) => ReturnType<ResponseFactory>;

export interface ResponseFactoryOptions {
  /** The app whose pages these are — server rendering is reported on its `render.ssr` channel. */
  app?: Application;
  /**
   * Hears each page, layer or island object a response carries, before it is sent — the kernel's, for the `http.request`
   * message's prop sizes (it computes nothing unless something listens).
   */
  onPage?: (request: Request, page: PageObject | RegionObject, kind: 'page' | 'layer' | 'island', origins: () => PropOrigins) => void;
  /** Where server-rendering errors go. */
  logger?: Logger;
  /** Server rendering at all (`SSR_ENABLED=false` turns it off for every page: the browser renders them). Default: on. */
  ssr?: boolean;
  /** Development: say why an island (or a page) is a 404 where it was asked for the other. */
  debug?: boolean;
  /**
   * Resolves an island of a page in-process while the page renders — the kernel's: through the island route's own
   * middleware, read-only. Without it, islands load in the browser.
   */
  islands?: (url: string, parent: { request: Request; scope: Container; requestId: string | undefined }) => Promise<RegionResult>;
  /** How long a deferred group streamed with its page may take before the browser loads it instead (ms, default 10 s). */
  deferredTimeout?: number;
  /**
   * Resolves the base of a layer whose URL was loaded as a document — a deep link or a reload: the kernel's, a GET of
   * `url` in-process through the base route's own middleware and authorization, read-only. Without it, a layer's document
   * shows the layer over the neutral surface.
   */
  layerBases?: (url: string, parent: { request: Request; scope: Container; requestId: string | undefined }) => Promise<LayerBaseResult>;
}

/**
 * What the base of a deep-linked layer answered: its page object — a page, or another layer (`layer` set: its
 * base comes next) — or nothing to show: a redirect (not signed in), 401, 403, 404, an error. `status` is the HTTP status.
 */
export type LayerBaseResult = { readonly status: 'page'; readonly page: PageObject } | { readonly status: 'unavailable'; readonly httpStatus: number };

/**
 * Turns controller results into HTTP responses. Client-side navigations get the
 * page object as JSON, full page loads get a server-rendered document. A partial reload of the rendered component
 * gets only the props it asks for (and only those are computed — see `resolvePageProps`). Redirects
 * resolve named routes through `routes` (the router) and flash through the scope's `Flasher`.
 *
 * Server rendering never breaks a page: when it fails, the document goes out without markup — with the page object,
 * so the browser renders it — and the error is logged.
 */
export function createResponseFactory(
  renderer: PageRenderer = shellRenderer,
  routes?: RouteLookup,
  version: string | null = null,
  { app, logger = new ConsoleLogger({ channel: 'ssr' }), ssr = true, debug = false, islands, deferredTimeout = 10_000, layerBases, onPage }: ResponseFactoryOptions = {},
): ScopedResponseFactory {
  // What the error lines below mask their text with: the app's (the names its packages add — the session cookie — count too).
  const redactor = app?.container.has(Redactor) ? app.container.make(Redactor) : new Redactor();
  const describe = (error: unknown) => errorFields(error, redactor);
  const noRouter: RouteLookup = {
    findByName: (name) => {
      throw new Error(`Cannot redirect to route [${name}]: the response factory has no router.`);
    },
  };

  /**
   * What the page's request resolves while the page streams: its islands — in-process, through their own routes —
   * and its deferred groups, computed in the page's scope once the headers are out (read-only then). Per request.
   */
  const streaming = (page: PageObject, request: Request, props: Readonly<Record<string, unknown>>, scope: Container | undefined): Pick<PageRenderOptions, 'resolveIsland' | 'resolveDeferred'> => {
    if (!scope) return {};
    const requestId = currentRequest()?.requestId;
    // A prefetched document (`Sec-Purpose: prefetch`) leaves its islands to the browser: islands never load ahead.
    const resolveIsland = islands && !isPrefetch(request)
      ? async (url: string): Promise<RegionResult> => {
          const result = await islands(url, { request, scope, requestId });
          if (result.status === 'exception') logger.error(`The island ${redactor.text(url)} on [${page.component}] failed — it shows its error`, { component: page.component, island: redactor.text(url), status: result.failure.status });
          return result;
        }
      : undefined;
    const lifecycle = scope.has(ResponseLifecycle) ? scope.make(ResponseLifecycle) : undefined;
    const shared = scope.has(SharedData) ? scope.make(SharedData) : undefined;
    const resolveDeferred =
      lifecycle && page.deferredProps
        ? async (group: string): Promise<DeferredResult | null> => {
            const names = page.deferredProps?.[group];
            if (!names || names.length === 0) return null;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), deferredTimeout)));
            try {
              const computed = (async () => {
                // After the headers: the session is saved, the request read-only — a write throws (development) or is dropped.
                await lifecycle.whenHeadersSent();
                // Only the group's props (the controller's or shared ones) — never `always()` props again: they were the page's.
                const group: Record<string, unknown> = {};
                for (const [name, value] of shared?.entries() ?? []) if (names.includes(name)) group[name] = value;
                for (const name of names) if (Object.hasOwn(props, name)) group[name] = props[name];
                const resolved = await resolvePageProps(group, undefined, { only: names, except: [] });
                // Serialized as the browser gets it (a Date is its string) — the same value a partial reload would bring.
                return JSON.parse(JSON.stringify(resolved)) as DeferredResult;
              })();
              const result = await Promise.race([computed, late]);
              if (result === null) logger.error(`The deferred group [${group}] of [${page.component}] took longer than ${deferredTimeout} ms — the browser loads it`, { component: page.component });
              return result;
            } catch (error) {
              logger.error(`The deferred group [${group}] of [${page.component}] failed while streaming — the browser loads it`, { component: page.component, ...describe(error) });
              return null;
            } finally {
              clearTimeout(timer);
            }
          }
        : undefined;
    return { ...(resolveIsland ? { resolveIsland } : {}), ...(resolveDeferred ? { resolveDeferred } : {}) };
  };

  const document = async (
    page: PageObject,
    request: Request,
    resolvers: Pick<PageRenderOptions, 'resolveIsland' | 'resolveDeferred'> = {},
    scope?: Container,
  ): Promise<string | ReadableStream<Uint8Array>> => {
    // The response's CSP nonce — when `contentSecurityPolicy()` wants one (or the app made one): made here, read by the header.
    const nonce = scope?.has(RequestNonce) ? scope.make(RequestNonce).forDocument() : undefined;
    if (!ssr) return renderer.shell(page, request, nonce);
    const report = (message: string) => (error: unknown) => logger.error(message, { component: page.component, ...describe(error) });
    const complete = isBot(request);
    const render = () =>
      renderer.render(page, request, {
        complete,
        signal: request.signal,
        onError: report(`Server rendering of [${page.component}] failed in a Suspense boundary — the browser renders that part`),
        onWarning: (message) => logger.warn(message, { component: page.component }),
        ...resolvers,
        ...(nonce ? { nonce } : {}),
      });
    try {
      // On the `render.ssr` channel only while something listens.
      if (app && renders.hasSubscribers) {
        const message: SsrRenderMessage = { ...messageBase(app), component: page.component, complete };
        return await trace(renders, message, render, (ended, result) => {
          ended.streamed = typeof result !== 'string';
        });
      }
      return await render();
    } catch (error) {
      report(`Server rendering of [${page.component}] failed — the browser renders the page`)(error);
      const shell = await renderer.shell(page, request, nonce);
      // Development: the developer sees it — in Vite's overlay — instead of a page that silently renders in the browser.
      if (debug && app && renderer.failed) {
        try {
          const solutions = app.container.has(ErrorSolutions) ? await app.container.make(ErrorSolutions).find(error, { app }) : [];
          const markup = await renderer.failed(error, { component: page.component, solutions, redactor, ...(nonce ? { nonce } : {}) });
          const at = shell.lastIndexOf('</body>');
          if (markup) return at === -1 ? shell + markup : shell.slice(0, at) + markup + shell.slice(at);
        } catch (failure) {
          logger.error('Reporting the server-rendering error to the overlay failed', { ...describe(failure) });
        }
      }
      return shell;
    }
  };

  /** A layer's page object says what it is: its key (default: the view), its base's URL, and whether an action answered it. */
  const layerInfo = (result: LayerResult, request: Request): NonNullable<PageObject['layer']> => {
    const { base, key } = result.layer;
    const target = urlFor(routes ?? noRouter, base.name, base.params, base.query);
    const once = request.method !== 'GET' && request.method !== 'HEAD';
    return { key: key ?? result.component, base: target, ...(once ? { once: true as const } : {}) };
  };

  /**
   * The document of a layer's URL: its base — a page, or another layer, whose base comes next (up to
   * {@link MAX_LAYER_DEPTH}) — then the layers over it. A base that does not answer with its page (a redirect to the login,
   * 401, 403, 404, an error) leaves the layers alone over the neutral surface ({@link LAYER_BACKDROP}): nothing of the
   * base is computed for the browser, let alone sent.
   */
  const deepLink = async (layer: PageObject, request: Request, scope: Container | undefined): Promise<PageObject> => {
    const layers: PageObject[] = [layer];
    let base: PageObject | undefined;
    let next = layer.layer?.base;
    const parent = scope ? { request, scope, requestId: currentRequest()?.requestId } : undefined;
    while (layerBases && parent && next !== undefined) {
      const answer = await layerBases(next, parent);
      if (answer.status !== 'page') {
        if (answer.httpStatus >= 500) logger.error(`The base ${next} of the layer [${layer.component}] failed (${answer.httpStatus}) — the layer shows alone`, { component: layer.component });
        break;
      }
      if (!answer.page.layer) {
        base = answer.page;
        break;
      }
      if (layers.length >= MAX_LAYER_DEPTH) {
        logger.error(`The layer [${layer.component}] has more than ${MAX_LAYER_DEPTH} bases stacked (a cycle?) — it shows alone`, { component: layer.component });
        layers.splice(0, layers.length - 1);
        break;
      }
      layers.unshift(answer.page);
      next = answer.page.layer.base;
    }
    if (base) return { ...base, layers };
    // The neutral surface: the shared props only (the layout's), under the declared base's URL — never the base's data.
    const shared = scope?.has(SharedData) ? scope.make(SharedData) : undefined;
    const resolved = await resolvePageProps({}, shared, undefined);
    const csrf = scope?.has(PageSession) ? scope.make(PageSession).csrfToken() : undefined;
    const epoch = epochOf(scope);
    const surface: PageObject = {
      component: LAYER_BACKDROP,
      ...resolved,
      url: layers[0]!.layer?.base ?? layer.url,
      version,
      ...(csrf !== undefined ? { csrf } : {}),
      ...(epoch !== undefined ? { epoch } : {}),
      // What every page follows (the layout's bell) — the surface shows the layout.
      ...(await liveSubscriptions(shared?.liveChannels() ?? [], scope, LAYER_BACKDROP)),
    };
    for (const key of ['locale', 'fallbackLocale'] as const) if (layer[key] !== undefined) surface[key] = layer[key];
    return JSON.parse(JSON.stringify({ ...surface, layers })) as PageObject;
  };

  /**
   * The flash messages a response the user is shown takes: those waiting in the session, then the result's own. Never
   * for a prefetch (the user has not asked for the page yet), an island or any other read-only request (a layer's base,
   * resolved in-process for its deep link): they leave them for the page.
   */
  const deliver = (request: Request, scope: Container | undefined, own: readonly FlashEntry[] = []): FlashMessage[] => {
    if (isPrefetch(request) || regionOf(request) === 'island') return [];
    if (scope?.has(ReadOnly) && scope.make(ReadOnly).active) return [];
    const flasher = scope?.has(Flasher) ? scope.make(Flasher) : undefined;
    // Only those of this document: a message another tab's request flashed waits for that tab.
    return serializedFlash([...(flasher?.takeFlash(documentOfRequest(request)) ?? []), ...own]);
  };

  return async (result, ctx, scope) => {
    if (isRedirectResult(result)) {
      const flasher = scope?.has(Flasher) ? scope.make(Flasher) : undefined;
      const response = result.toResponse(ctx.request, routes ?? noRouter, flasher);
      // An action's redirect is not followed: its answer is what the user is shown, so it takes the flash messages.
      return isActionRequest(ctx.request) ? withFlash(response, deliver(ctx.request, scope)) : response;
    }
    if (isIslandResult(result)) return islandResponse(result, ctx, version, debug, scope, onPage);
    if (isJsonResult(result)) {
      const response = jsonResponse(result);
      // An action's data: with the messages its controller flashed — an API client's JSON leaves them for a page.
      return isActionRequest(ctx.request) ? withFlash(response, deliver(ctx.request, scope, flashOf(result))) : response;
    }
    if (!isViewResult(result)) return defaultToResponse(result, ctx);
    if (isActionRequest(ctx.request)) {
      // An action gets data, never a page: the types refuse such a route for `useAction` — a page here is a mistake.
      throw new HttpError(
        406,
        debug ? `[${result.component}] is a page — an action (useAction) gets data: its controller returns this.json(…) or a redirect, not this.view(…).` : undefined,
      );
    }
    if (regionOf(ctx.request) === 'island') {
      // `<Island route>` takes island routes only (a type error otherwise) — at runtime a page is not one either.
      throw new HttpError(404, debug ? `[${result.component}] is a page, not an island — its controller returns this.view(…); an island's returns this.island(…).` : undefined);
    }

    const url = new URL(ctx.request.url);
    const shared = scope?.has(SharedData) ? scope.make(SharedData) : undefined;
    // Who the page is for: the session's scope for once props, its CSRF token for forms without JavaScript.
    const session = scope?.has(PageSession) ? scope.make(PageSession) : undefined;
    const onceScope = session?.scope();
    // Once props the browser holds — under this session's scope only (another tab may have signed someone else in).
    const once = { component: result.component, held: heldOnceProps(ctx.request, onceScope) };
    // Shared props and the controller's (which win), resolved as far as this response sends them.
    const resolved = await resolvePageProps(result.props, shared, partialReloadOf(ctx.request, result.component), once);
    const csrf = session?.csrfToken();
    // The session's epoch: the tabs of the browser compare it — on every page, a partial reload's too.
    const epoch = epochOf(scope);
    const pageSession = { ...(resolved.onceProps && onceScope !== undefined ? { onceScope } : {}), ...(csrf !== undefined ? { csrf } : {}), ...(epoch !== undefined ? { epoch } : {}) };
    // The page's language — the request's translator speaks one of the app's locales (never a raw header value).
    const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
    const language = translator ? { locale: translator.locale, ...(translator.fallbackLocale ? { fallbackLocale: translator.fallbackLocale } : {}) } : {};
    // The parsed query, for `useQueryState`: what the URL set validly, and the defaults — never parsed again in the browser.
    const query = ctx.pageQuery ? { query: { ...ctx.pageQuery.values }, queryDefaults: { ...ctx.pageQuery.defaults } } : {};
    const layer = isLayerResult(result) ? layerInfo(result, ctx.request) : undefined;
    // The route that answered (`<Link activeMatch>`): its name — never an internal one's, and none for an error page.
    const matched = (ctx as { route?: { routeName?: string | undefined; isInternal?: boolean } }).route;
    const route = matched?.routeName !== undefined && !matched.isInternal ? { route: matched.routeName } : {};
    // The channels it follows: its own and — a page, which shows the layout — the shared ones, signed for this session.
    const live = await liveSubscriptions([...(layer ? [] : (shared?.liveChannels() ?? [])), ...liveOf(result)], scope, result.component);
    const page: PageObject = { component: result.component, ...resolved, url: url.pathname + url.search, version, ...language, ...query, ...(layer ? { layer } : {}), ...route, ...pageSession, ...live };
    // Shown to the user: it takes the flash messages — and a response with them is never kept by a cache (a document
    // from the HTTP cache would fire them again).
    const flash = deliver(ctx.request, scope, flashOf(result));
    if (flash.length > 0) page.flash = flash;
    onPage?.(ctx.request, page, layer ? 'layer' : 'page', () => propOrigins(result.props, shared, Object.keys(resolved.props)));
    // A prefetch takes none — but says when some wait: the client asks again on the click instead of showing it.
    const waiting = isPrefetch(ctx.request) && (flashOf(result).length > 0 || (scope?.has(Flasher) === true && scope.make(Flasher).hasFlash(documentOfRequest(ctx.request))));
    const headers = {
      ...result.headers,
      vary: PAGE_VARY,
      ...(flash.length > 0 ? { 'cache-control': 'no-store' } : {}),
      ...(waiting ? { [FLASH_WAITING_HEADER]: 'true' } : {}),
    };

    // Serialized once: what the browser gets is also what the server renders from — a Date is a string on both
    // sides (`Serialize<T>`), so the markup hydrates.
    const json = JSON.stringify(page);
    if (ctx.request.headers.get(PAGE_HEADER) === 'true') {
      // A layer's page object, also to a plain visit: the client opens it over what is on screen.
      return ownResponse(new Response(json, {
        status: result.status,
        headers: { ...headers, 'content-type': 'application/json', [PAGE_HEADER]: 'true', ...(layer ? { [REGION_HEADER]: 'layer' } : {}) },
      }));
    }

    const sent = JSON.parse(json) as PageObject;
    if (layer) {
      // A deep link or a reload of a layer's URL: its declared base under it, resolved in-process — or the neutral
      // surface, when the base turns the user away. The base's deferred props load in the browser (its scope is gone).
      // The flash messages go with the document (the outermost page object), not with the layer in it.
      const { flash: _flash, ...top } = sent;
      const stacked = await deepLink(top, ctx.request, scope);
      if (sent.flash) stacked.flash = sent.flash;
      const { resolveIsland } = streaming(stacked, ctx.request, {}, scope);
      return ownResponse(new Response(await document(stacked, ctx.request, resolveIsland ? { resolveIsland } : {}, scope), {
        status: result.status,
        headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
      }));
    }
    return ownResponse(new Response(await document(sent, ctx.request, streaming(sent, ctx.request, result.props, scope), scope), {
      status: result.status,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    }));
  };
}

/** `response` with the flash messages it delivers — in a header: an action's body is its controller's data. */
function withFlash(response: Response, flash: readonly FlashMessage[]): Response {
  if (flash.length === 0) return response;
  const headers = new Headers(response.headers);
  headers.set(FLASH_HEADER, encodeURIComponent(JSON.stringify(flash)));
  headers.set('cache-control', 'no-store');
  return ownResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

/**
 * The answer to an island's request: its region object as JSON — the page object of the island route, without
 * shared props and without the page's locale. Only for a region request (`x-marmeon-region: island`): anything else —
 * a direct hit, a page visit or a prefetch of the island's URL — is a 404 (an island has no head, layout or title).
 */
async function islandResponse(
  result: IslandResult,
  ctx: ResponseContext,
  version: string | null,
  debug: boolean,
  scope: Container | undefined,
  onPage?: ResponseFactoryOptions['onPage'],
): Promise<Response> {
  const { request } = ctx;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // The types refuse this already (`Route.post(…)` with an island's controller); a route built without them fails here.
    throw new Error(`[${result.component}] is an island, and islands answer GET requests only — ${request.method} ${new URL(request.url).pathname} returned this.island(…).`);
  }
  if (regionOf(request) !== 'island' || isPrefetch(request)) {
    throw new HttpError(
      404,
      debug
        ? `[${result.component}] is an island: it is loaded by <Island route> on a page (x-marmeon-region: island), never visited, linked or prefetched by itself.`
        : undefined,
    );
  }
  const url = new URL(request.url);
  // Its own props only: the page around it has the shared ones. Partial reloads of the island name its component.
  const resolved = await resolvePageProps(result.props, undefined, partialReloadOf(request, result.component));
  const query = ctx.pageQuery ? { query: { ...ctx.pageQuery.values }, queryDefaults: { ...ctx.pageQuery.defaults } } : {};
  // The channels it follows, signed for the session of the page around it (an island's request carries its cookie).
  const live = await liveSubscriptions(liveOf(result), scope, result.component);
  const region: RegionObject = { component: result.component, ...resolved, url: url.pathname + url.search, version, ...query, ...live };
  onPage?.(request, region, 'island', () => propOrigins(result.props, undefined, Object.keys(resolved.props)));
  return ownResponse(new Response(JSON.stringify(region), {
    status: 200,
    headers: { vary: PAGE_VARY, 'content-type': 'application/json', [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island' },
  }));
}

/**
 * What a region request's response becomes on its way out — whatever the island route's middleware or controller
 * answered: the region object passes, so does a 409 (a new build: the client loads the whole page again). A redirect, a
 * 401 or a 423 is `unauthorized`, a 403 `forbidden` — `204` with `x-marmeon-region-status`, the redirect never followed,
 * so the island shows its fallback and the page never navigates. Anything else is an `exception`, with its status (an
 * error's JSON body, from the kernel, stays for development).
 */
export async function toRegionResponse(response: Response): Promise<Response> {
  if (response.ok && response.headers.get(REGION_HEADER) === 'island') return response;
  if (response.status === 409 && response.headers.has(LOCATION_HEADER)) return response;
  const outcome = regionOutcome(response.status);
  const headers = new Headers(response.headers);
  for (const name of ['location', 'set-cookie', 'content-length', PAGE_HEADER, REGION_HEADER]) headers.delete(name);
  headers.set(REGION_STATUS_HEADER, outcome);
  // An outcome is about who asked, and the island URL answers otherwise without the header: never kept, kept apart.
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store');
  const vary = headers.get('vary');
  if (!vary?.toLowerCase().split(/\s*,\s*/).includes(REGION_HEADER)) headers.set('vary', vary ? `${vary}, ${REGION_HEADER}` : REGION_HEADER);
  const json = response.headers.get('content-type')?.includes('json') ?? false;
  if (outcome !== 'exception' || !json) {
    await response.body?.cancel();
    headers.delete('content-type');
    return ownResponse(new Response(null, { status: outcome === 'exception' ? (response.status >= 400 ? response.status : 500) : 204, headers }));
  }
  return ownResponse(new Response(response.body, { status: response.status >= 400 ? response.status : 500, headers }));
}

/**
 * What an action's response becomes on its way out — whatever its route's middleware or controller answered:
 * - a redirect is not followed (the browser's `fetch` would, and the action would read the next page): `204` with
 *   {@link ACTION_REDIRECT_HEADER} — the client reports where it pointed;
 * - a 409 with `x-marmeon-location` (signed out through the action, a new build) passes: the client loads that page;
 * - never kept by any cache (`no-store`, whatever the route set): the answer is about who asked, at that moment.
 */
export async function toActionResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  const vary = headers.get('vary');
  if (!vary?.toLowerCase().split(/\s*,\s*/).includes(ACTION_HEADER)) headers.set('vary', vary ? `${vary}, ${ACTION_HEADER}` : ACTION_HEADER);
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  if (location !== null) {
    await response.body?.cancel();
    for (const name of ['location', 'content-type', 'content-length']) headers.delete(name);
    headers.set(ACTION_REDIRECT_HEADER, location);
    return ownResponse(new Response(null, { status: 204, headers }));
  }
  return ownResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

/**
 * The answer of a live validation: never cached (`no-store`, `Vary`), and a redirect of its route — middleware that sends
 * a guest away, say — becomes `204` with `x-marmeon-redirect`, like an action's: reported, not followed. Only its own `204` and
 * `422` carry `x-marmeon-validated` (the router's and the kernel's) — what the client takes for a result.
 */
export async function toLiveValidationResponse(response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store');
  const vary = headers.get('vary');
  if (!vary?.toLowerCase().split(/\s*,\s*/).includes(VALIDATE_HEADER)) headers.set('vary', vary ? `${vary}, ${VALIDATE_HEADER}` : VALIDATE_HEADER);
  const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
  if (location !== null) {
    await response.body?.cancel();
    for (const name of ['location', 'content-type', 'content-length', VALIDATED_HEADER]) headers.delete(name);
    headers.set(ACTION_REDIRECT_HEADER, location);
    return ownResponse(new Response(null, { status: 204, headers }));
  }
  return ownResponse(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
}

function regionOutcome(status: number): RegionOutcomeStatus {
  if ((status >= 300 && status < 400) || status === 401 || status === 423) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'exception';
}

/** An error's name, message and stack for a log line's context — its text masked by `redactor` (the app's). */
function errorFields(error: unknown, redactor: Redactor): { exception: string; message: string; stack?: string } {
  return error instanceof Error
    ? { exception: error.name, message: redactor.text(error.message), ...(error.stack === undefined ? {} : { stack: redactor.text(error.stack) }) }
    : { exception: 'Error', message: redactor.text(String(error)) };
}

/** The document a request of the client core names (`x-marmeon-document`, the tabSync feature) — undefined: none (a full page load). */
function documentOfRequest(request: Request): string | undefined {
  return request.headers.get(DOCUMENT_HEADER) ?? undefined;
}
