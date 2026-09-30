import type { Container } from '@bespokecore/core';
import { Flasher, isRedirectResult, isViewResult, PAGE_HEADER, SharedData, type PageObject, type UrlGenerator } from '@bespokecore/http';
import { defaultToResponse, type ResponseFactory } from '@bespokecore/router';
import { FALLBACK_TEMPLATE, renderDocument } from './html.ts';

/** Turns a page object into a full HTML document (SSR). Implemented per environment. */
export interface PageRenderer {
  render(page: PageObject, request: Request): Promise<string>;
}

/** Renders an empty shell with the page object — the client renders everything. */
export const shellRenderer: PageRenderer = {
  render: async (page) => renderDocument(FALLBACK_TEMPLATE, page, { html: '' }),
};

/** A response factory that may use the request's container scope (the kernel passes it). */
export type ScopedResponseFactory = (...args: [...Parameters<ResponseFactory>, scope?: Container]) => ReturnType<ResponseFactory>;

/**
 * Turns controller results into HTTP responses. Client-side navigations get the
 * page object as JSON, full page loads get a server-rendered document. Redirects
 * resolve named routes through `urls` (the router) and flash through the scope's `Flasher`.
 */
export function createResponseFactory(renderer: PageRenderer = shellRenderer, urls?: UrlGenerator): ScopedResponseFactory {
  const noRouter: UrlGenerator = {
    url: (name) => {
      throw new Error(`Cannot redirect to route [${name}]: the response factory has no router.`);
    },
  };

  return async (result, ctx, scope) => {
    if (isRedirectResult(result)) {
      const flasher = scope?.has(Flasher) ? scope.make(Flasher) : undefined;
      return result.toResponse(ctx.request, urls ?? noRouter, flasher);
    }
    if (!isViewResult(result)) return defaultToResponse(result, ctx);

    const url = new URL(ctx.request.url);
    // Shared props first, so a controller's own prop of the same name wins.
    const shared = scope?.has(SharedData) ? await scope.make(SharedData).resolve() : {};
    const page: PageObject = { component: result.component, props: { ...shared, ...result.props }, url: url.pathname + url.search };
    const headers = { vary: PAGE_HEADER };

    if (ctx.request.headers.get(PAGE_HEADER) === 'true') {
      return Response.json(page, { status: result.status, headers: { ...headers, [PAGE_HEADER]: 'true' } });
    }

    return new Response(await renderer.render(page, ctx.request), {
      status: result.status,
      headers: { ...headers, 'content-type': 'text/html; charset=utf-8' },
    });
  };
}
