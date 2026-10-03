/**
 * The requests of islands (E52): a GET with the page headers and `x-bespoke-region: island`, never following a redirect. What
 * the server answers becomes the region's outcome — never a navigation of the page — except a 409: a new build (or a document
 * change), so the whole page loads again (the island's code of this build may be gone).
 */
import { LOCATION_HEADER, PAGE_HEADER, REGION_HEADER, REGION_STATUS_HEADER, VERSION_HEADER, type RegionObject } from '../../page.ts';
import type { FeatureHost } from '../core.ts';
import { defineFeature } from '../feature.ts';
import { follow } from '../load-live.ts';
import { REGIONS, type RegionOwner } from '../owner.ts';
import { ownedRegion, type Region, type RegionInitial, type RegionResponse, type RegionTransport } from '../region.ts';

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

/** What adapters use of islands (E48–E52): the regions of the entries on screen. */
export interface IslandsFeature {
  /**
   * A region of the page — an island (E48, E50): `url` is its route's (same origin), `owner` the entry it belongs to (what
   * `render` handed the adapter; default: the page on screen). The same URL gives the same region (one request for two
   * identical islands); what it loaded stays in the entry's memory, so Back/Forward shows it without a request. `initial`
   * is a region object the server already sent (streamed with the page). Islands never load ahead (no prefetch, E52).
   */
  region(url: string, options?: { owner?: RegionOwner; initial?: RegionInitial }): Region;
}

/**
 * Islands (E48–E52) as a feature, attached where an island renders (React: `<Island>`): their regions and how they send their
 * requests. The owners of the entries on screen are the core's; the regions live on them (`owner.live`, closed with them), and
 * what they loaded in the entries' slots (`REGIONS`, emptied by the core).
 */
export const islands = defineFeature('islands', (host): IslandsFeature => {
  const sent = regionTransport(host);
  // An island that follows live channels (W6.10) — loaded, or streamed with the page: the core's live feature follows them too.
  const transport: RegionTransport = { request: (url, headers, signal) => sent.request(url, headers, signal).then((response) => (response.kind === 'region' && follow(host.navigator, response.region), response)) };
  // A page that keeps its state takes the place of the one on screen (a partial reload, a sort link): its islands come along.
  host.on('carry', (from, to) => {
    const kept = from.entry === undefined ? undefined : host.peek(REGIONS, from.entry);
    if (kept && to.entry !== undefined) for (const [id, region] of kept) host.entry(REGIONS, to.entry).set(id, region);
  });
  return {
    region(url, { owner = host.navigator.regionOwner, initial } = {}) {
      const target = new URL(url, host.window.location.href);
      if (target.origin !== host.window.location.origin) throw new Error(`A region comes from this site, not from ${target.origin} (${url}).`);
      const kept = owner.entry === undefined ? new Map() : host.entry(REGIONS, owner.entry);
      follow(host.navigator, initial as { live?: unknown } | undefined);
      return ownedRegion(owner, kept, transport, target.pathname + target.search, initial, owner.back ? host.declared : undefined);
    },
  };
}, 7);
