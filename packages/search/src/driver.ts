import type { Logger, Resolver } from '@marmeon/core';

/** What a search driver's factory is given: the name `SEARCH_DRIVER` selected it by, the container and a logger on the `search` channel. */
export interface SearchDriverContext {
  readonly name: string;
  readonly container: Resolver;
  readonly logger: Logger;
}

/** Creates the search driver a provider brings under a name (`static searchDrivers`). See `docs/full-text-search.md#writing-a-driver`. */
export type SearchDriverFactory = (context: SearchDriverContext) => unknown;
