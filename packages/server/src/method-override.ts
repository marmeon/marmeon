import { DEFAULT_MAX_BODY_SIZE } from '@bespokecore/router';

/** The methods an HTML form can stand for with a `_method` field (it can only send GET and POST itself). */
const OVERRIDES = new Set(['PUT', 'PATCH', 'DELETE']);

/** The body field that names the method — Laravel's `_method` (`<Form>` renders it for PUT, PATCH and DELETE routes). */
export const METHOD_FIELD = '_method';

/**
 * Method spoofing (E64, Laravel's `_method`): a plain HTML form — `<Form>` without JavaScript — can only POST, so a PUT, PATCH
 * or DELETE route gets a POST with `_method=PUT` in its body. The request becomes that method before it is routed.
 *
 * Only from the body of a POST that a form sends (`application/x-www-form-urlencoded`, `multipart/form-data`), never from the
 * query (E65: a link could set it), only to PUT, PATCH and DELETE (never to GET — a GET has no CSRF check). CSRF verification
 * then runs for the method it became, as for any write. A body larger than `limit` is left as it is (its route answers 413).
 */
export async function overrideMethod(request: Request, limit = DEFAULT_MAX_BODY_SIZE): Promise<Request> {
  if (request.method !== 'POST' || request.body === null) return request;
  const type = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data') return request;
  const declared = Number(request.headers.get('content-length'));
  if (declared > limit) return request;
  const bytes = await readLimited(request.clone(), limit);
  if (!bytes) return request;
  let method: string | undefined;
  try {
    const form =
      type === 'application/x-www-form-urlencoded'
        ? new URLSearchParams(new TextDecoder().decode(bytes))
        : await new Response(bytes, { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
    const value = form.get(METHOD_FIELD);
    method = typeof value === 'string' ? value.trim().toUpperCase() : undefined;
  } catch {
    return request; // malformed: its route says so (400)
  }
  if (!method || !OVERRIDES.has(method)) return request;
  return new Request(request.url, { method, headers: request.headers, body: bytes, signal: request.signal });
}

/** The body, or undefined once it grows past `limit`. */
async function readLimited(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
