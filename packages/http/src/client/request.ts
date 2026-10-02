/**
 * The requests of the client core: a visit's URL, headers and body (JSON, or multipart with files), the CSRF token, the
 * headers of a partial reload, and uploads with progress (XHR).
 */
import { PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER } from '../page.ts';
import type { VisitProgress } from './events.ts';
import type { VisitMethod, VisitOptions } from './navigation.ts';

/** The CSRF token the server put into the readable `XSRF-TOKEN` cookie. */
export function xsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/** The URL, headers and body of a request to `target`: a GET's data goes into the query, a write's into the body (with the XSRF token). */
export function buildRequest(target: URL, method: VisitMethod, data: VisitOptions['data']): { url: string; headers: Record<string, string>; body?: BodyInit } {
  if (method === 'get') {
    if (data && !(data instanceof FormData)) {
      for (const [key, value] of Object.entries(data)) if (value !== undefined && value !== null) target.searchParams.set(key, String(value));
    }
    return { url: target.pathname + target.search, headers: {} };
  }
  const url = target.pathname + target.search;
  const token = xsrfToken();
  const headers: Record<string, string> = token ? { 'x-xsrf-token': token } : {};
  // Multipart for files — the browser sets the boundary.
  if (data instanceof FormData) return { url, headers, body: data };
  if (data && hasFiles(data)) return { url, headers, body: toFormData(data) };
  return { url, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) };
}

/** The headers of a partial reload of `component` — of a page, a layer or a region. */
export function partialReloadHeaders(component: string, only: readonly string[] | undefined, except: readonly string[] | undefined): Record<string, string> {
  return {
    [PARTIAL_COMPONENT_HEADER]: component,
    ...(only === undefined ? {} : { [PARTIAL_DATA_HEADER]: only.join(',') }),
    ...(except && except.length > 0 ? { [PARTIAL_EXCEPT_HEADER]: except.join(',') } : {}),
  };
}

function hasFiles(value: unknown): boolean {
  if (value instanceof Blob) return true;
  if (Array.isArray(value)) return value.some(hasFiles);
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasFiles);
  return false;
}

/**
 * Data with a file in it, as multipart: nested keys in brackets (`links[0][url]`), the notation the server
 * parses back into objects. As in any HTML form, other values become strings — `true` is `1`, `false` is `0`,
 * `null` is empty.
 */
function toFormData(data: Record<string, unknown>, form = new FormData(), prefix = ''): FormData {
  for (const [key, value] of Object.entries(data)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) continue;
    if (value instanceof Blob) form.append(name, value);
    else if (Array.isArray(value)) toFormData(Object.fromEntries(value.map((item, index) => [String(index), item])), form, name);
    else if (typeof value === 'object' && value !== null) toFormData(value as Record<string, unknown>, form, name);
    else form.append(name, value === null ? '' : typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
  }
  return form;
}

/**
 * XHR, because `fetch` reports no upload progress (streaming request bodies need HTTP/2 in Chromium, and
 * a `FormData` body would have to be streamed by hand). Answers with a `Response` like `fetch`.
 */
export function sendWithProgress(
  Xhr: new () => XMLHttpRequest,
  url: string,
  { method, headers, body, signal }: { method: string; headers: Record<string, string>; body?: BodyInit; signal: AbortSignal },
  onProgress: (progress: VisitProgress) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new Xhr();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', (event) => {
      const total = event.lengthComputable && event.total > 0 ? event.total : undefined;
      onProgress({ loaded: event.loaded, total, percentage: total === undefined ? undefined : Math.round((event.loaded / total) * 100) });
    });
    xhr.addEventListener('load', () => {
      const responseHeaders = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const colon = line.indexOf(':');
        if (colon > 0) responseHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
      const empty = [101, 204, 205, 304].includes(xhr.status);
      const response = new Response(empty ? null : xhr.responseText, { status: xhr.status, statusText: xhr.statusText, headers: responseHeaders });
      Object.defineProperty(response, 'url', { value: xhr.responseURL });
      resolve(response);
    });
    xhr.addEventListener('error', () => reject(new TypeError('Network request failed')));
    xhr.addEventListener('abort', () => reject(new DOMException('The visit was aborted.', 'AbortError')));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body as XMLHttpRequestBodyInit);
  });
}

/** `promise`, or undefined as soon as `signal` aborts — a newer visit does not wait for a page fetched ahead it does not need. */
export function untilAborted<T>(promise: Promise<T | undefined>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const abort = () => resolve(undefined);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    });
  });
}
