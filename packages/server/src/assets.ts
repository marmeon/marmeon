import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';

/** How long the build's hashed files may be kept: a year, never revalidated — a new build has new names. */
export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** What `marmeon build` writes `.br`/`.gz` of — text, scripts, styles, JSON, SVG, WebAssembly (`precompressAssets`). */
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json|wasm|xml)|image\/svg\+xml)/;

/**
 * The build's `/assets/*`: Vite names every file by its content's hash, so a response is kept for a year
 * (`public, max-age=31536000, immutable`). A file `marmeon build` compressed is sent as its `.br` (else `.gz`) when the
 * request's `Accept-Encoding` names it — `Content-Encoding` set, `Content-Type` the original's — and every compressible file
 * says `Vary: Accept-Encoding`, so a shared cache keeps the variants apart. Nothing is compressed per request: documents
 * never (BREACH — compressing a page with a secret next to reflected input leaks the secret), assets ahead of time; a
 * proxy may compress what it likes. Ranges (a video in the assets) work for uncompressed files.
 */
export function serveAssets(clientDir: string): MiddlewareHandler[] {
  const headers: MiddlewareHandler = async (c, next) => {
    await next();
    const { status } = c.res;
    if (status !== 200 && status !== 206) return;
    c.res.headers.set('cache-control', ASSET_CACHE_CONTROL);
    if (COMPRESSIBLE.test(c.res.headers.get('content-type') ?? '')) {
      const vary = c.res.headers.get('vary');
      if (!vary?.toLowerCase().includes('accept-encoding')) c.res.headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    }
  };
  return [headers, serveStatic({ root: clientDir, precompressed: true })];
}
