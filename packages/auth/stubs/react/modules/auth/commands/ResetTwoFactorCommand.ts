import { TwoFactorDisabled, TwoFactorStore } from '@marmeon/auth';
import { EventDispatcher, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { UserRepository } from '../UserRepository.ts';

/**
 * `marmeon auth:reset-two-factor <email> --force`: removes the authenticator and every recovery code of an account, for the
 * user who lost both the phone and the codes. Only an operator who is sure the person asking is the owner runs it — hence
 * `--force`, in every environment. The owner gets the mail about it (`TwoFactorDisabled` with `via: 'operator'`), the log gets a line.
 * The account's open sessions and remember-me cookies stay; the next sign-in needs the password only.
 */
export class ResetTwoFactorCommand {
  static command = 'auth:reset-two-factor';
  static description = "Remove an account's second factor and recovery codes (the owner lost both)";
  static usage = '<email> --force';
  static options = { force: { type: 'boolean' } } as const;

  readonly #users: UserRepository;
  readonly #store: TwoFactorStore;
  readonly #events: EventDispatcher;
  readonly #logger: Logger;

  constructor(users: UserRepository, store: TwoFactorStore, events: EventDispatcher, logger: Logger) {
    this.#users = users;
    this.#store = store;
    this.#events = events;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const email = args[0]?.trim().toLowerCase();
    if (!email) {
      output.error('Usage: marmeon auth:reset-two-factor <email> --force');
      return 1;
    }
    const user = await this.#users.findByEmail(email);
    if (!user) {
      output.error(`No account has the address ${email}.`);
      return 1;
    }
    if ((await this.#store.factors(user.id)).length === 0) {
      output.success(`${email} has no second factor.`);
      return 0;
    }
    if (options.force !== true) {
      output.error(`This removes the second factor and the recovery codes of ${email}; the password alone signs them in afterwards. Be sure it is the owner, then pass --force.`);
      return 1;
    }
    await this.#store.removeAll(user.id);
    // removeAll() dispatches nothing: the owner's mail and any audit log hear of the reset from this event.
    await this.#events.dispatch(new TwoFactorDisabled(user, 'operator'));
    this.#logger.info('Removed the second factor of an account at the operator\'s request', { userId: user.id });
    output.success(`Removed the second factor and the recovery codes of ${email}.`);
    return 0;
  }
}
