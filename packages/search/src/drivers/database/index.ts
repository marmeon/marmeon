import type { Application } from '@marmeon/core';
import { withCode } from '@marmeon/core/internal';
import type { SearchDriverFactory } from '../../driver.ts';
import { SearchSetupError } from '../../errors.ts';

/** The `database` driver: the index lives in a table of the app's database. */
export const databaseDriver: SearchDriverFactory = () => {
  throw new SearchSetupError(withCode('Q9', 'SEARCH_DRIVER=database is not built in this version of @marmeon/search. Select a driver a provider brings.'));
};

/** Tells the migrator which schema objects the search table derives; called at every start, whatever the driver. */
export function declareSearchSchema(_app: Application): void {}
