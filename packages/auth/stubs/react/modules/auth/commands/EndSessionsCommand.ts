import { AccountSessions } from '@marmeon/auth';
import { Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { UserRepository } from '../UserRepository.ts';

/**
 * `marmeon auth:end-sessions <email> --force`: signs an account out everywhere, every browser and every "keep me signed in" cookie, for
 * a lost device or a suspected theft. Whoever holds the password signs in again; change it first when it may be known. `--force` in every
 * environment, since it cannot be undone. Through `AccountSessions.end()`, see `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class EndSessionsCommand {
  static command = 'auth:end-sessions';
  static description = 'End every session and remember-me cookie of an account (a lost device, a suspected theft)';
  static usage = '<email> --force';
  static options = { force: { type: 'boolean' } } as const;

  readonly #users: UserRepository;
  readonly #accounts: AccountSessions;
  readonly #logger: Logger;

  constructor(users: UserRepository, accounts: AccountSessions, logger: Logger) {
    this.#users = users;
    this.#accounts = accounts;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const email = args[0]?.trim().toLowerCase();
    if (!email) {
      output.error('Usage: marmeon auth:end-sessions <email> --force');
      return 1;
    }
    const user = await this.#users.findByEmail(email);
    if (!user) {
      output.error(`No account has the address ${email}.`);
      return 1;
    }
    if (options.force !== true) {
      output.error(`This signs ${email} out of every browser and device, remember-me cookies included. Be sure you mean it, then pass --force.`);
      return 1;
    }
    // A failure is not caught: the operator has to see that some sessions may still stand.
    const ended = await this.#accounts.end(user.id);
    if (!ended.ok) {
      // Only a race: the account was deleted after findByEmail().
      output.error(`No account has the address ${email}.`);
      return 1;
    }
    this.#logger.info('Ended every session of an account at the operator\'s request', { userId: user.id });
    output.success(`Ended every session and remember-me cookie of ${email}; ${ended.value.removed} stored sessions were deleted at once, the others end at their next request.`);
    return 0;
  }
}
