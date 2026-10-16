/**
 * The requests of the client core: a visit's URL, headers and body (JSON, or multipart with files), the CSRF token and the
 * headers of a partial reload. (Uploads with progress, over XHR, load on first use: `upload.ts`.)
 */
import { PARTIAL_COMPONENT_HEADER, PARTIAL_DATA_HEADER, PARTIAL_EXCEPT_HEADER } from '../protocol.ts';
import type { VisitMethod, VisitOptions } from './navigation.ts';

/** What the client reads of its window to tell this site's origin. */
export interface OriginWindow {
  readonly location: { readonly origin: string };
}

/**
 * The address for `path`, a path of this site (a full URL stays as it is): the origin in front, so a path that starts with two
 * slashes (a page at `//host/x` is a path on this site) is never read as a protocol-relative URL of another host.
 */
export function atOrigin(path: string, { location }: OriginWindow): string {
  return path.startsWith('/') ? location.origin + path : path;
}

/** Whether `response` came from another origin than the page's (a redirect followed to another host): it is never read as a page. */
export function isForeign({ url }: Response, { location }: OriginWindow): boolean {
  return url !== '' && !url.startsWith(location.origin + '/');
}

/**
 * The address the browser may be sent to for `url` — undefined for anything but `http:` and `https:`, as the URL parser reads it
 * (it drops tabs and newlines and a leading space, and lowercases the scheme): `javascript:`, `data:`, `blob:`, `file:` and the
 * like never reach `location`. Load the returned `href`, so the address that loads is the one that was checked, whatever
 * `<base href>` says. A refusal says why in development.
 */
export function navigable(url: string, base: string): URL | undefined {
  let target: URL | undefined;
  try {
    target = new URL(url, base);
  } catch {
    // Not a URL at all: refused below.
  }
  if (target?.protocol === 'http:' || target?.protocol === 'https:') return target;
  if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
    console.error(`[marmeon] Navigation refused: only http: and https: addresses are loaded, not ${target?.protocol ?? 'an invalid URL'}`);
  }
  return undefined;
}

/** The CSRF token the server put into the readable `XSRF-TOKEN` cookie. */
export function xsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * The URL, headers and body of a request to `target`: a GET's data goes into the query, a write's into the body (with the XSRF
 * token). A list in a GET's data is the key repeated (`{ role: ['admin', 'owner'] }` → `?role=admin&role=owner`) — what the
 * server's query schema reads as a list, and what `toSearchParams` writes.
 */
export function buildRequest(target: URL, method: VisitMethod, data: VisitOptions['data']): { url: string; headers: Record<string, string>; body?: BodyInit } {
  if (method === 'get') {
    if (data && !(data instanceof FormData)) {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) continue;
        target.searchParams.delete(key);
        for (const item of [value].flat()) if (item !== undefined && item !== null) target.searchParams.append(key, String(item));
      }
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
