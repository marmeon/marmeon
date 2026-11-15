import { Clock, CommandArgumentsError, Container, SystemClock } from '@marmeon/core';
import type { CommandInput } from 'marmeon';
import { AuthConfig } from './config.ts';
import { EmailChangeStore } from './email-changes.ts';
import type { GuardContext } from './guard-context.ts';
import { GUARD_OPTION, OperatorGuards } from './operator-guard.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { SessionConfig } from '@marmeon/session';
import { SignInStore } from './sign-ins.ts';
import { AccessTokenStore } from './tokens.ts';
import { authenticationIsSetUp } from './upgrades.ts';

/**
 * `marmeon auth:prune-tokens [--hours=0] [--guard=<name>]`: deletes what can no longer be used — reset tokens older than `AUTH_RESET_MINUTES`,
 * remember-me tokens that expired or are older than `AUTH_REMEMBER_DAYS` (all of them with `0`), API tokens expired more than
 * `--hours` ago (a lookup drops only the one it finds), changes of address that expired (when the app bound an `EmailChangeStore`), and sign-ins that are over. Valid reset and API tokens and changes of address stay. For the scheduler:
 * `s.command('auth:prune-tokens').daily().at('03:10').onOneServer()`. It also prunes the reset tokens and sign-ins of every package guard, each with the
 * settings of that guard; `--guard=<name>` prunes that guard alone, and `--guard=web` the app alone. Without the option, an app that binds
 * no `UserProvider` of its own is skipped, with a line saying so.
 */
export class PruneTokensCommand {
  static command = 'auth:prune-tokens';
  static description = 'Delete expired password reset and API tokens, and sign-ins that are over';
  static usage = '[--hours=0] [--guard=<name>]';
  static options = { hours: { type: 'string' }, ...GUARD_OPTION } as const;
  static inject = [PasswordResetTokenStore, AccessTokenStore, AuthConfig, SessionConfig, SignInStore, Container, Clock, OperatorGuards];

  readonly #resets: PasswordResetTokenStore;
  readonly #access: AccessTokenStore;
  readonly #config: AuthConfig;
  readonly #sessionConfig: SessionConfig;
  readonly #signIns: SignInStore;
  readonly #clock: Clock;
  readonly #container: Pick<Container, 'has' | 'make'> | undefined;
  readonly #guards: OperatorGuards | undefined;

  constructor(resets: PasswordResetTokenStore, access: AccessTokenStore, config: AuthConfig, sessionConfig: SessionConfig, signIns: SignInStore, container?: Pick<Container, 'has' | 'make'>, clock: Clock = new SystemClock(), guards?: OperatorGuards) {
    this.#guards = guards;
    this.#clock = clock;
    this.#container = container;
    this.#resets = resets;
    this.#access = access;
    this.#config = config;
    this.#sessionConfig = sessionConfig;
    this.#signIns = signIns;
  }

  async handle({ args, options, output }: CommandInput): Promise<number> {
    if (args.length > 0) {
      throw new CommandArgumentsError(`auth:prune-tokens takes no arguments (got "${args.join(' ')}"). To prune one guard of a package, pass --guard=<name>.`);
    }
    const hours = options.hours === undefined ? 0 : Number(options.hours);
    if (!Number.isFinite(hours) || hours < 0) {
      throw new CommandArgumentsError(`--hours must be a number ≥ 0 (API tokens expired longer ago than that are deleted), not ${String(options.hours)}.`);
    }
    // Without the lookup (a command built by hand) no guard can be named, and the option is refused like an unknown name.
    const guards = this.#guards ?? new OperatorGuards({ make: () => undefined as never }, { has: () => false });
    const target = guards.resolve(options.guard);
    if (!target.ok) {
      output.error(target.error.message);
      return 1;
    }
    const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const named = target.value.name;
    // Named: that guard alone, or the app alone with `web`. Not named: every package guard, and the app when it has users of its own.
    const names = options.guard === undefined ? guards.names() : named === undefined ? [] : [named];
    // An app whose only users belong to package guards has no tables of its own to prune; an app without guards keeps what it always did.
    const skipApp = options.guard === undefined && this.#container !== undefined && guards.names().length > 0 && !authenticationIsSetUp(this.#container);
    if (named === undefined && !skipApp) {
      const resets = await this.#resets.prune(this.#config.resetMinutes * 60);
      const access = await this.#access.prune(hours * 3600);
      const signIns = await this.#signIns.prune({ idleSeconds: this.#sessionConfig.lifetimeMinutes * 60, maxSeconds: this.#config.sessionMaxSeconds }, this.#config.rememberDays);
      // Opt-in: the store exists only where the app bound one.
      const changes = this.#container?.has(EmailChangeStore) ? await this.#container.make(EmailChangeStore).prune(new Date(this.#clock.now())) : undefined;
      const parts = [count(resets, 'password reset token'), count(access, 'API token'), count(signIns, 'sign-in'), ...(changes === undefined ? [] : [`${changes} change${changes === 1 ? '' : 's'} of address`])];
      output.success(`Pruned ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}.`);
    } else if (named === undefined) {
      output.line('Skipped the app: it has no users of its own (no UserProvider is bound).');
    }
    for (const name of names) {
      // The guard's own stores and settings; only the idle lifetime is the app's, since the browser's session is shared (as in `Auth`).
      const found = guards.resolve(name);
      if (!found.ok) throw new Error(found.error.message);
      const context: GuardContext = found.value.context();
      const resets = await context.passwordResets().prune(context.settings.resetMinutes * 60);
      const signIns = await context.signIns().prune({ idleSeconds: this.#sessionConfig.lifetimeMinutes * 60, maxSeconds: context.settings.sessionMaxSeconds }, context.settings.rememberDays);
      output.success(`Pruned ${count(resets, 'password reset token')} and ${count(signIns, 'sign-in')} of the guard '${name}'.`);
    }
    return 0;
  }
}
