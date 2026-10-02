/**
 * The requests of islands (E52): a GET with the page headers and `x-bespoke-region: island`, never following a redirect. What
 * the server answers becomes the region's outcome — never a navigation of the page — except a 409: a new build (or a document
 * change), so the whole page loads again (the island's code of this build may be gone).
 */
import { LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, REGION_STATUS_HEADER, VERSION_HEADER, type RegionObject } from '../../page.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature } from '../feature.ts';
import type { RegionResponse, RegionTransport } from '../region.ts';

type IslandsCore = Pick<FeatureHost, 'window' | 'left' | 'version' | 'documentChange'>;

/** How the islands of one navigator send their requests. */
export function regionTransport(core: IslandsCore): RegionTransport {
  return { request: (url, headers, signal) => regionRequest(core, url, headers, signal) };
}

async function regionRequest(core: IslandsCore, url: string, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<RegionResponse> {
  if (core.left || signal.aborted) return { kind: 'cancelled' };
  let response: Response;
  try {
    response = await core.window.fetch(url, {
      method: 'GET',
      headers: { [PAGE_HEADER]: 'true', [REGION_HEADER]: 'island', ...(core.version ? { [VERSION_HEADER]: core.version } : {}), ...headers },
      signal,
      redirect: 'manual',
    });
  } catch (cause) {
    return signal.aborted || core.left ? { kind: 'cancelled' } : { kind: 'exception', failure: { status: undefined, cause } };
  }
  if (core.left || signal.aborted) {
    await response.body?.cancel();
    return { kind: 'cancelled' };
  }
  if (response.status === 409 && response.headers.has(LOCATION_HEADER)) {
    // The whole page loads again (the island's code of this build may be gone) — a new build only when nothing holds it (E64).
    await core.documentChange.change(response, 'reload');
    return { kind: 'cancelled' };
  }
  const outcome = response.headers.get(REGION_STATUS_HEADER);
  // The server turns redirects, 401 and 403 into an outcome; a redirect not turned (a proxy) is never followed either.
  if (outcome === 'unauthorized' || response.type === 'opaqueredirect' || response.status === 401 || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel();
    return { kind: 'unauthorized' };
  }
  if (outcome === 'forbidden' || response.status === 403) {
    await response.body?.cancel();
    return { kind: 'forbidden' };
  }
  if (response.ok && response.headers.get(REGION_HEADER) === 'island') return { kind: 'region', region: (await response.json()) as RegionObject };
  let message: string | undefined;
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === 'string') message = body.message;
  } catch {
    // Not JSON (a proxy's error page): the status says enough.
  }
  return { kind: 'exception', failure: { status: response.status || undefined, message } };
}

/**
 * Islands (E48–E52) as a feature: how their regions send requests. The region owners of the history entries are still made
 * by the core (Wave 5c step 4 moves them in here); what they load lives in the entries' slots (`REGIONS`).
 */
export const islands = defineFeature('islands', (host) => {
  host.transport = regionTransport(host);
  return host.transport;
});
