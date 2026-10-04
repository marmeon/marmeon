/**
 * Responses whose headers this request may change in place — the framework made them for this request (a page, a document, a
 * redirect, a region, an error page) or copied them once already. Weak: a response that is gone is forgotten.
 */
const owned = new WeakSet<Response>();

/**
 * Marks `response` as made for this request alone: middleware may set its headers in place ({@link editableResponse}). Only for a
 * response just constructed with mutable headers — never one an app could hand out twice (a module-level constant), one from
 * `fetch()` or `Response.redirect()`.
 */
export function ownResponse<R extends Response>(response: R): R {
  owned.add(response);
  return response;
}

/**
 * `response`, ready for its headers to be set: itself when this request owns it ({@link ownResponse}), else a copy it owns from
 * now on — at most one copy per request, whatever number of middleware add headers (Wave 8 step 9: four copies per page before).
 *
 * A response the framework did not make is copied rather than changed: an app may return the same `Response` object twice (a
 * constant `new Response(null, { status: 204 })`), and a cookie set in place would reach the next request that gets it; its
 * headers may also be immutable (`Response.redirect`, `fetch`).
 *
 * ```ts
 * async handle(ctx: HttpContext, next: Next<{}>) {
 *   const response = editableResponse(await next());
 *   response.headers.set('x-frame-options', 'DENY');
 *   return response;
 * }
 * ```
 */
export function editableResponse(response: Response): Response {
  if (owned.has(response)) return response;
  const copy = new Response(response.body, response);
  owned.add(copy);
  return copy;
}
