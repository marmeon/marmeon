import { isViewResult, type ViewResult } from '@bespokecore/core';
import { defaultToResponse, type ResponseFactory } from '@bespokecore/router';

export interface PageObject {
  component: string;
  props: ViewResult['props'];
  url: string;
}

/** Client-side navigations send this header and receive the page object as JSON. */
export const PAGE_HEADER = 'x-bespoke';

/**
 * Turns controller results into HTTP responses. `ViewResult`s become an HTML
 * shell carrying the page object; Vite-powered SSR will replace the shell body.
 */
export const renderResponse: ResponseFactory = (result, ctx) => {
  if (!isViewResult(result)) return defaultToResponse(result, ctx);

  const page: PageObject = {
    component: result.component,
    props: result.props,
    url: new URL(ctx.request.url).pathname,
  };

  if (ctx.request.headers.get(PAGE_HEADER) === 'true') {
    return Response.json(page, { status: result.status, headers: { vary: PAGE_HEADER, [PAGE_HEADER]: 'true' } });
  }

  return new Response(htmlShell(page), {
    status: result.status,
    headers: { 'content-type': 'text/html; charset=utf-8', vary: PAGE_HEADER },
  });
};

function htmlShell(page: PageObject): string {
  // `<` is escaped so props can never close the script tag early.
  const json = JSON.stringify(page).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>BespokeCore</title></head>
  <body>
    <div id="app"></div>
    <script type="application/json" id="bespoke-page">${json}</script>
  </body>
</html>`;
}
