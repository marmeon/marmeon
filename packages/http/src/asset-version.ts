import { token } from '@bespokecore/core';
import type { HttpContext, Next } from '@bespokecore/router';
import { LOCATION_HEADER, PAGE_HEADER, VERSION_HEADER } from './page.ts';

/** The current build's asset version — set by the server kernel; null means "do not check" (development). */
export interface AssetVersion {
  readonly value: string | null;
}
export const AssetVersion = token<AssetVersion>('AssetVersion');

/**
 * After a deployment, open tabs still run the old JavaScript, whose chunks may no
 * longer exist. A client-side visit with another version gets 409 and the URL to
 * load fully — the browser then fetches the new build (Inertia's asset versioning).
 * Only GET visits: a form submit is never thrown away.
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
    return new Response(null, { status: 409, headers: { [LOCATION_HEADER]: request.url } });
  }
}
