import { CommandArgumentsError } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { MAX_REBUILD_BATCH, Rebuilder } from '../rebuild.ts';
import { SearchIndexes } from '../registry.ts';
import type { SearchIndexClass } from '../search-index.ts';

/** The names of the registered indexes, for a message. */
export function knownIndexes(indexes: SearchIndexes): string {
  const names = indexes.all().map((Index) => indexes.info(Index).name);
  return names.length === 0 ? 'none is registered' : `known: ${names.join(', ')}`;
}

/**
 * `marmeon search:rebuild [index]`: fills an index again from all of its rows, in batches, resumable, one run per index at a time;
 * without a name, every registered index one after another. See `docs/full-text-search.md#rebuilding-and-flushing`.
 */
export class SearchRebuildCommand {
  static command = 'search:rebuild';
  static description = 'Rebuild search indexes from their rows, in batches and resumable';
  static usage = '[index] [--batch=500] [--fresh]';
  static options = { batch: { type: 'string' }, fresh: { type: 'boolean' } } as const;
  static inject = [SearchIndexes, Rebuilder] as const;

  readonly #indexes: SearchIndexes;
  readonly #rebuilder: Rebuilder;

  constructor(indexes: SearchIndexes, rebuilder: Rebuilder) {
    this.#indexes = indexes;
    this.#rebuilder = rebuilder;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    if (args.length > 1) throw new CommandArgumentsError(`search:rebuild takes at most one index name.\nUsage: marmeon search:rebuild ${SearchRebuildCommand.usage}`);
    const given = options.batch;
    const batch = given === undefined ? MAX_REBUILD_BATCH : typeof given === 'string' && /^[1-9]\d{0,2}$/.test(given) ? Number(given) : Number.NaN;
    if (!(batch >= 1 && batch <= MAX_REBUILD_BATCH)) throw new CommandArgumentsError(`--batch is a whole number from 1 to ${MAX_REBUILD_BATCH}.`);
    let list: readonly SearchIndexClass[];
    if (args[0] === undefined) {
      list = this.#indexes.all();
      if (list.length === 0) {
        output.line('No search index is registered: list index classes in a module’s searchIndexes or a provider’s static searchIndexes.');
        return 0;
      }
    } else {
      const Index = this.#indexes.get(args[0]);
      if (Index === undefined) throw new CommandArgumentsError(`No search index is named ${JSON.stringify(args[0].slice(0, 80))} (${knownIndexes(this.#indexes)}).`);
      list = [Index];
    }
    let code = 0;
    for (const Index of list) {
      const name = this.#indexes.info(Index).name;
      const outcome = await this.#rebuilder.rebuild(Index, { batch, fresh: options.fresh === true, report: (line) => output.line(line) });
      if (outcome.status === 'held') {
        output.error(`Another rebuild of "${name}" holds its lock until ${outcome.until}. Wait for it to finish; a run that stopped frees the lock then.`);
        code = 1;
      } else if (outcome.status === 'lost') {
        output.error(`The rebuild of "${name}" lost its lock to another run and stopped. That run goes on from the last saved batch.`);
        return 1;
      }
    }
    return code;
  }
}
