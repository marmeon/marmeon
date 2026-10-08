import { AuthConfig } from '@marmeon/auth';
import { Clock, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountDeletion } from '../AccountDeletion.ts';
import { UserRepository } from '../UserRepository.ts';

const DAY = 86_400_000;

/**
 * `marmeon auth:prune-unverified` (E203): deletes the accounts that never confirmed an address within `AUTH_UNVERIFIED_DAYS` of
 * their sign-up (default 7; `0` keeps them). Whoever signed up with somebody else's address stops holding it, and the data of
 * sign-ups nobody finished goes (pre-hijacked accounts, data minimization). **Never an account that was confirmed once**
 * (`first_verified_at`, Max 07.10.) — with `AUTH_PRIVATE_REGISTRATION=false` a change of address leaves it unconfirmed, and it
 * stays. Through `AccountDeletion`, in batches; the number goes to the log. Not scheduled by itself (E209): schedule.ts has the line,
 * commented out — your app turns it on. Irreversible: with `AUTH_PRIVATE_REGISTRATION=false` such sign-ups were signed in and may
 * have used the app.
 */
export class PruneUnverifiedCommand {
  static command = 'auth:prune-unverified';
  static description = 'Delete accounts whose address was not confirmed within AUTH_UNVERIFIED_DAYS';
  /** How many accounts one transaction deletes. */
  static batch = 100;

  readonly #users: UserRepository;
  readonly #accounts: AccountDeletion;
  readonly #config: AuthConfig;
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor(users: UserRepository, accounts: AccountDeletion, config: AuthConfig, clock: Clock, logger: Logger) {
    this.#users = users;
    this.#accounts = accounts;
    this.#config = config;
    this.#clock = clock;
    this.#logger = logger;
  }

  async handle({ output }: CommandInput): Promise<number> {
    const days = this.#config.unverifiedDays;
    if (days === 0) {
      output.success('AUTH_UNVERIFIED_DAYS=0: accounts without a confirmed address are kept.');
      return 0;
    }
    const since = new Date(this.#clock.now() - days * DAY);
    let pruned = 0;
    for (;;) {
      const ids = await this.#users.unconfirmedSince(since, PruneUnverifiedCommand.batch);
      const deleted = ids.length === 0 ? 0 : (await this.#accounts.delete(ids, { unconfirmedSince: since })).length;
      pruned += deleted;
      // A short batch was the last; one that deleted nothing (all confirmed meanwhile) would only find the same ones again.
      if (ids.length < PruneUnverifiedCommand.batch || deleted === 0) break;
    }
    if (pruned > 0) this.#logger.info('Deleted accounts whose address was never confirmed', { pruned, days });
    output.success(`Deleted ${pruned} ${pruned === 1 ? 'account' : 'accounts'} whose address was not confirmed within ${days} ${days === 1 ? 'day' : 'days'}.`);
    return 0;
  }
}
