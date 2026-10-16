import { token } from '@marmeon/core';
import type { HttpContext, Next } from '@marmeon/router';
import { LOCATION_HEADER, PAGE_HEADER, RELOAD_HEADER, VERSION_HEADER } from './protocol.ts';

/** The current build's asset version — set by the server kernel; null means "do not check" (development). */
export interface AssetVersion {
  readonly value: string | null;
}
export const AssetVersion = token<AssetVersion>('AssetVersion');

/**
 * After a deployment, open tabs still run the old JavaScript, whose chunks may no longer exist: a client-side visit with
 * another asset version gets 409 (`x-marmeon-reload: version`) and the URL to load fully. Only GET visits — a form submit is
 * never thrown away. See docs/navigation.md#a-new-version-of-the-app.
 */
export class CheckAssetVersion {
  readonly #version: AssetVersion;

  constructor(version: AssetVersion) {
    this.#version = version;
  }

  handle(ctx: HttpContext, next: Next<{}>): Response | Promise<Response> {
    const { request } = ctx;
    const current = this.#version.value;
    const client = request.headers.get(VERSION_HEADER);
    const stale =
      current !== null && client !== null && client !== current && request.method === 'GET' && request.headers.get(PAGE_HEADER) === 'true';
    if (!stale) return next();
    return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: request.url, [RELOAD_HEADER]: 'version' } });
  }
}
