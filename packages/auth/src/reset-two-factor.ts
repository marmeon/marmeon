import { EventDispatcher, Logger, type Key } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountSessions } from './account-sessions.ts';
import { TwoFactorDisabled } from './events.ts';
import { TwoFactorState } from './two-factor/state.ts';
import { assertSignInFinder, idOf, UserProvider } from './user.ts';

/** Exact, trimmed lookup: an address typed in capitals finds nothing when the account stores it in lower case. */
const noAccount = (identifier: string) => `No account has the identifier ${identifier}: the lookup is exact (only trimmed), so type it as it is stored, e.g. ${identifier.toLowerCase()}.`;

/**
 * `marmeon auth:reset-two-factor <identifier> --force`: removes the authenticator, every passkey and every recovery code of an account
 * (whatever the bound `TwoFactorState` holds), for the user who lost both their devices and the codes. Only an operator who is sure the
 * person asking is the owner runs it — hence `--force`, in every environment. The owner gets the mail about it (`TwoFactorDisabled` with
 * `via: 'operator'`), the log gets a line. It ends every session and remember-me cookie of the account first, so a session that is open on
 * a lost device, or an attacker's, cannot enrol a "first" factor once the account has none; the next sign-in needs the password only.
 * The account is found by `UserProvider.findForSignIn()` with the identifier as the sign-in form normalizes it.
 */
export class ResetTwoFactorCommand {
  static command = 'auth:reset-two-factor';
  static description = "Remove an account's second factors (authenticator, passkeys) and recovery codes (the owner lost them)";
  static usage = '<identifier> --force';
  static options = { force: { type: 'boolean' } } as const;
  // Annotated: the declaration then names `Key` instead of spelling out the app's user type.
  static inject: readonly Key[] = [UserProvider, AccountSessions, TwoFactorState, EventDispatcher, Logger];

  readonly #users: UserProvider;
  readonly #accounts: AccountSessions;
  readonly #state: TwoFactorState;
  readonly #events: EventDispatcher;
  readonly #logger: Logger;

  constructor(users: UserProvider, accounts: AccountSessions, state: TwoFactorState, events: EventDispatcher, logger: Logger) {
    this.#users = users;
    this.#accounts = accounts;
    this.#state = state;
    this.#events = events;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const identifier = args[0]?.trim();
    if (!identifier) {
      output.error('Usage: marmeon auth:reset-two-factor <identifier> --force');
      return 1;
    }
    assertSignInFinder(this.#users);
    const found = await this.#users.findForSignIn(identifier);
    if (!found) {
      output.error(noAccount(identifier));
      return 1;
    }
    const user = found.user;
    const id = idOf(user);
    if ((await this.#state.factors(id)).length === 0) {
      output.success(`${identifier} has no second factor.`);
      return 0;
    }
    if (options.force !== true) {
      output.error(`This removes the authenticator app, the passkeys and the recovery codes of ${identifier}; the password alone signs them in afterwards. Be sure it is the owner, then pass --force.`);
      return 1;
    }
    // Before the factors go: were it to fail, the factors stay and the operator can run the command again.
    // Ending first also matters for a factor still being set up: `confirm()` and `register()` check their session against the account when they store it, so they find it ended.
    if (!(await this.#accounts.end(id)).ok) {
      output.error(`The account ${identifier} vanished while its sessions were ended.`);
      return 1;
    }
    await this.#state.removeAll(id);
    // removeAll() dispatches nothing: the owner's mail and any audit log hear of the reset from this event.
    await this.#events.dispatch(new TwoFactorDisabled(user, 'operator'));
    this.#logger.info('Removed the second factor of an account at the operator\'s request', { userId: id });
    // A sign-in or enrolment that was authorised before the sessions ended can still commit a factor after removeAll().
    if ((await this.#state.factors(id)).length > 0) {
      output.error(`A second factor was enrolled for ${identifier} while the command ran. Run it again.`);
      return 1;
    }
    output.success(`Removed the authenticator app, the passkeys and the recovery codes of ${identifier}, and ended its sessions.`);
    return 0;
  }
}
