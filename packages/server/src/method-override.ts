/** The methods an HTML form can stand for with a `_method` field (it can only send GET and POST itself). */
const OVERRIDES = new Set(['PUT', 'PATCH', 'DELETE']);

/** The body field that names the method (`<Form>` renders it for PUT, PATCH and DELETE routes). */
export const METHOD_FIELD = '_method';

/**
 * How much of a body is read to find `_method`: the fields at its start — `<Form>` renders `_method` first, a form
 * written by hand has it next to `_token`. The body is never read twice: what was read goes on, ahead of the rest of the stream.
 */
export const METHOD_FIELD_WINDOW = 16 * 1024;

/**
 * Method spoofing: a plain HTML form — `<Form>` without JavaScript — can only POST, so a PUT, PATCH
 * or DELETE route gets a POST with `_method=PUT` in its body. The request becomes that method before it is routed.
 *
 * Only from the body of a POST that a form sends (`application/x-www-form-urlencoded`, `multipart/form-data`), never from the
 * query (a link could set it), only to PUT, PATCH and DELETE (never to GET — a GET has no CSRF check). CSRF verification
 * then runs for the method it became, as for any write.
 *
 * Only the complete fields within the first {@link METHOD_FIELD_WINDOW} bytes count — before the first file of a multipart
 * body: the body is read once, by its route (bounded by `SERVER_MAX_BODY_MB`), not buffered here first.
 */
export async function overrideMethod(request: Request): Promise<Request> {
  if (request.method !== 'POST' || request.body === null) return request;
  const contentType = request.headers.get('content-type') ?? '';
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data') return request;

  const reader = request.body.getReader();
  const head: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < METHOD_FIELD_WINDOW) {
    const chunk = await reader.read();
    if (chunk.done) {
      done = true;
      break;
    }
    head.push(chunk.value);
    size += chunk.value.byteLength;
  }
  const bytes = concat(head, Math.min(size, METHOD_FIELD_WINDOW));
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const value = type === 'application/x-www-form-urlencoded' ? fromUrlEncoded(text, done && size <= METHOD_FIELD_WINDOW) : fromMultipart(text, contentType);
  const method = value?.trim().toUpperCase();

  // What was read goes first, then the rest of the stream — as it came.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Request(request.url, {
    method: method && OVERRIDES.has(method) ? method : request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    duplex: 'half',
  } as RequestInit);
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    bytes.set(chunk.subarray(0, length - offset), offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** `_method` among the complete `name=value` pairs of the start of a urlencoded body (`whole`: the body ends there). */
function fromUrlEncoded(text: string, whole: boolean): string | undefined {
  const complete = whole ? text : text.slice(0, Math.max(0, text.lastIndexOf('&')));
  try {
    return new URLSearchParams(complete).get(METHOD_FIELD) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * `_method` among the complete fields at the start of a multipart body — up to the first file (whatever comes after it is not
 * read here).
 */
function fromMultipart(text: string, contentType: string): string | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const delimiter = `--${(boundary?.[1] ?? boundary?.[2] ?? '').trim()}`;
  if (delimiter === '--') return undefined;
  let at = text.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (text.startsWith('--', start)) return undefined; // the end of the body
    const headersEnd = text.indexOf('\r\n\r\n', start);
    if (headersEnd === -1) return undefined;
    const headers = text.slice(start, headersEnd);
    if (/filename\*?=/i.test(headers)) return undefined; // a file: nothing after it is looked at
    const next = text.indexOf(`\r\n${delimiter}`, headersEnd + 4);
    if (next === -1) return undefined; // a field that goes on past what was read
    const name = /name="([^"]*)"/i.exec(headers)?.[1];
    if (name === METHOD_FIELD) return text.slice(headersEnd + 4, next);
    at = next + 2;
  }
  return undefined;
}
