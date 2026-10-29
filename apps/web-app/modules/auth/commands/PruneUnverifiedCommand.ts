import { AuthConfig } from '@marmeon/auth';
import { Clock, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountDeletion } from '../AccountDeletion.ts';
import type { User } from '../users.ts';
import { UserRepository } from '../UserRepository.ts';

const DAY = 86_400_000;

/**
 * `marmeon auth:prune-unverified`: deletes the accounts that never confirmed an address within `AUTH_UNVERIFIED_DAYS` of
 * their sign-up (default 7; `0` keeps them). Whoever signed up with somebody else's address stops holding it, and the data of
 * sign-ups nobody finished goes (pre-hijacked accounts, data minimization). **Never an account that was confirmed once**
 * (`first_verified_at`), even when a change of address left it unconfirmed. Through `AccountDeletion`, in batches; the number
 * goes to the log, and so do the accounts a module refused to lose ({@link AccountDeleting}). This app schedules it nightly (schedule.ts). Irreversible: with `AUTH_PRIVATE_REGISTRATION=false` such
 * sign-ups were signed in and may have used the app.
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
    // Accounts a module refused to lose: the next look-up skips them, so they neither stop the run nor come back every batch.
    const refused: { user: User; reasons: readonly string[] }[] = [];
    for (;;) {
      const ids = await this.#users.unconfirmedSince(since, PruneUnverifiedCommand.batch, refused.map((one) => one.user.id));
      const outcome = ids.length === 0 ? { deleted: [], refused: [] } : await this.#accounts.delete(ids, { unconfirmedSince: since });
      pruned += outcome.deleted.length;
      refused.push(...outcome.refused);
      // A short batch was the last; one that deleted and refused nothing (all confirmed meanwhile) would only find the same ones again.
      if (ids.length < PruneUnverifiedCommand.batch || outcome.deleted.length + outcome.refused.length === 0) break;
    }
    if (pruned > 0) this.#logger.info('Deleted accounts whose address was never confirmed', { pruned, days });
    output.success(`Deleted ${pruned} ${pruned === 1 ? 'account' : 'accounts'} whose address was not confirmed within ${days} ${days === 1 ? 'day' : 'days'}.`);
    if (refused.length > 0) {
      this.#logger.warn('Kept accounts whose deletion a module refused', { kept: refused.map((one) => ({ id: one.user.id, reasons: one.reasons })) });
      output.warn(`Kept ${refused.length} ${refused.length === 1 ? 'account' : 'accounts'}: a module refused to lose ${refused.length === 1 ? 'it' : 'them'} (see the log for the reasons).`);
    }
    return 0;
  }
}
