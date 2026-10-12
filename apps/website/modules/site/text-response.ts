/** A plain `Response` with a content type (`@marmeon/http` has no text helper; `new Response` is the documented way, docs/responses.md). */
export function textResponse(body: string, contentType: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { headers: { ...headers, 'content-type': contentType } });
}
