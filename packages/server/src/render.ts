import { ConsoleLogger, Translator, type Container, type Logger } from '@bespokecore/core';
import {
  Flasher,
  isRedirectResult,
  isViewResult,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  partialReloadOf,
  resolvePageProps,
  SharedData,
  type PageObject,
  type SsrRender,
} from '@bespokecore/http';
import { defaultToResponse, type ResponseFactory, type RouteLookup } from '@bespokecore/router';
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
const PAGE_VARY = [PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER, PURPOSE_HEADER].join(', ');

/** A response factory that may use the request's container scope (the kernel passes it). */
export type ScopedResponseFactory = (...args: [...Parameters<ResponseFactory>, scope?: Container]) => ReturnType<ResponseFactory>;

export interface ResponseFactoryOptions {
  /** Where server-rendering errors go. */
  logger?: Logger;
  /** Server rendering at all (`SSR_ENABLED=false` turns it off for every page: the browser renders them). Default: on. */
  ssr?: boolean;
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
  { logger = new ConsoleLogger({ channel: 'ssr' }), ssr = true }: ResponseFactoryOptions = {},
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
    if (!isViewResult(result)) return defaultToResponse(result, ctx);

    const url = new URL(ctx.request.url);
    const shared = scope?.has(SharedData) ? scope.make(SharedData) : undefined;
    // Shared props and the controller's (which win), resolved as far as this response sends them.
    const resolved = await resolvePageProps(result.props, shared, partialReloadOf(ctx.request, result.component));
    // The page's language — the request's translator speaks one of the app's locales (never a raw header value).
    const translator = scope?.has(Translator) ? scope.make(Translator) : undefined;
    const language = translator ? { locale: translator.locale, ...(translator.fallbackLocale ? { fallbackLocale: translator.fallbackLocale } : {}) } : {};
    const page: PageObject = { component: result.component, ...resolved, url: url.pathname + url.search, version, ...language };
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

function describe(error: unknown): { exception: string; message: string; stack?: string } {
  return error instanceof Error
    ? { exception: error.name, message: error.message, stack: error.stack }
    : { exception: 'Error', message: String(error) };
}
