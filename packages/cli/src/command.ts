import type { ParseArgsOptionsConfig } from 'node:util';
import type { Output } from './output.ts';

export interface CommandInput {
  /** Positional arguments after the command name. */
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly output: Output;
  /** The directory `bespoke` runs in — the app root. */
  readonly root: string;
  /**
   * Runs another `bespoke` command in a fresh process — one that boots the app anew, e.g. `route:types` after a
   * generator added a module. Its output goes to this console; resolves with its exit code.
   */
  readonly spawn: (...args: string[]) => Promise<number>;
}

/**
 * A console command: a class with `handle()` and constructor injection, like a
 * controller. Returning a number sets the exit code.
 *
 * ```ts
 * export class PruneTokensCommand {
 *   static command = 'tokens:prune';
 *   static description = 'Delete expired tokens';
 *   constructor(tokens: TokenRepository) { … }
 *   async handle({ output }: CommandInput) { … }
 * }
 * ```
 */
export interface Command {
  handle(input: CommandInput): void | number | Promise<void | number>;
}

export interface CommandClass {
  new (...args: any[]): Command;
  readonly command: string;
  readonly description: string;
  /** Shown in help, e.g. `<Name> --module=<module>`. */
  readonly usage?: string;
  readonly options?: ParseArgsOptionsConfig;
  /**
   * Whether the application must boot first (default: true). Generators and
   * tooling set this to false, so they work without a valid `.env`.
   */
  readonly boots?: boolean;
  /** Hidden from `bespoke list`. */
  readonly hidden?: boolean;
}

/** All commands the app knows: built-ins, modules' `commands` and those packages add. */
export class CommandRegistry {
  readonly #commands = new Map<string, CommandClass>();

  add(commands: readonly CommandClass[]): this {
    for (const command of commands) this.#commands.set(command.command, command);
    return this;
  }

  get(name: string): CommandClass | undefined {
    return this.#commands.get(name);
  }

  all(): CommandClass[] {
    return [...this.#commands.values()].sort((a, b) => a.command.localeCompare(b.command));
  }
}
