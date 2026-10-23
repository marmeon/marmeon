import { Logger, type Key } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountSessions } from './account-sessions.ts';
import { assertSignInFinder, idOf, UserProvider } from './user.ts';

/** Exact, trimmed lookup: an address typed in capitals finds nothing when the account stores it in lower case. */
const noAccount = (identifier: string) => `No account has the identifier ${identifier}: the lookup is exact (only trimmed), so type it as it is stored, e.g. ${identifier.toLowerCase()}.`;

/**
 * `marmeon auth:end-sessions <identifier> --force`: signs an account out everywhere, every browser and every "keep me signed in" cookie, for
 * a lost device or a suspected theft. Whoever holds the password signs in again; change it first when it may be known. The account is
 * found by `UserProvider.findForSignIn()` with the identifier as the sign-in form normalizes it (usually the e-mail, lower case). `--force`
 * in every environment, since it cannot be undone. Through `AccountSessions.end()`, see `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class EndSessionsCommand {
  static command = 'auth:end-sessions';
  static description = 'End every session and remember-me cookie of an account (a lost device, a suspected theft)';
  static usage = '<identifier> --force';
  static options = { force: { type: 'boolean' } } as const;
  // Annotated: the declaration then names `Key` instead of spelling out the app's user type.
  static inject: readonly Key[] = [UserProvider, AccountSessions, Logger];

  readonly #users: UserProvider;
  readonly #accounts: AccountSessions;
  readonly #logger: Logger;

  constructor(users: UserProvider, accounts: AccountSessions, logger: Logger) {
    this.#users = users;
    this.#accounts = accounts;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    const identifier = args[0]?.trim();
    if (!identifier) {
      output.error('Usage: marmeon auth:end-sessions <identifier> --force');
      return 1;
    }
    assertSignInFinder(this.#users);
    const found = await this.#users.findForSignIn(identifier);
    if (!found) {
      output.error(noAccount(identifier));
      return 1;
    }
    if (options.force !== true) {
      output.error(`This signs ${identifier} out of every browser and device, remember-me cookies included. Be sure you mean it, then pass --force.`);
      return 1;
    }
    const id = idOf(found.user);
    // A failure is not caught: the operator has to see that some sessions may still stand.
    const ended = await this.#accounts.end(id);
    if (!ended.ok) {
      // Only a race: the account was deleted after findForSignIn().
      output.error(noAccount(identifier));
      return 1;
    }
    this.#logger.info('Ended every session of an account at the operator\'s request', { userId: id });
    output.success(`Ended every session and remember-me cookie of ${identifier}; ${ended.value.removed} stored sessions were deleted at once, the others end at their next request.`);
    return 0;
  }
}
