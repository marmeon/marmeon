import { AccountSessions, TwoFactorDisabled, TwoFactorStore } from '@marmeon/auth';
import { PasskeyStore } from '@marmeon/auth/passkeys';
import { EventDispatcher, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { UserRepository } from '../UserRepository.ts';

/**
 * `marmeon auth:reset-two-factor <email> --force`: removes the authenticator, every passkey and every recovery code of an account,
 * for the user who lost both their devices and the codes. Only an operator who is sure the person asking is the owner runs it — hence
 * `--force`, in every environment. The owner gets the mail about it (`TwoFactorDisabled` with `via: 'operator'`), the log gets a line.
 * It ends every session and remember-me cookie of the account first, so a session that is open on a lost device, or an attacker's,
 * cannot enrol a "first" factor once the account has none; the next sign-in needs the password only.
 */
export class ResetTwoFactorCommand {
  static command = 'auth:reset-two-factor';
  static description = "Remove an account's second factors (authenticator, passkeys) and recovery codes (the owner lost them)";
  static usage = '<email> --force';
  static options = { force: { type: 'boolean' } } as const;

  readonly #users: UserRepository;
  readonly #accounts: AccountSessions;
  readonly #store: TwoFactorStore;
  readonly #passkeys: PasskeyStore;
  readonly #events: EventDispatcher;
  readonly #logger: Logger;

  constructor(users: UserRepository, accounts: AccountSessions, store: TwoFactorStore, passkeys: PasskeyStore, events: EventDispatcher, logger: Logger) {
    this.#users = users;
    this.#accounts = accounts;
    this.#store = store;
    this.#passkeys = passkeys;
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
    if ((await this.#store.factors(user.id)).length + (await this.#passkeys.factors(user.id)).length === 0) {
      output.success(`${email} has no second factor.`);
      return 0;
    }
    if (options.force !== true) {
      output.error(`This removes the authenticator app, the passkeys and the recovery codes of ${email}; the password alone signs them in afterwards. Be sure it is the owner, then pass --force.`);
      return 1;
    }
    // Before the factors go: were it to fail, the factors stay and the operator can run the command again.
    if (!(await this.#accounts.end(user.id)).ok) {
      output.error(`The account ${email} vanished while its sessions were ended.`);
      return 1;
    }
    await this.#store.removeAll(user.id);
    await this.#passkeys.removeAll(user.id);
    // removeAll() dispatches nothing: the owner's mail and any audit log hear of the reset from this event.
    await this.#events.dispatch(new TwoFactorDisabled(user, 'operator'));
    this.#logger.info('Removed the second factor of an account at the operator\'s request', { userId: user.id });
    // A sign-in or enrolment that was authorised before the sessions ended can still commit a factor after removeAll().
    if ((await this.#store.factors(user.id)).length + (await this.#passkeys.factors(user.id)).length > 0) {
      output.error(`A second factor was enrolled for ${email} while the command ran. Run it again.`);
      return 1;
    }
    output.success(`Removed the authenticator app, the passkeys and the recovery codes of ${email}, and ended its sessions.`);
    return 0;
  }
}
