import type { ByteRange, Disk, OpenedFile } from './disk.ts';
import { FileNotFoundError, InvalidKeyError } from './errors.ts';
import { basename } from './keys.ts';
import { contentDisposition, isInlineType, mimeTypeOf } from './mime.ts';
import { isFrameworkDisk } from './framework-disks.ts';
import { confirmedRange, parseRange } from './ranges.ts';
import { lengthOf } from './size.ts';

/**
 * What `serveFile()` takes: the `Cache-Control` of the response, the name the browser saves the file as and whether a `Range`
 * request gets only those bytes. See docs/storage.md#public-and-private-files.
 */
export interface ServeFileOptions {
  /** `Cache-Control` of the response. */
  readonly cacheControl: string;
  /** The name the browser saves the file as (default: the key's last segment). */
  readonly filename?: string | undefined;
  /**
   * Answer a `Range` request of a GET with 206 (or 416) and ask the disk for those bytes only (default: `false`, the whole file
   * is always sent). Only a disk from `Storage` that honours ranges (local, memory, S3, or a driver with `acceptsRanges: true`)
   * answers one; any other disk object, your own or a wrapper, `Proxy` or copy of one from `Storage`, sends the whole file as
   * 200. A route that changes the bytes `serveFile()` returns leaves `ranges` off: it would change a slice. Leave it off too for
   * a route that counts a download per request. See docs/storage.md#ranges-and-video.
   */
  readonly ranges?: boolean | undefined;
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
export function fileHeaders(key: string, contentType: string, options: ServeFileOptions): Headers {
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

/** The file of one `open()`, as `serveFile()` reads it: each field once, so what is checked is what goes out. */
type Snapshot = { readonly file: OpenedFile; readonly answer: unknown; readonly claims: boolean; readonly headers: Headers; readonly modified: Date; readonly time: number };

/** Cancels a body that will not be sent; a body that is locked or already closed is nothing to report. */
async function release(body: ReadableStream<Uint8Array> | undefined): Promise<void> {
  try {
    await body?.cancel();
  } catch {
    // nothing to report for a body that cannot be cancelled
  }
}

/** The `Last-Modified` time as the header carries it: whole seconds. */
const wholeSeconds = (time: Date) => new Date(Math.floor(time.getTime() / 1000) * 1000);

/**
 * A file of a disk as a response — 404 for a missing file or a refused key, 304 when `If-Modified-Since` still holds. Its
 * `Content-Length` is the disk's size, and `startServer()` holds the body to it. An S3 store that names no length gets none.
 * With `ranges: true` a `Range` request of a GET gets 206 or 416, and a disk from `Storage` that honours ranges is asked for those
 * bytes only; any other disk sends the whole file as 200. Throws a `StorageError` when the disk answers another range than
 * the one asked. See docs/storage.md#public-and-private-files and docs/responses.md#downloads.
 */
export async function serveFile(disk: Disk, key: string, request: Request, options: ServeFileOptions): Promise<Response> {
  const ranges = options.ranges === true;
  // Identity, not a property: a wrapper or a copy of a disk is not one, and its `open()` is never given a range.
  const ours = isFrameworkDisk(disk);
  const wanted = ranges && request.method === 'GET' && ours ? parseRange(request.headers.get('range')) : undefined;
  const ifRange = request.headers.get('if-range');
  // An entity tag, or a date that does not parse, is no validator to compare: the whole file is the answer.
  let range = wanted !== undefined && (ifRange === null || !Number.isNaN(Date.parse(ifRange))) ? wanted : undefined;

  const open = async (asked: ByteRange | undefined): Promise<OpenedFile | undefined> => {
    try {
      return await (asked === undefined ? disk.open(key) : disk.open(key, { range: asked }));
    } catch (error) {
      if (error instanceof FileNotFoundError || error instanceof InvalidKeyError) return undefined;
      throw error;
    }
  };
  const snapshot = (file: OpenedFile): Snapshot => {
    const { body, size, lastModified, contentType } = file;
    const claims = ours && file.acceptsRanges === true;
    const answer = (file as { range?: unknown }).range;
    const headers = fileHeaders(key, contentType, options);
    const modified = wholeSeconds(lastModified);
    headers.set('last-modified', modified.toUTCString());
    return { file: { body, size, lastModified, contentType }, answer, claims, headers, modified, time: lastModified.getTime() };
  };
  const first = await open(range);
  if (first === undefined) return notFound();
  let current: Snapshot;
  try {
    current = snapshot(first);
  } catch (error) {
    await release(first.body);
    throw error;
  }
  let body = current.file.body;
  try {
    const since = Date.parse(request.headers.get('if-modified-since') ?? '');
    if (!Number.isNaN(since) && current.modified.getTime() <= since) {
      await release(body);
      if (ranges && current.claims) current.headers.set('accept-ranges', 'bytes');
      return new Response(null, { status: 304, headers: current.headers });
    }
    if (range !== undefined && ifRange !== null) {
      // The date is a strong validator only when it is this exact text and the file is at least a second older than now (by its
      // exact time, not the header's whole seconds, so a file changed twice within a second is not taken for unchanged).
      const { time } = current;
      if (ifRange !== current.headers.get('last-modified') || !(time > 0) || !(Date.now() - time >= 1000)) {
        await release(body);
        const again = await open(undefined);
        if (again === undefined) return notFound();
        try {
          current = snapshot(again);
        } catch (error) {
          await release(again.body);
          throw error;
        }
        body = current.file.body;
        range = undefined;
      }
    }
    let served: OpenedFile = current.file;
    let answer: OpenedFile['range'];
    if (range !== undefined) {
      // Local, memory and S3 disks do not pass through `GuardedDisk`: confirm their answer here.
      const confirmed = await confirmedRange(range, { ...current.file, range: current.answer as OpenedFile['range'] });
      body = confirmed.body;
      answer = confirmed.range;
      served = confirmed;
    }
    const { headers } = current;
    if (ranges && (current.claims || answer !== undefined)) headers.set('accept-ranges', 'bytes');
    if (answer === 'unsatisfiable') {
      await release(body);
      headers.set('content-range', `bytes */${served.size}`);
      headers.set('content-length', '0');
      headers.set('cache-control', 'no-store');
      return new Response(null, { status: 416, headers });
    }
    if (answer !== undefined) {
      headers.set('content-range', `bytes ${answer.start}-${answer.end}/${served.size}`);
      headers.set('content-length', String(answer.end - answer.start + 1));
      return new Response(body, { status: 206, headers });
    }
    const length = lengthOf(served);
    if (length !== undefined) headers.set('content-length', String(length));
    if (request.method === 'HEAD') {
      await release(body);
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  } catch (error) {
    await release(body);
    throw error;
  }
}

/** The same 404 for "no such file" and "no such key": nothing tells which files exist. */
export function notFound(): Response {
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
}
