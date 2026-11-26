import { CommandArgumentsError, Logger, type Key } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { GUARD_OPTION, OperatorGuards } from './operator-guard.ts';
import { logQuietly } from './quiet-log.ts';
import { assertSignInFinder, idOf } from './user.ts';

/** Exact, trimmed lookup: an address typed in capitals finds nothing when the account stores it in lower case. */
const noAccount = (identifier: string) => `No account has the identifier ${identifier}: the lookup is exact (only trimmed), so type it as it is stored, e.g. ${identifier.toLowerCase()}.`;

/**
 * `marmeon auth:end-sessions <identifier> --force [--guard=<name>]`: signs an account out everywhere, every browser and every "keep me signed in" cookie, for
 * a lost device or a suspected theft. Whoever holds the password signs in again; change it first when it may be known. The account is
 * found by `UserProvider.findForSignIn()` with the identifier as the sign-in form normalizes it (usually the e-mail, lower case). `--force`
 * in every environment, since it cannot be undone. It also revokes the account's API tokens and deletes its password-reset link;
 * `--keep-api-tokens` keeps the tokens. `--guard=<name>` acts on the users of that package guard and never on the app's. Through
 * `AccountSessions.end()`, see `docs/authentication.md#ending-every-session-of-a-user`.
 */
export class EndSessionsCommand {
  static command = 'auth:end-sessions';
  static description = 'End every session and remember-me cookie of an account (a lost device, a suspected theft)';
  static usage = '<identifier> --force [--guard=<name>] [--keep-api-tokens]';
  static options = { force: { type: 'boolean' }, 'keep-api-tokens': { type: 'boolean' }, ...GUARD_OPTION } as const;
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
      throw new CommandArgumentsError(`Usage: marmeon auth:end-sessions ${EndSessionsCommand.usage}`);
    }
    // A second argument is most likely a guard's name typed without `--guard=`, which must not end the app's account instead.
    if (args.length > 1) {
      throw new CommandArgumentsError(`auth:end-sessions takes one identifier (got "${args.join(' ')}"). To act on a guard of a package, pass --guard=<name>.`);
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
    if (options.force !== true) {
      output.error(`This signs ${identifier} out of every browser and device, remember-me cookies included. Be sure you mean it, then pass --force.`);
      return 1;
    }
    const id = idOf(found.user);
    // A failure is not caught: the operator has to see that some sessions may still stand.
    const keepTokens = options['keep-api-tokens'] === true;
    const ended = await guard.accountSessions().end(id, { accessTokens: !keepTokens });
    if (!ended.ok) {
      // Only a race: the account was deleted after findForSignIn().
      output.error(noAccount(identifier));
      return 1;
    }
    logQuietly(this.#logger, 'info', 'Ended every session of an account at the operator\'s request', target.value.name === undefined ? { userId: id } : { userId: id, guard: target.value.name });
    const { removed, accessTokens } = ended.value;
    // A package guard has no API tokens: nothing is said of them.
    const tokens = target.value.name === undefined;
    output.success(
      `Ended every session and remember-me cookie of ${identifier}; ${removed} stored sessions were deleted at once, the others end at their next request. ` +
        `${tokens ? `Revoked ${accessTokens} API tokens and deleted` : 'Deleted'} the password-reset link, if there was one.`,
    );
    output.line(`Kept: second factors, passkeys${tokens && keepTokens ? ', API tokens' : ''}`);
    return 0;
  }
}
