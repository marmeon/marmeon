import { CommandArgumentsError, environment } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { Rebuilder } from '../rebuild.ts';
import { INDEX_NAME, SearchIndexes, type IndexInfo } from '../registry.ts';
import { knownIndexes } from './rebuild.ts';

/**
 * `marmeon search:flush <index>`: removes every document of an index, also of a name no class declares any more, and discards an
 * unfinished rebuild of it, so that no resume brings the documents back. Asks for `--force` where the app is protected, and refuses
 * while a rebuild of the index runs. See `docs/full-text-search.md#rebuilding-and-flushing`.
 */
export class SearchFlushCommand {
  static command = 'search:flush';
  static description = 'Remove every document of a search index';
  static usage = '<index> [--force]';
  static options = { force: { type: 'boolean' } } as const;
  static inject = [SearchIndexes, Rebuilder] as const;

  readonly #indexes: SearchIndexes;
  readonly #rebuilder: Rebuilder;

  constructor(indexes: SearchIndexes, rebuilder: Rebuilder) {
    this.#indexes = indexes;
    this.#rebuilder = rebuilder;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const [name] = args;
    if (name === undefined || args.length > 1) throw new CommandArgumentsError(`search:flush takes one index name (${knownIndexes(this.#indexes)}).\nUsage: marmeon search:flush ${SearchFlushCommand.usage}`);
    if (!INDEX_NAME.test(name)) throw new CommandArgumentsError(`${JSON.stringify(name.slice(0, 80))} is no index name (${knownIndexes(this.#indexes)}).`);
    // The same check as `confirmed()` of the database commands: protected wherever NODE_ENV is not development or test.
    output.line(`Environment: ${environment.describe()}`);
    if (environment.isProtected() && options.force !== true) {
      output.error(`The application is protected (${environment.describe()}). Pass --force to flush the search index "${name}" — or, on a development machine, set NODE_ENV=development (in .env or the environment).`);
      return 1;
    }
    const Index = this.#indexes.get(name);
    // A name no class declares any more still holds the documents it had: they stay until a flush, so it reaches them too.
    const info: IndexInfo = Index === undefined ? Object.freeze({ name, key: '', fields: Object.freeze([]), filters: Object.freeze([]) }) : this.#indexes.info(Index);
    if (Index === undefined) output.warn(`No index class declares "${name}" (${knownIndexes(this.#indexes)}); flushing the documents stored under that name.`);
    const flushed = await this.#rebuilder.flush(info);
    if (flushed.status === 'held') {
      output.error(`A rebuild of "${name}" holds its lock until ${flushed.until}. Flush the index once it has finished.`);
      return 1;
    }
    if (flushed.leftover !== undefined) output.warn(flushed.leftover);
    output.success(`Flushed the search index "${name}".`);
    return 0;
  }
}
