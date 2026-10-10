/**
 * Uploads with progress (`FormData` with an `onProgress` listener): over XHR — a chunk of its own, loaded with the first such
 * upload. A chunk that cannot load sends the upload with `fetch`, without progress.
 */
import type { VisitProgress } from './events.ts';

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
    // Aborted while this code loaded: nothing is sent.
    if (signal.aborted) return reject(new DOMException('The visit was aborted.', 'AbortError'));
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
