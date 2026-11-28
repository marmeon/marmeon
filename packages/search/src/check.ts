import type { AppCheck, AppCheckContext, CheckProblem } from 'marmeon';
import { SearchDriver, type SearchProblem } from './driver.ts';
import { SearchIndexes } from './registry.ts';

/**
 * The `search-indexes` check of `marmeon check`: what the selected driver's `inspect()` finds wrong for the indexes of the app, each
 * an error (Q9) with its fix. A driver without `inspect()` has nothing to report, so the check passes. See
 * `docs/full-text-search.md#checking`.
 */
export class SearchIndexesCheck implements AppCheck {
  static check = 'search-indexes';
  static phase = 'run' as const;
  static inject = [SearchIndexes, SearchDriver] as const;

  readonly #indexes: SearchIndexes;
  readonly #driver: SearchDriver;

  constructor(indexes: SearchIndexes, driver: SearchDriver) {
    this.#indexes = indexes;
    this.#driver = driver;
  }

  async handle(context?: AppCheckContext): Promise<readonly CheckProblem[]> {
    if (this.#driver.inspect === undefined) return [];
    const found: unknown = await this.#driver.inspect(
      this.#indexes.all().map((Index) => this.#indexes.info(Index)),
      context === undefined ? undefined : { signal: context.signal },
    );
    // A driver in JavaScript can return anything: say what is wrong rather than fail on it.
    if (!Array.isArray(found)) throw new TypeError('inspect() of the search driver must return a list of SearchProblem objects.');
    return (found as readonly SearchProblem[]).map(({ index, message, fix }): CheckProblem => ({
      severity: 'error',
      code: 'Q9',
      message: index === undefined ? message : `${index}: ${message}`,
      ...(fix === undefined ? {} : { fix }),
      docs: 'docs/full-text-search.md#checking',
    }));
  }
}
