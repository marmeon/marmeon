import type { CommandInput } from 'marmeon';
import { AuthConfig } from './config.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { RememberTokenStore } from './remember.ts';
import { AccessTokenStore } from './tokens.ts';

/**
 * `marmeon auth:prune-tokens [--hours=0]`: deletes what can no longer be used — reset tokens older than
 * `AUTH_RESET_EXPIRE`, expired remember-me tokens, and API tokens expired more than `--hours` ago (a lookup drops only
 * the one it finds). Valid tokens stay. For the scheduler:
 * `s.command('auth:prune-tokens').daily().at('03:10').onOneServer()`.
 */
export class PruneTokensCommand {
  static command = 'auth:prune-tokens';
  static description = 'Delete expired password reset, remember-me and API tokens';
  static usage = '[--hours=0]';
  static options = { hours: { type: 'string' } } as const;

  readonly #resets: PasswordResetTokenStore;
  readonly #remember: RememberTokenStore;
  readonly #access: AccessTokenStore;
  readonly #config: AuthConfig;

  constructor(resets: PasswordResetTokenStore, remember: RememberTokenStore, access: AccessTokenStore, config: AuthConfig) {
    this.#resets = resets;
    this.#remember = remember;
    this.#access = access;
    this.#config = config;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 0 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      output.error(`--hours must be a number ≥ 0 (API tokens expired longer ago than that are deleted), not ${String(options.hours)}.`);
      return 1;
    }
    const resets = await this.#resets.prune(this.#config.resetExpire * 60);
    const remember = await this.#remember.prune();
    const access = await this.#access.prune(hours * 3600);
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    output.success(`Pruned ${count(resets, 'password reset token')}, ${count(remember, 'remember-me token')} and ${count(access, 'API token')}.`);
    return 0;
  }
}
