import { withCode } from '@marmeon/core/internal';
import type { SearchDriverFactory } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';

/** The `meilisearch` driver: each index lives on a Meilisearch server. */
export const meilisearchDriver: SearchDriverFactory = () => {
  throw new SearchSetupError(withCode('Q9', 'SEARCH_DRIVER=meilisearch is not built in this version of @marmeon/search. Select a driver a provider brings.'));
};
