import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { Container } from '@marmeon/core';
import type { Output } from './output.ts';

export interface CommandInput {
  /** Positional arguments after the command name. */
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly output: Output;
  /** The directory `marmeon` runs in — the app root. */
  readonly root: string;
  /**
   * Runs another `marmeon` command in a fresh process — one that boots the app anew, e.g. `route:types` after a
   * generator added a module. Its output goes to this console; resolves with its exit code.
   */
  readonly spawn: (...args: string[]) => Promise<number>;
}

/**
 * A console command: a class with `static command`, `handle()` and constructor injection, like a controller. Returning a
 * number sets the exit code. See docs/console.md#writing-commands.
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
   * tooling set this to false, so they work without a valid `.env`. `'build'`: the app as `marmeon build` has it — every
   * provider registered, none booted, no runtime secret needed (`route:types`). Read for the CLI's built-in commands, which it
   * knows before the app boots.
   */
  readonly boots?: boolean | 'build';
  /** Hidden from `marmeon list`. */
  readonly hidden?: boolean;
}

/** Two different commands share a name — the app cannot tell which one `marmeon <name>` means. */
export class CommandSetupError extends Error {
  override name = 'CommandSetupError';
}

/** All commands the app knows: built-ins, modules' `commands` and those packages add. */
export class CommandRegistry {
  readonly #commands = new Map<string, { readonly command: CommandClass; readonly source: string }>();

  /**
   * Registers `commands`; adding the same class again is a no-op, a different class under a taken name throws a
   * `CommandSetupError` naming both classes and their `source` (a package or module), so no package silently takes over
   * an app's command. Built-ins that run before the app boots (`boots = false`) are checked once a booting command runs.
   * See docs/package-development.md#commands.
   */
  add(commands: readonly CommandClass[], source = 'a package'): this {
    for (const command of commands) {
      const taken = this.#commands.get(command.command);
      if (!taken) {
        this.#commands.set(command.command, { command, source });
      } else if (taken.command !== command) {
        throw new CommandSetupError(
          `Two commands are named "${command.command}": ${taken.command.name} (${taken.source}) and ${command.name} (${source}). Rename one — its static command is how marmeon finds it.`,
        );
      }
    }
    return this;
  }

  get(name: string): CommandClass | undefined {
    return this.#commands.get(name)?.command;
  }

  all(): CommandClass[] {
    return [...this.#commands.values()].map((entry) => entry.command).sort((a, b) => a.command.localeCompare(b.command));
  }
}

/** The arguments do not fit the command's options — the message says what, and how the command is used. */
export class CommandArgumentsError extends Error {
  override name = 'CommandArgumentsError';
}

/**
 * Whether `argv` asks for the command's help: `--help` or `-h` before a `--`, unless the command declares an option of that name itself.
 * Without `Command`, a built-in the CLI knows before the app boots is not at hand yet — any `--help`/`-h` counts.
 */
export function wantsHelp(argv: readonly string[], Command?: CommandClass): boolean {
  const end = argv.indexOf('--');
  const flags = end === -1 ? argv : argv.slice(0, end);
  const options = Object.entries(Command?.options ?? {});
  const own = (flag: string) => options.some(([name, option]) => (flag === '--help' ? name === 'help' : option.short === 'h'));
  return flags.some((flag) => (flag === '--help' || flag === '-h') && !own(flag));
}

/** Splits `argv` into positionals and the options `Command` declares (unknown options are an error). */
export function parseCommandArgs(Command: CommandClass, argv: readonly string[]): Pick<CommandInput, 'args' | 'options'> {
  try {
    const parsed = parseArgs({ args: [...argv], options: Command.options ?? {}, allowPositionals: true, strict: true });
    return { args: parsed.positionals, options: parsed.values };
  } catch (error) {
    throw new CommandArgumentsError(`${(error as Error).message}\nUsage: marmeon ${Command.command} ${Command.usage ?? ''}`.trimEnd());
  }
}

/**
 * Runs `Command` with `argv` — built through `container` (constructor injection), as `marmeon <command>` does: the
 * scheduler runs `s.command(…)` tasks this way, each in a scope of its own. Resolves with the exit code.
 */
export async function runCommand(container: Container, Command: CommandClass, argv: readonly string[], context: Pick<CommandInput, 'output' | 'root' | 'spawn'>): Promise<number> {
  const input = parseCommandArgs(Command, argv);
  const command = container.make(Command as never) as Command;
  const code = await command.handle({ ...input, ...context });
  return typeof code === 'number' ? code : 0;
}
