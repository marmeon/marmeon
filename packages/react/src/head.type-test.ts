// Type guarantees of the `jsonLd` blocks of <Head> — checked by `tsc` (pnpm build / typecheck), never run.
import type { HeadFields, JsonLd, JsonLdNode } from './head-fields.ts';

const organization: JsonLdNode = { '@type': 'Organization', '@id': 'https://example.com/#org', name: 'Shop' };

export const node: JsonLd = { '@context': 'https://schema.org', '@type': 'Article', headline: 'Hello' };
export const graph: JsonLd = { '@context': 'https://schema.org', '@graph': [organization, { '@type': ['WebSite'], publisher: { '@id': 'x' } }] };
export const several: HeadFields = { jsonLd: [node, graph, organization] };

// @ts-expect-error — `@graph` is a list of nodes
export const graphAsObject: JsonLd = { '@graph': { '@type': 'Thing' } };

// @ts-expect-error — every node of a graph needs an `@type`
export const nodeWithoutType: JsonLd = { '@graph': [{ name: 'x' }] };

// @ts-expect-error — a block without `@type` and without `@graph`
export const noType: JsonLd = { name: 'x' };

// @ts-expect-error — a `Date` is not JSON
export const withDate: JsonLd = { '@graph': [{ '@type': 'Event', startDate: new Date() }] };
