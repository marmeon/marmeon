import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { Container } from '@bespokecore/core';
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

/** The arguments do not fit the command's options — the message says what, and how the command is used. */
export class CommandArgumentsError extends Error {
  override name = 'CommandArgumentsError';
}

/** Splits `argv` into positionals and the options `Command` declares (unknown options are an error). */
export function parseCommandArgs(Command: CommandClass, argv: readonly string[]): Pick<CommandInput, 'args' | 'options'> {
  try {
    const parsed = parseArgs({ args: [...argv], options: Command.options ?? {}, allowPositionals: true, strict: true });
    return { args: parsed.positionals, options: parsed.values };
  } catch (error) {
    throw new CommandArgumentsError(`${(error as Error).message}\nUsage: bespoke ${Command.command} ${Command.usage ?? ''}`.trimEnd());
  }
}

/**
 * Runs `Command` with `argv` — built through `container` (constructor injection), as `bespoke <command>` does: the
 * scheduler runs `s.command(…)` tasks this way, each in a scope of its own. Resolves with the exit code.
 */
export async function runCommand(container: Container, Command: CommandClass, argv: readonly string[], context: Pick<CommandInput, 'output' | 'root' | 'spawn'>): Promise<number> {
  const input = parseCommandArgs(Command, argv);
  const command = container.make(Command as never) as Command;
  const code = await command.handle({ ...input, ...context });
  return typeof code === 'number' ? code : 0;
}
