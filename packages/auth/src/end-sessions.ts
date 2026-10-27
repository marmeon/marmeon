import { CommandArgumentsError, Logger, type Key } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountSessions } from './account-sessions.ts';
import { assertSignInFinder, idOf, UserProvider } from './user.ts';

/** Exact, trimmed lookup: an address typed in capitals finds nothing when the account stores it in lower case. */
const noAccount = (identifier: string) => `No account has the identifier ${identifier}: the lookup is exact (only trimmed), so type it as it is stored, e.g. ${identifier.toLowerCase()}.`;

/**
 * `marmeon auth:end-sessions <identifier> --force`: signs an account out everywhere, every browser and every "keep me signed in" cookie, for
 * a lost device or a suspected theft. Whoever holds the password signs in again; change it first when it may be known. The account is
 * found by `UserProvider.findForSignIn()` with the identifier as the sign-in form normalizes it (usually the e-mail, lower case). `--force`
 * in every environment, since it cannot be undone. It also revokes the account's API tokens and deletes its password-reset link;
 * `--keep-api-tokens` keeps the tokens. Through `AccountSessions.end()`, see `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class EndSessionsCommand {
  static command = 'auth:end-sessions';
  static description = 'End every session and remember-me cookie of an account (a lost device, a suspected theft)';
  static usage = '<identifier> --force [--keep-api-tokens]';
  static options = { force: { type: 'boolean' }, 'keep-api-tokens': { type: 'boolean' } } as const;
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
      throw new CommandArgumentsError('Usage: marmeon auth:end-sessions <identifier> --force');
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
    const keepTokens = options['keep-api-tokens'] === true;
    const ended = await this.#accounts.end(id, { accessTokens: !keepTokens });
    if (!ended.ok) {
      // Only a race: the account was deleted after findForSignIn().
      output.error(noAccount(identifier));
      return 1;
    }
    this.#logger.info('Ended every session of an account at the operator\'s request', { userId: id });
    const { removed, accessTokens } = ended.value;
    output.success(
      `Ended every session and remember-me cookie of ${identifier}; ${removed} stored sessions were deleted at once, the others end at their next request. ` +
        `Revoked ${accessTokens} API tokens and deleted the password-reset link, if there was one.`,
    );
    output.line(`Kept: second factors, passkeys${keepTokens ? ', API tokens' : ''}`);
    return 0;
  }
}
