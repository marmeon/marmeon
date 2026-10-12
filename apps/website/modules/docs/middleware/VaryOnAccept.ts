import { editableResponse, type HttpContext, type Next } from '@marmeon/http';

/**
 * Route middleware for the pages that answer Markdown or HTML by `Accept`: both variants say so in `Vary`, so a shared cache
 * never hands the Markdown a tool asked for to a browser, or the other way round.
 */
export class VaryOnAccept {
  async handle(_ctx: HttpContext, next: Next<{}>) {
    const response = editableResponse(await next());
    response.headers.append('vary', 'Accept');
    return response;
  }
}
