import { Clock, CommandArgumentsError, Container, SystemClock } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AuthConfig } from './config.ts';
import { EmailChangeStore } from './email-changes.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { SessionConfig } from '@marmeon/session';
import { SignInStore } from './sign-ins.ts';
import { AccessTokenStore } from './tokens.ts';

/**
 * `marmeon auth:prune-tokens [--hours=0]`: deletes what can no longer be used — reset tokens older than `AUTH_RESET_MINUTES`,
 * remember-me tokens that expired or are older than `AUTH_REMEMBER_DAYS` (all of them with `0`), API tokens expired more than
 * `--hours` ago (a lookup drops only the one it finds), changes of address that expired (when the app bound an `EmailChangeStore`), and sign-ins that are over. Valid reset and API tokens and changes of address stay. For the scheduler:
 * `s.command('auth:prune-tokens').daily().at('03:10').onOneServer()`.
 */
export class PruneTokensCommand {
  static command = 'auth:prune-tokens';
  static description = 'Delete expired password reset and API tokens, and sign-ins that are over';
  static usage = '[--hours=0]';
  static options = { hours: { type: 'string' } } as const;
  static inject = [PasswordResetTokenStore, AccessTokenStore, AuthConfig, SessionConfig, SignInStore, Container, Clock];

  readonly #resets: PasswordResetTokenStore;
  readonly #access: AccessTokenStore;
  readonly #config: AuthConfig;
  readonly #sessionConfig: SessionConfig;
  readonly #signIns: SignInStore;
  readonly #clock: Clock;
  readonly #container: Pick<Container, 'has' | 'make'> | undefined;

  constructor(resets: PasswordResetTokenStore, access: AccessTokenStore, config: AuthConfig, sessionConfig: SessionConfig, signIns: SignInStore, container?: Pick<Container, 'has' | 'make'>, clock: Clock = new SystemClock()) {
    this.#clock = clock;
    this.#container = container;
    this.#resets = resets;
    this.#access = access;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
    this.#signIns = signIns;
  }

  async handle({ options, output }: CommandInput): Promise<number> {
    const hours = options.hours === undefined ? 0 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new CommandArgumentsError(`--hours must be a number ≥ 0 (API tokens expired longer ago than that are deleted), not ${String(options.hours)}.`);
    }
    const resets = await this.#resets.prune(this.#config.resetMinutes * 60);
    const access = await this.#access.prune(hours * 3600);
    const signIns = await this.#signIns.prune({ idleSeconds: this.#sessionConfig.lifetimeMinutes * 60, maxSeconds: this.#config.sessionMaxSeconds }, this.#config.rememberDays);
    // Opt-in: the store exists only where the app bound one.
    const changes = this.#container?.has(EmailChangeStore) ? await this.#container.make(EmailChangeStore).prune(new Date(this.#clock.now())) : undefined;
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const parts = [count(resets, 'password reset token'), count(access, 'API token'), count(signIns, 'sign-in'), ...(changes === undefined ? [] : [`${changes} change${changes === 1 ? '' : 's'} of address`])];
    output.success(`Pruned ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.`);
    return 0;
  }
}
