import type { Container } from '@bespokecore/core';
import {
  Flasher,
  isRedirectResult,
  isViewResult,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  partialReloadOf,
  resolvePageProps,
  SharedData,
  type PageObject,
} from '@bespokecore/http';
import { defaultToResponse, type ResponseFactory, type RouteLookup } from '@bespokecore/router';
import { FALLBACK_TEMPLATE, renderDocument } from './html.ts';

/** Turns a page object into a full HTML document (SSR). Implemented per environment. */
export interface PageRenderer {
  render(page: PageObject, request: Request): Promise<string>;
  /** Version of the built assets; undefined in development (no checks while Vite serves sources). */
  readonly version?: string;
}

/** Renders an empty shell with the page object — the client renders everything. */
export const shellRenderer: PageRenderer = {
  render: async (page) => renderDocument(FALLBACK_TEMPLATE, page, { html: '' }),
};

/**
 * Page responses differ by these request headers: a page document or its JSON (`x-bespoke`), all props or some
 * (a partial reload). A cache (`Cache-Control: private, max-age=…`) must never answer one with the other.
 */
const PAGE_VARY = [PAGE_HEADER, PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER].join(', ');

/** A response factory that may use the request's container scope (the kernel passes it). */
export type ScopedResponseFactory = (...args: [...Parameters<ResponseFactory>, scope?: Container]) => ReturnType<ResponseFactory>;

/**
 * Turns controller results into HTTP responses. Client-side navigations get the
 * page object as JSON, full page loads get a server-rendered document. A partial reload of the rendered component
 * gets only the props it asks for (and only those are computed — see `resolvePageProps`). Redirects
 * resolve named routes through `routes` (the router) and flash through the scope's `Flasher`.
 */
export function createResponseFactory(
  renderer: PageRenderer = shellRenderer,
  routes?: RouteLookup,
  version: string | null = null,
): ScopedResponseFactory {
  const noRouter: RouteLookup = {
    findByName: (name) => {
      throw new Error(`Cannot redirect to route [${name}]: the response factory has no router.`);
    },
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
    const page: PageObject = { component: result.component, ...resolved, url: url.pathname + url.search, version };
    const headers = { ...result.headers, vary: PAGE_VARY };

    if (ctx.request.headers.get(PAGE_HEADER) === 'true') {
      return Response.json(page, { status: result.status, headers: { ...headers, [PAGE_HEADER]: 'true' } });
    }

    return new Response(await renderer.render(page, ctx.request), {
      status: result.status,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    });
  };
}
