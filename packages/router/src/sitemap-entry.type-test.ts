// The alternates of a sitemap entry are parameters of the same route, by language tag — checked by `tsc`, never run.
import type { SitemapEntries, SitemapEntry } from './types.ts';

export const entry: SitemapEntry<{ slug: string }> = { params: { slug: 'about' }, alternates: { en: { slug: 'about' }, de: { slug: 'ueber-uns' } } };

// @ts-expect-error — a version is the parameters of the route, never an address
export const address: SitemapEntry<{ slug: string }> = { params: { slug: 'a' }, alternates: { de: 'https://example.com/de' } };

// @ts-expect-error — the parameters must be those of the route
export const wrong: SitemapEntry<{ slug: string }> = { params: { slug: 'a' }, alternates: { de: { id: 1 } } };

export const entries: SitemapEntries<{ slug: string }> = [entry];
