import { isRedirectResult, isViewResult, PAGE_HEADER, type PageObject, type UrlGenerator } from '@bespokecore/http';
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

/**
 * Turns controller results into HTTP responses. Client-side navigations get the
 * page object as JSON, full page loads get a server-rendered document. Redirects
 * resolve named routes through `urls` (the router).
 */
export function createResponseFactory(renderer: PageRenderer = shellRenderer, urls?: UrlGenerator): ResponseFactory {
  const noRouter: UrlGenerator = {
    url: (name) => {
      throw new Error(`Cannot redirect to route [${name}]: the response factory has no router.`);
    },
  };

  return async (result, ctx) => {
    if (isRedirectResult(result)) return result.toResponse(ctx.request, urls ?? noRouter);
    if (!isViewResult(result)) return defaultToResponse(result, ctx);

    const url = new URL(ctx.request.url);
    const page: PageObject = { component: result.component, props: result.props, url: url.pathname + url.search };
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
