import { hostname, userInfo } from 'node:os';
import { CommandArgumentsError, environment, Logger } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AccountSessions } from './account-sessions.ts';

/**
 * `marmeon auth:end-all-sessions --force [--keep-api-tokens] [--keep-reset-tokens]`: signs every account out of every browser and
 * device at once, remember-me cookies included, for the moment after a leak. It also revokes every API token and deletes every
 * password-reset token, since a thief may hold either; the `--keep-…` options leave them. Passkeys, second factors, passwords and
 * addresses are not touched, and the output says so. `--force` in every environment, since it cannot be undone. Through
 * `AccountSessions.endEveryone()`, see `docs/authentication.md#ending-every-session-of-every-account`.
 */
export class EndAllSessionsCommand {
  static command = 'auth:end-all-sessions';
  static description = 'End every session and remember-me cookie of every account (after a leak)';
  static usage = '--force [--keep-api-tokens] [--keep-reset-tokens]';
  static options = {
    force: { type: 'boolean' },
    'keep-api-tokens': { type: 'boolean' },
    'keep-reset-tokens': { type: 'boolean' },
    // Declared only to answer with the new default instead of an unknown-option error.
    'api-tokens': { type: 'boolean' },
    'reset-tokens': { type: 'boolean' },
  } as const;
  static inject = [AccountSessions, Logger];

  readonly #accounts: AccountSessions;
  readonly #logger: Logger | undefined;

  constructor(accounts: AccountSessions, logger?: Logger) {
    this.#accounts = accounts;
    this.#logger = logger;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    // A stray argument is most likely a mistyped `auth:end-sessions <identifier>`, which must not end every account's sessions.
    if (args.length > 0) {
      throw new CommandArgumentsError(`auth:end-all-sessions takes no arguments (got "${args.join(' ')}"). To sign out one account, use auth:end-sessions <identifier> --force.`);
    }
    for (const old of ['api-tokens', 'reset-tokens']) {
      if (options[old] === true) {
        throw new CommandArgumentsError(`--${old} no longer exists: the command revokes API tokens and deletes password-reset tokens by default. Pass --keep-${old} to leave them. Nothing was ended.`);
      }
    }
    output.line(`Environment: ${environment.describe()}`);
    if (options.force !== true) {
      output.error(
        'This signs every account out of every browser and device at once: every session, every remember-me cookie and every sign-in. ' +
          'It also revokes every API token and deletes every password-reset token (--keep-api-tokens and --keep-reset-tokens leave them). ' +
          'Passkeys, second factors, passwords and e-mail addresses are not touched. Be sure you mean it, then pass --force.',
      );
      return 1;
    }
    const accessTokens = options['keep-api-tokens'] !== true;
    const resetTokens = options['keep-reset-tokens'] !== true;
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
    const kept = [...(accessTokens ? [] : ['API tokens']), ...(resetTokens ? [] : ['password-reset tokens'])];
    output.success(
      `Ended every session of ${count(ended.accounts, 'account')}: ${count(ended.signIns, 'sign-in')} deleted (remember-me tokens with them)` +
        `${resetTokens ? `, ${count(ended.resetTokens, 'password-reset token')} deleted` : ''}${accessTokens ? `, ${count(ended.accessTokens, 'API token')} revoked` : ''}. ` +
        'Sessions of every driver end at their next request (environment: ' + environment.describe() + ').',
    );
    if (kept.length > 0) output.line(`Kept as asked: ${kept.join(' and ')}.`);
    output.line(
      'Not touched: passkeys, second factors (TOTP, recovery codes), passwords, e-mail addresses (pending changes too) and accounts of other user providers. A thief may have added a passkey or a second factor ' +
        'to an account: check PasskeyRegistered, TwoFactorEnabled, RecoveryCodesGenerated and e-mail changes since the leak, and run auth:reset-two-factor for suspect accounts.',
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
