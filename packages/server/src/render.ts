import { ConsoleLogger, Translator, type Container, type Logger } from '@bespokecore/core';
import {
  Flasher,
  HttpError,
  isIslandResult,
  isPrefetch,
  isRedirectResult,
  isViewResult,
  LOCATION_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  partialReloadOf,
  REGION_HEADER,
  REGION_STATUS_HEADER,
  regionOf,
  resolvePageProps,
  SharedData,
  type IslandResult,
  type PageObject,
  type RegionObject,
  type RegionOutcomeStatus,
  type SsrRender,
} from '@bespokecore/http';
import { defaultToResponse, type ResponseContext, type ResponseFactory, type RouteLookup } from '@bespokecore/router';
import { documentOf, FALLBACK_TEMPLATE, renderDocument } from './html.ts';

export interface PageRenderOptions {
  /** Wait for the whole page before sending — for bots (see {@link isBot}). */
  complete: boolean;
  /** An error after the shell (the browser renders that part instead) — the response is already on its way. */
  onError(error: unknown): void;
  /** A hint for the developer (development only). */
  onWarning(message: string): void;
  /** Stops rendering when the client went away. */
  signal?: AbortSignal;
}

/** Turns a page object into a full HTML document. Implemented per environment (Vite in development, the build in production). */
export interface PageRenderer {
  /**
   * The document with the server-rendered page — streamed: the head and the shell first, Suspense boundaries as they
   * finish. Rejects when the page cannot render on the server (an error in the shell).
   */
  render(page: PageObject, request: Request, options: PageRenderOptions): Promise<string | ReadableStream<Uint8Array>>;
  /** The document without markup: the browser renders the page (server rendering failed, or is off). */
  shell(page: PageObject, request: Request): Promise<string>;
  /** Version of the built assets; undefined in development (no checks while Vite serves sources). */
  readonly version?: string;
}

export interface DocumentRendererOptions {
  /** The app's `index.html`, per request (Vite transforms it in development). */
  template(request: Request): string | Promise<string>;
  /** The app's SSR entry (`render` of `bootstrap/ssr.tsx`). */
  ssr(): SsrRender | Promise<SsrRender>;
  /** Maps an error's stack to the sources (Vite's `ssrFixStacktrace` in development). */
  fixStack?(error: unknown): void;
  version?: string;
}

/** A renderer from a template and an SSR entry — the one code path of the development and the production renderer. */
export function createDocumentRenderer({ template, ssr, fixStack, version }: DocumentRendererOptions): PageRenderer {
  const fixed = (error: unknown) => {
    if (error instanceof Error) fixStack?.(error);
    return error;
  };
  return {
    async render(page, request, { complete, onError, onWarning, signal }) {
      const [document, render] = await Promise.all([template(request), ssr()]);
      // Rendering stops when the client goes away — the request aborts, or the server cancels the body. Not an error.
      const stopped = new AbortController();
      try {
        const result = await render(page, {
          complete,
          signal: signal ? AbortSignal.any([signal, stopped.signal]) : stopped.signal,
          onWarning,
          onError: (error) => onError(fixed(error)),
        });
        return documentOf(document, page, result, (reason) => stopped.abort(reason));
      } catch (error) {
        throw fixed(error);
      }
    },
    async shell(page, request) {
      return renderDocument(await template(request), page, { html: '' });
    },
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
 * Page responses differ by these request headers: a page document or its JSON (`x-bespoke`), all props or some
 * (a partial reload), a prefetch or the visit (`Purpose` — a page may skip side effects for a prefetch). A cache
 * (`Cache-Control: private, max-age=…`) must never answer one with the other.
 */
const PAGE_VARY = [PAGE_HEADER, REGION_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, PURPOSE_HEADER].join(', ');

/** A response factory that may use the request's container scope (the kernel passes it). */
export type ScopedResponseFactory = (...args: [...Parameters<ResponseFactory>, scope?: Container]) => ReturnType<ResponseFactory>;

export interface ResponseFactoryOptions {
  /** Where server-rendering errors go. */
  logger?: Logger;
  /** Server rendering at all (`SSR_ENABLED=false` turns it off for every page: the browser renders them). Default: on. */
  ssr?: boolean;
  /** Development: say why an island (or a page) is a 404 where it was asked for the other. */
  debug?: boolean;
}

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
  { logger = new ConsoleLogger({ channel: 'ssr' }), ssr = true, debug = false }: ResponseFactoryOptions = {},
): ScopedResponseFactory {
  const noRouter: RouteLookup = {
    findByName: (name) => {
      throw new Error(`Cannot redirect to route [${name}]: the response factory has no router.`);
    },
  };

  const document = async (page: PageObject, request: Request): Promise<string | ReadableStream<Uint8Array>> => {
    if (!ssr) return renderer.shell(page, request);
    const report = (message: string) => (error: unknown) => logger.error(message, { component: page.component, ...describe(error) });
    try {
      return await renderer.render(page, request, {
        complete: isBot(request),
        signal: request.signal,
        onError: report(`Server rendering of [${page.component}] failed in a Suspense boundary — the browser renders that part`),
        onWarning: (message) => logger.warn(message, { component: page.component }),
      });
    } catch (error) {
      report(`Server rendering of [${page.component}] failed — the browser renders the page`)(error);
      return renderer.shell(page, request);
    }
  };

  return async (result, ctx, scope) => {
    if (isRedirectResult(result)) {
      const flasher = scope?.has(Flasher) ? scope.make(Flasher) : undefined;
      return result.toResponse(ctx.request, routes ?? noRouter, flasher);
    }
    if (isIslandResult(result)) return islandResponse(result, ctx, version, debug);
    if (!isViewResult(result)) return defaultToResponse(result, ctx);
    if (regionOf(ctx.request)) {
      // `<Island route>` takes island routes only (a type error otherwise) — at runtime a page is not one either.
      throw new HttpError(404, debug ? `[${result.component}] is a page, not an island — its controller returns this.view(…); an island's returns this.island(…).` : undefined);
    }

    const url = new URL(ctx.request.url);
    const shared = scope?.has(SharedData) ? scope.make(SharedData) : undefined;
    // Shared props and the controller's (which win), resolved as far as this response sends them.
    const resolved = await resolvePageProps(result.props, shared, partialReloadOf(ctx.request, result.component));
    // The page's language — the request's translator speaks one of the app's locales (never a raw header value).
    const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
    const language = translator ? { locale: translator.locale, ...(translator.fallbackLocale ? { fallbackLocale: translator.fallbackLocale } : {}) } : {};
    // The parsed query (E55), for `useQueryState`: what the URL set validly, and the defaults — never parsed again in the browser.
    const query = ctx.pageQuery ? { query: { ...ctx.pageQuery.values }, queryDefaults: { ...ctx.pageQuery.defaults } } : {};
    const page: PageObject = { component: result.component, ...resolved, url: url.pathname + url.search, version, ...language, ...query };
    const headers = { ...result.headers, vary: PAGE_VARY };

    // Serialized once: what the browser gets is also what the server renders from — a Date is a string on both
    // sides (`Serialize<T>`), so the markup hydrates.
    const json = JSON.stringify(page);
    if (ctx.request.headers.get(PAGE_HEADER) === 'true') {
      return new Response(json, { status: result.status, headers: { ...headers, 'content-type': 'application/json', [PAGE_HEADER]: 'true' } });
    }

    return new Response(await document(JSON.parse(json) as PageObject, ctx.request), {
      status: result.status,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    });
  };
}

/**
 * The answer to an island's request (E48, E52): its region object as JSON — the page object of the island route, without
 * shared props and without the page's locale. Only for a region request (`x-bespoke-region: island`): anything else —
 * a direct hit, a page visit or a prefetch of the island's URL — is a 404 (an island has no head, layout or title).
 */
async function islandResponse(
  result: IslandResult,
  ctx: ResponseContext,
  version: string | null,
  debug: boolean,
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
        ? `[${result.component}] is an island: it is loaded by <Island route> on a page (x-bespoke-region: island), never visited, linked or prefetched by itself.`
        : undefined,
    );
  }
  const url = new URL(request.url);
  // Its own props only: the page around it has the shared ones. Partial reloads of the island name its component.
  const resolved = await resolvePageProps(result.props, undefined, partialReloadOf(request, result.component));
  const query = ctx.pageQuery ? { query: { ...ctx.pageQuery.values }, queryDefaults: { ...ctx.pageQuery.defaults } } : {};
  const region: RegionObject = { component: result.component, ...resolved, url: url.pathname + url.search, version, ...query };
  return new Response(JSON.stringify(region), {
    status: 200,
    headers: { vary: PAGE_VARY, 'content-type': 'application/json', [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island' },
  });
}

/**
 * What a region request's response becomes on its way out (E52) — whatever the island route's middleware or controller
 * answered: the region object passes, so does a 409 (a new build: the client loads the whole page again). A redirect, a
 * 401 or a 423 is `unauthorized`, a 403 `forbidden` — `204` with `x-bespoke-region-status`, the redirect never followed,
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
    return new Response(null, { status: outcome === 'exception' ? (response.status >= 400 ? response.status : 500) : 204, headers });
  }
  return new Response(response.body, { status: response.status >= 400 ? response.status : 500, headers });
}

function regionOutcome(status: number): RegionOutcomeStatus {
  if ((status >= 300 && status < 400) || status === 401 || status === 423) return 'unauthorized';
  if (status === 403) return 'forbidden';
  return 'exception';
}

function describe(error: unknown): { exception: string; message: string; stack?: string } {
  return error instanceof Error
    ? { exception: error.name, message: error.message, stack: error.stack }
    : { exception: 'Error', message: String(error) };
}
