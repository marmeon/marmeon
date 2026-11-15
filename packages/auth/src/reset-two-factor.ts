import { CommandArgumentsError, Logger, type Key } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { TwoFactorDisabled } from './events.ts';
import { GUARD_OPTION, OperatorGuards } from './operator-guard.ts';
import { assertSignInFinder, idOf } from './user.ts';

/** Exact, trimmed lookup: an address typed in capitals finds nothing when the account stores it in lower case. */
const noAccount = (identifier: string) => `No account has the identifier ${identifier}: the lookup is exact (only trimmed), so type it as it is stored, e.g. ${identifier.toLowerCase()}.`;

/**
 * `marmeon auth:reset-two-factor <identifier> --force [--guard=<name>]`: removes the authenticator, every passkey and every recovery code of an account
 * (whatever the bound `TwoFactorState` holds), for the user who lost both their devices and the codes. Only an operator who is sure the
 * person asking is the owner runs it — hence `--force`, in every environment. The owner gets the mail about it (`TwoFactorDisabled` with
 * `via: 'operator'`), the log gets a line. It ends every session and remember-me cookie of the account first, so a session that is open on
 * a lost device, or an attacker's, cannot enrol a "first" factor once the account has none; the next sign-in needs the password only.
 * The account is found by `UserProvider.findForSignIn()` with the identifier as the sign-in form normalizes it. `--guard=<name>` acts on the
 * users of that package guard, through the guard's own stores (authenticator, passkeys and recovery codes together), and never on the app's;
 * a guard's reset sends no event.
 */
export class ResetTwoFactorCommand {
  static command = 'auth:reset-two-factor';
  static description = "Remove an account's second factors (authenticator, passkeys) and recovery codes (the owner lost them)";
  static usage = '<identifier> --force [--guard=<name>]';
  static options = { force: { type: 'boolean' }, ...GUARD_OPTION } as const;
  // Annotated: the declaration then names `Key` instead of spelling out the app's user type. `OperatorGuards`, not the app's `UserProvider`: an app whose only users belong to a guard has none.
  static inject: readonly Key[] = [OperatorGuards, Logger];

  readonly #guards: OperatorGuards;
  readonly #logger: Logger;

  constructor(guards: OperatorGuards, logger: Logger) {
    this.#guards = guards;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const identifier = args[0]?.trim();
    if (!identifier) {
      throw new CommandArgumentsError(`Usage: marmeon auth:reset-two-factor ${ResetTwoFactorCommand.usage}`);
    }
    // A second argument is most likely a guard's name typed without `--guard=`, which must not reset the app's account instead.
    if (args.length > 1) {
      throw new CommandArgumentsError(`auth:reset-two-factor takes one identifier (got "${args.join(' ')}"). To act on a guard of a package, pass --guard=<name>.`);
    }
    const target = this.#guards.resolve(options.guard);
    if (!target.ok) {
      output.error(target.error.message);
      return 1;
    }
    const guard = target.value.context();
    const users = guard.users();
    assertSignInFinder(users);
    const found = await users.findForSignIn(identifier);
    if (!found) {
      output.error(noAccount(identifier));
      return 1;
    }
    const user = found.user;
    const id = idOf(user);
    if ((await guard.factors().factors(id)).length === 0) {
      output.success(`${identifier} has no second factor.`);
      return 0;
    }
    if (options.force !== true) {
      output.error(`This removes the authenticator app, the passkeys and the recovery codes of ${identifier}; the password alone signs them in afterwards. Be sure it is the owner, then pass --force.`);
      return 1;
    }
    // Before the factors go: were it to fail, the factors stay and the operator can run the command again.
    // Ending first also matters for a factor still being set up: `confirm()` and `register()` check their session against the account when they store it, so they find it ended.
    if (!(await guard.accountSessions().end(id, { accessTokens: false })).ok) {
      output.error(`The account ${identifier} vanished while its sessions were ended.`);
      return 1;
    }
    await guard.factors().removeAll(id);
    // removeAll() dispatches nothing: the owner's mail and any audit log hear of the reset from this event. A package guard dispatches none: the app's listeners would act on the app's user of the same id.
    const event = guard.event(new TwoFactorDisabled(user, 'operator'));
    if (event !== undefined) await guard.events().dispatch(event);
    this.#logger.info('Removed the second factor of an account at the operator\'s request', target.value.name === undefined ? { userId: id } : { userId: id, guard: target.value.name });
    // A sign-in or enrolment that was authorised before the sessions ended can still commit a factor after removeAll().
    if ((await guard.factors().factors(id)).length > 0) {
      output.error(`A second factor was enrolled for ${identifier} while the command ran. Run it again.`);
      return 1;
    }
    output.success(`Removed the authenticator app, the passkeys and the recovery codes of ${identifier}, and ended its sessions.`);
    return 0;
  }
}
