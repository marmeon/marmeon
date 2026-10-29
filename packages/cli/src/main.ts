import { Application, ConfigError, Container, errorCodeOf, ErrorReports, ErrorSolutions, type ServiceProviderClass } from '@marmeon/core';
import { coreSolutions, loadDiscoveredPackages, messageBase, sendConsoleLogsToStderr, trace } from '@marmeon/core/internal';
import { channels, type CommandRunMessage } from '@marmeon/core/diagnostics';
import { CommandArgumentsError, CommandRegistry, type CommandClass, CommandSetupError, parseCommandArgs, runCommand, wantsHelp } from './command.ts';
import { BUILT_IN } from './built-in.ts';
import { packageAdvice } from './check/packages.ts';
import { printCommandHelp, printCommandList, printCommandListJson } from './commands/list.ts';
import { loadApplication } from './load.ts';
import { appFrameOf } from './load-failure.ts';
import { Output, printError, stdoutToStderr, style } from './output.ts';
import { createPrompt, isPromptCancelled } from './prompt.ts';
import { spawnMarmeon } from './spawn.ts';

/** Exit code of a call that is wrong (unknown command, unknown option, missing option value), apart from a command that ran and failed (1). */
const EXIT_USAGE = 2;

/** Exit code of a command the person cancelled at a question (Ctrl-C), as shells report SIGINT. */
const EXIT_CANCELLED = 130;

const commands = channels.tracing('command.run');

/**
 * Checks `argv` against the options of a built-in that needs no app (`marmeon dev` is `serve`; `name` is what the usage line says).
 * The launcher calls it before it starts `node --watch`, which would wait for changes after a wrong call.
 * @throws {CommandArgumentsError}
 * @internal Only for the launcher (`bin/marmeon.js`); not part of the public API.
 */
export function checkArgs(command: string, argv: readonly string[], name = command): void {
  argv = withoutNoInteraction(argv, 0).argv;
  const builtIn = BUILT_IN.find((candidate) => candidate.command === command);
  if (builtIn && !wantsHelp(argv, builtIn)) parseCommandArgs(builtIn, argv, name);
}

/**
 * Runs one `marmeon` invocation in the app root (`cwd`) and returns the exit code. With `--json`, stdout holds the document only:
 * whatever app code writes to stdout meanwhile goes to stderr.
 * @internal Only for the launcher (`bin/marmeon.js`); not part of the public API.
 */
export async function run(args: readonly string[], root = process.cwd()): Promise<number> {
  const { argv, noInteraction } = withoutNoInteraction(args, 1);
  const rest = argv.slice(1);
  const redirect = (rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest).includes('--json') ? stdoutToStderr() : undefined;
  try {
    return await runCommandLine(argv, root, new Output(redirect?.write), noInteraction);
  } finally {
    redirect?.restore();
  }
}

/**
 * `--no-interaction` is an option of every command: a command never sees it among its options. Only arguments from `from` on count
 * (the command name comes first) and a `--` ends the options, as everywhere.
 */
function withoutNoInteraction(argv: readonly string[], from: number): { readonly argv: readonly string[]; readonly noInteraction: boolean } {
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  const kept = argv.filter((arg, index) => index < from || index >= end || arg !== '--no-interaction');
  return { argv: kept, noInteraction: kept.length !== argv.length };
}

async function runCommandLine(argv: readonly string[], root: string, output: Output, noInteraction: boolean): Promise<number> {
  const [name = 'list', ...rest] = argv;
  const builtIn = BUILT_IN.find((command) => command.command === name);
  const listing = name === 'list' || name === 'help' || name === '--help' || name === '-h';
  // `--json` after `--` is a positional.
  const wantsJson = (rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest).includes('--json');
  const json = listing && wantsJson;
  // With --json stdout holds the document or nothing: what a failed command says goes to stderr.
  const failing = wantsJson ? 'stderr' : 'stdout';
  // Log lines too, before the app boots: a provider may log while it registers.
  sendConsoleLogsToStderr(wantsJson);
  let warning: string | undefined;
  // A built-in's help needs no app; an app's command is known once the app booted.
  if (builtIn && wantsHelp(rest, builtIn)) {
    printCommandHelp({ output }, builtIn);
    return 0;
  }

  // A wrong call to a built-in is found before the app boots, so a broken app does not hide it.
  if (builtIn && !listing) {
    try {
      parseCommandArgs(builtIn, rest);
    } catch (error) {
      if (!(error instanceof CommandArgumentsError)) throw error;
      output.error(error.message);
      return EXIT_USAGE;
    }
  }

  // Boot the application unless the command works without it (generators, tooling).
  let app: Application | undefined;
  if (listing || !builtIn || builtIn.boots !== false) {
    // `boots = 'build'` (route:types): registered, not booted, without runtime secrets — what `marmeon build` needs.
    const loaded = await loadApplication(root, !listing && builtIn?.boots === 'build' ? 'build' : 'run');
    if (loaded instanceof Error) {
      // A name used twice is fatal even for `list`: the clash is found while the app registers.
      if (!listing || loaded instanceof CommandSetupError) {
        // Node's code (ERR_…) beside its message: what one searches for.
        const code = (loaded as { code?: unknown }).code;
        // The place in the app where it failed: Node's message alone names no file.
        const where = loaded instanceof ConfigError ? undefined : appFrameOf(loaded, root);
        output.error(loaded instanceof ConfigError ? loaded.message : `Could not start the application: ${loaded.message}${typeof code === 'string' ? ` (${code})` : ''}${where ? `\n  at ${where}` : ''}`);
        await printSolutions(output, loaded, root, failing);
        printPackageAdvice(output, loaded, root, failing);
        return 1;
      }
      const where = appFrameOf(loaded, root);
      warning = `${loaded.message.split('\n')[0]}${where ? ` (at ${where})` : ''} — showing built-in commands only.`;
      if (!json) output.warn(warning);
    } else {
      app = loaded;
    }
  }

  // The app's registry already holds the built-ins; without an app (a generator, a broken app) only they are known.
  const registry = app?.container.has(CommandRegistry) ? app.container.make(CommandRegistry) : new CommandRegistry().add(BUILT_IN, 'marmeon');

  if (listing) {
    // `list` and `help` take no options but --help/-h and --json; `help <command>` prints that command's help.
    const flags = rest.slice(0, rest.includes('--') ? rest.indexOf('--') : undefined);
    const stray = flags.find((flag) => flag.startsWith('-') && flag !== '--help' && flag !== '-h' && flag !== '--json');
    if (stray !== undefined) {
      output.error(`Unknown option '${stray}'\nUsage: marmeon ${name === 'help' ? 'help [command]' : 'list'}`);
      return EXIT_USAGE;
    }
    const target = name === 'help' ? flags.find((flag) => !flag.startsWith('-')) : undefined;
    if (target !== undefined) {
      if (json) {
        output.error(`--json lists every command and takes no command name.\nUsage: marmeon help --json`);
        return EXIT_USAGE;
      }
      const Target = registry.get(target);
      if (!Target && !app) {
        // The app's commands are unknown while it does not boot: not a wrong call.
        output.error(`Could not start the application, so "${target}" cannot be looked up.`);
        return 1;
      }
      if (!Target) {
        output.error(`Command "${target}" is not defined. Run "marmeon list" to see all commands.`);
        return EXIT_USAGE;
      }
      printCommandHelp({ output }, Target);
      return 0;
    }
    if (json) printCommandListJson({ output }, registry.all(), warning === undefined, warning === undefined ? [] : [warning]);
    else printCommandList({ output }, registry.all());
    return 0;
  }

  const Command = registry.get(name);
  if (!Command) {
    output.error(`Command "${name}" is not defined. Run "marmeon list" to see all commands.`);
    return EXIT_USAGE;
  }
  if (wantsHelp(rest, Command)) {
    await app?.shutdown();
    printCommandHelp({ output }, Command);
    return 0;
  }

  try {
    parseCommandArgs(Command, rest);
  } catch (error) {
    if (!(error instanceof CommandArgumentsError)) {
      printError(output, error);
      reportFailure(app, Command, error);
      await app?.shutdown();
      return 1;
    }
    output.error(error.message);
    await app?.shutdown();
    return EXIT_USAGE;
  }

  // Commands are built through the container, so they get constructor injection — in a scope of their own, like a
  // request or a job: scoped services (a Translator, in APP_LOCALE) resolve, and start fresh for each command.
  // The app shuts down afterwards (pools, handles), or an open connection would keep the process alive.
  try {
    const scope = app?.container.createScope() ?? new Container();
    // An app without the CLI provider (or none at all) has no registry bound: a command that asks for it (`make:command`) gets this one, not an empty one.
    if (!scope.has(CommandRegistry)) scope.instance(CommandRegistry, registry);
    const execute = () => runCommand(scope, Command, rest, { output, root, spawn: (...args) => spawnMarmeon(root, args, noInteraction), prompt: createPrompt({ noInteraction }) });
    // On the `command.run` channel while something listens: the devtools keep what a command did as one batch.
    if (!app || !commands.hasSubscribers) return await execute();
    const message: CommandRunMessage = { ...messageBase(app), command: Command.command, args: rest };
    return await trace(commands, message, execute, (ended, code) => {
      ended.exitCode = code;
    });
  } catch (error) {
    // Ctrl-C or the end of input while a command asked a question.
    if (isPromptCancelled(error)) {
      output.error('\nmarmeon: cancelled.');
      return EXIT_CANCELLED;
    }
    // An argument the command itself refuses is a wrong call, like one `parseCommandArgs` refuses: exit 2, not an error to report.
    if (error instanceof CommandArgumentsError) {
      output.error(error.message);
      return EXIT_USAGE;
    }
    printError(output, error);
    printPackageAdvice(output, error, root, 'stderr');
    reportFailure(app, Command, error);
    return 1;
  } finally {
    await app?.shutdown();
  }
}

/**
 * Tells the error reporters of the app that a command ended with an error, by its name only: the arguments may carry secrets. The user
 * has the error on the screen already, so it is not logged again. A wrong call (exit 2) and a cancelled prompt are not errors.
 */
function reportFailure(app: Application | undefined, Command: CommandClass, error: unknown): void {
  if (app?.container.has(ErrorReports)) app.container.make(ErrorReports).report(error, { source: 'command', context: { command: Command.command }, log: false });
}

/**
 * What to do about an error the app could not start with — the solutions of the core and of the installed packages
 * (`APP_KEY` → `marmeon key:generate`), as text. Never fails itself.
 */
async function printSolutions(output: Output, error: Error, root: string, stream: 'stdout' | 'stderr'): Promise<void> {
  const line = (text = '') => (stream === 'stderr' ? void process.stderr.write(`${text}\n`) : output.line(text));
  try {
    const discovered = await loadDiscoveredPackages({ root }).catch(() => undefined);
    const providers = (discovered?.providers ?? []) as ServiceProviderClass[];
    const solutions = await new ErrorSolutions([...providers.flatMap((Provider) => Provider.solutions ?? []), ...coreSolutions]).find(error);
    for (const solution of solutions) {
      line();
      line(`${stream === 'stderr' ? 'ℹ' : style('cyan', 'ℹ')} How to fix it${solution.code ? ` (${solution.code})` : ''}: ${solution.title}`);
      line(`  ${solution.text}`);
      if (solution.command) line(`  $ ${solution.command}`);
      if (solution.docs) line(`  docs: ${solution.docs}`);
    }
  } catch {
    // The error itself was printed — that is what counts.
  }
}

/**
 * After a K3 (a class the loader could not give an injection list), the @marmeon packages of the app that are not in one version
 * — the usual reason a package is read by a loader of another version. Prints nothing when they are all alike. Never fails itself.
 */
function printPackageAdvice(output: Output, error: unknown, root: string, stream: 'stdout' | 'stderr'): void {
  if (errorCodeOf(error) !== 'K3') return;
  const advice = packageAdvice(root);
  if (advice.length === 0) return;
  const line = (text = '') => (stream === 'stderr' ? void process.stderr.write(`${text}\n`) : output.line(text));
  line();
  line(`${stream === 'stderr' ? 'ℹ' : style('cyan', 'ℹ')} The @marmeon packages of this app are not in one version (docs/check.md#the-packages-check):`);
  for (const text of advice) line(`  ${text}`);
}
