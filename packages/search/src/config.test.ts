import { REDACTED, Redactor, resolveConfig } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { SearchConfig } from './config.ts';

const resolve = async (env: Record<string, string>) => (await resolveConfig([SearchConfig], env)).get(SearchConfig) as SearchConfig;

describe('SearchConfig', () => {
  it('selects database by default, and the Meilisearch address and key are empty', async () => {
    expect(await resolve({})).toEqual({ driver: 'database', meilisearch: { url: '', apiKey: '' } });
  });

  it('reads SEARCH_DRIVER, SEARCH_MEILISEARCH_URL and SEARCH_MEILISEARCH_API_KEY', async () => {
    const config = await resolve({ SEARCH_DRIVER: 'meilisearch', SEARCH_MEILISEARCH_URL: 'http://127.0.0.1:7700', SEARCH_MEILISEARCH_API_KEY: 'abc' });
    expect(config).toEqual({ driver: 'meilisearch', meilisearch: { url: 'http://127.0.0.1:7700', apiKey: 'abc' } });
  });

  it('reads its credential under a name the log redactor masks, and the address under one it shows', async () => {
    const credential = 'SEARCH_MEILISEARCH_API_KEY';
    const address = 'SEARCH_MEILISEARCH_URL';
    // A renamed variable is no longer read here, so this test goes red with the rename.
    expect((await resolve({ [credential]: 'abc', [address]: 'http://127.0.0.1:7700' })).meilisearch).toEqual({ url: 'http://127.0.0.1:7700', apiKey: 'abc' });
    expect(new Redactor().log({ [credential]: 'abc', [address]: 'http://127.0.0.1:7700' })).toEqual({ [credential]: REDACTED, [address]: 'http://127.0.0.1:7700' });
  });
});
