import { importOptional } from './optional-peer.ts';

type SearchModules = typeof import('@marmeon/search') & typeof import('@marmeon/search/testing');

/** The two entries of @marmeon/search `createTestApp()` needs. */
const loadSearch = async (): Promise<SearchModules> => ({ ...(await import('@marmeon/search')), ...(await import('@marmeon/search/testing')) });

/**
 * `undefined` only when @marmeon/search is not installed; any other load failure throws, so a test never runs against a real
 * search service by accident.
 * `load` is replaceable by a test. @internal
 */
export async function importSearch(load: () => Promise<SearchModules> = loadSearch): Promise<SearchModules | undefined> {
  return importOptional('@marmeon/search', load);
}
