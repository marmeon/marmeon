import type { CommandInput } from 'marmeon';
import { AuthConfig } from './config.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { RememberTokenStore } from './remember.ts';
import { SessionConfig } from '@marmeon/session';
import { SignInTracker } from './sign-ins.ts';
import { AccessTokenStore } from './tokens.ts';

/**
 * `marmeon auth:prune-tokens [--hours=0]`: deletes what can no longer be used — reset tokens older than `AUTH_RESET_EXPIRE`,
 * remember-me tokens that expired or are older than `AUTH_REMEMBER_DAYS` (all of them with `0`), and API tokens expired more
 * than `--hours` ago (a lookup drops only the one it finds), and — with a bound `SignInStore` — sign-ins that are over. Valid reset and API tokens stay. For the scheduler:
 * `s.command('auth:prune-tokens').daily().at('03:10').onOneServer()`.
 */
export class PruneTokensCommand {
  static command = 'auth:prune-tokens';
  static description = 'Delete expired password reset, remember-me and API tokens, and sign-ins that are over';
  static usage = '[--hours=0]';
  static options = { hours: { type: 'string' } } as const;
  // Written out: the trailing parameters have defaults for hand-built instances, and a default would keep the container from injecting them.
  static inject = [PasswordResetTokenStore, RememberTokenStore, AccessTokenStore, AuthConfig, SessionConfig, SignInTracker];

  readonly #resets: PasswordResetTokenStore;
  readonly #remember: RememberTokenStore;
  readonly #access: AccessTokenStore;
  readonly #config: AuthConfig;
  readonly #sessionConfig: SessionConfig | undefined;
  readonly #signIns: SignInTracker;

  constructor(resets: PasswordResetTokenStore, remember: RememberTokenStore, access: AccessTokenStore, config: AuthConfig, sessionConfig?: SessionConfig, signIns: SignInTracker = new SignInTracker(undefined)) {
    this.#resets = resets;
    this.#remember = remember;
    this.#access = access;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
    this.#signIns = signIns;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 0 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      output.error(`--hours must be a number ≥ 0 (API tokens expired longer ago than that are deleted), not ${String(options.hours)}.`);
      return 1;
    }
    const resets = await this.#resets.prune(this.#config.resetExpire * 60);
    const remember = await this.#remember.prune(this.#config.rememberDays);
    const access = await this.#access.prune(hours * 3600);
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    if (!this.#signIns.enabled) {
      output.success(`Pruned ${count(resets, 'password reset token')}, ${count(remember, 'remember-me token')} and ${count(access, 'API token')}.`);
      return 0;
    }
    if (this.#sessionConfig === undefined) throw new Error('PruneTokensCommand needs the SessionConfig to prune sign-ins.');
    const signIns = await this.#signIns.prune({ idleSeconds: this.#sessionConfig.lifetime * 60, maxSeconds: this.#config.sessionMaxSeconds });
    output.success(`Pruned ${count(resets, 'password reset token')}, ${count(remember, 'remember-me token')}, ${count(access, 'API token')} and ${count(signIns, 'sign-in')}.`);
    return 0;
  }
}
