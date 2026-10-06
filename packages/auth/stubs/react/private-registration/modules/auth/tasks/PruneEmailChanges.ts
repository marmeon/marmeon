import { Clock, Logger } from '@bespokecore/core';
import { UserRepository } from '../UserRepository.ts';

/**
 * Pending changes of address (private registration, E146) that nobody confirmed in time: their address and token hash are
 * cleared — an expired link never worked, this only tidies the rows (the scheduler runs it nightly, `s.call(PruneEmailChanges)`).
 */
export class PruneEmailChanges {
  readonly #users: UserRepository;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(users: UserRepository, clock: Clock, logger: Logger) {
    this.#users = users;
    this.#clock = clock;
    this.#logger = logger;
  }

  async handle(): Promise<number> {
    const pruned = await this.#users.pruneEmailChanges(new Date(this.#clock.now()));
    if (pruned > 0) this.#logger.info('Cleared expired changes of address', { pruned });
    return pruned;
  }
}
