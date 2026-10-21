import { editableResponse, type HttpContext, type Next } from '@marmeon/http';

/**
 * Route middleware for everything under `/docs/<line>`: the answer says it is not to be indexed. The HTML pages say so in the
 * page too (`<meta name="robots">`); Markdown and text have no head, so the header is what a crawler reads there.
 */
export class NoIndexLine {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const response = editableResponse(await next());
    response.headers.set('x-robots-tag', 'noindex');
    return response;
  }
}
