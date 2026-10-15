import { hostname, userInfo } from 'node:os';
import { environment, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountSessions } from './account-sessions.ts';

/**
 * `marmeon auth:end-all-sessions --force [--api-tokens] [--reset-tokens]`: signs every account out of every browser and device at
 * once, remember-me cookies included, for the moment after a leak. `--api-tokens` revokes every API token too and `--reset-tokens`
 * deletes every password-reset token. `--force` in every environment, since it cannot be undone. Through
 * `AccountSessions.endEveryone()`, see `docs/authentication.md#ending-every-session-of-every-account`.
 */
export class EndAllSessionsCommand {
  static command = 'auth:end-all-sessions';
  static description = 'End every session and remember-me cookie of every account (after a leak)';
  static usage = '--force [--api-tokens] [--reset-tokens]';
  static options = { force: { type: 'boolean' }, 'api-tokens': { type: 'boolean' }, 'reset-tokens': { type: 'boolean' } } as const;
  static inject = [AccountSessions, Logger];

  readonly #accounts: AccountSessions;
  readonly #logger: Logger | undefined;

  constructor(accounts: AccountSessions, logger?: Logger) {
    this.#accounts = accounts;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    // A stray argument is most likely a mistyped `auth:end-sessions <email>`, which must not end every account's sessions.
    if (args.length > 0) {
      output.error(`auth:end-all-sessions takes no arguments (got "${args.join(' ')}"). To sign out one account, use auth:end-sessions <email> --force.`);
      return 1;
    }
    output.line(`Environment: ${environment.describe()}`);
    if (options.force !== true) {
      output.error(
        'This signs every account out of every browser and device at once: every session, every remember-me cookie and every sign-in. ' +
          'API tokens stay unless you pass --api-tokens, password-reset tokens unless you pass --reset-tokens. Be sure you mean it, then pass --force.',
      );
      return 1;
    }
    const accessTokens = options['api-tokens'] === true;
    const resetTokens = options['reset-tokens'] === true;
    let ended;
    try {
      ended = await this.#accounts.endEveryone({ accessTokens, resetTokens });
    } catch (error) {
      // The message says which steps finished and whether to run it again or fix the user provider first.
      output.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    // `endEveryone()` has logged the counts; this adds who asked for it.
    this.#logger?.info('Ended every session of every account at the operator\'s request', { ...operator(), ...ended });
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    output.success(
      `Ended every session of ${count(ended.accounts, 'account')}: ${count(ended.rememberTokens, 'remember-me token')} and ${count(ended.signIns, 'sign-in')} deleted` +
        `${resetTokens ? `, ${count(ended.resetTokens, 'password-reset token')} deleted` : ''}${accessTokens ? `, ${count(ended.accessTokens, 'API token')} revoked` : ''}. ` +
        'Sessions of every driver end at their next request (environment: ' + environment.describe() + ').',
    );
    return 0;
  }
}

/** Who runs the command; a system without a user database (a container with an unnamed uid) has none to name. */
function operator(): { operator: string | undefined; host: string } {
  let name: string | undefined;
  try {
    name = userInfo().username;
  } catch {
    name = undefined;
  }
  return { operator: name, host: hostname() };
}
