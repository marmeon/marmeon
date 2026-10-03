import type { Disk } from './disk.ts';
import { FileNotFoundError, InvalidKeyError } from './errors.ts';
import { basename } from './keys.ts';
import { contentDisposition, isInlineType, mimeTypeOf } from './mime.ts';

export interface ServeOptions {
  /** `Cache-Control` of the response. */
  readonly cacheControl: string;
  /** The name the browser saves the file as (default: the key's last segment). */
  readonly filename?: string | undefined;
}

/**
 * The headers every file a disk serves goes out with:
 *
 * - `X-Content-Type-Options: nosniff` — the browser takes the content type as sent, never guesses HTML in a "picture";
 * - `Content-Security-Policy: sandbox` — should a file be rendered after all, it runs in a sandbox: no script, a unique
 *   origin (no cookies, no access to the app);
 * - `Content-Disposition: attachment` for everything but raster images (PNG, JPEG, GIF, WebP, AVIF) — HTML, SVG, PDF, XML
 *   and text are downloaded, never shown on the app's origin.
 */
export function fileHeaders(key: string, contentType: string, options: ServeOptions): Headers {
  const filename = options.filename ?? basename(key);
  // The type by the name the file goes out as: a ".png" key with HTML in it stays an image/png (and nosniff keeps it one).
  const type = contentType || mimeTypeOf(filename);
  return new Headers({
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'content-disposition': contentDisposition(isInlineType(type) ? 'inline' : 'attachment', filename),
    'cache-control': options.cacheControl,
  });
}

/** A file of a disk as a response — 404 for a missing file or a refused key, 304 when `If-Modified-Since` still holds. */
export async function serveFile(disk: Disk, key: string, request: Request, options: ServeOptions): Promise<Response> {
  let file;
  try {
    file = await disk.open(key);
  } catch (error) {
    if (error instanceof FileNotFoundError || error instanceof InvalidKeyError) return notFound();
    throw error;
  }
  const headers = fileHeaders(key, file.contentType, options);
  const modified = new Date(Math.floor(file.lastModified.getTime() / 1000) * 1000);
  headers.set('last-modified', modified.toUTCString());
  const since = Date.parse(request.headers.get('if-modified-since') ?? '');
  if (!Number.isNaN(since) && modified.getTime() <= since) {
    await file.body.cancel();
    return new Response(null, { status: 304, headers });
  }
  headers.set('content-length', String(file.size));
  if (request.method === 'HEAD') {
    await file.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(file.body, { status: 200, headers });
}

/** The same 404 for "no such file" and "no such key": nothing tells which files exist. */
export function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
}
