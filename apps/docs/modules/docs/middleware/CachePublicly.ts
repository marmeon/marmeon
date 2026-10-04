import { createHash } from 'node:crypto';
import type { HttpContext, Next } from '@bespokecore/http';
import {
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  PAGE_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  REGION_HEADER,
  VERSION_HEADER,
} from '@bespokecore/http/page';
import { DocsConfig } from '../../../config/docs.ts';

/**
 * The request headers a page answer depends on besides its URL — a cache must keep one copy per combination: the
 * document or its JSON (`x-bespoke`), all props or some (the partial headers), a prefetch (`purpose`), the once props
 * the tab holds, and the build the client runs (`x-bespoke-version`: an old client gets its 409, never a page of the new
 * build from a cache). The kernel's page answers already name all but the last; this list makes sure of them.
 */
export const PAGE_VARY = [
  PAGE_HEADER,
  REGION_HEADER,
  PARTIAL_COMPONENT_HEADER,
  PARTIAL_DATA_HEADER,
  PARTIAL_EXCEPT_HEADER,
  PURPOSE_HEADER,
  'sec-purpose',
  ONCE_HEADER,
  ONCE_SCOPE_HEADER,
  VERSION_HEADER,
];

/**
 * Public pages for browsers and shared caches: `Cache-Control: public, max-age=…` (in development `no-cache`) and an
 * `ETag` from the body — a revalidation that finds the same page answers `304` without it. Only for a successful GET that
 * sets no cookie and says nothing about caching itself (a `no-store` answer stays one).
 */
export class CachePublicly {
  readonly #config: DocsConfig;

  constructor(config: DocsConfig) {
    this.#config = config;
  }

  async handle(ctx: HttpContext, next: Next<{}>): Promise<Response> {
    const response = await next();
    const method = ctx.request.method;
    if ((method !== 'GET' && method !== 'HEAD') || response.status !== 200 || response.headers.has('cache-control') || response.headers.has('set-cookie')) {
      return response;
    }
    const body = await response.arrayBuffer();
    const etag = `"${createHash('sha256').update(new Uint8Array(body)).digest('base64url').slice(0, 27)}"`;
    const headers = new Headers(response.headers);
    headers.set('cache-control', this.#config.development ? 'no-cache' : `public, max-age=${this.#config.cacheMaxAge}`);
    headers.set('etag', etag);
    headers.set('vary', vary(headers.get('vary')));
    if (matches(ctx.request.headers.get('if-none-match'), etag)) {
      headers.delete('content-type');
      headers.delete('content-length');
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
}

function vary(current: string | null): string {
  const names = (current ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const lower = new Set(names.map((name) => name.toLowerCase()));
  return [...names, ...PAGE_VARY.filter((name) => !lower.has(name.toLowerCase()))].join(', ');
}

/** `If-None-Match: "a", W/"b"` — weak comparison, as for GET. */
function matches(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
}
