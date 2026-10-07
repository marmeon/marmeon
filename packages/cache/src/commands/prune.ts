import type { CommandInput } from 'marmeon';
import { Cache } from '../cache.ts';
import { CacheConfig } from '../config.ts';

/**
 * `marmeon cache:prune`: removes expired entries and locks — in memory, file and database stores they stay until read
 * or overwritten (`job.once` markers, rate-limit windows, the scheduler's locks …). For the scheduler:
 * `s.command('cache:prune').hourly()`. Redis expires them itself.
 */
export class CachePruneCommand {
  static command = 'cache:prune';
  static description = 'Delete expired cache entries and locks (memory, file and database drivers)';

  readonly #cache: Cache;
  readonly #config: CacheConfig;

  constructor(cache: Cache, config: CacheConfig) {
    this.#cache = cache;
    this.#config = config;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const removed = await this.#cache.prune();
    if (removed === undefined) output.line(`Nothing to prune: ${this.#config.driver} entries expire on their own.`);
    else output.success(`Pruned ${removed} expired ${removed === 1 ? 'entry' : 'entries and locks'} (${this.#config.driver}).`);
    return 0;
  }
}

/**
 * `marmeon cache:clear`: empties the cache — every entry, never a lock (a lock belongs to whoever holds it). Also gone:
 * rate-limit counters, `job.once` markers and the scheduler's last tick — e.g. after `migrate:fresh`, when ids start
 * over and old markers would match new records.
 */
export class CacheClearCommand {
  static command = 'cache:clear';
  static description = 'Remove every cache entry (locks stay)';

  readonly #cache: Cache;
  readonly #config: CacheConfig;

  constructor(cache: Cache, config: CacheConfig) {
    this.#cache = cache;
    this.#config = config;
  }

  async handle({ output }: CommandInput): Promise<number> {
    await this.#cache.flush();
    output.success(`Cleared the cache (${this.#config.driver}).`);
    return 0;
  }
}
